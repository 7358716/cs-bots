/**
 * cs-bots Dispatcher 测试 —— 唤醒桥的**不变量**与三条纪律。
 *
 * 依据 `multiagent/10-初步架构设计方案-v1.md` §3.5（去重 / 节流 / 背压）+ §3.6 K4
 * （投递必须有背压，绝不静默丢弃），以及「绝不静默失败」的总纪律。
 *
 * 测试环境约束：
 *   - 用**可控时钟**（`config.now`）替代真实等待 → 秒级完成、无 flake。
 *   - 走**真实** `kernel.followup`（不 mock kernel），用 fake live agent 制造成功路径、
 *     用空 ctx 制造失败路径 —— 测的是真实集成链。
 *
 * ⚠️ 两条**实现语义**（写断言前必须知道，否则会写出假失败）：
 *   1. **节流只在「成功投递」后冷却**：`lastSentAt` 仅在 `deliver()` 成功分支里更新
 *      （`src/dispatcher.js:375`）。⇒ 节流测试必须让投递**成功**，否则第二次不会被延后。
 *   2. **去重检查在背压检查之前**：所以「同 key 重复」永远先命中 `dedup-hit`，
 *      只有**新 key** 才会走到背压分支（`src/dispatcher.js:468` → `:484`）。
 *      ⇒ 背压测试必须每次换一个新 key。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDispatcher, WAKE_REASONS, NOTIFY_RESULTS } from '../src/dispatcher.js'

/** 目标会话（有 fake agent 时投递会成功）。 */
const T = 's-agent'

/**
 * 造隔离的临时状态目录 + 可控时钟 + 可选 fake agent。
 *
 * @param {object} [overrides]
 * @param {boolean} [overrides.withAgent] true=装 fake live agent（投递成功）；缺省=空 ctx（投递失败）
 */
function harness(overrides = {}) {
  const { withAgent = false, ...configOverrides } = overrides
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-disp-'))
  let clock = 1_000_000
  const now = () => clock

  /** 已投递消息（断言用）。 */
  const delivered = []
  const fakeAgent = {
    id: T,
    followup(message) {
      delivered.push(message)
    },
  }
  // `anyAgent:true` 时任何 target 都投递成功（byTeam 等聚合测试要多个 target 都 sent）；
  // 缺省仍只认 T，保持既有测试的失败路径语义不变。
  const { anyAgent = false } = overrides
  const ctx = withAgent
    ? {
        get: (key) =>
          key === 'agents'
            ? {
                get: (id) => (anyAgent || id === T ? fakeAgent : undefined),
                list: () => [fakeAgent],
              }
            : undefined,
      }
    : {}

  const dispatcher = createDispatcher(ctx, {
    stateDir,
    now,
    throttleMs: 5_000,
    maxPerTarget: 3,
    queueTtlMs: 60_000,
    ...configOverrides,
  })

  return {
    dispatcher,
    stateDir,
    ctx,
    delivered,
    wakesFile: join(stateDir, 'wakes.jsonl'),
    tick(ms) {
      clock += ms
    },
    readWakes() {
      const f = join(stateDir, 'wakes.jsonl')
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    },
    cleanup() {
      dispatcher.dispose()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

// ── 契约：常量集 ─────────────────────────────────────────────────────────────

test('WAKE_REASONS 覆盖 §3.5 的全部五种原因', () => {
  assert.deepEqual(
    [...WAKE_REASONS].sort(),
    ['lease-timeout', 'room-message', 'task-assigned', 'task-unblocked', 'timer'].sort(),
  )
})

test('NOTIFY_RESULTS 含 pending（比 Wake.result 多一个）', () => {
  assert.deepEqual([...NOTIFY_RESULTS].sort(), ['failed', 'pending', 'sent', 'skipped'].sort())
})

// ── 纪律 1：去重 ─────────────────────────────────────────────────────────────

test('去重：同 dedupKey 第二次必须 skipped，且 reason=dedup-hit', () => {
  const h = harness({ withAgent: true })
  try {
    const first = h.dispatcher.notify({ target: T, reason: 'task-assigned', dedupKey: 'K1', text: 'a' })
    assert.equal(first.result, 'sent')

    const second = h.dispatcher.notify({ target: T, reason: 'task-assigned', dedupKey: 'K1', text: 'a' })
    assert.equal(second.result, 'skipped')
    assert.equal(second.reason, 'dedup-hit')

    const st = h.dispatcher.stats()
    assert.equal(st.total, 2)
    assert.equal(st.sent, 1)
    assert.equal(st.skipped, 1)

    // 真投了 1 条（不是「记账了但没送」）
    assert.equal(h.delivered.length, 1)
  } finally {
    h.cleanup()
  }
})

test('去重不影响不同 dedupKey（越过节流窗后两条都该投出）', () => {
  const h = harness({ withAgent: true })
  try {
    assert.equal(h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'A' }).result, 'sent')
    h.tick(6_000) // 越过 throttleMs，避免被节流延后
    assert.equal(h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'B' }).result, 'sent')
    assert.equal(h.dispatcher.stats().skipped, 0)
    assert.equal(h.delivered.length, 2)
  } finally {
    h.cleanup()
  }
})

