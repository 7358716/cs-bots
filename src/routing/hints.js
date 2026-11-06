/**
 * cs-bots 复杂度路由 hint 注入 —— **唯一的宿主触点在 `../kernel.js`（`onLlmStream`）**。
 *
 * 契约：`design/17-并发感知路由层-接口契约-v1.md` §3（hint 形状）+ §6（注入点）。
 *
 * ── 为什么必须走旁路注册表（不要试图改 options）────────────────────────────────
 * 宿主 `dsh-agent-loop` 在 dispatch 前把请求对象 `Object.freeze(...)` 后交给 adapter，
 * 再经 `ctx.waterfall(this, 'llm/stream', options, ...)` 瀑布（证据：
 * `dsh-llm/lib/index.js:2397`，签名 `'llm/stream'(this, options: GenerateOptions,
 * next: () => AsyncIterable<StreamChunk>)`，官方插件用法见
 * `dsh-session-checkpoint-policy/lib/index.js:61`）。
 * ⇒ `options` **只读**。任何「给请求加个 metadata 字段」的做法在运行时都会失败，
 *   所以 hint 只能写进跨插件的旁路注册表：
 *     `globalThis[Symbol.for('cs-myfree.routing.hints.v1')] = { version, api }`
 *   由 cs-myfree 读取（`options.sessionId` → hint）。
 *
 * ── 三条硬纪律 ──────────────────────────────────────────────────────────────
 *   1. **fail-open**：`llm/stream` 的 handler **永远** `return next()`。本模块任何
 *      异常（注册表缺失、cs-myfree 内部抛错、hint 形状校验失败）都只记统计，
 *      绝不让一条对话请求失败 —— 路由优化不值得拿可用性换。
 *   2. **只碰自己那一格**：仅当 `options.provider === 'cs-myfree'` 时写 hint。
 *      官方 deepseek 渠道、其它 adapter 一律不写（写了也没人读，纯污染）。
 *   3. **迟到也能装**：注册表在**每次请求时**动态解析（而不是安装时缓存），
 *      因此 cs-myfree 比 cs-bots 晚装载也能生效；缺失时静默跳过。
 *
 * 本文件**不 import 任何宿主包**（`test/ci-zero-dep.sh` 检查 1 机械强制）。
 */

import {
  billingTierFor,
  classifyComplexity,
  normalizeRole,
  normalizeSubagentMode,
  normalizeTier,
} from './complexity.js'

/** 跨插件唯一入口（与 cs-myfree 的 `adapter/routing-hints.js` 必须逐字一致）。 */
export const HINTS_SYMBOL = Symbol.for('cs-myfree.routing.hints.v1')
/**
 * 本模块写入的 hint 版本。
 *
 * v1（`design/17` §3）= 六键；v2（`design/22` 契约 E1/E4）= 六键 + 两个**可选**键
 * `follow_parent_routing` / `pinned_model`。
 *
 * 🔴 交叉兼容纪律（两个仓库的版本必然错开升级）：
 *   · **v1 六键 hint 仍然合法**（本模块未声明策略时**照旧只发六键**，形状不变）；
 *   · **未知键必须被丢弃而不是报错** —— 旧 cs-myfree 读新 hint、新 cs-myfree 读旧
 *     hint 都必须能跑；报错会让整条授权链路静默消失（比缺功能更难查）。
 */
export const HINTS_VERSION = 2
/** 请求级 hint 的来源标识（可审计：谁写的）。 */
export const SOURCE_LLM_STREAM = 'cs-bots/llm-stream'
/** 任务板 claim/wake 时写 hint 的来源标识。 */
export const SOURCE_TASK_BOARD = 'cs-bots/task-board'
/**
 * hint 有效期（ms）—— 与 cs-myfree 注册表默认 `ttlMs` 对齐（契约 §3：30 分钟）。
 * 用于 `mergeHint` 判定「任务授权是否还能延续」，避免一条旧的 paid_allowed 永久生效。
 */
export const HINT_TTL_MS = 30 * 60 * 1000

/** cs-myfree 的 provider 路由名（只有它读 hint）。 */
const MYFREE_PROVIDER = 'cs-myfree'
/** token 粗估：字符数 / 4（英文代码约 3.5–4 字符/token，中文约 1.5–2；取 4 保守）。 */
const CHARS_PER_TOKEN = 4

