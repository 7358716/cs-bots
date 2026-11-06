/**
 * cs-bots MetricsService —— PDCA 测量面（Check 的数据基础）。
 *
 * 为什么需要它：PDCA 的「持续优化」没有测量就是空话。平台此前只有任务状态
 * （status/rev），没有「周期过了多久 / 驳回率多少 / 吞吐多少」这类指标。
 * 本模块是**纯被动记账**：任何动作（claim/complete/accept/review…）记一条，
 * 聚合交给 `aggregate()`。不做定时器、不主动采集 —— 与 reviewer.js 同款哲学。
 *
 * 不变量（照抄 suggest.js / board.js 纪律）：
 *   1. **事件流是真相源**：先 append jsonl（失败即抛，内存回滚），再改内存，
 *      最后写快照（失败只 warn + 计数，因为事件流已落盘，replay 可恢复）。
 *   2. **只追加，绝不改写历史**。
 *   3. **绝不静默失败**。
 *
 * 依赖面：node 内置 + `./store.js` + `./kernel.js`（惰性桥）。零第三方依赖。
 */

import { appendJsonl, readJsonl, statePath, writeJsonAtomic } from './store.js'

// ── kernel 惰性桥（照抄 suggest.js：静态 import 会让裸检出连带失败）────────────
/** @type {object | null} */
let kernel = null
/** @type {unknown} */
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

/** 合法指标种类。新增种类必须同步加测试。 */
export const METRIC_KINDS = Object.freeze([
  'cycle_start', 'cycle_complete', 'review_proposed', 'review_done',
  'accept_pass', 'accept_reject', 'task_claim', 'task_complete', 'task_blocked',
  'lead_create', 'bot_create', 'room_create', 'turn_end',
])

/** 结构化错误：所有失败都走它，绝不静默。 */
export class MetricsError extends Error {
  constructor(message, code = 'METRICS_ERROR', details) {
    super(message)
    this.name = 'MetricsError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** 深拷贝 + JSON 归一（去掉 undefined 键，保证内存态与磁盘态逐字相等）。 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** `now` 归一：缺省当前时间；显式必须是有限数字。 */
function normalizeNow(now, where) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new MetricsError(
      `metrics.${where}：now 必须是有限数字（毫秒时间戳），收到 ${JSON.stringify(now)}`,
      'METRICS_BAD_FIELD',
      { where, field: 'now' },
    )
  }
  return now
}

/** 必填字符串（trim 后非空）。 */
function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MetricsError(
      `metrics.${where}：${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
      'METRICS_BAD_FIELD',
      { where, field },
    )
  }
  return value.trim()
}

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**（与 board.js 同一纪律）：兜到临时目录会让数据重启即丢。
 */
function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') {
    return config.stateDir.trim()
  }
  if (kernel && typeof kernel.stateDir === 'function') return kernel.stateDir()
  const reason = kernelError?.message ?? 'kernel.stateDir 不存在'
  throw new MetricsError(
    `metrics.createMetrics：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'METRICS_NO_STATE_DIR',
  )
}

/** `(ctx, config)` 归一，允许单参数简写（与 suggest.js 同款）。 */
function splitArgs(ctx, config) {
  const cfgGiven = config && typeof config === 'object' && Object.keys(config).length > 0
  if (cfgGiven) return { context: ctx ?? {}, config }
  if (ctx && typeof ctx === 'object' && typeof ctx.stateDir === 'string') return { context: {}, config: ctx }
  return { context: ctx ?? {}, config: config ?? {} }
}

/**
 * 创建测量服务实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（只用于日志）
 * @param {{ stateDir?: string, name?: string }} [config]
 * @returns {object} metrics service
 */
