/**
 * cs-bots 投递回执看护（Delivery Acknowledgement Watchdog）
 *
 * ## 它补的是哪一层
 *   superagent 把「一条输入到底有没有被消费」拆成三级：
 *     `inputsDelivered`（到达会话）→ `inputsRead`（进入历史，且后续有 Report/回合结束才算）
 *   我们此前**只有第一级的一半**：`dispatcher` 记 `sent`（= 把消息交给了宿主），
 *   就当作成功。于是出现最坏的一类失败：
 *
 *     现场（2026-11-09）：wake 记 `sent`，会话 `turns: 0 / steps: 0`，
 *     事件文件还停在几天前 —— 任务卡在「进行中」，页面看不到任何异常。
 *     **投递成功 ≠ 真的在跑。**
 *
 *   本模块补第二级：投递之后盯着会话的**事件水位**。过了宽限期还没涨，
 *   就把「已投递但执行者未开始动作」写进 `task.delivery.error`
 *   （`stage.js` 会据此派 `person/delivery`，页面立刻显形并给出下一步）。
 *
 * ## 为什么用宽限期而不是立即判
 *   模型冷启动 + 排队 + 长上下文都可能让「第一回合」晚几十秒才开始。
 *   立刻判会产生大量误报，而**误报比漏报更伤**：人会学会忽略这条提示。
 *   所以默认 90 秒宽限，超时才落失败；期间任何一次水位上涨都算兑现。
 *
 * ## 持久化取舍（诚实说明）
 *   期望表**只在内存里**，进程重启即清空。理由：
 *     - 重启会把所有会话一起杀掉，旧的期望本来就已经失效；
 *     - 落盘会给每个投递写一条记录，把 `wakes.jsonl` 的语义搅浑；
 *     - 漏判的代价只是「这一次没提醒」——下一次唤醒会重新建立期望。
 *   如果将来需要跨重启追踪，再把它做成 append-only 文件不迟。
 *
 * @module delivery-watch
 */

/** 默认宽限期：投递后多久还没动静就判「未开始动作」。 */
export const DEFAULT_GRACE_MS = 90_000
/** 默认巡检间隔。 */
export const DEFAULT_TICK_MS = 15_000
/** 单次最多同时跟踪多少条期望（防内存失控）。 */
export const DEFAULT_MAX_PENDING = 200

/**
 * 创建回执看护。
 *
 * @param {object} deps
 * @param {(sessionId: string) => Promise<object>} deps.watermark 读会话水位（kernel.readSessionWatermark）
 * @param {(taskId: string, reason: string) => Promise<boolean>} deps.markFailure 落 delivery.error
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @param {{ graceMs?: number, tickMs?: number, maxPending?: number,
 *           now?: () => number, schedule?: Function, cancel?: Function }} [deps.options]
 * @returns {object} watchdog
 */