// ── 请求信号提取（纯函数）───────────────────────────────────────────────────

/** 单条消息的文本长度（兼容 string content / parts 数组 / 裸 text 字段）。 */
function messageChars(message) {
  if (!message || typeof message !== 'object') return 0
  let total = 0
  const { content, text } = message
  if (typeof content === 'string') total += content.length
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue
      if (typeof part === 'string') total += part.length
      else if (typeof part.text === 'string') total += part.text.length
      else if (typeof part.content === 'string') total += part.content.length
    }
  }
  if (typeof text === 'string') total += text.length
  return total
}

/** 粗估上下文 token 数（字符 / 4，向上取整）。 */
export function estimateContextTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  let chars = 0
  for (const m of messages) chars += messageChars(m)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** 请求是否带工具（工具声明 / 工具历史 / 历史里的工具调用与结果都算）。 */
export function detectToolUse(options = {}) {
  const { tools, toolHistory, messages } = options ?? {}
  if (Array.isArray(tools) && tools.length > 0) return true
  if (Array.isArray(toolHistory) && toolHistory.length > 0) return true
  if (toolHistory && typeof toolHistory === 'object' && !Array.isArray(toolHistory)) {
    if (Object.keys(toolHistory).length > 0) return true
  }
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      if (m.role === 'tool') return true
      const calls = m.toolCalls ?? m.tool_calls
      if (Array.isArray(calls) && calls.length > 0) return true
    }
  }
  return false
}

/**
 * 从宿主请求对象提取分类器需要的信号。
 *
 * ⚠️ 只读：`options` 在宿主里是冻结对象，这里**绝不写回**。
 *
 * @param {object} options 宿主 `llm/stream` 的 GenerateOptions（可含 provider/model/sessionId/messages/tools/signal）
 * @param {{ role?: string, requiresPaid?: boolean, explicitComplexity?: string,
 *           contextTokens?: number } } [extra] 平台侧已知信息（角色 / 任务标注 / 已测 token）
 * @returns {{ contextTokens: number, historyDepth: number, hasToolCalls: boolean,
 *             agentRole: string, explicitComplexity: string|null }}
 */
export function signalsFromRequest(options = {}, extra = {}) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const measured = typeof extra?.contextTokens === 'number' && Number.isFinite(extra.contextTokens)
    ? extra.contextTokens
    : undefined
  return {
    contextTokens: measured ?? estimateContextTokens(messages),
    historyDepth: messages.length,
    hasToolCalls: detectToolUse(options),
    agentRole: normalizeRole(extra?.role),
    explicitComplexity: normalizeTier(extra?.explicitComplexity),
  }
}

// ── hint 构造（纯函数，离线可测）──────────────────────────────────────────────

/** v1 六键（`design/17` §3，语义冻结不许改）。 */
export const HINT_KEYS_V1 = Object.freeze([
  'billing_tier', 'complexity_tier', 'agent_role', 'requires_paid', 'source', 'at',
])

/** v2 新增的两个**可选**键（`design/22` 契约 E1）。 */
export const HINT_KEYS_V2 = Object.freeze(['follow_parent_routing', 'pinned_model'])

/** 本模块认得的全部键（白名单：其余一律丢弃）。 */
export const KNOWN_HINT_KEYS = Object.freeze([...HINT_KEYS_V1, ...HINT_KEYS_V2])

/**
 * 白名单过滤 hint：**只保留认得的键**（未知键丢弃，绝不抛错）。
 *
 * 用于「结果出口」而不是「入口校验」：cs-myfree 侧 `normalizeHint` 也是白名单重建，
 * 两边都丢弃未知键 ⇒ 任一仓库先升级都不会把对方搞挂（契约 E4 的交叉兼容要求）。
 *
 * @param {unknown} hint
 * @returns {object} 只含已知键的新对象（原对象不动；`null`/非对象 ⇒ `{}`）
 */
export function pickHintKeys(hint) {
  const out = {}
  if (!hint || typeof hint !== 'object') return out
  for (const key of KNOWN_HINT_KEYS) {
    if (hint[key] !== undefined) out[key] = hint[key]
  }
  return out
}

