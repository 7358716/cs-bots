/**
 * DESIGN-v2 特性 ①：房间超级管理员 + 房间配置 —— 域层验收测试。
 *
 * 覆盖 DESIGN 明确要求的全部点：
 *   归档 / 恢复 / 硬删 / 角色 / 踢人 / withBody / 超级管理员放行 / 普通成员被拒 /
 *   replay 后新字段仍在。
 *
 * 纪律（与 `test/room.test.mjs` 一致）：
 *   - 只用 `node:test` + `node:assert` + node 内置模块（零第三方依赖）；
 *   - 断言的是**磁盘事实**（`rooms/<id>/events.jsonl`、`index.json`、旁路正文文件），
 *     不是「函数没抛错」；
 *   - 每个用例独立状态目录，互不污染。
 *
 * 运行：`node --test test/room-admin.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createRoom,
  RoomError,
  ROOM_DEFAULT_SETTINGS,
  ROOM_LIMITS,
  ROOM_MEMBER_ROLES,
} from '../src/room.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

function setup(t) {
  const base = process.env.CS_BOTS_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-room-admin-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const rooms = createRoom({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  return { dir, rooms }
}

/** 3 成员房间（创建者 s-a；everyone 模式）。 */
function seed(rooms, over = {}) {
  return rooms.createRoom_({
    name: `R${counter++}`,
    members: ['s-a', 's-b', 's-c'],
    byId: 's-a',
    ...over,
  })
}

/** 读事件流（审计真相源）。 */
function eventRows(dir, roomId) {
  const file = join(dir, 'rooms', roomId, 'events.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

// ── 1. 模型新字段：缺省值 / 持久化 / 回放 ───────────────────────────────────

test('新建房间：purpose/roles/settings/archivedAt 都有确定缺省值，且落进事件流', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)

  assert.equal(room.purpose, '', 'purpose 缺省空串（不是 undefined —— 回放后形状必须一致）')
  assert.deepEqual(room.roles, { 's-a': 'member', 's-b': 'member', 's-c': 'member' })
  assert.deepEqual(room.settings, { ...ROOM_DEFAULT_SETTINGS }, 'settings 缺省必须完整，不能是空对象')
  assert.equal(room.archivedAt, null, '未归档 = null')

  // 落盘证据：事件流的 after 里带全字段
  const events = eventRows(dir, room.id)
  assert.equal(events.length, 1)
  assert.equal(events[0].after.purpose, '')
  assert.deepEqual(events[0].after.roles, room.roles)
  assert.deepEqual(events[0].after.settings, { ...ROOM_DEFAULT_SETTINGS })
  assert.equal(events[0].after.archivedAt, null)
})

test('新建房间：admin 模式下 adminId 的角色记为 admin；purpose/settings 入参生效', (t) => {
  const { rooms } = setup(t)
  const room = rooms.createRoom_({
    name: 'admin-config',
    members: ['s-a', 's-b'],
    mode: 'admin',
    adminId: 's-a',
    byId: 's-a',
    purpose: '一期需求评审',
    settings: { allowBotAutoPost: false, maxBotsPerRound: 5 },
  })
  assert.equal(room.purpose, '一期需求评审')
  assert.deepEqual(room.roles, { 's-a': 'admin', 's-b': 'member' })
  assert.deepEqual(room.settings, { allowBotAutoPost: false, maxBotsPerRound: 5, relayEnabled: true },
    '未显式给的开关必须回落缺省值（增量合并口径）')
})

