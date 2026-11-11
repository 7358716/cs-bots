/**
 * RoomService 测试 —— 只碰 `node:test` + `node:assert` + `node:fs` + `node:os` + `node:path`。
 *
 * 覆盖硬约束里的每一条，且每条都用**实际落盘产物**做证据（读 `rooms/<id>/log.jsonl`、
 * `bodies/<msgId>.txt`、`events.jsonl`、`index.json`），不接受「函数没抛错」这种弱断言。
 *
 * 两条纪律：
 *   - **relay 不 mock `kernel.followup`**：走真实 `kernel`，用 fake `agents` 服务制造
 *     成功/失败两条路径（与 `test/dispatcher.test.mjs:9` 的既有做法一致）。
 *   - **断言的是事实不是实现**：seq 是否连续看磁盘；长正文是否旁路看磁盘；
 *     是否截断看条数。
 *
 * 运行：`node --test test/room.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRoom, RoomError, ROOM_LIMITS } from '../src/room.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/** 每个用例一个独立状态目录（互不污染）。 */
function setup(t, config = {}, ctxOverrides = {}) {
  const base = process.env.CS_BOTS_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-room-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const ctx = { logger: { info() {}, warn() {} }, ...ctxOverrides }
  const rooms = createRoom(ctx, { stateDir: dir, ...config })
  return { dir, rooms, ctx }
}

/** 制造一个「成员都活着」的 agents 替身，并记录每次投递的文本。 */
function liveAgents(sent) {
  return {
    get: (id) => ({
      id,
      followup: (message) => sent.push({ target: id, text: message?.content?.[0]?.text }),
    }),
    list: () => [],
  }
}