/**
 * 归一化 `follow_parent_routing`：只认布尔，其它 ⇒ `undefined`（= **不出现在 hint 里**）。
 *
 * 为什么是 `undefined` 而不是 `null`：cs-bots 是 hint 的**生产方**，
 * 「没有声明」就应该连键都不发（保持 v1 六键形状不变 ⇒ 旧 cs-myfree 零感知）。
 * cs-myfree 是消费方，它那边才把「缺键」归一成 `null`。
 *
 * @param {unknown} value
 * @returns {boolean|undefined}
 */
export function normalizeFollowParentRouting(value) {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 归一化 `pinned_model`（`'provider/model'` 或裸模型名）：非法 ⇒ `undefined`（不发该键）。
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function normalizePinnedModel(value) {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (!s) return undefined
  if (/[\s\u0000-\u001F\u007F]/.test(s)) return undefined
  return s.slice(0, 128)
}

/**
 * 由 `subagentRouting`（或显式声明）推导两个 v2 键（纯函数）。
 *
 * 映射（契约 E3 三选项，逐条对应，不自创）：
 *   · mode='follow' ⇒ `follow_parent_routing: true`
 *   · mode='pinned' ⇒ `follow_parent_routing: false` + `pinned_model: model`（无 model 则不发该键）
 *   · mode='auto'   ⇒ `follow_parent_routing: false`（明确不跟随，由 myfree 自动选路）
 *   · 未配置（null）⇒ **两个键都不发**（保持 v1 六键形状 ⇒ 零回归）
 *
 * 显式 `followParentRouting` / `pinnedModel` 优先级高于 `subagentRouting.mode`（便于
 * 任务板按任务覆盖）。
 *
 * @param {{ subagentRouting?: object|null, followParentRouting?: boolean,
 *           pinnedModel?: string|null }} [deps]
 * @returns {{ follow?: boolean, pinned?: string }}
 */
export function subagentRoutingKeys(deps = {}) {
  const out = {}
  const explicitFollow = normalizeFollowParentRouting(deps?.followParentRouting)
  const explicitPinned = normalizePinnedModel(deps?.pinnedModel)
  const mode = normalizeSubagentMode(deps?.subagentRouting?.mode)

  if (explicitFollow !== undefined) out.follow = explicitFollow
  else if (mode === 'follow') out.follow = true
  else if (mode === 'pinned' || mode === 'auto') out.follow = false

  if (explicitPinned !== undefined) out.pinned = explicitPinned
  else if (mode === 'pinned') {
    const pinned = normalizePinnedModel(deps?.subagentRouting?.model)
    if (pinned !== undefined) out.pinned = pinned
  }
  return out
}

/**
 * 造一个契约形状的 hint。
 *
 * v1 六键**永远**都在（值域不变）；v2 两键是**可选**的 —— 传了才出现，
 * 没传就不出现（这是「v1 客户端/旧配置 ⇒ 形状与今天逐字一致」的落地方式）。
 *
 * @param {{ billing_tier: 'free_only'|'paid_allowed', complexity_tier: string|null,
 *           agent_role: 'main'|'subagent'|'unknown', requires_paid: boolean,
 *           source: string, at: number,
 *           follow_parent_routing?: boolean|null, pinned_model?: string|null }} parts
 * @returns {object}
 */
function buildHint(parts) {
  const hint = {
    billing_tier: parts.billing_tier,
    complexity_tier: parts.complexity_tier ?? null,
    agent_role: parts.agent_role,
    requires_paid: parts.requires_paid === true,
    source: String(parts.source),
    at: parts.at,
  }
  const follow = normalizeFollowParentRouting(parts.follow_parent_routing)
  if (follow !== undefined) hint.follow_parent_routing = follow
  const pinned = normalizePinnedModel(parts.pinned_model)
  if (pinned !== undefined) hint.pinned_model = pinned
  return hint
}

/**
 * 判定一条既有 hint 是否为「任务级付费授权态」（`mergeHint` 用）。
 *
 * 两个来源都算：`SOURCE_TASK_BOARD`（claim/wake 首次授权）与 `SOURCE_LLM_STREAM`
 * （本 handler 合并后的续期形态）—— 只认前者会让授权在第二条请求就衰减（真 bug）。
 * 以 `requires_paid === true` 作为授权态的自描述标记（hint 形状 v1 冻结，不能加 `granted_at`）。
 *
 * @param {unknown} hint
 * @returns {boolean}
 */
function isTaskGrant(hint) {
  if (!hint || typeof hint !== 'object') return false
  if (hint.billing_tier !== 'paid_allowed') return false
  if (hint.requires_paid !== true) return false
  return hint.source === SOURCE_TASK_BOARD || hint.source === SOURCE_LLM_STREAM
}

/**
 * 合并「已存在的 hint」与「本次请求算出的 hint」—— **只升不降**（纯函数）。
 *
 * 这是 P3-fix 的核心（2026-11-04 缺陷）：`applyTaskHint` 在 claim/wake 时写入的
 * `paid_allowed` 是**任务级授权**，下一条 llm/stream 请求算出的 `free_only`（子智能体默认）
 * 不能把它踩掉；否则「requires_paid:true 的子任务获付费」永远失效。
 *
 * 规则（严格按此，不做别的推断）：
 *   1. `next.billing_tier === 'paid_allowed'` ⇒ 用 next（平台已判定本次就该付费）；
 *   2. 否则，若已存在一条**未过期**的「任务授权态」hint（`billing_tier === 'paid_allowed'`
 *      且 `requires_paid === true`，来源为 `SOURCE_TASK_BOARD` 或本模块）⇒ 保留 paid_allowed，
 *      但 `complexity_tier` / `at` / `source` 用 next 的（新鲜度），`requires_paid` 保持 true；
 *   3. 其余 ⇒ 用 next（即正常降回 free_only；任务授权过期/来源不可信时不做特殊处理）。
 *
 * ⚠️ 为什么授权态要认 `SOURCE_LLM_STREAM` 这一来源（P3-fix 第二轮，实测抓到）：
 *   合并结果由本 handler 写回，其 `source` 是 `'cs-bots/llm-stream'`。若只认
 *   `SOURCE_TASK_BOARD`，则**第二条请求**就会把授权判成「来源不成立」而降级
 *   —— 缺陷只是从「第一条」推迟到「第二条」，仍然失效。hint 形状 v1 冻结（六个键）
 *   不许多存一个 `granted_at`，故用 `requires_paid === true` 作为「授权态」的自描述标记。
 *   代价：只要该会话持续发请求，授权就持续有效；**静默 30 分钟（`HINT_TTL_MS`）后失效**
 *   （`at` 每次刷新 ⇒ 滚动 TTL，这是与 cs-myfree 注册表 TTL 对齐后的语义）。
 *
 * @param {object|null|undefined} existing 注册表里已有的 hint（可能为 null）
 * @param {object} next 本次请求算出的 hint
 * @param {{ now?: number, ttlMs?: number }} [opts]
 * @returns {object} 要写入的 hint（只含已知键；未声明策略时**恰好六键**，与契约 §3 一致）
 */
export function mergeHint(existing, next, opts = {}) {
  if (!next || typeof next !== 'object') return next
  const merged = mergeHintCore(existing, next, opts)
  return pickHintKeys(merged)
}

/**
 * `mergeHint` 的实体（`pickHintKeys` 只做出口白名单，逻辑全在这里）。
 *
 * v2 两键的合并规则（与 billing_tier 的"只升不降"**不同**，刻意分开）：
 *   · 它们是**声明式策略**，不是授权：本次请求声明了就以本次为准；
 *   · 本次没声明（缺键）时**继承既有** —— 否则「claim 时写了 follow，下一条
 *     llm/stream 请求没带策略」会把跟随关系抹掉（策略抖动 ⇒ 选路抖动）；
 *   · 既有的也不带 ⇒ 两键都不出现（v1 六键形状）。
 */
function mergeHintCore(existing, next, opts = {}) {
  if (next.billing_tier === 'paid_allowed') return next
  const base = { ...next }
  const carryStrategy = () => {
    for (const key of HINT_KEYS_V2) {
      if (base[key] === undefined && existing && typeof existing === 'object' && existing[key] !== undefined) {
        base[key] = existing[key]
      }
    }
  }

  if (!existing || typeof existing !== 'object') {
    carryStrategy()   // existing 缺失时无需继承，但走同一路径保证形状一致
    return base
  }

  if (!isTaskGrant(existing)) {
    carryStrategy()
    return base
  }

  const issuedAt = typeof existing.at === 'number' && Number.isFinite(existing.at) ? existing.at : null
  if (issuedAt === null) {
    carryStrategy()
    return base
  }
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now)
    ? opts.now
    : (typeof next.at === 'number' && Number.isFinite(next.at) ? next.at : null)
  if (now === null) {
    carryStrategy()
    return base
  }
  const ttl = typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
    ? opts.ttlMs
    : HINT_TTL_MS
  if (now - issuedAt >= ttl) {
    carryStrategy()
    return base
  }

  carryStrategy()
  return { ...base, billing_tier: 'paid_allowed', requires_paid: true }
}

