/**
 * cs-bots BoardService —— 跨会话任务板。
 *
 * 设计依据：`multiagent/10-初步架构设计方案-v1.md` §3.3（BoardService）。
 * 相对官方任务板的三个增量（官方**完全没有**，是我方的核心价值）：
 *   1. `lease` + 心跳 + `expireLeases()` —— 官方 owner 在 interrupt/崩溃后
 *      **永不释放**，任务永久挂着一个已死成员；本模块用租约到期自动回收封死这个硬伤。
 *   2. `priority` / `dueAt` —— 官方 schema 只有 `blockedBy/writeScopes`，无排期能力。
 *   3. `acceptance` —— 官方 `complete` 由 owner 自己完成，没有「验收/驳回」这个动作。
 *
 * ── 本文件新增的字段（在 §3.3 的 Task 形状之外，纯增量，不改动既有字段语义）──
 *   `artifacts`    —— `complete` 的产出物证据（§3.3 要求 complete 必须带 artifacts，
 *                     但未规定落点；落在 Task 上便于查询，事件流里也有一份）。
 *   `createdAt` / `createdBy` / `completedAt` —— 便于 `list()` 消费方直接展示。
 *   `blockedReason` —— `block({ note })` 时记录阻塞原因。
 *   `expectedComplexity` / `requiresPaid` —— **复杂度路由标签**（契约 §6）：规划 Agent
 *     拆解时显式给出该子任务的复杂度档位（T0–T3）与「是否值得付费」的诉求；
 *     子任务被 claim/wake 时平台据此给 owner 会话写 hint（见 `src/routing/hints.js`）。
 *     两者都是**可选字段**：缺省 ⇒ 平台按 `free_only` 处理（fail-closed，省成本）。
 *
 * ── 三条不变量（全模块机械保证）──
 *   1. **CAS 优先**：任何变更都要带 `expectedRev`；不匹配即抛错，绝不静默覆盖。
 *   2. **事件流是真相源**：先 append `board.jsonl`（失败即抛错，不动内存），
 *      再更新内存，最后原子写 `board.snap.json`（快照失败只降级 warn——
 *      因为事件流已落盘，`replay()` 能完整重建）。
 *   3. **生命周期只走 action**：`subject/description/blockedBy/writeScopes/priority/dueAt`
 *      走字段补丁；`status` **不允许**直接补丁（否则 `complete` 的 artifacts
 *      校验会被绕过）。改状态请用 claim/release/heartbeat/complete/reopen/block/delete。
 *
 * ── 为什么 kernel.js 是「动态导入」而不是静态 import（重要，勿改成静态）──
 *   `kernel.js` 静态 import 了宿主包（DSH 提供，只在 DSH profile 内可解析）。
 *   本仓库是**裸检出**（无 node_modules），静态 import 会让 board.js 连带
 *   kernel.js 一并加载失败 → `test/board.test.mjs` 根本起不来。
 *   故此处用顶层 `await import()` 并在失败时记下原因：
 *     - 拿得到 kernel → `config.stateDir` 缺省走 `kernel.stateDir()`
 *     - 拿不到 kernel 且调用方也没给 `config.stateDir` → **抛可读错误**（不静默兜底）
 *   零依赖 CI（`test/ci-zero-dep.sh` 检查 1）依然成立：这里引用的只是 `./kernel.js`，
 *   满足「除 kernel.js 外不得出现宿主包真实引用」这条纪律。
 *
 * 依赖面：node 内置 + `./store.js` + `./kernel.js`。**不 import 任何宿主包**。
 */

import {
  appendJsonl,
  readJson,
  readJsonl,
  statePath,
  writeJsonAtomic,
  IdempotencySet,
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

// ── store.appendAudit 软导入（P0-B §5）──────────────────────────────────────
// 另一位工程师正在 store.js 加 appendAudit（与 board.js 并行）。我们必须**软用**：
// 拿不到就只 warn 一次并计入 diagnostics，绝不阻断主流程，也绝不自己另造审计格式。
// 用顶层 await 一次性判定（board.js 已经是 ESM + 顶层 await 的写法，见 kernel 桥），
// 这样 commit() 里是同步判定，diagnostics 计数不会因异步竞态而不确定。
let storeAppendAudit = /** @type {null | ((dir: string, entry: object) => unknown)} */ (null)
let storeAuditMissing = false
try {
  const storeMod = await import('./store.js')
  if (typeof storeMod.appendAudit === 'function') storeAppendAudit = storeMod.appendAudit
  else storeAuditMissing = true
} catch {
  storeAuditMissing = true
}


// ── 常量 ────────────────────────────────────────────────────────────────────

/** `description` 上限（§3.3）。 */
const MAX_DESCRIPTION = 16384
/** 合法状态集合。 */
const STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'deleted']
/** 验收结果集合。 */
const ACCEPT_RESULTS = ['pass', 'reject']
/** 租约缺省 TTL（ms）。 */
const DEFAULT_LEASE_MS = 300_000
/** 复杂度档位（契约 §6 冻结；路由侧 `src/routing/complexity.js` 用同一套字面量）。 */
const COMPLEXITY_TIERS = ['T0', 'T1', 'T2', 'T3']
/**
 * 收尾结论集合 —— 借鉴 `dsh-superagent-prototype` 的 Report 枚举
 * （docs/001：`progress | waiting | ready | blocked | failed | dropped`）。
 *
 * 我们只保留**收尾时才有意义**的四档，且与自家 5 态机一一对应：
 *   - `ready`   —— 干完了，等人验收 ⇒ `complete` 默认值（status=completed）
 *   - `blocked` —— 卡住了，要人决策 ⇒ 必须走 `block`（status=blocked）
 *   - `failed`  —— 干不成（不是卡住，是失败）⇒ 必须走 `block`（同上，
 *                  用 `outcome:'failed'` 区分「不是等人解锁，是这条路走不通」）
 *   - `dropped` —— 结论是「不需要人做任何事」⇒ `complete` 可用（status=completed），
 *                  面板不把它计入「待你决定」
 *
 * **为什么不给 `complete` 开 `blocked`/`failed`**：我们的 `complete` 会置
 * `status='completed'`，而「卡住/失败」的任务不该出现在「待验收」里 —— 那会让人
 * 以为有东西可验收。宁可让它报错并指路 `block`，也不接受一个语义矛盾的收尾。
 */
const OUTCOMES = ['ready', 'blocked', 'failed', 'dropped']
/** `complete` 允许直接使用的收尾结论（其余必须走 `block`）。 */
const COMPLETE_OUTCOMES = ['ready', 'dropped']
/** `humanAction` 上限 —— 对齐 superagent 的 `human_action` ≤1000 字符（docs/003）。 */
const MAX_HUMAN_ACTION = 1000
/** 字段补丁允许改的字段（**不含 status**，见文件头不变量 3）。 */
const PATCH_FIELDS = [
  'subject', 'description', 'blockedBy', 'writeScopes', 'priority', 'dueAt',
  // 复杂度路由标注（2026-11-04 新增，契约 §6）—— 见文件头「路由标签」说明
  'expectedComplexity', 'requiresPaid',
  // 结构化收尾（2026-11-09 新增，借鉴 superagent 的 Report 枚举）：
  // `outcome`/`humanAction` 是**入参**（complete/block 时消费），落盘到
  // `latestReport`（`src/stage.js` 读的字段）。它们也允许出现在 `edit`/`set`
  // 的补丁里（比如执行中改口「我要你决定 X」），由 applyNewFields 统一落到
  // latestReport —— **不产生第二个顶层字段**。
  'outcome', 'humanAction',
  // P0-B 新增可选字段
  'labels', 'milestone', 'cycle', 'estimate', 'assignee', 'reviewer',
  'startedAt', 'completedAt', 'archivedAt', 'triaged', 'progress',
]
/** P0-B 新增可选字段（create/edit/set 三条入口共用同一套校验）。 */
const NEW_FIELD_NAMES = [
  'labels', 'milestone', 'cycle', 'estimate', 'assignee', 'reviewer',
  'startedAt', 'completedAt', 'archivedAt', 'triaged', 'progress',
  // 结构化收尾（2026-11-09）：与 PATCH_FIELDS 同步，否则 `set` 会拒这两个字段。
  // 落盘目标是 `latestReport`（stage.js 的唯一真相），不是顶层字段。
  'outcome', 'humanAction',
  // Mandate 授权留痕（2026-11-09，借鉴 superagent docs/001）：
  // `mandate.basis` 记「这条活的授权依据」—— explicit（人明确点名）/ inferred（规则推断）
  // / task-board（任务板派发）/ room（房间指令）；`mandate.sender` 记谁下的令；
  // `mandate.policyVersion` 记规则版本，供「改规则后追溯当时依据」用。
  'mandate',
]
/** 事件动作集合。 */
const ACTIONS = ['create', 'edit', 'claim', 'release', 'heartbeat', 'complete', 'reopen', 'block', 'unblock', 'set', 'delete', 'accept', 'lease_expired', 'triage']

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 任务板结构化错误。所有失败都走它，**绝不静默**。 */
export class BoardError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息（任务 id / rev / 字段名）
   * @param {string} [code]
   * @param {object} [details]
   */
  constructor(message, code = 'BOARD_ERROR', details) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/**
 * 深拷贝 + **JSON 归一**（去掉值为 undefined 的键）。
 * 必须走 JSON 而不是 structuredClone：否则内存态会比磁盘态多出
 * `{lease: undefined}` 这类键，导致 `replay()` 重建后的 `list()` 与原值不等。
 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 取 `t-<n>` 里的 n；非本格式返回 0。 */
function idNumber(id) {
  const m = /^t-(\d+)$/.exec(String(id ?? ''))
  return m ? Number(m[1]) : 0
}

/** 非空字符串字段校验。 */
function requireString(value, field, where) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BoardError(
      `board.${where}：字段 ${field} 缺失或类型错误（要求非空字符串，收到 ${JSON.stringify(value)}）`,
      'BOARD_MISSING_FIELD',
      { field, where },
    )
  }
  return value
}

