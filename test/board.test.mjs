/**
 * BoardService 测试 —— 只碰 `node:test` + `node:assert` + `node:fs` + `node:os` + `node:path`。
 *
 * 覆盖硬约束里的每一条，且每条都用**实际落盘产物**做证据（读 board.jsonl / board.snap.json），
 * 不接受「函数没抛错」这种弱断言。
 *
 * 运行：`node --test test/board.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBoard, BoardError } from '../src/board.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/**
 * 每个用例一个独立状态目录（互不污染）。
 * 目录优先放 `BOARD_TEST_TMPDIR`（沙箱受限时可指定到工作区内），否则走系统临时目录。
 */
function setup(t, config = {}) {
  const base = process.env.BOARD_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-board-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const board = createBoard({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, board }
}

/** 读事件流（真相源）。 */
function events(dir) {
  const file = join(dir, 'board.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 建一个普通任务（省去每个用例重复的样板）。 */
function seed(board, over = {}) {
  return board.create({ subject: 'S', byId: 'lead', ...over })
}

// ── 1. 形状与落盘 ───────────────────────────────────────────────────────────

test('create：返回 §3.3 的 Task 形状，且事件与快照都落盘', (t) => {
  const { dir, board } = setup(t)
  const task = seed(board, { subject: '实现 BoardService', description: '跨会话任务板', priority: 3, dueAt: 1_800_000_000_000, writeScopes: ['src/board.js'] })

  assert.equal(task.id, 't-1')
  assert.equal(task.rev, 1)
  assert.equal(task.status, 'pending')
  assert.deepEqual(task.blockedBy, [])
  assert.deepEqual(task.writeScopes, ['src/board.js'])
  assert.equal(task.priority, 3)
  assert.equal(task.dueAt, 1_800_000_000_000)
  assert.equal(task.lease, undefined)
  assert.equal(task.sourceSeq, undefined)

  const rows = events(dir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, 'create')
  assert.equal(rows[0].rev, 1)
  assert.equal(rows[0].byId, 'lead')
  assert.equal(rows[0].before, null)
  assert.equal(rows[0].after.id, 't-1')
  assert.ok(existsSync(join(dir, 'board.snap.json')), '快照应已写入')
})

test('create：缺 subject / byId、description 超长、blockedBy 引用不存在 → 全部抛可读错误', (t) => {
  const { board } = setup(t)

  assert.throws(() => board.create({ byId: 'lead' }), (e) => e instanceof BoardError && e.code === 'BOARD_MISSING_FIELD' && /subject/.test(e.message))
  assert.throws(() => board.create({ subject: 'x' }), (e) => e instanceof BoardError && e.code === 'BOARD_MISSING_FIELD' && /byId/.test(e.message))
  assert.throws(
    () => board.create({ subject: 'x', byId: 'lead', description: 'a'.repeat(16385) }),
    (e) => e instanceof BoardError && e.code === 'BOARD_DESCRIPTION_TOO_LONG' && /16384/.test(e.message),
  )
  assert.throws(
    () => board.create({ subject: 'x', byId: 'lead', blockedBy: ['t-999'] }),
    (e) => e instanceof BoardError && e.code === 'BOARD_DEPENDENCY_NOT_FOUND' && /t-999/.test(e.message),
  )
  // 边界：正好 16384 应当被接受
  assert.equal(board.create({ subject: 'x', byId: 'lead', description: 'a'.repeat(16384) }).description.length, 16384)
})

// ── 2. CAS ──────────────────────────────────────────────────────────────────

test('CAS：两个并发 update 用同一 expectedRev → 第二个必须失败，且不覆盖第一个的结果', (t) => {
  const { dir, board } = setup(t)
  const task = seed(board, { subject: '原始标题' })

  // 两个「会话」同时读到 rev=1（各自拿到自己的快照 → 并发前提成立）
  const seenA = board.get(task.id)
  const seenB = board.get(task.id)
  assert.equal(seenA.rev, 1)
  assert.equal(seenB.rev, 1)

  // A 先赢
  const afterA = board.update({ id: task.id, expectedRev: 1, action: 'edit', subject: 'A 的标题', byId: 'bot-a' })
  assert.equal(afterA.rev, 2)

  // B 用同一个 expectedRev=1 → 必须抛错，且错误里带 rev 与实际 rev
  let caught
  try {
    board.update({ id: task.id, expectedRev: 1, action: 'edit', subject: 'B 的标题', byId: 'bot-b' })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof BoardError, '必须抛出 BoardError（绝不是静默覆盖）')
  assert.equal(caught.code, 'BOARD_REV_CONFLICT')
  assert.match(caught.message, /rev/)
  assert.equal(caught.details.rev, 2, '错误里要带上实际 rev')
  assert.equal(caught.details.expectedRev, 1)

  // A 的写入未被覆盖；B 的失败没有产生任何事件
  assert.equal(board.get(task.id).subject, 'A 的标题')
  assert.equal(board.get(task.id).rev, 2)
  const rows = events(dir)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.rev), [1, 2])

  // expectedRev 缺失/非整数 → 也要抛（不能默认接受）
  assert.throws(() => board.update({ id: task.id, action: 'edit', subject: 'x', byId: 'bot-b' }), (e) => e.code === 'BOARD_MISSING_EXPECTED_REV')

  // 拿到最新 rev 后重试成功（CAS 不是死路）
  const retry = board.update({ id: task.id, expectedRev: 2, action: 'edit', subject: 'B 的标题', byId: 'bot-b' })
  assert.equal(retry.rev, 3)
  assert.equal(retry.subject, 'B 的标题')
})

test('update/edit：未知字段、空补丁、直接补丁 status → 都抛错（不静默忽略）', (t) => {
  const { board } = setup(t)
  const task = seed(board)

  assert.throws(() => board.update({ id: task.id, expectedRev: 1, action: 'edit', byId: 'lead' }), (e) => e.code === 'BOARD_NO_PATCH_FIELDS')
  assert.throws(() => board.update({ id: task.id, expectedRev: 1, action: 'edit', byId: 'lead', nope: 1 }), (e) => e.code === 'BOARD_UNKNOWN_FIELD')
  // status 不允许走字段补丁（否则 complete 的 artifacts 校验可被绕过）
  assert.throws(() => board.update({ id: task.id, expectedRev: 1, action: 'edit', byId: 'lead', status: 'completed' }), (e) => e.code === 'BOARD_UNKNOWN_FIELD')
  assert.throws(() => board.update({ id: task.id, expectedRev: 1, action: 'frobnicate', byId: 'lead' }), (e) => e.code === 'BOARD_BAD_ACTION')
  assert.throws(() => board.update({ id: 't-404', expectedRev: 1, action: 'edit', byId: 'lead', subject: 'x' }), (e) => e.code === 'BOARD_TASK_NOT_FOUND')
  assert.equal(board.history(task.id).length, 1, '以上失败都不应产生事件')
})

// ── 3. 幂等 ─────────────────────────────────────────────────────────────────

test('幂等：同 sourceSeq 建两次 → 只有一条任务、一条 create 事件', (t) => {
  const { dir, board } = setup(t)
  const payload = { subject: '重复投递的任务', byId: 'dispatcher', sourceSeq: 'wake-001' }

  const first = board.create({ ...payload })
  const second = board.create({ ...payload })

  assert.equal(first.id, second.id, '重复创建必须返回同一个 Task')
  assert.deepStrictEqual(second, first, '返回内容逐字段相等')
  assert.equal(board.list().length, 1, 'list 里只有一条')
  assert.equal(events(dir).filter((r) => r.action === 'create').length, 1, '事件流里只有一条 create')

  // 第三次、且内容不同 → 仍然幂等（sourceSeq 是权威键）
  const third = board.create({ ...payload, subject: '改过的标题' })
  assert.equal(third.id, first.id)
  assert.equal(third.subject, '重复投递的任务', '幂等命中不得被后来者改写')

  // 不同 sourceSeq → 正常新建
  const other = board.create({ subject: '另一件事', byId: 'dispatcher', sourceSeq: 'wake-002' })
  assert.notEqual(other.id, first.id)
  assert.equal(board.list().length, 2)

  // 重启后幂等仍然有效（键从事件流重建）
  const revived = createBoard({}, { stateDir: dir })
  const again = revived.create({ ...payload })
  assert.equal(again.id, first.id, '重启后同 sourceSeq 仍返回同一 Task')
  assert.equal(events(dir).length, 2, '重启后重复创建没有新增事件')
})

// ── 4. 依赖整图 ─────────────────────────────────────────────────────────────

test('依赖：blockedBy 未完成 → 不在 ready()；跨两级完成后才进入 ready()', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const b = seed(board, { subject: 'B', blockedBy: [a.id] })
  const c = seed(board, { subject: 'C', blockedBy: [b.id] })

  assert.deepEqual(board.ready().map((x) => x.id), [a.id], '只有 A 就绪（B、C 的依赖未完成，整图校验）')

  board.update({ id: a.id, expectedRev: 1, action: 'claim', byId: 'bot-1' })
  board.update({ id: a.id, expectedRev: 2, action: 'complete', artifacts: ['src/a.js'], byId: 'bot-1' })

  assert.deepEqual(board.ready().map((x) => x.id), [b.id], 'A 完成后只放行 B，不放行 C（不能只看直接依赖就误放行）')

  board.update({ id: b.id, expectedRev: 1, action: 'claim', byId: 'bot-1' })
  board.update({ id: b.id, expectedRev: 2, action: 'complete', artifacts: ['src/b.js'], byId: 'bot-1' })
  assert.deepEqual(board.ready().map((x) => x.id), [c.id])

  // in_progress 的不算就绪
  board.update({ id: c.id, expectedRev: 1, action: 'claim', byId: 'bot-2' })
  assert.deepEqual(board.ready(), [], 'in_progress / completed 都不属于 ready')
})

