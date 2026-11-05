/**
 * CAS 覆盖测试（P1-D）—— 四服务 rev/expectedRev 乐观并发。
 *
 * 验收口径（task-4）：四服务**各一例 expectedRev 匹配成功 + 各一例不匹配被拒**。
 * 每条断言都用真实返回值 / 真实落盘产物做证据，不接受「没抛错」这种弱断言。
 * 只碰 node:test + node:assert + node:fs + node:os + node:path。
 *
 * 运行：`node --test test/cas-coverage.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createRoom from '../src/room.js'
import createMemory from '../src/memory.js'
import createTodo from '../src/todo.js'
import createRoster from '../src/roster.js'

let counter = 0

/** 独立状态目录（互不污染）。 */
function tmpState(t, tag) {
  const base = process.env.CS_BOTS_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-cas-${tag}-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  return dir
}

const ctx = { logger: { info() {}, warn() {} } }

// ── RoomService ──────────────────────────────────────────────────────────────

test('room：update 带正确 expectedRev 匹配成功（rev +1）', (t) => {
  const dir = tmpState(t, 'room-ok')
  const rooms = createRoom(ctx, { stateDir: dir })
  const room = rooms.createRoom_({ name: 'CAS room', members: ['s-a'], byId: 's-a' })
  assert.equal(room.rev, 1, '新建房间 rev 从 1 起')

  const updated = rooms.update({ roomId: room.id, name: 'CAS room v2', expectedRev: room.rev, byId: 's-a' })
  assert.equal(updated.rev, 2, '成功变更后 rev 必须 +1')
  assert.equal(updated.name, 'CAS room v2')

  // 审计：audit.jsonl 应已落盘（appendAudit 软用成功）
  assert.ok(existsSync(join(dir, 'audit.jsonl')), 'audit.jsonl 应被 appendAudit 写入')
})

test('room：update 带过期 expectedRev 被拒（ROOM_REV_CONFLICT）', (t) => {
  const dir = tmpState(t, 'room-bad')
  const rooms = createRoom(ctx, { stateDir: dir })
  const room = rooms.createRoom_({ name: 'CAS room', members: ['s-a'], byId: 's-a' })

  // 先做一次合法变更（rev → 2），再用过期的 rev=1 试图变更 → 必须抛
  rooms.update({ roomId: room.id, name: 'changed', expectedRev: room.rev, byId: 's-a' })
  assert.throws(
    () => rooms.update({ roomId: room.id, name: 'should not apply', expectedRev: room.rev, byId: 's-a' }),
    (e) => e.code === 'ROOM_REV_CONFLICT' && e.details?.expectedRev === 1 && e.details?.rev === 2,
  )
})

// ── MemoryService ────────────────────────────────────────────────────────────

test('memory：update 带正确 expectedRev 匹配成功（rev +1）', (t) => {
  const dir = tmpState(t, 'mem-ok')
  const mem = createMemory(ctx, { stateDir: dir })
  const entry = mem.add({ layer: 'L1', content: 'CAS memory entry', by: 'user' })
  assert.equal(entry.rev, 1, '新建条目 rev 从 1 起')

  const updated = mem.update({ layer: 'L1', id: entry.id, expectedRev: entry.rev, content: 'CAS memory v2', by: 'user' })
  assert.equal(updated.rev, 2, '成功变更后 rev 必须 +1')
  assert.equal(updated.content, 'CAS memory v2')

  assert.ok(existsSync(join(dir, 'audit.jsonl')), 'audit.jsonl 应被 appendAudit 写入')
})

test('memory：update 带过期 expectedRev 被拒（MEMORY_CAS_CONFLICT）', (t) => {
  const dir = tmpState(t, 'mem-bad')
  const mem = createMemory(ctx, { stateDir: dir })
  const entry = mem.add({ layer: 'L1', content: 'CAS memory entry', by: 'user' })

  mem.update({ layer: 'L1', id: entry.id, expectedRev: entry.rev, content: 'changed', by: 'user' })
  assert.throws(
    () => mem.update({ layer: 'L1', id: entry.id, expectedRev: entry.rev, content: 'should not apply', by: 'user' }),
    (e) => e.code === 'MEMORY_CAS_CONFLICT' && e.details?.expectedRev === 1 && e.details?.rev === 2,
  )
})