/** 可选数字字段校验。 */
function optionalNumber(value, field, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BoardError(
      `board.${where}：字段 ${field} 类型错误（要求有限数字，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD',
      { field, where },
    )
  }
  return value
}

/** 字符串数组归一（去空、去重、保序）。 */
function stringList(value, field, where) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new BoardError(
      `board.${where}：字段 ${field} 类型错误（要求字符串数组，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD',
      { field, where },
    )
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new BoardError(
        `board.${where}：字段 ${field} 的元素必须是非空字符串，收到 ${JSON.stringify(item)}`,
        'BOARD_BAD_FIELD',
        { field, where },
      )
    }
    const v = item.trim()
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** 时间参数归一：缺省 now；支持 ms 数字与 Date。 */
function normalizeNow(value, where) {
  if (value === undefined || value === null) return Date.now()
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new BoardError(
    `board.${where}：now 必须是毫秒时间戳或 Date，收到 ${JSON.stringify(value)}`,
    'BOARD_BAD_NOW',
    { where },
  )
}

/** `description` 校验（≤16384）。 */
function normalizeDescription(value, where = 'create') {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new BoardError(
      `board.${where}：description 必须是字符串，收到 ${JSON.stringify(value)}`,
      'BOARD_BAD_FIELD',
      { field: 'description' },
    )
  }
  if (value.length > MAX_DESCRIPTION) {
    throw new BoardError(
      `board.${where}：description 超长（${value.length} > ${MAX_DESCRIPTION} 字符上限）——请把长正文落旁路文件，任务板只存摘要`,
      'BOARD_DESCRIPTION_TOO_LONG',
      { length: value.length, max: MAX_DESCRIPTION },
    )
  }
  return value
}

/**
 * `expectedComplexity` 归一：`T0`–`T3`（大小写不敏感）。
 *
 * 非法值**抛可读错误**、绝不悄悄改成默认档 —— 否则「这个子任务为什么走了免费渠道」
 * 就无从追溯（契约 §6 明确要求「非法值给可读错误码」）。`undefined/null` ⇒ 未标注。
 */
function normalizeComplexity(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new BoardError(
      `board.${where}：字段 expectedComplexity 类型错误（要求 ${COMPLEXITY_TIERS.join(' | ')} 字符串，`
      + `收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_COMPLEXITY',
      { field: 'expectedComplexity', where, accepted: [...COMPLEXITY_TIERS] },
    )
  }
  const v = value.trim().toUpperCase()
  if (!COMPLEXITY_TIERS.includes(v)) {
    throw new BoardError(
      `board.${where}：expectedComplexity=${JSON.stringify(value)} 非法（合法值：${COMPLEXITY_TIERS.join(' | ')}）`,
      'BOARD_BAD_COMPLEXITY',
      { field: 'expectedComplexity', where, value },
    )
  }
  return v
}

/** `requiresPaid` 归一：严格布尔（**不做字符串强转**，`'true'` 也算非法）。 */
function normalizeRequiresPaid(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new BoardError(
      `board.${where}：字段 requiresPaid 类型错误（要求 true|false 布尔，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD',
      { field: 'requiresPaid', where },
    )
  }
  return value
}

/** `complete` 的产出物证据归一：非空字符串或非空数组（元素为字符串/对象）。 */function normalizeArtifacts(value, taskId) {
  let list
  if (typeof value === 'string') list = [value]
  else if (Array.isArray(value)) list = value
  else {
    throw new BoardError(
      `board.update/complete：任务 ${taskId} 的 complete 必须带 artifacts（产出物证据），收到 ${JSON.stringify(value)}`,
      'BOARD_MISSING_ARTIFACTS',
      { id: taskId },
    )
  }
  const out = []
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim() === '') {
        throw new BoardError(
          `board.update/complete：任务 ${taskId} 的 artifacts 含空白字符串，非有效证据`,
          'BOARD_MISSING_ARTIFACTS',
          { id: taskId },
        )
      }
      out.push(item.trim())
    } else if (item && typeof item === 'object') {
      out.push(clone(item))
    } else {
      throw new BoardError(
        `board.update/complete：任务 ${taskId} 的 artifacts 元素必须是字符串或对象，收到 ${JSON.stringify(item)}`,
        'BOARD_BAD_FIELD',
        { id: taskId, field: 'artifacts' },
      )
    }
  }
  if (out.length === 0) {
    throw new BoardError(
      `board.update/complete：任务 ${taskId} 的 complete 必须带**非空** artifacts —— 拒绝无证据完成`,
      'BOARD_MISSING_ARTIFACTS',
      { id: taskId },
    )
  }
  return out
}

/** labels 归一：必须是字符串数组（可选；undefined ⇒ 不写字段）。 */
function normalizeLabels(value, where) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new BoardError(
      `board.${where}：字段 labels 类型错误（要求字符串数组，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD', { field: 'labels', where },
    )
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new BoardError(
        `board.${where}：labels 元素必须是字符串，收到 ${JSON.stringify(item)}`,
        'BOARD_BAD_FIELD', { field: 'labels', where },
      )
    }
    out.push(item)
  }
  return out
}

/** 可选字符串字段。 */
function normalizeOptionalString(value, field, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new BoardError(
      `board.${where}：字段 ${field} 类型错误（要求字符串，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD', { field, where },
    )
  }
  return value
}

/** estimate 归一：≥0 有限数。 */
function normalizeEstimate(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BoardError(
      `board.${where}：字段 estimate 类型错误（要求有限数字，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD', { field: 'estimate', where },
    )
  }
  if (value < 0) {
    throw new BoardError(
      `board.${where}：字段 estimate 必须 ≥ 0，收到 ${value}`,
      'BOARD_BAD_FIELD', { field: 'estimate', where },
    )
  }
  return value
}

/** progress 归一：0-100 有限数。 */
function normalizeProgress(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BoardError(
      `board.${where}：字段 progress 类型错误（要求有限数字，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD', { field: 'progress', where },
    )
  }
  if (value < 0 || value > 100) {
    throw new BoardError(
      `board.${where}：字段 progress 必须在 0-100 之间，收到 ${value}`,
      'BOARD_BAD_FIELD', { field: 'progress', where },
    )
  }
  return value
}

/** triaged 归一：严格布尔。 */
function normalizeTriaged(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new BoardError(
      `board.${where}：字段 triaged 类型错误（要求 boolean，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD', { field: 'triaged', where },
    )
  }
  return value
}

/**
 * 收尾结论归一：必须是 `OUTCOMES` 之一（借鉴 superagent Report 枚举）。
 *
 * 不在集合内 → 抛错，**不静默取默认**。理由：`outcome` 是 `stage.js` 派生
 * 「待验收/待你决定」的唯一依据，猜一个默认值会把「失败」显示成「待验收」，
 * 或反过来。宁可拒绝，也不接受语义错误的收尾。
 */
function normalizeOutcome(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new BoardError(
      `board.${where}：字段 outcome 类型错误（要求字符串，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD', { field: 'outcome', where },
    )
  }
  if (!OUTCOMES.includes(value)) {
    throw new BoardError(
      `board.${where}：outcome 必须是 ${OUTCOMES.join(' | ')}，收到 ${JSON.stringify(value)}`,
      'BOARD_BAD_FIELD', { field: 'outcome', where },
    )
  }
  return value
}

/**
 * `humanAction` 归一：**一句话、必填于需要人决策时、≤ `MAX_HUMAN_ACTION` 字符**。
 *
 * 对齐 superagent 的 `human_action`（docs/003：≤1000 字符，「一句话说清要人做什么」）。
 * 它是「待你决定」列表的标题来源，所以必须是**一句话**，不是一段报告。
 *
 * 只校验「传了就必须是干净字符串」；是否**该**传由调用方（complete/block 的语义）
 * 决定，不在这里猜 —— 但空串会被 `complete`/`block` 拒绝（见对应 case）。
 */
function normalizeHumanAction(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new BoardError(
      `board.${where}：字段 humanAction 类型错误（要求字符串，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD', { field: 'humanAction', where },
    )
  }
  if (value.length > MAX_HUMAN_ACTION) {
    throw new BoardError(
      `board.${where}：字段 humanAction 超长（≤${MAX_HUMAN_ACTION} 字符，收到 ${value.length}）—— `
      + '它要当「待你决定」列表的标题，请压缩成一句话',
      'BOARD_BAD_FIELD', { field: 'humanAction', where },
    )
  }
  return value
}

/**
 * Mandate 授权留痕归一（借鉴 superagent docs/001 §Mandate）。
 *
 * 只接受 `{ basis, sender, policyVersion }` 三个字段，且 `basis` 必须在
 * `MANDATE_BASES` 内；**多余的键直接拒绝**，不静默忽略 —— Mandate 是「这条活
 * 凭什么能做」的唯一证据，多一个字段就意味着多一种「当时没记清」的可能。
 *
 * 其中 `sender`（谁下的令）必填且非空；`policyVersion` 可选（缺省 null）。
 */
const MANDATE_BASES = ['explicit', 'inferred', 'task-board', 'room', 'cycle']
/**
 * Mandate 的合法字段集合。
 * 「谁下令」（sender）必填，其余可选；`basis` 的语义见 `MANDATE_BASES`。
 */
const MANDATE_FIELDS = ['basis', 'sender', 'policyVersion', 'scope']

function normalizeMandate(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BoardError(
      `board.${where}：字段 mandate 类型错误（要求对象，收到 ${JSON.stringify(value)}）`,
      'BOARD_BAD_FIELD', { field: 'mandate', where },
    )
  }
  const unknown = Object.keys(value).filter((k) => !MANDATE_FIELDS.includes(k))
  if (unknown.length > 0) {
    throw new BoardError(
      `board.${where}：mandate 含未知字段 ${unknown.join(', ')}（合法：${MANDATE_FIELDS.join(' | ')}）—— `
      + '拒绝静默忽略，Mandate 是授权依据，多一个字段就多一处说不清',
      'BOARD_BAD_FIELD', { field: 'mandate', where, unknown },
    )
  }
  const out = { ...value }
  if (out.basis !== undefined && out.basis !== null) {
    if (typeof out.basis !== 'string' || !MANDATE_BASES.includes(out.basis)) {
      throw new BoardError(
        `board.${where}：mandate.basis 必须是 ${MANDATE_BASES.join(' | ')}，收到 ${JSON.stringify(out.basis)}`,
        'BOARD_BAD_FIELD', { field: 'mandate.basis', where },
      )
    }
  }
  if (out.sender !== undefined && out.sender !== null) {
    if (typeof out.sender !== 'string' || out.sender.trim() === '') {
      throw new BoardError(
        `board.${where}：mandate.sender 必须是非空字符串（谁下的令）—— 收到 ${JSON.stringify(out.sender)}`,
        'BOARD_BAD_FIELD', { field: 'mandate.sender', where },
      )
    }
    out.sender = out.sender.trim()
  }
  if (out.policyVersion !== undefined && out.policyVersion !== null) {
    if (typeof out.policyVersion !== 'string') {
      throw new BoardError(
        `board.${where}：mandate.policyVersion 类型错误（要求字符串，收到 ${JSON.stringify(out.policyVersion)}）`,
        'BOARD_BAD_FIELD', { field: 'mandate.policyVersion', where },
      )
    }
  }
  if (out.scope !== undefined && out.scope !== null) {
    if (typeof out.scope !== 'string') {
      throw new BoardError(
        `board.${where}：mandate.scope 类型错误（要求字符串，收到 ${JSON.stringify(out.scope)}）`,
        'BOARD_BAD_FIELD', { field: 'mandate.scope', where },
      )
    }
  }
  // 至少要留下一条依据 —— 否则 Mandate 是空壳，等于没记
  if (out.basis === undefined && out.sender === undefined && out.policyVersion === undefined && out.scope === undefined) {
    throw new BoardError(
      `board.${where}：mandate 不能是空对象（至少给 basis 或 sender）`,
      'BOARD_BAD_FIELD', { field: 'mandate', where },
    )
  }
  return out
}


// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**：两条路都不通时必须让调用方看见。
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
  throw new BoardError(
    `board.createBoard：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'BOARD_NO_STATE_DIR',
  )
}