export function createMetrics(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'metrics.jsonl')
  const snapPath = statePath(stateDir, 'metrics.snap.json')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} id → 记录 */
  const entries = new Map()
  /** @type {object[]} 全部事件（审计流） */
  const events = []
  let idCounter = 0
  let disposed = false

  const diagnostics = {
    stateDir,
    jsonlPath,
    snapPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: /** @type {null|'jsonl'|'empty'} */ (null),
    replayedEvents: 0,
    badLines: 0,
    snapshotWriteFailures: 0,
    lastReplayAt: /** @type {number|undefined} */ (undefined),
  }

  /** 已销毁实例的调用一律抛错（静默返回空数据比崩掉更难查）。 */
  function assertAlive(where) {
    if (disposed) {
      throw new MetricsError(
        `metrics.${where}：实例已 dispose()，请重新 createMetrics()（拒绝在已销毁实例上静默返回空数据）`,
        'METRICS_DISPOSED',
        { where },
      )
    }
  }

  /**
   * 提交一次变更：**先落事件，再改内存**。顺序不可颠倒。
   */
  function commit(action, at, by, before, after) {
    if (!appendJsonl(jsonlPath, { id: after.id, rev: after.rev, action, by, at, before, after })) {
      throw new MetricsError(
        `metrics.${action}：事件追加失败（${jsonlPath}）—— 拒绝「只改内存不落盘」`,
        'METRICS_APPEND_FAILED',
        { action },
      )
    }
    entries.set(after.id, clone(after))
    events.push({
      id: after.id, rev: after.rev, action, by, at,
      before: before ? clone(before) : null,
      after: clone(after),
    })
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/metrics] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可恢复`)
    }
  }

  function snapshot() {
    return { version: 1, savedAt: Date.now(), entries: [...entries.values()] }
  }

  /** 从 `metrics.jsonl` 重建内存态；坏行**不静默丢弃**。 */
  function hydrate() {
    entries.clear()
    events.length = 0
    idCounter = 0
    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) {
      warn(`[cs-bots/metrics] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }
    if (rows.length === 0) {
      diagnostics.hydratedFrom = 'empty'
      return
    }
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.id !== 'string') { skipped += 1; continue }
      if (!ev.after || typeof ev.after !== 'object') { skipped += 1; continue }
      const current = entries.get(ev.id)
      if (current && Number.isFinite(ev.rev) && ev.rev <= current.rev) {
        // 同 rev 重放幂等（容忍重复投递）
        skipped += 1
        continue
      }
      entries.set(ev.id, clone(ev.after))
      events.push(clone(ev))
      const m = /^m-(\d+)$/.exec(ev.id)
      if (m) idCounter = Math.max(idCounter, Number(m[1]))
    }
    if (skipped > 0) {
      warn(`[cs-bots/metrics] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }
    diagnostics.hydratedFrom = 'jsonl'
  }

  // ── API：写 ────────────────────────────────────────────────────────────────

  /**
   * 记一条指标。
   * @param {{ kind: string, taskId?: string, cycleId?: string, sessionId?: string,
   *           value?: number, labels?: object, by: string, now?: number, source?: string }} input
   * @returns {object} 完整记录
   */
  function record(input = {}) {
    assertAlive('record')
    const { kind, taskId, cycleId, sessionId, value, labels, by, now, source } = input ?? {}
    if (!METRIC_KINDS.includes(kind)) {
      throw new MetricsError(
        `metrics.record：kind=${JSON.stringify(kind)} 非法（合法：${METRIC_KINDS.join(' | ')}）`,
        'METRICS_BAD_KIND',
        { kind },
      )
    }
    const author = requireString(by, 'by', 'record')
    const at = normalizeNow(now, 'record')

    let val = null
    if (value !== undefined && value !== null) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new MetricsError(
          `metrics.record：value 必须是有限数字，收到 ${JSON.stringify(value)}`,
          'METRICS_BAD_FIELD',
          { field: 'value' },
        )
      }
      val = value
    }
    const lab = labels !== undefined && labels !== null ? clone(labels) : null

    idCounter += 1
    const id = `m-${idCounter}`
    /** @type {Record<string, unknown>} */
    const rec = {
      id,
      rev: 1,
      kind,
      taskId: taskId ?? null,
      cycleId: cycleId ?? null,
      sessionId: sessionId ?? null,
      value: val,
      labels: lab,
      source: source ?? 'model',
      at,
      by: author,
      createdAt: at,
      updatedAt: at,
    }
    commit('record', at, author, null, rec)
    info(`[cs-bots/metrics] 记录 ${id}（${kind}）by ${author}`)
    return clone(rec)
  }

  // ── API：读 ────────────────────────────────────────────────────────────────

  /** 按条件取记录（at 升序）。 */
  function series(query = {}) {
    assertAlive('series')
    const { kind, taskId, since, until, limit } = query ?? {}
    let rows = [...entries.values()]
    if (kind !== undefined && kind !== null) rows = rows.filter((r) => r.kind === kind)
    if (taskId !== undefined && taskId !== null) rows = rows.filter((r) => r.taskId === taskId)
    if (since !== undefined && since !== null) rows = rows.filter((r) => r.at >= since)
    if (until !== undefined && until !== null) rows = rows.filter((r) => r.at <= until)
    rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    if (Number.isInteger(limit) && limit > 0) rows = rows.slice(-limit)
    return clone(rows)
  }

  /** 聚合：按 kind 计数 + 求和 + 首末时间。 */
  function aggregate(query = {}) {
    assertAlive('aggregate')
    const { kind, since } = query ?? {}
    const byKind = {}
    let total = 0
    let sum = 0
    let firstAt = null
    let lastAt = null
    for (const r of entries.values()) {
      if (kind !== undefined && kind !== null && r.kind !== kind) continue
      if (since !== undefined && since !== null && r.at < since) continue
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
      total += 1
      if (r.value !== null && r.value !== undefined) sum += r.value
      if (firstAt === null || r.at < firstAt) firstAt = r.at
      if (lastAt === null || r.at > lastAt) lastAt = r.at
    }
    return { byKind, total, sum, firstAt, lastAt }
  }

  function stats() {
    const byKind = {}
    for (const r of entries.values()) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    return { total: entries.size, byKind, events: events.length, diagnostics: clone(diagnostics) }
  }

  function replay() {
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return { from: diagnostics.hydratedFrom, events: events.length, bad: diagnostics.badLines }
  }

  function dispose() { disposed = true }

  /** 首次构造即回放，保证重启后马上可用。 */
  hydrate()

  const service = {
    name: cfg.name ?? 'metrics',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    record,
    series,
    aggregate,
    stats,
    replay,
    diagnostics: () => clone(diagnostics),
    dispose,
  }
  return service
}

export default createMetrics
