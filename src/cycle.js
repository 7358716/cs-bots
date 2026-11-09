/**
 * cs-bots CycleService —— PDCA 复盘与标准化（Act）。
 *
 * 为什么需要它：PDCA 的「Act」此前没有落点 —— 周期结束后经验无处沉淀，
 * 下次照样踩同一个坑。本模块给一个任务绑定一个「周期」，强制走完
 * planned → doing → checking → acting → done 四步，**不许跳步**（跳步即抛
 * `CYCLE_BAD_PHASE_FLOW`）—— 这正是「持续优化」的纪律。
 *
 * 复盘（review）会把 lessons 提议成记忆建议、standards 提议成纪律建议，
 * 走既有的「建议确认制」：**模型只提议，人点采纳才落库**。suggest 缺失或抛错时
 * 降级为「只记复盘内容」，绝不阻断、绝不假装建议已提。
 *
 * 不变量：事件流真相源 / 只追加 / 绝不静默失败 / CAS。
 * 依赖面：node 内置 + `./store.js` + `./kernel.js`。零第三方依赖。
 */

import { appendJsonl, readJsonl, statePath, writeJsonAtomic } from './store.js'

let kernel = null
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

/**
 * 周期类型（需求4，2026-11-08）。
 *
 * 用户原话：「我要求 pdca 是对用户长任务进行复盘跟进的，人类主导；
 *            智能体的 pdca 流程你优化一下，看看有没有必要或优化，
 *            我关心的是用户能否对长任务进行管理，智能体的 pdca 需要定期归纳提升」
 *
 * ⇒ 两种周期，语义完全不同，**不能混在一起**：
 *
 * | kind | 谁主导 | 用来干什么 | 阶段纪律 |
 * |---|---|---|---|
 * | `human` | **人** | 跟一个长任务：目标漂移没有、卡在哪、下一步是什么 | 强制走完五步（人不许跳步，防自欺） |
 * | `agent` | 智能体 | 事后归纳：同类问题是否重复出现、该沉淀什么标准 | **可以一次性提交**（见 `review` 的快捷路径） |
 *
 * 为什么 agent 周期不强制走五步：智能体的复盘是「批量归纳」，
 * 让它假装走 planned→doing 是对事实的虚构；人需要的是「结论 + 可采纳的标准」。
 * 但**归纳本身要定期发生**——由 reviewer 的回合计数驱动（见 `reviewer.js`）。
 */

/** 合法周期类型。 */
export const CYCLE_KINDS = Object.freeze(['human', 'agent'])

/** 合法阶段（顺序即流转顺序）。 */
export const CYCLE_PHASES = Object.freeze(['planned', 'doing', 'checking', 'acting', 'done'])

/** 合法状态。 */
export const CYCLE_STATUSES = Object.freeze(['open', 'closed'])

/** 合法动作。 */
export const CYLE_ACTIONS = Object.freeze(['start', 'advance', 'check', 'review', 'close'])

/** 阶段流转表（下一步只允许这些）：不许跳步。 */
const NEXT_PHASE = Object.freeze({
  planned: 'doing',
  doing: 'checking',
  checking: 'acting',
  acting: 'done',
})

/** 结构化错误。 */
export class CycleError extends Error {
  constructor(message, code = 'CYCLE_ERROR', details) {
    super(message)
    this.name = 'CycleError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeNow(now, where) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new CycleError(`cycle.${where}：now 必须是有限数字，收到 ${JSON.stringify(now)}`, 'CYCLE_BAD_FIELD', { where, field: 'now' })
  }
  return now
}

function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CycleError(`cycle.${where}：${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`, 'CYCLE_BAD_FIELD', { where, field })
  }
  return value.trim()
}

function requirePlainObject(value, where) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CycleError(`cycle.${where}：必须是普通对象，收到 ${JSON.stringify(value)}`, 'CYCLE_BAD_FIELD', { where })
  }
  return value
}

function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') return config.stateDir.trim()
  if (kernel && typeof kernel.stateDir === 'function') return kernel.stateDir()
  const reason = kernelError?.message ?? 'kernel.stateDir 不存在'
  throw new CycleError(`cycle.createCycle：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`, 'CYCLE_NO_STATE_DIR')
}

