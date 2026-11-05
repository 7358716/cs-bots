/**
 * cs-bots ReviewerService —— 审查调度器（回合内自我审查的**计数器**，DESIGN-v2 §「审查调度」）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 「每 N 回合该自我审查一次」听起来简单，但真正难的是**跨重启不丢计数**：
 *   - 纯内存计数 → 每次进程重启归零 → 审查永远到不了期（`due` 恒 false）；
 *   - 用 `Date.now()` 判间隔 → 用户休息 8 小时也该审一次吗？不该，**回合数**才是语义；
 *   - 自己起 `setInterval` 定时器 → 宿主生命周期不可控（插件卸载/热更新后定时器泄漏，
 *     或者会话空闲时审查根本不该跑）。
 * 所以本模块是**纯被动记账**：上层在每回合调一次 `noteTurn()`，它只负责「数到 N 没有」。
 * 到期后**干什么**不归它管 —— 由上层（api/工具层）读 `due`，决定是提示模型还是落一条建议。
 *
 * ── 为什么计数必须落盘（`reviewer.jsonl`）──
 * 这是本模块最重要的不变量：**重启后计数不能丢**。
 * 否则「每 10 回合审一次」在频繁重启的开发期等于「永远不审」，
 * 而且这种失效**没有任何报错**，只能靠人发现「怎么从来没人审」—— 属于最难查的一类问题。
 * 因此每个 `noteTurn` 都 append 一行事件，`replay()` 从事件流重建；
 * 构造时立即 hydrate，保证重启后 `status()` 一读就是真值。
 *
 * ── 为什么**不做快照** ────────────────────────────────────────────────────
 * 会话状态只有几个整数，事件流一行即可重建；加 `.snap.json` 只会引入
 * 「快照与事件流两处真相不一致」的新故障面（board.js 需要快照是因为整板任务
 * 重建代价高，这里没有这个需求）。事件流就是唯一真相源。
 *
 * ── 为什么允许运行时改 interval ───────────────────────────────────────────
 * 「几回合审一次」是**人的偏好**（UI 设置项），不该写死在代码里；
 * 且改完必须**立即生效**（不等下一次重启），所以 interval 也落进事件流，
 * 重启后保持用户最后设的值。
 *
 * 依赖面：`node:*` + `./store.js` + `./kernel.js`（惰性桥）。**零第三方依赖**。
 */

import {
  appendJsonl,
  readJsonl,
  statePath,
} from './store.js'

// ── kernel 惰性桥（与 board.js / discipline.js 同款，理由见 suggest.js 同名段落）──

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

/** 缺省间隔（回合）。10 是一个折中：太短会每几轮就打断，太长（如 50）用户感知不到「自我整理」。 */
export const DEFAULT_INTERVAL = 10
/** 间隔下限：1 = 每回合都到期（等于「每回合都提示审查」，压测/演示用）。 */
export const MIN_INTERVAL = 1
/**
 * 间隔上限：100000 只是防呆（比如 UI 传了 `Number.MAX_SAFE_INTEGER` 把 `due` 永久锁死）。
 * 上限本身不参与业务语义，**不因超限而静默截断** —— 超限抛错，让人看见自己传错了。
 */
export const MAX_INTERVAL = 100000

/** 会话 id 的长度上限（防把一整段正文误传成 sessionId，污染状态文件）。 */
const MAX_SESSION_ID_LENGTH = 200

// ── 错误类 ──────────────────────────────────────────────────────────────────

/** 审查调度错误：`code` 一律 `REVIEW_` 前缀。 */
export class ReviewerError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息
   * @param {string} [code] 大写下划线错误码（`REVIEW_` 前缀）
   * @param {object} [detail] 机器可读上下文
   */
  constructor(message, code = 'REVIEW_ERROR', detail) {
    super(message)
    this.name = 'ReviewerError'
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

/** `now` 归一：缺省当前时间；显式必须是有限数字。 */
function normalizeNow(now, where) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new ReviewerError(
      `reviewer.${where}：now 必须是有限数字（毫秒时间戳），收到 ${JSON.stringify(now)}`,
      'REVIEW_BAD_FIELD',
      { where, field: 'now' },
    )
  }
  return now
}

