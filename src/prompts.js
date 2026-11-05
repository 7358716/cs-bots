/**
 * cs-bots PromptService —— 提示词库 + 注入轨（对标 dsh-memory-evolve 的 Prompt Manager，
 * 但**完全自建、零第三方依赖**：只用 `node:*` 内置 + `./store.js` / `./kernel.js`）。
 *
 * ── 两个概念，别混 ──
 *   **提示词库（Prompt）**：可复用资产。有名字/分类/标签/正文/启用开关，CRUD + CAS。
 *   **注入轨（Injection）**：把某条提示词（或一段临时文本）按「次数 × 间隔」投进
 *   某个会话的系统提示词。注入是**运行时调度**，不是内容：删提示词会级联清它的注入，
 *   但改提示词正文会被后续注入自动读到新版本（见下「为什么正文实时解析」）。
 *
 * ── 三条不变量（与 board.js / discipline.js 同款，机械保证）──
 *   1. **CAS 优先**：prompt/injection 的任何变更都带 `expectedRev`；不匹配即抛错。
 *   2. **事件流是真相源**：先 append `prompts.jsonl`（失败即抛错，内存原封不动），
 *      再改内存，最后原子写 `prompts.snap.json`（快照失败只降级 warn —— 事件流可 replay）。
 *   3. **不静默失败**：未知字段、非法输入、不存在的 id 一律抛 `PromptError`（带 code+detail）。
 *
 * ── 为什么注入要单独一套「拿到即计数」的机制 ──
 *   `activeInjectionsFor()` 只负责**算出本轮该投什么**（纯查询）；真正的
 *   「消耗一次 / 剩余次数 -1 / 归零移除」在 `tickTurn()` 里做。
 *   两者分离的理由：提示词装配可能在同一回合被调用多次（UI 预览、retry、多步推理），
 *   如果查询本身扣次数，预览就会把注入预算吃光。所以查询只在内存里打一个
 *   「本轮已产出」标记（pending），tick 时按标记精确扣一次 —— 同一回合重复查询幂等。
 *
 * ── 为什么 `useCount` 不走 prompt 的 rev（重要）──
 *   useCount 是**遥测**，不是内容版本。若每次注入都 `rev+1` 去写它，后台持续注入
 *   会把 rev 一直推高，人在 UI 里编辑提示词几乎必然 CAS 冲突（"版本冲突请刷新"）。
 *   所以 useCount 用独立的 `usage` 事件累计（不碰 prompt.rev），回放时重放计数，
 *   计数按「每回合每提示词一条事件（带 count）」合并写入，避免 N 条注入产生 N 条事件。
 *
 * ── 为什么注入正文在**产出时**实时解析提示词 body ──
 *   用户改了提示词正文，期望「持续注入」下一回合就念新版本，而不是继续念旧快照。
 *   `injection.text` 只作为创建时的留档与 ad-hoc 文本的载体；产出时以 prompt.body 为准
 *   （提示词被删会级联清注入，不会出现悬空引用）。
 *
 * 依赖面：node 内置（crypto）+ `./store.js` + `./kernel.js`。不 import 任何宿主包/第三方包。
 */

import { randomBytes } from 'node:crypto'

import {
  appendJsonl,
  readJson,
  readJsonl,
  statePath,
  writeJsonAtomic,
} from './store.js'

// ── kernel 惰性桥（与 board.js 同款，裸检出时静态 import 会连累测试起不来）──────

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

/** 未分类：分类被删除时，其下提示词迁到这里；**不可删除**，是兜底。 */
export const DEFAULT_CATEGORY = '未分类'

/** 缺省分类（首次启动播种；可被用户删除，删除动作会进事件流，回放后仍然生效）。 */
export const DEFAULT_CATEGORIES = ['未分类', '通用', '编程', '写作', '分析']

/** 名称上限（字符）。 */
export const MAX_NAME = 200
/** 描述上限（字符）。 */
export const MAX_DESCRIPTION = 2000
/** 正文上限（UTF-8 字节）——提示词是往系统提示词里塞的东西，太大直接爆上下文。 */
export const MAX_BODY = 256 * 1024
/** 标签个数上限。 */
export const MAX_TAGS = 20
/** 单个标签长度上限（字符）。 */
export const MAX_TAG_LEN = 48
/** 分类名长度上限（字符）。 */
export const MAX_CATEGORY_LEN = 64
/** 会话 id 长度上限（字符）。 */
export const MAX_SESSION_ID = 200
/** 提示词 id 前缀。 */
export const PROMPT_ID_PREFIX = 'pt-'
/** 注入 id 前缀。 */
export const INJECTION_ID_PREFIX = 'inj-'

/** 事件 kind（落盘事件的联合类型）。 */
const EVENT_KINDS = ['prompt', 'injection', 'category', 'session', 'usage']

// ── 错误 ────────────────────────────────────────────────────────────────────

/**
 * 提示词/注入结构化错误。所有失败都走它，**绝不静默**。
 * 同时挂 `detail` 与 `details`（契约字段名 + 本仓既有习惯，两种取法都拿得到）。
 */
export class PromptError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息（id / rev / 字段名）
   * @param {string} [code]
   * @param {object} [detail]
   */
  constructor(message, code = 'PROMPT_ERROR', detail) {
    super(message)
    this.name = 'PromptError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
      this.details = detail
    }
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 深拷贝 + JSON 归一（去掉 undefined 键，避免内存态与磁盘态不等）。 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 归一化 now（可注入，测试用）：非有限数兜底当前时间，永不 NaN。 */
function normalizeNow(now) {
  return Number.isFinite(now) ? Math.floor(now) : Date.now()
}

/** 归一化「谁在操作」——所有写操作都必须能追到人/会话，不允许匿名写入。 */
function requireActor(input, where) {
  const raw = input?.by ?? input?.byId
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new PromptError(
      `prompts.${where}：缺少操作者 by（所有变更都必须能追到人/会话，拒绝匿名写入）`,
      'PROMPT_MISSING_ACTOR',
      { where },
    )
  }
  return raw.trim()
}

