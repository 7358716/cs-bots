/**
 * cs-bots Admission Gate —— 房间消息的**确定性准入闸**（改造09 · 借鉴 superagent 的两段式准入）。
 *
 * ## 为什么需要它
 *
 * 现状：任务订阅房间后，房间里每条消息都会扇出上下文；
 * 要不要因此**唤醒**执行者，只有一个布尔开关 `wakeOnFanout`（默认关）。
 * 那是全有或全无：要么谁都别醒，要么每条消息都醒 —— 后者等于把执行者变成
 * 消息回音壁，一分钟花掉几块钱，还让它迷失在无关闲聊里。
 *
 * superagent 的答案是把准入拆成**两段**（docs/002-authorization.md §Admission）：
 *   1. **Gate（确定性、可审计、零模型成本）**：这条消息是
 *      `explicit`（明确要你，直接做）/ `inferred`（候选，需要评估）/ `ignore`（不要）。
 *      查表得出，答案固定、可复现。
 *   2. **Assessment（模型判断）**：Gate 判为 `inferred` 的，由模型判断值不值得动手。
 *      —— 这一段贵，所以**只在 Gate 放行之后**才发生。
 *
 * 本模块只做第 1 段。第 2 段交给执行者（它本来就是模型）。
 * 于是钱花在「真的相关」的消息上，而不是每条闲聊上。
 *
 * ## 准入表（三值，与 superagent docs/002:58-73 逐格对齐）

行 = 接收方是否在名单上；列 = 消息是否点名。

| | 点名找你 | 没点名 |
|---|---|---|
| **在名单上** | `explicit`（**不在表里**，直接明确） | `inferred`（缺省） |
| **不在名单上** | `ignore`（缺省） | `ignore`（缺省） |

⚠️ 四个反直觉但关键的点（都有官方出处）：

1. **不在名单上的人点名你，缺省是 `ignore`。**
   官方原文：`A listed sender who addresses the agent always makes an explicit request`
   ——「明确」的前提是**在名单上**。不在名单上就点名，
   默认当没看见；要让他能直接派活，得**把这个格子改成 explicit**（表格的 `unlistedAddressed` 格）。
   放行等于绕过订阅权限 —— 正确做法是让他订阅，而不是让 Gate 开后门。

2. **`inferred` 不是「放行」，是「候选」。**
   它意味着上下文可以记，但要不要动手要由评估决定；
   且 `off` 模式下**根本不会**成为候选。
   把「候选」当成「放行」会让无关消息全部进来。

3. **「没点名」那两格不是所有来源都开放。**
   官方：`Cells for unaddressed messages are available only where the Source receives every message`
   —— 房间不是「收全部消息」时，未点名的消息**不可能成为候选**。
   本闸用 `receivesEveryMessage` 表达该约束，缺省 false（保守）。

4. **机器人永远不能造出 `explicit`。**
   官方：`They cannot make explicit requests or stop Tickets.`
   ⇒ 机器人即使在 `unlistedAddressed` 格被设为 explicit，也只算候选。

## 三条铁律
 *
 * 1. **纯函数、无副作用**：给定同样的输入，永远同样的输出。审计靠它。
 * 2. **绝不猜**：证据不足一律 `ignore`；「本会准入」只在 `observe` 下作为**记录**出现，
 *    绝不冒充成「已准入」。
 * 3. **reason 必须是人话**：这条消息为什么醒了/为什么没醒，人要能读懂并据此改规则。
 *
 * ## 依赖面
 *
 * node 内置都不用。零依赖（CI 检查 1 覆盖）。
 */

/** 准入模式。 */
export const ACCEPT_MODES = Object.freeze(['off', 'observe', 'auto'])

/** 缺省模式 —— 保守优先，先观察再放权。 */
export const DEFAULT_ACCEPT_MODE = 'observe'

/** 准入结论（三值，对齐 superagent 的 Admission）。 */
export const ADMISSIONS = Object.freeze({
  EXPLICIT: 'explicit', // 明确要你 —— 直接做，无需评估
  INFERRED: 'inferred', // 候选 —— 记下上下文，需要评估后才能动手
  IGNORE: 'ignore', // 不相关 —— 连上下文都不记
})

/**
 * 准入表的三个格子（对齐 superagent `src/admission.ts` 的 `ADMISSION_OPTIONS`）。
 *
 * ⚠️ 官方约束：**「没点名」那两格不是所有来源都开放**。
 * `Cells for unaddressed messages are available only where the Source receives every message`
 * —— 也就是说，房间不是「收全部消息」时，没点名的消息**根本不能成为候选**。
 * 这里用 `receivesEveryMessage` 输入表达该约束，缺省 false（保守）。
 */
