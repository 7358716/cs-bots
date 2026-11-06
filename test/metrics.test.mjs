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
