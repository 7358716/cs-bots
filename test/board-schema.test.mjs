import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoard, BoardError } from '../src/board.js'

let c = 0
function setup(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), `bs-${process.pid}-${c++}-`))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  return { dir, board: createBoard({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config }) }
}

test('老数据回放补默认：labels=[]/triaged=false/progress=0', (t) => {
  const { dir } = setup(t)
  // 手工写一个老格式事件（无 labels/triaged/progress）
  const line = JSON.stringify({ taskId: 't-1', rev: 1, action: 'create', byId: 'lead', at: 1, before: null, after: { id: 't-1', rev: 1, subject: 'old', status: 'pending', blockedBy: [], writeScopes: [], createdAt: 1, createdBy: 'lead' } }) + '\n'
  writeFileSync(join(dir, 'board.jsonl'), line)
  const b = createBoard({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const t1 = b.get('t-1')
  assert.deepEqual(t1.labels, [])
  assert.equal(t1.triaged, false)
  assert.equal(t1.progress, 0)
})

test('WIP 超限被拒', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'bot' })
  const b = board.create({ subject: 'B', byId: 'bot' })
  board.update({ id: a.id, expectedRev: 1, action: 'claim', byId: 'bot' })
  board.update({ id: b.id, expectedRev: 1, action: 'claim', byId: 'bot' })
  const c = board.create({ subject: 'C', byId: 'bot' })
  assert.throws(() => board.update({ id: c.id, expectedRev: 1, action: 'claim', byId: 'bot' }), (e) => e.code === 'BOARD_WIP_EXCEEDED')
})

test('triage 后 ready 才可见（strict）', (t) => {
  const { board } = setup(t, { requireTriageForReady: true })
  const a = board.create({ subject: 'A', byId: 'lead' })
  assert.deepEqual(board.ready({ strict: true }).map((x) => x.id), [])
  board.update({ id: a.id, expectedRev: 1, action: 'triage', byId: 'lead', assignee: 'bot-1' })
  assert.deepEqual(board.ready({ strict: true }).map((x) => x.id), [a.id])
})

test('progress 越界被拒', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead' })
  assert.throws(() => board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'lead', progress: 150 }), (e) => e.code === 'BOARD_BAD_FIELD')
  assert.throws(() => board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'lead', progress: -1 }), (e) => e.code === 'BOARD_BAD_FIELD')
})

test('purgeDeleted 移除墓碑', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead' })
  board.update({ id: a.id, expectedRev: 1, action: 'delete', byId: 'lead', now: 1000 })
  const removed = board.purgeDeleted({ olderThanMs: 0, now: 2000 })
  assert.deepEqual(removed, [a.id])
  assert.equal(board.get(a.id), undefined)
})
