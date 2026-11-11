/**
 * cs-bots Dispatcher（唤醒桥）—— 官方完全没有的关键零件。
 *
 * ## 为什么必须有它
 *
 * 官方 Agent Teams 的硬事实（已核验，见 `10-初步架构设计方案-v1.md` §3.5）：
 *   - 任务 `complete` **只改状态位**；
 *   - `activity.notify(TeamId)` 是 **Team 级广播**，只 resolve 正在阻塞的 `wait_agent`；
 *   - 工具契约原文：**"Task readiness never starts an owner"**。
 *
 * ⇒ **没有唤醒桥，平台会静默停摆**：任务建好了、被派了，但 owner 根本不会动。
 * 本模块就是那条「让 owner 动起来」的通路。
 *
 * ## 三条纪律（§3.5 原文）
 *
 * 1. **只对 owner 定向发**，绝不用 `wait_agent` 当轮询（Team 级广播会造成唤醒风暴）；
 * 2. **去重 + 节流**：`dedupKey` 命中即跳过；
 * 3. **租约超时**也走唤醒（"你的任务租约已过期"）。
 *
 * ## 绝不静默失败（本模块最重要的性质）
 *
 * 三种「没唤成」的情况**都必须能被调用方看见**，且**两层可见**（返回值 + 落盘）：
 *
 * | 情况 | 返回值 | 落盘 | 说明 |
 * |---|---|---|---|
 * | 被去重 | `{ok:true, result:'skipped', reason:'dedup-hit'}` | `result:'skipped'` | 同 dedupKey 只唤一次 |
 * | 被背压 | `{ok:false, result:'failed', reason:'backpressure'}` | `result:'failed'` | 队列超限，绝不静默丢 |
 * | 投递失败 | `{ok:false, result:'failed', reason:<原因>}` | `result:'failed'` | agent-not-live / followup-failed… |
 * | 队龄超限 | （由 `flush()` 的 `pruned` 报告） | `result:'failed'` | 24h 未投出，丢弃可见 |
 * | 落盘失败 | `{ok:false, reason:'record-persist-failed', durable:false}` | —— | 状态目录不可写，**明说写不成** |
 *
 * 一句话：**任何时候「本该发生唤醒却没发生」，调用方一定拿得到理由，
 * 且 `wakes.jsonl` 里一定有一条能读到的记录。**
 *
 * ## 去重是「投递前就把键写死」的（intent-first）
 *
 * 官方投递失败（如 `agent-not-live`）在会话重启后是**可恢复**的，但本模块**不自动重试**。
 * 理由：Dispatcher 的上游是任务板/房间的**事件流**，同一 `dedupKey` 会被反复触发。
 * 若投递失败就释放键，事件流会在「失败 → 释放键 → 事件再触发 → 再投递」之间
 * **无限空转**，正是 K1/K2 要防的反模式，且会烧 token。
 *
 * ⇒ **先占键 → 再投递**，投递失败也不释放（原因已落盘、已可见，
 * 由上层按自己的策略决定是否用**新的** dedupKey 重派）。
 * **两处例外**（都是「请求根本没被接受」，而非「接受了但没送成」）：
 *   - 状态目录不可写（连记录都落不成 ⇒ 没有任何持久痕迹，占着键只会把该 target
 *     永久静默，故释放）；
 *   - 被背压拒绝（请求被**拒绝**，该 dedupKey 尚未被消费掉，释放后队列疏通仍可重发）。
 *
 * ## 投递语义：一律 `followup`，不用 `steer`（K1）
 *
 * K1 已定：投递必须**异步**、**绝不阻塞** —— 唤醒是「新开一个回合干活」，不是插话。
 * `kernel.steer` 只用于「正在干活时插一句话」，本模块不需要，故不引入。
 *
 * ## 时间控制（测试友好）
 *
 * **不使用不可注入的 `setTimeout`**：`config.now` 与 `config.timer` 均可注入，
 * 测试用假时钟把「节流推迟 / 到期投递 / 24h 过期」全部**确定性**推进，零真实等待。
 *
 * ## 持久化口径：只落**终态**
 *
 * `wakes.jsonl` 里每条记录的 `result` 严格取自 §3.5 的三值
 * `'sent' | 'skipped' | 'failed'`；尚未投递的唤醒**只存在于内存队列**（不写垃圾状态），
 * 它最终落盘时必然是 `sent` 或 `failed`。这样 `list()` 的返回类型与 §3.5 模型完全一致。
 *
 * ## 本文件零依赖（CI 检查 1 覆盖）
 *
 * 不 import 任何 `@deepseek-ai/*`（耦合只允许出现在 `kernel.js`）；
 * 只用 node 内置 + `store.js` + `kernel.js`。
 */