test('依赖：环 / 自依赖 → 抛错（不写坏 DAG）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const b = seed(board, { subject: 'B', blockedBy: [a.id] })

  assert.throws(() => board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'lead', blockedBy: [b.id] }), (e) => e instanceof BoardError && e.code === 'BOARD_DEPENDENCY_CYCLE')
  assert.throws(() => board.create({ subject: 'X', byId: 'lead', blockedBy: ['t-9'] }), (e) => e.code === 'BOARD_DEPENDENCY_NOT_FOUND')
  // 自依赖
  assert.throws(() => board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'lead', blockedBy: [a.id] }), (e) => e.code === 'BOARD_DEPENDENCY_CYCLE')

  // 没被写坏：a 仍无依赖、rev 仍是 1
  assert.deepEqual(board.get(a.id).blockedBy, [])
  assert.equal(board.get(a.id).rev, 1)
  // 合法的 DAG 变更照常生效
  const updated = board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'lead', blockedBy: [] })
  assert.equal(updated.rev, 2)
})

test('依赖：未就绪时 claim 抛错（可 force 抢占）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const b = seed(board, { subject: 'B', blockedBy: [a.id] })

  assert.throws(() => board.update({ id: b.id, expectedRev: 1, action: 'claim', byId: 'bot-x' }), (e) => e.code === 'BOARD_NOT_READY')
  const forced = board.update({ id: b.id, expectedRev: 1, action: 'claim', byId: 'bot-x', force: true })
  assert.equal(forced.status, 'in_progress')
})