/** 读房间消息日志（真相源）。 */
function logRows(dir, roomId) {
  const file = join(dir, 'rooms', roomId, 'log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 读房间事件流（审计流）。 */
function eventRows(dir, roomId) {
  const file = join(dir, 'rooms', roomId, 'events.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 建一个 3 成员房间（成员管理类用例的样板）。 */
function seed(rooms, over = {}) {
  return rooms.createRoom_({
    name: `R${counter++}`,
    members: ['s-a', 's-b', 's-c'],
    byId: 's-a',
    ...over,
  })
}

// ── 1. 建房间与形状 ─────────────────────────────────────────────────────────

test('createRoom_：返回 §3.2 的 Room 形状，索引与事件流都落盘', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms, { name: '一期需求评审', mode: 'admin', adminId: 's-a', notice: '只讨论一期范围', cwd: '/tmp/proj' })

  assert.match(room.id, /^room-/)
  assert.equal(room.name, '一期需求评审')
  assert.equal(room.mode, 'admin')
  assert.equal(room.adminId, 's-a')
  assert.equal(room.notice, '只讨论一期范围')
  assert.equal(room.cwd, '/tmp/proj')
  assert.deepEqual(room.members, ['s-a', 's-b', 's-c'])
  assert.equal(room.relayLimit, 9, '默认 3 × 成员数')
  assert.equal(room.seq, 0)
  assert.ok(Number.isFinite(room.createdAt))
  assert.equal(room.createdBy, 's-a')

  // 落盘证据：索引快照 + 事件流 + bodies/ 目录
  assert.ok(existsSync(join(dir, 'rooms', 'index.json')), '索引快照应已写入')
  assert.ok(existsSync(join(dir, 'rooms', room.id, 'bodies')), 'bodies/ 目录应已建好')
  const events = eventRows(dir, room.id)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'room_created')
  assert.equal(events[0].before, null)
  assert.equal(events[0].after.id, room.id)
})

test('createRoom_：缺字段 / 重名（大小写归一）/ notice 超长 → 全部抛可读错误', (t) => {
  const { rooms } = setup(t)
  seed(rooms, { name: 'Dup Room' })

  assert.throws(
    () => rooms.createRoom_({ byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_MISSING_FIELD' && /name/.test(e.message),
  )
  assert.throws(
    () => rooms.createRoom_({ name: 'x' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_MISSING_FIELD' && /byId/.test(e.message),
  )
  // 名字唯一性：trim + NFKC + 小写 归一 ⇒ 'DUP ROOM' / '  dup room  ' 都算重名
  for (const dup of ['DUP ROOM', '  dup room  ']) {
    assert.throws(
      () => rooms.createRoom_({ name: dup, members: ['s-a'], byId: 's-a' }),
      (e) => e instanceof RoomError && e.code === 'ROOM_NAME_TAKEN' && /已被占用/.test(e.message),
      `重名 ${JSON.stringify(dup)} 必须被拒`,
    )
  }
  assert.throws(
    () => rooms.createRoom_({ name: 'n', members: ['s-a'], byId: 's-a', notice: 'a'.repeat(2001) }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOTICE_TOO_LONG' && /2000/.test(e.message),
  )
  // 边界：正好 2000 应当被接受
  assert.equal(
    rooms.createRoom_({ name: 'n', members: ['s-a'], byId: 's-a', notice: 'a'.repeat(2000) }).notice.length,
    2000,
  )
  assert.throws(
    () => rooms.createRoom_({ name: 'badmode', members: ['s-a'], byId: 's-a', mode: 'nobody' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_MODE',
  )
  // adminId 只对 admin 模式有语义 → 非 admin 传它必须被拒（不静默忽略）
  assert.throws(
    () => rooms.createRoom_({ name: 'strayadmin', members: ['s-a'], byId: 's-a', mode: 'everyone', adminId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_ADMIN_ID_NOT_APPLICABLE',
  )
})

test('createRoom_：显式 members 原样采信（创建者不自动入房）；缺省 members 才是 [byId]', (t) => {
  const { rooms } = setup(t)
  const explicit = rooms.createRoom_({ name: 'role room', members: ['s-x'], byId: 's-a' })
  assert.deepEqual(explicit.members, ['s-x'], '显式 members 不增不减 —— 否则 relayLimit 的算术会漂移')
  assert.equal(explicit.relayLimit, 3, '1 名成员 → 3×1=3')

  const solo = rooms.createRoom_({ name: 'solo', byId: 's-a' })
  assert.deepEqual(solo.members, ['s-a'], '缺省 members = [byId]（创建者自成一房）')
})

// ── 2. 成员管理 ─────────────────────────────────────────────────────────────

test('join/leave：成员表与 relayLimit 同步更新，事件流留痕；重复 join / 非成员 leave 抛错', (t) => {
  const { dir, rooms } = setup(t)
  const room = rooms.createRoom_({ name: 'members', members: ['s-a'], byId: 's-a' })
  assert.equal(room.relayLimit, 3)

  const joined = rooms.join({ roomId: room.id, sessionId: 's-b' })
  assert.deepEqual(joined.members, ['s-a', 's-b'])
  assert.equal(joined.relayLimit, 6, '2 名成员 → 6')
  assert.equal(joined.rev, 2, 'CAS 版本递增')

  // 重复 join 必须抛错（不静默成功，否则成员表不可审计）
  assert.throws(
    () => rooms.join({ roomId: room.id, sessionId: 's-b' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_ALREADY_MEMBER',
  )
  // 非成员 leave 必须抛错（不静默无操作）
  assert.throws(
    () => rooms.leave({ roomId: room.id, sessionId: 's-ghost' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_MEMBER',
  )
  // 不存在的房间
  assert.throws(
    () => rooms.join({ roomId: 'room-nope', sessionId: 's-b' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_FOUND',
  )
  // 可选 CAS：传了就必须匹配
  assert.throws(
    () => rooms.join({ roomId: room.id, sessionId: 's-c', expectedRev: 1 }),
    (e) => e instanceof RoomError && e.code === 'ROOM_REV_CONFLICT' && e.details.rev === 2,
  )

  const left = rooms.leave({ roomId: room.id, sessionId: 's-b' })
  assert.deepEqual(left.members, ['s-a'])
  assert.equal(left.relayLimit, 3)

  const types = eventRows(dir, room.id).map((e) => e.type)
  assert.deepEqual(types, ['room_created', 'members_joined', 'members_left'])
})

test('admin 模式：管理员退房后管理权移交给最早加入的剩余成员（不留锁死的房间）', (t) => {
  const { dir, rooms } = setup(t)
  const room = rooms.createRoom_({ name: 'admin room', members: ['s-a', 's-b', 's-c'], mode: 'admin', adminId: 's-a', byId: 's-a' })

  const after = rooms.leave({ roomId: room.id, sessionId: 's-a' })
  assert.equal(after.adminId, 's-b', '管理权必须移交，否则房间被永久锁死')
  assert.equal(eventRows(dir, room.id).at(-1).type, 'admin_transferred')

  // 全部退光 → adminId 清空（而不是指向一个已不在的人）
  rooms.leave({ roomId: room.id, sessionId: 's-b' })
  const emptied = rooms.leave({ roomId: room.id, sessionId: 's-c' })
  assert.equal(emptied.adminId, undefined)
  assert.deepEqual(emptied.members, [])
})

// ── 3. post：seq 连续无洞（★ 硬要求）────────────────────────────────────────

test('post：连发 10 条 → seq 恰好 1..10，内存与磁盘双证，连续无洞', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)

  for (let i = 1; i <= 10; i += 1) {
    const msg = rooms.post({ roomId: room.id, from: 's-a', text: `第 ${i} 条` })
    assert.equal(msg.seq, i, `第 ${i} 次 post 的 seq 必须是 ${i}`)
    assert.equal(msg.id, `m-${i}`)
    assert.equal(msg.roomId, room.id)
    assert.equal(msg.from, 's-a')
    assert.equal(msg.kind, 'normal', 'kind 缺省 normal')
    assert.ok(Number.isFinite(msg.at))
  }

  // 磁盘真相源：seq 必须严格 1..10 连续（断点续传的前提）
  const rows = logRows(dir, room.id)
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(rooms.listMessages({ roomId: room.id }).map((m) => m.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(rooms.get(room.id).seq, 10, 'room.seq 应跟到最新')
  assert.equal(rooms.stats().seqGaps, 0, '不得有 seq 空洞')

  // 断点续传口径：sinceSeq=7 → 8,9,10；limit=2 → 取**最新** 2 条
  assert.deepEqual(rooms.listMessages({ roomId: room.id, sinceSeq: 7 }).map((m) => m.seq), [8, 9, 10])
  assert.deepEqual(rooms.listMessages({ roomId: room.id, limit: 2 }).map((m) => m.seq), [9, 10])
})

test('post：非法 kind / replyTo 悬空 / 空文本 → 抛结构化错误', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)

  assert.throws(
    () => rooms.post({ roomId: room.id, from: 's-a', text: 'x', kind: 'shout' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_KIND' && /normal/.test(e.message),
  )
  assert.throws(
    () => rooms.post({ roomId: room.id, from: 's-a', text: 'x', replyTo: 'm-999' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_REPLY_TARGET_NOT_FOUND' && /m-999/.test(e.message),
  )
  assert.throws(
    () => rooms.post({ roomId: room.id, from: 's-a', text: '' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_MISSING_FIELD' && /text/.test(e.message),
  )

  // 合法 replyTo 落盘可见
  const first = rooms.post({ roomId: room.id, from: 's-a', text: '问题' })
  const reply = rooms.post({ roomId: room.id, from: 's-b', text: '回答', replyTo: first.id, kind: 'pass' })
  assert.equal(reply.replyTo, first.id)
  assert.equal(reply.kind, 'pass')
})

// ── 4. 幂等（★ 硬要求）──────────────────────────────────────────────────────

test('post 幂等：同 dedupKey 发两条 → 只有一条消息、只占一个 seq、日志只有一行', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)

  const a = rooms.post({ roomId: room.id, from: 's-a', text: '原始内容', dedupKey: 'k-1' })
  const b = rooms.post({ roomId: room.id, from: 's-a', text: '重复投递（内容不同也必须复用）', dedupKey: 'k-1' })

  assert.equal(b.id, a.id, '幂等命中必须返回同一条消息')
  assert.equal(b.text, '原始内容', '返回的是**既有**消息，不是新内容')
  assert.equal(b.seq, 1)

  const rows = logRows(dir, room.id)
  assert.equal(rows.length, 1, '磁盘上只能有一行')
  assert.equal(rows[0].dedupKey, 'k-1')

  // 幂等只在本房间内生效（同 key 换房间是另一条消息）
  // ⚠️ 消息 id 是**房间内**编号（`m-<seq>`，各房间都从 1 开始），故用 roomId+id 共同判定，
  //    否则会把「另一个房间的 m-1」误当成同一条消息。
  const other = rooms.createRoom_({ name: 'other', members: ['s-a'], byId: 's-a' })
  const c = rooms.post({ roomId: other.id, from: 's-a', text: '同 key 不同房间', dedupKey: 'k-1' })
  assert.equal(c.roomId, other.id, '同 key 在另一个房间必须是独立消息')
  assert.equal(`${c.roomId}::${c.id}` === `${a.roomId}::${a.id}`, false)
  assert.equal(c.seq, 1)
  assert.equal(c.text, '同 key 不同房间', '不得跨房间复用内容')
  assert.equal(logRows(dir, other.id).length, 1)
})

// ── 5. 长正文旁路 + 读回全等（★ K2 / 硬要求）────────────────────────────────

test('长正文旁路：5000 字符 → log 只留 bodyRef+指纹+头，readBody 取回**原文完全一致**', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)

  // 构造 5000 字符，且**首尾可区分**（防「只存头」被误判为通过）
  // 固定件 'HEAD-'(5) + '-MIDDLE-'(8) + '-TAIL-END'(9) = 22 字符，故重复段取 2978+2000
  const body = `HEAD-${'A'.repeat(2978)}-MIDDLE-${'B'.repeat(2000)}-TAIL-END`
  assert.equal(body.length, 5000, '用例前提：正文恰好 5000 字符')
  assert.ok(body.length > ROOM_LIMITS.BODY_THRESHOLD, '用例前提：正文必须超过阈值')
  const msg = rooms.post({ roomId: room.id, from: 's-a', text: body })
  assert.equal(msg.bodyRef, `bodies/${msg.id}.txt`)
  assert.equal(msg.fingerprint.length, body.length)
  assert.equal(msg.fingerprint.sha256.length, 12)
  assert.equal(msg.text.length, ROOM_LIMITS.BODY_HEAD_CHARS, '日志里的 text 只保留头')

  // 磁盘证据：log.jsonl 里**没有全文**，只有头 + 指纹 + bodyRef
  const rows = logRows(dir, room.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bodyRef, `bodies/${msg.id}.txt`)
  assert.equal(rows[0].text.length, ROOM_LIMITS.BODY_HEAD_CHARS)
  assert.ok(!readFileSync(join(dir, 'rooms', room.id, 'log.jsonl'), 'utf8').includes('-TAIL-END'),
    '日志文件里绝不能出现正文尾部（否则等于没旁路）')

  // 旁路文件存在，且**原文逐字全等**
  const bodyFile = join(dir, 'rooms', room.id, `bodies/${msg.id}.txt`)
  assert.ok(existsSync(bodyFile), 'bodies/<msgId>.txt 应存在')
  const got = rooms.readBody({ roomId: room.id, messageId: msg.id })
  assert.equal(got, body, 'readBody 必须与原文逐字一致')
  assert.equal(readFileSync(bodyFile, 'utf8'), body)

  // 短文本不旁路（对照组）
  const short = rooms.post({ roomId: room.id, from: 's-a', text: '短消息' })
  assert.equal(short.bodyRef, undefined)
  assert.equal(short.text, '短消息')
  assert.equal(rooms.readBody({ roomId: room.id, messageId: short.id }), '短消息')
})

test('readBody：正文文件缺失 / bodyRef 形态非法 → 抛错，绝不返回可疑内容', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  const msg = rooms.post({ roomId: room.id, from: 's-a', text: 'X'.repeat(3000) })

  // 人为删除旁路文件（模拟被清理/损坏）
  rmSync(join(dir, 'rooms', room.id, `bodies/${msg.id}.txt`), { force: true })
  assert.throws(
    () => rooms.readBody({ roomId: room.id, messageId: msg.id }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BODY_MISSING',
  )
  // 消息不存在
  assert.throws(
    () => rooms.readBody({ roomId: room.id, messageId: 'm-999' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_MESSAGE_NOT_FOUND',
  )
})

// ── 6. 不截断（★ 对比 ds-bot 的 60 条环形）─────────────────────────────────

test('不截断：连发 100 条 → listMessages 与日志**全都在**（对照 ds-bot ROOM_LOG_MAX=60）', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)

  for (let i = 1; i <= 100; i += 1) {
    rooms.post({ roomId: room.id, from: 's-a', text: `msg-${i}` })
  }

  const listed = rooms.listMessages({ roomId: room.id })
  assert.equal(listed.length, 100, '一条都不能少')
  assert.deepEqual(listed.map((m) => m.seq), Array.from({ length: 100 }, (_, i) => i + 1))
  assert.equal(listed[0].text, 'msg-1', '最早的仍在')
  assert.equal(listed[99].text, 'msg-100')

  assert.equal(logRows(dir, room.id).length, 100, '磁盘日志也必须是 100 行')
  assert.equal(rooms.get(room.id).seq, 100)
  assert.equal(rooms.stats().messages, 100)

  // 加大剂量到 150 条：仍无任何环形丢弃
  for (let i = 101; i <= 150; i += 1) rooms.post({ roomId: room.id, from: 's-a', text: `msg-${i}` })
  assert.equal(rooms.listMessages({ roomId: room.id }).length, 150)
})

// ── 7. relay 投递（★ 走真实 kernel.followup）────────────────────────────────

test('relay：投递给成员 → kernel.followup 被调，且 content 正确（房间名/消息号/发送者/正文）', (t) => {
  const sent = []
  const { rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = rooms.createRoom_({ name: '投递房间', members: ['s-a', 's-b', 's-c'], byId: 's-a' })
  const msg = rooms.post({ roomId: room.id, from: 's-a', text: '请复核 board.js 的 CAS' })

  const result = rooms.relay({ roomId: room.id, messageId: msg.id, targets: ['s-b', 's-c'] })

  assert.equal(result.ok, true)
  assert.equal(result.relayed, 2)
  assert.equal(result.attempted, 2)
  assert.equal(result.limit, 9)
  assert.equal(result.remaining, 7)
  assert.equal(result.reason, undefined)
  assert.deepEqual(result.deliveries.map((d) => d.target), ['s-b', 's-c'])
  assert.deepEqual(result.deliveries.map((d) => d.ok), [true, true])

  // 真实 kernel.followup 把消息构造出来并投给了正确的目标
  assert.equal(sent.length, 2)
  assert.deepEqual(sent.map((s) => s.target), ['s-b', 's-c'])
  const text = sent[0].text
  assert.match(text, /投递房间/, '载荷必须含房间名')
  assert.match(text, /room-/, '载荷必须含房间 id')
  assert.match(text, new RegExp(msg.id), '载荷必须含消息 id')
  assert.match(text, /#1/, '载荷必须含 seq')
  assert.match(text, /← s-a/, '载荷必须标出发送者')
  assert.match(text, /\[normal\]/, '载荷必须标出 kind')
  assert.ok(text.includes('请复核 board.js 的 CAS'), '载荷必须含正文')
  assert.equal(text.endsWith('请复核 board.js 的 CAS'), true, '正文在最后，不带截断标记')
})

test('relay：缺省 mentionOnly ⇒ 没 @ 就不唤醒任何人（relayed:0，不抛错）；mentionOnly:false 才广播', (t) => {
  const sent = []
  const { rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = seed(rooms)
  const msg = rooms.post({ roomId: room.id, from: 's-b', text: '广播' })

  // ── 2026-11-11 行为变更：缺省从「广播给全部成员」改为「只在被 @ 时唤醒」──
  // 实测证据：一条无 @ 的房间消息产生 3 次唤醒尝试、3 次全失败（其中一次打给 `ui`）。
  // 所以**缺省**必须是安静的：没 @ 到人 ⇒ relayed:0，且**不抛错**（「只记录不打扰」是合法结果）。
  const quiet = rooms.relay({ roomId: room.id, messageId: msg.id })
  assert.equal(quiet.relayed, 0, '缺省没 @ ⇒ 不唤醒任何人')
  assert.equal(quiet.attempted, 0)
  assert.equal(quiet.ok, true, '「只记录不打扰」是合法结果，不是失败')
  assert.equal(quiet.reason, 'mention-only-no-target')
  assert.equal(sent.length, 0, '一个 followup 都不许发出去')

  // 显式关掉定向（broadcast 模式）⇒ 回退到「除发送者外全部成员」
  const room2 = seed(rooms, { settings: { mentionOnly: false } })
  const msg2 = rooms.post({ roomId: room2.id, from: 's-b', text: '广播' })
  const broadcast = rooms.relay({ roomId: room2.id, messageId: msg2.id })
  assert.deepEqual(broadcast.deliveries.map((d) => d.target), ['s-a', 's-c'], '不回投给发送者')
  assert.equal(broadcast.targetSource, 'broadcast')
  assert.equal(sent.length, 2)

  // 只有发送者一人的房间 + 广播模式 → 无目标可投，抛错（不是静默成功）
  const solo = rooms.createRoom_({ name: 'solo-relay', members: ['s-x'], byId: 's-x', settings: { mentionOnly: false } })
  const m2 = rooms.post({ roomId: solo.id, from: 's-x', text: '自言自语' })
  assert.throws(
    () => rooms.relay({ roomId: solo.id, messageId: m2.id }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NO_TARGETS',
  )
  // 显式空数组同样拒绝（防「以为投了其实没投」）
  assert.throws(
    () => rooms.relay({ roomId: room.id, messageId: msg.id, targets: [] }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NO_TARGETS',
  )
  // 向非成员投递必须拒绝
  assert.throws(
    () => rooms.relay({ roomId: room.id, messageId: msg.id, targets: ['s-outsider'] }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_MEMBER' && /s-outsider/.test(e.message),
  )
  // 消息不存在
  assert.throws(
    () => rooms.relay({ roomId: room.id, messageId: 'm-999', targets: ['s-a'] }),
    (e) => e instanceof RoomError && e.code === 'ROOM_MESSAGE_NOT_FOUND',
  )
})

test('relay：长正文投递的是**全文**（旁路的意义），不是日志里的头', (t) => {
  const sent = []
  const { rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = seed(rooms)
  const body = `${'头部内容'.repeat(300)}-MIDDLE-${'尾部内容'.repeat(300)}-THE-VERY-END`
  assert.ok(body.length > ROOM_LIMITS.BODY_THRESHOLD)

  const msg = rooms.post({ roomId: room.id, from: 's-a', text: body })
  assert.equal(rooms.relay({ roomId: room.id, messageId: msg.id, targets: ['s-b'] }).ok, true)

  assert.equal(sent.length, 1)
  assert.ok(sent[0].text.includes('-THE-VERY-END'), '接收方必须拿到完整正文（K2 的意义就在这）')
  assert.equal(sent[0].text.endsWith(body), true, '载荷尾部 = 正文原文')
})

// ── 8. relayLimit 防无限转发（★ 硬要求）────────────────────────────────────

test('relay 超限：累计投递数一旦超过 relayLimit 即抛错（含第四次的边界）', (t) => {
  const sent = []
  const { dir, rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = seed(rooms) // 3 成员 → relayLimit = 9
  const msg = rooms.post({ roomId: room.id, from: 'user', text: '需要全房转发' })

  assert.equal(room.relayLimit, 9)
  const all = ['s-a', 's-b', 's-c']
  for (let round = 1; round <= 3; round += 1) {
    const r = rooms.relay({ roomId: room.id, messageId: msg.id, targets: all })
    assert.equal(r.ok, true, `第 ${round} 轮（累计 ${round * 3}/9）应被允许`)
    assert.equal(r.remaining, 9 - round * 3)
  }

  // 第 4 轮：累计 12 > 9 → 必须抛错，**且不能发生任何投递**
  const before = sent.length
  let caught
  try {
    rooms.relay({ roomId: room.id, messageId: msg.id, targets: all })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof RoomError, '超限必须抛 RoomError，绝不能静默放过')
  assert.equal(caught.code, 'ROOM_RELAY_LIMIT')
  assert.equal(caught.details.attempted, 9)
  assert.equal(caught.details.adding, 3)
  assert.equal(caught.details.limit, 9)
  assert.equal(sent.length, before, '被拒的转发不得产生任何投递')

  // 审计流里：3 条 relay + 3 条 relay_result，反向证明「先落意图再投递」
  const events = eventRows(dir, room.id)
  assert.equal(events.filter((e) => e.type === 'relay').length, 3)
  assert.equal(events.filter((e) => e.type === 'relay_result').length, 3)
  const relayEvent = events.find((e) => e.type === 'relay')
  assert.deepEqual(relayEvent.targets, all)
  assert.equal(relayEvent.attempted, 3)
})

test('relay 计数跨 replay 持久：重启后仍在累计（限额不可被重启绕过）', (t) => {
  const sent = []
  const { rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = seed(rooms)
  const msg = rooms.post({ roomId: room.id, from: 'user', text: '三成员' })

  rooms.relay({ roomId: room.id, messageId: msg.id, targets: ['s-a', 's-b', 's-c'] }) // 3/9
  rooms.replay()                                                                       // 重启
  const after = rooms.relay({ roomId: room.id, messageId: msg.id, targets: ['s-a', 's-b', 's-c'] }) // 6/9

  assert.equal(after.ok, true)
  assert.equal(after.remaining, 3, '剩余额度必须体现重启前的 3 次（否则限额可被重启绕过）')
})

// ── 9. 投递失败必须可见（★ 绝不静默）───────────────────────────────────────

test('relay 投递失败可见：无 agents 服务 → ok:false + 逐条 reason，且不抛错不静默', (t) => {
  const { rooms } = setup(t) // ctx 里没有 agents 服务 → kernel.followup 必然失败
  const room = seed(rooms)
  const msg = rooms.post({ roomId: room.id, from: 's-a', text: '没人能收到' })

  const result = rooms.relay({ roomId: room.id, messageId: msg.id, targets: ['s-b', 's-c'] })

  assert.equal(result.ok, false, '投递失败必须反映在返回值上')
  assert.equal(result.relayed, 0)
  assert.equal(result.attempted, 2)
  assert.ok(result.reason, 'reason 必填（绝不静默）')
  assert.match(result.reason, /agent-not-live/)
  assert.deepEqual(result.deliveries.map((d) => d.ok), [false, false])
  assert.equal(result.deliveries[0].reason, 'agent-not-live')

  // 失败原因也落在审计流里（可事后追责）
  const events = rowsOf(rooms, room.id)
  const relayResult = events.find((e) => e.type === 'relay_result')
  assert.equal(relayResult.deliveries[0].reason, 'agent-not-live')

  function rowsOf(service, id) {
    return service.history({ roomId: id }).filter((e) => e.type === 'relay_result')
  }
})

test('relay 部分失败：成功的仍计入 relayed，失败的在 reason 里点名', (t) => {
  const sent = []
  const halfAgents = {
    get: (id) => (id === 's-c' ? undefined : {
      id,
      followup: (message) => sent.push({ target: id, text: message?.content?.[0]?.text }),
    }),
  }
  const { rooms } = setup(t, {}, { agents: halfAgents })
  const room = seed(rooms)
  const msg = rooms.post({ roomId: room.id, from: 's-a', text: '半成功' })

  const result = rooms.relay({ roomId: room.id, messageId: msg.id, targets: ['s-b', 's-c'] })
  assert.equal(result.ok, false)
  assert.equal(result.relayed, 1)
  assert.deepEqual(result.deliveries, [
    { target: 's-b', ok: true },
    { target: 's-c', ok: false, reason: 'agent-not-live' },
  ])
  assert.match(result.reason, /s-c:agent-not-live/)
  assert.equal(sent.length, 1)
})

// ── 10. 发言权（★ 非成员发言被拒）──────────────────────────────────────────

test('post 发言权：非成员被拒、user 恒可发言、admin 模式只有 adminId 能发言', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)

  // 非成员
  let caught
  try {
    rooms.post({ roomId: room.id, from: 's-ghost', text: '我不在房里' })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof RoomError, '非成员发言必须抛错')
  assert.equal(caught.code, 'ROOM_NOT_MEMBER')
  assert.match(caught.message, /不是房间/)
  assert.equal(logRows === undefined ? 0 : 0, 0)

  // 'user' 是特殊发送者：永远可发言
  const fromUser = rooms.post({ roomId: room.id, from: 'user', text: '人类发言' })
  assert.equal(fromUser.from, 'user')
  assert.equal(fromUser.seq, 1, '被拒的那条**没有**消耗 seq')

  // admin 模式：只有管理员能发言
  const adminRoom = rooms.createRoom_({ name: 'admin-post', members: ['s-a', 's-b'], mode: 'admin', adminId: 's-a', byId: 's-a' })
  assert.equal(rooms.post({ roomId: adminRoom.id, from: 's-a', text: '公告' }).seq, 1)
  assert.throws(
    () => rooms.post({ roomId: adminRoom.id, from: 's-b', text: '普通成员想说话' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_POST_FORBIDDEN' && /admin 模式/.test(e.message),
  )
  assert.equal(rooms.post({ roomId: adminRoom.id, from: 'user', text: '人类仍可发言' }).seq, 2)

  // 显式 members 不含创建者 → 创建者发言同样被拒（成员表就是权威）
  const explicit = rooms.createRoom_({ name: 'no-creator', members: ['s-x'], byId: 's-a' })
  assert.throws(
    () => rooms.post({ roomId: explicit.id, from: 's-a', text: '创建者不在成员表里' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_MEMBER',
  )
})

// ── 11. 回放一致性（★ 硬要求）──────────────────────────────────────────────

test('replay：另起一个实例从磁盘回放 → 房间与消息与内存态**逐字段一致**', (t) => {
  const sent = []
  const { dir, rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = rooms.createRoom_({ name: '回放房间', members: ['s-a', 's-b'], byId: 's-a', notice: '公告' })
  rooms.post({ roomId: room.id, from: 's-a', text: '第一条' })
  rooms.post({ roomId: room.id, from: 's-b', text: 'Y'.repeat(3000), kind: 'pass' })
  rooms.post({ roomId: room.id, from: 's-a', text: '第三条', dedupKey: 'dup-1' })
  rooms.join({ roomId: room.id, sessionId: 's-c' })
  const msg2 = rooms.listMessages({ roomId: room.id })[1]
  rooms.relay({ roomId: room.id, messageId: msg2.id, targets: ['s-a'] })

  const liveRooms = rooms.list()
  const liveMsgs = rooms.listMessages({ roomId: room.id })
  const liveEvents = rooms.history({ roomId: room.id })

  // 全新实例（模拟进程重启），同一状态目录
  const revived = createRoom({ logger: { info() {}, warn() {} } }, { stateDir: dir })

  assert.deepEqual(revived.list(), liveRooms, '房间状态必须逐字段一致（含 seq/rev/members/relayLimit）')
  assert.deepEqual(revived.listMessages({ roomId: room.id }), liveMsgs, '消息必须逐字段一致')
  assert.deepEqual(revived.history({ roomId: room.id }), liveEvents, '审计流必须一致')

  // 长正文回放后仍可读回原文
  assert.equal(revived.readBody({ roomId: room.id, messageId: msg2.id }), 'Y'.repeat(3000))
  // 幂等键随回放重建：重启后重复投递仍被复用
  const again = revived.post({ roomId: room.id, from: 's-a', text: '重复', dedupKey: 'dup-1' })
  assert.equal(again.id, liveMsgs[2].id)
  assert.equal(revived.listMessages({ roomId: room.id }).length, 3)
  // 回放不产生 seq 空洞
  assert.equal(revived.stats().seqGaps, 0)
  assert.equal(revived.stats().hydratedFrom, 'events')
})

test('replay 幂等：同一实例重复 replay 结果稳定；事件流缺失才回落索引快照', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  rooms.post({ roomId: room.id, from: 's-a', text: 'A' })
  rooms.post({ roomId: room.id, from: 's-a', text: 'B' })

  const first = rooms.replay()
  const second = rooms.replay()
  assert.deepEqual(second, { ...first, from: first.from }, '重复回放必须稳定（不叠加、不清空）')
  assert.equal(first.rooms, 1)
  assert.equal(first.messages, 2)
  assert.equal(first.bad, 0)

  // 事件流被清掉（模拟损坏）→ 回落快照，房间不丢
  rmSync(join(dir, 'rooms', room.id, 'events.jsonl'), { force: true })
  const fallback = rooms.replay()
  assert.equal(fallback.from, 'snapshot')
  assert.equal(rooms.get(room.id).name, room.name, '索引快照必须能救回房间')
  // 但消息真相源只有 log.jsonl，仍在（这正是「消息不依赖索引快照」的设计意图）
  assert.equal(rooms.listMessages({ roomId: room.id }).length, 2)
})

test('replay：坏行不静默丢弃（计入 bad 并保留原始数据）', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  rooms.post({ roomId: room.id, from: 's-a', text: '好的' })

  // 人为往日志尾部塞一行坏数据（撕裂写模拟）
  const logFile = join(dir, 'rooms', room.id, 'log.jsonl')
  const raw = readFileSync(logFile, 'utf8')
  writeFileSync(logFile, `${raw}{ 这不是 JSON\n`, 'utf8')

  const result = rooms.replay()
  assert.equal(result.bad >= 1, true, '坏行必须被计入 bad（绝不静默丢弃）')
  assert.equal(rooms.listMessages({ roomId: room.id }).length, 1, '好行照常可用')
  // 坏行**未被删除**：原文件仍在（可人工核对，不是「悄悄修好」）
  assert.ok(readFileSync(logFile, 'utf8').includes('这不是 JSON'))
})

// ── 2026-11-04 测试回归 ─────────────────────────────────────────────────────
// 🔴 P1-5：update() 之前只在 admin 模式校验管理员，mode='everyone' 时**完全不校验
//   调用者是否成员** ⇒ 任意人可改房间名/公告（实测 byId:'attacker-not-a-member' 改名成功）。

test('2026-11-04 P1-5：非成员不能改 everyone 模式房间的设置', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms) // mode 默认 everyone，成员 s-a/s-b/s-c
  assert.throws(
    () => rooms.update({ roomId: room.id, expectedRev: room.rev, byId: 'attacker-not-a-member', name: 'hijacked' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_MEMBER',
  )
})

test('2026-11-04 P1-5：成员可以改 everyone 模式房间的设置', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)
  const updated = rooms.update({ roomId: room.id, expectedRev: room.rev, byId: 's-a', name: 'renamed-ok' })
  assert.equal(updated.name, 'renamed-ok')
})

test('2026-11-04 P1-5：user（主管本人）可改房间设置（不被成员校验挡）', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)
  const updated = rooms.update({ roomId: room.id, expectedRev: room.rev, byId: 'user', name: 'by-user' })
  assert.equal(updated.name, 'by-user')
})

// ══ 2026-11-11「唤醒风暴」止血 —— mentionOnly 定向唤醒 ══════════════════════

test('mentionOnly：缺省 true，@ 到的人被唤醒，其他人不唤醒', (t) => {
  const sent = []
  const { rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = seed(rooms)
  const msg = rooms.post({ roomId: room.id, from: 's-b', text: '@s-a 帮忙看下这个' })

  const result = rooms.relay({ roomId: room.id, messageId: msg.id })
  assert.equal(result.targetSource, 'mention', '有 @ 时走 mention 档')
  assert.equal(result.relayed, 1, '只 @ 了 s-a，只唤醒 1 人')
  assert.deepEqual(result.deliveries.map((d) => d.target), ['s-a'])
  assert.equal(sent.length, 1, '只投递给 s-a')
})

test('mentionOnly：缺省 true，没 @ 到人 ⇒ relayed:0 不抛错，一个 followup 都不发', (t) => {
  const sent = []
  const { rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = seed(rooms)
  const msg = rooms.post({ roomId: room.id, from: 's-b', text: '大家看下这个（没 @ 任何人）' })

  const result = rooms.relay({ roomId: room.id, messageId: msg.id })
  assert.equal(result.ok, true, '「只记录不打扰」是合法结果')
  assert.equal(result.relayed, 0)
  assert.equal(result.attempted, 0)
  assert.equal(result.reason, 'mention-only-no-target')
  assert.equal(sent.length, 0, '一个 followup 都不许发出去')
})

test('mentionOnly：human 身份（ui/user/person）在任何模式下都不被唤醒', (t) => {
  const sent = []
  const { rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = rooms.createRoom_({
    name: 'humans-excluded',
    members: ['s-a', 'ui', 'user', 'person'],
    byId: 's-a',
  })
  const msg = rooms.post({ roomId: room.id, from: 's-a', text: '@ui @user @person 看这条' })

  // mentionOnly=true 时：human 被 @ 了也跳过 → 合法空转发，不抛错
  const result = rooms.relay({ roomId: room.id, messageId: msg.id })
  assert.equal(result.relayed, 0, 'human id 被 @ 了也不唤醒')
  assert.equal(result.reason, 'mention-only-no-target')
  assert.equal(sent.length, 0)

  // mentionOnly=false（广播）+ 房间里除发送者外全是 human → 无可唤醒目标，**抛错**
  // 这是配置错误：广播模式但没有 bot 可广播给。抛错比静默更诚实。
  const room2 = rooms.createRoom_({
    name: 'humans-excluded-broadcast',
    members: ['s-b', 'ui', 'user'],
    byId: 's-b',
    settings: { mentionOnly: false },
  })
  const msg2 = rooms.post({ roomId: room2.id, from: 's-b', text: '广播测试' })
  assert.throws(
    () => rooms.relay({ roomId: room2.id, messageId: msg2.id }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NO_TARGETS',
    '广播模式但没有可唤醒成员（全是 human）⇒ 抛错，不静默',
  )
})

test('mentionOnly：显式 targets 走 explicit 档，剔除混入的 human id 并 warn', (t) => {
  const sent = []
  const { rooms } = setup(t, {}, { agents: liveAgents(sent) })
  const room = seed(rooms)
  const msg = rooms.post({ roomId: room.id, from: 's-b', text: '定向投递' })

  const result = rooms.relay({ roomId: room.id, messageId: msg.id, targets: ['s-a', 'ui'] })
  assert.equal(result.targetSource, 'explicit')
  assert.deepEqual(result.deliveries.map((d) => d.target), ['s-a'], 'ui 被剔除，只有 s-a 被投递')
  assert.equal(result.relayed, 1)
  assert.equal(sent.length, 1)
})

test('mentionOnly：settings 未知键仍抛错（mentionOnly 加入白名单但不放宽校验）', (t) => {
  const { rooms } = setup(t)
  assert.throws(
    () => rooms.createRoom_({ name: 'bad-key', members: ['s-a'], byId: 's-a', settings: { nonExistent: true } }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_SETTING' && /nonExistent/.test(e.message),
  )
  // mentionOnly 是合法键
  const ok = rooms.createRoom_({ name: 'ok-mention-only', members: ['s-a'], byId: 's-a', settings: { mentionOnly: false } })
  assert.equal(ok.settings.mentionOnly, false)
  assert.equal(ok.settings.allowBotAutoPost, true, '未给的键回落缺省')
})

test('mentionOnly：回放持久化 —— 从磁盘重建的房间 settings.mentionOnly 与内存态一致', (t) => {
  const { dir, rooms } = setup(t)
  const room = rooms.createRoom_({ name: 'replay-mention', members: ['s-a', 's-b'], byId: 's-a' })
  assert.equal(room.settings.mentionOnly, true, '缺省 true')
  rooms.update({ roomId: room.id, expectedRev: room.rev, byId: 's-a', settings: { mentionOnly: false } })

  const revived = createRoom({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const got = revived.get(room.id)
  assert.equal(got.settings.mentionOnly, false, '回放后 mentionOnly=false 仍在')
  assert.equal(got.settings.maxBotsPerRound, 3, '其他缺省值也完好')
})