import { rmSync } from 'node:fs'
import { dirname } from 'node:path'

import * as kernel from './kernel.js'
import { IdempotencySet, appendJsonl, ensureDir, nextSeq, readJsonl, statePath } from './store.js'

// ── 导出常量 ────────────────────────────────────────────────────────────────

/**
 * 合法的唤醒原因（§3.5 原文枚举）。
 * 非法 reason 会被**明确拒绝**而不是被悄悄接受 —— 否则事件源写错一个词，
 * 该任务的唤醒就会**静默失联**，正是本模块要根除的故障。
 * @type {readonly string[]}
 */
export const WAKE_REASONS = Object.freeze([
  'task-assigned',
  'task-unblocked',
  'room-message',
  'lease-timeout',
  'timer',
])

/** `notify()` 返回值的全部可能取值（比 Wake.result 多一个 `'pending'`，见 `notify` 注释）。 */
export const NOTIFY_RESULTS = Object.freeze(['sent', 'skipped', 'failed', 'pending'])

/** 原因 → 人类可读文案（生成缺省唤醒文本用）。 */
const REASON_TEXT = Object.freeze({
  'task-assigned': '你被指派了新任务，请开工。',
  'task-unblocked': '你的任务依赖已解除，现在可以开工。',
  'room-message': '房间有新消息，请查看。',
  'lease-timeout': '你的任务租约已过期，请处理或续租。',
  timer: '定时唤醒。',
})

/**
 * 缺省配置，全部可被 `createDispatcher(ctx, config)` 覆盖。
 *
 * - `throttleMs`      同 target 时间窗内最多唤醒一次（K4 时间窗）
 * - `maxPerTarget`    每会话队列上限（K4 队列上限；DS-BOT 原型为每会话 50 条）
 * - `queueTtlMs`      pending 存活上限，超过即判过期丢弃（K4 的 24h）
 * - `retryDeferredMs` 队列非空时的巡检间隔（驱动过期清理与到期投递）
 */
const DEFAULTS = Object.freeze({
  throttleMs: 5_000,
  maxPerTarget: 50,
  queueTtlMs: 24 * 60 * 60 * 1_000,
  retryDeferredMs: 1_000,
})

/** 去重器内存上限（LRU 近似，超出丢最旧）。 */
const DEDUP_MAX = 50_000

/**
 * 重复 skip 的**落盘折叠窗口**：同一 dedupKey 在此窗口内重复触发，只落一条 skipped 记录。
 *
 * 为什么需要：上游是事件流，`notify` 会被同一 dedupKey 高频重复调用（例如任务板每次
 * 重算都重发同一条指派）。逐次落盘会让 `wakes.jsonl` 线性膨胀。
 * 折叠后**可见性不降**（返回值仍是 `result:'skipped'`，`stats().skipped` 仍逐次计数），
 * 只是审计日志不被重复条目淹没。
 */
const SKIP_RECORD_INTERVAL_MS = 60_000

// ── 内部工具 ────────────────────────────────────────────────────────────────