// ── 5. 租约（封死「owner 永不释放」硬伤）────────────────────────────────────

test('租约：claim 后 expireLeases 到期 → 回 pending，并清掉 ownerId/lease', (t) => {
  const { board } = setup(t)
  const task = seed(board, { subject: '会崩在 owner 手里的任务' })

  const T0 = 1_700_000_000_000
  const claimed = board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: 'bot-crash', now: T0, leaseMs: 60_000 })
  assert.equal(claimed.status, 'in_progress')
  assert.equal(claimed.ownerId, 'bot-crash')
  assert.equal(claimed.lease.ownerId, 'bot-crash')
  assert.equal(claimed.lease.expiresAt, T0 + 60_000)
  assert.equal(claimed.lease.heartbeatAt, T0)

  // 未到期 → 不回收（不能提前抢）
  assert.deepEqual(board.expireLeases({ now: T0 + 59_999 }), [])
  assert.equal(board.get(task.id).status, 'in_progress')

  // 到期（owner 已死、没有心跳）→ 自动回 pending
  const recycled = board.expireLeases({ now: T0 + 60_000 })
  assert.deepEqual(recycled, [task.id], '返回被回收的 taskId')
  const after = board.get(task.id)
  assert.equal(after.status, 'pending', '★ 回到待领池，不再永久挂在已死成员名下')
  assert.equal(after.ownerId, undefined)
  assert.equal(after.lease, undefined)
  assert.equal(after.rev, 3, '回收也要留下 rev 变更（CAS 依据）')
  assert.ok(board.ready().some((x) => x.id === task.id), '回收后就绪，可被重新领取')
  assert.equal(board.expireLeases({ now: T0 + 10_000_000 }).length, 0, '幂等：没有租约了就不重复回收')

  // 审计流里有据可查
  const leaseEvents = board.history(task.id).filter((e) => e.action === 'lease_expired')
  assert.equal(leaseEvents.length, 1)
  assert.equal(leaseEvents[0].before.status, 'in_progress')
  assert.equal(leaseEvents[0].after.status, 'pending')
})