// ── 纪律 2：节流（延后但不丢）─────────────────────────────────────────────────

test('节流：同 target 时间窗内的第二次被延后（result=pending, reason=throttled）', () => {
  const h = harness({ withAgent: true })
  try {
    const a = h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'A' })
    assert.equal(a.result, 'sent')

    h.tick(100) // 仍在 5000ms 窗内
    const b = h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'B' })
    assert.equal(b.result, 'pending', '窗内第二次应挂起而非投递')
    assert.equal(b.reason, 'throttled')
    assert.equal(h.dispatcher.stats().deferred, 1)
    assert.equal(h.dispatcher.stats().pending, 1)
    // **没丢**：消息仍在队列里
    assert.equal(h.delivered.length, 1, '挂起的不应被投出')
  } finally {
    h.cleanup()
  }
})

test('节流：越过时间窗后 flush 能把挂起的投出去（不丢唤醒）', () => {
  const h = harness({ withAgent: true })
  try {
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'A' })
    h.tick(100)
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'B' })

    h.tick(6_000) // 越过 throttleMs
    const flushed = h.dispatcher.flush()
    assert.ok(flushed.sent >= 1, `flush 应投出挂起项，实际 ${JSON.stringify(flushed)}`)
    assert.equal(h.dispatcher.stats().pending, 0)
    assert.equal(h.delivered.length, 2, '两条都应最终送达')
  } finally {
    h.cleanup()
  }
})

test('显式 delayMs 推迟；flush() 不投、flush({force:true}) 投出', () => {
  const h = harness({ withAgent: true })
  try {
    const r = h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'D', delayMs: 60_000 })
    assert.equal(r.result, 'pending')
    assert.equal(r.reason, 'scheduled-delay')

    const early = h.dispatcher.flush()
    assert.equal(early.sent, 0, '未到期不应投出')

    const forced = h.dispatcher.flush({ force: true })
    assert.equal(forced.sent, 1, 'force 应无视未到期直接投出')
    assert.equal(h.delivered.length, 1)
  } finally {
    h.cleanup()
  }
})

// ── 纪律 3：背压（K4）—— 拒绝且**可见** ──────────────────────────────────────

test('背压：队列满时拒绝（ok=false, reason=backpressure），并落 failed 记录', () => {
  const h = harness({ withAgent: true, maxPerTarget: 3 })
  try {
    // 用 delayMs 把它们挂在队列里（不被节流也不立刻投出）
    for (let i = 0; i < 3; i += 1) {
      const r = h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: `F${i}`, delayMs: 60_000 })
      assert.equal(r.result, 'pending')
    }
    assert.equal(h.dispatcher.stats().pending, 3)

    // ⚠️ 必须用**新 key**：同 key 会先命中 dedup-hit（去重检查在背压之前）
    const over = h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'F-over', delayMs: 60_000 })
    assert.equal(over.ok, false)
    assert.equal(over.result, 'failed')
    assert.equal(over.reason, 'backpressure')
    assert.equal(h.dispatcher.stats().backpressured, 1)

    // **绝不静默**：盘上必须有这条 failed 记录。
    // ⚠️ 语义：Wake.reason 存的是**唤醒原因**（'timer'），背压的判据在 `detail` 里
    //    （`queue-full:<n>/<max>`），并带 `keyReleased:true`（该请求未被接受）。
    const failed = h.readWakes().filter(
      (w) => w.result === 'failed' && String(w.detail ?? '').startsWith('queue-full:'),
    )
    assert.equal(failed.length, 1, '背压拒绝必须落一条 failed 记录')
    assert.equal(failed[0].keyReleased, true, '背压拒绝应释放 dedupKey（队列疏通后可重发）')
  } finally {
    h.cleanup()
  }
})

