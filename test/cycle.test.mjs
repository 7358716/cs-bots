/**
 * CycleService 测试 —— PDCA 复盘与标准化（Act）。
 *
 * 重点：阶段流转不许跳步（CYCLE_BAD_PHASE_FLOW）、复盘提议建议的降级。
 * 运行：`node --test test/cycle.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createCycle, { CycleError, CYCLE_PHASES } from '../src/cycle.js'

let counter = 0
function setup(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), `cs-bots-cycle-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const svc = createCycle({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

/** 假 suggest：记录调用，可选地抛错。 */
function fakeSuggest({ fail = false } = {}) {
  const calls = []
  return {
    calls,
    suggest(input) {
      calls.push(input)
      if (fail) throw new Error('suggest boom')
      return { id: `sg-${calls.length}` }
    },
  }
}

function readEvents(dir) {
  const f = join(dir, 'cycle.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('start 创建 + 落盘', (t) => {
  const { dir, svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: '实现登录', by: 'ui' })
  assert.match(c.id, /^c-\d+$/)
  assert.equal(c.phase, 'planned')
  assert.equal(c.status, 'open')
  assert.equal(c.progress, 0)
  assert.equal(readEvents(dir).length, 1)
})

test('advance planned→doing→checking 正常流转', (t) => {
  const { svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  const d = svc.advance({ id: c.id, expectedRev: c.rev, phase: 'doing', progress: 20, by: 'bot' })
  assert.equal(d.phase, 'doing')
  assert.equal(d.progress, 20)
  const ch = svc.advance({ id: c.id, expectedRev: d.rev, phase: 'checking', by: 'bot' })
  assert.equal(ch.phase, 'checking')
})

test('advance 跳步（planned→done）抛 CYCLE_BAD_PHASE_FLOW', (t) => {
  const { svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  assert.throws(
    () => svc.advance({ id: c.id, expectedRev: c.rev, phase: 'done', by: 'bot' }),
    (e) => e instanceof CycleError && e.code === 'CYCLE_BAD_PHASE_FLOW',
  )
})

test('check reject → phase 回 doing', (t) => {
  const { svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  const d = svc.advance({ id: c.id, expectedRev: c.rev, phase: 'doing', by: 'bot' })
  const ch = svc.advance({ id: c.id, expectedRev: d.rev, phase: 'checking', by: 'bot' })
  const rej = svc.check({ id: c.id, expectedRev: ch.rev, result: 'reject', evidence: '测试失败', by: 'lead' })
  assert.equal(rej.phase, 'doing')
  assert.equal(rej.rejectCount, 1)
})

test('check pass → phase 到 acting', (t) => {
  const { svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  const d = svc.advance({ id: c.id, expectedRev: c.rev, phase: 'doing', by: 'bot' })
  const ch = svc.advance({ id: c.id, expectedRev: d.rev, phase: 'checking', by: 'bot' })
  const pass = svc.check({ id: c.id, expectedRev: ch.rev, result: 'pass', by: 'lead' })
  assert.equal(pass.phase, 'acting')
})

test('review 记录 summary/lessons/standards', (t) => {
  const { svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  const d = svc.advance({ id: c.id, expectedRev: c.rev, phase: 'doing', by: 'bot' })
  const ch = svc.advance({ id: c.id, expectedRev: d.rev, phase: 'checking', by: 'bot' })
  const act = svc.check({ id: c.id, expectedRev: ch.rev, result: 'pass', by: 'lead' })
  const r = svc.review({
    id: c.id, expectedRev: act.rev,
    summary: '这个周期学到：先写测试',
    lessons: ['先写测试再写实现'],
    standards: [{ scope: 'workspace', kind: 'rule', title: 'TDD', content: '先写测试' }],
    by: 'lead',
  })
  assert.equal(r.cycle.review.summary, '这个周期学到：先写测试')
  assert.equal(r.cycle.review.lessons.length, 1)
  // 无 suggest → 降级，suggestions 空
  assert.equal(r.suggestions.length, 0)
  assert.equal(r.degraded, true)
})

test('review 提议建议（注入假 suggest，断言调用次数与参数）', (t) => {
  const suggest = fakeSuggest()
  const { svc } = setup(t, { suggest })
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  const d = svc.advance({ id: c.id, expectedRev: c.rev, phase: 'doing', by: 'bot' })
  const ch = svc.advance({ id: c.id, expectedRev: d.rev, phase: 'checking', by: 'bot' })
  const act = svc.check({ id: c.id, expectedRev: ch.rev, result: 'pass', by: 'lead' })
  const r = svc.review({
    id: c.id, expectedRev: act.rev,
    summary: '总结',
    lessons: ['教训一'],
    standards: [{ scope: 'global', kind: 'principle', title: 'S', content: 'C' }],
    by: 'lead',
  })
  assert.equal(r.proposedCount, 2) // 1 纪律 + 1 记忆
  assert.equal(r.suggestions.length, 2)
  assert.equal(suggest.calls.length, 2)
  assert.equal(suggest.calls[0].kind, 'discipline')
  assert.equal(suggest.calls[1].kind, 'memory')
  assert.equal(suggest.calls[1].layer, 'L2')
  assert.equal(suggest.calls[0].source, 'cycle-review')
})

test('review 在非 acting 阶段抛 CYCLE_BAD_PHASE', (t) => {
  const { svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  assert.throws(
    () => svc.review({ id: c.id, expectedRev: c.rev, summary: 'x', by: 'lead' }),
    (e) => e.code === 'CYCLE_BAD_PHASE',
  )
})

test('review 时 suggest 抛错 → 不阻断，diagnostics 计数', (t) => {
  const suggest = fakeSuggest({ fail: true })
  const { svc } = setup(t, { suggest })
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  const d = svc.advance({ id: c.id, expectedRev: c.rev, phase: 'doing', by: 'bot' })
  const ch = svc.advance({ id: c.id, expectedRev: d.rev, phase: 'checking', by: 'bot' })
  const act = svc.check({ id: c.id, expectedRev: ch.rev, result: 'pass', by: 'lead' })
  const r = svc.review({
    id: c.id, expectedRev: act.rev, summary: '总结',
    lessons: ['L1'], standards: [{ scope: 'global', kind: 'rule', title: 'S', content: 'C' }],
    by: 'lead',
  })
  assert.equal(r.cycle.review.summary, '总结') // 复盘已落盘
  assert.equal(r.proposedCount, 0)
  assert.ok(svc.diagnostics().suggestFailures >= 1)
})

test('CAS 冲突抛错', (t) => {
  const { svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  assert.throws(
    () => svc.advance({ id: c.id, expectedRev: 999, phase: 'doing', by: 'bot' }),
    (e) => e.code === 'CYCLE_REV_CONFLICT',
  )
})

test('replay 从 jsonl 重建', (t) => {
  const { dir, svc } = setup(t)
  svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  const fresh = createCycle({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(fresh.stats().total, 1)
  assert.equal(fresh.replay().from, 'jsonl')
})

test('坏行不静默', (t) => {
  const { dir } = setup(t)
  appendFileSync(join(dir, 'cycle.jsonl'), 'broken\n')
  const rep = createCycle({ logger: { info() {}, warn() {} } }, { stateDir: dir }).replay()
  assert.equal(rep.bad, 1)
})

test('dispose 后抛 CYCLE_DISPOSED', (t) => {
  const { svc } = setup(t)
  svc.dispose()
  assert.throws(() => svc.start({ taskId: 't', objective: 'x', by: 'u' }), (e) => e.code === 'CYCLE_DISPOSED')
})

test('done 后 status=closed', (t) => {
  const { svc } = setup(t)
  const c = svc.start({ taskId: 't-1', objective: 'x', by: 'ui' })
  let cur = c
  for (const p of ['doing', 'checking']) {
    cur = svc.advance({ id: cur.id, expectedRev: cur.rev, phase: p, by: 'bot' })
  }
  cur = svc.check({ id: cur.id, expectedRev: cur.rev, result: 'pass', by: 'lead' })
  cur = svc.advance({ id: cur.id, expectedRev: cur.rev, phase: 'done', by: 'lead' })
  assert.equal(cur.status, 'closed')
  assert.ok(cur.closedAt)
  const st = svc.stats()
  assert.equal(st.closed, 1)
})

test('CYCLE_PHASES 五阶段齐全', () => {
  assert.deepEqual([...CYCLE_PHASES], ['planned', 'doing', 'checking', 'acting', 'done'])
})