/**
 * 探测目标文件所在目录**是否真的可写** —— 这是「绝不静默失败」的地基。
 *
 * 做法：在**旁路文件**上试写再删除（不污染 `wakes.jsonl` 审计流）。
 * 若不可写，Dispatcher 仍照常工作，但每次决策都会在返回值里带 `durable:false` ——
 * 调用方绝不能以为「没报错 = 记录下来了」。
 *
 * @param {string} file
 * @returns {{ writable: boolean, probeError?: string }}
 */
function probeWritable(file) {
  const probeFile = `${file}.probe-${process.pid}`
  try {
    if (!ensureDir(dirname(file))) return { writable: false, probeError: 'state-dir-unusable' }
    if (!appendJsonl(probeFile, { probe: true, at: Date.now() })) {
      return { writable: false, probeError: 'state-dir-not-writable' }
    }
    rmSync(probeFile, { force: true })
    return { writable: true }
  } catch (error) {
    return { writable: false, probeError: `state-dir-probe-failed:${error?.message ?? error}` }
  }
}

// ── 队列（有界、按 target 分区）─────────────────────────────────────────────

/**
 * pending 唤醒队列。
 *
 * 设计要点：
 *   - **按 target 分区计数**，让「每会话上限」是 **O(1)** 判定，而不是每次扫全队列；
 *   - Entry 额外带 `notBefore`（节流推迟后的最早可投递时刻）与 `keyHeld`
 *     （本 entry 是否占着去重键 —— 丢弃时必须释放，否则该任务永久静默）。
 */
function createQueue() {
  /** @type {Map<string, object[]>} target → Entry[] */
  const byTarget = new Map()
  /** @type {Map<string, object>} wakeId → Entry */
  const index = new Map()

  function detach(entry) {
    index.delete(entry.draft.id)
    const list = byTarget.get(entry.draft.target)
    if (!list) return
    const i = list.indexOf(entry)
    if (i >= 0) list.splice(i, 1)
    if (list.length === 0) byTarget.delete(entry.draft.target)
  }

  return {
    add(entry) {
      const list = byTarget.get(entry.draft.target)
      if (list) list.push(entry)
      else byTarget.set(entry.draft.target, [entry])
      index.set(entry.draft.id, entry)
    },
    remove: detach,
    /** 某 target 当前排队条数（O(1) —— 背压判定不走全队列扫描）。 */
    sizeOf(target) {
      return byTarget.get(target)?.length ?? 0
    },
    total() {
      return index.size
    },
    targets() {
      return byTarget.size
    },
    all() {
      return [...index.values()]
    },
    /** 已到期的 entry（`notBefore <= now`）。 */
    due(at) {
      const out = []
      for (const entry of index.values()) if (entry.notBefore <= at) out.push(entry)
      return out
    },
    /**
     * 摘出超过 TTL 的 pending。**不静默**：返回被丢弃的 entry，
     * 由调用方逐条落 `failed` 记录并释放去重键。
     */
    prune(at, ttlMs) {
      const dropped = []
      for (const entry of index.values()) {
        if (at - entry.draft.scheduledAt > ttlMs) dropped.push(entry)
      }
      for (const entry of dropped) detach(entry)
      return dropped
    },
  }
}

// ── 主体 ────────────────────────────────────────────────────────────────────

/**
 * 创建 Dispatcher。
 *
 * @param {object} ctx 宿主上下文（透传给 `kernel.followup`）
 * @param {{
 *   stateDir?: string, wakesFile?: string, throttleMs?: number, maxPerTarget?: number,
 *   queueTtlMs?: number, retryDeferredMs?: number,
 *   now?: () => number,
 *   timer?: { setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout?: (h: unknown) => void },
 *   clearTimer?: (handle: unknown) => void,
 * }} [config]
 */