/**
 * 由一次请求解析出应该写入的 hint（纯函数 —— 便于离线表驱动测试）。
 *
 * 返回 `null` 的全部情形（**都算正常**，不是错误）：
 *   - `options.provider !== 'cs-myfree'`：别的渠道不读 hint；
 *   - 没有 `sessionId`：注册表按 sessionId 建索引，无键可写。
 *
 * @param {object} options
 * @param {{ role?: string, requiresPaid?: boolean, explicitComplexity?: string,
 *           source?: string, now?: number, contextTokens?: number,
 *           subagentRouting?: { mode?: string, model?: string|null }|null,
 *           parentBillingTier?: string, followParentRouting?: boolean,
 *           pinnedModel?: string|null }} [deps]
 *   `subagentRouting` —— 子智能体路由跟随策略（`design/22` 契约 E3/E4）；
 *     缺省 ⇒ **两个 v2 键都不写**（v1 六键形状不变，零回归）。
 *   `parentBillingTier` —— 上级会话的授权标签，仅在 mode='follow' 时用于继承。
 * @returns {object|null} hint
 */
export function resolveHint(options, deps = {}) {
  if (!options || typeof options !== 'object') return null
  if (options.provider !== MYFREE_PROVIDER) return null
  const sessionId = options.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null

  const role = normalizeRole(deps?.role)
  const requiresPaid = deps?.requiresPaid === true
  const explicitComplexity = normalizeTier(deps?.explicitComplexity)
  const signals = signalsFromRequest(options, { role, explicitComplexity, contextTokens: deps?.contextTokens })
  const classified = classifyComplexity(signals)
  const at = typeof deps?.now === 'number' && Number.isFinite(deps.now) ? deps.now : Date.now()
  // v2 策略两键：未配置 ⇒ `{}`（⇒ buildHint 不写这两键，形状与 v1 逐字一致）
  const strategy = subagentRoutingKeys(deps)

  return buildHint({
    billing_tier: billingTierFor({
      tier: classified.tier,
      role,
      requiresPaid,
      subagentRouting: deps?.subagentRouting,
      parentBillingTier: deps?.parentBillingTier,
    }),
    complexity_tier: classified.tier,
    agent_role: role,
    requires_paid: requiresPaid,
    source: deps?.source ?? SOURCE_LLM_STREAM,
    at,
    follow_parent_routing: strategy.follow,
    pinned_model: strategy.pinned,
  })
}

