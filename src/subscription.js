/**
 * cs-bots SubscriptionService —— 任务订阅（改造07 · 借鉴 Super-agent 的 Subscription 扇出）。
 *
 * ## 为什么需要它
 *
 * 现有协作里有一个**断点**：房间里的讨论在推进，但相关任务**看不到**。
 * 人只好回到任务里手动补一句「刚才房间说……」，或者重新 @ Bot 一次。
 *
 * Super-agent 的 Subscription 解决了这个：一次性订阅后，
 * Thread 上的**后续消息自动扇出**给订阅它的 Ticket——讨论进展自动到达，
 * 不需要再点名。
 *
 * ## 本模块的形态（与 Super-agent 的差异，写清避免误读）
 *
 * | | Super-agent | cs-bots（本模块） |
 * |---|---|---|
 * | 订阅主体 | Ticket ↔ Thread | **Task ↔ Room** |
 * | 扇出后果 | 消息作为上下文 Input 送达执行器 | 消息作为**任务上下文**追加，并**可选**唤醒 owner |
 * | 授权影响 | 只给上下文，不授予新权力 | 同：**只给上下文，不改变任务状态** |
 * | 生成方式 | 模型/人订阅 | 人/模型订阅（显式） |
 *
 * **刻意不做的事**：扇出不改变任务状态、不授予「可以开工」的权力——
 * 与 Super-agent 的设计一致（Subscription 只加 context，不加 authority）。
 * 谁有权开工仍由任务本身的 claim 决定。
 *
 * ## 四条不变量
 *
 * 1. **事件流是真相源**：先 append `subscription.jsonl`，再改内存，最后写快照。
 * 2. **CAS**：所有变更带 `expectedRev`；不匹配即抛错，绝不静默覆盖。
 * 3. **幂等**：同一 (taskId, roomId) 只存在一条活订阅；重复 subscribe 返回既有记录。
 * 4. **绝不静默失败**：订阅/取消订阅/扇出全部有明确返回值与可读原因。
 *
 * ## 扇出节流（K4 类比）
 *
 * 房间发消息可以很频繁，每条都扇出会让任务上下文爆炸。
 * 故扇出有两条约束：
 *   - 每次扇出只保留**最近 N 条**（默认 20，`fanoutKeep`），滚动的上下文窗口；
 *   - **唤醒**默认关闭（`wakeOnFanout:false`）——上下文到达不等于要打扰执行者。
 *
 * ## 依赖面
 *
 * node 内置 + `./store.js` + `./kernel.js`（惰性）。零第三方依赖。
 */

import { appendJsonl, readJsonl, readJson, writeJsonAtomic, ensureDir, statePath } from './store.js'

let kernel = null
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

/** 合法状态。 */
export const SUB_STATES = Object.freeze(['active', 'active_stopped', 'dropped'])

/** 事件动作集合。 */
const ACTIONS = ['subscribe', 'unsubscribe', 'fanout', 'drop']

/** 缺省配置。 */
const DEFAULTS = Object.freeze({
  /** 每个任务保留的上下文条目上限（滚动窗口）。 */
  fanoutKeep: 20,
  /** 扇出后是否唤醒 owner（默认否：上下文到达不等于要打扰）。 */
  wakeOnFanout: false,
})

