/**
 * cs-bots SuggestService —— 建议确认队列（记忆进化的**命门**，DESIGN-v2 §「建议确认制」）。
 *
 * ── 为什么必须存在 ──────────────────────────────────────────────────────────
 * `memory.review()` 碰到 `explicit:true` 条目只会返回 `{ action:'suggest', ... }`，
 * 那个返回值**刷新即丢**：没有队列、没有持久化、没有「人确认」这一步。
 * 而「模型不能直接改长期记忆，只能提建议，人确认后才生效」正是记忆进化最核心的一条。
 * 少了它，模型的一次幻觉就能直接污染人显式写下的偏好/人设 —— 这是不可接受的。
 *
 * 所以本模块把「模型想改」与「真的改」**拆成两步**：
 *
 *   模型/审查器 suggest()  →  落盘 pending（带 reason，人看得懂为什么）
 *        →  人在 UI 里看理由、看目标层
 *        →  accept({ id, apply }) 才真正入库
 *
 * ── 为什么**不 import** `memory.js` / `library.js` ──────────────────────────
 * 三条理由，缺一条都会让这个模块变脆：
 *   ① **避免循环依赖**：memory.js / library.js 将来若要「发现值得建议的改动」，
 *      它们会想调本模块；本模块再 import 它们就成环。ESM 的环会带来 TDZ 问题，
 *      在 `type:module` 下表现为「某些情况下 undefined is not a function」这种难查故障。
 *   ② **写入边界**：本模块只许写自己的 `suggestions.jsonl`。真正入库的动作由调用方
 *      （api 层）通过 `apply` 回调注入 —— `accept` 自己**从不**碰记忆/技能库。
 *      这样「建议」与「领域写入」的权限面是分离的，越权在结构上就不可能发生。
 *   ③ **可测**：`apply` 用假回调就能测通「采纳 → 落库 → 状态归位」整条链路，
 *      不用先构造一个 memory 实例（memory.js 3k+ 行，拖进单测不划算）。
 *
 * ── 三条铁律（与 board.js / discipline.js 同款）────────────────────────────
 *   1. **CAS(rev)**：accept/reject 支持 `expectedRev`；不匹配即抛 `SUGGEST_CAS_CONFLICT`，
 *      **绝不静默覆盖**（UI 双开两个页面时，后点的那个必须失败而不是覆盖先点的结果）。
 *   2. **事件流是真相源**：先 append `suggestions.jsonl`（失败即抛错、内存原封不动），
 *      再改内存，最后原子写 `suggestions.snap.json`（快照失败只 warn，replay() 可重建）。
 *   3. **apply 失败绝不假装成功**：该条保持 `pending`、错误文本记进 `lastError`（并且落盘，
 *      重启后仍可审计），同时把错误**抛给调用方**。绝不出现「界面说已采纳、库里啥也没有」。
 *      `apply` **可同步也可异步**（api 层的 applySuggestion 是 async：memory/library 的写入
 *      可能跨异步边界）—— 因此 `accept`/`bulkAccept` 返回 Promise，内部**必定 await**；
 *      不 await 就会在真正写库完成前标 accepted，那正是「假采纳」。
 *
 * ── 去重口径 ────────────────────────────────────────────────────────────────
 * 同 `kind + layer + payload（trim + 压空白 + 大小写不敏感）` 且仍为 `pending` → 视为重复：
 * 返回已有那条并标 `duplicate:true`，**不新增**。
 * 为什么把 `layer` 也算进去：同一段文字写进 L1（偏好）与 L3（项目 key）是**两个不同目标**，
 * 合并会把建议引到错误的层；为什么只比 pending：被拒绝过的建议允许再次提出（人可能只是当时忙）。
 * `cwd`（可选，只对 L3/L4/L5 有意义）也参与归一化比较：同一句话进「A 项目」和「B 项目」
 * 是两个不同的建议，合并会让项目记忆串味。
 *
 * 依赖面：`node:*` + `./store.js` + `./kernel.js`（惰性桥）。**零第三方依赖**。
 */

import { randomBytes } from 'node:crypto'

import {
  appendJsonl,
  readJson,
  readJsonl,
  statePath,
  writeJsonAtomic,
} from './store.js'

// ── kernel 惰性桥 ───────────────────────────────────────────────────────────
//
// 与 board.js / discipline.js 同款：kernel.js 是**唯一**允许静态 import 宿主包的文件，
// 裸检出（无宿主包）时它的加载会失败；这里用 try/catch 兜住，拿不到 kernel 时
// **不静默兜底** —— 调用方必须显式传 `config.stateDir`，错误码 `SUGGEST_NO_STATE_DIR`。

/** @type {object | null} */
let kernel = null
/** @type {unknown} */
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

// ── 常量（契约冻结，改这里等于改 API 层契约）────────────────────────────────

/** 建议类型：记忆 / 技能 / 纪律。 */
export const KINDS = ['memory', 'skill', 'discipline']
/** 建议生命周期状态。 */
export const STATUSES = ['pending', 'accepted', 'rejected']
/** 建议来源（谁提的）：审查 / 合并整理 / 模型主动。 */
export const SOURCES = ['review', 'consolidate', 'model']
/**
 * 记忆层白名单：**L0 人格不在其中**。
 * 为什么：L0 是「人显式写下的人格」，memory.js 用 `assertNotPersonaLayer` 硬拦
 * 一切程序写入；建议队列如果允许往 L0 提，就只是把一个会被拒的动作延后了，
 * 白让用户点一次「采纳」再看到失败。所以在 suggest 阶段就拒掉（SUGGEST_BAD_LAYER）。
 */
export const MEMORY_LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5']

/**
 * payload 各字段上限。
 * 刻意与 library.js / DESIGN-v2 的既有上限对齐 —— 建议比库里更宽松没有意义：
 * 在队列里放得下、采纳时却被库拒收，等于把失败推后到人点按钮的那一刻。
 */
export const LIMITS = Object.freeze({
  reason: 2000,
  memoryContent: 20000,
  skillName: 64,
  skillDescription: 2000,
  skillBody: 20000,
  disciplineTitle: 120,
  disciplineContent: 4000,
  /** cwd 单条长度上限（路径再长也不该超过这个数；超出多半是误把正文塞进来了）。 */
  cwd: 4096,
  tags: 20,
  tagLength: 64,
})

/**
 * 纪律模块的枚举**内联**，不从 `./discipline.js` import。
 * 为什么：suggest.js 是「闸门」，不该因为纪律模块换实现而连带加载失败；
 * 两边取值以 DESIGN-v2 §特性② 为唯一来源，这里只做校验用。
 */