/** 非空字符串字段校验。 */
function requireString(value, field, where, max = 0) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PromptError(
      `prompts.${where}：${field} 必须是非空字符串（收到 ${value === null ? 'null' : JSON.stringify(value)}）`,
      'PROMPT_BAD_INPUT',
      { field, where },
    )
  }
  const out = value.trim()
  if (max > 0 && out.length > max) {
    throw new PromptError(
      `prompts.${where}：${field} 超过上限 ${max} 字符（实际 ${out.length}）`,
      'PROMPT_BAD_INPUT',
      { field, where, length: out.length, max },
    )
  }
  return out
}

/** 提示词名称。 */
function normalizeName(value, where) {
  return requireString(value, 'name', where, MAX_NAME)
}

/** 描述（可空；空串是合法值，表示"没写描述"）。 */
function normalizeDescription(value, where) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new PromptError(
      `prompts.${where}：description 必须是字符串（收到 ${typeof value}）`,
      'PROMPT_BAD_INPUT',
      { field: 'description', where },
    )
  }
  const out = value.trim()
  if (out.length > MAX_DESCRIPTION) {
    throw new PromptError(
      `prompts.${where}：description 超过上限 ${MAX_DESCRIPTION} 字符（实际 ${out.length}）`,
      'PROMPT_BAD_INPUT',
      { field: 'description', where, length: out.length, max: MAX_DESCRIPTION },
    )
  }
  return out
}

/** 正文（必须是字符串；按 UTF-8 字节判上限）。 */
function normalizeBody(value, where) {
  if (typeof value !== 'string') {
    throw new PromptError(
      `prompts.${where}：body 必须是字符串（收到 ${value === null ? 'null' : typeof value}）`,
      'PROMPT_BAD_BODY',
      { where, type: typeof value },
    )
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > MAX_BODY) {
    throw new PromptError(
      `prompts.${where}：body ${bytes} 字节超过上限 ${MAX_BODY} 字节（256 KiB）——请拆分提示词`,
      'PROMPT_TOO_LARGE',
      { where, bytes, max: MAX_BODY },
    )
  }
  return value
}

/** 标签：去空、去重（大小写敏感去重，保留用户原始大小写）、限个数与长度。 */
function normalizeTags(value, where) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new PromptError(
      `prompts.${where}：tags 必须是字符串数组（收到 ${typeof value}）`,
      'PROMPT_BAD_TAGS',
      { where, type: typeof value },
    )
  }
  const out = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new PromptError(
        `prompts.${where}：tags 含非字符串项（${typeof raw}）`,
        'PROMPT_BAD_TAGS',
        { where, item: String(raw) },
      )
    }
    const tag = raw.trim()
    if (tag === '' || seen.has(tag)) continue
    if (tag.length > MAX_TAG_LEN) {
      throw new PromptError(
        `prompts.${where}：标签 ${JSON.stringify(tag)} 超过 ${MAX_TAG_LEN} 字符`,
        'PROMPT_BAD_TAGS',
        { where, tag, max: MAX_TAG_LEN },
      )
    }
    seen.add(tag)
    out.push(tag)
  }
  if (out.length > MAX_TAGS) {
    throw new PromptError(
      `prompts.${where}：标签最多 ${MAX_TAGS} 个（实际 ${out.length}）`,
      'PROMPT_BAD_TAGS',
      { where, count: out.length, max: MAX_TAGS },
    )
  }
  return out
}

/** 分类名（缺省落到「未分类」；`requireExplicit=true` 用于 addCategory 这种必须点名的场景）。 */
function normalizeCategoryName(value, where, requireExplicit = false) {
  if (value === undefined || value === null || value === '') {
    if (requireExplicit) {
      throw new PromptError(
        `prompts.${where}：category 不能为空`,
        'PROMPT_BAD_CATEGORY',
        { where },
      )
    }
    return DEFAULT_CATEGORY
  }
  if (typeof value !== 'string') {
    throw new PromptError(
      `prompts.${where}：category 必须是字符串（收到 ${typeof value}）`,
      'PROMPT_BAD_CATEGORY',
      { where, type: typeof value },
    )
  }
  const name = value.trim()
  if (name === '') {
    if (requireExplicit) {
      throw new PromptError(`prompts.${where}：category 不能为空`, 'PROMPT_BAD_CATEGORY', { where })
    }
    return DEFAULT_CATEGORY
  }
  if (name.length > MAX_CATEGORY_LEN) {
    throw new PromptError(
      `prompts.${where}：分类名超过 ${MAX_CATEGORY_LEN} 字符（实际 ${name.length}）`,
      'PROMPT_BAD_CATEGORY',
      { where, length: name.length, max: MAX_CATEGORY_LEN },
    )
  }
  return name
}

/** 启用开关：缺省 true；只接受布尔（'false' 字符串这种歧义输入直接拒绝）。 */
function normalizeEnabled(value, where) {
  if (value === undefined || value === null) return true
  if (typeof value !== 'boolean') {
    throw new PromptError(
      `prompts.${where}：enabled 必须是布尔值（收到 ${JSON.stringify(value)}）`,
      'PROMPT_BAD_ENABLED',
      { where, value },
    )
  }
  return value
}

/** 注入次数：0 = 无限（默认），N = 有限 N 次。 */
function normalizeTimes(value, where) {
  if (value === undefined || value === null) return 0
  if (!Number.isInteger(value) || value < 0) {
    throw new PromptError(
      `prompts.${where}：times 必须是 >=0 的整数（0=无限，N=有限 N 次；收到 ${JSON.stringify(value)}）`,
      'PROMPT_BAD_TIMING',
      { where, field: 'times', value },
    )
  }
  return value
}