/** 必填字符串（trim 后非空）。 */
function requireString(value, field, where, code = 'REVIEW_BAD_FIELD') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ReviewerError(
      `reviewer.${where}：${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
      code,
      { where, field },
    )
  }
  return value.trim()
}

/** 会话 id 校验（与 requireString 分开：这里额外限长）。 */
function requireSessionId(value, where) {
  const sessionId = requireString(value, 'sessionId', where, 'REVIEW_BAD_SESSION')
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new ReviewerError(
      `reviewer.${where}：sessionId 过长（${sessionId.length} > ${MAX_SESSION_ID_LENGTH}）—— `
      + '疑似把正文误传成会话 id，拒绝写进状态文件',
      'REVIEW_BAD_SESSION',
      { where, length: sessionId.length },
    )
  }
  return sessionId
}

/** interval 校验：正整数且在上限内。 */
function requireInterval(value, where) {
  if (!Number.isInteger(value) || value < MIN_INTERVAL || value > MAX_INTERVAL) {
    throw new ReviewerError(
      `reviewer.${where}：interval 必须是 ${MIN_INTERVAL}..${MAX_INTERVAL} 的整数，收到 ${JSON.stringify(value)}`,
      'REVIEW_BAD_INTERVAL',
      { where, interval: value, min: MIN_INTERVAL, max: MAX_INTERVAL },
    )
  }
  return value
}

// ── 状态目录 ────────────────────────────────────────────────────────────────

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**（与 board.js 同一纪律）：兜到临时目录会让计数重启即丢。
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
  throw new ReviewerError(
    `reviewer.createReviewer：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'REVIEW_NO_STATE_DIR',
  )
}

/** `(ctx, config)` 归一，允许单参数简写（`{ stateDir }`），与 discipline.js 同款。 */
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
 * 创建审查调度器实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（只用于日志，缺失即 no-op）
 * @param {{ stateDir?: string, interval?: number, name?: string }} [config]
 * @returns {object} reviewer service
 */