/**
 * 创建一个任务板实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（只用于日志，缺失即静默降级为 no-op 日志）
 * @param {{ stateDir?: string, leaseMs?: number, idempotencyMax?: number, name?: string }} [config]
 * @returns {object} board
 */
export function createBoard(ctx, config = {}) {
  const stateDir = resolveStateDir(config)
  const leaseMsDefault = Number.isFinite(config.leaseMs) && config.leaseMs > 0
    ? config.leaseMs
    : DEFAULT_LEASE_MS
  const settings = (config && typeof config.settings === 'object' && config.settings !== null) ? config.settings : {}
  const wipLimitPerBot = Number.isFinite(settings.wipLimitPerBot) && settings.wipLimitPerBot >= 1
    ? settings.wipLimitPerBot
    : (Number.isFinite(config.wipLimitPerBot) && config.wipLimitPerBot >= 1 ? config.wipLimitPerBot : 2)
  const requireTriageForReady = settings.requireTriageForReady === true || config.requireTriageForReady === true

  const jsonlPath = statePath(stateDir, 'board.jsonl')
  const snapPath = statePath(stateDir, 'board.snap.json')

  const info = (...args) => { try { ctx?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { ctx?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} 任务 id → Task（创建序 = Map 插入序） */
  const tasks = new Map()
  /** @type {object[]} 全部 TaskEvent（审计流，按落盘顺序） */
  const events = []
  /** @type {Map<string, string>} sourceSeq → taskId（幂等取回） */
  const sourceSeqIndex = new Map()
  /** 幂等去重器（store 提供；`replay()` 时从事件流重建） */
  const idem = new IdempotencySet(Number.isFinite(config.idempotencyMax) ? config.idempotencyMax : 10_000)
  /** 已 warn 过的缺失依赖 id（防刷屏） */
  const warnedMissingDeps = new Set()

  let idCounter = 0

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
    auditWriteFailures: 0,
    auditWarnedOnce: false,
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 快照内容（落盘形态）。 */
  const snapshot = () => ({
    version: 1,
    savedAt: Date.now(),
    idCounter,
    tasks: [...tasks.values()],
  })

  /**
   * 提交一次变更：**先落事件，再改内存，最后写快照**。
   *
   * 顺序不可颠倒：append 失败时内存必须原封不动（否则内存与磁盘分叉，
   * 重启回放后状态凭空回退，属于最恶劣的静默失败）。
   *
   * @param {string} taskId
   * @param {string} action
   * @param {string|null} byId
   * @param {number} at
   * @param {object|null} before 变更前 Task（create 为 null）
   * @param {object} after 变更后 Task
   * @returns {object} 克隆后的 after
   */
  function commit(taskId, action, byId, at, before, after) {
    const event = {
      taskId,
      rev: after.rev,
      action,
      byId: byId ?? null,
      at,
      before: before ? clone(before) : null,
      after: clone(after),
    }
    if (!appendJsonl(jsonlPath, event)) {
      throw new BoardError(
        `board.${action}：事件追加失败（${jsonlPath}）——拒绝「只改内存不落盘」`,
        'BOARD_APPEND_FAILED',
        { taskId, action },
      )
    }
    tasks.set(taskId, clone(after))
    events.push(event)
    if (after.sourceSeq) {
      // 幂等键在这里登记（而不是在 create 开头），保证「校验/落盘失败不污染键」
      idem.check(after.sourceSeq)
      sourceSeqIndex.set(after.sourceSeq, taskId)
    }
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/board] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可完整恢复`)
    }
    // ── 审计接线（P0-B §5）────────────────────────────────────────────────
    // 软用 store.appendAudit：拿不到/写失败 → 只 warn 一次 + 计数，**绝不阻断**主流程
    //（事件流 board.jsonl 已是本模块自己的真相源，审计是补充，不是必需品）。
    if (storeAuditMissing) {
      diagnostics.auditWriteFailures += 1
      if (!diagnostics.auditWarnedOnce) {
        diagnostics.auditWarnedOnce = true
        warn('[cs-bots/board] store.appendAudit 尚不可用（另一侧未合并）→ 审计接线跳过；主流程不受影响')
      }
    } else {
      try {
        const digest = (t) => (t
          ? { id: t.id, status: t.status, rev: t.rev, subject: t.subject, assignee: t.assignee ?? null, progress: t.progress ?? 0, triaged: t.triaged === true }
          : null)
        const result = storeAppendAudit(stateDir, {
          ts: at, actor: byId, action, target: taskId, before: digest(before), after: digest(after),
        })
        // appendAudit 的失败约定兼容两种形态：`false`（布尔）与 `{ok:false,reason}`（对象）。
        // 抛错同样按失败计。**任何形态都只 warn 一次，不阻断。**
        const failed = result === false || Boolean(result && typeof result === 'object' && result.ok === false)
        if (failed) {
          diagnostics.auditWriteFailures += 1
          if (!diagnostics.auditWarnedOnce) {
            diagnostics.auditWarnedOnce = true
            const reason = result && typeof result === 'object' ? (result.reason ?? '未知原因') : '返回 false'
            warn(`[cs-bots/board] store.appendAudit 返回失败：${reason}——主流程不受影响`)
          }
        }
      } catch (error) {
        diagnostics.auditWriteFailures += 1
        if (!diagnostics.auditWarnedOnce) {
          diagnostics.auditWarnedOnce = true
          warn(`[cs-bots/board] store.appendAudit 抛错：${error?.message ?? error}——主流程不受影响`)
        }
      }
    }
    return clone(after)
  }

  // ── 回放 ──────────────────────────────────────────────────────────────────

  /**
   * 从 `board.jsonl`（真相源）重建内存态；jsonl 为空才回落到 `board.snap.json`。
   * 坏行**不静默丢弃**：计入 diagnostics 并 warn。
   */
  function hydrate() {
    tasks.clear()
    events.length = 0
    sourceSeqIndex.clear()
    idem.keys.clear()
    warnedMissingDeps.clear()
    idCounter = 0

    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) {
      warn(`[cs-bots/board] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }

    if (rows.length === 0) {
      const snap = readJson(snapPath, null)
      const snapTasks = Array.isArray(snap?.tasks) ? snap.tasks : null
      if (snapTasks) {
        for (const raw of snapTasks) {
          if (!raw || typeof raw.id !== 'string') continue
          const t = clone(raw)
          if (!Array.isArray(t.blockedBy)) t.blockedBy = []
          if (!Array.isArray(t.writeScopes)) t.writeScopes = []
          if (!Array.isArray(t.labels)) t.labels = []
          if (t.triaged !== true && t.triaged !== false) t.triaged = false
          if (typeof t.progress !== 'number' || !Number.isFinite(t.progress)) t.progress = 0
          tasks.set(t.id, t)
          idCounter = Math.max(idCounter, idNumber(t.id))
          if (t.sourceSeq) sourceSeqIndex.set(t.sourceSeq, t.id)
        }
        if (Number.isFinite(snap?.idCounter)) idCounter = Math.max(idCounter, snap.idCounter)
        idem.rebuildFrom([...sourceSeqIndex.keys()].map((k) => ({ dedupKey: k })), 'dedupKey')
        diagnostics.hydratedFrom = 'snapshot'
        info(`[cs-bots/board] 回放完成：无事件流 → 由快照恢复 ${tasks.size} 个任务`)
        return
      }
      diagnostics.hydratedFrom = 'empty'
      info('[cs-bots/board] 回放完成：空板（无事件流、无快照）')
      return
    }

    // 事件流是真相源：只接受 rev 递增的事件（同 rev 重放幂等，容忍重复投递）
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.taskId !== 'string' || !ev.after || typeof ev.after.id !== 'string') {
        skipped += 1
        continue
      }
      const before = tasks.get(ev.taskId)
      if (before && Number.isFinite(ev.rev) && ev.rev <= before.rev) {
        skipped += 1
        continue
      }
      const t = clone(ev.after)
      if (!Array.isArray(t.blockedBy)) t.blockedBy = []
      if (!Array.isArray(t.writeScopes)) t.writeScopes = []
      if (!Array.isArray(t.labels)) t.labels = []
      if (t.triaged !== true && t.triaged !== false) t.triaged = false
      if (typeof t.progress !== 'number' || !Number.isFinite(t.progress)) t.progress = 0
      tasks.set(ev.taskId, t)
      events.push(clone(ev))
      idCounter = Math.max(idCounter, idNumber(ev.taskId))
      if (t.sourceSeq) {
        sourceSeqIndex.set(t.sourceSeq, ev.taskId)
        idem.check(t.sourceSeq)
      }
    }
    if (skipped > 0) {
      warn(`[cs-bots/board] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }
    diagnostics.hydratedFrom = 'jsonl'
    info(`[cs-bots/board] 回放完成：${rows.length} 条事件 → ${tasks.size} 个任务`)
  }

  // ── DAG 校验 ──────────────────────────────────────────────────────────────

  /**
   * 依赖环探测：从 `selfId` 出发沿 blockedBy 边遍历，回到 `selfId` 即环。
   * @param {string} selfId
   * @param {string[]} deps 该任务**将要生效**的 blockedBy
   * @returns {string[] | null} 环路径（含首尾重复的 selfId），无环返回 null
   */
  function findCycle(selfId, deps) {
    const visited = new Set([selfId])
    const stack = [[selfId, [selfId]]]
    while (stack.length > 0) {
      const [node, trail] = stack.pop()
      const edges = node === selfId ? deps : (tasks.get(node)?.blockedBy ?? [])
      for (const dep of edges) {
        if (dep === selfId) return [...trail, dep]
        if (visited.has(dep)) continue
        visited.add(dep)
        stack.push([dep, [...trail, dep]])
      }
    }
    return null
  }

  /**
   * 校验 blockedBy：非空 id / 引用存在 / 无环。
   * 依赖不存在的 id 会**抛错**：否则该任务永远等不到 completed，形成静默死锁。
   * @param {string} selfId
   * @param {string[]} deps
   */
  function assertDependencyGraph(selfId, deps) {
    for (const dep of deps) {
      if (dep === selfId) {
        throw new BoardError(
          `board：依赖环 → ${selfId} → ${selfId}（任务不能 blockedBy 自己）`,
          'BOARD_DEPENDENCY_CYCLE',
          { id: selfId, cycle: [selfId, selfId] },
        )
      }
      if (!tasks.has(dep)) {
        throw new BoardError(
          `board：blockedBy 引用了不存在的任务 ${dep}（任务 ${selfId}）——拒绝写入永远无法满足的依赖`,
          'BOARD_DEPENDENCY_NOT_FOUND',
          { id: selfId, dep },
        )
      }
    }
    const cycle = findCycle(selfId, deps)
    if (cycle) {
      const shown = cycle.map((x) => `${x}`).join(' → ')
      throw new BoardError(
        `board：依赖环 ${shown}（任务 ${selfId} 的 blockedBy 会让依赖图无法收敛）`,
        'BOARD_DEPENDENCY_CYCLE',
        { id: selfId, cycle },
      )
    }
  }

  /** 未完成的依赖清单（就绪判定用）。 */
  function unfinishedDeps(task) {
    const out = []
    for (const dep of task.blockedBy ?? []) {
      const d = tasks.get(dep)
      if (!d) {
        if (!warnedMissingDeps.has(dep)) {
          warnedMissingDeps.add(dep)
          warn(`[cs-bots/board] blockedBy 引用了未知任务 ${dep}（依赖视为**未满足**，不静默放过）`)
        }
        out.push(`${dep}(missing)`)
        continue
      }
      if (d.status !== 'completed') out.push(`${dep}(${d.status})`)
    }
    return out
  }

  // ── API：读 ────────────────────────────────────────────────────────────────

  /** @param {string} id @returns {object | undefined} */
  function get(id) {
    const t = tasks.get(id)
    return t ? clone(t) : undefined
  }

  /**
   * 列出任务（**创建序**）。
   * 缺省不含 `deleted`；只有显式传 `status:'deleted'` 才看得到墓碑。
   * @param {{ status?: string }} [options]
   * @returns {object[]}
   */
  /**
   * 「需要人管」的判定（与 todo 的四象限同思路，但对象是协作任务）：
   *   - blocked（卡住了，需要人判断怎么办）
   *   - 高优先级（priority >= 8，紧急）
   *   - 已逾期（dueAt 在过去且仍未完成）
   *   - 待验收（completed 但还没验收）
   *   - 我建的、还没做完
   * 没有「重要/紧急」字段 —— 那是待办的概念；协作任务用 priority + dueAt 表达。
   */
  function needsAttention(task, mySession) {
    if (task.status === 'deleted') return false
    if (task.status === 'blocked') return true
    if (task.priority !== undefined && task.priority >= 8) return true
    if (task.dueAt && task.status !== 'completed' && task.dueAt < Date.now()) return true
    if (task.status === 'completed' && task.accepted !== true) return true
    // 结构化「待你回答」：latestReport.attention 存在 ⇒ 执行者明确在等人
    // （2026-11-09：与 stage.js 的 person/answer 判定同一依据，不另起字段）
    if (task.latestReport?.attention) return true
    if (mySession && task.createdBy === mySession && !['completed', 'deleted'].includes(task.status)) return true
    return false
  }

  function list(options = {}) {
    const { status, attention, priority, dueAt, source, sort, triaged } = options ?? {}
    if (status !== undefined && status !== null) {
      if (!STATUSES.includes(status)) {
        throw new BoardError(
          `board.list：非法 status=${JSON.stringify(status)}（合法值：${STATUSES.join(' | ')}）`,
          'BOARD_BAD_STATUS',
          { status },
        )
      }
    }
    const out = []
    const mySession = options?.byId
    for (const t of tasks.values()) {
      if (status) {
        if (t.status !== status) continue
      } else if (t.status === 'deleted') {
        continue
      }
      if (attention === true || attention === '1') {
        if (!needsAttention(t, mySession)) continue
      }
      if (priority !== undefined && priority !== null) {
        if (t.priority !== priority) continue
      }
      if (dueAt !== undefined && dueAt !== null) {
        if (t.dueAt !== dueAt) continue
      }
      if (source !== undefined && source !== null) {
        if (t.source !== source) continue
      }
      if (triaged !== undefined && triaged !== null) {
        const want = triaged === true || triaged === '1' || triaged === 'true'
        if ((t.triaged === true) !== want) continue
      }
      out.push(clone(t))
    }
    if (sort === 'priority' || attention === true || attention === '1') {
      out.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    }
    return out
  }

  /**
   * 就绪任务：`status === 'pending'` **且**全部 blockedBy 都已 completed（依赖整图校验）。
   * 纯读操作，不做租约回收（租约回收请显式调用 `expireLeases()`）。
   * @returns {object[]} 创建序
   */
  function ready(options = {}) {
    const strict = options?.strict === true || requireTriageForReady
    const out = []
    for (const t of tasks.values()) {
      if (t.status !== 'pending') continue
      if (strict) {
        if (t.triaged !== true) continue
        if (typeof t.assignee !== 'string' || t.assignee.trim() === '') continue
      }
      if (unfinishedDeps(t).length === 0) out.push(clone(t))
    }
    // 文档承诺「按优先级降序」，这里落实（否则只是「创建序」，与承诺不符）
    out.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    return out
  }

  /**
   * 审计流查询。
   * @param {string} [taskId] 省略则返回全部事件
   * @returns {object[]}
   */
  function history(taskId) {
    const rows = taskId ? events.filter((e) => e.taskId === taskId) : events
    return clone(rows)
  }

  // ── API：写 ────────────────────────────────────────────────────────────────

  /**
   * 创建任务。同 `sourceSeq` **幂等**：重复创建返回同一个 Task，不产生第二条事件。
   * @param {{ subject: string, description?: string, blockedBy?: string[], writeScopes?: string[],
   *           priority?: number, dueAt?: number, byId: string, sourceSeq?: string, now?: number }} input
   * @returns {object} Task
   */
  function create(input = {}) {
    const {
      subject, description, blockedBy, writeScopes, priority, dueAt, byId, sourceSeq, now,
      expectedComplexity, requiresPaid, source,
      labels, milestone, cycle, estimate, assignee, reviewer, progress, triaged,
      mandate,
    } = input ?? {}
    const by = requireString(byId, 'byId', 'create')
    // 来源判定：显式传了 source 就采信；否则按 byId 推断
    // （'ui'/'user' → 人；其他（会话 ID/Bot ID）→ 智能体）
    const src = source === 'human' || source === 'ai' ? source
      : (by === 'ui' || by === 'user' ? 'human' : 'ai')
    const subj = requireString(subject, 'subject', 'create')
    const desc = normalizeDescription(description, 'create')
    const deps = stringList(blockedBy, 'blockedBy', 'create')
    const scopes = stringList(writeScopes, 'writeScopes', 'create')
    const prio = optionalNumber(priority, 'priority', 'create')
    const due = optionalNumber(dueAt, 'dueAt', 'create')
    // 复杂度路由标签（可选；非法值在这里就抛，不进事件流）
    const complexity = normalizeComplexity(expectedComplexity, 'create')
    const paid = normalizeRequiresPaid(requiresPaid, 'create')
    const seq = sourceSeq === undefined || sourceSeq === null
      ? undefined
      : requireString(sourceSeq, 'sourceSeq', 'create')
    // P0-B 新增可选字段（全部「可选 + 回放补默认」，老数据不受影响）
    const labelsNorm = normalizeLabels(labels, 'create')
    const milestoneNorm = normalizeOptionalString(milestone, 'milestone', 'create')
    const cycleNorm = normalizeOptionalString(cycle, 'cycle', 'create')
    const estimateNorm = normalizeEstimate(estimate, 'create')
    const assigneeNorm = normalizeOptionalString(assignee, 'assignee', 'create')
    const reviewerNorm = normalizeOptionalString(reviewer, 'reviewer', 'create')
    const progressNorm = normalizeProgress(progress, 'create')
    const triagedNorm = normalizeTriaged(triaged, 'create')
    // Mandate 授权留痕（可选；不给就是「未记录依据」，不伪造一个）
    const mandateNorm = normalizeMandate(mandate, 'create')

    // ── 幂等（校验全部通过后再判定，避免校验失败污染幂等键）──
    if (seq !== undefined) {
      const existingId = sourceSeqIndex.get(seq)
      if (existingId && tasks.has(existingId)) {
        idem.check(seq)
        info(`[cs-bots/board] create 幂等命中 sourceSeq=${seq} → 复用 ${existingId}`)
        return clone(tasks.get(existingId))
      }
      if (idem.has(seq)) {
        // 去重器有记录、索引却没有 → 内部状态不一致，绝不猜测，直接暴露
        throw new BoardError(
          `board.create：sourceSeq=${seq} 已登记但找不到对应任务（幂等索引不一致）——拒绝静默新建`,
          'BOARD_IDEMPOTENCY_INDEX_MISSING',
          { sourceSeq: seq },
        )
      }
    }

    const at = normalizeNow(now, 'create')
    const nextCounter = idCounter + 1
    const taskId = `t-${nextCounter}`
    assertDependencyGraph(taskId, deps)

    /** @type {Record<string, unknown>} */
    const task = {
      id: taskId,
      rev: 1, source: src,
      subject: subj,
      description: desc,
      status: 'pending',
      blockedBy: deps,
      writeScopes: scopes,
      createdAt: at,
      createdBy: by,
      // P0-B：老数据回放补默认；新建任务也直接带上，保证 replay 深比较一致
      labels: [],
      triaged: false,
      progress: 0,
    }
    if (prio !== undefined) task.priority = prio
    if (due !== undefined) task.dueAt = due
    if (seq !== undefined) task.sourceSeq = seq
    if (complexity !== undefined) task.expectedComplexity = complexity
    if (paid !== undefined) task.requiresPaid = paid
    if (labelsNorm !== undefined) task.labels = labelsNorm
    if (milestoneNorm !== undefined) task.milestone = milestoneNorm
    if (cycleNorm !== undefined) task.cycle = cycleNorm
    if (estimateNorm !== undefined) task.estimate = estimateNorm
    if (assigneeNorm !== undefined) task.assignee = assigneeNorm
    if (reviewerNorm !== undefined) task.reviewer = reviewerNorm
    if (progressNorm !== undefined) task.progress = progressNorm
    if (triagedNorm !== undefined) task.triaged = triagedNorm
    if (mandateNorm !== undefined) task.mandate = mandateNorm
    else task.mandate = { sender: by } // 事实留痕：谁建的（`byId`），不是判断

    idCounter = nextCounter
    try {
      const committed = commit(taskId, 'create', by, at, null, task)
      return committed
    } catch (error) {
      idCounter = nextCounter - 1
      throw error
    }
  }

  /**
   * 按 `expectedRev` 做 CAS 变更。**rev 不匹配即抛错，绝不静默覆盖。**
   *
   * @param {{ id: string, expectedRev: number, action?: string, byId: string,
   *           subject?: string, description?: string, blockedBy?: string[], writeScopes?: string[],
   *           priority?: number|null, dueAt?: number|null, artifacts?: (string|object)[], note?: string,
   *           leaseMs?: number, force?: boolean, now?: number }} input
   * @returns {object} 变更后的 Task
   * @throws {BoardError} rev 冲突 / 缺字段 / 非法 action / 依赖环 / complete 缺 artifacts
   */
  function update(input = {}) {
    const {
      id, expectedRev, action = 'edit', byId, now,
      artifacts, note, reason, leaseMs, force, ...fields
    } = input ?? {}
    const taskId = requireString(id, 'id', 'update')
    const by = requireString(byId, 'byId', 'update')
    if (action !== 'edit' && !ACTIONS.includes(action)) {
      throw new BoardError(
        `board.update：不支持 action=${JSON.stringify(action)}（支持：edit | claim | release | heartbeat | `
        + 'complete | reopen | block | delete；验收请用 board.accept()）',
        'BOARD_BAD_ACTION',
        { action },
      )
    }

    const current = tasks.get(taskId)
    if (!current) {
      throw new BoardError(`board.update：任务不存在 id=${taskId}`, 'BOARD_TASK_NOT_FOUND', { id: taskId })
    }
    if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev)) {
      throw new BoardError(
        `board.update：expectedRev 必须是整数（CAS 需要显式期望版本，任务 ${taskId} 当前 rev=${current.rev}，`
        + `收到 ${JSON.stringify(expectedRev)}）`,
        'BOARD_MISSING_EXPECTED_REV',
        { id: taskId, rev: current.rev },
      )
    }
    if (current.rev !== expectedRev) {
      throw new BoardError(
        `board.update CAS 冲突：任务 ${taskId} 期望 rev=${expectedRev}，实际 rev=${current.rev} —— 拒绝静默覆盖，`
        + '请重新 get() 后按最新 rev 重试',
        'BOARD_REV_CONFLICT',
        { id: taskId, expectedRev, rev: current.rev },
      )
    }

    const at = normalizeNow(now, 'update')
    const before = clone(current)
    /** @type {Record<string, any>} */
    const next = clone(current)
    next.rev = current.rev + 1

    const isDead = (st) => st === 'deleted'
    const ownerName = (lease) => (lease?.ownerId ? String(lease.ownerId) : '?')

    // 复杂度路由标签（契约 §6）：**任何 action 下**非法值都直接拒 ——
    // 不给「脏输入被静默忽略」的口子（那样路由就不可追溯了）。
    const patchComplexity = normalizeComplexity(fields.expectedComplexity, `update/${action}`)
    const patchRequiresPaid = normalizeRequiresPaid(fields.requiresPaid, `update/${action}`)
    /**
     * 把 P0-B 新增可选字段落到 next 上（`null` = 清除）。
     * 与 create 共用同一套校验函数 —— 同一字段两条入口不得有两套规则。
     * @param {object} nextTask @param {object} src @param {string} where
     */
    const applyNewFields = (nextTask, src, where) => {
      const setOrDelete = (key, normalized) => {
        if (normalized === undefined) delete nextTask[key]
        else nextTask[key] = normalized
      }
      if (src.labels !== undefined) setOrDelete('labels', normalizeLabels(src.labels, where))
      if (src.milestone !== undefined) setOrDelete('milestone', normalizeOptionalString(src.milestone, 'milestone', where))
      if (src.cycle !== undefined) setOrDelete('cycle', normalizeOptionalString(src.cycle, 'cycle', where))
      if (src.estimate !== undefined) setOrDelete('estimate', normalizeEstimate(src.estimate, where))
      if (src.assignee !== undefined) setOrDelete('assignee', normalizeOptionalString(src.assignee, 'assignee', where))
      if (src.reviewer !== undefined) setOrDelete('reviewer', normalizeOptionalString(src.reviewer, 'reviewer', where))
      if (src.progress !== undefined) setOrDelete('progress', normalizeProgress(src.progress, where))
      if (src.triaged !== undefined) setOrDelete('triaged', normalizeTriaged(src.triaged, where))
      if (src.startedAt !== undefined) setOrDelete('startedAt', optionalNumber(src.startedAt, 'startedAt', where))
      if (src.completedAt !== undefined) setOrDelete('completedAt', optionalNumber(src.completedAt, 'completedAt', where))
      if (src.archivedAt !== undefined) setOrDelete('archivedAt', optionalNumber(src.archivedAt, 'archivedAt', where))
      // 结构化收尾（2026-11-09）：`outcome`/`humanAction` 是**入参**，
      // 落盘目标是 `latestReport`（stage.js 的唯一真相），**不新增顶层字段**。
      // `null` 表示「清除报告」（等价于 `delete latestReport`）—— 与 `setOrDelete`
      // 的既有约定一致；stage.js 读不到就用保守值，干净。
      if (src.outcome !== undefined) {
        if (src.outcome === null) {
          if (nextTask.latestReport) delete nextTask.latestReport.state
        } else {
          if (nextTask.latestReport === undefined) nextTask.latestReport = {}
          nextTask.latestReport.state = normalizeOutcome(src.outcome, where)
        }
      }
      if (src.humanAction !== undefined) {
        if (src.humanAction === null) {
          if (nextTask.latestReport) delete nextTask.latestReport.attention
        } else {
          if (nextTask.latestReport === undefined) nextTask.latestReport = {}
          nextTask.latestReport.attention = { question: normalizeHumanAction(src.humanAction, where) }
        }
      }
      if (src.mandate !== undefined) setOrDelete('mandate', normalizeMandate(src.mandate, where))
    }

    /** 把（可选）路由标签落到 next 上；`null` = 清除该标注。@param {object} nextTask */
    const applyRoutingLabels = (nextTask) => {
      if (fields.expectedComplexity !== undefined) {
        if (fields.expectedComplexity === null) delete nextTask.expectedComplexity
        else nextTask.expectedComplexity = patchComplexity
      }
      if (fields.requiresPaid !== undefined) {
        if (fields.requiresPaid === null) delete nextTask.requiresPaid
        else nextTask.requiresPaid = patchRequiresPaid
      }
    }

    switch (action) {
      // ── 字段补丁（内容类）────────────────────────────────────────────────
      case 'edit': {
        const given = Object.keys(fields).filter((k) => fields[k] !== undefined)
        if (given.length === 0) {
          throw new BoardError(
            `board.update/edit：未提供任何可改字段（可改：${PATCH_FIELDS.join(' | ')}；`
            + 'status 只能改走 action —— claim/release/heartbeat/complete/reopen/block/delete）',
            'BOARD_NO_PATCH_FIELDS',
            { id: taskId },
          )
        }
        if (isDead(current.status)) {
          throw new BoardError(
            `board.update/edit：任务 ${taskId} 已删除（tombstone），先 reopen 再改`,
            'BOARD_TASK_DELETED',
            { id: taskId },
          )
        }
        const unknown = given.filter((k) => !PATCH_FIELDS.includes(k))
        if (unknown.length > 0) {
          throw new BoardError(
            `board.update/edit：未知字段 ${unknown.join(', ')}（可改：${PATCH_FIELDS.join(' | ')}）——拒绝静默忽略`,
            'BOARD_UNKNOWN_FIELD',
            { id: taskId, unknown },
          )
        }
        if (fields.subject !== undefined) next.subject = requireString(fields.subject, 'subject', 'update')
        if (fields.description !== undefined) next.description = normalizeDescription(fields.description, 'update')
        if (fields.writeScopes !== undefined) next.writeScopes = stringList(fields.writeScopes, 'writeScopes', 'update')
        if (fields.blockedBy !== undefined) {
          const deps = stringList(fields.blockedBy, 'blockedBy', 'update')
          assertDependencyGraph(taskId, deps)
          next.blockedBy = deps
        }
        if (fields.priority !== undefined) {
          if (fields.priority === null) delete next.priority
          else next.priority = optionalNumber(fields.priority, 'priority', 'update')
        }
        if (fields.dueAt !== undefined) {
          if (fields.dueAt === null) delete next.dueAt
          else next.dueAt = optionalNumber(fields.dueAt, 'dueAt', 'update')
        }
        // P0-B 新增字段（null = 清除该字段，与 priority/dueAt 同语义）
        applyNewFields(next, fields, `update/edit`)
        applyRoutingLabels(next)
        break
      }

      // ── 取租约 ──────────────────────────────────────────────────────────
      case 'claim': {
        if (isDead(current.status)) {
          throw new BoardError(`board.claim：任务 ${taskId} 已删除，不能 claim`, 'BOARD_TASK_DELETED', { id: taskId })
        }
        if (current.status === 'completed') {
          throw new BoardError(`board.claim：任务 ${taskId} 已完成（rev=${current.rev}），需先 reopen`, 'BOARD_ALREADY_COMPLETED', { id: taskId })
        }
        if (current.status === 'blocked') {
          throw new BoardError(`board.claim：任务 ${taskId} 处于 blocked，需先 reopen 才能 claim`, 'BOARD_TASK_BLOCKED', { id: taskId })
        }
        const ttl = optionalNumber(leaseMs, 'leaseMs', 'claim') ?? leaseMsDefault
        if (!(ttl > 0)) {
          throw new BoardError(`board.claim：leaseMs 必须 > 0，收到 ${JSON.stringify(leaseMs)}`, 'BOARD_BAD_FIELD', { field: 'leaseMs' })
        }
        if (current.lease) {
          const exp = Number(current.lease.expiresAt)
          const live = Number.isFinite(exp) && exp > at
          if (live && current.lease.ownerId !== by) {
            throw new BoardError(
              `board.claim：任务 ${taskId} 的租约仍被 ${ownerName(current.lease)} 持有（至 ${new Date(exp).toISOString()}）`
              + `——不允许抢占，调用者为 ${by}`,
              'BOARD_LEASE_HELD',
              { id: taskId, ownerId: current.lease.ownerId, expiresAt: exp },
            )
          }
          if (!live) {
            warn(`[cs-bots/board] 任务 ${taskId} 的租约已于 ${new Date(exp).toISOString()} 过期（持有者 ${ownerName(current.lease)}）→ 允许抢占`)
          }
        }
        if (force !== true && current.status === 'pending') {
          const pending = unfinishedDeps(current)
          if (pending.length > 0) {
            throw new BoardError(
              `board.claim：任务 ${taskId} 尚未就绪，blockedBy 未完成 → ${pending.join(', ')}（确要抢占请传 force:true）`,
              'BOARD_NOT_READY',
              { id: taskId, blockedBy: current.blockedBy },
            )
          }
        }
        // WIP 上限（P0-B §2）：同 bot 名下 in_progress 任务数 >= 上限 → 拒
        //
        // ⚠️ 借自 superagent 的一条硬纪律（src/executor/dsh.ts:171-199）：
        //   `by === 'person'` 时**额外给一个槽位** —— 官方注释是
        //   「New work therefore cannot prevent a person from continuing an existing Ticket」。
        //   人手动接活不能被机器人的排队上限挡住：上限是给自动化流量设的闸，
        //   不是用来拒绝人。所以人的有效上限 = wipLimitPerBot + 1。
        const wipActive = [...tasks.values()].filter(
          (t) => t.status === 'in_progress' && t.ownerId === by,
        )
        const isPerson = by === 'person'
        const effectiveWipLimit = wipLimitPerBot + (isPerson ? 1 : 0)
        if (wipActive.length >= effectiveWipLimit) {
          throw new BoardError(
            `board.claim：WIP 超限 —— bot ${by} 当前在 ${wipActive.length} 个 in_progress 任务上（上限 ${effectiveWipLimit}），`
            + `拒绝再领 ${taskId}`,
            'BOARD_WIP_EXCEEDED',
            {
              botId: by, limit: effectiveWipLimit, baseLimit: wipLimitPerBot,
              personBonus: isPerson, current: wipActive.length, taskId,
            },
          )
        }
        next.status = 'in_progress'
        next.ownerId = by
        next.lease = { ownerId: by, expiresAt: at + ttl, heartbeatAt: at }
        if (next.startedAt === undefined) next.startedAt = at
        // claim 也可顺带纠正路由标注（规划 Agent 领活时补/改 expectedComplexity 的路径）
        applyRoutingLabels(next)
        break
      }

      // ── 放租约 ──────────────────────────────────────────────────────────
      case 'release': {
        if (!current.lease) {
          throw new BoardError(
            `board.release：任务 ${taskId} 当前没有租约（status=${current.status}），无可释放`,
            'BOARD_NO_LEASE',
            { id: taskId },
          )
        }
        if (current.lease.ownerId !== by) {
          throw new BoardError(
            `board.release：只允许租约持有者操作（任务 ${taskId} 的租约属于 ${ownerName(current.lease)}，调用者 ${by}）`,
            'BOARD_LEASE_NOT_OWNER',
            { id: taskId, ownerId: current.lease.ownerId },
          )
        }
        next.status = current.status === 'blocked' ? 'blocked' : 'pending'
        delete next.lease
        delete next.ownerId
        break
      }

      // ── 心跳续租 ────────────────────────────────────────────────────────
      case 'heartbeat': {
        if (current.status !== 'in_progress' || !current.lease) {
          throw new BoardError(
            `board.heartbeat：任务 ${taskId} 没有活跃租约（status=${current.status}，lease=${current.lease ? '已设' : '无'}）`
            + '——请先 claim',
            'BOARD_NO_LEASE',
            { id: taskId, status: current.status },
          )
        }
        if (current.lease.ownerId !== by) {
          throw new BoardError(
            `board.heartbeat：只允许租约持有者续租（任务 ${taskId} 的租约属于 ${ownerName(current.lease)}，调用者 ${by}）`,
            'BOARD_LEASE_NOT_OWNER',
            { id: taskId, ownerId: current.lease.ownerId },
          )
        }
        const exp = Number(current.lease.expiresAt)
        if (!Number.isFinite(exp) || exp <= at) {
          throw new BoardError(
            `board.heartbeat：任务 ${taskId} 的租约已过期（expiresAt=${Number.isFinite(exp) ? new Date(exp).toISOString() : exp}）`
            + '——心跳无法复活过期租约，请走 claim 或 expireLeases',
            'BOARD_LEASE_EXPIRED',
            { id: taskId, expiresAt: exp },
          )
        }
        const ttl = optionalNumber(leaseMs, 'leaseMs', 'heartbeat') ?? leaseMsDefault
        next.lease = { ownerId: by, expiresAt: at + ttl, heartbeatAt: at }
        break
      }

      // ── 完成（必须带 artifacts）─────────────────────────────────────────
      case 'complete': {
        if (current.status === 'completed') {
          throw new BoardError(
            `board.complete：任务 ${taskId} 已完成（rev=${current.rev}）——重复完成无意义，需先 reopen`,
            'BOARD_ALREADY_COMPLETED',
            { id: taskId },
          )
        }
        if (isDead(current.status)) {
          throw new BoardError(`board.complete：任务 ${taskId} 已删除，不能 complete`, 'BOARD_TASK_DELETED', { id: taskId })
        }
        if (current.lease && current.lease.ownerId !== by) {
          throw new BoardError(
            `board.complete：只允许租约持有者交付（任务 ${taskId} 的租约属于 ${ownerName(current.lease)}，调用者 ${by}）`,
            'BOARD_LEASE_NOT_OWNER',
            { id: taskId, ownerId: current.lease.ownerId },
          )
        }
        // ── 结构化收尾（2026-11-09，借鉴 superagent Report 枚举）──────────────
        // 落到 `latestReport`（**单一真相**），而不是另开顶层 `outcome` 字段 ——
        // `src/stage.js` 的 8 阶段分类器读的就是 `latestReport.state` / `latestReport.attention`，
        // 若这里写另一个字段名，阶段表永远派不出「等你验收/等你回答」。
        //
        // 顺序纪律（与 stage.js 同构）：complete 时**不要**带 attention ——
        // attention 的优先级高于 `ready`（stage 顺序：answer > review），
        // 带 attention 会把「待验收」显示成「等你回答」，语义就错了。
        const rawOutcome = fields.outcome
        const outcomeNorm = normalizeOutcome(rawOutcome, 'complete')
        if (outcomeNorm !== undefined && !COMPLETE_OUTCOMES.includes(outcomeNorm)) {
          throw new BoardError(
            `board.complete：outcome=${JSON.stringify(outcomeNorm)} 不能用 complete 交付 —— `
            + `「卡住/失败」的任务不该出现在「待验收」里（那是 ready/dropped 的语义）。请改用 board.update block。`,
            'BOARD_BAD_FIELD',
            { id: taskId, outcome: outcomeNorm, allowed: COMPLETE_OUTCOMES },
          )
        }
        const humanActionNorm = normalizeHumanAction(fields.humanAction, 'complete')
        if (humanActionNorm !== undefined) {
          throw new BoardError(
            `board.complete：complete 不接受 humanAction（${JSON.stringify(humanActionNorm)}）—— `
            + '完成就是「等人验收」，不是「等人回答」；要提问请用 block 或 edit。'
            + '（否则 stage 会把「待验收」误判成「等你回答」）',
            'BOARD_BAD_FIELD', { id: taskId, field: 'humanAction' },
          )
        }

        next.artifacts = normalizeArtifacts(artifacts, taskId)
        next.status = 'completed'
        next.completedAt = at
        next.ownerId = current.ownerId ?? by
        // `ready` = 干完了等人验收（默认）；`dropped` = 结论是「不需要人做任何事」。
        // 两者都合法，但面板含义完全不同：前者进「待验收」，后者直接归档不显示。
        // 缺省取 `ready` —— 一个 completed 任务不该默默变成「无需验收」。
        next.latestReport = {
          state: outcomeNorm ?? 'ready',
          at,
          reporter: by,
        }
        delete next.lease
        delete next.acceptance // 完成即待验收，旧的验收结论作废（历史在事件流里）
        delete next.accepted // `accepted` 与 `acceptance` 同生同灭，必须一起清
        break
      }

      // ── 重开 ────────────────────────────────────────────────────────────
      case 'reopen': {
        if (current.status === 'pending' && !current.lease) {
          throw new BoardError(
            `board.reopen：任务 ${taskId} 已是 pending 且无租约，无需 reopen`,
            'BOARD_NOTHING_TO_REOPEN',
            { id: taskId },
          )
        }
        next.status = 'pending'
        delete next.lease
        delete next.ownerId
        delete next.acceptance
        delete next.completedAt
        delete next.artifacts
        delete next.blockedReason
        // 重开 = 一切收尾结论作废（旧结论在事件流的 before 里留档）
        delete next.latestReport
        break
      }

      // ── 阻塞 ────────────────────────────────────────────────────────────
      case 'block': {
        if (isDead(current.status)) {
          throw new BoardError(`board.block：任务 ${taskId} 已删除，不能 block`, 'BOARD_TASK_DELETED', { id: taskId })
        }
        if (current.status === 'completed') {
          throw new BoardError(`board.block：任务 ${taskId} 已完成，需先 reopen 才能 block`, 'BOARD_ALREADY_COMPLETED', { id: taskId })
        }
        next.status = 'blocked'
        delete next.lease
        // ⚠️ 修复（2026-11-04 测试）：tools.js 的 schema 与 UI 传的是 `reason`，
        //   实现却只读 `note` ⇒ 「终止/阻塞原因」被静默丢弃。现在两个字段都认。
        const blockReason = note !== undefined && note !== null ? note : reason
        if (blockReason !== undefined && blockReason !== null && String(blockReason) !== '') {
          next.blockedReason = String(blockReason)
        }
        // ── 结构化「要人做什么」（2026-11-09）──────────────────────────────
        // 落到 `latestReport`（与 stage.js 共用同一真相）：
        //   state = blocked | failed  ⇒ stage 派 `person/blocked` / `person/failed`
        //   attention.question       ⇒ 若给了 humanAction，stage 会优先派 `person/answer`
        //
        // ⚠️ 顺序陷阱：stage.js 里 `answer` 的优先级**高于** `blocked`。
        //   所以「blocked + 带 attention」会显示成「等你回答」而不是「受阻等你」。
        //   这其实是对的语义 —— 如果执行者能说清「我要你做什么」，那就是在等你回答；
        //   说不出（只 report blocked）才落到「受阻等你」。两者都指向「该人动手」。
        const blockOutcome = normalizeOutcome(fields.outcome, 'block')
        if (blockOutcome !== undefined && !['blocked', 'failed'].includes(blockOutcome)) {
          throw new BoardError(
            `board.block：outcome 只能是 blocked | failed，收到 ${JSON.stringify(blockOutcome)}`
            + '（ready/dropped 请用 complete）',
            'BOARD_BAD_FIELD', { id: taskId, outcome: blockOutcome },
          )
        }
        const blockHumanAction = normalizeHumanAction(fields.humanAction, 'block')
        if (blockHumanAction !== undefined && String(blockHumanAction).trim() === '') {
          throw new BoardError(
            `board.block：humanAction 不能是空白 —— 要么写清要人做什么，要么不传`,
            'BOARD_BAD_FIELD', { id: taskId, field: 'humanAction' },
          )
        }
        /** @type {Record<string, unknown>} */
        const blockReport = {
          state: blockOutcome ?? 'blocked',
          at,
          reporter: by,
        }
        // attention 只在**明确给了 humanAction** 时才写 —— 绝不用 blockedReason
        // 冒充「问题」。理由：blockedReason 是「为什么卡住」（给人看的诊断），
        // attention 是「要你做什么」（给人的行动指令）。把诊断当指令，会让人
        // 在「等你回答」里看到一句「端口被占用」，然后不知道该回什么。
        if (blockHumanAction !== undefined) {
          blockReport.attention = { question: blockHumanAction }
        }
        next.latestReport = blockReport
        break
      }

      // ── 解除阻塞（2026-11-04 新增：tools.js schema 与 README 早已承诺，实现缺失）──
      case 'unblock': {
        if (isDead(current.status)) {
          throw new BoardError(`board.unblock：任务 ${taskId} 已删除，不能 unblock`, 'BOARD_TASK_DELETED', { id: taskId })
        }
        if (current.status !== 'blocked') {
          throw new BoardError(
            `board.unblock：任务 ${taskId} 当前状态是 ${current.status}，只有 blocked 才能 unblock`,
            'BOARD_BAD_STATE',
            { id: taskId, status: current.status },
          )
        }
        // 依赖未完成的仍保持 blocked（依赖是数据约束，不是状态约束）
        const unmet = (current.blockedBy ?? []).filter((d) => {
          const dep = tasks.get(d)
          return dep ? dep.status !== 'completed' && dep.status !== 'deleted' : true
        })
        next.status = unmet.length === 0 ? 'pending' : 'blocked'
        delete next.blockedReason
        break
      }

      // ── 直接改字段/状态（2026-11-04 新增：tools.js schema 早承诺、实现缺失）──
      case 'set': {
        if (isDead(current.status)) {
          throw new BoardError(`board.set：任务 ${taskId} 已删除，不能 set`, 'BOARD_TASK_DELETED', { id: taskId })
        }
        const fieldsGiven = Object.keys(fields).filter((k) => fields[k] !== undefined)
        if (fieldsGiven.length === 0) {
          throw new BoardError(
            `board.set：未提供任何字段（可改：${PATCH_FIELDS.join(' | ')} | status | priority | dueAt）`,
            'BOARD_BAD_FIELD',
            { id: taskId, patchable: PATCH_FIELDS },
          )
        }
        // P0-B 新增字段：走统一校验后落值（不许经 raw 赋值绕过 progress/labels 校验）
        applyNewFields(next, fields, 'set')
        for (const k of fieldsGiven) {
          if (NEW_FIELD_NAMES.includes(k)) continue
          if (k === 'status') {
            if (!['pending', 'blocked', 'in_progress'].includes(fields.status)) {
              throw new BoardError(
                `board.set：status 只允许 pending | blocked | in_progress（completed 走 complete/accept，deleted 走 delete）`,
                'BOARD_BAD_FIELD',
                { field: 'status', value: fields.status },
              )
            }
            next.status = fields.status
            if (fields.status !== 'in_progress') delete next.lease
          } else if (k === 'expectedComplexity') {
            if (fields[k] === null) delete next.expectedComplexity
            else next.expectedComplexity = normalizeComplexity(fields[k], 'set')
          } else if (k === 'requiresPaid') {
            if (fields[k] === null) delete next.requiresPaid
            else next.requiresPaid = normalizeRequiresPaid(fields[k], 'set')
          } else if (PATCH_FIELDS.includes(k)) {
            next[k] = fields[k]
          } else {
            throw new BoardError(
              `board.set：字段 ${JSON.stringify(k)} 不可直接设置（可改：${PATCH_FIELDS.join(' | ')} | status）`,
              'BOARD_BAD_FIELD',
              { field: k, patchable: PATCH_FIELDS },
            )
          }
        }
        break
      }

      // ── Triage 闸门（P0-B §3）───────────────────────────────────────────
      // 语义：把「创建时随手记下的一条」变成「可以派给人干的一条」。
      // 这一步才允许指定 assignee / priority / dueAt / labels —— 未 triage 的任务
      // 不进 ready()（见 requireTriageForReady），避免「没想清楚就派活」。
      case 'triage': {
        if (isDead(current.status)) {
          throw new BoardError(`board.triage：任务 ${taskId} 已删除，不能 triage`, 'BOARD_TASK_DELETED', { id: taskId })
        }
        if (current.status !== 'pending') {
          throw new BoardError(
            `board.triage：任务 ${taskId} 当前状态是 ${current.status}，只有 pending 才能 triage`,
            'BOARD_BAD_STATE',
            { id: taskId, status: current.status, expected: 'pending' },
          )
        }
        if (current.triaged === true) {
          throw new BoardError(
            `board.triage：任务 ${taskId} 已 triage 过（rev=${current.rev}）——要改派/改优先级请走 edit`,
            'BOARD_ALREADY_TRIAGED',
            { id: taskId },
          )
        }
        next.triaged = true
        // 顺手可写：assignee / priority / dueAt / labels（同一套校验，不另开规则）
        if (fields.assignee !== undefined) {
          if (fields.assignee === null) delete next.assignee
          else next.assignee = normalizeOptionalString(fields.assignee, 'assignee', 'triage')
        }
        if (fields.priority !== undefined && fields.priority !== null) {
          next.priority = optionalNumber(fields.priority, 'priority', 'triage')
        }
        if (fields.dueAt !== undefined && fields.dueAt !== null) {
          next.dueAt = optionalNumber(fields.dueAt, 'dueAt', 'triage')
        }
        if (fields.labels !== undefined && fields.labels !== null) {
          next.labels = normalizeLabels(fields.labels, 'triage')
        }
        break
      }

      // ── 删除（tombstone，不物理删除）─────────────────────────────────────
      case 'delete': {
        if (isDead(current.status)) {
          throw new BoardError(
            `board.delete：任务 ${taskId} 已是 deleted（rev=${current.rev}）——墓碑不重复写`,
            'BOARD_TASK_DELETED',
            { id: taskId },
          )
        }
        const dependents = [...tasks.values()].filter((t) => t.status !== 'deleted' && (t.blockedBy ?? []).includes(taskId))
        if (dependents.length > 0) {
          warn(
            `[cs-bots/board] 删除任务 ${taskId} 会让依赖它的任务永久挂在 blockedBy 上：`
            + `${dependents.map((t) => t.id).join(', ')}（未自动改写 DAG，请人工决定）`,
          )
        }
        next.status = 'deleted'
        next.deletedAt = at
        next.deletedBy = by
        delete next.lease
        break
      }

      default: {
        throw new BoardError(
          `board.update：不支持的 action=${JSON.stringify(action)}（支持：edit | claim | release | heartbeat | `
          + 'complete | reopen | block | delete）',
          'BOARD_BAD_ACTION',
          { action },
        )
      }
    }

    return commit(taskId, action, by, at, before, next)
  }

  /**
   * 过期租约回收：`status==='in_progress'` 且 `lease.expiresAt <= now` → 回 `pending`。
   *
   * **这是封死官方「owner interrupt/崩溃后永不释放」硬伤的关键动作**：
   * 回收即清租约、清 ownerId，再把任务放回待领池，谁也不欠谁。
   *
   * @param {{ now?: number }} [options]
   * @returns {string[]} 被回收的 taskId（创建序）
   */
  function expireLeases(options = {}) {
    const at = normalizeNow(options?.now, 'expireLeases')
    const recycled = []
    for (const current of [...tasks.values()]) {
      if (current.status !== 'in_progress') continue
      if (!current.lease) continue
      const exp = Number(current.lease.expiresAt)
      if (!Number.isFinite(exp)) {
        warn(
          `[cs-bots/board] 任务 ${current.id} 的租约 expiresAt 非法（${JSON.stringify(current.lease.expiresAt)}）`
          + '——不静默放过，本次跳过回收',
        )
        continue
      }
      if (exp > at) continue

      const before = clone(current)
      const next = clone(current)
      next.rev = current.rev + 1
      next.status = 'pending'
      delete next.lease
      delete next.ownerId
      commit(current.id, 'lease_expired', current.lease.ownerId ?? null, at, before, next)
      recycled.push(current.id)
      info(`[cs-bots/board] 租约回收：${current.id} 由 ${current.lease.ownerId} 于 ${new Date(exp).toISOString()} 过期 → pending`)
    }
    return recycled
  }

  /**
   * 记验收动作（官方**没有**这个语义：官方 complete 由 owner 自评自结）。
   *
   * `pass` → 状态置 completed（验收完成）；`reject` → 回 pending 并清租约/产出物，
   * 让任务重新可领。验收结论落在 `task.acceptance`，事件流里也有一条。
   *
   * @param {{ id: string, by: string, result: 'pass'|'reject', note?: string, now?: number }} input
   * @returns {object} 变更后的 Task
   */
  function accept(input = {}) {
    const { id, by, result, note, now } = input ?? {}
    const taskId = requireString(id, 'id', 'accept')
    const actor = requireString(by, 'by', 'accept')
    if (!ACCEPT_RESULTS.includes(result)) {
      throw new BoardError(
        `board.accept：result 必须是 ${ACCEPT_RESULTS.join(' | ')}，收到 ${JSON.stringify(result)}`,
        'BOARD_BAD_ACCEPT_RESULT',
        { result },
      )
    }
    const current = tasks.get(taskId)
    if (!current) {
      throw new BoardError(`board.accept：任务不存在 id=${taskId}`, 'BOARD_TASK_NOT_FOUND', { id: taskId })
    }
    if (current.status === 'deleted') {
      throw new BoardError(`board.accept：任务 ${taskId} 已删除（tombstone），不能验收`, 'BOARD_TASK_DELETED', { id: taskId })
    }
    // ⚠️ 修复（2026-11-04 测试，P1-1）：原来 accept 不检查任务状态，任何状态的
    //   任务都能直接被 accept('pass') 置 completed —— 绕过 complete() 的
    //   blockedBy/lease/artifacts 校验，依赖图收敛逻辑形同虚设。
    //   现在：pass 要求任务已经是 completed（由 owner 完成且带 artifacts 后才验收），
    //   reject 则允许从 completed 打回 pending。
    if (result === 'pass') {
      if (current.status !== 'completed') {
        throw new BoardError(
          `board.accept/pass：任务 ${taskId} 当前状态是 ${current.status}，只有 completed 才能验收通过`,
          'BOARD_BAD_STATE',
          { id: taskId, status: current.status, expected: 'completed' },
        )
      }
      if (current.blockedBy?.length) {
        const unmet = current.blockedBy.filter((d) => {
          const dep = tasks.get(d)
          return dep ? dep.status !== 'completed' && dep.status !== 'deleted' : true
        })
        if (unmet.length > 0) {
          throw new BoardError(
            `board.accept/pass：任务 ${taskId} 的依赖未全部完成（未完成：${unmet.join(', ')}）`,
            'BOARD_BLOCKED_BY_UNMET',
            { id: taskId, unmet },
          )
        }
      }
      if (!current.artifacts || Object.keys(current.artifacts).length === 0) {
        throw new BoardError(
          `board.accept/pass：任务 ${taskId} 没有产出物（artifacts）—— complete() 的不变量未满足`,
          'BOARD_NO_ARTIFACTS',
          { id: taskId },
        )
      }
    } else if (result === 'reject') {
      if (current.status !== 'completed') {
        throw new BoardError(
          `board.accept/reject：任务 ${taskId} 当前状态是 ${current.status}，只有 completed 才能打回`,
          'BOARD_BAD_STATE',
          { id: taskId, status: current.status, expected: 'completed' },
        )
      }
    }
    const at = normalizeNow(now, 'accept')
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    /** @type {Record<string, unknown>} */
    const acceptance = { by: actor, at, result }
    if (note !== undefined && note !== null) acceptance.note = String(note)
    next.acceptance = acceptance
    delete next.lease
    if (result === 'pass') {
      next.status = 'completed'
      next.completedAt = current.completedAt ?? at
      // ⚠️ 修复（2026-11-09）：原来只写 `acceptance` 却从不写 `accepted`，
      //   而 `src/stage.js` 的「已完成且已验收 → idle」分支读的是 `accepted`。
      //   结果是：验收通过的任务永远显示「等你验收」，`person/review` 永不消失，
      //   `needsAttention` 也永远认为它还需要关注 —— 阶段表被一个写侧缺口卡住。
      //   现在 `accepted` 必须由 acceptance 记录推出（**不接受手动 patch**）：
      //   有 acceptance.result==='pass' 才有 accepted=true，两者同生同灭。
      next.accepted = true
    } else {
      next.status = 'pending'
      delete next.ownerId
      delete next.completedAt
      delete next.artifacts // 验收驳回 → 产出物作废（在事件流的 before 里留档）
      delete next.latestReport // 旧的收尾结论一并作废（重做后会重新产生）
      delete next.accepted // 驳回即取消「已验收」，与 acceptance.result='reject' 一致
    }
    return commit(taskId, 'accept', actor, at, before, next)
  }

  /**
   * 从 `board.jsonl` 重建内存态（重启回放一致性）。
   * @returns {{ from: string, tasks: number, events: number, bad: number }}
   */
  function replay() {
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      tasks: tasks.size,
      events: events.length,
      bad: diagnostics.badLines,
    }
  }

  /**
   * 软删除墓碑清理（P0-B §4）：把 deleted 且 deletedAt 早于阈值的任务从内存与快照移除。
   * 事件流**仍保留墓碑**（append-only 真相源），所以 `replay()` 后这些任务会重新出现；
   * purge 是内存/快照层的 housekeeping，不是审计 deletion。
   * @param {{ olderThanMs?: number, now?: number }} [options]
   * @returns {string[]} 被移除的 taskId
   */
  function purgeDeleted(options = {}) {
    const at = normalizeNow(options?.now, 'purgeDeleted')
    const threshold = Number.isFinite(options?.olderThanMs) && options.olderThanMs >= 0
      ? at - options.olderThanMs
      : at
    const removed = []
    for (const [id, t] of [...tasks.entries()]) {
      if (t.status !== 'deleted') continue
      if (typeof t.deletedAt !== 'number' || !Number.isFinite(t.deletedAt)) continue
      if (t.deletedAt < threshold) {
        tasks.delete(id)
        removed.push(id)
      }
    }
    if (removed.length > 0) {
      if (!writeJsonAtomic(snapPath, snapshot())) {
        diagnostics.snapshotWriteFailures += 1
        warn(`[cs-bots/board] purgeDeleted 快照写入失败（${snapPath}）——事件流仍保留墓碑，replay() 可恢复`)
      }
    }
    return removed
  }

  /** 首次构造即回放，保证 `list()` 在重启后马上可用。 */
  hydrate()

  /**
   * 统计（给 /status 与 UI 概览用）。
   * ⚠️ 修复（2026-11-04 测试，P2-2）：board 之前没有 `stats()`，`/status` 与
   *   UI 概览里任务数恒显示 `—`。
   */
  function stats() {
    const byStatus = {}
    let total = 0, ready = 0, blocked = 0, inProgress = 0, completed = 0, deleted = 0
    for (const t of tasks.values()) {
      total += 1
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
      if (t.status === 'in_progress') inProgress += 1
      else if (t.status === 'blocked') blocked += 1
      else if (t.status === 'completed') completed += 1
      else if (t.status === 'deleted') deleted += 1
      else if (t.status === 'pending' && unfinishedDeps(t).length === 0) ready += 1
    }
    return { total, ready, blocked, inProgress, completed, deleted, byStatus, events: events.length }
  }

  const board = {
    name: config.name ?? 'board',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    create,
    get,
    stats,
    list,
    update,
    ready,
    needsAttention,
    purgeDeleted,
    expireLeases,
    accept,
    replay,
    history,
    diagnostics: () => clone(diagnostics),
  }
  return board
}

export default createBoard
