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
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
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

// ── 2026-11-04 测试回归 ─────────────────────────────────────────────────────
// 🔴 P0-3：tools.js schema / README / UI 都承诺 unblock 与 set，board 实现里没有 ⇒
//   BOARD_BAD_ACTION。另外 block 的 reason 字段被静默忽略（实现只读 note）。

test('2026-11-04 P0-3：unblock 动作存在且把 blocked 拉回 pending', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const blocked = board.update({ id: a.id, expectedRev: 1, action: 'block', byId: 'lead', reason: 'WHY' })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.blockedReason, 'WHY', 'reason 字段必须被记录（修复前被静默丢弃）')

  const un = board.update({ id: a.id, expectedRev: 2, action: 'unblock', byId: 'lead' })
  assert.equal(un.status, 'pending')
  assert.equal(un.blockedReason, undefined)
})

test('2026-11-04 P0-3：unblock 在有未完成依赖时保持 blocked', (t) => {
  const { board } = setup(t)
  const parent = seed(board, { subject: 'P' })
  const child = seed(board, { subject: 'C', blockedBy: [parent.id] })
  const b2 = board.update({ id: child.id, expectedRev: 1, action: 'block', byId: 'lead' })
  const un = board.update({ id: child.id, expectedRev: b2.rev, action: 'unblock', byId: 'lead' })
  assert.equal(un.status, 'blocked', '依赖未完成 → 保持 blocked')
})

test('2026-11-04 P0-3：set 动作存在且能改字段', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const r = board.update({ id: a.id, expectedRev: 1, action: 'set', byId: 'lead', priority: 8, subject: 'A2' })
  assert.equal(r.priority, 8)
  assert.equal(r.subject, 'A2')
})

test('2026-11-04 P0-3：set 拒绝非法 status（completed 必须走 complete/accept）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  assert.throws(
    () => board.update({ id: a.id, expectedRev: 1, action: 'set', byId: 'lead', status: 'completed' }),
    (e) => e instanceof BoardError && e.code === 'BOARD_BAD_FIELD',
  )
})

// 🔴 P1-1：accept 之前只看「任务存在」，任何状态都能被 pass 置 completed，
//   绕过 complete() 的 blockedBy/lease/artifacts 校验。

test('2026-11-04 P1-1：accept/pass 拒绝未完成的任务（不能绕过依赖与产出物）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  assert.throws(
    () => board.accept({ id: a.id, by: 'lead', result: 'pass' }),
    (e) => e instanceof BoardError && e.code === 'BOARD_BAD_STATE',
  )
})

test('2026-11-04 P1-1：accept/pass 拒绝依赖未完成的 completed 任务', (t) => {
  const { board } = setup(t)
  const parent = seed(board, { subject: 'P' })
  const child = seed(board, { subject: 'C', blockedBy: [parent.id] })
  // 直接把 child 置 completed（绕过 complete 的依赖校验，模拟历史脏数据）
  const c = board.update({ id: child.id, expectedRev: 1, action: 'set', byId: 'lead', status: 'in_progress' })
  board.update({ id: child.id, expectedRev: c.rev, action: 'complete', byId: 'lead', artifacts: ['x'] }).catch?.(() => {})
  // 依赖未完成时不能验收 → 应当抛错（无论走哪条分支）
  let threw = false
  try {
    board.accept({ id: child.id, by: 'lead', result: 'pass' })
  } catch { threw = true }
  assert.equal(threw, true, '依赖未完成时 accept/pass 必须拒绝')
})

// 🔴 P1-4：expireLeases 之前无任何调用者 ⇒ 租约永不回收。

test('2026-11-04 P1-4：expireLeases 把过期租约任务回收成 pending', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const claimed = board.update({ id: a.id, expectedRev: 1, action: 'claim', byId: 'worker', leaseMs: 1000 })
  assert.equal(claimed.status, 'in_progress')
  // 时间推进到租约过期之后
  const later = claimed.lease.expiresAt + 1000
  const recycled = board.expireLeases({ now: later })
  assert.deepEqual(recycled, [a.id])
  const after = board.get(a.id)
  assert.equal(after.status, 'pending')
  assert.equal(after.lease, undefined)
})

// ── 2026-11-04 测试回归 ─────────────────────────────────────────────────────
// 🔴 P2-2：board 没有 stats() ⇒ /status 与 UI 概览里任务数恒显示 `—`。
test('2026-11-04 P2-2：board.stats() 存在且含 total', (t) => {
  const { board } = setup(t)
  seed(board, { subject: 'A' })
  seed(board, { subject: 'B' })
  const st = board.stats()
  assert.equal(typeof st, 'object')
  assert.equal(st.total, 2)
  assert.ok(st.byStatus)
  assert.equal(st.ready, 2)
})