const DISCIPLINE_SCOPES = ['global', 'workspace', 'room', 'bot']
const DISCIPLINE_KINDS = ['rule', 'requirement', 'principle', 'style']

/** 技能名的 kebab-case 硬校验（比 library.NAME_RE 更严，理由见 requireSkillName）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// ── 错误类 ──────────────────────────────────────────────────────────────────

/** 建议队列错误：`code` 一律 `SUGGEST_` 前缀，`detail` 给机器读的上下文。 */
export class SuggestError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息
   * @param {string} [code] 大写下划线错误码（`SUGGEST_` 前缀）
   * @param {object} [detail] 机器可读上下文
   */
  constructor(message, code = 'SUGGEST_ERROR', detail) {
    super(message)
    this.name = 'SuggestError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 深拷贝 + JSON 归一（去掉 undefined 键，保证内存态与磁盘态逐字相等）。 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 错误 → 一行可读文本。 */
function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * `apply` 返回值的**可序列化**形态（入库证据要随事件流回显）。
 * 为什么需要：若回调返回循环引用对象，直接 JSON 序列化会抛错，
 * 把一次**已经成功**的采纳变成异常 —— 那是比失败更难查的误报。
 */
function safeResult(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value
  try {
    return clone(value)
  } catch {
    return { unserializable: String(value) }
  }
}

/** `now` 归一：缺省取当前时间；显式传必须是有限数字（拒绝字符串时间戳）。 */
function normalizeNow(now, where) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new SuggestError(
      `suggest.${where}：now 必须是有限数字（毫秒时间戳），收到 ${JSON.stringify(now)}`,
      'SUGGEST_BAD_FIELD',
      { where, field: 'now' },
    )
  }
  return now
}

