/**
 * cs-bots DisciplineService —— 分级纪律体系（DESIGN-v2 §特性②）。
 *
 * 概念（契约冻结，勿改语义）：
 *   - **层级 scope**：global（全局）→ workspace（工作区，按 cwd）→ room（房间）→ bot（单 Bot）；
 *     越具体越靠后，冲突时**具体优先**。
 *   - **分类 kind**：rule（纪律/硬规矩）、requirement（要求/交付标准）、
 *     principle（原则/价值观）、style（风格/说话方式）。
 *   - **优先级 priority**：数字越大越靠前（缺省 0）。
 *
 * ── 三条不变量（与 board.js 同款，机械保证）──
 *   1. **CAS 优先**：任何变更都要带 `expectedRev`；不匹配即抛错，绝不静默覆盖。
 *   2. **事件流是真相源**：先 append `discipline.jsonl`（失败即抛错，内存原封不动），
 *      再更新内存，最后原子写 `discipline.snap.json`（快照失败只降级 warn ——
 *      事件流已落盘，`replay()` 能完整重建）。
 *   3. **写失败绝不静默**：append 失败抛 `DISCIPLINE_APPEND_FAILED` 并回滚内存/计数器。
 *
 * ── 为什么 token 估算要**复制** memory.js 的 estimateTokens 而不是 import ──
 *   ① 本模块刻意保持轻量（只依赖 `./store.js` + `./kernel.js` 惰性桥），
 *      memory.js 是 3k+ 行的重模块，为 8 行函数把它拖进来不值；
 *   ② 更要紧的是**写入范围纪律**：memory.js 属于 memory 负责人，
 *      从它 import 会把本模块的可用性绑到别人的改动上（改坏一处，纪律注入全瘫）。
 *   ③ 口径必须**逐字一致**（4 字符/token，宽字符按 1.5）—— 否则「同一段文本，
 *      记忆注入算 100 token、纪律注入算 130」，预算口径就不可比了。
 *
 * ── 为什么 kernel.js 是「动态导入」──
 *   与 board.js 相同：kernel.js 静态 import 了宿主包，裸检出（无 node_modules）
 *   下静态 import 会让本模块连带加载失败，`test/discipline.test.mjs` 起不来。
 *   拿不到 kernel 时**不静默兜底**：调用方必须显式传 `config.stateDir`。
 *
 * 依赖面：node 内置 + `./store.js` + `./kernel.js`。**不 import 任何宿主包/第三方包**。
 */

import { normalize as normalizePath } from 'node:path'

import {
  appendJsonl,
  readJson,
  readJsonl,
  statePath,
  writeJsonAtomic,
} from './store.js'

// ── kernel 惰性桥（见文件头「为什么是动态导入」）──────────────────────────────

/** @type {object | null} */
let kernel = null
/** @type {unknown} */
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

// ── 常量（契约冻结）──────────────────────────────────────────────────────────

/** 合法层级，顺序 = 从泛到具体。 */
export const SCOPES = ['global', 'workspace', 'room', 'bot']
/** 合法分类。 */
export const KINDS = ['rule', 'requirement', 'principle', 'style']
/** 字段上限（DESIGN §特性②模型注释）。 */
export const LIMITS = { title: 120, content: 4000 }
/** import 的三种去重策略：跳过 / 覆盖 / 改名（rename 为 library 同款扩展）。 */
export const IMPORT_MODES = ['skip', 'overwrite', 'rename']

/**
 * scope 具体度排序：数值大 = 更具体。
 * 冲突裁决的**第二关键字**（第一关键字是 priority），见 `compareDisciplines`。
 */
const SCOPE_RANK = { global: 1, workspace: 2, room: 3, bot: 4 }

/** 分类 → markdown 小节标题（顺序即渲染顺序，契约要求）。 */
const KIND_SECTION = {
  rule: '## 纪律',
  requirement: '## 要求',
  principle: '## 原则',
  style: '## 风格',
}
/** 渲染顺序：硬规矩 → 交付标准 → 原则 → 风格。 */
const KIND_ORDER = ['rule', 'requirement', 'principle', 'style']

/** 超预算时的省略提示前缀（契约原文要求）。 */
const TRUNCATED_PREFIX = '⚠️ 已省略 '

// ── 错误 ────────────────────────────────────────────────────────────────────

/**
 * 分级纪律结构化错误。所有失败都走它，**绝不静默**。
 * `detail` 带上定位信息（条目 id / 字段 / rev），便于 API 层原样回显给 UI。
 */
export class DisciplineError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息
   * @param {string} [code] 大写下划线错误码
   * @param {object} [detail] 机器可读的上下文
   */
  constructor(message, code = 'DISCIPLINE_ERROR', detail) {
    super(message)
    this.name = 'DisciplineError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/**
 * 深拷贝 + **JSON 归一**（去掉 undefined 键）。
 * 必须走 JSON 而不是 structuredClone：否则内存态会比磁盘态多出
 * `{priority: undefined}` 这类键，`replay()` 重建后与内存值不等。
 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 取 `d-<n>` 里的 n；非本格式返回 0。 */
function idNumber(id) {
  const m = /^d-(\d+)$/.exec(String(id ?? ''))
  return m ? Number(m[1]) : 0
}

/** 非空字符串字段校验。 */
function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DisciplineError(
      `discipline.${where}：字段 ${field} 缺失或类型错误（要求非空字符串，收到 ${JSON.stringify(value)}）`,
      'DISCIPLINE_MISSING_FIELD',
      { field, where },
    )
  }
  return value
}