test('租约：心跳续租可行；过期后心跳失败；他人不可抢占/不可放租约', (t) => {
  const { board } = setup(t)
  const task = seed(board)
  const T0 = 1_700_000_000_000

  board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: 'bot-a', now: T0, leaseMs: 60_000 })

  // 心跳把到期时间往后推
  const hb = board.update({ id: task.id, expectedRev: 2, action: 'heartbeat', byId: 'bot-a', now: T0 + 30_000, leaseMs: 60_000 })
  assert.equal(hb.lease.expiresAt, T0 + 90_000)
  assert.equal(hb.lease.heartbeatAt, T0 + 30_000)

  // 租约仍活 → 他人 claim 必须被拒
  assert.throws(() => board.update({ id: task.id, expectedRev: 3, action: 'claim', byId: 'bot-b', now: T0 + 40_000 }), (e) => e.code === 'BOARD_LEASE_HELD')
  // 非持有者不能心跳 / 不能放租约 / 不能交付
  assert.throws(() => board.update({ id: task.id, expectedRev: 3, action: 'heartbeat', byId: 'bot-b', now: T0 + 40_000 }), (e) => e.code === 'BOARD_LEASE_NOT_OWNER')
  assert.throws(() => board.update({ id: task.id, expectedRev: 3, action: 'release', byId: 'bot-b' }), (e) => e.code === 'BOARD_LEASE_NOT_OWNER')
  assert.throws(() => board.update({ id: task.id, expectedRev: 3, action: 'complete', artifacts: ['x'], byId: 'bot-b' }), (e) => e.code === 'BOARD_LEASE_NOT_OWNER')
  // 状态未被这些失败改动
  assert.equal(board.get(task.id).status, 'in_progress')
  assert.equal(board.get(task.id).rev, 3)

  // 过期后心跳无法复活 → 必须走 claim / expireLeases
  assert.throws(() => board.update({ id: task.id, expectedRev: 3, action: 'heartbeat', byId: 'bot-a', now: T0 + 200_000 }), (e) => e.code === 'BOARD_LEASE_EXPIRED')
  // 过期后他人可抢占
  const stolen = board.update({ id: task.id, expectedRev: 3, action: 'claim', byId: 'bot-b', now: T0 + 200_000 })
  assert.equal(stolen.ownerId, 'bot-b')
  assert.equal(stolen.status, 'in_progress')

  // 正常释放
  const released = board.update({ id: task.id, expectedRev: 4, action: 'release', byId: 'bot-b' })
  assert.equal(released.status, 'pending')
  assert.equal(released.lease, undefined)
  assert.equal(released.ownerId, undefined)
  assert.throws(() => board.update({ id: task.id, expectedRev: 5, action: 'release', byId: 'bot-b' }), (e) => e.code === 'BOARD_NO_LEASE')
})

// ── 6. complete 必须带 artifacts ────────────────────────────────────────────