export const ADMISSION_CELLS = Object.freeze({
  LISTED_UNADDRESSED: 'listedUnaddressed',
  UNLISTED_ADDRESSED: 'unlistedAddressed',
  UNLISTED_UNADDRESSED: 'unlistedUnaddressed',
})

/** 每格可选值（官方 ADMISSION_OPTIONS 逐字对齐）。 */
export const ADMISSION_OPTIONS = Object.freeze({
  listedUnaddressed: Object.freeze(['inferred', 'ignore']),
  unlistedAddressed: Object.freeze(['explicit', 'inferred', 'ignore']),
  unlistedUnaddressed: Object.freeze(['inferred', 'ignore']),
})

/** 缺省表（官方 ADMISSION_DEFAULTS 逐字对齐）。 */
export const ADMISSION_DEFAULTS = Object.freeze({
  listedUnaddressed: 'inferred',
  unlistedAddressed: 'ignore',
  unlistedUnaddressed: 'ignore',
})

/** 决策来源（审计用：知道是谁拍的板）。 */
export const DECIDED_BY = Object.freeze({
  LISTED_ADDRESSED: 'listed-addressed', // 名单上的人点名 —— 明确，无需评估
  TABLE_EXPLICIT: 'table-explicit', // 表格把「不在名单但点名」格设为 explicit
  LISTED_UNADDRESSED: 'listed-unaddressed', // 在名单上但没点名 —— 候选
  TABLE_INFERRED: 'table-inferred', // 表格把「不在名单且没点名」格设为 inferred
  MODE_OFF: 'mode-off', // 模式把候选关掉了
  MODE_OBSERVE: 'mode-observe', // 观察模式：记候选但不唤醒
  NOT_ON_LIST: 'not-on-list', // 不在名单上 —— 不相关
  STOPPED: 'stopped', // 订阅已停
  INVALID: 'invalid', // 输入不合法
})

/**
 * 消息是否**点名**找某个接收者。
 *
 * 认三种形状（历史演进过，读侧必须宽容）：
 *   - `message.to === recipientId`（定向发言）
 *   - `message.mentions` 含 `recipientId`
 *   - `message.text` 里出现 `@recipientId`（兜底，最弱但常见）
 *
 * @param {object} message 房间消息
 * @param {string} recipientId 接收者（bot 会话 id / 任务 id 皆可）
 * @returns {boolean}
 */
export function isAddressed(message, recipientId) {
  if (!message || typeof message !== 'object') return false
  if (typeof recipientId !== 'string' || recipientId === '') return false
  if (message.to === recipientId) return true
  if (Array.isArray(message.mentions) && message.mentions.includes(recipientId)) return true
  const text = typeof message.text === 'string' ? message.text : ''
  // `@id` 后必须跟非标识符字符（或结尾），否则 `@bot` 会误命中 `@bot-2`
  if (text) {
    const idx = text.indexOf(`@${recipientId}`)
    if (idx >= 0) {
      const after = text.slice(idx + 1 + recipientId.length)
      if (after === '' || !/[A-Za-z0-9_-]/.test(after[0])) return true
    }
  }
  return false
}

/**
 * 规则是否匹配这条消息（用于把某个格子设为 inferred/explicit 时加约束）。
 *
 * 规则形状（**只要有一条命中就算命中**）：
 *   - `{ from: 'bot-xxx' }`   —— 发信人
 *   - `{ kind: 'notice' }`    —— 消息类型
 *   - `{ contains: '上线' }`  —— 正文包含（大小写不敏感）
 *   - `{ regex: '^部署' }`    —— 正文正则（**编译失败视为不匹配**）
 *
 * 未知键规则 → 不匹配（严格：认不出的规则不能变成万能放行）。
 *
 * @param {object} message
 * @param {object} rule
 * @returns {boolean}
 */
export function matchesRule(message, rule) {
  if (!message || typeof message !== 'object') return false
  if (!rule || typeof rule !== 'object') return false
  const keys = Object.keys(rule)
  if (keys.length === 0) return false
  const text = typeof message.text === 'string' ? message.text : ''
  for (const key of keys) {
    if (key === 'from') {
      if (message.from !== rule.from) return false
    } else if (key === 'kind') {
      if (message.kind !== rule.kind) return false
    } else if (key === 'contains') {
      const needle = String(rule.contains ?? '')
      if (needle === '' || !text.toLowerCase().includes(needle.toLowerCase())) return false
    } else if (key === 'regex') {
      let re
      try {
        re = new RegExp(String(rule.regex ?? ''), 'i')
      } catch {
        return false // 坏规则 = 不匹配。绝不让手滑变成全放行。
      }
      if (!re.test(text)) return false
    } else {
      return false // 认不出的键：不放行
    }
  }
  return true
}