/**
 * 取操作者 id。
 *
 * 契约参数名是 `by`（DESIGN §特性②签名）；这里同时容忍 board 风格的 `byId`，
 * 因为 api/tools 层在 board 那边习惯写 `byId`，混用时不至于把一个正确的调用
 * 变成「缺 by」的假失败。两者都给时以契约名 `by` 为准。
 */
function requireActor(input, where) {
  const value = input?.by ?? input?.byId
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DisciplineError(
      `discipline.${where}：操作者缺失（字段 by，兼容别名 byId；收到 ${JSON.stringify(value)}）`,
      'DISCIPLINE_MISSING_FIELD',
      { field: 'by', where },
    )
  }
  return value
}

/** 时间参数归一：可注入（测试），缺省 Date.now()。 */
function normalizeNow(now, where) {  if (now === undefined || now === null) return Date.now()
  if (!Number.isFinite(now) || now < 0) {
    throw new DisciplineError(
      `discipline.${where}：now 必须是有限的非负数毫秒时间戳（收到 ${JSON.stringify(now)}）`,
      'DISCIPLINE_BAD_FIELD',
      { field: 'now', where },
    )
  }
  return now
}

/** 层级校验。 */
function normalizeScope(scope, where) {
  if (typeof scope !== 'string' || !SCOPES.includes(scope)) {
    throw new DisciplineError(
      `discipline.${where}：非法 scope=${JSON.stringify(scope)}（合法值：${SCOPES.join(' | ')}）`,
      'DISCIPLINE_BAD_SCOPE',
      { field: 'scope', where, scope },
    )
  }
  return scope
}

/**
 * scopeId 归一（与 scope 强绑定，不许「global 却带个 id」这种歧义状态）。
 *   - global：scopeId 必须为空（null/undefined/''）→ 统一存 null；
 *   - 其他：必须是非空字符串（workspace 为 cwd 绝对路径，room/bot 为对应 id）。
 */
function normalizeScopeId(scope, scopeId, where) {
  const empty = scopeId === undefined || scopeId === null || scopeId === ''
  if (scope === 'global') {
    if (!empty) {
      throw new DisciplineError(
        `discipline.${where}：scope=global 时 scopeId 必须为空（收到 ${JSON.stringify(scopeId)}）——`
        + '全局条目挂在任何 id 上都会让合并规则出现歧义',
        'DISCIPLINE_BAD_SCOPE_ID',
        { field: 'scopeId', where, scope },
      )
    }
    return null
  }
  if (empty || typeof scopeId !== 'string' || scopeId.trim() === '') {
    throw new DisciplineError(
      `discipline.${where}：scope=${scope} 时必须给非空 scopeId（workspace=cwd 绝对路径 / room=roomId / bot=botId）`,
      'DISCIPLINE_BAD_SCOPE_ID',
      { field: 'scopeId', where, scope, scopeId },
    )
  }
  return scopeId.trim()
}

/** 分类校验。 */
function normalizeKind(kind, where) {
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    throw new DisciplineError(
      `discipline.${where}：非法 kind=${JSON.stringify(kind)}（合法值：${KINDS.join(' | ')}）`,
      'DISCIPLINE_BAD_KIND',
      { field: 'kind', where, kind },
    )
  }
  return kind
}

/** 标题校验（≤120）。 */
function normalizeTitle(title, where) {
  const s = requireString(title, 'title', where).trim()
  if (s.length > LIMITS.title) {
    throw new DisciplineError(
      `discipline.${where}：title 超长（${s.length} > ${LIMITS.title}）——标题是合并去重键，不能任意膨胀`,
      'DISCIPLINE_TITLE_TOO_LONG',
      { field: 'title', where, length: s.length, max: LIMITS.title },
    )
  }
  return s
}

/** 正文校验（非空，≤4000）。不 trim 正文：markdown 缩进有意义。 */
function normalizeContent(content, where) {
  requireString(content, 'content', where)
  if (typeof content !== 'string') return content
  if (content.length > LIMITS.content) {
    throw new DisciplineError(
      `discipline.${where}：content 超长（${content.length} > ${LIMITS.content}）`,
      'DISCIPLINE_CONTENT_TOO_LONG',
      { field: 'content', where, length: content.length, max: LIMITS.content },
    )
  }
  return content
}

/** priority 归一（缺省 0；必须是有限数字）。 */
function normalizePriority(priority, where) {
  if (priority === undefined || priority === null) return 0
  // UI 表单可能把数字序列化成字符串（"5"）：这是等价值，不算坏输入；
  // 但 "high" 这种真非法值仍必须抛错 —— 不静默变 0。
  if (typeof priority === 'string' && priority.trim() !== '' && Number.isFinite(Number(priority))) {
    return Number(priority)
  }
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new DisciplineError(
      `discipline.${where}：priority 必须是有限数字（收到 ${JSON.stringify(priority)}）`,
      'DISCIPLINE_BAD_FIELD',
      { field: 'priority', where },
    )
  }
  return priority
}

/** enabled 归一（缺省 true；必须是布尔）。 */
function normalizeEnabled(enabled, where) {
  if (enabled === undefined || enabled === null) return true
  if (typeof enabled !== 'boolean') {
    throw new DisciplineError(
      `discipline.${where}：enabled 必须是布尔（收到 ${JSON.stringify(enabled)}）`,
      'DISCIPLINE_BAD_FIELD',
      { field: 'enabled', where },
    )
  }
  return enabled
}

/**
 * cwd 归一（只用于比较，不改变存储值）：
 * 去尾部分隔符、按平台处理大小写。
 * 为什么不改存储值：用户看到的是自己写入的原样路径；比较用归一值即可。
 */