test('背压：被拒绝的新 key 会释放，队列疏通后可用同一 key 重发', () => {
  const h = harness({ withAgent: true, maxPerTarget: 1 })
  try {
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'X', delayMs: 60_000 })
    // 新 key 'Y' 才走背压分支
    const rejected = h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'Y', delayMs: 60_000 })
    assert.equal(rejected.reason, 'backpressure')

    // 疏通队列
    h.dispatcher.flush({ force: true })

    // 'Y' 已被释放 → 可以重发（不会被去重误杀）
    const again = h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'Y', delayMs: 60_000 })
    assert.equal(again.result, 'pending', '被拒绝的 key 应在疏通后可重发')
    assert.notEqual(again.reason, 'dedup-hit')
  } finally {
    h.cleanup()
  }
})

test('背压不跨 target 误伤：一个 target 满了，另一个照常投递', () => {
  const h = harness({ withAgent: true, maxPerTarget: 1 })
  try {
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'A1', delayMs: 60_000 })
    const otherFull = h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'A2', delayMs: 60_000 })
    assert.equal(otherFull.reason, 'backpressure')

    // 另一个 target（无 agent → 会 failed，但**不应是 backpressure**）
    const other = h.dispatcher.notify({ target: 's-other', reason: 'timer', dedupKey: 'O1' })
    assert.notEqual(other.reason, 'backpressure', '别的 target 不该受本 target 队列影响')
  } finally {
    h.cleanup()
  }
})

// ── 失败可见：真实集成路径（无 agents 服务 → kernel.followup 失败）────────────

test('投递失败可见：无 agents 服务时 failed 且 reason 可读，并落盘', () => {
  const h = harness() // 空 ctx，无 fake agent
  try {
    const r = h.dispatcher.notify({ target: 's-missing', reason: 'task-assigned', dedupKey: 'M1' })
    assert.equal(r.ok, false)
    assert.equal(r.result, 'failed')
    assert.equal(r.reason, 'agent-not-live', 'reason 应指向真实原因')

    const recorded = h.readWakes().filter((w) => w.result === 'failed')
    assert.ok(recorded.length >= 1, '投递失败必须落盘（绝不静默）')
    assert.ok(
      recorded.some((w) => String(w.detail ?? '').includes('agent-not-live')),
      'failed 记录应带可读 detail',
    )
    assert.equal(h.dispatcher.stats().failed, 1)
  } finally {
    h.cleanup()
  }
})

test('投递失败**保留** dedupKey（intent-first：见 dispatcher 头部设计意图）', () => {
  const h = harness()
  try {
    const first = h.dispatcher.notify({ target: 's-missing', reason: 'timer', dedupKey: 'R1' })
    assert.equal(first.result, 'failed')

    // ⚠️ 实现语义（`src/dispatcher.js:42-50` 原文）：
    //   "先占键 → 再投递，投递失败也不释放（原因已落盘、已可见，由上层按自己的策略
    //    决定是否用**新的** dedupKey 重派）。"
    //   ⇒ 同 key 重试会命中 dedup-hit（这是**有意**防「无限空转烧 token」）。
    const again = h.dispatcher.notify({ target: 's-missing', reason: 'timer', dedupKey: 'R1' })
    assert.equal(again.reason, 'dedup-hit', '投递失败后同 key 重试应被去重（intent-first）')

    // 但用**新** key 重派必须可行
    const retry = h.dispatcher.notify({ target: 's-missing', reason: 'timer', dedupKey: 'R2' })
    assert.equal(retry.result, 'failed')
    assert.equal(retry.reason, 'agent-not-live')

    // 两种「请求根本未被接受」的例外：背压会释放 key（已在背压用例覆盖）；
    // 此处再验：**失败记录本身落盘且可读**（不静默）
    const failedRows = h.readWakes().filter((w) => w.result === 'failed')
    assert.equal(failedRows.length, 2)
    assert.ok(failedRows.every((w) => String(w.detail ?? '').includes('agent-not-live')))
  } finally {
    h.cleanup()
  }
})