/** 注入间隔：1 = 每回合（默认），N = 每 N 回合，0 = 只注入一次。 */
function normalizeEvery(value, where) {
  if (value === undefined || value === null) return 1
  if (!Number.isInteger(value) || value < 0) {
    throw new PromptError(
      `prompts.${where}：every 必须是 >=0 的整数（1=每回合，N=每 N 回合，0=只注入一次；收到 ${JSON.stringify(value)}）`,
      'PROMPT_BAD_TIMING',
      { where, field: 'every', value },
    )
  }
  return value
}

/** 会话 id。 */
function normalizeSessionId(value, where) {
  return requireString(value, 'sessionId', where, MAX_SESSION_ID)
}

/** 生成 `pt-xxxxxxxx` / `inj-xxxxxxxx`（8 位十六进制；碰撞则重试，绝不复用已存在的 id）。 */
function newId(prefix, taken) {
  for (let i = 0; i < 100; i += 1) {
    const id = `${prefix}${randomBytes(4).toString('hex')}`
    if (!taken.has(id)) return id
  }
  throw new PromptError(
    `prompts：连续 100 次生成 ${prefix}* id 均碰撞（几乎必然是随机源异常）`,
    'PROMPT_ID_EXHAUSTED',
    { prefix },
  )
}

/** 补零两位。 */
function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地日期 `YYYY-MM-DD`。 */
function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 本地时间 `HH:mm`。 */
function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 变量展开：`{{date}}` → 本地 `YYYY-MM-DD`，`{{time}}` → 本地 `HH:mm`。
 * **在产出时展开**（不是创建时），这样"每天早上注入今日计划"这类提示词不会写着写着变成昨天。
 * 未知变量原样保留（未来 `{{path}}`/`{{event}}` 由调用方自行扩展）。
 */