function splitArgs(ctx, config) {
  const cfgGiven = config && typeof config === 'object' && Object.keys(config).length > 0
  if (cfgGiven) return { context: ctx ?? {}, config }
  if (ctx && typeof ctx === 'object' && typeof ctx.stateDir === 'string') return { context: {}, config: ctx }
  return { context: ctx ?? {}, config: config ?? {} }
}

/** 字符串数组归一（≤20 条，每条 ≤2000）。 */
function stringList(value, field, where) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new CycleError(`cycle.${where}：${field} 必须是数组，收到 ${JSON.stringify(value)}`, 'CYCLE_BAD_FIELD', { where, field })
  }
  if (value.length > 20) {
    throw new CycleError(`cycle.${where}：${field} 最多 20 条（收到 ${value.length}）`, 'CYCLE_BAD_FIELD', { where, field })
  }
  return value.map((v) => {
    if (typeof v !== 'string') {
      throw new CycleError(`cycle.${where}：${field} 每项必须是非空字符串`, 'CYCLE_BAD_FIELD', { where, field })
    }
    const t = v.trim()
    if (t.length === 0) throw new CycleError(`cycle.${where}：${field} 每项必须非空`, 'CYCLE_BAD_FIELD', { where, field })
    if (t.length > 2000) {
      throw new CycleError(`cycle.${where}：${field} 每项 ≤2000 字符（收到 ${t.length}）`, 'CYCLE_BAD_FIELD', { where, field })
    }
    return t
  })
}

function progressOf(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new CycleError(`cycle.${where}：progress 必须在 0-100 之间，收到 ${JSON.stringify(value)}`, 'CYCLE_BAD_FIELD', { where, field: 'progress' })
  }
  return value
}

/**
 * 创建复盘服务。
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx]
 * @param {{ stateDir?: string, name?: string, suggest?: object }} [config]
 * @returns {object} cycle service
 */