// ── 输入校验：不合法明确拒绝 ──────────────────────────────────────────────────

test('非法 target：明确 failed + reason=invalid-target', () => {
  const h = harness()
  try {
    for (const bad of [undefined, '', 123]) {
      const r = h.dispatcher.notify({ target: bad, reason: 'timer' })
      assert.equal(r.result, 'failed')
      assert.equal(r.reason, 'invalid-target')
    }
  } finally {
    h.cleanup()
  }
})

test('非法 reason：明确 failed + reason=invalid-reason（且落盘可审计）', () => {
  const h = harness()
  try {
    const r = h.dispatcher.notify({ target: T, reason: 'not-a-real-reason' })
    assert.equal(r.result, 'failed')
    assert.equal(r.reason, 'invalid-reason')
    assert.ok(h.readWakes().some((w) => String(w.detail ?? '').includes('invalid-reason')))
  } finally {
    h.cleanup()
  }
})

// ── 恒等式与审计面 ────────────────────────────────────────────────────────────

test('统计恒等式：total === sent + skipped + failed + pending', () => {
  const h = harness({ withAgent: true, maxPerTarget: 2 })
  try {
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'A' }) // sent
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'A' }) // skipped（同 key）
    h.dispatcher.notify({ target: '', reason: 'timer' }) // failed（非法 target）
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'Q1', delayMs: 60_000 }) // pending
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'Q2', delayMs: 60_000 }) // pending
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'Q3', delayMs: 60_000 }) // 背压 → failed

    const st = h.dispatcher.stats()
    assert.equal(
      st.total,
      st.sent + st.skipped + st.failed + st.pending,
      `恒等式不成立：${JSON.stringify(st)}`,
    )
  } finally {
    h.cleanup()
  }
})

test('list() 从盘读（非内存），进程重启后仍可审计', () => {
  const h = harness({ withAgent: true })
  const stateDir = h.stateDir
  try {
    h.dispatcher.notify({ target: T, reason: 'lease-timeout', dedupKey: 'L1' })

    // 另建实例指向同一目录（模拟重启）
    const reopened = createDispatcher({}, { stateDir, now: () => 1_000_000 })
    try {
      const rows = reopened.list({ limit: 50 })
      assert.ok(rows.length >= 1, '重启后应从 wakes.jsonl 读到历史')
      assert.ok(rows.some((w) => w.target === T))
    } finally {
      reopened.dispose()
    }
  } finally {
    h.cleanup()
  }
})

test('list({target}) 只返回该目标；坏行计入 bad 而不静默丢弃', () => {
  const h = harness({ withAgent: true })
  try {
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'P1' })
    h.dispatcher.notify({ target: 's-zzz', reason: 'timer', dedupKey: 'P2' })

    const only = h.dispatcher.list({ target: T })
    assert.ok(only.every((w) => w.target === T))
    assert.equal(typeof only.bad, 'number', 'bad 计数应可见（非枚举属性）')
  } finally {
    h.cleanup()
  }
})

test('dispose() 可安全重复调用，且不投递', () => {
  const h = harness({ withAgent: true })
  try {
    h.dispatcher.notify({ target: T, reason: 'timer', dedupKey: 'Z', delayMs: 60_000 })
    h.dispatcher.dispose()
    h.dispatcher.dispose()
    assert.equal(h.dispatcher.stats().pending, 1, 'dispose 不应丢队列（也不应代投）')
  } finally {
    h.cleanup()
  }
})

// ══ t-39 第2批 D：唤醒成本可见（teamId 落盘 + 按团队聚合）══════════════════════

test('wakes.jsonl：teamId 传入即落盘（用于按团队统计唤醒成本）', () => {
  const h = harness({ withAgent: true })
  try {
    h.dispatcher.notify({ target: T, reason: 'room-message', dedupKey: 'D1', text: 'x', teamId: 'team-7' })
    const row = h.readWakes().find((w) => w.dedupKey === 'D1')
    assert.ok(row, '应有 D1 记录')
    assert.equal(row.teamId, 'team-7')
  } finally {
    h.cleanup()
  }
})

