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

test('契约 §6：edit 写 progress 时自动同写 progressBy/progressAt', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead' })
  const updated = board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'bot-7', progress: 40, now: 12345 })
  assert.equal(updated.progress, 40)
  assert.equal(updated.progressBy, 'bot-7', 'progressBy 必须等于写入者 byId（不需要调用方传）')
  assert.equal(updated.progressAt, 12345, 'progressAt 必须等于写入时刻')
  // 必须能从读接口读到（这是 UI 显示「队长估算 / Boss 设定」的唯一依据）
  assert.equal(board.get(a.id).progressBy, 'bot-7')
  assert.equal(board.list().find((x) => x.id === a.id).progressBy, 'bot-7')
})

test('契约 §6：set 写 progress 时同样自动同写 progressBy/progressAt', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead' })
  const updated = board.update({ id: a.id, expectedRev: 1, action: 'set', byId: 'boss-ui', progress: 90, now: 2000 })
  assert.equal(updated.progress, 90)
  assert.equal(updated.progressBy, 'boss-ui')
  assert.equal(updated.progressAt, 2000)
})

test('契约 §6：progressBy/progressAt 是派生字段，调用方传了会被拒（不许伪造来源）', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead' })
  assert.throws(
    () => board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'lead', progress: 10, progressBy: 'liar' }),
    (e) => e.code === 'BOARD_UNKNOWN_FIELD',
  )
})

test('契约 §6：progress=null 清除进度时，来源字段一并清除', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead' })
  board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'bot-7', progress: 40, now: 5 })
  const cleared = board.update({ id: a.id, expectedRev: 2, action: 'edit', byId: 'bot-7', progress: null, now: 9 })
  assert.equal(cleared.progress, undefined)
  assert.equal(cleared.progressBy, undefined)
  assert.equal(cleared.progressAt, undefined)
})

test('契约 §9：老数据没有 progressBy/progressAt 时不报错、不伪造来源', (t) => {
  const { dir } = setup(t)
  // 手工写一条旧格式事件（无 progressBy / progressAt）
  const line = JSON.stringify({
    taskId: 't-old', rev: 1, action: 'create', byId: 'lead', at: 1, before: null,
    after: { id: 't-old', rev: 1, subject: 'old', status: 'pending', blockedBy: [], writeScopes: [], labels: [], triaged: false, progress: 0, createdAt: 1, createdBy: 'lead' },
  }) + '\n'
  writeFileSync(join(dir, 'board.jsonl'), line)
  const b = createBoard({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const t1 = b.get('t-old')
  assert.equal(t1.progress, 0)
  assert.equal(t1.progressBy, undefined, '旧数据没有 progressBy ⇒ 不得伪造')
  assert.equal(t1.progressAt, undefined, '旧数据没有 progressAt ⇒ 不得伪造')
})

test('契约 §9：快照路径缺新字段同样不抛（board.snap.json）', (t) => {
  const { dir } = setup(t)
  // 只有快照、没有事件流 ⇒ 走 hydrate 的 snapshot 分支
  writeFileSync(join(dir, 'board.snap.json'), JSON.stringify({
    version: 1, idCounter: 1, tasks: [
      { id: 't-snap', rev: 1, subject: 's', status: 'pending', blockedBy: [], writeScopes: [], createdAt: 1, createdBy: 'lead' },
    ],
  }))
  const b = createBoard({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const t1 = b.get('t-snap')
  assert.equal(t1.progress, 0, '缺 progress 给默认 0')
  assert.equal(t1.progressBy, undefined, '缺 progressBy 不抛、不伪造')
  assert.equal(t1.progressAt, undefined)
})

test('契约 §6：progressBy/progressAt 经得起重启回放（事件流即真相源）', (t) => {
  const { dir, board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead' })
  board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'bot-3', progress: 55, now: 4242 })

  // 重新构造：只认 board.jsonl（升级不丢历史的硬要求）
  const b2 = createBoard({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const t2 = b2.get(a.id)
  assert.equal(t2.progress, 55)
  assert.equal(t2.progressBy, 'bot-3', '重启后来源必须还在')
  assert.equal(t2.progressAt, 4242, '重启后写入时刻必须还在')
})

test('purgeDeleted 移除墓碑', (t) => {
  const { board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead' })
  board.update({ id: a.id, expectedRev: 1, action: 'delete', byId: 'lead', now: 1000 })
  const removed = board.purgeDeleted({ olderThanMs: 0, now: 2000 })
  assert.deepEqual(removed, [a.id])
  assert.equal(board.get(a.id), undefined)
})