export function expandTemplates(text, now) {
  const d = new Date(Number.isFinite(now) ? now : Date.now())
  return String(text ?? '')
    .replace(/\{\{date\}\}/g, formatDate(d))
    .replace(/\{\{time\}\}/g, formatTime(d))
}

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错（与 board/discipline 一致）。
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
  throw new PromptError(
    `prompts.createPrompts：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'PROMPT_NO_STATE_DIR',
  )
}

/** `(ctx, config)` 归一，允许只传一个 config 对象的简写（与 discipline.js 同款）。 */
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
 * 创建提示词/注入服务实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（缺失即降级 no-op 日志）
 * @param {{ stateDir?: string, name?: string }} [config]
 * @returns {object} prompts service
 */
export function createPrompts(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'prompts.jsonl')
  const snapPath = statePath(stateDir, 'prompts.snap.json')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} id → Prompt（插入序 = 创建序） */
  const prompts = new Map()
  /** @type {Map<string, object>} id → Injection（只存活跃注入；移除即删） */
  const injections = new Map()
  /** @type {Map<string, object>} name → { name, createdAt, createdBy } */
  const categories = new Map()
  /** @type {Map<string, number>} sessionId → 已完成的回合数（回合序号从 1 开始） */
  const sessions = new Map()
  /** @type {Map<string, Set<string>>} sessionId → 「本轮已产出、待 tick 扣次数」的注入 id */
  const pendingConsume = new Map()
  /** @type {object[]} 全部事件（审计流，按落盘顺序） */
  const events = []

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

  /** 已销毁实例的调用一律抛错（静默返回空列表会被误解成"提示词全丢了"）。 */
  function assertAlive(where) {
    if (disposed) {
      throw new PromptError(
        `prompts.${where}：实例已 dispose()，请重新 createPrompts()（拒绝在已销毁实例上静默返回空数据）`,
        'PROMPT_DISPOSED',
        { where },
      )
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 快照内容（落盘形态）。 */
  function buildSnapshot() {
    return {
      version: 1,
      savedAt: Date.now(),
      prompts: [...prompts.values()],
      injections: [...injections.values()],
      categories: [...categories.values()],
      sessions: Object.fromEntries(sessions),
    }
  }

  /**
   * 通用事件应用：**回放与新写入走同一函数**，保证「内存态」与「回放态」逐字一致
   * （否则 restart 后状态会凭空分叉，这是最恶劣的静默失败）。
   */
  function applyEvent(ev) {
    switch (ev.kind) {
      case 'prompt':
        if (ev.after && typeof ev.after.id === 'string') prompts.set(ev.after.id, clone(ev.after))
        else prompts.delete(ev.id)
        break
      case 'injection':
        if (ev.after && typeof ev.after.id === 'string') injections.set(ev.after.id, clone(ev.after))
        else injections.delete(ev.id)
        break
      case 'category':
        if (ev.action === 'remove' || !ev.after) categories.delete(ev.id)
        else categories.set(ev.after.name, clone(ev.after))
        break
      case 'session':
        // 只接受推进（同时容忍重复投递）
        if (Number.isFinite(ev.rev)) sessions.set(ev.id, Math.max(sessions.get(ev.id) ?? 0, ev.rev))
        break
      case 'usage': {
        const prompt = prompts.get(ev.id)
        if (prompt) {
          const delta = Number.isInteger(ev.after?.count) && ev.after.count > 0 ? ev.after.count : 1
          prompt.useCount = (Number.isInteger(prompt.useCount) ? prompt.useCount : 0) + delta
        }
        break
      }
      default:
        break
    }
  }

  /** 写快照（失败只 warn：事件流已落盘，replay 能重建）。 */
  function persistSnapshot() {
    if (!writeJsonAtomic(snapPath, buildSnapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/prompts] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可完整恢复`)
    }
  }

  /**
   * 提交一次变更：**先落事件，再改内存，最后写快照**。顺序不可颠倒
   * （append 失败时内存必须原封不动，否则内存与磁盘分叉）。
   *
   * @param {'prompt'|'injection'|'category'|'session'|'usage'} kind
   * @param {string} id
   * @param {string} action
   * @param {number} rev
   * @param {string|null} byId
   * @param {number} at
   * @param {object|null} before
   * @param {object|null} after
   * @returns {object|null} 克隆后的 after
   */
  function commit(kind, id, action, rev, byId, at, before, after) {
    const event = {
      kind,
      id,
      rev,
      action,
      byId: byId ?? null,
      at,
      before: before ? clone(before) : null,
      after: after ? clone(after) : null,
    }
    if (!appendJsonl(jsonlPath, event)) {
      throw new PromptError(
        `prompts.${action}：事件追加失败（${jsonlPath}）——拒绝「只改内存不落盘」`,
        'PROMPT_APPEND_FAILED',
        { kind, id, action, path: jsonlPath },
      )
    }
    applyEvent(event)
    events.push(event)
    persistSnapshot()
    return after ? clone(after) : null
  }

  // ── 回放 ──────────────────────────────────────────────────────────────────

  /**
   * 从 `prompts.jsonl`（真相源）重建内存态；jsonl 为空才回落到快照。
   * 坏行**不静默丢弃**：计入 diagnostics 并 warn。
   *
   * 缺省分类先播种再回放事件 —— 这样"用户删除了缺省分类"这个动作在回放后仍然生效
   * （否则每次重启默认分类又长回来，与用户操作相悖）。
   */
  function hydrate() {
    prompts.clear()
    injections.clear()
    categories.clear()
    sessions.clear()
    pendingConsume.clear()
    events.length = 0
    disposed = false

    for (const name of DEFAULT_CATEGORIES) {
      categories.set(name, { name, createdAt: 0, createdBy: 'system' })
    }

    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) {
      warn(`[cs-bots/prompts] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }

    if (rows.length === 0) {
      const snap = readJson(snapPath, null)
      if (snap && typeof snap === 'object' && Array.isArray(snap.prompts)) {
        for (const raw of snap.prompts) {
          if (!raw || typeof raw.id !== 'string') continue
          const p = clone(raw)
          if (!Array.isArray(p.tags)) p.tags = []
          if (typeof p.useCount !== 'number') p.useCount = 0
          prompts.set(p.id, p)
        }
        for (const raw of Array.isArray(snap.injections) ? snap.injections : []) {
          if (!raw || typeof raw.id !== 'string') continue
          injections.set(raw.id, clone(raw))
        }
        if (Array.isArray(snap.categories)) {
          categories.clear()
          for (const raw of snap.categories) {
            if (!raw || typeof raw.name !== 'string') continue
            categories.set(raw.name, clone(raw))
          }
        }
        if (snap.sessions && typeof snap.sessions === 'object') {
          for (const [sid, turn] of Object.entries(snap.sessions)) {
            if (typeof sid === 'string' && Number.isFinite(turn)) sessions.set(sid, turn)
          }
        }
        diagnostics.hydratedFrom = 'snapshot'
        info(`[cs-bots/prompts] 回放完成：无事件流 → 由快照恢复 ${prompts.size} 条提示词 / ${injections.size} 条注入`)
        return
      }
      diagnostics.hydratedFrom = 'empty'
      info('[cs-bots/prompts] 回放完成：空库（无事件流、无快照）')
      return
    }

    // 事件流是真相源：prompt/injection 只接受 rev 递增事件（同 rev 重放幂等，容忍重复投递）
    const seenRev = new Map()
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.kind !== 'string' || typeof ev.id !== 'string') {
        skipped += 1
        continue
      }
      if (!EVENT_KINDS.includes(ev.kind)) {
        skipped += 1
        continue
      }
      if (ev.kind === 'prompt' || ev.kind === 'injection') {
        if (!Number.isFinite(ev.rev)) {
          skipped += 1
          continue
        }
        const key = `${ev.kind}:${ev.id}`
        const seen = seenRev.get(key) ?? 0
        if (ev.rev <= seen) {
          skipped += 1
          continue
        }
        seenRev.set(key, ev.rev)
      }
      applyEvent(ev)
      events.push(clone(ev))
    }
    if (skipped > 0) {
      warn(`[cs-bots/prompts] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }

    // 兜底：旧数据里可能没有 category 事件，但提示词引用了某个分类 —— 补齐，避免 UI 分类树丢条目
    for (const p of prompts.values()) {
      if (!categories.has(p.category)) {
        categories.set(p.category, { name: p.category, createdAt: 0, createdBy: 'system' })
      }
    }

    diagnostics.hydratedFrom = 'jsonl'
    info(`[cs-bots/prompts] 回放完成：${rows.length} 条事件 → ${prompts.size} 条提示词 / ${injections.size} 条注入`)
  }

  // ── 校验小件 ──────────────────────────────────────────────────────────────

  /** CAS 前置校验：expectedRev 必须显式给、且与当前 rev 一致（不匹配绝不覆盖）。 */
  function assertExpectedRev(current, expectedRev, where) {
    if (!Number.isInteger(expectedRev)) {
      throw new PromptError(
        `prompts.${where}：expectedRev 必须是整数（CAS 需要显式期望版本，条目 ${current.id} 当前 rev=${current.rev}，`
        + `收到 ${JSON.stringify(expectedRev)}）`,
        'PROMPT_MISSING_EXPECTED_REV',
        { id: current.id, rev: current.rev, where },
      )
    }
    if (current.rev !== expectedRev) {
      throw new PromptError(
        `prompts.${where} CAS 冲突：条目 ${current.id} 期望 rev=${expectedRev}，实际 rev=${current.rev} —— `
        + '拒绝静默覆盖，请重新 getPrompt() 后按最新 rev 重试',
        'PROMPT_REV_CONFLICT',
        { id: current.id, expectedRev, rev: current.rev, where },
      )
    }
  }

  /** 取必须存在的提示词。 */
  function mustGetPrompt(id, where) {
    const promptId = requireString(id, 'id', where)
    const current = prompts.get(promptId)
    if (!current) {
      throw new PromptError(
        `prompts.${where}：提示词 ${promptId} 不存在`,
        'PROMPT_NOT_FOUND',
        { id: promptId, where },
      )
    }
    return current
  }

  /** 取必须存在的注入。 */
  function mustGetInjection(id, where) {
    const injectionId = requireString(id, 'id', where)
    const current = injections.get(injectionId)
    if (!current) {
      throw new PromptError(
        `prompts.${where}：注入 ${injectionId} 不存在（可能已被停止或过期）`,
        'PROMPT_INJECTION_NOT_FOUND',
        { id: injectionId, where },
      )
    }
    return current
  }

  /**
   * 确保分类存在（自由文本分类自动登记）。
   * 为什么自动登记而不是抛错：UI 里新建提示词时直填分类是高频操作，
   * 让用户先去建分类是多余摩擦；登记动作本身进事件流，可回放、可审计。
   */
  function ensureCategory(name, by, at) {
    if (categories.has(name)) return
    commit('category', name, 'add', 1, by, at, null, { name, createdAt: at, createdBy: by })
  }

  // ── 提示词 CRUD ───────────────────────────────────────────────────────────

  /**
   * 新建提示词。
   * @param {{ name: string, description?: string, category?: string, tags?: string[],
   *           body?: string, enabled?: boolean, by: string, now?: number }} input
   * @returns {object} Prompt
   */
  function createPrompt(input = {}) {
    assertAlive('createPrompt')
    const by = requireActor(input, 'create')
    const at = normalizeNow(input?.now)
    const fields = {
      name: normalizeName(input?.name, 'create'),
      description: normalizeDescription(input?.description, 'create'),
      category: normalizeCategoryName(input?.category, 'create'),
      tags: normalizeTags(input?.tags, 'create'),
      body: normalizeBody(input?.body === undefined || input?.body === null ? '' : input?.body, 'create'),
      enabled: normalizeEnabled(input?.enabled, 'create'),
    }
    ensureCategory(fields.category, by, at)

    const id = newId(PROMPT_ID_PREFIX, prompts)
    const record = {
      id,
      rev: 1,
      ...fields,
      // useCount 起点 0；它是遥测不是内容版本，见文件头「为什么 useCount 不走 rev」
      useCount: 0,
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      updatedBy: by,
    }
    return commit('prompt', id, 'create', 1, by, at, null, record)
  }

  /**
   * 按 `expectedRev` 做 CAS 变更。可改：name/description/category/tags/body/enabled。
   * @param {{ id: string, expectedRev: number, name?: string, description?: string,
   *           category?: string, tags?: string[], body?: string, enabled?: boolean,
   *           by: string, now?: number }} input
   * @returns {object} 更新后的 Prompt
   */
  function updatePrompt(input = {}) {
    assertAlive('updatePrompt')
    // 注意：by / byId 必须一并解构出去，否则会落进 `rest` 被误判成未知字段
    const {
      id, expectedRev, name, description, category, tags, body, enabled, now,
      by: _by, byId: _byId, ...rest
    } = input ?? {}
    const by = requireActor(input, 'update')
    const current = mustGetPrompt(id, 'update')
    assertExpectedRev(current, expectedRev, 'update')

    // 字段级「给没给」判定必须用 `!== undefined`：description='' / tags=[] / body=''
    // 都是**合法的显式清空**，不能当成"没提供"而静默忽略。
    const unknown = Object.keys(rest ?? {})
    if (unknown.length > 0) {
      throw new PromptError(
        `prompts.update：未知字段 ${unknown.join(', ')}（可改：name | description | category | tags | body | enabled；`
        + 'id/rev/useCount/createdAt 由系统维护，不可改）——拒绝静默忽略',
        'PROMPT_UNKNOWN_FIELD',
        { id: current.id, unknown },
      )
    }

    const patch = {}
    if (name !== undefined) patch.name = normalizeName(name, 'update')
    if (description !== undefined) patch.description = normalizeDescription(description, 'update')
    if (category !== undefined) patch.category = normalizeCategoryName(category, 'update')
    if (tags !== undefined) patch.tags = normalizeTags(tags, 'update')
    if (body !== undefined) patch.body = normalizeBody(body, 'update')
    if (enabled !== undefined) patch.enabled = normalizeEnabled(enabled, 'update')

    if (Object.keys(patch).length === 0) {
      throw new PromptError(
        'prompts.update：未提供任何可改字段（name | description | category | tags | body | enabled）',
        'PROMPT_NO_PATCH_FIELDS',
        { id: current.id },
      )
    }

    const at = normalizeNow(now)
    if (patch.category !== undefined) ensureCategory(patch.category, by, at)

    const next = {
      ...clone(current),
      ...patch,
      rev: current.rev + 1,
      updatedAt: at,
      updatedBy: by,
    }
    return commit('prompt', current.id, 'update', next.rev, by, at, clone(current), next)
  }

  /**
   * 删除提示词（CAS）。**级联清理**它名下的活跃注入 ——
   * 不级联就会留下「提示词已经没了、注入轨还在每回合念旧内容」的悬空引用。
   * @param {{ id: string, expectedRev: number, by: string, now?: number }} input
   * @returns {{ removed: string, injections: number }}
   */
  function removePrompt(input = {}) {
    assertAlive('removePrompt')
    const { id, expectedRev, now } = input ?? {}
    const by = requireActor(input, 'remove')
    const current = mustGetPrompt(id, 'remove')
    assertExpectedRev(current, expectedRev, 'remove')
    const at = normalizeNow(now)

    const related = [...injections.values()].filter((inj) => inj.promptId === current.id)
    for (const inj of related) {
      commit('injection', inj.id, 'stop', inj.rev + 1, by, at, clone(inj), null)
    }
    commit('prompt', current.id, 'remove', current.rev + 1, by, at, clone(current), null)
    info(`[cs-bots/prompts] 已删除提示词 ${current.id}（级联清理 ${related.length} 条注入）`)
    return { removed: current.id, injections: related.length }
  }

  /** 取一条提示词；不存在返回 null（与 board.get 同款，不抛错）。 */
  function getPrompt(id) {
    assertAlive('getPrompt')
    if (typeof id !== 'string' || id.trim() === '') return null
    const found = prompts.get(id.trim())
    return found ? clone(found) : null
  }

  /**
   * 列表查询。
   * @param {{ category?: string, tag?: string, query?: string, enabled?: boolean, limit?: number }} [options]
   * @returns {object[]} 按 updatedAt 倒序（最近改的在前），同时间按 id 升序保证稳定
   */
  function listPrompts(options = {}) {
    assertAlive('listPrompts')
    const { category, tag, query, enabled, limit } = options ?? {}
    const categoryFilter = typeof category === 'string' && category.trim() !== '' ? category.trim() : null
    const tagFilter = typeof tag === 'string' && tag.trim() !== '' ? tag.trim() : null
    const q = typeof query === 'string' && query.trim() !== '' ? query.trim().toLowerCase() : null
    const enabledFilter = typeof enabled === 'boolean' ? enabled : null
    const limitFilter = Number.isInteger(limit) && limit > 0 ? limit : 0

    const out = []
    for (const p of prompts.values()) {
      if (categoryFilter !== null && p.category !== categoryFilter) continue
      if (enabledFilter !== null && p.enabled !== enabledFilter) continue
      if (tagFilter !== null && !(p.tags ?? []).some((x) => x.toLowerCase() === tagFilter.toLowerCase())) continue
      if (q !== null) {
        const haystack = `${p.name}\n${p.description}\n${p.body}\n${(p.tags ?? []).join(' ')}`.toLowerCase()
        if (!haystack.includes(q)) continue
      }
      out.push(clone(p))
    }
    out.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return limitFilter > 0 ? out.slice(0, limitFilter) : out
  }

  // ── 分类 ──────────────────────────────────────────────────────────────────

  /**
   * 分类列表（含每个分类下的提示词数）。
   * 按名字升序（稳定，便于 UI 与测试比对）。
   * @returns {{ name: string, createdAt: number, createdBy: string, builtin: boolean,
   *             protected: boolean, count: number }[]}
   */
  function listCategories() {
    assertAlive('listCategories')
    const counts = new Map()
    for (const p of prompts.values()) {
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1)
    }
    return [...categories.values()]
      .map((c) => ({
        name: c.name,
        createdAt: c.createdAt,
        createdBy: c.createdBy,
        // createdAt=0 是"启动播种的缺省分类"；用户删了再加回来就转正为普通分类
        builtin: c.createdAt === 0,
        // 「未分类」是兜底分类，删掉它会让 removeCategory 无处可迁 —— 必须保护
        protected: c.name === DEFAULT_CATEGORY,
        count: counts.get(c.name) ?? 0,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /**
   * 新建分类。
   * @param {{ name: string, by: string, now?: number }} input
   * @returns {{ name: string, createdAt: number, createdBy: string }}
   */
  function addCategory(input = {}) {
    assertAlive('addCategory')
    const by = requireActor(input, 'addCategory')
    const at = normalizeNow(input?.now)
    const name = normalizeCategoryName(input?.name, 'addCategory', true)
    if (categories.has(name)) {
      throw new PromptError(
        `prompts.addCategory：分类「${name}」已存在（拒绝重复创建，也不会静默合并）`,
        'PROMPT_CATEGORY_EXISTS',
        { name },
      )
    }
    return commit('category', name, 'add', 1, by, at, null, { name, createdAt: at, createdBy: by })
  }

  /**
   * 删除分类：该分类下的提示词**迁移到「未分类」**（分类只是组织方式，删分类不删内容）。
   * @param {{ name: string, by: string, now?: number }} input
   * @returns {{ removed: string, moved: number }}
   */
  function removeCategory(input = {}) {
    assertAlive('removeCategory')
    const by = requireActor(input, 'removeCategory')
    const at = normalizeNow(input?.now)
    const name = requireString(input?.name, 'name', 'removeCategory', MAX_CATEGORY_LEN)
    if (name === DEFAULT_CATEGORY) {
      throw new PromptError(
        `prompts.removeCategory：「${DEFAULT_CATEGORY}」是兜底分类，不可删除（否则删其它分类时提示词无处迁）`,
        'PROMPT_PROTECTED_CATEGORY',
        { name },
      )
    }
    const record = categories.get(name)
    if (!record) {
      throw new PromptError(
        `prompts.removeCategory：分类「${name}」不存在`,
        'PROMPT_CATEGORY_NOT_FOUND',
        { name },
      )
    }

    const affected = [...prompts.values()].filter((p) => p.category === name)
    for (const p of affected) {
      const next = {
        ...clone(p),
        category: DEFAULT_CATEGORY,
        rev: p.rev + 1,
        updatedAt: at,
        updatedBy: by,
      }
      commit('prompt', p.id, 'update', next.rev, by, at, clone(p), next)
    }
    commit('category', name, 'remove', 1, by, at, clone(record), null)
    info(`[cs-bots/prompts] 已删除分类「${name}」，${affected.length} 条提示词迁到「${DEFAULT_CATEGORY}」`)
    return { removed: name, moved: affected.length }
  }

  // ── 注入轨 ────────────────────────────────────────────────────────────────

  /**
   * 新建注入。
   *
   * `promptId` 与 `text` 二选一：前者把某条提示词投进注入轨（产出时实时读最新 body），
   * 后者投一段临时文本（ad-hoc，比如一次性提醒）。两者都给会被拒绝 ——
   * "到底念哪段"必须唯一确定，不能靠优先级猜测。
   *
   * @param {{ promptId?: string, text?: string, sessionId: string, times?: number,
   *           every?: number, immediate?: boolean, by: string, now?: number }} input
   * @returns {object} Injection
   */
  function inject(input = {}) {
    assertAlive('inject')
    const by = requireActor(input, 'inject')
    const at = normalizeNow(input?.now)
    const sessionId = normalizeSessionId(input?.sessionId, 'inject')

    const hasPrompt = input?.promptId !== undefined && input?.promptId !== null && input?.promptId !== ''
    const hasText = input?.text !== undefined && input?.text !== null
    if (hasPrompt && hasText) {
      throw new PromptError(
        'prompts.inject：promptId 与 text 只能给一个（同时给会让「念哪段」歧义）',
        'PROMPT_AMBIGUOUS_INPUT',
        { promptId: String(input.promptId) },
      )
    }
    if (!hasPrompt && !hasText) {
      throw new PromptError(
        'prompts.inject：必须提供 promptId 或 text 之一',
        'PROMPT_MISSING_TEXT',
        {},
      )
    }

    let promptId = null
    let text
    if (hasPrompt) {
      const prompt = mustGetPrompt(input.promptId, 'inject')
      if (prompt.enabled !== true) {
        throw new PromptError(
          `prompts.inject：提示词 ${prompt.id} 处于停用状态，不能注入（请先启用）`,
          'PROMPT_DISABLED',
          { id: prompt.id },
        )
      }
      promptId = prompt.id
      text = prompt.body
    } else {
      text = normalizeBody(input.text, 'inject')
    }

    const immediate = input?.immediate === true
    let every = normalizeEvery(input?.every, 'inject')
    let times = normalizeTimes(input?.times, 'inject')
    if (immediate) {
      // 立即注入 = 只注入一次，且无视间隔：固定 every=0 / times=1
      every = 0
      times = 1
    } else if (every === 0) {
      // every=0 的语义是「只注入一次」（用户直觉：没有间隔 = 只出现一下），
      // 它与「无限次」的 times=0 天然矛盾 —— 以 every=0 为准（次数被覆盖为 1）。
      times = 1
    }
    const remaining = times // times=0 是「无限」的哨兵；remaining 保持 0，tick 永不减

    const id = newId(INJECTION_ID_PREFIX, injections)
    const record = {
      id,
      rev: 1,
      promptId,
      text,
      sessionId,
      times,
      every,
      remaining,
      immediate,
      createdAt: at,
      createdBy: by,
    }
    info(`[cs-bots/prompts] 新建注入 ${id} session=${sessionId} times=${times} every=${every} immediate=${immediate}`)
    return commit('injection', id, 'create', 1, by, at, null, record)
  }

  /**
   * 手动停止一条注入（提前结束）。
   * @param {{ id: string, by: string, now?: number }} input
   * @returns {{ stopped: string }}
   */
  function stopInjection(input = {}) {
    assertAlive('stopInjection')
    const by = requireActor(input, 'stopInjection')
    const at = normalizeNow(input?.now)
    const current = mustGetInjection(input?.id, 'stopInjection')
    commit('injection', current.id, 'stop', current.rev + 1, by, at, clone(current), null)
    // 从各会话的待扣集合里摘掉，避免后续 tick 引用已删条目（虽然 tick 会跳过，但别留垃圾）
    for (const set of pendingConsume.values()) set.delete(current.id)
    return { stopped: current.id }
  }

  /**
   * 列活跃注入（按创建时间正序）。
   * @param {{ sessionId?: string }} [options] 省略 sessionId 则返回全部（UI 概览用）
   * @returns {object[]}
   */
  function listInjections(options = {}) {
    assertAlive('listInjections')
    const sessionId = typeof options?.sessionId === 'string' && options.sessionId.trim() !== ''
      ? options.sessionId.trim()
      : null
    const out = []
    for (const inj of injections.values()) {
      if (sessionId !== null && inj.sessionId !== sessionId) continue
      out.push(clone(inj))
    }
    out.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return out
  }

  /**
   * **本轮应注入的内容**（纯查询，可重复调用）。
   *
   * 判定规则（严格实现契约）：
   *   - `immediate=true` → 固定产出一轮，不受 times/every 影响；
   *   - `every > 1` → 只在「本回合序号 % every === 0」的回合产出；
   *   - `every === 1` → 每回合产出；
   *   - `every === 0` → 一次性（次数已归一为 1，产出即等问题）。
   *
   * 同回合重复调用**幂等**：产出过的 id 记在 pending 里，直接返回同一批
   * （次数扣减统一交给 `tickTurn`，避免预览把注入预算吃光）。
   *
   * @param {{ sessionId: string, now?: number }} input `now` 仅测试用，控制 {{date}}/{{time}} 展开
   * @returns {{ id: string, text: string }[]} 正文已展开 `{{date}}`/`{{time}}`
   */
  function activeInjectionsFor(input = {}) {
    assertAlive('activeInjectionsFor')
    const sessionId = normalizeSessionId(input?.sessionId, 'activeInjectionsFor')
    const at = normalizeNow(input?.now)
    const turnNo = sessions.get(sessionId) ?? 0
    const currentTurn = turnNo + 1

    let pending = pendingConsume.get(sessionId)
    if (!pending) {
      pending = new Set()
      pendingConsume.set(sessionId, pending)
    }

    const out = []
    for (const inj of injections.values()) {
      if (inj.sessionId !== sessionId) continue
      const already = pending.has(inj.id)
      let eligible
      if (already) {
        eligible = true
      } else if (inj.immediate === true) {
        // 立即注入：不看间隔，本轮就产出
        eligible = true
      } else if (inj.every > 1) {
        // 「本回合序号 % every === 0」：every=2 → 第 2、4、6… 回合产出
        eligible = currentTurn % inj.every === 0
      } else {
        eligible = true // every 1（每回合）或 0（一次性）
      }
      if (!eligible) continue
      pending.add(inj.id)
      out.push({ id: inj.id, text: renderInjection(inj, at) })
    }
    return out
  }

  /** 产出的正文：提示词注入实时读最新 body；ad-hoc 用创建时的 text。 */
  function renderInjection(inj, now) {
    let source = inj.text ?? ''
    if (inj.promptId) {
      const prompt = prompts.get(inj.promptId)
      // 理论上删除提示词会级联清注入；这里保留 text 兜底，防止旧数据悬空
      if (prompt) source = prompt.body ?? ''
    }
    return expandTemplates(source, now)
  }

  /**
   * 回合推进：对「本轮已产出」的注入扣一次剩余次数，归零则自动移除（记 `expire` 事件）；
   * 同时 session 回合序号 +1。
   *
   * 为什么不在 `activeInjectionsFor` 里扣：见文件头「为什么注入要单独一套拿到即计数机制」。
   *
   * @param {{ sessionId: string, now?: number }} input
   * @returns {{ sessionId: string, turn: number, consumed: number, expired: number, active: number }}
   */
  function tickTurn(input = {}) {
    assertAlive('tickTurn')
    const sessionId = normalizeSessionId(input?.sessionId, 'tickTurn')
    const at = normalizeNow(input?.now)

    const pending = pendingConsume.get(sessionId)
    let consumed = 0
    let expired = 0
    /** @type {Map<string, number>} promptId → 本回合产出次数（合并成一条 usage 事件） */
    const usedPrompts = new Map()

    if (pending && pending.size > 0) {
      for (const id of [...pending]) {
        const inj = injections.get(id)
        if (!inj) {
          pending.delete(id)
          continue
        }
        consumed += 1
        if (inj.promptId) usedPrompts.set(inj.promptId, (usedPrompts.get(inj.promptId) ?? 0) + 1)
        // times=0 = 无限注入：不消耗、永不自动过期（只能手动 stop）
        if (inj.times === 0) continue

        const before = clone(inj)
        const next = clone(inj)
        next.rev = inj.rev + 1
        next.remaining = Math.max(0, (Number.isInteger(inj.remaining) ? inj.remaining : 0) - 1)
        if (next.remaining <= 0) {
          commit('injection', inj.id, 'expire', next.rev, null, at, before, null)
          expired += 1
        } else {
          commit('injection', inj.id, 'tick', next.rev, null, at, before, next)
        }
      }
      pending.clear()
    }

    // useCount 遥测：每回合每提示词合并成一条 usage 事件（N 条注入不写 N 条事件）
    for (const [promptId, count] of usedPrompts) {
      if (!prompts.has(promptId)) continue
      commit('usage', promptId, 'inc', 0, null, at, null, { promptId, count })
    }

    const turn = (sessions.get(sessionId) ?? 0) + 1
    commit('session', sessionId, 'tick', turn, null, at, null, { sessionId, turn })

    let active = 0
    for (const inj of injections.values()) {
      if (inj.sessionId === sessionId) active += 1
    }
    return { sessionId, turn, consumed, expired, active }
  }

  // ── 统计 / 回放 / 销毁 ────────────────────────────────────────────────────

  /** 审计流查询（可选按 id 过滤）。 */
  function history(id) {
    assertAlive('history')
    const rows = typeof id === 'string' && id !== ''
      ? events.filter((e) => e.id === id)
      : events
    return clone(rows)
  }

  /**
   * 统计（给 /status 与 UI 概览用）。
   * @returns {object}
   */
  function stats() {
    assertAlive('stats')
    const byCategory = {}
    const bySession = {}
    let enabled = 0
    let disabled = 0
    const tagSet = new Set()
    for (const p of prompts.values()) {
      byCategory[p.category] = (byCategory[p.category] ?? 0) + 1
      if (p.enabled === false) disabled += 1
      else enabled += 1
      for (const tag of p.tags ?? []) tagSet.add(tag)
    }
    for (const inj of injections.values()) {
      bySession[inj.sessionId] = (bySession[inj.sessionId] ?? 0) + 1
    }
    return {
      prompts: prompts.size,
      enabled,
      disabled,
      categories: categories.size,
      tags: tagSet.size,
      injections: injections.size,
      sessions: sessions.size,
      events: events.length,
      byCategory,
      bySession,
    }
  }

  /**
   * 从 `prompts.jsonl` 重建内存态（重启回放一致性）。
   * @returns {{ from: string, prompts: number, injections: number, categories: number, sessions: number, events: number, bad: number }}
   */
  function replay() {
    assertAlive('replay')
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      prompts: prompts.size,
      injections: injections.size,
      categories: categories.size,
      sessions: sessions.size,
      events: events.length,
      bad: diagnostics.badLines,
    }
  }

  /**
   * 销毁实例（拒绝后续调用）。不删文件：提示词是长期资产，dispose 只是「实例下班」。
   * @returns {{ disposed: boolean, prompts: number, injections: number, events: number }}
   */
  function dispose() {
    const out = { disposed: true, prompts: prompts.size, injections: injections.size, events: events.length }
    disposed = true
    prompts.clear()
    injections.clear()
    categories.clear()
    sessions.clear()
    pendingConsume.clear()
    events.length = 0
    return out
  }

  /** 首次构造即回放，保证重启后 get/list 马上可用。 */
  hydrate()

  const service = {
    name: cfg.name ?? 'prompts',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    // 提示词
    createPrompt,
    updatePrompt,
    removePrompt,
    getPrompt,
    listPrompts,
    // 分类
    listCategories,
    addCategory,
    removeCategory,
    // 注入轨
    inject,
    stopInjection,
    listInjections,
    activeInjectionsFor,
    tickTurn,
    // 运维
    stats,
    replay,
    history,
    dispose,
    diagnostics: () => clone(diagnostics),
  }
  return service
}

export default createPrompts