/** 必填字符串（trim 后非空）。 */
function requireString(value, field, where, code = 'SUGGEST_BAD_FIELD') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SuggestError(
      `suggest.${where}：${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
      code,
      { where, field },
    )
  }
  return value.trim()
}

/** 长度上限（按码点计，避免中文被 UTF-16 长度误伤）。 */
function assertMaxLength(text, max, field, where) {
  const length = [...text].length
  if (length > max) {
    throw new SuggestError(
      `suggest.${where}：${field} 超长（${length} > ${max} 码点）—— 建议队列不放「采纳时必被库拒收」的内容`,
      'SUGGEST_TOO_LONG',
      { where, field, length, max },
    )
  }
  return text
}

/** payload 必须是纯对象（数组/null/字符串一律拒）。 */
function requirePlainObject(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SuggestError(
      `suggest.${where}：payload 必须是对象，收到 ${Array.isArray(value) ? 'array' : JSON.stringify(value)}`,
      'SUGGEST_BAD_PAYLOAD',
      { where, kind: typeof value },
    )
  }
  return value
}

/** 未知字段一律拒（契约里没写的字段 = 调用方 bug，静默忽略会让人以为生效了）。 */
function assertOnlyKeys(payload, allowed, where) {
  const extra = Object.keys(payload).filter((k) => !allowed.includes(k))
  if (extra.length > 0) {
    throw new SuggestError(
      `suggest.${where}：payload 含未知字段 ${extra.join(', ')}（允许：${allowed.join(', ')}）`,
      'SUGGEST_UNKNOWN_FIELD',
      { where, fields: extra, allowed },
    )
  }
}

/** 标签归一：字符串数组、trim、去空、去重、条数与单条长度上限。 */
function normalizeTags(tags, where) {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) {
    throw new SuggestError(
      `suggest.${where}：payload.tags 必须是字符串数组，收到 ${JSON.stringify(tags)}`,
      'SUGGEST_BAD_PAYLOAD',
      { where, field: 'tags' },
    )
  }
  const out = []
  const seen = new Set()
  for (const raw of tags) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new SuggestError(
        `suggest.${where}：payload.tags 每项必须是非空字符串，收到 ${JSON.stringify(raw)}`,
        'SUGGEST_BAD_PAYLOAD',
        { where, field: 'tags' },
      )
    }
    const tag = raw.trim()
    assertMaxLength(tag, LIMITS.tagLength, 'payload.tags[]', where)
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  if (out.length > LIMITS.tags) {
    throw new SuggestError(
      `suggest.${where}：payload.tags 最多 ${LIMITS.tags} 条，收到 ${out.length} 条`,
      'SUGGEST_TOO_LONG',
      { where, field: 'tags', count: out.length, max: LIMITS.tags },
    )
  }
  return out
}

/**
 * 技能名校验。
 * 为什么比 library.NAME_RE 更严（只允许 kebab-case）：技能最终要落成
 * `<cwd>/.agents/skills/<name>/SKILL.md` 的**目录名**，而 skill 目录约定就是 kebab-case；
 * 允许大写/下划线会造出「库里一条、目录里一条」的同名分裂，人排查时极难看出。
 */
function requireSkillName(value, where) {
  const name = requireString(value, 'payload.name', where, 'SUGGEST_BAD_PAYLOAD')
  if (!SKILL_NAME_RE.test(name) || name.length > LIMITS.skillName) {
    throw new SuggestError(
      `suggest.${where}：payload.name ${JSON.stringify(name)} 必须是 kebab-case（小写字母数字，连字符分隔，≤${LIMITS.skillName}）`,
      'SUGGEST_BAD_PAYLOAD',
      { where, field: 'name', name },
    )
  }
  return name
}

/** 把 payload 按 kind 归一（切掉两侧空白、校验必填与上限、拒未知字段）。 */
function normalizePayload(kind, rawPayload, where, layer = null) {
  const payload = requirePlainObject(rawPayload, where)
  const out = {}
  if (kind === 'memory') {
    // cwd 是可选字段：memory.js 已支持「按工作目录隔离」（只有 L3/L4/L5 认它）。
    // 提前收进 payload，是为了让「给某个项目提一条 L3 建议」在队列里就能表达目标项目。
    assertOnlyKeys(payload, ['content', 'tags', 'cwd'], where)
    out.content = assertMaxLength(
      requireString(payload.content, 'payload.content', where, 'SUGGEST_BAD_PAYLOAD'),
      LIMITS.memoryContent,
      'payload.content',
      where,
    )
    out.tags = normalizeTags(payload.tags, where)
    if (payload.cwd !== undefined && payload.cwd !== null) {
      const cwd = requireString(payload.cwd, 'payload.cwd', where, 'SUGGEST_BAD_PAYLOAD')
      assertMaxLength(cwd, LIMITS.cwd, 'payload.cwd', where)
      // 全局层（L1/L2）带 cwd 会被 memory.add **静默忽略** —— 那会让人以为「已按项目隔离」，
      // 实际写成了全局。宁可在入队时就拒掉（错误码带 field:cwd，UI 能说人话）。
      if (!['L3', 'L4', 'L5'].includes(layer)) {
        throw new SuggestError(
          `suggest.${where}：memory 建议的 payload.cwd 只对按项目隔离的层有效（L3/L4/L5），`
          + `当前 layer=${layer} —— 全局层写 cwd 会被静默忽略，故拒绝`,
          'SUGGEST_BAD_PAYLOAD',
          { where, field: 'cwd', layer },
        )
      }
      out.cwd = cwd
    }
    return out
  }
  if (kind === 'skill') {
    assertOnlyKeys(payload, ['name', 'description', 'body', 'tags'], where)
    out.name = requireSkillName(payload.name, where)
    out.description = payload.description === undefined || payload.description === null
      ? ''
      : assertMaxLength(
        requireString(payload.description, 'payload.description', where, 'SUGGEST_BAD_PAYLOAD'),
        LIMITS.skillDescription,
        'payload.description',
        where,
      )
    out.body = assertMaxLength(
      requireString(payload.body, 'payload.body', where, 'SUGGEST_BAD_PAYLOAD'),
      LIMITS.skillBody,
      'payload.body',
      where,
    )
    out.tags = normalizeTags(payload.tags, where)
    return out
  }
  // discipline
  // scopeId 是**目标定位**（workspace=cwd / room=roomId / bot=botId），discipline.js 对
  // 非 global 的 scope 强制要求它。允许它进 payload，是为了让「给某个工作区提一条纪律建议」
  // 在队列里就能表达清楚；否则采纳时才炸「scopeId 必填」，等于把失败推给人点按钮那一刻。
  assertOnlyKeys(payload, ['scope', 'scopeId', 'kind', 'title', 'content'], where)
  out.scope = requireString(payload.scope, 'payload.scope', where, 'SUGGEST_BAD_PAYLOAD')
  if (!DISCIPLINE_SCOPES.includes(out.scope)) {
    throw new SuggestError(
      `suggest.${where}：payload.scope=${JSON.stringify(out.scope)} 非法（合法：${DISCIPLINE_SCOPES.join(' | ')}）`,
      'SUGGEST_BAD_PAYLOAD',
      { where, field: 'scope' },
    )
  }
  out.kind = requireString(payload.kind, 'payload.kind', where, 'SUGGEST_BAD_PAYLOAD')
  if (!DISCIPLINE_KINDS.includes(out.kind)) {
    throw new SuggestError(
      `suggest.${where}：payload.kind=${JSON.stringify(out.kind)} 非法（合法：${DISCIPLINE_KINDS.join(' | ')}）`,
      'SUGGEST_BAD_PAYLOAD',
      { where, field: 'kind' },
    )
  }
  // scopeId 与 scope 强绑定（与 discipline.normalizeScopeId 同口径，宁可在入队时就拒）：
  // global 带 id 是歧义状态；非 global 缺 id 则采纳时必被 discipline 拒收。
  const rawScopeId = payload.scopeId === undefined || payload.scopeId === null ? '' : payload.scopeId
  let scopeId = null
  if (typeof rawScopeId === 'string' && rawScopeId.trim() !== '') {
    scopeId = assertMaxLength(rawScopeId.trim(), LIMITS.cwd, 'payload.scopeId', where)
  } else if (rawScopeId !== '') {
    throw new SuggestError(
      `suggest.${where}：payload.scopeId 必须是非空字符串（workspace=cwd / room=roomId / bot=botId），收到 ${JSON.stringify(payload.scopeId)}`,
      'SUGGEST_BAD_PAYLOAD',
      { where, field: 'scopeId' },
    )
  }
  if (out.scope === 'global' && scopeId !== null) {
    throw new SuggestError(
      `suggest.${where}：payload.scope=global 时不允许带 scopeId（收到 ${JSON.stringify(scopeId)}）—— `
      + '这是歧义状态，discipline 会拒收',
      'SUGGEST_BAD_PAYLOAD',
      { where, field: 'scopeId', scope: out.scope },
    )
  }
  if (out.scope !== 'global' && scopeId === null) {
    throw new SuggestError(
      `suggest.${where}：payload.scope=${out.scope} 必须给非空 scopeId（workspace=cwd 绝对路径 / room=roomId / bot=botId）`,
      'SUGGEST_BAD_PAYLOAD',
      { where, field: 'scopeId', scope: out.scope },
    )
  }
  out.scopeId = scopeId
  out.title = assertMaxLength(
    requireString(payload.title, 'payload.title', where, 'SUGGEST_BAD_PAYLOAD'),
    LIMITS.disciplineTitle,
    'payload.title',
    where,
  )
  out.content = assertMaxLength(
    requireString(payload.content, 'payload.content', where, 'SUGGEST_BAD_PAYLOAD'),
    LIMITS.disciplineContent,
    'payload.content',
    where,
  )
  return out
}

/** 递归归一化字符串：trim + 压缩空白 + 大小写不敏感（去重口径，见文件头）。 */
function normalizeForDedup(value) {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ').toLowerCase()
  if (Array.isArray(value)) return value.map(normalizeForDedup)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      out[key] = normalizeForDedup(value[key])
    }
    return out
  }
  return value
}

/** 去重键：`kind | layer | 归一化 payload`（稳定键序，避免键顺序不同导致漏判重复）。 */
function dedupKeyOf(kind, layer, payload) {
  return `${kind}|${layer ?? ''}|${JSON.stringify(normalizeForDedup(payload))}`
}

// ── 状态目录 ────────────────────────────────────────────────────────────────

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**（与 board.js 同一纪律）：兜到临时目录会造成「建议莫名其妙消失」。
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
  throw new SuggestError(
    `suggest.createSuggest：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'SUGGEST_NO_STATE_DIR',
  )
}

/**
 * 把 `(ctx, config)` 归一。允许「只传一个 config 对象」的简写（`{ stateDir }`），
 * 与 discipline.js 的 splitArgs 同款 —— 测试/工具层手写实例时更顺手。
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
 * 创建一个建议队列实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（只用于日志，缺失即 no-op）
 * @param {{ stateDir?: string, name?: string }} [config]
 * @returns {object} suggest service
 */