// ── 注册表发现 ──────────────────────────────────────────────────────────────

/**
 * 读 cs-myfree 的旁路注册表。
 *
 * **未安装 ⇒ 返回 null ⇒ 调用方静默跳过**（这是契约要求的降级路径，不是错误）。
 * 逐个字段防御式取值：`api.setRequestHint` 不是函数就当作未安装，
 * 免得 cs-myfree 改版后 cs-bots 直接把请求搞挂。
 *
 * @param {object} [scope] 便于测试替换（默认 globalThis）
 * @returns {{ version: number|string|null, api: { setRequestHint: Function,
 *             getRequestHint?: Function, clearRequestHint?: Function } } | null}
 */
export function getGlobalHintsRegistry(scope = globalThis) {
  try {
    const entry = scope?.[HINTS_SYMBOL]
    if (!entry || typeof entry !== 'object') return null
    const api = entry.api
    if (!api || typeof api.setRequestHint !== 'function') return null
    return { version: entry.version ?? null, api }
  } catch {
    // Symbol 访问本身被代理陷阱拒绝时也不能炸
    return null
  }
}

// ── 注入安装 ────────────────────────────────────────────────────────────────

/**
 * 装 `llm/stream` 拦截：**每条请求前**把复杂度 hint 写进 cs-myfree 的旁路注册表。
 *
 * 返回语义（契约 §6 + Lead 的 DoD 口径）：
 *   - `hooked`    —— `llm/stream` 拦截是否已注册成功（kernel 窄接口是否可用）
 *   - `installed` —— `hooked && 当前能解析到 cs-myfree 注册表`
 *     ⇒ cs-myfree 未安装时是 `{ installed:false, reason:'cs-myfree-registry-missing' }`，
 *        **但 handler 仍然会被调用并 `return next()`**（请求照常进行，只是不写 hint）。
 *        「先装钩子、运行时再发现注册表」是刻意的：cs-myfree 后装载也能立刻生效。
 *   - `handler` / `stats` —— 便于离线测试与诊断（不对外暴露给模型）。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ onLlmStream?: Function }} kernel `../kernel.js` 的窄接口集合
 * @param {{ warn?: Function, role?: string, requiresPaid?: boolean,
 *           explicitComplexity?: string, source?: string, now?: Function,
 *           getRegistry?: Function,
 *           roleOf?: (sessionId: string) => 'main'|'subagent'|'unknown',
 *           subagentRouting?: object|null,
 *           subagentRoutingOf?: (sessionId: string) => object|null,
 *           parentBillingTier?: string,
 *           followParentRouting?: boolean, pinnedModel?: string|null,
 *           hintTtlMs?: number }} [opts]
 *   `roleOf` —— **每次请求按 sessionId 动态解析角色**（P3-fix）：主对话 ⇒ `main`（⇒ paid_allowed），
 *               注册表里的 Bot 会话 ⇒ `subagent`（⇒ free_only）。抛错/缺省 ⇒ `unknown`（fail-closed）。
 *   `subagentRouting` / `subagentRoutingOf` —— v2 子智能体路由策略（`design/22` 契约 E4，
 *               `{ mode:'auto'|'pinned'|'follow', model, fallback }`）；**缺省 ⇒ hint 只含六键**
 *               （v1 形状不变 ⇒ 零回归）。`Of` 形式按 sessionId 逐请求解析（与 `roleOf` 同理）。
 *   `hintTtlMs` —— 任务级授权 hint 的延续上限（缺省 30 分钟，见 `HINT_TTL_MS`）。
 * @returns {{ installed: boolean, hooked: boolean, reason?: string,
 *             handler: Function, stats: object }}
 */