// ── 2026-11-09：结构化收尾（借鉴 superagent Report 枚举）────────────────────
// 背景：`src/stage.js`（改造07）读 `latestReport` / `delivery` / `attention`，
// 但 `board.js` **从未写入过这些字段**（grep 计数为 0）⇒ 阶段表 8 个阶段中有 4 个
// 永远派不出来（person/answer、person/blocked、person/failed、idle）。
// 下面三条用例锁死「写入侧」与「读取侧」的一致性。

test('2026-11-09：complete 把 latestReport.state 落成 ready（默认）', (t) => {
  const { dir, board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const done = board.update({ id: a.id, expectedRev: 1, action: 'complete', byId: 'bot', artifacts: ['out/x.md'] })
  assert.equal(done.status, 'completed')
  assert.equal(done.latestReport.state, 'ready')
  assert.equal(done.latestReport.reporter, 'bot')
  // 落盘也必须有（不是只在内存里）
  const last = events(dir).at(-1)
  assert.equal(last.after.latestReport.state, 'ready')
})

test('2026-11-09：complete 的 outcome=dropped 落成 dropped（无人在等）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const done = board.update({
    id: a.id, expectedRev: 1, action: 'complete', byId: 'bot',
    artifacts: ['out/y.md'], outcome: 'dropped',
  })
  assert.equal(done.latestReport.state, 'dropped')
})

test('2026-11-09：complete 拒绝 outcome=blocked/failed（应走 block）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  for (const bad of ['blocked', 'failed']) {
    assert.throws(
      () => board.update({ id: a.id, expectedRev: 1, action: 'complete', byId: 'bot', artifacts: ['x'], outcome: bad }),
      (err) => err.code === 'BOARD_BAD_FIELD' && /请改用 board\.update block/.test(err.message),
      `outcome=${bad} 必须被拒并指路 block`,
    )
  }
})

test('2026-11-09：complete 拒绝 humanAction（完成≠提问，否则 stage 误判待验收）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  // 即使先 claim 成 in_progress 也一样要拒 —— 这不是状态问题，是语义问题
  const claimed = board.update({ id: a.id, expectedRev: 1, action: 'claim', byId: 'bot' })
  assert.throws(
    () => board.update({
      id: a.id, expectedRev: claimed.rev, action: 'complete', byId: 'bot',
      artifacts: ['x'], humanAction: '帮我确认端口',
    }),
    (err) => err.code === 'BOARD_BAD_FIELD' && /complete 不接受 humanAction/.test(err.message),
  )
})

test('2026-11-09：block 落 latestReport（state=blocked + attention.question）', (t) => {
  const { dir, board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const blocked = board.update({
    id: a.id, expectedRev: 1, action: 'block', byId: 'bot',
    reason: '端口 3080 被占用',
    humanAction: '请你确认是否杀掉旧进程',
  })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.blockedReason, '端口 3080 被占用')
  assert.equal(blocked.latestReport.state, 'blocked')
  assert.equal(blocked.latestReport.attention.question, '请你确认是否杀掉旧进程')
  // 落盘校验
  const last = events(dir).at(-1)
  assert.equal(last.after.latestReport.state, 'blocked')
})

test('2026-11-09：block 的 outcome=failed 与 blocked 区分开', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const failed = board.update({ id: a.id, expectedRev: 1, action: 'block', byId: 'bot', outcome: 'failed' })
  assert.equal(failed.latestReport.state, 'failed')
})

test('2026-11-09：block 不给 humanAction 时不伪造 attention（诊断≠指令）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const blocked = board.update({ id: a.id, expectedRev: 1, action: 'block', byId: 'bot', reason: '等外部 API' })
  assert.equal(blocked.latestReport.state, 'blocked')
  assert.equal(blocked.latestReport.attention, undefined,
    'blockedReason 不得冒充 attention.question —— 否则人在「等你回答」里看到一句诊断，不知道回什么')
})

test('2026-11-09：block 拒绝 outcome=ready/dropped（应走 complete）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  assert.throws(
    () => board.update({ id: a.id, expectedRev: 1, action: 'block', byId: 'bot', outcome: 'ready' }),
    (err) => err.code === 'BOARD_BAD_FIELD' && /blocked \| failed/.test(err.message),
  )
})

