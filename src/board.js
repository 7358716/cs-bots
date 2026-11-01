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

// ── 常量 ────────────────────────────────────────────────────────────────────

/** `description` 上限（§3.3）。 */
const MAX_DESCRIPTION = 16384
/** 合法状态集合。 */
const STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'deleted']
/** 验收结果集合。 */
const ACCEPT_RESULTS = ['pass', 'reject']
/** 租约缺省 TTL（ms）。 */
const DEFAULT_LEASE_MS = 300_000
/** 字段补丁允许改的字段（**不含 status**，见文件头不变量 3）。 */
const PATCH_FIELDS = ['subject', 'description', 'blockedBy', 'writeScopes', 'priority', 'dueAt']
/** 事件动作集合。 */
const ACTIONS = ['create', 'edit', 'claim', 'release', 'heartbeat', 'complete', 'reopen', 'block', 'delete', 'accept', 'lease_expired']

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

/** `complete` 的产出物证据归一：非空字符串或非空数组（元素为字符串/对象）。 */
function normalizeArtifacts(value, taskId) {
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
  function list(options = {}) {
    const { status } = options ?? {}
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
    for (const t of tasks.values()) {
      if (status) {
        if (t.status === status) out.push(clone(t))
      } else if (t.status !== 'deleted') {
        out.push(clone(t))
      }
    }
    return out
  }

  /**
   * 就绪任务：`status === 'pending'` **且**全部 blockedBy 都已 completed（依赖整图校验）。
   * 纯读操作，不做租约回收（租约回收请显式调用 `expireLeases()`）。
   * @returns {object[]} 创建序
   */
  function ready() {
    const out = []
    for (const t of tasks.values()) {
      if (t.status !== 'pending') continue
      if (unfinishedDeps(t).length === 0) out.push(clone(t))
    }
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
    const { subject, description, blockedBy, writeScopes, priority, dueAt, byId, sourceSeq, now } = input ?? {}
    const by = requireString(byId, 'byId', 'create')
    const subj = requireString(subject, 'subject', 'create')
    const desc = normalizeDescription(description, 'create')
    const deps = stringList(blockedBy, 'blockedBy', 'create')
    const scopes = stringList(writeScopes, 'writeScopes', 'create')
    const prio = optionalNumber(priority, 'priority', 'create')
    const due = optionalNumber(dueAt, 'dueAt', 'create')
    const seq = sourceSeq === undefined || sourceSeq === null
      ? undefined
      : requireString(sourceSeq, 'sourceSeq', 'create')

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
      rev: 1,
      subject: subj,
      description: desc,
      status: 'pending',
      blockedBy: deps,
      writeScopes: scopes,
      createdAt: at,
      createdBy: by,
    }
    if (prio !== undefined) task.priority = prio
    if (due !== undefined) task.dueAt = due
    if (seq !== undefined) task.sourceSeq = seq

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
      artifacts, note, leaseMs, force, ...fields
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
        next.status = 'in_progress'
        next.ownerId = by
        next.lease = { ownerId: by, expiresAt: at + ttl, heartbeatAt: at }
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
        next.artifacts = normalizeArtifacts(artifacts, taskId)
        next.status = 'completed'
        next.completedAt = at
        next.ownerId = current.ownerId ?? by
        delete next.lease
        delete next.acceptance // 完成即待验收，旧的验收结论作废（历史在事件流里）
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
        if (note !== undefined && note !== null) next.blockedReason = String(note)
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
    } else {
      next.status = 'pending'
      delete next.ownerId
      delete next.completedAt
      delete next.artifacts // 验收驳回 → 产出物作废（在事件流的 before 里留档）
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

  /** 首次构造即回放，保证 `list()` 在重启后马上可用。 */
  hydrate()

  const board = {
    name: config.name ?? 'board',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    create,
    get,
    list,
    update,
    ready,
    expireLeases,
    accept,
    replay,
    history,
    diagnostics: () => clone(diagnostics),
  }
  return board
}

export default createBoard