export function installLlmStreamHint(ctx, kernel, opts = {}) {
  const warn = typeof opts?.warn === 'function' ? opts.warn : () => {}
  const now = typeof opts?.now === 'function' ? opts.now : () => Date.now()
  const getRegistry = typeof opts?.getRegistry === 'function' ? opts.getRegistry : getGlobalHintsRegistry
  const source = opts?.source ?? SOURCE_LLM_STREAM

  /** 运行期统计（诊断用：为什么这条请求没拿到 hint）。 */
  const stats = {
    calls: 0,
    injected: 0,
    skippedProvider: 0,
    skippedNoSession: 0,
    skippedNoRegistry: 0,
    errors: 0,
    /** `opts.roleOf` 抛错的次数（每次都会降级为 unknown ⇒ free_only）。 */
    roleOfErrors: 0,
    /** 注册表不提供 `getRequestHint` 的次数（无法读旧 hint ⇒ 按无 existing 处理）。 */
    existingUnavailable: 0,
    /** 读旧 hint 抛错的次数（fail-open：照常写 next）。 */
    existingReadErrors: 0,
    /** 本次 next 只是 free_only、但因任务授权而保留 paid_allowed 的次数（P3-fix 的关键指标）。 */
    carriedTaskAuth: 0,
    /** `opts.subagentRoutingOf` 抛错的次数（每次都会降级为「未配置」⇒ v1 六键形状）。 */
    subagentRoutingErrors: 0,
  }

  /**
   * 解析**这条请求**的子智能体路由策略（`design/22` 契约 E4）。
   *
   * `opts.subagentRoutingOf` 未提供时退回安装时的静态 `opts.subagentRouting`；
   * 抛错/返回垃圾 ⇒ `null`（= 未配置 ⇒ 只写 v1 六键，行为与今天一致）。
   */
  function safeStrategyOf(strategyOf, sessionId) {
    try {
      const v = strategyOf(sessionId)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch (error) {
      stats.subagentRoutingErrors += 1
      try {
        warn(`[cs-bots] subagentRoutingOf 解析失败（按「未配置」处理 ⇒ 六键 hint）：${error?.message ?? error}`)
      } catch {
        /* 静默 */
      }
      return null
    }
  }

  /**
   * 解析**这条请求**的角色（每次请求都重新算，不缓存 —— session 的角色可能变，
   * 缓存会让「Bot 会话先按 main 拿到付费」这种错误永久化）。
   *
   * `opts.roleOf` 未提供时退回安装时静态 `opts.role`（向后兼容）；
   * 抛错/返回垃圾值 ⇒ `'unknown'`（⇒ free_only，fail-closed）。
   */
  function resolveRequestRole(sessionId) {
    const roleOf = opts?.roleOf
    if (typeof roleOf !== 'function') return normalizeRole(opts?.role)
    try {
      return normalizeRole(roleOf(sessionId))
    } catch (error) {
      stats.roleOfErrors += 1
      try {
        warn(`[cs-bots] roleOf 解析失败（按 unknown ⇒ free_only 处理）：${error?.message ?? error}`)
      } catch {
        /* 静默 */
      }
      return 'unknown'
    }
  }

  /** 读注册表里已存在的 hint；无该方法/读失败一律返回 null（fail-open，不拦请求）。 */
  function readExistingHint(registry, sessionId) {
    const getter = registry?.api?.getRequestHint
    if (typeof getter !== 'function') {
      stats.existingUnavailable += 1
      return null
    }
    try {
      return getter(sessionId) ?? null
    } catch {
      stats.existingReadErrors += 1
      return null
    }
  }

  /**
   * 核心 handler —— **永远**返回 `next()`。
   * 刻意写成同步函数：`llm/stream` 的 `next()` 返回 `AsyncIterable<StreamChunk>`，
   * 包成 async 会把它变成 Promise<AsyncIterable>，与瀑布签名不符。
   */
  function handler(options, next) {
    stats.calls += 1
    try {
      if (options?.provider !== MYFREE_PROVIDER) {
        stats.skippedProvider += 1
      } else if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
        stats.skippedNoSession += 1
      } else {
        const registry = getRegistry()
        if (!registry) {
          stats.skippedNoRegistry += 1
        } else {
          const sessionId = options.sessionId
          const hint = resolveHint(options, {
            role: resolveRequestRole(sessionId),
            requiresPaid: opts?.requiresPaid,
            explicitComplexity: opts?.explicitComplexity,
            source,
            now: now(),
            // v2 策略（`design/22` 契约 E4）：缺省不传 ⇒ hint 只有六键（零回归）
            subagentRouting: typeof opts?.subagentRoutingOf === 'function'
              ? safeStrategyOf(opts.subagentRoutingOf, sessionId, stats, warn)
              : opts?.subagentRouting,
            parentBillingTier: opts?.parentBillingTier,
            followParentRouting: opts?.followParentRouting,
            pinnedModel: opts?.pinnedModel,
          })
          if (hint) {
            // ⚠️ P3-fix：写入前先与已有 hint 合并（**只升不降**），否则 claim 写的
            //   paid_allowed 会被下一条请求踩成 free_only，「requires_paid 子任务获付费」失效。
            const existing = readExistingHint(registry, sessionId)
            const effective = mergeHint(existing, hint, { now: hint.at, ttlMs: opts?.hintTtlMs })
            if (
              effective?.billing_tier === 'paid_allowed'
              && hint.billing_tier !== 'paid_allowed'
            ) {
              stats.carriedTaskAuth += 1
            }
            registry.api.setRequestHint(sessionId, effective)
            stats.injected += 1
          } else {
            stats.skippedProvider += 1
          }
        }
      }
    } catch (error) {
      stats.errors += 1
      // fail-open：写 hint 失败绝不影响请求
      try {
        warn(`[cs-bots] 写复杂度路由 hint 失败（已忽略，请求照常）：${error?.message ?? error}`)
      } catch {
        /* 连日志都失败 → 完全静默 */
      }
    }
    return typeof next === 'function' ? next() : undefined
  }

  let hooked = false
  try {
    hooked = typeof kernel?.onLlmStream === 'function' ? kernel.onLlmStream(ctx, handler) === true : false
  } catch (error) {
    hooked = false
    try {
      warn(`[cs-bots] 注册 llm/stream 拦截失败（降级：不注入 hint）：${error?.message ?? error}`)
    } catch {
      /* 静默 */
    }
  }

  if (!hooked) {
    return { installed: false, hooked: false, reason: 'llm-stream-hook-unavailable', handler, stats }
  }

  let registry = null
  try {
    registry = getRegistry()
  } catch {
    registry = null
  }
  if (!registry) {
    return { installed: false, hooked: true, reason: 'cs-myfree-registry-missing', handler, stats }
  }
  return { installed: true, hooked: true, registryVersion: registry.version, handler, stats }
}