export function createCycle(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'cycle.jsonl')
  const snapPath = statePath(stateDir, 'cycle.snap.json')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* */ } }

  const suggestions = cfg.suggest ?? null
  const entries = new Map()
  const events = []
  let idCounter = 0
  let disposed = false

  const diagnostics = {
    stateDir, jsonlPath, snapPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: null, replayedEvents: 0, badLines: 0,
    snapshotWriteFailures: 0, lastReplayAt: undefined,
    suggestAvailable: suggestions !== null,
    suggestFailures: 0,
  }

  function assertAlive(where) {
    if (disposed) {
      throw new CycleError(`cycle.${where}：实例已 dispose()，请重新 createCycle()（拒绝在已销毁实例上静默返回空数据）`, 'CYCLE_DISPOSED', { where })
    }
  }

  function snapshot() { return { version: 1, savedAt: Date.now(), entries: [...entries.values()] } }

  function commit(action, at, by, before, after) {
    if (!appendJsonl(jsonlPath, { id: after.id, rev: after.rev, action, by, at, before, after })) {
      throw new CycleError(`cycle.${action}：事件追加失败（${jsonlPath}）—— 拒绝「只改内存不落盘」`, 'CYCLE_APPEND_FAILED', { action })
    }
    entries.set(after.id, clone(after))
    events.push({ id: after.id, rev: after.rev, action, by, at, before: before ? clone(before) : null, after: clone(after) })
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/cycle] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可恢复`)
    }
  }

  function hydrate() {
    entries.clear(); events.length = 0; idCounter = 0
    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) warn(`[cs-bots/cycle] ${jsonlPath} 有 ${bad} 行无法解析——已跳过，请核对`)
    if (rows.length === 0) { diagnostics.hydratedFrom = 'empty'; return }
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.id !== 'string' || !ev.after) { skipped += 1; continue }
      const current = entries.get(ev.id)
      if (current && Number.isFinite(ev.rev) && ev.rev <= current.rev) { skipped += 1; continue }
      entries.set(ev.id, clone(ev.after)); events.push(clone(ev))
      const m = /^c-(\d+)$/.exec(ev.id)
      if (m) idCounter = Math.max(idCounter, Number(m[1]))
    }
    if (skipped > 0) warn(`[cs-bots/cycle] 回放跳过 ${skipped} 条非递增/残缺事件`)
    diagnostics.hydratedFrom = 'jsonl'
  }

  function requireTask(id, where) {
    const t = entries.get(id)
    if (!t) throw new CycleError(`cycle.${where}：周期 ${id} 不存在`, 'CYCLE_NOT_FOUND', { where, id })
    return t
  }

  /** CAS：返回当前任务或抛错。 */
  function cas(id, expectedRev, where) {
    const t = requireTask(id, where)
    if (expectedRev !== undefined && expectedRev !== null) {
      if (!Number.isInteger(expectedRev)) {
        throw new CycleError(`cycle.${where}：expectedRev 必须是整数（当前 rev=${t.rev}）`, 'CYCLE_BAD_FIELD', { where, field: 'expectedRev' })
      }
      if (t.rev !== expectedRev) {
        throw new CycleError(
          `cycle.${where} CAS 冲突：周期 ${id} 期望 rev=${expectedRev}，实际 rev=${t.rev} —— 拒绝静默覆盖`,
          'CYCLE_REV_CONFLICT', { where, id, expectedRev, rev: t.rev },
        )
      }
    }
    return t
  }

  // ── API：写 ────────────────────────────────────────────────────────────────

  /**
   * 为一个任务开一个复盘周期。
   * @param {{ taskId: string, objective: string, cycle?: string, milestone?: string,
   *           estimate?: number, kind?: 'human'|'agent', by: string, now?: number }} input
   */
  function start(input = {}) {
    assertAlive('start')
    const { taskId, objective, cycle, milestone, estimate, kind, by, now } = input ?? {}
    const taskIdNorm = requireString(taskId, 'taskId', 'start')
    const objectiveNorm = requireString(objective, 'objective', 'start')
    const author = requireString(by, 'by', 'start')
    const at = normalizeNow(now, 'start')
    const est = progressOf(estimate, 'start')
    // 需求4：kind 决定这是「人跟长任务」还是「智能体事后归纳」
    const kindNorm = kind === undefined || kind === null ? 'human' : String(kind)
    if (!CYCLE_KINDS.includes(kindNorm)) {
      throw new CycleError(
        `cycle.start：kind=${JSON.stringify(kind)} 非法（合法：${CYCLE_KINDS.join(' | ')}）`,
        'CYCLE_BAD_KIND', { kind },
      )
    }

    idCounter += 1
    const id = `c-${idCounter}`
    /** @type {Record<string, unknown>} */
    const rec = {
      id, rev: 1, taskId: taskIdNorm, objective: objectiveNorm,
      cycle: cycle ?? null, milestone: milestone ?? null, estimate: est ?? null,
      kind: kindNorm,
      status: 'open', phase: 'planned', progress: 0,
      review: null, closedAt: null,
      createdAt: at, createdBy: author, updatedAt: at, updatedBy: author,
    }
    commit('start', at, author, null, rec)
    info(`[cs-bots/cycle] 周期 ${id} 开启（task=${taskIdNorm}，phase=planned）`)
    return clone(rec)
  }

  /**
   * 推进阶段。**不许跳步**：planned→doing→checking→acting→done。
   * @param {{ id: string, expectedRev?: number, phase: string, progress?: number, evidence?: string, by: string, now?: number }} input
   */
  function advance(input = {}) {
    assertAlive('advance')
    const { id, expectedRev, phase, progress, evidence, by, now } = input ?? {}
    const author = requireString(by, 'by', 'advance')
    const at = normalizeNow(now, 'advance')
    if (!CYCLE_PHASES.includes(phase)) {
      throw new CycleError(`cycle.advance：phase=${JSON.stringify(phase)} 非法（合法：${CYCLE_PHASES.join(' | ')}）`, 'CYCLE_BAD_PHASE', { phase })
    }
    const current = cas(id, expectedRev, 'advance')
    if (current.phase === 'done') {
      throw new CycleError(`cycle.advance：周期 ${id} 已完成，不可再推进`, 'CYCLE_ALREADY_DONE', { id })
    }
    const expectedNext = NEXT_PHASE[current.phase]
    if (phase !== expectedNext) {
      throw new CycleError(
        `cycle.advance 阶段流转非法：周期 ${id} 当前 ${current.phase}，下一步只能是 ${expectedNext}，收到 ${phase} —— 不许跳步`,
        'CYCLE_BAD_PHASE_FLOW',
        { id, current: current.phase, expected: expectedNext, received: phase },
      )
    }
    const next = clone(current)
    next.rev = current.rev + 1
    next.phase = phase
    if (phase === 'done') {
      next.status = 'closed'
      next.closedAt = at
    }
    const prog = progressOf(progress, 'advance')
    if (prog !== undefined) next.progress = prog
    if (evidence !== undefined && evidence !== null) {
      next.evidence = String(evidence).slice(0, 4000)
    }
    next.updatedAt = at
    next.updatedBy = author
    commit('advance', at, author, clone(current), next)
    info(`[cs-bots/cycle] 周期 ${id} → ${phase}`)
    return clone(next)
  }

  /**
   * 记录一次检查结果。reject 打回 doing（重做），pass 前进到 acting。
   * @param {{ id: string, expectedRev?: number, result: 'pass'|'reject', evidence?: string, by: string, now?: number }} input
   */
  function check(input = {}) {
    assertAlive('check')
    const { id, expectedRev, result, evidence, by, now } = input ?? {}
    const author = requireString(by, 'by', 'check')
    const at = normalizeNow(now, 'check')
    if (!['pass', 'reject'].includes(result)) {
      throw new CycleError(`cycle.check：result 必须是 pass | reject（收到 ${JSON.stringify(result)}）`, 'CYCLE_BAD_FIELD', { field: 'result' })
    }
    const current = cas(id, expectedRev, 'check')
    const next = clone(current)
    next.rev = current.rev + 1
    if (result === 'pass') {
      next.phase = 'acting'
    } else {
      // 驳回 → 打回重做（doing）。progress 不变（重做不退款，也不前进）。
      next.phase = 'doing'
      next.rejectedAt = at
      next.rejectCount = (next.rejectCount ?? 0) + 1
    }
    if (evidence !== undefined && evidence !== null) next.checkEvidence = String(evidence).slice(0, 4000)
    next.updatedAt = at
    next.updatedBy = author
    commit('check', at, author, clone(current), next)
    info(`[cs-bots/cycle] 周期 ${id} 检查 ${result} → ${next.phase}`)
    return clone(next)
  }

  /**
   * 复盘（Act）：记录经验教训，并提议标准化建议。
   * @param {{ id: string, expectedRev?: number, summary: string, lessons?: string[],
   *           standards?: {scope: string, scopeId?: string, kind: string, title: string, content: string}[],
   *           by: string, now?: number }} input
   */
  function review(input = {}) {
    assertAlive('review')
    const { id, expectedRev, summary, lessons, standards, by, now } = input ?? {}
    const author = requireString(by, 'by', 'review')
    const at = normalizeNow(now, 'review')
    const summaryNorm = requireString(summary, 'summary', 'review')
    if (summaryNorm.length > 8000) {
      throw new CycleError(`cycle.review：summary ≤8000 字符（收到 ${summaryNorm.length}）`, 'CYCLE_BAD_FIELD', { field: 'summary' })
    }
    const lessonList = stringList(lessons, 'lessons', 'review')
    const standardList = Array.isArray(standards) ? standards : []
    if (standardList.length > 20) {
      throw new CycleError(`cycle.review：standards 最多 20 条（收到 ${standardList.length}）`, 'CYCLE_BAD_FIELD', { field: 'standards' })
    }

    const current = cas(id, expectedRev, 'review')
    // 需求4：human 周期强制 acting 阶段（人不许跳步，防自欺）；
    //        agent 周期是批量归纳，允许一次性提交（不必假装走完 planned→doing→checking）。
    const isAgent = (current.kind ?? 'human') === 'agent'
    if (!isAgent && current.phase !== 'acting') {
      throw new CycleError(
        `cycle.review：周期 ${id} 当前阶段 ${current.phase}，复盘只能在 acting 阶段做 —— 请先 check pass`
        + '（只有 agent 类型的周期允许一次性提交）',
        'CYCLE_BAD_PHASE',
        { id, phase: current.phase, kind: current.kind ?? 'human' },
      )
    }

    // ── 先记复盘内容（事件流是真相源；建议提议失败绝不阻断这一步）──
    const next = clone(current)
    next.rev = current.rev + 1
    next.review = { summary: summaryNorm, lessons: lessonList, standards: clone(standardList), at, by: author }
    next.updatedAt = at
    next.updatedBy = author
    commit('review', at, author, clone(current), next)
    info(`[cs-bots/cycle] 周期 ${id} 复盘完成（${lessonList.length} 条教训，${standardList.length} 条标准化建议）`)

    // ── 提议标准化建议（走「建议确认制」；suggest 缺失/抛错 → 降级）──
    /** @type {object[]} */
    const proposed = []
    if (!suggestions || typeof suggestions.suggest !== 'function') {
      warn(`[cs-bots/cycle] suggest 服务不可用 → 周期 ${id} 的复盘已记录，但标准化建议未提议（需人工整理）`)
      return { cycle: clone(next), suggestions: [], proposedCount: 0, degraded: true }
    }
    for (const s of standardList) {
      try {
        const out = suggestions.suggest({
          kind: 'discipline',
          payload: {
            scope: s.scope,
            scopeId: s.scopeId ?? null,
            kind: s.kind,
            title: s.title,
            content: s.content,
          },
          reason: `周期 ${id}（${current.taskId}）复盘标准化`,
          source: 'cycle-review',
          by: author,
          confidence: 0.7,
        })
        proposed.push({ kind: 'discipline', id: out.id, title: s.title })
      } catch (error) {
        diagnostics.suggestFailures += 1
        warn(`[cs-bots/cycle] 周期 ${id} 提议纪律建议失败（${error?.message ?? error}）—— 复盘内容已落盘，建议未提`)
      }
    }
    for (const lesson of lessonList) {
      try {
        const out = suggestions.suggest({
          kind: 'memory',
          layer: 'L2',
          payload: { content: lesson, tags: ['cycle-review', current.taskId ?? 'unknown'] },
          reason: `周期 ${id}（${current.taskId}）复盘教训`,
          source: 'cycle-review',
          by: author,
          confidence: 0.6,
        })
        proposed.push({ kind: 'memory', id: out.id, title: lesson.slice(0, 60) })
      } catch (error) {
        diagnostics.suggestFailures += 1
        warn(`[cs-bots/cycle] 周期 ${id} 提议教训记忆失败（${error?.message ?? error}）`)
      }
    }
    // 需求4：agent 周期归纳完即闭环——智能体不需要「人点完成」这个仪式；
    //        human 周期留在 acting，由人显式 advance 到 done（人要对复盘结论负责）。
    if (isAgent) {
      const closed = clone(next)
      closed.rev = next.rev + 1
      closed.phase = 'done'
      closed.status = 'closed'
      closed.closedAt = at
      closed.updatedAt = at
      closed.updatedBy = author
      commit('advance', at, author, clone(next), closed)
      info(`[cs-bots/cycle] 周期 ${id}（agent）归纳完成 → done`)
      return { cycle: clone(closed), suggestions: proposed, proposedCount: proposed.length, degraded: false, autoClosed: true }
    }

    return { cycle: clone(next), suggestions: proposed, proposedCount: proposed.length, degraded: false, autoClosed: false }
  }

  // ── API：读 ────────────────────────────────────────────────────────────────

  function list(query = {}) {
    assertAlive('list')
    let rows = [...entries.values()]
    // 需求4：按 kind 分离——人只关心 human 周期（长任务跟进），不着 AI 的归纳周期
    if (query?.kind !== undefined && query?.kind !== null) rows = rows.filter((r) => (r.kind ?? 'human') === query.kind)
    if (query?.status !== undefined && query?.status !== null) rows = rows.filter((r) => r.status === query.status)
    if (query?.phase !== undefined && query?.phase !== null) rows = rows.filter((r) => r.phase === query.phase)
    if (query?.taskId !== undefined && query?.taskId !== null) rows = rows.filter((r) => r.taskId === query.taskId)
    return clone(rows)
  }

  function get(id) {
    assertAlive('get')
    const t = entries.get(id)
    return t ? clone(t) : null
  }

  function stats() {
    const byPhase = {}
    const byStatus = {}
    const byKind = {}
    for (const r of entries.values()) {
      byPhase[r.phase] = (byPhase[r.phase] ?? 0) + 1
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
      const k = r.kind ?? 'human'
      byKind[k] = (byKind[k] ?? 0) + 1
    }
    return { total: entries.size, open: byStatus.open ?? 0, closed: byStatus.closed ?? 0, byPhase, byStatus, byKind, events: events.length, diagnostics: clone(diagnostics) }
  }

  function replay() { hydrate(); diagnostics.lastReplayAt = Date.now(); return { from: diagnostics.hydratedFrom, events: events.length, bad: diagnostics.badLines } }
  function dispose() { disposed = true }

  hydrate()

  return {
    name: cfg.name ?? 'cycle',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    start,
    advance,
    check,
    review,
    list,
    get,
    stats,
    replay,
    diagnostics: () => clone(diagnostics),
    dispose,
  }
}

export default createCycle
