/**
 * ReviewerService 测试 —— 审查调度器（回合内自我审查的计数器）。
 *
 * 纪律：每条断言都用**实际落盘产物**或**真实返回值**做证据，
 * 不接受「函数没抛错」这种弱断言。
 * 只碰 `node:test` + `node:assert` + `node:fs` + `node:os` + `node:path`。
 *
 * 覆盖（任务书验收项逐条对应）：
 *   - noteTurn 累加、间隔到期 due=true（含「只在跨阈值那一刻打日志」不影响返回值）
 *   - markReviewed 归零（turnCount 不清零、lastReviewedAt/By 落盘）
 *   - interval 运行时可改（立即生效；值没变不写事件）
 *   - **重启后计数恢复**（同 stateDir 新实例，构造即 hydrate；interval 也恢复）
 *   - 多会话隔离
 *   - reset / CAS / 坏行 / dispose / stats / list / history
 *
 * 运行：`node --test test/reviewer.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createReviewer, {
  ReviewerError,
  DEFAULT_INTERVAL,
  MIN_INTERVAL,
  MAX_INTERVAL,
} from '../src/reviewer.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/** 每个用例一个独立状态目录（互不污染），并注册自动清理。 */
function setup(t, config = {}) {
  const base = process.env.REVIEWER_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-reviewer-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const svc = createReviewer({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

/** 读事件流（唯一真相源）。 */
function events(dir) {
  const file = join(dir, 'reviewer.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 把错误码断言写成可读一行。 */
function throwsCode(fn, code, extra = {}) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ReviewerError, `应抛 ReviewerError，实际 ${error?.name}`)
    assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}：${error.message}`)
    for (const [key, value] of Object.entries(extra)) {
      assert.deepEqual(error.detail?.[key], value, `detail.${key} 不符`)
    }
    return true
  })
}

/** 连续记 N 回合（省去样板），返回最后一回合的 noteTurn 结果。 */
function note(svc, sessionId, n, startedAt = 1_000) {
  let last
  for (let i = 0; i < n; i += 1) last = svc.noteTurn({ sessionId, now: startedAt + i })
  return last
}

// ── 1. 导出面 ───────────────────────────────────────────────────────────────

test('导出：default 是工厂；常量与错误类可用', () => {
  assert.equal(typeof createReviewer, 'function')
  assert.equal(typeof ReviewerError, 'function')
  assert.equal(DEFAULT_INTERVAL, 10)
  assert.equal(MIN_INTERVAL, 1)
  assert.ok(MAX_INTERVAL >= 1000)
})

test('工厂：支持单参数简写 { stateDir }，paths 指向 reviewer.jsonl（无快照）', (t) => {
  const base = process.env.REVIEWER_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-reviewer-single-${process.pid}-${counter++}-`))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const svc = createReviewer({ stateDir: dir })
  assert.equal(svc.paths.stateDir, dir)
  assert.equal(svc.paths.jsonl, join(dir, 'reviewer.jsonl'))
  assert.equal(svc.status().interval, DEFAULT_INTERVAL)
})