/** 结构化错误。 */
export class SubscriptionError extends Error {
  constructor(message, code = 'SUBSCRIPTION_ERROR', details) {
    super(message)
    this.name = 'SubscriptionError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SubscriptionError(
      `subscription.${where}：${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
      'SUBSCRIPTION_BAD_FIELD',
      { where, field },
    )
  }
  return value.trim()
}

function optionalString(value, field, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new SubscriptionError(
      `subscription.${where}：${field} 必须是字符串，收到 ${JSON.stringify(value)}`,
      'SUBSCRIPTION_BAD_FIELD',
      { where, field },
    )
  }
  return value
}

function normalizeNow(value, where) {
  if (value === undefined || value === null) return Date.now()
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SubscriptionError(
      `subscription.${where}：now 必须是有限数字，收到 ${JSON.stringify(value)}`,
      'SUBSCRIPTION_BAD_FIELD',
      { where, field: 'now' },
    )
  }
  return value
}

function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') return config.stateDir.trim()
  if (kernel && typeof kernel.stateDir === 'function') return kernel.stateDir()
  const reason = kernelError?.message ?? (kernel ? 'kernel.stateDir 不存在' : 'kernel 未加载')
  throw new SubscriptionError(
    `subscription.createSubscription：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`,
    'SUBSCRIPTION_NO_STATE_DIR',
  )
}

/**
 * 创建订阅服务。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx]
 * @param {{ stateDir?: string, fanoutKeep?: number, wakeOnFanout?: boolean, now?: () => number }} [config]
 * @returns {object} subscription service
 */
export function createSubscription(ctx, config = {}) {
  const stateDir = resolveStateDir(config)
  const jsonlPath = statePath(stateDir, 'subscription.jsonl')
  const snapPath = statePath(stateDir, 'subscription.snap.json')
  const fanoutKeep = Number.isFinite(config.fanoutKeep) && config.fanoutKeep > 0
    ? Math.floor(config.fanoutKeep)
    : DEFAULTS.fanoutKeep
  const wakeOnFanout = config.wakeOnFanout === true
  const now = typeof config.now === 'function' ? config.now : () => Date.now()

  const info = (...args) => { try { ctx?.logger?.info?.(...args) } catch { /* */ } }
  const warn = (...args) => { try { ctx?.logger?.warn?.(...args) } catch { /* */ } }

  /** @type {Map<string, object>} 订阅 id → Subscription */
  const subs = new Map()
  /** 索引：(taskId, roomId) → subId（活订阅唯一） */
  const liveIndex = new Map()
  /** 全部事件（审计） */
  const events = []
  let idCounter = 0

  const diagnostics = {
    stateDir,
    jsonlPath,
    snapPath,
    hydratedFrom: null,
    replayedEvents: 0,
    badLines: 0,
    snapshotWriteFailures: 0,
    fanouts: 0,
    wakeFailures: 0,
  }

  function snapshot() {
    return { version: 1, savedAt: Date.now(), idCounter, subs: [...subs.values()] }
  }

  /**
   * 提交一次变更：**先落事件，再改内存，最后写快照**。顺序不可颠倒。
   */
  function commit(action, at, by, before, after) {
    if (!appendJsonl(jsonlPath, { id: after.id, rev: after.rev, action, by, at, before, after })) {
      throw new SubscriptionError(
        `subscription.${action}：事件追加失败（${jsonlPath}）——拒绝「只改内存不落盘」`,
        'SUBSCRIPTION_APPEND_FAILED',
        { action },
      )
    }
    subs.set(after.id, clone(after))
    events.push({ id: after.id, rev: after.rev, action, by, at, before: before ? clone(before) : null, after: clone(after) })
    if (after.state === 'active') liveIndex.set(keyOf(after.taskId, after.roomId), after.id)
    else liveIndex.delete(keyOf(after.taskId, after.roomId))
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/subscription] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可恢复`)
    }
    return clone(after)
  }

  function keyOf(taskId, roomId) {
    return `${taskId}::${roomId}`
  }

  function hydrate() {
    subs.clear()
    liveIndex.clear()
    events.length = 0
    idCounter = 0
    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) warn(`[cs-bots/subscription] ${jsonlPath} 有 ${bad} 行无法解析——已跳过，请核对`)
    if (rows.length === 0) {
      const snap = readJson(snapPath, null)
      const list = Array.isArray(snap?.subs) ? snap.subs : null
      if (list) {
        for (const raw of list) {
          if (!raw || typeof raw.id !== 'string') continue
          subs.set(raw.id, clone(raw))
          if (raw.state === 'active') liveIndex.set(keyOf(raw.taskId, raw.roomId), raw.id)
          const m = /^sub-(\d+)$/.exec(raw.id)
          if (m) idCounter = Math.max(idCounter, Number(m[1]))
        }
        if (Number.isFinite(snap?.idCounter)) idCounter = Math.max(idCounter, snap.idCounter)
        diagnostics.hydratedFrom = 'snapshot'
        info(`[cs-bots/subscription] 回放完成：由快照恢复 ${subs.size} 条订阅`)
        return
      }
      diagnostics.hydratedFrom = 'empty'
      return
    }
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.id !== 'string' || !ev.after) { skipped += 1; continue }
      const cur = subs.get(ev.id)
      if (cur && Number.isFinite(ev.rev) && ev.rev <= cur.rev) { skipped += 1; continue }
      subs.set(ev.id, clone(ev.after))
      events.push(clone(ev))
      if (ev.after.state === 'active') liveIndex.set(keyOf(ev.after.taskId, ev.after.roomId), ev.after.id)
      else liveIndex.delete(keyOf(ev.after.taskId, ev.after.roomId))
      const m = /^sub-(\d+)$/.exec(ev.id)
      if (m) idCounter = Math.max(idCounter, Number(m[1]))
    }
    if (skipped > 0) warn(`[cs-bots/subscription] 回放跳过 ${skipped} 条非递增/残缺事件`)
    diagnostics.hydratedFrom = 'jsonl'
  }

  function requireSub(id, where) {
    const s = subs.get(id)
    if (!s) {
      throw new SubscriptionError(
        `subscription.${where}：订阅 ${id} 不存在`,
        'SUBSCRIPTION_NOT_FOUND',
        { where, id },
      )
    }
    return s
  }

  function cas(id, expectedRev, where) {
    const s = requireSub(id, where)
    if (expectedRev !== undefined && expectedRev !== null) {
      if (!Number.isInteger(expectedRev)) {
        throw new SubscriptionError(
          `subscription.${where}：expectedRev 必须是整数（当前 rev=${s.rev}）`,
          'SUBSCRIPTION_BAD_FIELD', { where, field: 'expectedRev' },
        )
      }
      if (s.rev !== expectedRev) {
        throw new SubscriptionError(
          `subscription.${where} CAS 冲突：订阅 ${id} 期望 rev=${expectedRev}，实际 rev=${s.rev} —— 拒绝静默覆盖`,
          'SUBSCRIPTION_REV_CONFLICT', { where, id, expectedRev, rev: s.rev },
        )
      }
    }
    return s
  }

  // ── 写 ────────────────────────────────────────────────────────────────────

  /**
   * 订阅：让任务接收某个房间的后续消息。
   *
   * **幂等**：同一 (taskId, roomId) 已有活订阅时，直接返回既有记录
   * （不抛错、不新建——重复订阅是无害的用户操作）。
   *
   * @param {{ taskId: string, roomId: string, note?: string, by: string, now?: number }} input
   * @returns {object} Subscription
   */
  function subscribe(input = {}) {
    const { taskId, roomId, note, by, now: at0 } = input ?? {}
    const tId = requireString(taskId, 'taskId', 'subscribe')
    const rId = requireString(roomId, 'roomId', 'subscribe')
    const author = requireString(by, 'by', 'subscribe')
    const n = optionalString(note, 'note', 'subscribe')
    const at = normalizeNow(at0, 'subscribe')

    // 幂等：已有活订阅 → 原样返回
    const existingId = liveIndex.get(keyOf(tId, rId))
    if (existingId) {
      const existing = subs.get(existingId)
      if (existing && existing.state === 'active') {
        info(`[cs-bots/subscription] subscribe 幂等命中 ${tId} ↔ ${rId} → 复用 ${existingId}`)
        return clone(existing)
      }
    }

    idCounter += 1
    const id = `sub-${idCounter}`
    /** @type {Record<string, unknown>} */
    const sub = {
      id,
      rev: 1,
      taskId: tId,
      roomId: rId,
      state: 'active',
      context: [],
      fanoutCount: 0,
      createdAt: at,
      createdBy: author,
      updatedAt: at,
      updatedBy: author,
    }
    if (n !== undefined) sub.note = n
    commit('subscribe', at, author, null, sub)
    info(`[cs-bots/subscription] ${id}：任务 ${tId} 订阅房间 ${rId}`)
    return clone(sub)
  }

  /**
   * 取消订阅（活 → dropped，终态）。
   *
   * @param {{ id: string, expectedRev?: number, by: string, now?: number }} input
   * @returns {object} Subscription
   */
  function unsubscribe(input = {}) {
    const { id, expectedRev, by, now: at0 } = input ?? {}
    const author = requireString(by, 'by', 'unsubscribe')
    const at = normalizeNow(at0, 'unsubscribe')
    const cur = cas(id, expectedRev, 'unsubscribe')
    if (cur.state === 'dropped') {
      throw new SubscriptionError(
        `subscription.unsubscribe：订阅 ${id} 已是 dropped（终态），无法再次取消`,
        'SUBSCRIPTION_ALREADY_DROPPED', { id },
      )
    }
    const next = clone(cur)
    next.rev = cur.rev + 1
    next.state = 'dropped'
    next.droppedAt = at
    next.droppedBy = author
    next.updatedAt = at
    next.updatedBy = author
    commit('unsubscribe', at, author, clone(cur), next)
    return clone(next)
  }

  /**
   * 扇出：把房间的一条消息送达所有订阅该房间的活任务。
   *
   * **只加上下文，不改任务状态**（与 Super-agent「Subscription 只加 context 不加 authority」一致）。
   * 每条订阅的 `context` 是滚动窗口（默认保留最近 20 条）。
   *
   * @param {{ roomId: string, message: object, wake?: boolean, by?: string, now?: number }} input
   * @returns {{ fanned: number, woke: number, failed: number, details: object[] }}
   */
  async function fanout(input = {}) {
    const { roomId, message, wake } = input ?? {}
    const rId = requireString(roomId, 'roomId', 'fanout')
    if (!message || typeof message !== 'object') {
      throw new SubscriptionError(
        'subscription.fanout：message 必须是消息对象',
        'SUBSCRIPTION_BAD_FIELD', { field: 'message' },
      )
    }
    const at = normalizeNow(input.now, 'fanout')
    const by = typeof input.by === 'string' && input.by ? input.by : 'system'
    const shouldWake = wake === true || (wake === undefined && wakeOnFanout)

    // 找出订阅该房间的全部活订阅
    const targets = [...subs.values()].filter((s) => s.roomId === rId && s.state === 'active')
    const details = []
    let woke = 0
    let failed = 0

    for (const s of targets) {
      const entry = {
        from: message.from ?? '?',
        seq: message.seq ?? null,
        text: typeof message.text === 'string' ? message.text.slice(0, 2000) : '',
        at: message.at ?? at,
        messageId: message.id ?? null,
      }
      const next = clone(s)
      next.rev = s.rev + 1
      const ctx = Array.isArray(s.context) ? [...s.context, entry] : [entry]
      // 滚动窗口：只留最近 fanoutKeep 条
      next.context = ctx.length > fanoutKeep ? ctx.slice(-fanoutKeep) : ctx
      next.fanoutCount = (s.fanoutCount ?? 0) + 1
      next.lastFanoutAt = at
      next.updatedAt = at
      next.updatedBy = by
      try {
        commit('fanout', at, by, clone(s), next)
        diagnostics.fanouts += 1
      } catch (error) {
        failed += 1
        details.push({ subId: s.id, taskId: s.taskId, ok: false, reason: `commit-failed:${error?.message ?? error}` })
        continue
      }

      // 可选唤醒（默认关）：上下文到达不等于要打扰执行者
      if (shouldWake) {
        try {
          // 通过 dispatcher 发（若可用），否则直接 kernel.followup
          const text = `[任务上下文] 房间 ${rId} 新消息（${entry.from}）：${entry.text.slice(0, 500)}`
          const wakeResult = await wakeTask(s.taskId, text)
          if (wakeResult.ok) woke += 1
          else { failed += 1; diagnostics.wakeFailures += 1 }
          details.push({ subId: s.id, taskId: s.taskId, ok: true, woke: wakeResult.ok, wakeReason: wakeResult.reason })
        } catch (error) {
          failed += 1
          diagnostics.wakeFailures += 1
          details.push({ subId: s.id, taskId: s.taskId, ok: true, woke: false, reason: `wake-failed:${error?.message ?? error}` })
        }
      } else {
        details.push({ subId: s.id, taskId: s.taskId, ok: true, woke: false })
      }
    }

    return { fanned: targets.length, woke, failed, details }
  }

  /** 唤醒某任务的 owner（未提供 dispatcher 时返回明确原因，不假装成功）。 */
  async function wakeTask(taskId, text) {
    if (!kernel) return { ok: false, reason: `kernel-unavailable:${kernelError?.message ?? 'unknown'}` }
    const target = ctx?.services?.board
      ? (() => {
          try {
            const t = ctx.services.board.get(taskId)
            return t?.ownerId
          } catch { return undefined }
        })()
      : undefined
    if (!target) return { ok: false, reason: 'task-has-no-owner' }
    try {
      const out = kernel.followup(ctx, target, text)
      return { ok: Boolean(out?.ok), reason: out?.reason }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  function get(id) {
    const s = subs.get(id)
    return s ? clone(s) : null
  }

  function list(query = {}) {
    let rows = [...subs.values()]
    if (query?.taskId) rows = rows.filter((s) => s.taskId === query.taskId)
    if (query?.roomId) rows = rows.filter((s) => s.roomId === query.roomId)
    if (query?.state) rows = rows.filter((s) => s.state === query.state)
    return clone(rows)
  }

  /** 某任务的全部活订阅（任务详情页显示「订阅了什么」）。 */
  function listByTask(taskId) {
    return clone([...subs.values()].filter((s) => s.taskId === taskId))
  }

  /** 某房间的订阅者任务 id 列表（房间页显示「谁在听」）。 */
  function subscribersOf(roomId) {
    return [...subs.values()]
      .filter((s) => s.roomId === roomId && s.state === 'active')
      .map((s) => s.taskId)
  }

  function stats() {
    const byState = {}
    for (const s of subs.values()) byState[s.state] = (byState[s.state] ?? 0) + 1
    return {
      total: subs.size,
      active: byState.active ?? 0,
      dropped: byState.dropped ?? 0,
      byState,
      fanouts: diagnostics.fanouts,
      wakeFailures: diagnostics.wakeFailures,
      events: events.length,
    }
  }

  function replay() {
    hydrate()
    return { from: diagnostics.hydratedFrom, events: events.length, bad: diagnostics.badLines }
  }

  hydrate()

  return {
    name: config.name ?? 'subscription',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    subscribe,
    unsubscribe,
    fanout,
    get,
    list,
    listByTask,
    subscribersOf,
    stats,
    replay,
    diagnostics: () => clone(diagnostics),
    constants: Object.freeze({
      SUB_STATES: Object.freeze([...SUB_STATES]),
      ACTIONS: Object.freeze([...ACTIONS]),
      DEFAULTS,
    }),
  }
}

export default createSubscription