export function createSuggest(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'suggestions.jsonl')
  const snapPath = statePath(stateDir, 'suggestions.snap.json')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} 建议 id → Suggestion（插入序 = 创建序） */
  const suggestions = new Map()
  /** @type {object[]} 全部事件（审计流，按落盘顺序；apply 失败也在这里留证） */
  const events = []

  let disposed = false
  /** accept 正在执行 apply 的 id 集合（防 apply 回调里再次 accept 同一条 → 重复入库）。 */
  const deciding = new Set()

  const diagnostics = {
    stateDir,
    jsonlPath,
    snapPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: /** @type {null|'jsonl'|'snapshot'|'empty'} */ (null),
    replayedEvents: 0,
    badLines: 0,
    snapshotWriteFailures: 0,
    duplicatesReturned: 0,
    lastReplayAt: /** @type {number|undefined} */ (undefined),
  }

  /** 已销毁实例的调用一律抛错：静默返回空队列比崩掉更难查（「建议都没了？」）。 */
  function assertAlive(where) {
    if (disposed) {
      throw new SuggestError(
        `suggest.${where}：实例已 dispose()，请重新 createSuggest()（拒绝在已销毁实例上静默返回空数据）`,
        'SUGGEST_DISPOSED',
        { where },
      )
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 快照内容（落盘形态）。 */
  const snapshot = () => ({
    version: 1,
    savedAt: Date.now(),
    suggestions: [...suggestions.values()],
  })

  /**
   * 提交一次变更：**先落事件，再改内存，最后写快照**。
   * 顺序不可颠倒：append 失败时内存必须原封不动，否则内存与磁盘分叉，
   * 重启回放后「已采纳」凭空变回「待确认」，属于最恶劣的静默失败。
   *
   * @param {string} action add | accept | reject | apply_failed
   * @param {number} at
   * @param {string|null} by
   * @param {object|null} before 变更前（add 为 null）
   * @param {object} after 变更后
   * @param {object|null} [extra] 额外事件字段（目前只有 accept 用：`{ applyResult }` 入库证据）
   * @returns {object} 克隆后的 after
   */
  function commit(action, at, by, before, after, extra = null) {
    const event = {
      id: after.id,
      rev: after.rev,
      action,
      by: by ?? null,
      at,
      before: before ? clone(before) : null,
      after: clone(after),
      ...(extra && typeof extra === 'object' ? clone(extra) : {}),
    }
    if (!appendJsonl(jsonlPath, event)) {
      throw new SuggestError(
        `suggest.${action}：事件追加失败（${jsonlPath}）—— 拒绝「只改内存不落盘」`,
        'SUGGEST_APPEND_FAILED',
        { id: after.id, action },
      )
    }
    suggestions.set(after.id, clone(after))
    events.push(event)
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/suggest] 快照写入失败（${snapPath}）—— 事件流已落盘，replay() 可完整恢复`)
    }
    return clone(after)
  }

  /**
   * 从 `suggestions.jsonl`（真相源）重建内存态；jsonl 为空才回落到快照。
   * 坏行**不静默丢弃**：计入 diagnostics 并 warn（撕裂写必须被人看见）。
   */
  function hydrate() {
    suggestions.clear()
    events.length = 0

    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) {
      warn(`[cs-bots/suggest] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }

    if (rows.length === 0) {
      const snap = readJson(snapPath, null)
      const saved = Array.isArray(snap?.suggestions) ? snap.suggestions : null
      if (saved) {
        for (const raw of saved) {
          if (!raw || typeof raw.id !== 'string' || !STATUSES.includes(raw.status)) continue
          suggestions.set(raw.id, clone(raw))
        }
        diagnostics.hydratedFrom = 'snapshot'
        info(`[cs-bots/suggest] 回放完成：无事件流 → 由快照恢复 ${suggestions.size} 条建议`)
        return
      }
      diagnostics.hydratedFrom = 'empty'
      info('[cs-bots/suggest] 回放完成：空队列（无事件流、无快照）')
      return
    }

    // 事件流是真相源：只接受 rev 递增的事件（同 rev 重放幂等，容忍重复投递）
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.id !== 'string' || !ev.after || typeof ev.after.id !== 'string') {
        skipped += 1
        continue
      }
      const before = suggestions.get(ev.id)
      if (before && Number.isFinite(ev.rev) && ev.rev <= before.rev) {
        skipped += 1
        continue
      }
      suggestions.set(ev.id, clone(ev.after))
      events.push(clone(ev))
    }
    if (skipped > 0) {
      warn(`[cs-bots/suggest] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }
    diagnostics.hydratedFrom = 'jsonl'
    info(`[cs-bots/suggest] 回放完成：${rows.length} 条事件 → ${suggestions.size} 条建议`)
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  /** 取值或抛 `SUGGEST_NOT_FOUND`（绝不返回 undefined 让上层猜）。 */
  function requireSuggestion(id, where) {
    const found = suggestions.get(id)
    if (!found) {
      throw new SuggestError(
        `suggest.${where}：建议 [id:${id}] 不存在`,
        'SUGGEST_NOT_FOUND',
        { where, id },
      )
    }
    return clone(found)
  }

  /**
   * 列建议。缺省只列 `pending`（UI 红点/待办箱视角；已决的建议要显式要）。
   * 排序：`confidence` 降序 → `createdAt` 降序 → id 升序（最后一条只为**确定性**：
   * 相同置信度与时间戳时顺序不能随 Map 插入序漂移，否则测试与 UI 都会闪）。
   *
   * @param {{ kind?: string, status?: string, limit?: number, minConfidence?: number }} [query]
   * @returns {object[]}
   */
  function listSuggestions(query = {}) {
    assertAlive('listSuggestions')
    const { kind, status, limit, minConfidence } = query ?? {}
    let wantStatus = 'pending'
    if (status !== undefined && status !== null) {
      if (status === 'all') wantStatus = 'all'
      else if (STATUSES.includes(status)) wantStatus = status
      else {
        throw new SuggestError(
          `suggest.listSuggestions：status=${JSON.stringify(status)} 非法（合法：pending | accepted | rejected | all）`,
          'SUGGEST_BAD_FIELD',
          { field: 'status' },
        )
      }
    }
    if (kind !== undefined && kind !== null && !KINDS.includes(kind)) {
      throw new SuggestError(
        `suggest.listSuggestions：kind=${JSON.stringify(kind)} 非法（合法：${KINDS.join(' | ')}）`,
        'SUGGEST_BAD_FIELD',
        { field: 'kind' },
      )
    }
    let limitNumber = 0
    if (limit !== undefined && limit !== null) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new SuggestError(
          `suggest.listSuggestions：limit 必须是非负整数，收到 ${JSON.stringify(limit)}`,
          'SUGGEST_BAD_FIELD',
          { field: 'limit' },
        )
      }
      limitNumber = limit
    }
    let min = 0
    if (minConfidence !== undefined && minConfidence !== null) {
      if (typeof minConfidence !== 'number' || !Number.isFinite(minConfidence)
        || minConfidence < 0 || minConfidence > 1) {
        throw new SuggestError(
          `suggest.listSuggestions：minConfidence 必须是 0..1 的数字，收到 ${JSON.stringify(minConfidence)}`,
          'SUGGEST_BAD_FIELD',
          { field: 'minConfidence' },
        )
      }
      min = minConfidence
    }

    const rows = [...suggestions.values()].filter((s) => {
      if (wantStatus !== 'all' && s.status !== wantStatus) return false
      if (kind !== undefined && kind !== null && s.kind !== kind) return false
      if (s.confidence < min) return false
      return true
    })
    rows.sort((a, b) => (
      (b.confidence - a.confidence)
      || (b.createdAt - a.createdAt)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    ))
    return clone(limitNumber > 0 ? rows.slice(0, limitNumber) : rows)
  }

  /**
   * 取单条建议。
   * @param {string} id
   * @returns {object}
   */
  function getSuggestion(id) {
    assertAlive('getSuggestion')
    const suggestionId = requireString(id, 'id', 'getSuggestion')
    return requireSuggestion(suggestionId, 'getSuggestion')
  }

  // ── 写：提建议 ─────────────────────────────────────────────────────────────

  /**
   * 提一条建议（**不写领域库**，只落自己的队列）。
   *
   * @param {{ kind: string, layer?: string|null, payload: object, reason: string,
   *           source?: string, confidence?: number, by: string, now?: number }} input
   * @returns {object} Suggestion（重复时 `duplicate:true`，仍是已有那条）
   */
  function suggest(input = {}) {
    assertAlive('suggest')
    const { kind, layer, payload, reason, source, confidence, by, now } = input ?? {}
    const at = normalizeNow(now, 'suggest')
    const author = requireString(by, 'by', 'suggest')

    if (!KINDS.includes(kind)) {
      throw new SuggestError(
        `suggest.suggest：kind=${JSON.stringify(kind)} 非法（合法：${KINDS.join(' | ')}）`,
        'SUGGEST_BAD_KIND',
        { kind },
      )
    }

    // layer 只在 memory 建议上出现：其他类型带 layer 是调用方串味，必须拒（不静默忽略）。
    let targetLayer = null
    if (kind === 'memory') {
      targetLayer = requireString(layer, 'layer', 'suggest', 'SUGGEST_BAD_LAYER')
      if (!MEMORY_LAYERS.includes(targetLayer)) {
        throw new SuggestError(
          `suggest.suggest：layer=${JSON.stringify(targetLayer)} 非法（合法：${MEMORY_LAYERS.join(' | ')}；`
          + 'L0 人格由人专写，程序不得建议）',
          'SUGGEST_BAD_LAYER',
          { kind, layer: targetLayer, allowed: MEMORY_LAYERS },
        )
      }
    } else if (layer !== undefined && layer !== null) {
      throw new SuggestError(
        `suggest.suggest：kind=${kind} 不应带 layer（layer 只用于 memory 建议的目标层）`,
        'SUGGEST_BAD_FIELD',
        { kind, field: 'layer' },
      )
    }

    const normalizedPayload = normalizePayload(kind, payload, 'suggest', targetLayer)
    const why = assertMaxLength(
      requireString(reason, 'reason', 'suggest', 'SUGGEST_MISSING_REASON'),
      LIMITS.reason,
      'reason',
      'suggest',
    )
    const from = source === undefined || source === null
      ? 'model'
      : requireString(source, 'source', 'suggest')
    if (!SOURCES.includes(from)) {
      throw new SuggestError(
        `suggest.suggest：source=${JSON.stringify(from)} 非法（合法：${SOURCES.join(' | ')}）`,
        'SUGGEST_BAD_SOURCE',
        { source: from, allowed: SOURCES },
      )
    }
    let score = 0.5
    if (confidence !== undefined && confidence !== null) {
      if (typeof confidence !== 'number' || !Number.isFinite(confidence)
        || confidence < 0 || confidence > 1) {
        throw new SuggestError(
          `suggest.suggest：confidence 必须是 0..1 的数字，收到 ${JSON.stringify(confidence)}`,
          'SUGGEST_BAD_CONFIDENCE',
          { confidence },
        )
      }
      score = confidence
    }

    // ── 去重（只比 pending；口径见文件头）──
    const key = dedupKeyOf(kind, targetLayer, normalizedPayload)
    for (const existing of suggestions.values()) {
      if (existing.status !== 'pending') continue
      if (dedupKeyOf(existing.kind, existing.layer, existing.payload) !== key) continue
      diagnostics.duplicatesReturned += 1
      info(`[cs-bots/suggest] 重复建议命中 ${existing.id}（${kind}）→ 返回已有那条，不新增`)
      const dup = clone(existing)
      dup.duplicate = true
      return dup
    }

    const id = newId(suggestions)
    /** @type {Record<string, unknown>} */
    const entry = {
      id,
      rev: 1,
      kind,
      status: 'pending',
      layer: targetLayer,
      payload: normalizedPayload,
      reason: why,
      source: from,
      confidence: score,
      createdAt: at,
      createdBy: author,
      updatedAt: at,
      updatedBy: author,
      decidedAt: null,
      decidedBy: null,
    }
    const created = commit('add', at, author, null, entry)
    info(`[cs-bots/suggest] 新建议 ${id}（${kind}${targetLayer ? `/${targetLayer}` : ''}）来自 ${from}`)

    // 返回时也带 duplicate:false，让调用方**永远**能读同一字段而不是靠「有没有这个键」判断。
    const out = clone(created)
    out.duplicate = false
    return out
  }

  /** 生成 `sg-xxxxxxxx` 形式的 id（8 位十六进制，碰撞则重试；耗尽属于极不可能，也抛错不静默）。 */
  function newId(taken) {
    for (let i = 0; i < 8; i += 1) {
      const id = `sg-${randomBytes(4).toString('hex')}`
      if (!taken.has(id)) return id
    }
    throw new SuggestError(
      'suggest.suggest：连续 8 次生成 id 均碰撞 —— 建议队列状态异常，拒绝静默覆盖',
      'SUGGEST_ID_EXHAUSTED',
    )
  }

  // ── 写：人确认 ─────────────────────────────────────────────────────────────

  /** 共用的 CAS/状态闸门（accept 与 reject 都要过）。 */
  function assertDecidable(current, expectedRev, where) {
    if (expectedRev !== undefined && expectedRev !== null) {
      if (!Number.isInteger(expectedRev)) {
        throw new SuggestError(
          `suggest.${where}：expectedRev 必须是整数（CAS 需要显式期望版本；当前 rev=${current.rev}，`
          + `收到 ${JSON.stringify(expectedRev)}）`,
          'SUGGEST_BAD_FIELD',
          { where, field: 'expectedRev', id: current.id, rev: current.rev },
        )
      }
      if (current.rev !== expectedRev) {
        throw new SuggestError(
          `suggest.${where} CAS 冲突：建议 [id:${current.id}] 期望 rev=${expectedRev}，实际 rev=${current.rev} —— `
          + '拒绝静默覆盖，请重新 getSuggestion() 后按最新 rev 重试',
          'SUGGEST_CAS_CONFLICT',
          { where, id: current.id, expectedRev, rev: current.rev },
        )
      }
    }
    if (current.status !== 'pending') {
      throw new SuggestError(
        `suggest.${where}：建议 [id:${current.id}] 当前状态是 ${current.status}，`
        + '只有 pending 才能裁决（已裁决的建议不允许再审一次 —— 否则可能重复入库）',
        'SUGGEST_BAD_STATE',
        { where, id: current.id, status: current.status, expected: 'pending' },
      )
    }
  }

  /**
   * 采纳一条建议：**先等 `apply` 真正入库，成功后才标 accepted**。
   *
   * 为什么必须由调用方注入 `apply`（而不是本模块自己写）：见文件头「不 import memory/library」。
   *
   * `apply` 允许同步也允许异步（api 层的 applySuggestion 是 async：memory/library 的写入
   * 可能跨异步边界），因此本函数内部**一律 await**，返回 Promise —— **调用方必须 await**。
   * 不 await 就等于不等结果，失败会被吞成 unhandled rejection（那是最坏的静默失败）。
   *
   * 失败语义（**这条绝不能改**）：
   *   - `apply` 抛错/拒绝 → 该条保持 `pending`、错误文本写入 `lastError`（落盘，可审计）、
   *     并把错误**抛给调用方**。绝不出现「界面说已采纳、库里啥也没有」。
   *   - 同一条建议**不允许重复采纳**：`status !== 'pending'` 直接抛 SUGGEST_BAD_STATE；
   *     apply 执行期间再次 accept 同一条 → SUGGEST_BUSY（防 apply 回调递归触发重复入库）。
   *
   * @param {{ id: string, by: string, now?: number, expectedRev?: number,
   *           apply: (suggestion: object) => any }} input
   * @returns {Promise<object>} 采纳后的 Suggestion（附加 `applyResult` = 入库证据）
   */
  async function accept(input = {}) {
    assertAlive('accept')
    const { id, by, now, expectedRev, apply } = input ?? {}
    const suggestionId = requireString(id, 'id', 'accept')
    const author = requireString(by, 'by', 'accept')
    const at = normalizeNow(now, 'accept')
    const current = requireSuggestion(suggestionId, 'accept')

    if (typeof apply !== 'function') {
      throw new SuggestError(
        `suggest.accept：缺少 apply 回调 —— 采纳必须真正入库。`
        + '「只把状态改成 accepted 而不写库」等于假采纳，是最坏的静默失败，故拒绝',
        'SUGGEST_NO_APPLY',
        { id: suggestionId },
      )
    }

    assertDecidable(current, expectedRev, 'accept')

    if (deciding.has(suggestionId)) {
      throw new SuggestError(
        `suggest.accept：建议 [id:${suggestionId}] 正在 apply 中（apply 回调里不要再次 accept 同一条）—— `
        + '否则同一个入库动作会执行两次',
        'SUGGEST_BUSY',
        { id: suggestionId },
      )
    }

    deciding.add(suggestionId)
    let result
    try {
      // **必定 await**：同步回调直接拿到值，异步回调等它真正落地。
      // 这里的 await 也是「防重复采纳」的窗口期 —— deciding 守卫在 await 期间有效。
      result = await apply(clone(current))
    } catch (error) {
      // apply 期间实例被销毁：内存态已清空，不能再写盘，但必须把「副作用可能已发生」说清楚
      if (disposed) {
        throw new SuggestError(
          `suggest.accept：实例在 apply 期间被 dispose() —— 建议 [id:${suggestionId}] 状态未写入；`
          + 'apply 可能已产生副作用，请人工核对',
          'SUGGEST_DISPOSED',
          { id: suggestionId },
        )
      }
      const live = suggestions.get(suggestionId)
      if (!live || live.rev !== current.rev) {
        // apply 期间状态被改动：既不能标 accepted，也不该用旧 rev 写失败事件（会覆盖别人的决定）
        throw new SuggestError(
          `suggest.accept：建议 [id:${suggestionId}] 在 apply 期间状态被并发改动（rev 已变）—— `
          + '保持原状不写盘，请重新 getSuggestion() 核对（本次 apply 可能已产生副作用，需人工确认）',
          'SUGGEST_CAS_CONFLICT',
          { id: suggestionId, rev: current.rev, liveRev: live?.rev ?? null },
        )
      }
      const before = clone(current)
      const after = clone(current)
      after.rev = current.rev + 1
      after.lastError = errorText(error)
      after.lastErrorCode = (error && typeof error === 'object' && typeof error.code === 'string')
        ? error.code
        : 'SUGGEST_APPLY_THREW'
      after.lastErrorAt = at
      after.updatedAt = at
      after.updatedBy = author
      commit('apply_failed', at, author, before, after)
      const wrapped = new SuggestError(
        `suggest.accept：采纳建议 [id:${suggestionId}] 时 apply 失败 → 该条**保持 pending**，`
        + `错误已记入 lastError：${errorText(error)}`,
        'SUGGEST_APPLY_FAILED',
        { id: suggestionId, kind: current.kind, errorCode: after.lastErrorCode },
      )
      wrapped.cause = error
      throw wrapped
    } finally {
      deciding.delete(suggestionId)
    }

    if (disposed) {
      throw new SuggestError(
        `suggest.accept：实例在 apply 期间被 dispose() —— 建议 [id:${suggestionId}] 状态未写入；`
        + 'apply 可能已产生副作用，请人工核对',
        'SUGGEST_DISPOSED',
        { id: suggestionId },
      )
    }

    // apply 成功 → 再检查一次 rev（apply 回调理论上可能改同一条建议）。
    const live = suggestions.get(suggestionId)
    if (!live || live.rev !== current.rev) {
      throw new SuggestError(
        `suggest.accept：apply 已执行，但建议 [id:${suggestionId}] 在 apply 期间被改动（rev 已变）—— `
        + '本次入库已发生，请人工核对后决定是否回滚/保留（拒绝把状态覆盖成 accepted 掩盖问题）',
        'SUGGEST_CAS_CONFLICT',
        { id: suggestionId, rev: current.rev, liveRev: live?.rev ?? null },
      )
    }

    const before = clone(current)
    const after = clone(current)
    after.rev = current.rev + 1
    after.status = 'accepted'
    after.decidedAt = at
    after.decidedBy = author
    after.updatedAt = at
    after.updatedBy = author
    // 采纳成功后清 lastError：失败痕迹保留在事件流（audit），记录本身保持干净，
    // 免得 UI 上一条已成功的建议还挂着「上次失败」的红字。
    delete after.lastError
    delete after.lastErrorCode
    delete after.lastErrorAt
    const evidence = safeResult(result)
    const decided = commit('accept', at, author, before, after, { applyResult: evidence })
    info(`[cs-bots/suggest] 采纳建议 ${suggestionId}（${current.kind}）by ${author}`)
    // 返回**建议本身**（而不是 `{suggestion,result}` 包一层）：api 层直接把它塞进
    // `{ ok:true, suggestion: ... }` 回给页面，UI 不用多拆一层；入库证据放 `applyResult`。
    const out = clone(decided)
    out.applyResult = evidence
    return out
  }

  /**
   * 拒绝一条建议（**必须给原因**：没有原因，三个月后没人知道为什么否掉）。
   * @param {{ id: string, reason: string, by: string, now?: number, expectedRev?: number }} input
   * @returns {object} 拒绝后的 Suggestion
   */
  function reject(input = {}) {
    assertAlive('reject')
    const { id, reason, by, now, expectedRev } = input ?? {}
    const suggestionId = requireString(id, 'id', 'reject')
    const author = requireString(by, 'by', 'reject')
    const at = normalizeNow(now, 'reject')
    const current = requireSuggestion(suggestionId, 'reject')
    assertDecidable(current, expectedRev, 'reject')
    const why = assertMaxLength(
      requireString(reason, 'reason', 'reject', 'SUGGEST_MISSING_REASON'),
      LIMITS.reason,
      'reason',
      'reject',
    )

    const before = clone(current)
    const after = clone(current)
    after.rev = current.rev + 1
    after.status = 'rejected'
    after.decidedAt = at
    after.decidedBy = author
    after.rejectReason = why
    after.updatedAt = at
    after.updatedBy = author
    delete after.lastError
    delete after.lastErrorCode
    delete after.lastErrorAt
    const decided = commit('reject', at, author, before, after)
    info(`[cs-bots/suggest] 拒绝建议 ${suggestionId} by ${author}：${why}`)
    return decided
  }

  /**
   * 修改一条**待决**建议：内容 / 等级（layer）/ 标题标签都可以改（2026-11-12 t-40）。
   *
   * Boss 原话：「自动整理建议中，用户只能接纳和驳回，等级没办法选择、内容没办法修改，
   * 用户应该可以修改完善并确定等级范围」
   *
   * 为什么必须有这个口子：模型归纳出来的文字几乎总是「意思是对的、措辞不是我的」。
   * 只给「采纳/驳回」两个按钮，用户遇到措辞不合意的建议只能驳回再等它重新提一遍 ——
   * 而驳回会让同类建议进冷却，等于把「差一点就对」的东西越推越远。
   *
   * 语义边界：
   *   - **只能改 pending**：已采纳/已驳回是终态，改它等于篡改历史（要提新的就 propose）。
   *   - **改完仍是 pending**：编辑不等于采纳，用户改完可以再想想。
   *   - **等级仍走同一套白名单**：`layer` 只能是 MEMORY_LAYERS（L0 仍不可写）。
   *   - **改类型（kind）时 payload 必须一起给**：记忆与技能的 payload 形状不同。
   *   - **必须 CAS**：`expectedRev` 必填，防两人同时改互相覆盖。
   *   - **审计留痕**：写 `edit` 事件，before/after 都在事件流里可查。
   *
   * @param {{ id: string, expectedRev: number, payload?: object, kind?: string,
   *           layer?: string, title?: string, content?: string, by: string, now?: number }} input
   * @returns {object} 修改后的建议（rev 已 +1）
   */
  function edit(input = {}) {
    assertAlive('edit')
    const { id, expectedRev, kind, title, content, by, now } = input ?? {}
    let { payload } = input ?? {}
    const suggestionId = requireString(id, 'id', 'edit')
    const author = requireString(by, 'by', 'edit')
    const at = normalizeNow(now, 'edit')
    const current = requireSuggestion(suggestionId, 'edit')

    if (current.status !== 'pending') {
      throw new SuggestError(
        `suggest.edit：建议 [id:${suggestionId}] 已是 ${current.status}（终态不可改）—— `
        + '要改请重新提一条（propose）',
        'SUGGEST_NOT_PENDING',
        { id: suggestionId, status: current.status },
      )
    }
    const rev = Number(expectedRev)
    if (!Number.isFinite(rev)) {
      throw new SuggestError(
        'suggest.edit：expectedRev 必填（修改是覆盖性操作，必须带版本做 CAS）',
        'SUGGEST_BAD_FIELD',
        { id: suggestionId, field: 'expectedRev' },
      )
    }
    if (rev !== current.rev) {
      throw new SuggestError(
        `suggest.edit：CAS 冲突（期望 rev=${rev}，实际 rev=${current.rev}）—— 有人先改过了，请刷新后重试`,
        'SUGGEST_REV_CONFLICT',
        { id: suggestionId, expectedRev: rev, actualRev: current.rev },
      )
    }

    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1

    const nextKind = kind === undefined || kind === null ? current.kind : requireString(kind, 'kind', 'edit')
    if (!KINDS.includes(nextKind)) {
      throw new SuggestError(
        `suggest.edit：kind 只能是 ${KINDS.join(' | ')}，收到 ${JSON.stringify(nextKind)}`,
        'SUGGEST_BAD_KIND',
        { id: suggestionId, kind: nextKind },
      )
    }
    if (nextKind !== current.kind && payload === undefined) {
      throw new SuggestError(
        `suggest.edit：改 kind（${current.kind} → ${nextKind}）必须同时给 payload —— `
        + '记忆与技能的 payload 形状不同，只换类型会留下形状不匹配的脏数据',
        'SUGGEST_KIND_REQUIRES_PAYLOAD',
        { id: suggestionId, from: current.kind, to: nextKind },
      )
    }

    if (payload === undefined && (title !== undefined || content !== undefined)) {
      payload = { ...(current.payload ?? {}) }
      if (title !== undefined) payload.title = title
      if (content !== undefined) payload.content = content
    }

    if (payload !== undefined) {
      const targetLayerForPayload = payload.layer ?? current.payload?.layer ?? null
      next.payload = normalizePayload(nextKind, payload, 'edit', targetLayerForPayload)
    }
    next.kind = nextKind

    if (input.layer !== undefined && input.layer !== null && input.layer !== '') {
      if (!MEMORY_LAYERS.includes(input.layer)) {
        throw new SuggestError(
          `suggest.edit：layer 只能是 ${MEMORY_LAYERS.join(' | ')}（L0 人格仅人可写，不在此列），`
          + `收到 ${JSON.stringify(input.layer)}`,
          'SUGGEST_BAD_LAYER',
          { id: suggestionId, layer: input.layer },
        )
      }
      next.payload = { ...(next.payload ?? {}), layer: input.layer }
    }

    next.updatedAt = at
    next.updatedBy = author
    next.editedAt = at
    next.editedBy = author
    next.editCount = (Number(current.editCount) || 0) + 1

    return commit('edit', at, author, before, next)
  }

  /**
   * 批量采纳：**部分失败不中断**（人点「全部采纳」时，一条撞错不该让其余全不处理），
   * 但失败必须逐条回报（`failed[]` 带 code + reason），绝不吞掉。
   *
   * 顺序执行（不并发）：apply 回调可能是异步写库，并发会让「同一条被两条路径同时写」
   * 的排查变得很困难；队列通常只有个位数条目，顺序执行的性能代价可以忽略。
   *
   * @param {{ ids: string[], by: string, now?: number, apply: (suggestion: object) => any }} input
   * @returns {Promise<{ accepted: object[], failed: object[], deduped: number }>}
   *   `accepted[]` 是采纳后的建议（带 `applyResult`）；`failed[]` 是 `{ id, code, reason }`。
   */
  async function bulkAccept(input = {}) {
    assertAlive('bulkAccept')
    const { ids, by, now, apply } = input ?? {}
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new SuggestError(
        `suggest.bulkAccept：ids 必须是非空数组，收到 ${JSON.stringify(ids)}`,
        'SUGGEST_BAD_FIELD',
        { field: 'ids' },
      )
    }
    // apply 先整体校验一次：否则每条都会以 SUGGEST_NO_APPLY 失败，噪音掩盖真问题。
    if (typeof apply !== 'function') {
      throw new SuggestError(
        'suggest.bulkAccept：缺少 apply 回调 —— 批量采纳同样必须真正入库（见 accept 的说明）',
        'SUGGEST_NO_APPLY',
        { count: ids.length },
      )
    }
    // 去重（同一 id 传两次 → 第二次必然 BAD_STATE；先去重，并把去重条数回报，不静默）
    const unique = []
    const seen = new Set()
    for (const raw of ids) {
      const id = requireString(raw, 'ids[]', 'bulkAccept')
      if (seen.has(id)) continue
      seen.add(id)
      unique.push(id)
    }

    const accepted = []
    const failed = []
    for (const id of unique) {
      try {
        accepted.push(await accept({ id, by, now, apply }))
      } catch (error) {
        failed.push({
          id,
          code: (error && typeof error.code === 'string') ? error.code : 'SUGGEST_ERROR',
          reason: errorText(error),
        })
      }
    }
    if (failed.length > 0) {
      warn(`[cs-bots/suggest] bulkAccept：${accepted.length} 条成功 / ${failed.length} 条失败（失败原因已随返回值回报）`)
    }
    info(`[cs-bots/suggest] bulkAccept：采纳 ${accepted.length} 条（去重 ${ids.length - unique.length} 条）`)
    return { accepted, failed, deduped: ids.length - unique.length }
  }

  // ── 审计 / 恢复 / 统计 ─────────────────────────────────────────────────────

  /**
   * 事件历史（审计流）。`history(id)` 只取某一建议的事件。
   * @param {string} [id]
   * @returns {object[]}
   */
  function history(id) {
    assertAlive('history')
    const rows = typeof id === 'string' && id !== ''
      ? events.filter((e) => e.id === id)
      : events
    return clone(rows)
  }

  /**
   * 统计（给 /status 与 UI 概览用）。
   * @returns {{ total: number, pending: number, accepted: number, rejected: number,
   *             byKind: object, bySource: object, events: number }}
   */
  function stats() {
    assertAlive('stats')
    const byKind = { memory: 0, skill: 0, discipline: 0 }
    const bySource = { review: 0, consolidate: 0, model: 0 }
    let pending = 0
    let accepted = 0
    let rejected = 0
    for (const s of suggestions.values()) {
      byKind[s.kind] = (byKind[s.kind] ?? 0) + 1
      bySource[s.source] = (bySource[s.source] ?? 0) + 1
      if (s.status === 'pending') pending += 1
      else if (s.status === 'accepted') accepted += 1
      else if (s.status === 'rejected') rejected += 1
    }
    return {
      total: suggestions.size,
      pending,
      accepted,
      rejected,
      byKind,
      bySource,
      events: events.length,
    }
  }

  /**
   * 从 `suggestions.jsonl` 重建内存态（重启回放一致性）。
   * @returns {{ from: string, suggestions: number, events: number, bad: number }}
   */
  function replay() {
    assertAlive('replay')
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      suggestions: suggestions.size,
      events: events.length,
      bad: diagnostics.badLines,
    }
  }

  /**
   * 销毁实例（释放内存、拒绝后续调用）。
   * 为什么不写盘/不删文件：事件流是长期资产（「谁在什么时候建议了什么、谁采纳的」），
   * dispose 只是「这个实例下班了」，不等于删数据。
   * @returns {{ disposed: boolean, suggestions: number, events: number }}
   */
  function dispose() {
    const out = { disposed: true, suggestions: suggestions.size, events: events.length }
    disposed = true
    suggestions.clear()
    events.length = 0
    deciding.clear()
    return out
  }

  /** 首次构造即回放，保证 `listSuggestions()` 在重启后马上可用（否则每次重启红点清零）。 */
  hydrate()

  const service = {
    name: cfg.name ?? 'suggest',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    // 契约函数名（任务书/API 层按这些名字调）
    suggest,
    listSuggestions,
    getSuggestion,
    accept,
    reject,
    edit,
    bulkAccept,
    stats,
    replay,
    history,
    dispose,
    // 短别名：api 层若按 board 的 create/get/list 风格调用也能直接走
    list: listSuggestions,
    get: getSuggestion,
    diagnostics: () => clone(diagnostics),
  }
  return service
}

export default createSuggest