export function createDispatcher(ctx, config = {}) {
  // ── 时间面（可注入）──
  const now = typeof config.now === 'function' ? config.now : () => Date.now()
  const timer = config.timer ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  }
  const clearTimer =
    typeof config.clearTimer === 'function'
      ? config.clearTimer
      : (handle) => timer.clearTimeout?.(handle)

  // ── 策略参数 ──
  const throttleMs = Number.isFinite(config.throttleMs) ? config.throttleMs : DEFAULTS.throttleMs
  const maxPerTarget = Number.isFinite(config.maxPerTarget) ? config.maxPerTarget : DEFAULTS.maxPerTarget
  const queueTtlMs = Number.isFinite(config.queueTtlMs) ? config.queueTtlMs : DEFAULTS.queueTtlMs
  const retryDeferredMs = Number.isFinite(config.retryDeferredMs)
    ? config.retryDeferredMs
    : DEFAULTS.retryDeferredMs

  // ── 存储面 ──
  const stateDirectory = config.stateDir ?? kernel.stateDir()
  const wakesFile = config.wakesFile ?? statePath(stateDirectory, 'wakes.jsonl')
  const probe = probeWritable(wakesFile)

  // ── 内存状态 ──
  const dedup = new IdempotencySet(DEDUP_MAX)
  /** @type {Map<string, number>} target → 上一次**投递成功**时刻（节流依据：只算真正送达的） */
  const lastSentAt = new Map()
  /** @type {Map<string, number>} dedupKey → 上次落 skipped 记录的时刻（落盘折叠用） */
  const skipRecordedAt = new Map()
  const queue = createQueue()
  const counters = { total: 0, sent: 0, skipped: 0, failed: 0, deferred: 0, backpressured: 0, pruned: 0 }

  /**
   * 单调序号：创建时读一次盘取初值，之后**内存自增**（避免每条 wake 都全文件扫描）。
   * 本 Dispatcher 是该文件的唯一写者，故内存计数即正确。
   */
  let seqCounter = nextSeq(wakesFile)
  const takeSeq = () => (seqCounter += 1)

  /**
   * 从 `wakes.jsonl` 重建去重键（**重启后去重仍然有效** —— 这正是「不重复唤醒」的持久保证）。
   *
   * 有例外：被显式**释放**的键（`keyReleased:true`，见背压 / TTL 过期 / 落盘失败三处）
   * 必须**不**重建 —— 否则队列疏通后上游用同一个 dedupKey 重发会被自己历史记录挡住。
   * 按落盘顺序遍历，后写的一条覆盖前一条，故「先失败(保留键) → 后被释放」也能正确还原。
   *
   * @returns {number} 重建出的键数
   */
  function rebuildDedup() {
    const { rows } = readJsonl(wakesFile)
    let rebuilt = 0
    for (const row of rows) {
      const key = row?.dedupKey
      if (!key) continue
      if (row.keyReleased === true) {
        dedup.keys.delete(key)
        continue
      }
      if (!dedup.keys.has(key)) {
        dedup.keys.add(key)
        rebuilt += 1
      }
    }
    return rebuilt
  }

  // 重启后去重仍然有效：已有记录里的 dedupKey 一律视为「已消费」。
  rebuildDedup()

  // ── 定时器 ──
  let retryHandle = null
  let timerActive = false
  let flushing = false

  // ── 落盘 ──────────────────────────────────────────────────────────────────

  /**
   * 落一条**终态**记录（`result` 严格 ∈ §3.5 三值）。
   *
   * @param {object} draft
   * @param {'sent'|'skipped'|'failed'} result
   * @param {{ at?: number, detail?: string, keyReleased?: boolean }} [options]
   *   `keyReleased:true` 表示**本记录的 dedupKey 已被释放**（该请求未被接受，
   *   或队龄超限被丢弃）—— 供重启后 `rebuildDedup()` 正确还原去重状态。
   * @returns {{ wake: object, durable: boolean }}
   */
  function commit(draft, result, { at = now(), detail, keyReleased } = {}) {
    const wake = {
      id: draft.id,
      target: draft.target,
      reason: draft.reason,
      dedupKey: draft.dedupKey,
      scheduledAt: draft.scheduledAt,
      sentAt: result === 'sent' ? at : undefined,
      result,
      // ── 平台扩展字段（§3.5 未列，但对「可读原因」与可审计是必需的）──
      text: draft.text,
      // t-39 第2批 D：唤醒成本可见。无团队归属时是 null（不猜）。
      teamId: draft.teamId ?? null,
      updatedAt: at,
      seq: takeSeq(),
    }
    if (detail) wake.detail = detail
    if (keyReleased) wake.keyReleased = true
    const durable = Boolean(appendJsonl(wakesFile, wake))
    return { wake, durable }
  }

  /**
   * 构造 wake 草稿（此刻尚无终态；`result` 只在 `commit` 时赋值）。
   *
   * `teamId`：唤醒成本可见（t-39 第2批 D）。**不是所有唤醒都属于某个团队**
   * （例如任务派活、房间广播都可能与团队无关）—— 那种情况一律写 `null`，
   * 绝不按 target 猜一个团队塞进去：猜出来的数字比没有更糟，它会让
   * 「每团队唤醒成本」的统计凭空多出一份不属于它的开销。
   */
  function draftWake({ target, reason, dedupKey, text, at, teamId }) {
    return {
      id: `wake-${at}-${process.pid.toString(36)}-${takeSeq().toString(36)}`,
      target,
      reason,
      dedupKey,
      text,
      teamId: teamId ?? null,
      scheduledAt: at,
    }
  }

  // ── 投递 ──────────────────────────────────────────────────────────────────

  /**
   * 把一个 entry 真正投递出去（单次尝试，同步）。
   *
   * 无论成功失败都**摘队 + 落终态记录**，且失败时**保留** dedupKey（intent-first）。
   */
  function deliver(entry) {
    const draft = entry.draft
    const at = now()
    const attempt = kernel.followup(ctx, draft.target, draft.text ?? '')

    queue.remove(entry)

    if (attempt?.ok) {
      lastSentAt.set(draft.target, at)
      counters.sent += 1
      const { wake, durable } = commit(draft, 'sent', { at })
      return { ok: true, wakeId: wake.id, wake, durable }
    }

    const detail = attempt?.reason ?? 'followup-unknown-failure'
    counters.failed += 1
    const { wake, durable } = commit(draft, 'failed', { at, detail })
    return { ok: false, reason: detail, detail, wakeId: wake.id, wake, durable }
  }

  // ── 巡检 ──────────────────────────────────────────────────────────────────

  function scheduleRetry() {
    if (timerActive || queue.total() === 0) return
    timerActive = true
    retryHandle = timer.setTimeout(() => {
      timerActive = false
      retryHandle = null
      flush()
    }, retryDeferredMs)
  }

  function cancelRetry() {
    if (retryHandle != null) {
      try {
        clearTimer(retryHandle)
      } catch {
        /* 清理失败不影响正确性：下次巡检会重排 */
      }
      retryHandle = null
    }
    timerActive = false
  }

  /**
   * 清理超过 TTL 的 pending —— **丢弃必须可见**。
   *
   * 逐条落 `failed` 记录（`detail:'queue-ttl-expired'`），并**释放去重键**：
   * 否则该任务会被一个已经死掉的延迟唤醒**永久静默** —— 那是「静默停摆」的另一种形态。
   */
  function pruneExpired() {
    const dropped = queue.prune(now(), queueTtlMs)
    for (const entry of dropped) {
      const draft = entry.draft
      counters.failed += 1
      counters.pruned += 1
      if (entry.keyHeld && draft.dedupKey) dedup.keys.delete(draft.dedupKey)
      commit(draft, 'failed', { detail: 'queue-ttl-expired', keyReleased: true })
    }
    return dropped.length
  }

  // ── 公开接口 ──────────────────────────────────────────────────────────────

  /**
   * 请求一次唤醒。**唯一入口**。
   *
   * ### 返回值的 `result` 语义（诚实优先）
   *
   * `Wake.result`（**落盘**）严格取自 §3.5 的三值 `'sent' | 'skipped' | 'failed'`；
   * 而 `notify()` 的**返回值**多一个 `'pending'`，表示「已受理、已入队、尚未投递」
   * （被节流推迟，或显式传了 `delayMs`）。
   *
   * 为什么不把 `'pending'` 谎报成 `'sent'`：那正是本模块要根除的**静默失败** ——
   * 调用方会以为 owner 已经被唤醒了，而实际上它还在队列里。`'pending'` 不是失败：
   * 调用方用 `deferred:true` / `stats().pending` / 后续 `flush()` 跟踪其最终落点。
   *
   * @param {{
   *   target: string, reason: string, dedupKey?: string, text?: string, delayMs?: number,
   * }} request
   * @returns {{ ok: boolean, result: 'sent'|'skipped'|'failed'|'pending', wakeId?: string,
   *             reason?: string, durable?: boolean, deferred?: boolean }}
   */
  function notify(request = {}) {
    const at = now()
    const { target, reason, dedupKey, text, delayMs, teamId } = request
    const wakeText = text ?? `[cs-bots 唤醒] ${REASON_TEXT[reason] ?? String(reason)}`

    // 每调用一次 = 一次决策，先计数（恒等式 total === sent + skipped + failed + pending 由此成立）。
    counters.total += 1

    // ── 输入校验：不合法就**明确拒绝**，绝不悄悄接受 ──
    if (typeof target !== 'string' || target.length === 0) {
      counters.failed += 1
      return { ok: false, result: 'failed', reason: 'invalid-target', durable: probe.writable }
    }
    if (!WAKE_REASONS.includes(reason)) {
      counters.failed += 1
      const draft = draftWake({ target, reason: String(reason), dedupKey, text: wakeText, at, teamId })
      const { wake, durable } = commit(draft, 'failed', { at, detail: `invalid-reason:${reason}` })
      return { ok: false, result: 'failed', wakeId: wake.id, reason: 'invalid-reason', durable }
    }

    // ── 纪律 2 之去重：命中即 skipped，不重复唤醒 ──
    if (dedupKey && !dedup.check(dedupKey)) {
      counters.skipped += 1
      const last = skipRecordedAt.get(dedupKey)
      let wakeId
      let durable = probe.writable
      if (last === undefined || at - last >= SKIP_RECORD_INTERVAL_MS) {
        const draft = draftWake({ target, reason, dedupKey, text: wakeText, at, teamId })
        const committed = commit(draft, 'skipped', { at })
        wakeId = committed.wake.id
        durable = committed.durable
        skipRecordedAt.set(dedupKey, at)
        if (skipRecordedAt.size > DEDUP_MAX) {
          skipRecordedAt.delete(skipRecordedAt.keys().next().value)
        }
      }
      return { ok: true, result: 'skipped', wakeId, reason: 'dedup-hit', durable }
    }

    // ── K4 背压：队列超限 → 拒绝 + **可见失败记录**，绝不静默丢弃 ──
    if (queue.sizeOf(target) >= maxPerTarget) {
      counters.backpressured += 1
      counters.failed += 1
      const draft = draftWake({ target, reason, dedupKey, text: wakeText, at, teamId })
      // 请求被**拒绝**（而非「受理后没送成」）⇒ 该 dedupKey 尚未被消费，释放它，
      // 队列疏通后上游仍可用同一个 dedupKey 重发。
      if (dedupKey) dedup.keys.delete(dedupKey)
      const { wake, durable } = commit(draft, 'failed', {
        at,
        detail: `queue-full:${queue.sizeOf(target)}/${maxPerTarget}`,
        keyReleased: Boolean(dedupKey),
      })
      return { ok: false, result: 'failed', wakeId: wake.id, reason: 'backpressure', durable }
    }

    // ── K4 时间窗：窗内则**延后**（不丢唤醒），显式 delayMs 则按其推迟 ──
    let notBefore = at
    let deferred = false
    if (delayMs == null) {
      const since = lastSentAt.get(target)
      if (since !== undefined && at - since < throttleMs) {
        notBefore = since + throttleMs
        deferred = true
      }
    } else {
      notBefore = at + Math.max(0, Number(delayMs) || 0)
      deferred = notBefore > at
    }

    const draft = draftWake({ target, reason, dedupKey, text: wakeText, at, teamId })
    const entry = { draft, notBefore, keyHeld: Boolean(dedupKey) }
    queue.add(entry)
    if (deferred) counters.deferred += 1

    // 已到期 → 立刻投递；否则挂起，由 timer 驱动（到期清理 + 投递）。
    if (entry.notBefore <= at) {
      const outcome = deliver(entry)
      if (queue.total() > 0) scheduleRetry()
      if (outcome.ok) return { ok: true, result: 'sent', wakeId: outcome.wakeId, durable: outcome.durable }
      return {
        ok: false,
        result: 'failed',
        wakeId: outcome.wakeId,
        reason: outcome.reason,
        durable: outcome.durable,
      }
    }

    // 已受理但尚未投递 —— **如实报 'pending'**，并明说推迟原因。
    scheduleRetry()
    return {
      ok: true,
      result: 'pending',
      wakeId: draft.id,
      reason: delayMs != null ? 'scheduled-delay' : 'throttled',
      durable: probe.writable,
      deferred: true,
    }
  }

  /**
   * 立即投递 pending 唤醒（供测试与**关机前**调用）。
   *
   * @param {{ force?: boolean }} [options] `force:true` 时无视节流推迟，投递**全部** pending
   *   （关机前正确用法：与其让它们 24h 后过期成 `failed`，不如现在就投出去）
   * @returns {{ ok: boolean, sent: number, failed: number, pruned: number, remaining: number }}
   */
  function flush(options = {}) {
    if (flushing) {
      return { ok: true, sent: 0, failed: 0, pruned: 0, remaining: queue.total() }
    }
    flushing = true
    try {
      cancelRetry()
      const pruned = pruneExpired()
      const at = now()
      const pending = options.force ? queue.all() : queue.due(at)

      // 按 `scheduledAt`（同刻按 seq）升序投递 —— 同 target 的多次唤醒保持**入队顺序**，
      // 避免「后来的先执行」把 owner 引到错误的任务状态上。
      pending.sort(
        (a, b) =>
          a.draft.scheduledAt - b.draft.scheduledAt || a.draft.id.localeCompare(b.draft.id),
      )

      let sent = 0
      let failed = 0
      for (const entry of pending) {
        const outcome = deliver(entry)
        if (outcome.ok) sent += 1
        else failed += 1
      }

      if (queue.total() > 0) scheduleRetry()
      return { ok: true, sent, failed, pruned, remaining: queue.total() }
    } finally {
      flushing = false
    }
  }

  /**
   * 计数快照。恒等式：`total === sent + skipped + failed + pending`。
   *
   * `total` 统计的是**决策数**（每次 `notify` 的判定），因此尚在排队的唤醒
   * 计入 `pending` 而非 `sent`。
   *
   * @returns {{ total: number, sent: number, skipped: number, failed: number, pending: number,
   *            deferred: number, backpressured: number, pruned: number, targets: number }}
   */
  function stats() {
    return {
      total: counters.total,
      sent: counters.sent,
      skipped: counters.skipped,
      failed: counters.failed,
      pending: queue.total(),
      // ── 诊断扩展（不属于 §3.5 最小集，排查时必需）──
      deferred: counters.deferred,
      backpressured: counters.backpressured,
      pruned: counters.pruned,
      targets: queue.targets(),
    }
  }

  /**
   * 从 `wakes.jsonl` 读唤醒记录（**读盘，不是读内存** —— 进程重启后仍可审计）。
   *
   * @param {{ target?: string, teamId?: string, limit?: number }} [options]
   *        `teamId` 是 t-39 第2批 D 加的：唤醒成本可见（按团队过滤）。
   * @returns {object[]} 终态 Wake 记录（落盘顺序；有 `limit` 时取**最后** limit 条）
   */
  function list(options = {}) {
    const { target, teamId, limit } = options
    // 先按 limit 取尾，再按 target / teamId 过滤 —— 语义是「最近 limit 条里属于该 target/team 的」。
    const { rows, bad, total } = readJsonl(wakesFile, limit ? { limit } : {})
    let filtered = rows
    if (target) filtered = filtered.filter((row) => row?.target === target)
    if (teamId) filtered = filtered.filter((row) => row?.teamId === teamId)
    // 坏行**不静默**：作为非枚举属性挂上，调用方可用 `Object.keys` 忽略、也可显式读取。
    Object.defineProperty(filtered, 'bad', { value: bad, enumerable: false })
    Object.defineProperty(filtered, 'total', { value: total, enumerable: false })
    return filtered
  }

  /**
   * 按团队聚合唤醒成本（t-39 第2批 D）。
   *
   * 为什么需要：Boss 要看「哪个团队在消耗唤醒配额」。单看 target 看不出团队归属
   * （target 是会话 id，团队归属在 `teamId` 上）。
   *
   * 只聚合**真正有 teamId 的记录**；`teamId === null` 的（任务派活、房间广播等
   * 与团队无关的唤醒）单独归入 `teamId: null` 桶，不混进任何团队数字里。
   *
   * @param {{ since?: number }} [options] `since` = epoch ms，只统计该时刻之后的记录
   * @returns {{ since?: number, teams: object[], unassigned: object, total: number }}
   */
  function byTeam(options = {}) {
    const { since } = options
    const { rows } = readJsonl(wakesFile, { limit: 100_000 })
    const buckets = new Map()
    let total = 0
    for (const row of rows) {
      const at = row?.scheduledAt ?? row?.at
      if (since !== undefined && Number.isFinite(since) && Number.isFinite(at) && at < since) continue
      total += 1
      const key = row?.teamId ?? null
      if (!buckets.has(key)) {
        buckets.set(key, { teamId: key, count: 0, sent: 0, skipped: 0, failed: 0, pending: 0, targets: new Set() })
      }
      const b = buckets.get(key)
      b.count += 1
      const r = row?.result
      if (r === 'sent') b.sent += 1
      else if (r === 'skipped') b.skipped += 1
      else if (r === 'failed') b.failed += 1
      else if (r === 'pending') b.pending += 1
      if (row?.target) b.targets.add(row.target)
    }
    const teams = [...buckets.entries()]
      .filter(([key]) => key !== null)
      .map(([, b]) => ({ ...b, targets: b.targets.size, targetsList: [...b.targets] }))
      .sort((a, b) => b.count - a.count)
    const unassignedEntry = buckets.get(null)
    const unassigned = unassignedEntry
      ? { teamId: null, count: unassignedEntry.count, sent: unassignedEntry.sent, skipped: unassignedEntry.skipped, failed: unassignedEntry.failed, pending: unassignedEntry.pending, targets: unassignedEntry.targets.size, targetsList: [...unassignedEntry.targets] }
      : { teamId: null, count: 0, sent: 0, skipped: 0, failed: 0, pending: 0, targets: 0, targetsList: [] }
    return { since: since ?? null, teams, unassigned, total }
  }

  return {
    notify,
    flush,
    stats,
    list,
    byTeam,
    /** 只读诊断：状态目录 / 文件路径 / 是否可写。 */
    paths: { stateDir: stateDirectory, wakesFile },
    /** 状态目录可否持久化；`false` ⇒ 所有返回值都会带 `durable:false`。 */
    durable: probe.writable,
    probeError: probe.probeError,
    /**
     * 关机收尾：停掉定时器（避免进程退出被挂起的 timer 拖住）。
     * **不投递** —— 投递请显式调用 `flush({ force: true })`。
     */
    dispose() {
      cancelRetry()
    },
  }
}

export default createDispatcher