export function createReviewer(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'reviewer.jsonl')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} sessionId → 会话审查状态 */
  const sessions = new Map()
  /** @type {object[]} 全部事件（审计流，按落盘顺序） */
  const events = []

  /** 全局配置（interval 可由 setInterval 运行时改；落盘后重启保持）。 */
  let intervalDefault = cfg.interval === undefined || cfg.interval === null
    ? DEFAULT_INTERVAL
    : requireInterval(cfg.interval, 'createReviewer')
  let configUpdatedAt = null
  let configUpdatedBy = null

  let disposed = false

  const diagnostics = {
    stateDir,
    jsonlPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: /** @type {null|'jsonl'|'empty'} */ (null),
    replayedEvents: 0,
    badLines: 0,
    lastReplayAt: /** @type {number|undefined} */ (undefined),
  }

  /** 已销毁实例的调用一律抛错（静默返回 turnCount:0 会让人误以为「重启丢计数」是 bug）。 */
  function assertAlive(where) {
    if (disposed) {
      throw new ReviewerError(
        `reviewer.${where}：实例已 dispose()，请重新 createReviewer()（拒绝在已销毁实例上静默返回空状态）`,
        'REVIEW_DISPOSED',
        { where },
      )
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /**
   * 提交一次变更：**先落事件，再改内存**。
   * 顺序不可颠倒：append 失败必须抛错、内存原封不动，否则重启后计数凭空回退/前进。
   *
   * @param {object} event 事件（含 type / at / by / rev / before / after）
   * @param {() => void} applyToMemory 落盘成功后才执行的「改内存」动作
   * @returns {void}
   */
  function commit(event, applyToMemory) {
    if (!appendJsonl(jsonlPath, event)) {
      throw new ReviewerError(
        `reviewer.${event.type}：事件追加失败（${jsonlPath}）—— 拒绝「只改内存不落盘」`
        + '（否则重启后计数丢失，审查永远不到期）',
        'REVIEW_APPEND_FAILED',
        { type: event.type, sessionId: event.sessionId ?? null },
      )
    }
    applyToMemory()
    events.push(clone(event))
  }

  /**
   * 从 `reviewer.jsonl`（唯一真相源）重建内存态。
   * 坏行**不静默丢弃**：计入 diagnostics 并 warn。
   */
  function hydrate() {
    sessions.clear()
    events.length = 0
    // interval 先回到构造时的配置，再让事件流里的最后一次 setInterval 覆盖它 ——
    // 这样「用户在 UI 里改过间隔」重启后才不会退回缺省值。
    intervalDefault = cfg.interval === undefined || cfg.interval === null
      ? DEFAULT_INTERVAL
      : requireInterval(cfg.interval, 'createReviewer')
    configUpdatedAt = null
    configUpdatedBy = null

    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) {
      warn(`[cs-bots/reviewer] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }
    if (rows.length === 0) {
      diagnostics.hydratedFrom = 'empty'
      info('[cs-bots/reviewer] 回放完成：空状态（无事件流）')
      return
    }

    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.type !== 'string') {
        skipped += 1
        continue
      }
      if (ev.type === 'config') {
        const next = ev.after
        if (!next || !Number.isInteger(next.interval)) {
          skipped += 1
          continue
        }
        intervalDefault = next.interval
        configUpdatedAt = Number.isFinite(next.updatedAt) ? next.updatedAt : (Number.isFinite(ev.at) ? ev.at : null)
        configUpdatedBy = typeof ev.by === 'string' ? ev.by : null
        events.push(clone(ev))
        continue
      }
      const sessionId = typeof ev.sessionId === 'string' ? ev.sessionId : null
      if (!sessionId || typeof ev.rev !== 'number' || !Number.isFinite(ev.rev)) {
        skipped += 1
        continue
      }
      const current = sessions.get(sessionId)
      if (current && ev.rev <= current.rev) {
        // 同 rev 重放幂等（容忍重复投递/半截重试），不是错误但也不重复消费
        skipped += 1
        continue
      }
      if (ev.type === 'reset') {
        // reset 的 after 为 null：删除是**显式事件**，回放时必须真的删掉，
        // 否则「重置过的会话」重启后又带着旧计数回来（比不重置更迷惑人）。
        if (ev.after === null) sessions.delete(sessionId)
        else sessions.set(sessionId, clone(ev.after))
      } else if (ev.after && typeof ev.after === 'object') {
        sessions.set(sessionId, clone(ev.after))
      } else {
        skipped += 1
        continue
      }
      events.push(clone(ev))
    }
    if (skipped > 0) {
      warn(`[cs-bots/reviewer] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }
    diagnostics.hydratedFrom = 'jsonl'
    info(`[cs-bots/reviewer] 回放完成：${rows.length} 条事件 → ${sessions.size} 个会话状态（interval=${intervalDefault}）`)
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  /** 组装一个会话的对外状态（du 计算集中在这里，避免各调用点各写一遍判据）。 */
  function statusOf(sessionId) {
    const state = sessions.get(sessionId)
    if (!state) {
      return {
        sessionId,
        known: false,
        rev: 0,
        turnCount: 0,
        interval: intervalDefault,
        due: false,
        turnsSinceLastReview: 0,
        lastReviewedAt: null,
        lastReviewedBy: null,
        updatedAt: null,
      }
    }
    return {
      sessionId,
      known: true,
      rev: state.rev,
      turnCount: state.turnCount,
      interval: intervalDefault,
      due: state.turnsSinceLastReview >= intervalDefault,
      turnsSinceLastReview: state.turnsSinceLastReview,
      lastReviewedAt: state.lastReviewedAt,
      lastReviewedBy: state.lastReviewedBy,
      updatedAt: state.updatedAt,
    }
  }

  /**
   * 查审查状态。
   * - 传 `sessionId`：返回该会话的明细（未计数过也返回零态 + `known:false`，
   *   因为「还没到过回合」是合法查询，不该抛错）；
   * - 不传：返回全局概览（到期会话列表），给 UI 顶部红点/状态栏用。
   *
   * @param {{ sessionId?: string }} [query]
   * @returns {object}
   */
  function status(query = {}) {
    assertAlive('status')
    const sessionId = query?.sessionId
    if (sessionId !== undefined && sessionId !== null) {
      const sid = requireSessionId(sessionId, 'status')
      return statusOf(sid)
    }
    const dueSessions = []
    let totalTurns = 0
    for (const sid of sessions.keys()) {
      const one = statusOf(sid)
      totalTurns += one.turnCount
      if (one.due) dueSessions.push(sid)
    }
    return {
      interval: intervalDefault,
      sessions: sessions.size,
      due: dueSessions.length > 0,
      dueSessions: clone(dueSessions).sort(),
      totalTurns,
      configUpdatedAt,
      configUpdatedBy,
    }
  }

  // ── 写 ────────────────────────────────────────────────────────────────────

  /**
   * 记一回合（上层**每回合调一次**；本模块不自己起定时器 —— 宿主生命周期不可控）。
   *
   * @param {{ sessionId: string, now?: number }} input
   * @returns {{ sessionId: string, turnCount: number, turnsSinceLastReview: number,
   *             interval: number, due: boolean }}
   */
  function noteTurn(input = {}) {
    assertAlive('noteTurn')
    const { sessionId, now } = input ?? {}
    const sid = requireSessionId(sessionId, 'noteTurn')
    const at = normalizeNow(now, 'noteTurn')

    const before = sessions.get(sid)
    const next = before
      ? {
        ...clone(before),
        rev: before.rev + 1,
        turnCount: before.turnCount + 1,
        turnsSinceLastReview: before.turnsSinceLastReview + 1,
        updatedAt: at,
      }
      : {
        sessionId: sid,
        rev: 1,
        turnCount: 1,
        turnsSinceLastReview: 1,
        lastReviewedAt: null,
        lastReviewedBy: null,
        createdAt: at,
        updatedAt: at,
      }

    const event = {
      type: 'turn',
      sessionId: sid,
      rev: next.rev,
      at,
      before: before ? clone(before) : null,
      after: clone(next),
    }
    commit(event, () => { sessions.set(sid, clone(next)) })

    const due = next.turnsSinceLastReview >= intervalDefault
    if (due && (!before || before.turnsSinceLastReview < intervalDefault)) {
      // 只在**刚跨过阈值**那一刻提示一次，避免到期后每回合刷日志
      info(`[cs-bots/reviewer] 会话 ${sid} 已累计 ${next.turnsSinceLastReview} 回合未审查（阈值 ${intervalDefault}）→ 到期`)
    }
    return {
      sessionId: sid,
      turnCount: next.turnCount,
      turnsSinceLastReview: next.turnsSinceLastReview,
      interval: intervalDefault,
      due,
    }
  }

  /**
   * 审查完成：计数归零（`turnsSinceLastReview=0`），记录「何时、谁」审的。
   * 为什么不减 N 而是归零：审查是**一次性扫全量**，不是「审掉 10 条待办」；
   * 归零语义更简单，也避免用户改了 interval 后出现「负数/提前到期」。
   *
   * @param {{ sessionId: string, by: string, now?: number, expectedRev?: number }} input
   * @returns {object} 审查后的状态（含 `reviewedTurns` = 本次审掉的累计回合数）
   */
  function markReviewed(input = {}) {
    assertAlive('markReviewed')
    const { sessionId, by, now, expectedRev } = input ?? {}
    const sid = requireSessionId(sessionId, 'markReviewed')
    const author = requireString(by, 'by', 'markReviewed')
    const at = normalizeNow(now, 'markReviewed')

    const before = sessions.get(sid)
    if (expectedRev !== undefined && expectedRev !== null) {
      if (!Number.isInteger(expectedRev)) {
        throw new ReviewerError(
          `reviewer.markReviewed：expectedRev 必须是整数（当前 rev=${before?.rev ?? 0}，收到 ${JSON.stringify(expectedRev)}）`,
          'REVIEW_BAD_FIELD',
          { where: 'markReviewed', field: 'expectedRev', sessionId: sid, rev: before?.rev ?? 0 },
        )
      }
      const actualRev = before?.rev ?? 0
      if (actualRev !== expectedRev) {
        throw new ReviewerError(
          `reviewer.markReviewed CAS 冲突：会话 ${sid} 期望 rev=${expectedRev}，实际 rev=${actualRev} —— `
          + '拒绝静默覆盖（另一个窗口可能刚审过），请重新 status() 后重试',
          'REVIEW_CAS_CONFLICT',
          { where: 'markReviewed', sessionId: sid, expectedRev, rev: actualRev },
        )
      }
    }

    const reviewedTurns = before?.turnsSinceLastReview ?? 0
    const next = before
      ? {
        ...clone(before),
        rev: before.rev + 1,
        turnsSinceLastReview: 0,
        lastReviewedAt: at,
        lastReviewedBy: author,
        updatedAt: at,
      }
      : {
        // 会话从未计数过也可以记「审查过」（例如重启后第一次就被调用）：
        // 若直接抛错，上层会为了「先 noteTurn 一次」写一堆特判，得不偿失。
        sessionId: sid,
        rev: 1,
        turnCount: 0,
        turnsSinceLastReview: 0,
        lastReviewedAt: at,
        lastReviewedBy: author,
        createdAt: at,
        updatedAt: at,
      }

    const event = {
      type: 'review',
      sessionId: sid,
      rev: next.rev,
      at,
      by: author,
      before: before ? clone(before) : null,
      after: clone(next),
    }
    commit(event, () => { sessions.set(sid, clone(next)) })
    info(`[cs-bots/reviewer] 会话 ${sid} 审查完成 by ${author}（清掉 ${reviewedTurns} 回合积压）`)
    return { ...statusOf(sid), reviewedTurns }
  }

  /**
   * 运行时改间隔（UI 设置项）。**立即生效**：下一次 status() 的 `due` 就按新阈值算。
   * 值没变则**不写事件**（幂等，避免 UI 每次保存都堆一行噪音），但明确回报 `changed:false`。
   *
   * @param {{ interval: number, by?: string, now?: number }} input
   * @returns {{ interval: number, changed: boolean, updatedAt: number|null, updatedBy: string|null }}
   */
  function setIntervalConfig(input = {}) {
    assertAlive('setInterval')
    const { interval, by, now } = input ?? {}
    const value = requireInterval(interval, 'setInterval')
    const at = normalizeNow(now, 'setInterval')
    const author = by === undefined || by === null ? null : requireString(by, 'by', 'setInterval')

    if (value === intervalDefault) {
      return { interval: intervalDefault, changed: false, updatedAt: configUpdatedAt, updatedBy: configUpdatedBy }
    }
    const event = {
      type: 'config',
      at,
      by: author,
      rev: events.filter((e) => e.type === 'config').length + 1,
      before: { interval: intervalDefault, updatedAt: configUpdatedAt, updatedBy: configUpdatedBy },
      after: { interval: value, updatedAt: at, updatedBy: author },
    }
    commit(event, () => {
      intervalDefault = value
      configUpdatedAt = at
      configUpdatedBy = author
    })
    info(`[cs-bots/reviewer] 审查间隔改为 ${value} 回合 by ${author ?? 'unknown'}（立即生效）`)
    return { interval: value, changed: true, updatedAt: at, updatedBy: author }
  }

  /**
   * 重置某会话的计数（人点「重新开始计数」；比如换了任务阶段，旧积压不再有意义）。
   * 未知会话 → 抛错：静默成功会让人以为「重置了」，实际什么都没发生。
   *
   * @param {{ sessionId: string, by?: string, now?: number, expectedRev?: number }} input
   * @returns {{ sessionId: string, reset: true, cleared: object }}
   */
  function reset(input = {}) {
    assertAlive('reset')
    const { sessionId, by, now, expectedRev } = input ?? {}
    const sid = requireSessionId(sessionId, 'reset')
    const author = by === undefined || by === null ? null : requireString(by, 'by', 'reset')
    const at = normalizeNow(now, 'reset')

    const before = sessions.get(sid)
    if (!before) {
      throw new ReviewerError(
        `reviewer.reset：会话 ${sid} 没有审查计数可重置（拒绝静默成功）`,
        'REVIEW_SESSION_NOT_FOUND',
        { where: 'reset', sessionId: sid },
      )
    }
    if (expectedRev !== undefined && expectedRev !== null) {
      if (!Number.isInteger(expectedRev)) {
        throw new ReviewerError(
          `reviewer.reset：expectedRev 必须是整数（当前 rev=${before.rev}，收到 ${JSON.stringify(expectedRev)}）`,
          'REVIEW_BAD_FIELD',
          { where: 'reset', field: 'expectedRev', sessionId: sid, rev: before.rev },
        )
      }
      if (before.rev !== expectedRev) {
        throw new ReviewerError(
          `reviewer.reset CAS 冲突：会话 ${sid} 期望 rev=${expectedRev}，实际 rev=${before.rev} —— 拒绝静默覆盖`,
          'REVIEW_CAS_CONFLICT',
          { where: 'reset', sessionId: sid, expectedRev, rev: before.rev },
        )
      }
    }

    const cleared = clone(before)
    const event = {
      type: 'reset',
      sessionId: sid,
      rev: before.rev + 1,
      at,
      by: author,
      before: clone(before),
      after: null,
    }
    commit(event, () => { sessions.delete(sid) })
    info(`[cs-bots/reviewer] 会话 ${sid} 审查计数已重置（原 ${before.turnCount} 回合）by ${author ?? 'unknown'}`)
    return { sessionId: sid, reset: true, cleared }
  }

  /**
   * 列出所有会话的审查状态（按 `updatedAt` 降序 —— UI 里「最近动过的会话」排前面）。
   * @returns {object[]}
   */
  function list() {
    assertAlive('list')
    const rows = [...sessions.keys()].map((sid) => statusOf(sid))
    rows.sort((a, b) => (
      ((b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
    ))
    return rows
  }

  /**
   * 统计（给 /status 与 UI 概览用）。
   * @returns {{ sessions: number, dueSessions: number, totalTurns: number, interval: number, events: number }}
   */
  function stats() {
    assertAlive('stats')
    let totalTurns = 0
    let dueSessions = 0
    for (const sid of sessions.keys()) {
      const one = statusOf(sid)
      totalTurns += one.turnCount
      if (one.due) dueSessions += 1
    }
    return {
      sessions: sessions.size,
      dueSessions,
      totalTurns,
      interval: intervalDefault,
      events: events.length,
    }
  }

  /**
   * 从 `reviewer.jsonl` 重建内存态（重启后计数不丢，是**本模块存在的意义**）。
   * @returns {{ from: string, sessions: number, events: number, bad: number, interval: number }}
   */
  function replay() {
    assertAlive('replay')
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      sessions: sessions.size,
      events: events.length,
      bad: diagnostics.badLines,
      interval: intervalDefault,
    }
  }

  /**
   * 销毁实例（释放内存、拒绝后续调用）。不删事件流：它是长期审计资产。
   * @returns {{ disposed: boolean, sessions: number, events: number }}
   */
  function dispose() {
    const out = { disposed: true, sessions: sessions.size, events: events.length }
    disposed = true
    sessions.clear()
    events.length = 0
    return out
  }

  /** 事件历史（审计：谁在第几回合审了/改了什么）。 */
  function history(sessionId) {
    assertAlive('history')
    const rows = typeof sessionId === 'string' && sessionId !== ''
      ? events.filter((e) => e.sessionId === sessionId)
      : events
    return clone(rows)
  }

  /** 首次构造即回放：重启后 `status()` 必须是真值，不能等第一次 noteTurn 才补。 */
  hydrate()

  const service = {
    name: cfg.name ?? 'reviewer',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath }),
    // 契约函数名（任务书/API 层按这些名字调）
    noteTurn,
    status,
    markReviewed,
    setInterval: setIntervalConfig,
    reset,
    list,
    stats,
    replay,
    dispose,
    history,
    diagnostics: () => clone(diagnostics),
  }
  return service
}

export default createReviewer