function normalizeCwd(path) {
  if (typeof path !== 'string' || path.trim() === '') return null
  let s = path.trim()
  try {
    s = normalizePath(s)
  } catch {
    /* 非法路径按原样比较，不抛——比较不该比写还脆 */
  }
  if (s.length > 1) s = s.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') s = s.toLowerCase()
  return s
}

/**
 * token 粗算（**与 memory.js:estimateTokens 同口径**，见文件头说明）：
 * ASCII 按 4 字符/token，宽字符（> U+2E80，含中日韩）按 1.5 字符/token。
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  const s = String(text ?? '')
  if (s === '') return 0
  let wide = 0
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x2e80) wide += 1
  }
  const narrow = s.length - wide
  return Math.ceil(narrow / 4 + wide / 1.5)
}

/**
 * 合并时的排序：**priority 降序 → scope 具体度降序 → 创建时间升序 → id 升序**。
 * 后两级只是确定性 tie-break（避免同一份数据两次 resolve 顺序不同——
 * 那会让「预算裁剪丢哪条」变成不可复现的随机行为）。
 */
function compareDisciplines(a, b) {
  const byPriority = (Number(b.priority) || 0) - (Number(a.priority) || 0)
  if (byPriority !== 0) return byPriority
  const byScope = (SCOPE_RANK[b.scope] ?? 0) - (SCOPE_RANK[a.scope] ?? 0)
  if (byScope !== 0) return byScope
  const byCreated = (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
  if (byCreated !== 0) return byCreated
  return idNumber(a.id) - idNumber(b.id)
}

/**
 * 「谁更具体」判定（同 title 去重时保留哪条）：
 * scope 具体度优先（契约原文），同级再看 priority / updatedAt / id。
 * 注意：**与排序用的 compare 不同** —— 去重不能让「高 priority 的全局条目」
 * 顶掉「低 priority 的 bot 条目」，否则「具体优先」这条规则形同虚设。
 */
function isMoreSpecific(candidate, current) {
  const rankGap = (SCOPE_RANK[candidate.scope] ?? 0) - (SCOPE_RANK[current.scope] ?? 0)
  if (rankGap !== 0) return rankGap > 0
  const prioGap = (Number(candidate.priority) || 0) - (Number(current.priority) || 0)
  if (prioGap !== 0) return prioGap > 0
  const updatedGap = (Number(candidate.updatedAt) || 0) - (Number(current.updatedAt) || 0)
  if (updatedGap !== 0) return updatedGap > 0
  return idNumber(candidate.id) > idNumber(current.id)
}

/** 省略提示行（契约原文：`⚠️ 已省略 N 条（超出预算）`）。 */
function truncatedLine(count) {
  return `${TRUNCATED_PREFIX}${count} 条（超出预算）`
}

/**
 * 把条目渲染成分节 markdown（小节顺序 = 契约要求，节内保持排序结果）。
 * @param {object[]} items 已排序的条目
 * @returns {string}
 */
function renderItems(items) {
  const blocks = []
  for (const kind of KIND_ORDER) {
    const group = items.filter((d) => d.kind === kind)
    if (group.length === 0) continue
    const lines = [KIND_SECTION[kind]]
    for (const d of group) {
      // 正文多行时缩进到 bullet 之下，否则 markdown 会把续行渲染成新段落
      const body = String(d.content).split('\n')
        .map((line, i) => (i === 0 ? line : `  ${line}`))
        .join('\n')
      lines.push(`- **${d.title}**：${body}`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**（与 board.js 同一纪律）。
 * @param {{ stateDir?: string }} config
 * @returns {string}
 */
function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') {
    return config.stateDir.trim()
  }
  if (kernel && typeof kernel.stateDir === 'function') {
    return kernel.stateDir()
  }
  const reason = kernelError?.message ?? (kernel ? 'kernel.stateDir 不存在' : 'kernel 未加载')
  throw new DisciplineError(
    `discipline.createDiscipline：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'DISCIPLINE_NO_STATE_DIR',
  )
}

/**
 * 把 `(ctx, config)` 归一。允许「只传一个 config 对象」的简写（`{ stateDir }`），
 * 因为工具层/测试里手写实例时更顺手；两种写法语义完全一致。
 */
function splitArgs(ctx, config) {
  const cfgGiven = config && typeof config === 'object' && Object.keys(config).length > 0
  if (cfgGiven) return { context: ctx ?? {}, config }
  if (ctx && typeof ctx === 'object' && typeof ctx.stateDir === 'string') {
    return { context: {}, config: ctx }
  }
  return { context: ctx ?? {}, config: config ?? {} }
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 创建分级纪律服务实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（只用于日志，缺失即降级为 no-op）
 * @param {{ stateDir?: string, name?: string }} [config]
 * @returns {object} discipline service
 */
export function createDiscipline(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'discipline.jsonl')
  const snapPath = statePath(stateDir, 'discipline.snap.json')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} id → Discipline（插入序 = 创建序） */
  const disciplines = new Map()
  /** @type {object[]} 全部事件（审计流，按落盘顺序） */
  const events = []
  /** @type {Map<string, number>} id → 已见到的最新 rev（回放幂等用） */
  const lastRev = new Map()

  let idCounter = 0
  let disposed = false

  const diagnostics = {
    stateDir,
    jsonlPath,
    snapPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: /** @type {null|'jsonl'|'snapshot'|'empty'} */ (null),
    replayedEvents: 0,
    badLines: 0,
    snapshotWriteFailures: 0,
    lastReplayAt: /** @type {number|undefined} */ (undefined),
  }

  /** 已销毁实例的调用一律抛错：静默返回空数据比崩掉更难查。 */
  function assertAlive(where) {
    if (disposed) {
      throw new DisciplineError(
        `discipline.${where}：实例已 dispose()，请重新 createDiscipline()（拒绝在已销毁实例上静默返回空数据）`,
        'DISCIPLINE_DISPOSED',
        { where },
      )
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 快照内容（落盘形态）。 */
  const snapshot = () => ({
    version: 1,
    savedAt: Date.now(),
    idCounter,
    disciplines: [...disciplines.values()],
  })

  /**
   * 提交一次变更：**先落事件，再改内存，最后写快照**。
   *
   * 顺序不可颠倒：append 失败时内存必须原封不动（否则内存与磁盘分叉，
   * 重启回放后状态凭空回退 —— 这是最恶劣的静默失败）。
   *
   * @param {string} disciplineId
   * @param {'create'|'update'|'remove'} action
   * @param {string|null} byId
   * @param {number} at
   * @param {object|null} before 变更前记录（create 为 null）
   * @param {object|null} after 变更后记录（remove 为 null）
   * @returns {object|null} 克隆后的 after
   */
  function commit(disciplineId, action, byId, at, before, after) {
    /** @type {Record<string, unknown>} */
    const event = {
      disciplineId,
      rev: after ? after.rev : ((before?.rev ?? 0) + 1),
      action,
      byId: byId ?? null,
      at,
      before: before ? clone(before) : null,
      after: after ? clone(after) : null,
    }
    if (!appendJsonl(jsonlPath, event)) {
      throw new DisciplineError(
        `discipline.${action}：事件追加失败（${jsonlPath}）——拒绝「只改内存不落盘」`,
        'DISCIPLINE_APPEND_FAILED',
        { id: disciplineId, action, path: jsonlPath },
      )
    }
    if (after) {
      disciplines.set(disciplineId, clone(after))
      lastRev.set(disciplineId, after.rev)
      idCounter = Math.max(idCounter, idNumber(disciplineId))
    } else {
      disciplines.delete(disciplineId)
      lastRev.set(disciplineId, event.rev)
    }
    events.push(event)
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/discipline] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可完整恢复`)
    }
    return after ? clone(after) : null
  }

  // ── 回放 ──────────────────────────────────────────────────────────────────

  /**
   * 从 `discipline.jsonl`（真相源）重建内存态；jsonl 为空才回落到快照。
   * 坏行**不静默丢弃**：计入 diagnostics 并 warn。
   */
  function hydrate() {
    disciplines.clear()
    events.length = 0
    lastRev.clear()
    idCounter = 0
    disposed = false

    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) {
      warn(`[cs-bots/discipline] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }

    if (rows.length === 0) {
      const snap = readJson(snapPath, null)
      const list = Array.isArray(snap?.disciplines) ? snap.disciplines : null
      if (list) {
        for (const raw of list) {
          if (!raw || typeof raw.id !== 'string') continue
          const d = clone(raw)
          // 快照是旧版本时补齐字段（向后兼容，不改语义）
          if (typeof d.priority !== 'number') d.priority = 0
          if (typeof d.enabled !== 'boolean') d.enabled = true
          disciplines.set(d.id, d)
          lastRev.set(d.id, Number.isFinite(d.rev) ? d.rev : 1)
          idCounter = Math.max(idCounter, idNumber(d.id))
        }
        if (Number.isFinite(snap?.idCounter)) idCounter = Math.max(idCounter, snap.idCounter)
        diagnostics.hydratedFrom = 'snapshot'
        info(`[cs-bots/discipline] 回放完成：无事件流 → 由快照恢复 ${disciplines.size} 条纪律`)
        return
      }
      diagnostics.hydratedFrom = 'empty'
      info('[cs-bots/discipline] 回放完成：空库（无事件流、无快照）')
      return
    }

    // 事件流是真相源：只接受 rev 递增的事件（同 rev 重放幂等，容忍重复投递）
    let skipped = 0
    for (const ev of rows) {
      const id = typeof ev?.disciplineId === 'string' ? ev.disciplineId : ev?.after?.id
      if (!id) {
        skipped += 1
        continue
      }
      const rev = Number.isFinite(ev?.rev) ? ev.rev : undefined
      const current = lastRev.get(id) ?? 0
      if (rev !== undefined && rev <= current) {
        skipped += 1
        continue
      }
      if (ev.after && ev.after.id === id) {
        const d = clone(ev.after)
        if (typeof d.priority !== 'number') d.priority = 0
        if (typeof d.enabled !== 'boolean') d.enabled = true
        disciplines.set(id, d)
        lastRev.set(id, rev ?? d.rev)
        idCounter = Math.max(idCounter, idNumber(id))
      } else if (ev.action === 'remove') {
        disciplines.delete(id)
        lastRev.set(id, rev ?? current + 1)
      } else {
        skipped += 1
        continue
      }
      events.push(clone(ev))
    }
    if (skipped > 0) {
      warn(`[cs-bots/discipline] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }
    diagnostics.hydratedFrom = 'jsonl'
    info(`[cs-bots/discipline] 回放完成：${rows.length} 条事件 → ${disciplines.size} 条纪律`)
  }

  // ── 校验组合 ──────────────────────────────────────────────────────────────

  /**
   * 归一一条纪律的可写字段（create / import 共用）。
   * @param {object} input
   * @param {string} where
   */
  function normalizeFields(input, where) {
    const scope = normalizeScope(input?.scope, where)
    return {
      scope,
      scopeId: normalizeScopeId(scope, input?.scopeId, where),
      kind: normalizeKind(input?.kind, where),
      title: normalizeTitle(input?.title, where),
      content: normalizeContent(input?.content, where),
      priority: normalizePriority(input?.priority, where),
      enabled: normalizeEnabled(input?.enabled, where),
    }
  }

  /** CAS 前置校验：expectedRev 必须显式给、且与当前 rev 一致。 */
  function assertExpectedRev(current, expectedRev, where) {
    if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev)) {
      throw new DisciplineError(
        `discipline.${where}：expectedRev 必须是整数（CAS 需要显式期望版本，条目 ${current.id} 当前 rev=${current.rev}，`
        + `收到 ${JSON.stringify(expectedRev)}）`,
        'DISCIPLINE_MISSING_EXPECTED_REV',
        { id: current.id, rev: current.rev, where },
      )
    }
    if (current.rev !== expectedRev) {
      throw new DisciplineError(
        `discipline.${where} CAS 冲突：条目 ${current.id} 期望 rev=${expectedRev}，实际 rev=${current.rev} —— `
        + '拒绝静默覆盖，请重新 getDiscipline() 后按最新 rev 重试',
        'DISCIPLINE_REV_CONFLICT',
        { id: current.id, expectedRev, rev: current.rev, where },
      )
    }
  }

  /** 取记录或抛错。 */
  function mustGet(id, where) {
    const current = disciplines.get(id)
    if (!current) {
      throw new DisciplineError(
        `discipline.${where}：条目不存在 id=${id}`,
        'DISCIPLINE_NOT_FOUND',
        { id, where },
      )
    }
    return current
  }

  // ── API：写 ────────────────────────────────────────────────────────────────

  /**
   * 新建纪律条目。
   *
   * @param {{ scope: string, scopeId?: string|null, kind: string, title: string, content: string,
   *           priority?: number, enabled?: boolean, by: string, now?: number }} input
   * @returns {object} Discipline
   */
  function createDiscipline(input = {}) {
    assertAlive('createDiscipline')
    const fields = normalizeFields(input, 'create')
    const byId = requireActor(input, 'create')
    const at = normalizeNow(input?.now, 'create')

    const nextCounter = idCounter + 1
    const id = `d-${nextCounter}`
    /** @type {Record<string, unknown>} */
    const record = {
      id,
      rev: 1,
      ...fields,
      createdAt: at,
      createdBy: byId,
      updatedAt: at,
      updatedBy: byId,
    }
    idCounter = nextCounter
    try {
      return commit(id, 'create', byId, at, null, record)
    } catch (error) {
      // 落盘失败 → 计数器回滚，绝不留下「内存有、磁盘无」的幽灵 id
      idCounter = nextCounter - 1
      throw error
    }
  }

  /**
   * 按 `expectedRev` 做 CAS 变更。**rev 不匹配即抛错，绝不静默覆盖。**
   * 可改字段仅：title / content / kind / priority / enabled（scope 不可迁移，
   * 迁移会让合并顺序语义失效 —— 需要换层级请 remove 后重建）。
   *
   * @param {{ id: string, expectedRev: number, title?: string, content?: string, kind?: string,
   *           priority?: number, enabled?: boolean, by: string, now?: number }} input
   * @returns {object} 变更后的 Discipline
   */
  function updateDiscipline(input = {}) {
    assertAlive('updateDiscipline')
    const { id, expectedRev, title, content, kind, priority, enabled, by, byId: byAlias, now, ...rest } = input ?? {}
    const disciplineId = requireString(id, 'id', 'update')
    const byId = requireActor({ by, byId: byAlias }, 'update')

    const current = mustGet(disciplineId, 'update')
    assertExpectedRev(current, expectedRev, 'update')

    const unknown = Object.keys(rest ?? {})
    if (unknown.length > 0) {
      throw new DisciplineError(
        `discipline.update：未知字段 ${unknown.join(', ')}（可改：title | content | kind | priority | enabled；`
        + 'scope/scopeId 不可改，请 remove 后重建）——拒绝静默忽略',
        'DISCIPLINE_UNKNOWN_FIELD',
        { id: disciplineId, unknown },
      )
    }

    const patch = {}
    if (title !== undefined) patch.title = normalizeTitle(title, 'update')
    if (content !== undefined) patch.content = normalizeContent(content, 'update')
    if (kind !== undefined) patch.kind = normalizeKind(kind, 'update')
    if (priority !== undefined) patch.priority = normalizePriority(priority, 'update')
    if (enabled !== undefined) patch.enabled = normalizeEnabled(enabled, 'update')
    if (Object.keys(patch).length === 0) {
      throw new DisciplineError(
        'discipline.update：未提供任何可改字段（title | content | kind | priority | enabled）',
        'DISCIPLINE_NO_PATCH_FIELDS',
        { id: disciplineId },
      )
    }

    const at = normalizeNow(now, 'update')
    const before = clone(current)
    /** @type {Record<string, any>} */
    const next = clone(current)
    next.rev = current.rev + 1
    Object.assign(next, patch)
    next.updatedAt = at
    next.updatedBy = byId
    return commit(disciplineId, 'update', byId, at, before, next)
  }

  /**
   * 删除条目（CAS 保护）。事件流保留 `before` 快照，`history()` 可追。
   *
   * @param {{ id: string, expectedRev: number, by: string }} input
   * @returns {{ removed: string }}
   */
  function removeDiscipline(input = {}) {
    assertAlive('removeDiscipline')
    const { id, expectedRev, by, byId: byAlias } = input ?? {}
    const disciplineId = requireString(id, 'id', 'remove')
    const byId = requireActor({ by, byId: byAlias }, 'remove')

    const current = mustGet(disciplineId, 'remove')
    assertExpectedRev(current, expectedRev, 'remove')

    commit(disciplineId, 'remove', byId, Date.now(), clone(current), null)
    return { removed: disciplineId }
  }

  /**
   * 批量导入（去重键 = scope + scopeId + title）。
   *
   * 单条非法**不中断整批**：进 `errors[]`（DESIGN §特性② / library 同款纪律）。
   * 但**落盘失败仍抛错** —— 那不是「这条数据不好」，而是整台机器写不进去了，
   * 继续循环只会制造更多「内存有、磁盘无」的分叉。
   *
   * @param {{ items: object[], by: string, mode?: 'skip'|'overwrite'|'rename', now?: number }} input
   * @returns {{ created: object[], updated: object[], skipped: object[], errors: {index: number, title?: string, reason: string, code?: string}[] }}
   */
  function importDisciplines(input = {}) {
    assertAlive('importDisciplines')
    const { items, by, byId: byAlias, now } = input ?? {}
    // mode 不能靠解构缺省处理空串：UI 下拉框未选时可能传 '' / null，
    // 两者语义都是「按默认策略」，与不传等价（否则会假报 DISCIPLINE_BAD_MODE）。
    const modeRaw = input?.mode
    const mode = modeRaw === undefined || modeRaw === null || modeRaw === '' ? 'skip' : modeRaw
    const byId = requireActor({ by, byId: byAlias }, 'import')
    if (!Array.isArray(items)) {
      throw new DisciplineError(
        `discipline.import：items 必须是数组（收到 ${JSON.stringify(items)}）`,
        'DISCIPLINE_BAD_ITEMS',
        { field: 'items' },
      )
    }
    if (!IMPORT_MODES.includes(mode)) {
      throw new DisciplineError(
        `discipline.import：非法 mode=${JSON.stringify(mode)}（合法值：${IMPORT_MODES.join(' | ')}）`,
        'DISCIPLINE_BAD_MODE',
        { field: 'mode', mode },
      )
    }
    const at = normalizeNow(now, 'import')

    /** @type {{ created: object[], updated: object[], skipped: object[], errors: object[] }} */
    const result = { created: [], updated: [], skipped: [], errors: [] }

    /** 去重键：同一 scope 下 title 视为同一条（title 已 trim）。 */
    const dedupeKey = (rec) => {
      const scopeId = rec.scope === 'workspace' ? normalizeCwd(rec.scopeId) : rec.scopeId
      return `${rec.scope}|${scopeId ?? ''}|${rec.title}`
    }
    /** 在现有库里按去重键找条目。 */
    const findByKey = (rec) => {
      const key = dedupeKey(rec)
      for (const d of disciplines.values()) {
        if (dedupeKey(d) === key) return d
      }
      return undefined
    }
    /** rename 模式：在当前库里找一个不冲突的标题。 */
    const uniqueTitle = (rec) => {
      const base = rec.title
      for (let n = 2; n < 1000; n += 1) {
        const suffix = ` (${n})`
        const room = Math.max(0, LIMITS.title - suffix.length)
        const candidate = `${base.slice(0, room).trim()}${suffix}`
        if (!findByKey({ ...rec, title: candidate })) return candidate
      }
      throw new DisciplineError(
        `discipline.import：标题 ${JSON.stringify(base)} 的候选后缀已用尽（≥1000 条同名）——请先整理数据`,
        'DISCIPLINE_TITLE_EXHAUSTED',
        { title: base },
      )
    }

    for (let index = 0; index < items.length; index += 1) {
      const raw = items[index]
      try {
        const fields = normalizeFields(raw, `import[${index}]`)
        const existing = findByKey(fields)
        if (!existing) {
          const created = commitCreateForImport(fields, byId, at)
          result.created.push(created)
          continue
        }
        if (mode === 'skip') {
          result.skipped.push({
            index,
            id: existing.id,
            title: fields.title,
            scope: fields.scope,
            scopeId: fields.scopeId,
            reason: 'duplicate',
          })
          continue
        }
        if (mode === 'overwrite') {
          // 走同一条 CAS 更新通道，保证 rev 递增与事件流完整
          const patch = {
            content: fields.content,
            kind: fields.kind,
            priority: fields.priority,
            enabled: fields.enabled,
          }
          const updated = updateDiscipline({
            id: existing.id,
            expectedRev: existing.rev,
            ...patch,
            by: byId,
            now: at,
          })
          result.updated.push(updated)
          continue
        }
        // mode === 'rename'
        const created = commitCreateForImport({ ...fields, title: uniqueTitle(fields) }, byId, at)
        result.created.push(created)
      } catch (error) {
        // 落盘类错误必须上抛（不能当成「这条数据有问题」吞掉）
        if (error instanceof DisciplineError && error.code === 'DISCIPLINE_APPEND_FAILED') throw error
        result.errors.push({
          index,
          title: typeof raw?.title === 'string' ? raw.title : undefined,
          reason: error?.message ?? String(error),
          code: error?.code ?? 'DISCIPLINE_IMPORT_ITEM_FAILED',
        })
      }
    }
    return result
  }

  /**
   * import 内部的建条通道（复用 create 的落盘逻辑，但时间统一用 import 的 `at`，
   * 保证同一批导入的 createdAt 一致 —— 排序 tie-break 才有确定性）。
   */
  function commitCreateForImport(fields, byId, at) {
    const nextCounter = idCounter + 1
    const id = `d-${nextCounter}`
    const record = {
      id,
      rev: 1,
      ...fields,
      createdAt: at,
      createdBy: byId,
      updatedAt: at,
      updatedBy: byId,
    }
    idCounter = nextCounter
    try {
      return commit(id, 'create', byId, at, null, record)
    } catch (error) {
      idCounter = nextCounter - 1
      throw error
    }
  }

  // ── API：读 ────────────────────────────────────────────────────────────────

  /** @param {string} id @returns {object | undefined} */
  function getDiscipline(id) {
    assertAlive('getDiscipline')
    const d = typeof id === 'string' ? disciplines.get(id.trim()) : undefined
    return d ? clone(d) : undefined
  }

  /**
   * 列出条目（**创建序**）。所有过滤条件都是 AND。
   *
   * @param {{ scope?: string, scopeId?: string|null, kind?: string, enabled?: boolean, query?: string }} [options]
   * @returns {object[]}
   */
  function listDisciplines(options = {}) {
    assertAlive('listDisciplines')
    const { scope, scopeId, kind, enabled, query } = options ?? {}
    // '' 表示「UI 清空了该筛选」= 不筛选；null 同理（scopeId 例外，见下）
    const scopeFilter = scope === undefined || scope === null || scope === '' ? undefined : scope
    const kindFilter = kind === undefined || kind === null || kind === '' ? undefined : kind
    // scopeId：undefined/'' = 不筛选；null = 显式筛「global」（global 的 scopeId 就是 null）
    const scopeIdFilter = scopeId === undefined || scopeId === '' ? undefined : scopeId
    if (scopeFilter !== undefined && !SCOPES.includes(scopeFilter)) {
      throw new DisciplineError(
        `discipline.list：非法 scope=${JSON.stringify(scope)}（合法值：${SCOPES.join(' | ')}）`,
        'DISCIPLINE_BAD_SCOPE',
        { field: 'scope', scope },
      )
    }
    if (kindFilter !== undefined && !KINDS.includes(kindFilter)) {
      throw new DisciplineError(
        `discipline.list：非法 kind=${JSON.stringify(kind)}（合法值：${KINDS.join(' | ')}）`,
        'DISCIPLINE_BAD_KIND',
        { field: 'kind', kind },
      )
    }
    const needEnabled = enabled === undefined || enabled === null ? undefined : Boolean(enabled)
    const q = typeof query === 'string' && query.trim() !== '' ? query.trim().toLowerCase() : null

    const out = []
    for (const d of disciplines.values()) {
      if (scopeFilter !== undefined && d.scope !== scopeFilter) continue
      if (scopeIdFilter !== undefined && d.scopeId !== scopeIdFilter) continue
      if (kindFilter !== undefined && d.kind !== kindFilter) continue
      if (needEnabled !== undefined && d.enabled !== needEnabled) continue
      if (q) {
        const haystack = `${d.title}\n${d.content}`.toLowerCase()
        if (!haystack.includes(q)) continue
      }
      out.push(clone(d))
    }
    return out
  }

  /**
   * **核心**：沿层级合并生效纪律（DESIGN §特性②合并规则 1–6）。
   *
   * 合并顺序（规则 1）：global → workspace → room → bot；只取 `enabled !== false`。
   * 排序（规则 3）：priority 降序，再 scope 具体度降序。
   * 去重（规则 4）：同 title 只保留**最具体**那条，丢弃计入 `dropped`。
   * 预算（规则 6）：超出 `tokenBudget` 从**低优先级**（即排序尾部）丢，
   *   `truncated=true`，text 末尾加 `⚠️ 已省略 N 条（超出预算）`。
   *
   * `tokenBudget` 不是契约里的必填参数（resolve 允许不带预算做预览），
   * 但透传它能让 UI 用同一函数预览「注入后会不会被裁」。
   *
   * @param {{ botId?: string, cwd?: string, roomId?: string, tokenBudget?: number }} [input]
   * @returns {{ items: object[], text: string, byScope: Record<string, number>, truncated: boolean, dropped: number }}
   */
  function resolveDisciplines(input = {}) {
    assertAlive('resolveDisciplines')
    const { botId, cwd, roomId, tokenBudget } = input ?? {}
    return resolveInternal({ botId, cwd, roomId, tokenBudget })
  }

  /**
   * 注入用渲染：与 resolve 同源，额外返回 `tokens`（与 tokenBudget 同口径）。
   *
   * @param {{ botId?: string, cwd?: string, roomId?: string, tokenBudget?: number }} [input]
   * @returns {{ text: string, items: object[], truncated: boolean, dropped: number, tokens: number }}
   */
  function renderDisciplinePrompt(input = {}) {
    assertAlive('renderDisciplinePrompt')
    const { botId, cwd, roomId, tokenBudget } = input ?? {}
    const resolved = resolveInternal({ botId, cwd, roomId, tokenBudget })
    return {
      text: resolved.text,
      items: resolved.items,
      truncated: resolved.truncated,
      dropped: resolved.dropped,
      tokens: estimateTokens(resolved.text),
    }
  }

  /** resolve / render 的共用实现（避免两套合并逻辑漂移）。 */
  function resolveInternal({ botId, cwd, roomId, tokenBudget }) {
    const cwdKey = normalizeCwd(cwd)
    const botKey = typeof botId === 'string' && botId.trim() !== '' ? botId.trim() : null
    const roomKey = typeof roomId === 'string' && roomId.trim() !== '' ? roomId.trim() : null

    // 1+2：按层级收集（只取 enabled !== false）
    const candidates = []
    for (const d of disciplines.values()) {
      if (d.enabled === false) continue
      if (d.scope === 'global') {
        candidates.push(d)
      } else if (d.scope === 'workspace') {
        if (cwdKey && normalizeCwd(d.scopeId) === cwdKey) candidates.push(d)
      } else if (d.scope === 'room') {
        if (roomKey && d.scopeId === roomKey) candidates.push(d)
      } else if (d.scope === 'bot') {
        if (botKey && d.scopeId === botKey) candidates.push(d)
      }
    }

    // 3：先按 priority → scope 具体度排序（去重的 tie-break 也依赖它）
    candidates.sort(compareDisciplines)

    // 4：同 title 只留最具体（注意：具体度判定独立于排序，见 isMoreSpecific 注释）
    /** @type {Map<string, object>} */
    const byTitle = new Map()
    let droppedByTitle = 0
    for (const d of candidates) {
      const key = String(d.title).trim()
      const kept = byTitle.get(key)
      if (!kept) {
        byTitle.set(key, d)
        continue
      }
      droppedByTitle += 1
      if (isMoreSpecific(d, kept)) byTitle.set(key, d)
    }
    // 去重可能换了代表条目 → 重新排序，保证输出顺序仍符合规则 3
    let kept = [...byTitle.values()].sort(compareDisciplines)

    // 6：tokenBudget 裁剪（从尾部 = 最低优先级开始丢）
    let droppedByBudget = 0
    let truncated = false
    let text
    const budget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? Math.floor(tokenBudget) : Infinity
    if (Number.isFinite(budget)) {
      for (;;) {
        const body = renderItems(kept)
        const candidateText = droppedByBudget === 0
          ? body
          : (body === '' ? truncatedLine(droppedByBudget) : `${body}\n\n${truncatedLine(droppedByBudget)}`)
        if (estimateTokens(candidateText) <= budget) {
          text = candidateText
          break
        }
        if (kept.length === 0) {
          // 预算连省略提示都装不下：仍然返回提示（绝不静默伪装成「无纪律」）
          text = candidateText
          break
        }
        kept = kept.slice(0, -1)
        droppedByBudget += 1
        truncated = true
      }
    } else {
      text = renderItems(kept)
    }

    // 5：byScope 统计（固定四键，UI 不用判空）
    const byScope = { global: 0, workspace: 0, room: 0, bot: 0 }
    for (const d of kept) {
      byScope[d.scope] = (byScope[d.scope] ?? 0) + 1
    }

    return {
      items: kept.map((d) => clone(d)),
      text,
      byScope,
      truncated,
      // dropped = 同 title 去重丢弃 + 预算裁剪丢弃（两类都算「没进最终内容」）
      dropped: droppedByTitle + droppedByBudget,
    }
  }

  /**
   * 审计流查询。
   * @param {string} [id] 省略则返回全部事件
   * @returns {object[]}
   */
  function history(id) {
    assertAlive('history')
    const rows = typeof id === 'string' && id !== ''
      ? events.filter((e) => e.disciplineId === id)
      : events
    return clone(rows)
  }

  /**
   * 统计（给 /status 与 UI 概览用）。
   * @returns {{ total: number, enabled: number, disabled: number, byScope: object, byKind: object, events: number, idCounter: number }}
   */
  function stats() {
    assertAlive('stats')
    const byScope = { global: 0, workspace: 0, room: 0, bot: 0 }
    const byKind = { rule: 0, requirement: 0, principle: 0, style: 0 }
    let enabled = 0
    let disabled = 0
    for (const d of disciplines.values()) {
      byScope[d.scope] = (byScope[d.scope] ?? 0) + 1
      byKind[d.kind] = (byKind[d.kind] ?? 0) + 1
      if (d.enabled === false) disabled += 1
      else enabled += 1
    }
    return {
      total: disciplines.size,
      enabled,
      disabled,
      byScope,
      byKind,
      events: events.length,
      idCounter,
    }
  }

  /**
   * 从 `discipline.jsonl` 重建内存态（重启回放一致性）。
   * @returns {{ from: string, disciplines: number, events: number, bad: number }}
   */
  function replay() {
    assertAlive('replay')
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      disciplines: disciplines.size,
      events: events.length,
      bad: diagnostics.badLines,
    }
  }

  /**
   * 销毁实例（释放内存、拒绝后续调用）。
   * 为什么不写盘/不删文件：事件流是长期资产，dispose 只是「这个实例下班了」。
   * @returns {{ disposed: boolean, disciplines: number, events: number }}
   */
  function dispose() {
    const out = { disposed: true, disciplines: disciplines.size, events: events.length }
    disposed = true
    disciplines.clear()
    events.length = 0
    lastRev.clear()
    return out
  }

  /** 首次构造即回放，保证 `list()` 在重启后马上可用。 */
  hydrate()

  const service = {
    name: cfg.name ?? 'discipline',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    // 契约函数名（DESIGN §特性②，签名固定）
    createDiscipline,
    updateDiscipline,
    removeDiscipline,
    getDiscipline,
    listDisciplines,
    importDisciplines,
    resolveDisciplines,
    renderDisciplinePrompt,
    stats,
    replay,
    dispose,
    history,
    // 短别名：api/tools 层若按 board 的 create/get/list 风格调用也能直接走
    create: createDiscipline,
    update: updateDiscipline,
    remove: removeDiscipline,
    get: getDiscipline,
    list: listDisciplines,
    import: importDisciplines,
    resolve: resolveDisciplines,
    render: renderDisciplinePrompt,
    diagnostics: () => clone(diagnostics),
  }
  return service
}

export default createDiscipline