test('2026-11-09：outcome=waiting/progress 不是收尾结论，必须被拒', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  // superagent 的 Report 有 6 态，但 waiting/progress 是「进行中报告」，不是收尾
  for (const bad of ['waiting', 'progress']) {
    assert.throws(
      () => board.update({ id: a.id, expectedRev: 1, action: 'block', byId: 'bot', outcome: bad }),
      (err) => err.code === 'BOARD_BAD_FIELD',
    )
  }
})

test('2026-11-09：humanAction 超 1000 字符被拒（它是列表标题，不是报告）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  assert.throws(
    () => board.update({
      id: a.id, expectedRev: 1, action: 'block', byId: 'bot',
      humanAction: 'x'.repeat(1001),
    }),
    (err) => err.code === 'BOARD_BAD_FIELD' && /超长/.test(err.message),
  )
  // 边界：正好 1000 字符可接受
  const ok = board.update({
    id: a.id, expectedRev: 1, action: 'block', byId: 'bot',
    humanAction: 'y'.repeat(1000),
  })
  assert.equal(ok.latestReport.attention.question.length, 1000)
})

test('2026-11-09：edit 可补/清除 humanAction，落 latestReport 而非顶层字段', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const claimed = board.update({ id: a.id, expectedRev: 1, action: 'claim', byId: 'bot' })
  // 执行中改口「我要你决定 X」
  const asked = board.update({
    id: a.id, expectedRev: claimed.rev, action: 'edit', byId: 'bot',
    humanAction: '选 A 还是 B？',
  })
  assert.equal(asked.latestReport.attention.question, '选 A 还是 B？')
  assert.equal(asked.humanAction, undefined, '不得新增顶层 humanAction 字段（stage.js 不读它）')
  // 人回答了 → 清除
  const cleared = board.update({
    id: a.id, expectedRev: asked.rev, action: 'edit', byId: 'ui', humanAction: null,
  })
  assert.equal(cleared.latestReport?.attention, undefined)
})

test('2026-11-09：reopen 作废 latestReport（旧收尾结论不得残留）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const blocked = board.update({ id: a.id, expectedRev: 1, action: 'block', byId: 'bot', humanAction: '请决定' })
  const reopened = board.update({ id: a.id, expectedRev: blocked.rev, action: 'reopen', byId: 'ui' })
  assert.equal(reopened.latestReport, undefined)
  assert.equal(reopened.blockedReason, undefined)
})

test('2026-11-09：accept/reject 作废 latestReport（驳回后要重做）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const done = board.update({ id: a.id, expectedRev: 1, action: 'complete', byId: 'bot', artifacts: ['x'] })
  assert.equal(done.latestReport.state, 'ready')
  const rejected = board.accept({ id: a.id, by: 'ui', result: 'reject', note: '不合格' })
  assert.equal(rejected.status, 'pending')
  assert.equal(rejected.latestReport, undefined)
})

test('2026-11-09：needsAttention 认 latestReport.attention（与 stage 同一依据）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  // 未 claim、未 block、优先级低、无 dueAt ⇒ 本来不该被 attention 选中
  const before = board.list({ attention: true, byId: 'someone-else' })
  assert.equal(before.some((x) => x.id === a.id), false)
  board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'bot', humanAction: '需要你拍板' })
  const after = board.list({ attention: true, byId: 'someone-else' })
  assert.equal(after.some((x) => x.id === a.id), true)
})

// ── 2026-11-09：Mandate 授权留痕（借鉴 superagent docs/001 §Mandate）──────────

test('2026-11-09：create 未给 mandate 时记 sender=byId（事实，不是推断）', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'S', byId: 'lead' })
  assert.deepEqual(a.mandate, { sender: 'lead' })
})

test('2026-11-09：create 带 mandateBasis/mandateSender 时完整留痕', (t) => {
  const { dir, board } = setup(t)
  const a = board.create({
    subject: 'S', byId: 'lead',
    mandate: { basis: 'explicit', sender: '张三', policyVersion: 'v3' },
  })
  assert.deepEqual(a.mandate, { basis: 'explicit', sender: '张三', policyVersion: 'v3' })
  const last = events(dir).at(-1)
  assert.equal(last.after.mandate.basis, 'explicit')
})

test('2026-11-09：mandate 含未知字段被拒（授权依据不接受含糊）', (t) => {
  const { board } = setup(t)
  assert.throws(
    () => board.create({ subject: 'S', byId: 'lead', mandate: { basis: 'explicit', because: '我说了算' } }),
    (err) => err.code === 'BOARD_BAD_FIELD' && /未知字段 because/.test(err.message),
  )
})