/**
 * 判定一条消息对某个接收者的准入结果。
 *
 * @param {object} input
 * @param {object} input.message 房间消息（`from`/`to`/`kind`/`text`/`mentions`）
 * @param {string} input.recipientId 接收者标识（会话 id 或任务 id）
 * @param {boolean} [input.subscribed] 是否订阅了该房间（在名单上）
 * @param {string} [input.subscriptionState] 订阅状态（`active` 才算在名单上）
 * @param {string} [input.acceptMode] `off` | `observe` | `auto`，缺省 observe
 * @param {object} [input.rules] 该格子上的规则列表（用于把 inferred/explicit 收窄到特定消息）
 * @returns {{
 *   admission: 'explicit'|'inferred'|'ignore',
 *   decidedBy: string,
 *   reason: string,
 *   addressed: boolean,
 *   onList: boolean,
 *   mode: string,
 *   wouldAccept: boolean,
 *   matchedRules: number,
 *   wake: boolean,
 * }}
 */
export function decideAdmission(input) {
  const {
    message,
    recipientId,
    subscribed,
    subscriptionState,
    acceptMode,
    table,
    receivesEveryMessage,
    senderIsBot,
  } = input && typeof input === 'object' ? input : {}

  // 模式归一：不认识的值 **退回 observe**（不是退回 auto）
  const mode = ACCEPT_MODES.includes(acceptMode) ? acceptMode : DEFAULT_ACCEPT_MODE

  if (!message || typeof message !== 'object') {
    return build(ADMISSIONS.IGNORE, DECIDED_BY.INVALID, '没有可判定的消息对象 —— 按不相关处理（不猜）', false, false, mode)
  }
  if (typeof recipientId !== 'string' || recipientId.trim() === '') {
    return build(ADMISSIONS.IGNORE, DECIDED_BY.INVALID, '没有接收者标识 —— 无法判定，按不相关处理', false, false, mode)
  }

  // 表格归一：非法格子值退回缺省（**绝不退回更宽的 explicit**）
  const cells = {
    listedUnaddressed: pickCell(table, 'listedUnaddressed'),
    unlistedAddressed: pickCell(table, 'unlistedAddressed'),
    unlistedUnaddressed: pickCell(table, 'unlistedUnaddressed'),
  }

  // 「在名单上」= 订阅存在 **且** 处于 active。停掉的订阅不算在名单上。
  const onList = subscribed === true && (subscriptionState === undefined || subscriptionState === 'active')
  const addressed = isAddressed(message, recipientId)

  // ① 在名单上 + 点名 —— **这一格不在表里**（官方：`no table cell`）。
  //    官方原文：`A listed sender who addresses the agent always makes an explicit request`
  //    ⇒ 三档模式都准入，无需评估。
  if (onList && addressed) {
    return build(ADMISSIONS.EXPLICIT, DECIDED_BY.LISTED_ADDRESSED,
      `名单上的人点名找了 ${recipientId} —— 明确要你，直接做（无需评估）`, true, true, mode)
  }

  // ② 不在名单上 —— 查表的 unlisted 两格
  if (!onList) {
    if (!addressed) {
      // 未点名 + 不在名单：只有当「收全部消息」且格子为 inferred 才成为候选。
      // 官方：`Cells for unaddressed messages are available only where the Source receives every message`
      if (receivesEveryMessage !== true) {
        return build(ADMISSIONS.IGNORE, DECIDED_BY.NOT_ON_LIST,
          `没订阅该房间，且该房间不是「收全部消息」—— 未点名的消息不可能是候选`, false, false, mode)
      }
      if (cells.unlistedUnaddressed === 'inferred') {
        return candidateOrIgnore(mode, cells.unlistedUnaddressed,
          `不在名单上、未点名，但该房间收全部消息且格子设为 inferred —— 候选`, false, false, mode)
      }
      return build(ADMISSIONS.IGNORE, DECIDED_BY.NOT_ON_LIST,
        `不在名单上、未点名 —— 表格该格为 ignore`, false, false, mode)
    }
    // 点名 + 不在名单：官方缺省 ignore；只有把格子改成 explicit 才准入
    if (senderIsBot === true) {
      // 官方：`They cannot make explicit requests` —— 机器人不能造出 explicit
      return build(ADMISSIONS.IGNORE, DECIDED_BY.NOT_ON_LIST,
        `机器人消息点名找了 ${recipientId}，但它没订阅该房间 —— 机器人不能造出 explicit 请求`, true, false, mode)
    }
    if (cells.unlistedAddressed === 'explicit') {
      return build(ADMISSIONS.EXPLICIT, DECIDED_BY.TABLE_EXPLICIT,
        `不在名单上但点名了 ${recipientId}，且表格把该格设为 explicit —— 准入（如专用支持群）`, true, false, mode)
    }
    if (cells.unlistedAddressed === 'inferred') {
      return candidateOrIgnore(mode, 'inferred',
        `不在名单上但点名了 ${recipientId}，表格该格设为 inferred —— 候选（不是明确）`, true, false, mode)
    }
    return build(ADMISSIONS.IGNORE, DECIDED_BY.NOT_ON_LIST,
      `消息点名找了 ${recipientId}，但它没订阅该房间 —— 被点名不等于有权限收（表格缺省 ignore）`, true, false, mode)
  }

  // ③ 在名单上但没点名 —— 查 listedUnaddressed 格
  if (!addressed && receivesEveryMessage !== true) {
    // 在名单上也只能收到点名消息 ⇒ 未点名的消息不会成为候选
    return build(ADMISSIONS.IGNORE, DECIDED_BY.LISTED_UNADDRESSED,
      '在名单上但未点名，且该房间不是「收全部消息」—— 未点名的消息不会成为候选', false, true, mode)
  }
  if (cells.listedUnaddressed === 'ignore') {
    return build(ADMISSIONS.IGNORE, DECIDED_BY.LISTED_UNADDRESSED,
      '在名单上但未点名，表格该格设为 ignore —— 不相关', false, true, mode)
  }
  return candidateOrIgnore(mode, 'inferred',
    '在名单上但未点名 —— 候选，记下上下文，是否动手由评估决定', false, true, mode)
}