test('新建房间：非法 purpose / settings 键 / settings 类型 → 全部抛结构化错误', (t) => {
  const { rooms } = setup(t)
  const mk = (over) => rooms.createRoom_({ name: `bad-${counter++}`, members: ['s-a'], byId: 's-a', ...over })

  assert.throws(
    () => mk({ purpose: 123 }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_FIELD' && /purpose/.test(e.message),
  )
  assert.throws(
    () => mk({ purpose: 'x'.repeat(ROOM_LIMITS.MAX_PURPOSE + 1) }),
    (e) => e instanceof RoomError && e.code === 'ROOM_PURPOSE_TOO_LONG',
  )
  assert.throws(
    () => mk({ settings: { notARealSwitch: true } }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_SETTING' && /notARealSwitch/.test(e.message),
    '未知设置键必须拒绝，不能写入一份永远不生效的配置',
  )
  assert.throws(
    () => mk({ settings: { allowBotAutoPost: 'yes' } }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_SETTING',
  )
  assert.throws(
    () => mk({ settings: { maxBotsPerRound: -1 } }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_SETTING',
  )
  assert.throws(
    () => mk({ settings: [] }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_FIELD',
  )
})

// ── 2. update 扩展：purpose / settings ──────────────────────────────────────

test('update：可改 purpose 与 settings（增量合并），rev 递增，事件流留痕', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)

  const afterPurpose = rooms.update({ roomId: room.id, expectedRev: room.rev, byId: 's-a', purpose: '  新用途  ' })
  assert.equal(afterPurpose.purpose, '新用途', 'purpose 两端空白归一')
  assert.equal(afterPurpose.rev, 2)
  assert.equal(eventRows(dir, room.id).at(-1).type, 'purpose_changed')

  const afterSettings = rooms.update({
    roomId: room.id,
    expectedRev: afterPurpose.rev,
    byId: 's-b',
    settings: { maxBotsPerRound: 7 },
  })
  assert.deepEqual(afterSettings.settings, { allowBotAutoPost: true, maxBotsPerRound: 7, relayEnabled: true },
    '增量合并：只改给定的键，其余保持原值')
  assert.equal(afterSettings.rev, 3)
  assert.equal(eventRows(dir, room.id).at(-1).type, 'settings_changed')

  // 空串 = 清空用途（不是「未提供」）
  const cleared = rooms.update({ roomId: room.id, expectedRev: afterSettings.rev, byId: 's-a', purpose: '' })
  assert.equal(cleared.purpose, '')
  assert.equal(cleared.rev, 4)
})

test('update：无实际变化不写事件、不递增 rev（避免审计流被空变更污染）', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  const before = eventRows(dir, room.id).length

  const samePurpose = rooms.update({ roomId: room.id, expectedRev: room.rev, byId: 's-a', purpose: '' })
  assert.equal(samePurpose.rev, 1)
  const sameSettings = rooms.update({
    roomId: room.id,
    expectedRev: room.rev,
    byId: 's-a',
    settings: { allowBotAutoPost: true },
  })
  assert.equal(sameSettings.rev, 1)
  assert.equal(sameSettings.changed, undefined, '无变化时不应返回 changed')
  assert.equal(eventRows(dir, room.id).length, before)
})

test('update：settings 未知键 / 非法类型 / purpose 超长 → 抛错且不落盘', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  const eventsBefore = eventRows(dir, room.id).length

  assert.throws(
    () => rooms.update({ roomId: room.id, byId: 's-a', settings: { hackRoom: 1 } }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_SETTING',
  )
  assert.throws(
    () => rooms.update({ roomId: room.id, byId: 's-a', settings: { relayEnabled: 1 } }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_SETTING',
  )
  assert.throws(
    () => rooms.update({ roomId: room.id, byId: 's-a', purpose: 'x'.repeat(ROOM_LIMITS.MAX_PURPOSE + 1) }),
    (e) => e instanceof RoomError && e.code === 'ROOM_PURPOSE_TOO_LONG',
  )
  assert.equal(eventRows(dir, room.id).length, eventsBefore, '校验失败不得写事件')
  assert.equal(rooms.get(room.id).purpose, '')
})

test('update：CAS 不匹配必须抛 ROOM_REV_CONFLICT（禁止静默覆盖）', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)
  rooms.update({ roomId: room.id, expectedRev: 1, byId: 's-a', purpose: 'v2' })

  assert.throws(
    () => rooms.update({ roomId: room.id, expectedRev: 1, byId: 's-a', purpose: 'stale' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_REV_CONFLICT' && e.details.rev === 2,
  )
  assert.equal(rooms.get(room.id).purpose, 'v2', '冲突的写入不得生效')
})

// ── 3. 归档 / 恢复 ──────────────────────────────────────────────────────────

test('归档：缺省 list() 不含，includeArchived 含；get 仍可读；重复归档抛错', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)
  const other = seed(rooms)

  const archived = rooms.archiveRoom({ roomId: room.id, expectedRev: room.rev, byId: 's-a', now: 1000 })
  assert.equal(archived.archivedAt, 1000)
  assert.equal(archived.rev, 2)

  assert.deepEqual(rooms.list().map((r) => r.id), [other.id], '归档房缺省不出现在 list()')
  assert.deepEqual(rooms.list({ includeArchived: true }).map((r) => r.id), [room.id, other.id],
    'includeArchived=true 时必须包含归档房（创建序）')
  assert.equal(rooms.get(room.id).archivedAt, 1000, 'get 仍可读 —— 否则归档后无法恢复')

  assert.throws(
    () => rooms.archiveRoom({ roomId: room.id, byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_ALREADY_ARCHIVED',
  )
  assert.throws(
    () => rooms.list({ includeArchived: 'yes' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_FIELD',
  )
})

test('恢复：unarchiveRoom 清零 archivedAt；未归档时抛 ROOM_NOT_ARCHIVED', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  const other = seed(rooms) // 未归档的对照房
  rooms.archiveRoom({ roomId: room.id, expectedRev: room.rev, byId: 's-a', now: 5000 })

  assert.throws(
    () => rooms.unarchiveRoom({ roomId: other.id, byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_ARCHIVED',
  )

  const restored = rooms.unarchiveRoom({ roomId: room.id, expectedRev: 2, byId: 's-a' })
  assert.equal(restored.archivedAt, null)
  assert.equal(restored.rev, 3)
  assert.deepEqual(rooms.list().map((r) => r.id), [room.id, other.id], '恢复后重新出现在缺省 list()')
  assert.deepEqual(
    eventRows(dir, room.id).map((e) => e.type),
    ['room_created', 'room_archived', 'room_unarchived'],
    '归档/恢复必须各留一条审计事件',
  )
})

test('归档 / 恢复：CAS 不匹配抛错', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)
  rooms.update({ roomId: room.id, expectedRev: 1, byId: 's-a', purpose: 'x' })

  assert.throws(
    () => rooms.archiveRoom({ roomId: room.id, expectedRev: 1, byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_REV_CONFLICT',
  )
  const archived = rooms.archiveRoom({ roomId: room.id, expectedRev: 2, byId: 's-a' })
  assert.equal(archived.archivedAt !== null, true)

  assert.throws(
    () => rooms.unarchiveRoom({ roomId: room.id, expectedRev: 2, byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_REV_CONFLICT',
  )
})

test('归档：非成员不能归档 everyone 模式房间；成员可以（DESIGN 权限行）', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms) // everyone 模式，成员 s-a/s-b/s-c

  assert.throws(
    () => rooms.archiveRoom({ roomId: room.id, byId: 's-ghost' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_MEMBER',
  )
  const archived = rooms.archiveRoom({ roomId: room.id, byId: 's-b' })
  assert.equal(archived.archivedAt !== null, true, 'everyone 模式成员可归档（DESIGN 权限行）')
  // 非成员同样不能恢复
  assert.throws(
    () => rooms.unarchiveRoom({ roomId: room.id, byId: 's-ghost' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_MEMBER',
  )
})

test('归档房仍占用房间名（恢复后不会撞名）；硬删后才释放', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms, { name: '归档占名房' })
  rooms.archiveRoom({ roomId: room.id, byId: 's-a' })

  assert.throws(
    () => rooms.createRoom_({ name: '归档占名房', members: ['s-a'], byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NAME_TAKEN',
    '归档不是硬删：名字必须仍唯一，否则恢复归档房时会撞名',
  )
  rooms.removeRoom({ roomId: room.id, byId: 's-a' }) // 无消息，owner 可直接硬删
  assert.equal(
    rooms.createRoom_({ name: '归档占名房', members: ['s-a'], byId: 's-a' }).name,
    '归档占名房',
    '硬删后名字释放',
  )
})

// ── 4. 硬删 removeRoom ──────────────────────────────────────────────────────

test('硬删：有消息未 force → ROOM_NOT_EMPTY，目录仍在；force 后才真删', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  rooms.post({ roomId: room.id, from: 's-a', text: '这条消息会随硬删一起没' })

  assert.throws(
    () => rooms.removeRoom({ roomId: room.id, expectedRev: room.rev, byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_EMPTY' && e.details.messages === 1,
  )
  assert.ok(existsSync(join(dir, 'rooms', room.id)), '未 force 时目录必须原封不动')

  const result = rooms.removeRoom({ roomId: room.id, expectedRev: room.rev, byId: 's-a', force: true })
  assert.deepEqual(result, { removed: room.id, messages: 1 })
  assert.equal(existsSync(join(dir, 'rooms', room.id)), false, '硬删必须删掉房间目录（事件流/日志/正文）')
  assert.equal(rooms.get(room.id), undefined)
  assert.deepEqual(rooms.list({ includeArchived: true }), [])
})

test('硬删：无消息时 owner 不需要 force；非 owner 一律禁止（含 force）', (t) => {
  const { rooms } = setup(t)
  const empty = seed(rooms)
  assert.deepEqual(rooms.removeRoom({ roomId: empty.id, byId: 's-a' }), { removed: empty.id, messages: 0 })

  const busy = seed(rooms)
  rooms.post({ roomId: busy.id, from: 's-a', text: 'x' })
  // s-b 是成员但不是 owner（createdBy=s-a）
  assert.throws(
    () => rooms.removeRoom({ roomId: busy.id, byId: 's-b', force: true }),
    (e) => e instanceof RoomError && e.code === 'ROOM_FORBIDDEN' && /创建者/.test(e.message),
  )
  assert.ok(rooms.get(busy.id), '被拒绝的硬删不得改变状态')
})

test('硬删：目录不可写导致删除失败 → 抛 ROOM_DELETE_FAILED，内存与目录保持不变（可重试）', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  const roomDir = join(dir, 'rooms', room.id)
  // 去掉房间目录的写位 → rmSync 无法 unlink 目录内容（模拟文件权限事故）
  chmodSync(roomDir, 0o500)
  try {
    assert.throws(
      () => rooms.removeRoom({ roomId: room.id, byId: 's-a', force: true }),
      (e) => e instanceof RoomError && e.code === 'ROOM_DELETE_FAILED' && /删除失败/.test(e.message),
    )
  } finally {
    chmodSync(roomDir, 0o700)
  }
  assert.ok(existsSync(roomDir), '删除失败时目录必须还在（不静默半删）')
  assert.deepEqual(rooms.list({ includeArchived: true }).map((r) => r.id), [room.id], '内存不得半删')
  // 权限恢复后重试必须成功（失败不污染状态，可重入）
  assert.deepEqual(rooms.removeRoom({ roomId: room.id, byId: 's-a' }), { removed: room.id, messages: 0 })
  assert.equal(existsSync(roomDir), false)
})

// ── 5. 成员角色 setMemberRole ──────────────────────────────────────────────

test('setMemberRole：创建者可设 observer/admin，角色落盘且 rev 递增；无变化不写事件', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)

  const asObserver = rooms.setMemberRole({ roomId: room.id, sessionId: 's-b', role: 'observer', byId: 's-a' })
  assert.equal(asObserver.roles['s-b'], 'observer')
  assert.equal(asObserver.rev, 2)
  assert.equal(eventRows(dir, room.id).at(-1).type, 'member_role_changed')

  const asAdminRole = rooms.setMemberRole({ roomId: room.id, sessionId: 's-c', role: 'admin', byId: 's-a' })
  assert.equal(asAdminRole.roles['s-c'], 'admin')
  assert.equal(asAdminRole.rev, 3)
  assert.equal(asAdminRole.adminId, undefined, 'roles 只是描述：设 admin 角色不得隐式改房间管理员')

  const before = eventRows(dir, room.id).length
  const same = rooms.setMemberRole({ roomId: room.id, sessionId: 's-b', role: 'observer', byId: 's-a' })
  assert.equal(same.rev, 3, '无变化不递增 rev')
  assert.equal(eventRows(dir, room.id).length, before, '无变化不写事件')
})

test('setMemberRole：非法角色 / 非成员目标 / 改 USER 角色 → 抛错', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)

  assert.throws(
    () => rooms.setMemberRole({ roomId: room.id, sessionId: 's-b', role: 'superuser', byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_ROLE' && e.details.allowed.length === 3,
  )
  assert.throws(
    () => rooms.setMemberRole({ roomId: room.id, sessionId: 's-ghost', role: 'member', byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_MEMBER',
  )
  assert.throws(
    () => rooms.setMemberRole({ roomId: room.id, sessionId: 'user', role: 'observer', byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_CANNOT_MODIFY_USER',
  )
  assert.deepEqual(ROOM_MEMBER_ROLES, ['admin', 'member', 'observer'])
})

test('setMemberRole / kickMember：everyone 模式的普通成员被拒（管理员级操作）', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms) // 创建者 s-a；s-b 只是普通成员

  assert.throws(
    () => rooms.setMemberRole({ roomId: room.id, sessionId: 's-c', role: 'observer', byId: 's-b' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_FORBIDDEN' && /管理员级|普通成员/.test(e.message),
  )
  assert.throws(
    () => rooms.kickMember({ roomId: room.id, sessionId: 's-c', byId: 's-b' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_FORBIDDEN',
  )
  assert.throws(
    () => rooms.kickMember({ roomId: room.id, sessionId: 's-c', byId: 's-ghost' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_FORBIDDEN',
  )
})

test('setMemberRole：admin 模式的 adminId 可操作（普通成员仍被拒）', (t) => {
  const { rooms } = setup(t)
  const room = rooms.createRoom_({
    name: 'admin-role-room',
    members: ['s-a', 's-b', 's-c'],
    mode: 'admin',
    adminId: 's-a',
    byId: 's-a',
  })
  assert.equal(
    rooms.setMemberRole({ roomId: room.id, sessionId: 's-b', role: 'observer', byId: 's-a' }).roles['s-b'],
    'observer',
  )
  assert.throws(
    () => rooms.setMemberRole({ roomId: room.id, sessionId: 's-c', role: 'observer', byId: 's-b' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_FORBIDDEN',
  )
})

// ── 6. 踢人 kickMember ─────────────────────────────────────────────────────

test('kickMember：成员表 / relayLimit / roles 同步更新，留审计事件；不能踢 USER / 非成员', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms) // 3 成员，relayLimit=9
  rooms.setMemberRole({ roomId: room.id, sessionId: 's-b', role: 'observer', byId: 's-a' })

  const after = rooms.kickMember({ roomId: room.id, sessionId: 's-b', byId: 's-a' })
  assert.deepEqual(after.members, ['s-a', 's-c'])
  assert.equal(after.relayLimit, 6, '2 名成员 → 3×2')
  assert.equal(Object.prototype.hasOwnProperty.call(after.roles, 's-b'), false, '被踢者的角色条目必须清掉')
  assert.equal(eventRows(dir, room.id).at(-1).type, 'member_kicked')

  assert.throws(
    () => rooms.kickMember({ roomId: room.id, sessionId: 'user', byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_CANNOT_KICK_USER',
  )
  assert.throws(
    () => rooms.kickMember({ roomId: room.id, sessionId: 's-ghost', byId: 's-a' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_NOT_MEMBER',
  )
})

test('kickMember：踢掉 admin 模式的管理员 → 管理权移交给最早加入的剩余成员', (t) => {
  const { rooms } = setup(t)
  const room = rooms.createRoom_({
    name: 'kick-admin',
    members: ['s-a', 's-b', 's-c'],
    mode: 'admin',
    adminId: 's-a',
    byId: 'user', // 超级管理员创建，创建者不是 s-a（owner=user 才能踢 s-a）
  })
  assert.equal(room.adminId, 's-a')

  const after = rooms.kickMember({ roomId: room.id, sessionId: 's-a', byId: 'user' })
  assert.equal(after.adminId, 's-b', '踢掉管理员后必须移交，否则房间被锁死')
  assert.equal(after.roles['s-b'], 'admin')
  assert.deepEqual(after.members, ['s-b', 's-c'])
})

// ── 7. listMessages({withBody}) ────────────────────────────────────────────

test('listMessages：withBody=true 内联长正文全文；缺省不带 body 字段', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)
  const longText = 'Y'.repeat(ROOM_LIMITS.BODY_THRESHOLD + 500)
  const longMsg = rooms.post({ roomId: room.id, from: 's-a', text: longText })
  const shortMsg = rooms.post({ roomId: room.id, from: 's-b', text: '短消息' })

  // 缺省：与改造前完全一致（不带 body），保持老调用方行为
  const plain = rooms.listMessages({ roomId: room.id })
  assert.equal(plain.length, 2)
  for (const m of plain) assert.equal('body' in m, false, 'withBody 缺省时不得凭空多出 body 字段')
  assert.equal(plain[0].text.length, ROOM_LIMITS.BODY_HEAD_CHARS, '日志里仍然只存头（K2 不变）')
  assert.equal(plain[0].bodyRef, 'bodies/m-1.txt')

  const withBody = rooms.listMessages({ roomId: room.id, withBody: true })
  assert.equal(withBody[0].id, longMsg.id)
  assert.equal(withBody[0].body, longText, 'withBody=true 必须内联全文（不是头）')
  assert.equal(withBody[1].body, '短消息', '无旁路正文的消息 body=text')
  assert.equal(withBody[1].bodyError, undefined)

  // 与 sinceSeq/limit 组合仍正确
  const combo = rooms.listMessages({ roomId: room.id, sinceSeq: 1, limit: 1, withBody: true })
  assert.equal(combo.length, 1)
  assert.equal(combo[0].id, shortMsg.id)
  assert.equal(combo[0].body, '短消息')

  assert.throws(
    () => rooms.listMessages({ roomId: room.id, withBody: 'true' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_BAD_FIELD',
  )
})

test('listMessages(withBody)：旁路正文缺失时不静默 —— body 回落头 + 显式 bodyError', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)
  rooms.post({ roomId: room.id, from: 's-a', text: 'Z'.repeat(3000) })

  // 模拟旁路文件被清理
  rmSync(join(dir, 'rooms', room.id, 'bodies', 'm-1.txt'), { force: true })

  const [msg] = rooms.listMessages({ roomId: room.id, withBody: true })
  assert.equal(msg.body, msg.text, '读不到全文时回落到日志里的头（与缺省行为一致）')
  assert.equal(msg.bodyError.code, 'ROOM_BODY_MISSING', '必须显式报错，不能假装返回了全文')
  assert.match(msg.bodyError.message, /正文文件缺失/)
})

// ── 8. 超级管理员（USER）放行 ──────────────────────────────────────────────

test('超级管理员：byId=USER 对新老操作全部放行（非成员也能操作）', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms) // createdBy=s-a，USER 不是成员

  const updated = rooms.update({
    roomId: room.id,
    expectedRev: room.rev,
    byId: 'user',
    name: 'super-renamed',
    purpose: '主管改的用途',
    settings: { relayEnabled: false },
  })
  assert.equal(updated.name, 'super-renamed')
  assert.equal(updated.purpose, '主管改的用途')
  assert.equal(updated.settings.relayEnabled, false)

  const archived = rooms.archiveRoom({ roomId: room.id, expectedRev: updated.rev, byId: 'user' })
  assert.equal(archived.archivedAt !== null, true)
  const unarchived = rooms.unarchiveRoom({ roomId: room.id, expectedRev: archived.rev, byId: 'user' })
  assert.equal(unarchived.archivedAt, null)

  const roleChanged = rooms.setMemberRole({
    roomId: room.id, sessionId: 's-b', role: 'observer', byId: 'user',
  })
  assert.equal(roleChanged.roles['s-b'], 'observer')

  const kicked = rooms.kickMember({ roomId: room.id, sessionId: 's-c', byId: 'user' })
  assert.deepEqual(kicked.members, ['s-a', 's-b'])

  rooms.post({ roomId: room.id, from: 's-a', text: '一条消息' })
  const removed = rooms.removeRoom({ roomId: room.id, byId: 'user', force: true })
  assert.equal(removed.removed, room.id)
  assert.equal(removed.messages, 1, 'USER 可强制硬删别人的房间（超级管理员）')
})

// ── 9. 普通成员被拒（非 USER 走原权限规则）──────────────────────────────────

test('普通成员：非创建者成员不能改角色/踢人/硬删（即使 everyone 模式）', (t) => {
  const { rooms } = setup(t)
  const room = seed(rooms)
  rooms.post({ roomId: room.id, from: 's-a', text: 'x' })

  assert.throws(
    () => rooms.setMemberRole({ roomId: room.id, sessionId: 's-c', role: 'observer', byId: 's-b' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_FORBIDDEN',
  )
  assert.throws(
    () => rooms.kickMember({ roomId: room.id, sessionId: 's-c', byId: 's-b' }),
    (e) => e instanceof RoomError && e.code === 'ROOM_FORBIDDEN',
  )
  assert.throws(
    () => rooms.removeRoom({ roomId: room.id, byId: 's-b', force: true }),
    (e) => e instanceof RoomError && e.code === 'ROOM_FORBIDDEN',
  )
})

// ── 10. 回放：新字段必须持久化并在 replay 后仍在 ────────────────────────────

test('replay：purpose/roles/settings/archivedAt 持久化，回放后逐字段一致', (t) => {
  const { dir, rooms } = setup(t)
  const room = seed(rooms)

  rooms.update({
    roomId: room.id,
    expectedRev: room.rev,
    byId: 's-a',
    purpose: '回放用用途',
    settings: { allowBotAutoPost: false, maxBotsPerRound: 2 },
  })
  rooms.setMemberRole({ roomId: room.id, sessionId: 's-b', role: 'observer', byId: 's-a' })
  const archived = rooms.archiveRoom({ roomId: room.id, expectedRev: rooms.get(room.id).rev, byId: 's-a', now: 777 })

  const live = rooms.list({ includeArchived: true })

  // 全新实例（模拟进程重启）
  const revived = createRoom({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.deepEqual(revived.list({ includeArchived: true }), live,
    '新字段（purpose/roles/settings/archivedAt）必须逐字段一致')

  const got = revived.get(room.id)
  assert.equal(got.purpose, '回放用用途')
  assert.deepEqual(got.roles, { 's-a': 'member', 's-b': 'observer', 's-c': 'member' })
  assert.deepEqual(got.settings, { allowBotAutoPost: false, maxBotsPerRound: 2, relayEnabled: true })
  assert.equal(got.archivedAt, 777)
  assert.equal(got.rev, archived.rev)

  // 归档语义跨重启仍成立
  assert.deepEqual(revived.list(), [], '归档房在回放后仍缺省不出现在 list()')
  assert.equal(revived.stats().archived, 1)
  // 恢复能力跨重启也还在
  const restored = revived.unarchiveRoom({ roomId: room.id, expectedRev: got.rev, byId: 's-a' })
  assert.equal(restored.archivedAt, null)
  assert.deepEqual(revived.list().map((r) => r.id), [room.id])
})

test('replay：硬删的房间不会复活（目录删除后回放不再加载）', (t) => {
  const { dir, rooms } = setup(t)
  const keep = seed(rooms)
  const gone = seed(rooms)
  rooms.post({ roomId: gone.id, from: 's-a', text: 'x' })
  rooms.removeRoom({ roomId: gone.id, byId: 's-a', force: true })

  const revived = createRoom({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.deepEqual(revived.list({ includeArchived: true }).map((r) => r.id), [keep.id])
  assert.equal(revived.get(gone.id), undefined)
  assert.deepEqual(revived.listMessages({ roomId: keep.id }), [])
})