// ── 任务板 → 会话 hint ──────────────────────────────────────────────────────

/**
 * 用**任务字段**给 owner 会话写 hint（claim / wake 时调用）。
 *
 * 契约 §6 末段：「子任务被 claim/wake 时，平台用该任务字段给 owner 会话写 hint
 * （`requiresPaid` ⇒ paid_allowed）」。所以：
 *   - `task.expectedComplexity`（T0–T3）→ `complexity_tier`
 *   - `task.requiresPaid === true` → `billing_tier = paid_allowed`，否则 `free_only`
 *   - owner 默认按 `subagent` 记账（窄执行者），可用 `opts.role` 覆盖（如主 Agent 自领）
 *
 * 无 cs-myfree 注册表 ⇒ `{ ok:false, reason:'cs-myfree-registry-missing' }`（静默跳过，
 * **不抛**：hint 只是优化，任务板照样要能干活）。`setRequestHint` 抛错也一并吞掉并回报原因。
 *
 * @param {object} task BoardService 的 Task
 * @param {string} sessionId 目标会话（claim 时的 owner / wake 时的 target）
 * @param {{ role?: string, source?: string, now?: number, getRegistry?: Function,
 *           subagentRouting?: object|null, followParentRouting?: boolean,
 *           pinnedModel?: string|null, parentBillingTier?: string }} [opts]
 *   v2 策略键（`subagentRouting` / `followParentRouting` / `pinnedModel`）缺省时
 *   **不写入**两个新键 ⇒ hint 仍是 v1 六键形状（零回归）。
 * @returns {{ ok: boolean, hint?: object, reason?: string }}
 */
