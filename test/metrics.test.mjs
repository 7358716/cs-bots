/**
 * MetricsService 测试 —— PDCA 测量面。
 *
 * 纪律：每条断言都用实际落盘产物或真实返回值做证据。
 * 运行：`node --test test/metrics.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createMetrics, { MetricsError, METRIC_KINDS } from '../src/metrics.js'

let counter = 0
function setup(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), `cs-bots-metrics-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const svc = createMetrics({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

function readEvents(dir) {
  const f = join(dir, 'metrics.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('record 正常落盘 + 内存同步', (t) => {
  const { dir, svc } = setup(t)
  const rec = svc.record({ kind: 'task_claim', taskId: 't-1', by: 'bot-a' })
  assert.equal(rec.kind, 'task_claim')
  assert.equal(rec.taskId, 't-1')
  assert.equal(rec.by, 'bot-a')
  assert.match(rec.id, /^m-\d+$/)
  const evs = readEvents(dir)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].action, 'record')
  assert.equal(svc.stats().total, 1)
})

test('非法 kind 抛 METRICS_BAD_KIND', (t) => {
  const { svc } = setup(t)
  assert.throws(() => svc.record({ kind: 'nope', by: 'x' }), (e) => e instanceof MetricsError && e.code === 'METRICS_BAD_KIND')
})

test('缺 by 抛 METRICS_BAD_FIELD', (t) => {
  const { svc } = setup(t)
  assert.throws(() => svc.record({ kind: 'task_claim' }), (e) => e.code === 'METRICS_BAD_FIELD')
})

test('value 非数字拒绝', (t) => {
  const { svc } = setup(t)
  assert.throws(() => svc.record({ kind: 'task_claim', by: 'x', value: 'abc' }), (e) => e.code === 'METRICS_BAD_FIELD')
})

test('labels 深拷贝（改原对象不影响库内）', (t) => {
  const { svc } = setup(t)
  const labels = { a: 1 }
  svc.record({ kind: 'task_claim', by: 'x', labels })
  labels.a = 999
  const rows = svc.series()
  assert.equal(rows[0].labels.a, 1)
})

test('series 过滤 + 排序', (t) => {
  const { svc } = setup(t)
  svc.record({ kind: 'task_claim', taskId: 't-1', by: 'x', now: 1000 })
  svc.record({ kind: 'task_complete', taskId: 't-1', by: 'x', now: 2000 })
  svc.record({ kind: 'task_claim', taskId: 't-2', by: 'x', now: 3000 })
  const only = svc.series({ kind: 'task_claim' })
  assert.equal(only.length, 2)
  const t1 = svc.series({ taskId: 't-1' })
  assert.equal(t1.length, 2)
  assert.ok(t1[0].at <= t1[1].at)
})

test('aggregate 聚合正确', (t) => {
  const { svc } = setup(t)
  svc.record({ kind: 'task_claim', by: 'x', value: 10, now: 1000 })
  svc.record({ kind: 'task_claim', by: 'x', value: 20, now: 2000 })
  svc.record({ kind: 'task_complete', by: 'x', now: 3000 })
  const agg = svc.aggregate()
  assert.equal(agg.total, 3)
  assert.equal(agg.byKind.task_claim, 2)
  assert.equal(agg.sum, 30)
  assert.equal(agg.firstAt, 1000)
  assert.equal(agg.lastAt, 3000)
})

test('replay 从 jsonl 重建（重启后仍在）', (t) => {
  const { dir, svc } = setup(t)
  svc.record({ kind: 'task_claim', by: 'x' })
  const fresh = createMetrics({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(fresh.stats().total, 1)
  const rep = fresh.replay()
  assert.equal(rep.from, 'jsonl')
})

test('坏行不静默（badLines 计数）', (t) => {
  const { dir, svc } = setup(t)
  
  appendFileSync(join(dir, 'metrics.jsonl'), '{bad json\n')
  svc.record({ kind: 'task_claim', by: 'x' })
  const rep = createMetrics({ logger: { info() {}, warn() {} } }, { stateDir: dir }).replay()
  assert.equal(rep.bad, 1)
})

test('CAS：同 rev 重放幂等', (t) => {
  const { dir, svc } = setup(t)
  svc.record({ kind: 'task_claim', by: 'x' })
  const rows = readEvents(dir)
  const ev = { ...rows[0], action: 'record' }
  
  appendFileSync(join(dir, 'metrics.jsonl'), JSON.stringify(ev) + '\n')
  const fresh = createMetrics({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(fresh.stats().total, 1)
})

test('dispose 后抛 METRICS_DISPOSED', (t) => {
  const { svc } = setup(t)
  svc.dispose()
  assert.throws(() => svc.record({ kind: 'task_claim', by: 'x' }), (e) => e.code === 'METRICS_DISPOSED')
})

test('METRIC_KINDS 冻结不可改', () => {
  assert.ok(METRIC_KINDS.includes('cycle_start'))
  assert.ok(METRIC_KINDS.includes('accept_reject'))
  assert.ok(METRIC_KINDS.includes('turn_end'))
})

// ── bots04 欠账2：board 动作埋点 ───────────────────────────────────────────
// 为什么单独一条：此前 256 条 metrics **全是 turn_end** —— 因为只有 index.js
// 在回合结束自动记，认领/完成/验收这些**真正该测的动作**从没被记过。
// 后果是 PDCA 页面看不到验收通过率、任务认领率。

test('埋点：board 的 claim/complete/accept 会真实写入对应 kind（不是只有 turn_end）', async (t) => {
  const { createBoard } = await import('../src/board.js')
  const dir = mkdtempSync(join(tmpdir(), `cs-bots-inst-${process.pid}-${counter++}-`))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const metrics = createMetrics({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  // 用取值函数传入，模拟 index.js 的真实用法（metrics 晚于 board 装配）
  const board = createBoard({}, { stateDir: dir, leaseMs: 300000, metrics: () => metrics })

  const task = board.create({ byId: 'ui', subject: '埋点验证' })
  board.update({ id: task.id, expectedRev: task.rev, action: 'claim', byId: 'bot-1' })
  let cur = board.get(task.id)
  board.update({
    id: cur.id, expectedRev: cur.rev, action: 'complete', byId: 'bot-1', artifacts: ['x.md'],
  })
  cur = board.get(task.id)
  board.accept({ id: cur.id, expectedRev: cur.rev, by: 'ui', result: 'pass' })

  const byKind = metrics.aggregate({}).byKind
  assert.equal(byKind.task_claim, 1, 'claim 必须记 task_claim')
  assert.equal(byKind.task_complete, 1, 'complete 必须记 task_complete')
  assert.equal(byKind.accept_pass, 1, 'accept(pass) 必须记 accept_pass')
})

test('埋点：accept(reject) 记 accept_reject（与 pass 分开统计）', async (t) => {
  const { createBoard } = await import('../src/board.js')
  const dir = mkdtempSync(join(tmpdir(), `cs-bots-inst2-${process.pid}-${counter++}-`))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const metrics = createMetrics({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const board = createBoard({}, { stateDir: dir, leaseMs: 300000, metrics })

  const task = board.create({ byId: 'ui', subject: '打回验证' })
  board.update({ id: task.id, expectedRev: task.rev, action: 'claim', byId: 'bot-1' })
  let cur = board.get(task.id)
  board.update({
    id: cur.id, expectedRev: cur.rev, action: 'complete', byId: 'bot-1', artifacts: ['x.md'],
  })
  cur = board.get(task.id)
  board.accept({ id: cur.id, expectedRev: cur.rev, by: 'ui', result: 'reject', note: '不合格' })

  const byKind = metrics.aggregate({}).byKind
  assert.equal(byKind.accept_reject, 1, 'accept(reject) 必须记 accept_reject')
  assert.equal(byKind.accept_pass ?? 0, 0, 'pass 与 reject 必须分开')
})

test('埋点：metrics 缺失时业务动作照常成功（指标是旁路，绝不影响主流程）', async (t) => {
  const { createBoard } = await import('../src/board.js')
  const dir = mkdtempSync(join(tmpdir(), `cs-bots-inst3-${process.pid}-${counter++}-`))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  // 故意不传 metrics —— 模拟 metrics 装配失败
  const board = createBoard({}, { stateDir: dir, leaseMs: 300000 })

  const task = board.create({ byId: 'ui', subject: '无指标也要能干活' })
  const claimed = board.update({ id: task.id, expectedRev: task.rev, action: 'claim', byId: 'bot-1' })
  assert.equal(claimed.status, 'in_progress', '没有 metrics 时 claim 仍必须成功')
})