export function createDeliveryWatch(ctx, deps = {}) {
  const logger = deps.logger ?? {}
  const info = (...a) => { try { logger.info?.(...a) } catch { /* */ } }
  const warn = (...a) => { try { logger.warn?.(...a) } catch { /* */ } }

  const options = deps.options ?? {}
  const graceMs = Number.isFinite(options.graceMs) ? Number(options.graceMs) : DEFAULT_GRACE_MS
  const tickMs = Number.isFinite(options.tickMs) ? Number(options.tickMs) : DEFAULT_TICK_MS
  const maxPending = Number.isFinite(options.maxPending) ? Number(options.maxPending) : DEFAULT_MAX_PENDING
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const schedule = typeof options.schedule === 'function'
    ? options.schedule
    : (fn, ms) => {
        const t = setTimeout(fn, ms)
        // 别让看护定时器把进程顶住
        t?.unref?.()
        return t
      }
  const cancel = typeof options.cancel === 'function'
    ? options.cancel
    : (h) => clearTimeout(h)

  /** @type {Map<string, { taskId: string, sessionId: string, sentAt: number, baselineSeq: number,
   *                       baselineUserMessages: number, wakeId?: string }>} */
  const pending = new Map()
  const diagnostics = {
    expected: 0,      // 累计建立过多少条期望
    fulfilled: 0,     // 水位涨了（真的开始动了）
    unfulfilled: 0,   // 超时仍没动
    undecidable: 0,   // 读不到水位（宿主没持久化层 / 会话不存在）
    dropped: 0,       // 被新期望覆盖 / 主动取消
    lastSweepAt: undefined,
  }
  let timer = null
  let disposed = false

  /** 期望键：同一任务的同一会话只保留最新一条（新唤醒自然重置宽限期）。 */
  const keyOf = (taskId, sessionId) => `${taskId}\u0000${sessionId}`

  /**
   * 登记一条「投递已发出，等回执」的期望。
   *
   * @param {{ taskId: string, sessionId: string, baselineSeq?: number,
   *           baselineUserMessages?: number, wakeId?: string }} input
   * @returns {object} 期望记录（含 `key`，可用于 cancel）
   */
  function expect(input = {}) {
    const taskId = typeof input.taskId === 'string' ? input.taskId : ''
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    if (!taskId || !sessionId) {
      return { ok: false, reason: 'expect：taskId 与 sessionId 必填' }
    }
    const key = keyOf(taskId, sessionId)
    if (pending.has(key)) diagnostics.dropped += 1
    if (pending.size >= maxPending && !pending.has(key)) {
      // 满了就丢最旧的一条（只 warn，不抛——看护不该影响主流程）
      const oldest = pending.keys().next().value
      pending.delete(oldest)
      diagnostics.dropped += 1
      warn(`[cs-bots/watch] 期望表已满（${maxPending}），丢弃最旧一条（${oldest}）`)
    }
    const entry = {
      key,
      taskId,
      sessionId,
      sentAt: now(),
      baselineSeq: Number.isFinite(input.baselineSeq) ? Number(input.baselineSeq) : -1,
      baselineUserMessages: Number.isFinite(input.baselineUserMessages)
        ? Number(input.baselineUserMessages)
        : 0,
      wakeId: input.wakeId,
    }
    pending.set(key, entry)
    diagnostics.expected += 1
    ensureTimer()
    return { ok: true, ...entry, graceMs }
  }

  /** 兑现 / 撤销一条期望（例如任务被重开、或人主动重试）。 */
  function cancelByTask(taskId) {
    let removed = 0
    for (const [k, v] of pending) {
      if (v.taskId === taskId) {
        pending.delete(k)
        removed += 1
      }
    }
    if (removed) diagnostics.dropped += removed
    return removed
  }

  /**
   * 巡检一轮：判定「水位是否涨了」「是否超时」。
   *
   * 判据（两条任一即算兑现）：
   *   - 最新 seq > 投递前基线 seq（有新事件，说明回合真的开始了）
   *   - `user/message` 条数 > 基线（这条输入被吸进历史）
   *
   * @returns {Promise<{ checked: number, fulfilled: number, unfulfilled: number, undecidable: number }>}
   */
  async function sweep() {
    if (disposed) return { checked: 0, fulfilled: 0, unfulfilled: 0, undecidable: 0 }
    diagnostics.lastSweepAt = now()
    const checked = pending.size
    let fulfilled = 0
    let unfulfilled = 0
    let undecidable = 0
    const at = now()

    for (const [key, entry] of [...pending]) {
      if (!pending.has(key)) continue // 并发期间被删
      let wm
      try {
        wm = typeof deps.watermark === 'function'
          ? await deps.watermark(entry.sessionId)
          : { ok: false, available: false, reason: 'watermark 未注入' }
      } catch (error) {
        wm = { ok: false, available: true, reason: String(error?.message ?? error) }
      }

      if (!wm || !wm.ok) {
        // 读不到水位 —— 不能判死（可能是宿主没持久化层）。过了宽限期就放弃跟踪并记一笔。
        if (at - entry.sentAt >= graceMs) {
          pending.delete(key)
          diagnostics.undecidable += 1
          undecidable += 1
          warn(
            `[cs-bots/watch] 无法判定 ${entry.taskId} 的投递是否被消费（${wm?.reason ?? 'unknown'}），`
            + '已停止跟踪（不写失败，避免误报）',
          )
        }
        continue
      }

      const seqGrew = Number.isFinite(wm.seq) && wm.seq > entry.baselineSeq
      const userGrew = Number.isFinite(wm.userMessages) && wm.userMessages > entry.baselineUserMessages
      if (seqGrew || userGrew) {
        pending.delete(key)
        diagnostics.fulfilled += 1
        fulfilled += 1
        continue
      }

      if (at - entry.sentAt >= graceMs) {
        pending.delete(key)
        diagnostics.unfulfilled += 1
        unfulfilled += 1
        const reason = `已投递但执行者未开始动作（${Math.round((at - entry.sentAt) / 1000)} 秒内会话没有新事件）`
          + '——可能是会话没有真正运行，或它的模型路由不可用；去「Bot 档案」确认这个 Bot 能跑起来，再点「重试唤醒」'
        try {
          const marked = typeof deps.markFailure === 'function'
            ? await deps.markFailure(entry.taskId, reason)
            : false
          info(`[cs-bots/watch] ${entry.taskId} 投递未被消费 → ${marked ? '已写入 task.delivery' : '写入失败（任务可能已结束）'}`)
        } catch (error) {
          warn(`[cs-bots/watch] ${entry.taskId} 写 delivery 失败：${error?.message ?? error}`)
        }
      }
    }

    if (pending.size === 0) stopTimer()
    return { checked, fulfilled, unfulfilled, undecidable }
  }

  function ensureTimer() {
    if (disposed || timer != null || pending.size === 0) return
    const tick = async () => {
      timer = null
      try { await sweep() } catch (error) { warn(`[cs-bots/watch] 巡检异常：${error?.message ?? error}`) }
      if (!disposed && pending.size > 0) ensureTimer()
    }
    timer = schedule(tick, tickMs)
  }

  function stopTimer() {
    if (timer != null) {
      cancel(timer)
      timer = null
    }
  }

  /** 关停（插件 dispose 时调用）：清定时器、清期望表。 */
  function dispose() {
    disposed = true
    stopTimer()
    pending.clear()
  }

  return {
    expect,
    sweep,
    cancelByTask,
    dispose,
    stats: () => ({
      ...diagnostics,
      pending: pending.size,
      graceMs,
      tickMs,
    }),
    /** 只读快照（调试用）。 */
    list: () => [...pending.values()].map((e) => ({ ...e })),
  }
}

export default createDeliveryWatch