test('2026-11-09：mandate.basis 非法值被拒', (t) => {
  const { board } = setup(t)
  assert.throws(
    () => board.create({ subject: 'S', byId: 'lead', mandate: { basis: '我觉得可以' } }),
    (err) => err.code === 'BOARD_BAD_FIELD' && /mandate\.basis/.test(err.message),
  )
})

test('2026-11-09：mandate 空对象被拒（至少给一条依据）', (t) => {
  const { board } = setup(t)
  assert.throws(
    () => board.create({ subject: 'S', byId: 'lead', mandate: {} }),
    (err) => err.code === 'BOARD_BAD_FIELD' && /不能是空对象/.test(err.message),
  )
})

test('2026-11-09：mandate.sender 空白被拒', (t) => {
  const { board } = setup(t)
  assert.throws(
    () => board.create({ subject: 'S', byId: 'lead', mandate: { sender: '   ' } }),
    (err) => err.code === 'BOARD_BAD_FIELD' && /sender/.test(err.message),
  )
})

test('2026-11-09：set 可更新 mandate（改规则后追溯当时依据）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const updated = board.update({
    id: a.id, expectedRev: 1, action: 'set', byId: 'ui',
    mandate: { basis: 'room', sender: 'memory-evolve' },
  })
  assert.equal(updated.mandate.basis, 'room')
  assert.equal(updated.mandate.sender, 'memory-evolve')
})

// ── 2026-11-09：改造07 写入侧缺口修复 ──────────────────────────────────────
// `src/stage.js`（改造07）的「已完成且已验收 → idle」读 `task.accepted`，
// 但 `board.accept()` **从未写过这个字段**（只写 `acceptance`）⇒ 该分支永不触发，
// 验收通过的任务永远显示「等你验收」。下面的用例用 **deriveStage 的真实输出**
// 做证据，而不是只断言字段存在。

test('2026-11-09：accept/pass 写 accepted=true，deriveStage 从 person/review 转 idle', async (t) => {
  const { deriveStage } = await import('../src/stage.js')
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const done = board.update({ id: a.id, expectedRev: 1, action: 'complete', byId: 'bot', artifacts: ['x'] })
  assert.equal(deriveStage(done).stage, 'person/review', '交付后应等人验收')

  const passed = board.accept({ id: a.id, by: 'ui', result: 'pass' })
  assert.equal(passed.accepted, true)
  assert.equal(passed.acceptance.result, 'pass')
  assert.equal(deriveStage(passed).stage, 'idle', '验收通过后阶段必须离开 person/review')
  assert.equal(deriveStage(passed).needsPerson, false)
})

test('2026-11-09：accept/reject 清 accepted，deriveStage 回到 working/queued', async (t) => {
  const { deriveStage } = await import('../src/stage.js')
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  const done = board.update({ id: a.id, expectedRev: 1, action: 'complete', byId: 'bot', artifacts: ['x'] })
  const passed = board.accept({ id: a.id, by: 'ui', result: 'pass' })
  assert.equal(deriveStage(passed).stage, 'idle')

  const rejected = board.accept({ id: a.id, by: 'ui', result: 'reject', note: '重做' })
  assert.equal(rejected.accepted, undefined, '驳回后不得残留 accepted=true')
  assert.equal(rejected.acceptance.result, 'reject')
  assert.equal(deriveStage(rejected).stage, 'working/queued', '打回 pending 且无 owner ⇒ 排队等接活')
})

test('2026-11-09：complete 清 accepted（重开后重新验收不继承旧结论）', (t) => {
  const { board } = setup(t)
  const a = seed(board, { subject: 'A' })
  board.update({ id: a.id, expectedRev: 1, action: 'complete', byId: 'bot', artifacts: ['x'] })
  const passed = board.accept({ id: a.id, by: 'ui', result: 'pass' })
  assert.equal(passed.accepted, true)
  // reopen → 重做 → 再次 complete，此时 accepted 必须是 undefined（等新一轮验收）
  const reopened = board.update({ id: a.id, expectedRev: passed.rev, action: 'reopen', byId: 'ui' })
  const claimed = board.update({ id: a.id, expectedRev: reopened.rev, action: 'claim', byId: 'bot' })
  const redone = board.update({ id: a.id, expectedRev: claimed.rev, action: 'complete', byId: 'bot', artifacts: ['y'] })
  assert.equal(redone.accepted, undefined, '新一轮交付不得继承上一轮的 accepted=true')
  assert.equal(redone.acceptance, undefined)
})