test('wakes.jsonl：没传 teamId ⇒ 写 null，绝不瞎猜一个团队塞进去', () => {
  const h = harness({ withAgent: true })
  try {
    h.dispatcher.notify({ target: T, reason: 'task-assigned', dedupKey: 'D2', text: 'x' })
    const row = h.readWakes().find((w) => w.dedupKey === 'D2')
    assert.ok(row, '应有 D2 记录')
    assert.equal(row.teamId, null, '与团队无关的唤醒必须是 null，不能凭空归到某个团队')
  } finally {
    h.cleanup()
  }
})

test('list({ teamId }) 只返回该团队的唤醒记录', () => {
  const h = harness({ withAgent: true, anyAgent: true })
  try {
    // 用不同 target + 拉时间，避开 throttle（同 target 连发会被推迟，记录尚未落盘）
    h.dispatcher.notify({ target: 's-1', reason: 'room-message', dedupKey: 'T1', teamId: 'team-1' })
    h.tick(10_000)
    h.dispatcher.notify({ target: 's-2', reason: 'room-message', dedupKey: 'T2', teamId: 'team-2' })
    h.tick(10_000)
    h.dispatcher.notify({ target: 's-3', reason: 'timer', dedupKey: 'T3' })
    h.tick(10_000)
    assert.equal(h.dispatcher.list({ teamId: 'team-1' }).length, 1)
    assert.equal(h.dispatcher.list({ teamId: 'team-2' }).length, 1)
    assert.equal(h.dispatcher.list({}).length, 3)
  } finally {
    h.cleanup()
  }
})

test('byTeam()：按团队聚合次数/结果分布，null 桶单独归（不混进任何团队）', () => {
  const h = harness({ withAgent: true, anyAgent: true })
  try {
    // 每发一条都推进时钟 —— 同 target 连发会被 throttle 推迟，记录还没到终态
    for (const [target, teamId, key] of [['s-1','team-A','B1'],['s-2','team-A','B2'],['s-3','team-B','B3'],['s-4',undefined,'B4']]) {
      h.dispatcher.notify({ target, reason: 'room-message', dedupKey: key, ...(teamId ? { teamId } : {}) })
      h.tick(10_000)
    }

    const agg = h.dispatcher.byTeam()
    assert.equal(agg.total, 4)
    assert.equal(agg.teams.length, 2, '两个真实团队')
    const a = agg.teams.find((x) => x.teamId === 'team-A')
    assert.equal(a.count, 2)
    assert.equal(a.sent, 2)
    assert.equal(a.targetsList.length, 2, 'team-A 有 2 个不同 target')
    assert.equal(a.sent, 2, '两条都真的投递成功')
    const b = agg.teams.find((x) => x.teamId === 'team-B')
    assert.equal(b.count, 1)
    // 无团队的那次必须落在 unassigned，且**不**算进 team-A/team-B
    assert.equal(agg.unassigned.teamId, null)
    assert.equal(agg.unassigned.count, 1)
    assert.equal(a.count + b.count + agg.unassigned.count, agg.total, '三个桶加起来必须等于总数')
  } finally {
    h.cleanup()
  }
})

test('byTeam({since})：只统计该时刻之后的记录', () => {
  const h = harness({ withAgent: true, anyAgent: true })
  try {
    h.dispatcher.notify({ target: 's-1', reason: 'room-message', dedupKey: 'S1', teamId: 'team-A' })
    h.tick(10_000)
    const cutoff = 1_000_000 + 5_000 // 落在第一条(scheduledAt=1_000_000)与第二条(scheduledAt=1_010_000)之间
    h.dispatcher.notify({ target: 's-2', reason: 'room-message', dedupKey: 'S2', teamId: 'team-A' })
    h.tick(10_000)

    const all = h.dispatcher.byTeam()
    assert.equal(all.teams.find((x) => x.teamId === 'team-A').count, 2)
    const recent = h.dispatcher.byTeam({ since: cutoff })
    assert.equal(recent.teams.find((x) => x.teamId === 'team-A').count, 1, 'since 之后只剩 1 条')
  } finally {
    h.cleanup()
  }
})