/**
 * 候选成立时的收尾：`off` 把候选抹掉；`observe`/`auto` 都产出 `inferred`。
 *
 * ⚠️ 官方语义（docs/002 §Accept mode and rules）：
 *   - `off`：Nothing inferred becomes a candidate。
 *   - `observe`（缺省）：Inferred candidates **are assessed**；
 *     正向评估被记为 ignore 并标记 `would accept`，**什么都不接受**。
 *   - `auto`：正向评估的候选被接受。
 *
 * 也就是说 `observe` 与 `auto` **都产出候选、都要评估** —— 差别在评估之后。
 * 把 `observe` 做成「不评估」是错的：那样「would accept」永远没有依据。
 * 本闸只负责「是不是候选」；评估与放权是下一段的事。
 */
function candidateOrIgnore(mode, cellValue, reason, addressed, onList, m) {
  const modeActual = m ?? mode
  if (modeActual === 'off') {
    return build(ADMISSIONS.IGNORE, DECIDED_BY.MODE_OFF,
      `${reason.replace(/→.*$/, '')}但模式是 off —— 候选不成立（off = 没有候选）`, addressed, onList, modeActual)
  }
  return build(ADMISSIONS.INFERRED, DECIDED_BY.LISTED_UNADDRESSED,
    modeActual === 'observe'
      ? `${reason}（观察模式：评估会照做，但正向结论只记为 would accept，不会真的接受）`
      : `${reason}（自动模式：正向评估的候选会被接受）`,
    addressed, onList, modeActual)
}

/** 取格子值：非法值退回缺省（绝不退回更宽的 explicit）。 */
function pickCell(table, key) {
  const v = table && typeof table === 'object' ? table[key] : undefined
  const allowed = ADMISSION_OPTIONS[key]
  return allowed.includes(v) ? v : ADMISSION_DEFAULTS[key]
}

/** 构造返回形状（保证字段恒存在，调用方不用做 null 判断）。 */
function build(admission, decidedBy, reason, addressed, onList, mode, extra = {}) {
  const wake = extra.wake === true
  return {
    admission,
    decidedBy,
    reason,
    addressed,
    onList,
    mode,
    // ⚠️ `wouldAccept` 由**评估**阶段决定，Gate 只判「是不是候选」。
    //    Gate 阶段恒为 false —— 否则就是把「评估结论」提前伪造出来。
    //    （官方：observe 下正向评估记为 ignore 且标 "would accept"）
    wouldAccept: extra.wouldAccept === true,
    matchedRules: extra.matchedRules ?? 0,
    wake,
  }
}

export default {
  ACCEPT_MODES,
  DEFAULT_ACCEPT_MODE,
  ADMISSIONS,
  ADMISSION_CELLS,
  ADMISSION_OPTIONS,
  ADMISSION_DEFAULTS,
  DECIDED_BY,
  isAddressed,
  matchesRule,
  decideAdmission,
}