test('complete：缺 artifacts → 抛错且不改状态；带 artifacts → 完成', (t) => {
  const { dir, board } = setup(t)
  const task = seed(board, { subject: '交付物' })
  board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: 'bot-a' })

  for (const bad of [undefined, null, [], '', '   ']) {
    assert.throws(
      () => board.update({ id: task.id, expectedRev: 2, action: 'complete', byId: 'bot-a', artifacts: bad }),
      (e) => e instanceof BoardError && (e.code === 'BOARD_MISSING_ARTIFACTS' || e.code === 'BOARD_BAD_FIELD'),
      `artifacts=${JSON.stringify(bad)} 应被拒`,
    )
  }
  assert.equal(board.get(task.id).status, 'in_progress', '拒绝后状态不变')
  assert.equal(board.get(task.id).rev, 2, '拒绝后 rev 不变')

  const done = board.update({ id: task.id, expectedRev: 2, action: 'complete', byId: 'bot-a', artifacts: ['src/board.js', { path: 'test/board.test.mjs', sha: 'abc' }] })
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.artifacts, ['src/board.js', { path: 'test/board.test.mjs', sha: 'abc' }])
  assert.equal(done.lease, undefined, '完成即释放租约')
  assert.ok(Number.isFinite(done.completedAt))

  // 重复完成 → 抛错（要求先 reopen）
  assert.throws(() => board.update({ id: task.id, expectedRev: 3, action: 'complete', artifacts: ['x'], byId: 'bot-a' }), (e) => e.code === 'BOARD_ALREADY_COMPLETED')

  const reopened = board.update({ id: task.id, expectedRev: 3, action: 'reopen', byId: 'lead' })
  assert.equal(reopened.status, 'pending')
  assert.equal(reopened.artifacts, undefined)
  assert.equal(reopened.completedAt, undefined)
  // 事件流里留档，没有被"删除即抹迹"
  const doneEvent = events(dir).find((e) => e.action === 'complete')
  assert.equal(doneEvent.after.status, 'completed')
  assert.ok(Array.isArray(doneEvent.after.artifacts))
})

// ── 7. 验收（官方没有的语义）────────────────────────────────────────────────

test('accept：pass 置完成、reject 打回 pending 并清产出物', (t) => {
  const { board } = setup(t)
  const task = seed(board, { subject: '待验收' })
  board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: 'bot-a' })
  board.update({ id: task.id, expectedRev: 2, action: 'complete', byId: 'bot-a', artifacts: ['out.md'] })

  assert.throws(() => board.accept({ id: task.id, by: 'lead', result: 'maybe' }), (e) => e.code === 'BOARD_BAD_ACCEPT_RESULT')
  assert.throws(() => board.accept({ id: 't-404', by: 'lead', result: 'pass' }), (e) => e.code === 'BOARD_TASK_NOT_FOUND')

  const rejected = board.accept({ id: task.id, by: 'lead', result: 'reject', note: '证据不足' })
  assert.equal(rejected.status, 'pending', '驳回 → 回待领池，可被重新领取')
  assert.equal(rejected.acceptance.result, 'reject')
  assert.equal(rejected.acceptance.by, 'lead')
  assert.equal(rejected.acceptance.note, '证据不足')
  assert.equal(rejected.artifacts, undefined, '驳回 → 产出物作废')
  assert.ok(board.ready().some((x) => x.id === task.id))

  // 重新做完再验收通过
  board.update({ id: task.id, expectedRev: rejected.rev, action: 'claim', byId: 'bot-a' })
  board.update({ id: task.id, expectedRev: rejected.rev + 1, action: 'complete', byId: 'bot-a', artifacts: ['out-v2.md'] })
  const passed = board.accept({ id: task.id, by: 'lead', result: 'pass' })
  assert.equal(passed.status, 'completed')
  assert.equal(passed.acceptance.result, 'pass')
  assert.deepEqual(passed.artifacts, ['out-v2.md'], '通过时产出物保留')

  // 验收动作可重复记录（每次一条事件、rev 递增）——这是审计动作，不是一次性状态位
  const reAccepted = board.accept({ id: task.id, by: 'lead-2', result: 'pass', note: '复核通过' })
  assert.equal(reAccepted.status, 'completed')
  assert.equal(reAccepted.acceptance.by, 'lead-2')
  assert.equal(reAccepted.rev, passed.rev + 1)
})

// ── 8. 回放 ─────────────────────────────────────────────────────────────────