// ── TodoService ─────────────────────────────────────────────────────────────

test('todo：updateTodo 带正确 expectedRev 匹配成功（rev +1）', (t) => {
  const dir = tmpState(t, 'todo-ok')
  const svc = createTodo(ctx, { stateDir: dir })
  const todo = svc.createTodo({ track: 'life', content: 'CAS todo', by: 'lead' })
  assert.equal(todo.rev, 1, '新建待办 rev 从 1 起')

  const updated = svc.updateTodo({ id: todo.id, expectedRev: todo.rev, content: 'CAS todo v2', by: 'lead' })
  assert.equal(updated.rev, 2, '成功变更后 rev 必须 +1')
  assert.equal(updated.content, 'CAS todo v2')

  assert.ok(existsSync(join(dir, 'audit.jsonl')), 'audit.jsonl 应被 appendAudit 写入')
})

test('todo：updateTodo 带过期 expectedRev 被拒（TODO_REV_CONFLICT）', (t) => {
  const dir = tmpState(t, 'todo-bad')
  const svc = createTodo(ctx, { stateDir: dir })
  const todo = svc.createTodo({ track: 'life', content: 'CAS todo', by: 'lead' })

  svc.updateTodo({ id: todo.id, expectedRev: todo.rev, content: 'changed', by: 'lead' })
  assert.throws(
    () => svc.updateTodo({ id: todo.id, expectedRev: todo.rev, content: 'should not apply', by: 'lead' }),
    (e) => e.code === 'TODO_REV_CONFLICT' && e.details?.expectedRev === 1 && e.details?.rev === 2,
  )
})

// ── RosterService ───────────────────────────────────────────────────────────

test('roster：rename 带正确 expectedRev 匹配成功（rev +1）', async (t) => {
  const dir = tmpState(t, 'roster-ok')
  const root = mkdtempSync(join(tmpState(t, 'roster-ws'), 'ws'))
  const fakeCtx = {
    ...ctx,
    get(key) {
      if (key !== 'agents') return undefined
      return {
        async create(req) {
          return { sessionId: req.sessionId }
        },
      }
    },
  }
  const roster = createRoster(fakeCtx, { stateDir: dir })
  const bot = await roster.create({ name: 'cas-bot', cwd: root, permission: 'workspace-write', byId: 'lead' })
  assert.equal(bot.rev, 1, '新建 Bot rev 从 1 起')

  const renamed = roster.rename({ id: bot.id, name: 'cas-bot-v2', expectedRev: bot.rev, byId: 'lead' })
  assert.equal(renamed.rev, 2, '成功变更后 rev 必须 +1')
  assert.equal(renamed.name, 'cas-bot-v2')

  assert.ok(existsSync(join(dir, 'audit.jsonl')), 'audit.jsonl 应被 appendAudit 写入')
})

test('roster：rename 带过期 expectedRev 被拒（ROSTER_REV_CONFLICT）', async (t) => {
  const dir = tmpState(t, 'roster-bad')
  const root = mkdtempSync(join(tmpState(t, 'roster-ws-bad'), 'ws'))
  const fakeCtx = {
    ...ctx,
    get(key) {
      if (key !== 'agents') return undefined
      return {
        async create(req) {
          return { sessionId: req.sessionId }
        },
      }
    },
  }
  const roster = createRoster(fakeCtx, { stateDir: dir })
  const bot = await roster.create({ name: 'cas-bot', cwd: root, permission: 'workspace-write', byId: 'lead' })

  roster.rename({ id: bot.id, name: 'changed', expectedRev: bot.rev, byId: 'lead' })
  assert.throws(
    () => roster.rename({ id: bot.id, name: 'should not apply', expectedRev: bot.rev, byId: 'lead' }),
    (e) => e.code === 'ROSTER_REV_CONFLICT' && e.details?.expectedRev === 1 && e.details?.rev === 2,
  )
})