// ── 2026-11-09：并发槽位（⑤ · 借鉴 superagent WorkerSlots 的人优先原则）────────
// superagent（src/executor/dsh.ts:171-199）的硬纪律：`by === 'person'` 时额外给一个槽位，
// 官方注释「New work therefore cannot prevent a person from continuing an existing Ticket」。
// 上限是给**自动化流量**设的闸，不是用来拒绝人的。

test('2026-11-09：WIP 上限下，机器人不能再领，人多一个槽位', (t) => {
  const { board } = setup(t, { wipLimitPerBot: 1 })
  const a = seed(board, { subject: 'A' })
  const b = seed(board, { subject: 'B' })
  const c = seed(board, { subject: 'C' })
  const d = seed(board, { subject: 'D' })

  // 机器人领满 1 个
  const claimed = board.update({ id: a.id, expectedRev: 1, action: 'claim', byId: 'bot' })
  assert.equal(claimed.ownerId, 'bot')

  // 机器人再领 → 拒（机器人上限 = 1）
  assert.throws(
    () => board.update({ id: b.id, expectedRev: 1, action: 'claim', byId: 'bot' }),
    (err) => err.code === 'BOARD_WIP_EXCEEDED' && err.details?.botId === 'bot',
  )

  // 人领 → 人上限 = 基础 1 + 额外 1 = 2，当前 0 ⇒ 允许
  const personClaim = board.update({ id: b.id, expectedRev: 1, action: 'claim', byId: 'person' })
  assert.equal(personClaim.ownerId, 'person')
  assert.equal(personClaim.lease.ownerId, 'person')

  // 人领到第 2 个（人上限 2）⇒ 仍允许
  const personClaim2 = board.update({ id: c.id, expectedRev: 1, action: 'claim', byId: 'person' })
  assert.equal(personClaim2.ownerId, 'person')

  // 人领第 3 个 → 超（人上限 2）⇒ 拒
  assert.throws(
    () => board.update({ id: d.id, expectedRev: 1, action: 'claim', byId: 'person' }),
    (err) => err.code === 'BOARD_WIP_EXCEEDED' && err.details?.personBonus === true,
  )
})

test('2026-11-09：WIP 报文里带人优先的依据（limit 与 baseLimit 区分）', (t) => {
  const { board } = setup(t, { wipLimitPerBot: 1 })
  const a = seed(board, { subject: 'A' })
  const b = seed(board, { subject: 'B' })
  board.update({ id: a.id, expectedRev: 1, action: 'claim', byId: 'bot' })
  let err
  try {
    board.update({ id: b.id, expectedRev: 1, action: 'claim', byId: 'bot' })
  } catch (e) { err = e }
  assert.equal(err.code, 'BOARD_WIP_EXCEEDED')
  assert.equal(err.details.limit, 1, '机器人上限 = 基础上限')
  assert.equal(err.details.baseLimit, 1)
  assert.equal(err.details.personBonus, false)
  assert.equal(err.details.current, 1)
})

test('2026-11-09 回归：事件流里已有更大 id 时，新建任务不得撞号（防数据覆盖）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bots-idguard-'))
  // 场景：事件流记录了 t-32 的 create（历史/外部写入），但内存 idCounter 只到 31。
  // 若新建时分配 t-32，回放时 `ev.rev <= before.rev` 会把**新任务**当成重复投递跳过 →
  // 任务凭空消失。hydrate 必须让 idCounter 至少到事件流里的最大 id。
  const board = createBoard({}, { stateDir: dir })
  const seed = await board.create({ subject: 'seed', byId: 'ui' })
  assert.equal(seed.id, 't-1')
  const board2 = createBoard({}, { stateDir: dir })
  // 直接往事件流追加一条 t-99 的 create（模拟外部/历史写入）
  appendFileSync(join(dir, 'board.jsonl'), JSON.stringify({
    taskId: 't-99', rev: 1, action: 'create', byId: 'external', at: Date.now(),
    before: null,
    after: { id: 't-99', rev: 1, subject: 'external-write', description: '', status: 'pending',
      blockedBy: [], writeScopes: [], labels: [], triaged: false, progress: 0,
      createdAt: Date.now(), createdBy: 'external' },
  }) + '\n')
  // 全新实例回放后，新任务必须跳过 t-99
  const board3 = createBoard({}, { stateDir: dir })
  const next = await board3.create({ subject: 'after-external', byId: 'ui' })
  assert.notEqual(next.id, 't-99', '不得复用事件流里已存在的 id')
  assert.equal(next.id, 't-100', `应顺延为 t-100，实际 ${next.id}`)
})