test('工厂：interval 配置非法时**构造即抛**（不等到第一次 noteTurn 才炸）', (t) => {
  const base = process.env.REVIEWER_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-reviewer-badint-${process.pid}-${counter++}-`))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  throwsCode(() => createReviewer({}, { stateDir: dir, interval: 0 }), 'REVIEW_BAD_INTERVAL')
  throwsCode(() => createReviewer({}, { stateDir: dir, interval: 1.5 }), 'REVIEW_BAD_INTERVAL')
  throwsCode(() => createReviewer({}, { stateDir: dir, interval: MAX_INTERVAL + 1 }), 'REVIEW_BAD_INTERVAL')
})

// ── 2. 记账与到期 ───────────────────────────────────────────────────────────

test('noteTurn：逐回合累加 turnCount 与 turnsSinceLastReview，interval 前 due=false', (t) => {
  const { svc } = setup(t, { interval: 3 })
  assert.deepEqual(note(svc, 's-1', 1), {
    sessionId: 's-1', turnCount: 1, turnsSinceLastReview: 1, interval: 3, due: false,
  })
  const two = svc.noteTurn({ sessionId: 's-1', now: 2000 })
  assert.equal(two.turnCount, 2)
  assert.equal(two.due, false)
})

test('noteTurn：达到 interval 时 due=true（判据 turnsSinceLastReview >= interval）', (t) => {
  const { svc } = setup(t, { interval: 3 })
  const three = note(svc, 's-1', 3)
  assert.equal(three.turnCount, 3)
  assert.equal(three.turnsSinceLastReview, 3)
  assert.equal(three.due, true, '第 3 回合应到期')

  // 到期后每回合仍 due=true（直到人真的审一次）
  const four = svc.noteTurn({ sessionId: 's-1', now: 9999 })
  assert.equal(four.due, true)
  assert.equal(four.turnsSinceLastReview, 4)
})

test('status：单会话明细字段齐全；未知会话返回零态 + known:false（合法查询，不抛）', (t) => {
  const { svc } = setup(t, { interval: 2 })
  const unknown = svc.status({ sessionId: 's-never' })
  assert.equal(unknown.known, false)
  assert.equal(unknown.turnCount, 0)
  assert.equal(unknown.due, false)
  assert.equal(unknown.interval, 2)
  assert.equal(unknown.lastReviewedAt, null)

  note(svc, 's-1', 2)
  const st = svc.status({ sessionId: 's-1' })
  assert.equal(st.known, true)
  assert.equal(st.turnCount, 2)
  assert.equal(st.turnsSinceLastReview, 2)
  assert.equal(st.due, true)
  assert.equal(st.interval, 2)
  assert.equal(st.rev, 2)
})

test('status：不传 sessionId 返回全局概览（到期会话列表）', (t) => {
  const { svc } = setup(t, { interval: 2 })
  note(svc, 's-a', 2)
  note(svc, 's-b', 1)
  const all = svc.status()
  assert.equal(all.sessions, 2)
  assert.equal(all.due, true)
  assert.deepEqual(all.dueSessions, ['s-a'])
  assert.equal(all.totalTurns, 3)
  assert.equal(all.interval, 2)
})

// ── 3. 审查完成 ─────────────────────────────────────────────────────────────

test('markReviewed：turnsSinceLastReview 归零、turnCount 保留、记录谁在何时审的', (t) => {
  const { dir, svc } = setup(t, { interval: 2 })
  note(svc, 's-1', 5, 1000)
  const out = svc.markReviewed({ sessionId: 's-1', by: 'reviewer-bot', now: 50_000 })
  assert.equal(out.turnCount, 5, 'turnCount 是累计值，不因审查归零')
  assert.equal(out.turnsSinceLastReview, 0)
  assert.equal(out.due, false)
  assert.equal(out.lastReviewedAt, 50_000)
  assert.equal(out.lastReviewedBy, 'reviewer-bot')
  assert.equal(out.reviewedTurns, 5, '应回报本次审掉了多少回合积压')

  const rows = events(dir)
  const last = rows[rows.length - 1]
  assert.equal(last.type, 'review')
  assert.equal(last.by, 'reviewer-bot')
  assert.equal(last.after.turnsSinceLastReview, 0)
  assert.equal(last.before.turnsSinceLastReview, 5, 'before 里必须留有「审前积压」证据')

  // 归零后重新从 0 累计
  const next = svc.noteTurn({ sessionId: 's-1', now: 60_000 })
  assert.equal(next.turnCount, 6)
  assert.equal(next.turnsSinceLastReview, 1)
  assert.equal(next.due, false)
})

test('markReviewed：从未计数过的会话也可以记「已审查」（不逼上层先 noteTurn 垫一次）', (t) => {
  const { svc } = setup(t, { interval: 2 })
  const out = svc.markReviewed({ sessionId: 's-new', by: 'user' })
  assert.equal(out.known, true)
  assert.equal(out.turnCount, 0)
  assert.equal(out.turnsSinceLastReview, 0)
  assert.equal(out.reviewedTurns, 0)
})

test('markReviewed：expectedRev CAS 不匹配抛 REVIEW_CAS_CONFLICT', (t) => {
  const { svc } = setup(t, { interval: 2 })
  note(svc, 's-1', 2)
  throwsCode(() => svc.markReviewed({ sessionId: 's-1', by: 'user', expectedRev: 99 }), 'REVIEW_CAS_CONFLICT', { sessionId: 's-1', expectedRev: 99, rev: 2 })
  const ok = svc.markReviewed({ sessionId: 's-1', by: 'user', expectedRev: 2 })
  assert.equal(ok.turnsSinceLastReview, 0)
})

// ── 4. interval 运行时修改 ───────────────────────────────────────────────────

test('setInterval：运行时改间隔**立即生效**（下一次 due 就按新阈值算）', (t) => {
  const { svc } = setup(t, { interval: 10 })
  const out = svc.setInterval({ interval: 2, by: 'user', now: 12_000 })
  assert.equal(out.changed, true)
  assert.equal(out.interval, 2)
  assert.equal(out.updatedAt, 12_000)
  assert.equal(svc.status().interval, 2)

  note(svc, 's-1', 2)
  assert.equal(svc.status({ sessionId: 's-1' }).due, true, '改小后已积累的回合直接到期')

  // 调大后同样立即生效（未达到新阈值 → 不再 due）
  svc.setInterval({ interval: 100, by: 'user' })
  assert.equal(svc.status({ sessionId: 's-1' }).due, false)
})

test('setInterval：值没变则不写事件（幂等），但明确回报 changed:false', (t) => {
  const { dir, svc } = setup(t, { interval: 10 })
  const before = events(dir).length
  const out = svc.setInterval({ interval: 10, by: 'user' })
  assert.equal(out.changed, false)
  assert.equal(out.interval, 10)
  assert.equal(events(dir).length, before, '幂等保存不得堆噪音事件')
})

test('setInterval：非法值（0/小数/字符串/超上限）一律拒', (t) => {
  const { svc } = setup(t)
  throwsCode(() => svc.setInterval({ interval: 0 }), 'REVIEW_BAD_INTERVAL')
  throwsCode(() => svc.setInterval({ interval: 2.5 }), 'REVIEW_BAD_INTERVAL')
  throwsCode(() => svc.setInterval({ interval: '5' }), 'REVIEW_BAD_INTERVAL')
  throwsCode(() => svc.setInterval({ interval: MAX_INTERVAL + 1 }), 'REVIEW_BAD_INTERVAL')
  assert.equal(svc.status().interval, DEFAULT_INTERVAL, '被拒的修改不得生效')
})

// ── 5. 重启后计数恢复（本模块存在的意义）─────────────────────────────────────

test('重启：同 stateDir 新实例构造即恢复 turnCount / turnsSinceLastReview / due', (t) => {
  const { dir, svc } = setup(t, { interval: 3 })
  note(svc, 's-1', 2, 1000)
  note(svc, 's-2', 1, 2000)
  assert.equal(svc.status({ sessionId: 's-1' }).turnsSinceLastReview, 2)

  // 模拟进程重启：同一状态目录重建实例（构造函数里 hydrate）
  const restarted = createReviewer({ logger: { info() {}, warn() {} } }, { stateDir: dir, interval: 3 })
  const st = restarted.status({ sessionId: 's-1' })
  assert.equal(st.turnCount, 2, 'turnCount 不能重启归零')
  assert.equal(st.turnsSinceLastReview, 2, '距上次审查的回合数不能丢（否则审查永远不到期）')
  assert.equal(st.due, false)

  // 再记 1 回合即到期 —— 证明「跨重启累计」是连续的
  const third = restarted.noteTurn({ sessionId: 's-1', now: 3000 })
  assert.equal(third.turnCount, 3)
  assert.equal(third.due, true)
})

test('重启：lastReviewedAt 与 setInterval 改过的 interval 都要恢复', (t) => {
  const { dir, svc } = setup(t, { interval: 10 })
  note(svc, 's-1', 4, 1000)
  svc.markReviewed({ sessionId: 's-1', by: 'reviewer-bot', now: 77_777 })
  svc.setInterval({ interval: 2, by: 'user', now: 88_888 })

  const restarted = createReviewer({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const st = restarted.status({ sessionId: 's-1' })
  assert.equal(st.interval, 2, '用户在 UI 里改过的间隔必须跨重启保持')
  assert.equal(st.lastReviewedAt, 77_777)
  assert.equal(st.lastReviewedBy, 'reviewer-bot')
  assert.equal(st.turnsSinceLastReview, 0)
  assert.equal(st.turnCount, 4)
  assert.equal(restarted.status().configUpdatedBy, 'user')
})

test('replay：返回恢复来源与计数；空目录为 empty', (t) => {
  const { dir, svc } = setup(t)
  const empty = svc.replay()
  assert.equal(empty.from, 'empty')
  assert.equal(empty.sessions, 0)

  note(svc, 's-1', 2)
  const again = svc.replay()
  assert.equal(again.from, 'jsonl')
  assert.equal(again.sessions, 1)
  assert.equal(again.events, 2)
  assert.equal(again.bad, 0)
})

test('replay：坏行不静默丢弃 —— badLines 计数且有效事件仍恢复', (t) => {
  const { dir, svc } = setup(t, { interval: 5 })
  note(svc, 's-1', 3)
  appendFileSync(join(dir, 'reviewer.jsonl'), '{"type":"turn","sessionId":"s-1","rev":4,"at":')

  const restarted = createReviewer({ logger: { info() {}, warn() {} } }, { stateDir: dir, interval: 5 })
  const rep = restarted.replay()
  assert.equal(rep.bad, 1)
  assert.equal(rep.sessions, 1)
  assert.equal(restarted.status({ sessionId: 's-1' }).turnCount, 3)
})

// ── 6. 多会话隔离 ───────────────────────────────────────────────────────────

test('多会话：独立计数、互不影响（审 A 不清 B 的积压）', (t) => {
  const { svc } = setup(t, { interval: 3 })
  note(svc, 's-a', 3, 1000)
  note(svc, 's-b', 1, 1000)
  assert.equal(svc.status({ sessionId: 's-a' }).due, true)
  assert.equal(svc.status({ sessionId: 's-b' }).due, false)

  svc.markReviewed({ sessionId: 's-a', by: 'user', now: 5000 })
  assert.equal(svc.status({ sessionId: 's-a' }).due, false)
  assert.equal(svc.status({ sessionId: 's-a' }).turnCount, 3)
  assert.equal(svc.status({ sessionId: 's-b' }).turnsSinceLastReview, 1, 'B 的积压不能被 A 的审查清掉')

  const stats = svc.stats()
  assert.equal(stats.sessions, 2)
  assert.equal(stats.totalTurns, 4)
  assert.equal(stats.dueSessions, 0)
})

test('list：按 updatedAt 降序（最近动过的会话在前），字段与 status 同构', (t) => {
  const { svc } = setup(t, { interval: 3 })
  note(svc, 's-old', 1, 1000)
  note(svc, 's-new', 1, 9000)
  const rows = svc.list()
  assert.deepEqual(rows.map((r) => r.sessionId), ['s-new', 's-old'])
  assert.equal(rows[0].turnCount, 1)
  assert.equal(rows[0].interval, 3)
  assert.equal(rows[0].due, false)
})

// ── 7. 重置 ─────────────────────────────────────────────────────────────────

test('reset：清掉该会话计数并落盘（重启后不会带着旧计数回来）', (t) => {
  const { dir, svc } = setup(t, { interval: 3 })
  note(svc, 's-1', 3, 1000)
  const out = svc.reset({ sessionId: 's-1', by: 'user', now: 20_000 })
  assert.equal(out.reset, true)
  assert.equal(out.cleared.turnCount, 3, '被清掉的旧值要随返回值回报（不静默丢）')
  assert.equal(svc.status({ sessionId: 's-1' }).known, false)
  assert.equal(events(dir).pop().type, 'reset')

  const restarted = createReviewer({ logger: { info() {}, warn() {} } }, { stateDir: dir, interval: 3 })
  assert.equal(restarted.status({ sessionId: 's-1' }).known, false, 'reset 必须能跨重启生效')
})

test('reset：未知会话抛 REVIEW_SESSION_NOT_FOUND（不静默成功）；CAS 不匹配抛错', (t) => {
  const { svc } = setup(t)
  throwsCode(() => svc.reset({ sessionId: 's-ghost' }), 'REVIEW_SESSION_NOT_FOUND', { sessionId: 's-ghost' })
  note(svc, 's-1', 2)
  throwsCode(() => svc.reset({ sessionId: 's-1', expectedRev: 99 }), 'REVIEW_CAS_CONFLICT')
  assert.equal(svc.status({ sessionId: 's-1' }).turnCount, 2)
})

// ── 8. 校验 / 审计 / 生命周期 ───────────────────────────────────────────────

test('noteTurn：sessionId/now 校验（空值、超长、非数字时间戳都拒）', (t) => {
  const { svc } = setup(t)
  throwsCode(() => svc.noteTurn({}), 'REVIEW_BAD_SESSION')
  throwsCode(() => svc.noteTurn({ sessionId: '   ' }), 'REVIEW_BAD_SESSION')
  throwsCode(() => svc.noteTurn({ sessionId: 's'.repeat(201) }), 'REVIEW_BAD_SESSION')
  throwsCode(() => svc.noteTurn({ sessionId: 's-1', now: '2026-11-04' }), 'REVIEW_BAD_FIELD', { field: 'now' })
  assert.equal(svc.stats().sessions, 0, '被拒的调用不得创建会话状态')
})

test('history：可按 sessionId 过滤；config 事件也留在审计流里', (t) => {
  const { svc } = setup(t, { interval: 3 })
  note(svc, 's-a', 2, 1000)
  note(svc, 's-b', 1, 2000)
  svc.markReviewed({ sessionId: 's-a', by: 'user', now: 3000 })
  svc.setInterval({ interval: 5, by: 'user', now: 4000 })

  const rowsA = svc.history('s-a')
  assert.deepEqual(rowsA.map((e) => e.type), ['turn', 'turn', 'review'])
  assert.equal(svc.history('s-b').length, 1)
  assert.equal(svc.history().length, 5, '全部事件含 config 一条')
  assert.equal(svc.history().filter((e) => e.type === 'config').length, 1)
})

test('stats：会话数/总回合/到期数/间隔/事件数', (t) => {
  const { svc } = setup(t, { interval: 3 })
  note(svc, 's-a', 3, 1000)
  note(svc, 's-b', 1, 2000)
  const st = svc.stats()
  assert.deepEqual(st, { sessions: 2, dueSessions: 1, totalTurns: 4, interval: 3, events: 4 })
})

test('dispose：清空并拒绝后续调用（不静默返回零态让人误以为重启丢计数）', (t) => {
  const { svc } = setup(t)
  note(svc, 's-1', 1)
  const out = svc.dispose()
  assert.equal(out.disposed, true)
  assert.equal(out.sessions, 1)
  throwsCode(() => svc.noteTurn({ sessionId: 's-1' }), 'REVIEW_DISPOSED')
  throwsCode(() => svc.status({ sessionId: 's-1' }), 'REVIEW_DISPOSED')
  throwsCode(() => svc.stats(), 'REVIEW_DISPOSED')
})

test('边界：同一毫秒多回合也不合并（事件逐条落盘，计数按回合而非时间）', (t) => {
  const { dir, svc } = setup(t, { interval: 100 })
  const last = note(svc, 's-1', 5, 42)
  assert.equal(last.turnCount, 5, '时间相同不能把 5 个回合压成 1 个')
  assert.equal(events(dir).length, 5)
})