export function applyTaskHint(task, sessionId, opts = {}) {
  try {
    if (!task || typeof task !== 'object') return { ok: false, reason: 'no-task' }
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, reason: 'no-session' }
    const getRegistry = typeof opts?.getRegistry === 'function' ? opts.getRegistry : getGlobalHintsRegistry
    const registry = getRegistry()
    if (!registry) return { ok: false, reason: 'cs-myfree-registry-missing' }

    const tier = normalizeTier(task.expectedComplexity)
    const requiresPaid = task.requiresPaid === true
    const role = normalizeRole(opts?.role ?? 'subagent')
    const at = typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
    // 任务级策略覆盖（`design/22` 契约 E4）：缺省 ⇒ 不写 v2 两键（六键零回归）
    const strategy = subagentRoutingKeys(opts)
    const hint = buildHint({
      billing_tier: billingTierFor({
        tier: tier ?? undefined,
        role,
        requiresPaid,
        subagentRouting: opts?.subagentRouting,
        parentBillingTier: opts?.parentBillingTier,
      }),
      complexity_tier: tier,
      agent_role: role,
      requires_paid: requiresPaid,
      source: opts?.source ?? SOURCE_TASK_BOARD,
      at,
      follow_parent_routing: strategy.follow,
      pinned_model: strategy.pinned,
    })
    registry.api.setRequestHint(sessionId, hint)
    return { ok: true, hint }
  } catch (error) {
    return { ok: false, reason: `hint-write-failed:${error?.message ?? error}` }
  }
}

export default installLlmStreamHint