test('回放：写入后 replay() 重建的 list() 与原一致（逐字段深比较）', (t) => {
  const { dir, board } = setup(t)

  // 造一个有各种状态的状态机：依赖、租约、完成、阻塞、删除
  const a = seed(board, { subject: 'A', description: '第一个', priority: 1, sourceSeq: 'seq-a' })
  const b = seed(board, { subject: 'B', blockedBy: [a.id], writeScopes: ['src/b.js'] })
  const c = seed(board, { subject: 'C' })
  const d = seed(board, { subject: 'D', dueAt: 1_900_000_000_000 })

  const T0 = 1_700_000_000_000
  board.update({ id: a.id, expectedRev: 1, action: 'edit', subject: 'A(改)', priority: 9, byId: 'lead' })
  board.update({ id: a.id, expectedRev: 2, action: 'claim', byId: 'bot-a', now: T0, leaseMs: 60_000 })
  board.update({ id: a.id, expectedRev: 3, action: 'heartbeat', byId: 'bot-a', now: T0 + 10_000, leaseMs: 120_000 })
  board.update({ id: a.id, expectedRev: 4, action: 'complete', artifacts: ['a.js'], byId: 'bot-a', now: T0 + 20_000 })
  board.accept({ id: a.id, by: 'lead', result: 'pass', now: T0 + 30_000 })
  board.update({ id: b.id, expectedRev: 1, action: 'claim', byId: 'bot-b', now: T0, leaseMs: 1_000 })
  board.update({ id: c.id, expectedRev: 1, action: 'block', byId: 'lead', note: '等外部输入' })
  board.update({ id: d.id, expectedRev: 1, action: 'delete', byId: 'lead' })
  board.expireLeases({ now: T0 + 60_000 })

  const beforeList = board.list()
  const beforeDeleted = board.list({ status: 'deleted' })
  const beforeAll = [...beforeList, ...beforeDeleted]
  assert.equal(beforeList.length, 3, 'a(completed) / b(pending, 租约被回收) / c(blocked)')
  assert.equal(beforeDeleted.length, 1)

  // ① 同一个实例 replay()
  const result = board.replay()
  assert.equal(result.from, 'jsonl', '真相源是事件流')
  assert.equal(result.bad, 0)
  assert.deepStrictEqual(board.list(), beforeList, 'replay 后 list() 逐字段一致')
  assert.deepStrictEqual(board.list({ status: 'deleted' }), beforeDeleted)
  for (const task of beforeAll) assert.deepStrictEqual(board.get(task.id), task, `${task.id} 逐字段一致`)

  // ② 全新实例（模拟重启）—— 构造即回放
  const revived = createBoard({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.deepStrictEqual(revived.list(), beforeList, '新实例 list() 与原一致')
  assert.deepStrictEqual(revived.list({ status: 'deleted' }), beforeDeleted)
  assert.deepStrictEqual(revived.history(), board.history(), '审计流一并重建')
  assert.equal(revived.diagnostics().hydratedFrom, 'jsonl')

  // ③ 回放后仍然可写（rev 计数与 id 计数不能错位）
  const next = revived.create({ subject: 'E', byId: 'lead' })
  assert.equal(next.id, 't-5', 'id 计数器由事件流恢复，不重号')
  const edited = revived.update({ id: next.id, expectedRev: 1, action: 'edit', subject: 'E(改)', byId: 'lead' })
  assert.equal(edited.rev, 2)

  // ④ 快照与事件流都还在
  assert.ok(existsSync(join(dir, 'board.jsonl')))
  assert.ok(existsSync(join(dir, 'board.snap.json')))
})

test('回放：事件流为空而快照存在时，回落到快照（且标记来源）', (t) => {
  const { dir, board } = setup(t)
  seed(board, { subject: '快照里的任务', sourceSeq: 'seq-snap' })
  const snapshot = JSON.parse(readFileSync(join(dir, 'board.snap.json'), 'utf8'))
  assert.equal(snapshot.tasks.length, 1, '先确认快照已写')

  rmSync(join(dir, 'board.jsonl'), { force: true })

  const revived = createBoard({}, { stateDir: dir })
  assert.equal(revived.diagnostics().hydratedFrom, 'snapshot')
  assert.equal(revived.list().length, 1)
  assert.equal(revived.list()[0].subject, '快照里的任务')
  // 幂等键也一并恢复 → 重复创建不会双写
  const again = revived.create({ subject: '不该新建', byId: 'dispatcher', sourceSeq: 'seq-snap' })
  assert.equal(again.subject, '快照里的任务')
  assert.equal(revived.list().length, 1)
})

// ── 9. tombstone ────────────────────────────────────────────────────────────

test('tombstone：delete 后 get() 仍能取到（status=deleted），且不在 list() 里', (t) => {
  const { dir, board } = setup(t)
  const keep = seed(board, { subject: '保留的' })
  const gone = seed(board, { subject: '要删的' })

  const deleted = board.update({ id: gone.id, expectedRev: 1, action: 'delete', byId: 'lead' })
  assert.equal(deleted.status, 'deleted')

  // get() 取得到，且状态是 deleted
  const fetched = board.get(gone.id)
  assert.ok(fetched, '★ 墓碑必须还能被 get() 取到')
  assert.equal(fetched.status, 'deleted')
  assert.equal(fetched.subject, '要删的', '墓碑保留原内容（审计可追）')
  assert.equal(fetched.rev, 2)

  // 不在默认 list() 里；显式查才可见
  assert.deepEqual(board.list().map((x) => x.id), [keep.id])
  assert.deepEqual(board.list({ status: 'deleted' }).map((x) => x.id), [gone.id])
  // 就绪池里当然没有
  assert.deepEqual(board.ready().map((x) => x.id), [keep.id])
  // 物理上没有被移除
  assert.equal(events(dir).filter((e) => e.taskId === gone.id).length, 2)
  assert.ok(readFileSync(join(dir, 'board.jsonl'), 'utf8').includes('要删的'))

  // 墓碑不可再改 / 不可重复删 / 不可 claim，但可以 reopen 复活
  assert.throws(() => board.update({ id: gone.id, expectedRev: 2, action: 'edit', byId: 'lead', subject: 'x' }), (e) => e.code === 'BOARD_TASK_DELETED')
  assert.throws(() => board.update({ id: gone.id, expectedRev: 2, action: 'claim', byId: 'bot-a' }), (e) => e.code === 'BOARD_TASK_DELETED')
  assert.throws(() => board.update({ id: gone.id, expectedRev: 2, action: 'delete', byId: 'lead' }), (e) => e.code === 'BOARD_TASK_DELETED')
  assert.throws(() => board.accept({ id: gone.id, by: 'lead', result: 'pass' }), (e) => e.code === 'BOARD_TASK_DELETED')

  const back = board.update({ id: gone.id, expectedRev: 2, action: 'reopen', byId: 'lead' })
  assert.equal(back.status, 'pending')
  assert.deepEqual(board.list().map((x) => x.id), [keep.id, gone.id])
})

// ── 10. list 与状态过滤 ─────────────────────────────────────────────────────

test('list：创建序 + status 过滤 + 非法 status 抛错', (t) => {
  const { board } = setup(t)
  const ids = ['一', '二', '三'].map((s) => seed(board, { subject: s }).id)
  assert.deepEqual(board.list().map((x) => x.subject), ['一', '二', '三'], '按创建序，不是字典序')

  board.update({ id: ids[1], expectedRev: 1, action: 'claim', byId: 'bot-a' })
  assert.deepEqual(board.list({ status: 'in_progress' }).map((x) => x.id), [ids[1]])
  assert.deepEqual(board.list({ status: 'pending' }).map((x) => x.id), [ids[0], ids[2]])

  assert.throws(() => board.list({ status: 'nope' }), (e) => e.code === 'BOARD_BAD_STATUS' && /pending/.test(e.message))
  // 传空对象 / 不传 → 同一行为
  assert.deepEqual(board.list({}), board.list())
})

// ── 11. 状态目录解析 ────────────────────────────────────────────────────────

test('createBoard：config.stateDir 优先；缺省时若 kernel 不可用则抛可读错误', (t) => {
  const { dir } = setup(t)
  const board = createBoard(undefined, { stateDir: dir, name: 'my-board' })
  assert.equal(board.name, 'my-board')
  assert.equal(board.paths.stateDir, dir)
  assert.equal(board.paths.jsonl, join(dir, 'board.jsonl'))
  assert.equal(board.paths.snapshot, join(dir, 'board.snap.json'))

  // 本仓库是裸检出（无宿主包）：kernel 动态加载失败 → 仍要求**显式**给 stateDir，
  // 绝不静默兜底到别处（否则多个调用方会各写一份，真相源分裂）。
  const diag = board.diagnostics()
  assert.ok(typeof diag.kernel === 'string', 'diagnostics 必须如实报告 kernel 桥状态')
  assert.equal(diag.hydratedFrom, 'empty')
  if (diag.kernel !== 'loaded') {
    assert.throws(
      () => createBoard(undefined, {}),
      (e) => e instanceof BoardError && e.code === 'BOARD_NO_STATE_DIR' && /config\.stateDir/.test(e.message),
    )
  }
  void t
})
