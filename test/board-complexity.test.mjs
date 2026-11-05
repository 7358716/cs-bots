/**
 * 任务板复杂度路由标签测试（契约 §6 末段）。
 *
 * 守的是三件事：
 *   1. **透传**：`expectedComplexity` / `requiresPaid` 在 create / edit / claim / set
 *      四条路径上都真的落到 Task 上，并且**落盘**（事件流 + 快照），回放后还在；
 *   2. **校验**：非法档位/非布尔一律给**可读错误码**（BOARD_BAD_COMPLEXITY / BOARD_BAD_FIELD），
 *      且**不写事件**（脏数据进不了审计流）；
 *   3. **缺省安全**：不标注 `requiresPaid` 就是「未标注」，绝不悄悄变 true（付费 fail-closed）。
 *
 * 运行：`node --test test/board-complexity.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBoard, BoardError } from '../src/board.js'

// ── 夹具（与 board.test.mjs 同口径：每例独立状态目录，读真实落盘产物）──────────

let counter = 0

function setup(t, config = {}) {
  const base = process.env.BOARD_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-board-cx-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const board = createBoard({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, board }
}

function events(dir) {
  const file = join(dir, 'board.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

function snapshotTasks(dir) {
  const file = join(dir, 'board.snap.json')
  if (!existsSync(file)) return []
  return JSON.parse(readFileSync(file, 'utf8')).tasks ?? []
}

// ── 1. create 透传 + 落盘 ─────────────────────────────────────────────────────

test('create：expectedComplexity 归一为大写档位、requiresPaid 原样保留，并落进事件流与快照', (t) => {
  const { dir, board } = setup(t)
  const task = board.create({
    subject: '架构级改造',
    byId: 'lead',
    expectedComplexity: 't2',
    requiresPaid: true,
  })
  assert.equal(task.expectedComplexity, 'T2', '小写输入归一为大写档位')
  assert.equal(task.requiresPaid, true)

  const rows = events(dir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].after.expectedComplexity, 'T2', '事件流（真相源）必须带路由标签')
  assert.equal(rows[0].after.requiresPaid, true)

  const snap = snapshotTasks(dir)
  assert.equal(snap[0].expectedComplexity, 'T2')
  assert.equal(snap[0].requiresPaid, true)
})

test('create：不标注 ⇒ 字段**不存在**（不是 false/undefined 混杂），付费诉求默认 fail-closed', (t) => {
  const { dir, board } = setup(t)
  const task = board.create({ subject: '未标注', byId: 'lead' })
  assert.equal('expectedComplexity' in task, false)
  assert.equal('requiresPaid' in task, false)
  // requiresPaid !== true 就是「不授权付费」—— 消费方按 === true 判定
  assert.notEqual(task.requiresPaid, true)
  assert.equal(events(dir)[0].after.requiresPaid, undefined, 'JSON 落盘后不得出现 requiresPaid')
})

test('create：四档 T0–T3 全部可写（表驱动，含大小写与空白）', (t) => {
  const { board } = setup(t)
  for (const [input, expected] of [
    ['T0', 'T0'], ['T1', 'T1'], ['T2', 'T2'], ['T3', 'T3'],
    ['t0', 'T0'], [' t3 ', 'T3'],
  ]) {
    const task = board.create({ subject: `档位 ${input}`, byId: 'lead', expectedComplexity: input })
    assert.equal(task.expectedComplexity, expected, `输入 ${JSON.stringify(input)} 应为 ${expected}`)
  }
})

// ── 2. 非法值：可读错误码 + 不写事件 ─────────────────────────────────────────

test('create：非法 expectedComplexity（T9/空串/数字/数组）⇒ BOARD_BAD_COMPLEXITY，且不产生任何事件', (t) => {
  const { dir, board } = setup(t)
  for (const bad of ['T9', '', 'T', 3, true, ['T1'], {}]) {
    let caught
    try {
      board.create({ subject: 'x', byId: 'lead', expectedComplexity: bad })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof BoardError, `输入 ${JSON.stringify(bad)} 应抛 BoardError`)
    assert.equal(caught.code, 'BOARD_BAD_COMPLEXITY')
    assert.match(caught.message, /expectedComplexity/)
    assert.match(caught.message, /T0 \| T1 \| T2 \| T3/, '错误里要给出合法值，别让调用方猜')
  }
  assert.equal(events(dir).length, 0, '校验失败绝不能留半条事件')
})

test('create：requiresPaid 非布尔（"true"/1/null 以外的脏值）⇒ BOARD_BAD_FIELD（不做字符串强转）', (t) => {
  const { dir, board } = setup(t)
  for (const bad of ['true', 1, 0, 'yes', {}, []]) {
    let caught
    try {
      board.create({ subject: 'x', byId: 'lead', requiresPaid: bad })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof BoardError, `输入 ${JSON.stringify(bad)} 应抛 BoardError`)
    assert.equal(caught.code, 'BOARD_BAD_FIELD')
    assert.match(caught.message, /requiresPaid/)
  }
  assert.equal(events(dir).length, 0)
  // false 与 null 都是合法的「不授权」写法
  assert.equal(board.create({ subject: 'a', byId: 'lead', requiresPaid: false }).requiresPaid, false)
  assert.equal('requiresPaid' in board.create({ subject: 'b', byId: 'lead', requiresPaid: null }), false)
})

// ── 3. edit / claim / set 透传 ───────────────────────────────────────────────

test('edit：补标与改标 expectedComplexity/requiresPaid；传 null 清除标注', (t) => {
  const { board } = setup(t)
  const task = board.create({ subject: 'S', byId: 'lead', expectedComplexity: 'T1' })
  assert.equal(task.requiresPaid, undefined)

  const edited = board.update({
    id: task.id,
    expectedRev: 1,
    action: 'edit',
    byId: 'lead',
    expectedComplexity: 'T3',
    requiresPaid: true,
  })
  assert.equal(edited.expectedComplexity, 'T3')
  assert.equal(edited.requiresPaid, true)
  assert.equal(edited.rev, 2)

  const cleared = board.update({
    id: task.id,
    expectedRev: 2,
    action: 'edit',
    byId: 'lead',
    expectedComplexity: null,
    requiresPaid: null,
  })
  assert.equal('expectedComplexity' in cleared, false, 'null = 清除标注')
  assert.equal('requiresPaid' in cleared, false)
  assert.equal(cleared.rev, 3)
})

test('edit：只给 expectedComplexity 也算有效补丁（不会被判「未提供任何可改字段」）', (t) => {
  const { board } = setup(t)
  const task = board.create({ subject: 'S', byId: 'lead' })
  const edited = board.update({
    id: task.id, expectedRev: 1, action: 'edit', byId: 'lead', expectedComplexity: 'T2',
  })
  assert.equal(edited.expectedComplexity, 'T2')
})

test('claim：领活时可补/改路由标注，并原样持久化（子智能体接管任务的真实路径）', (t) => {
  const { dir, board } = setup(t)
  const task = board.create({ subject: 'S', byId: 'lead' })

  const claimed = board.update({
    id: task.id,
    expectedRev: 1,
    action: 'claim',
    byId: 'bot-sub',
    expectedComplexity: 'T3',
    requiresPaid: true,
  })
  assert.equal(claimed.status, 'in_progress')
  assert.equal(claimed.ownerId, 'bot-sub')
  assert.equal(claimed.expectedComplexity, 'T3')
  assert.equal(claimed.requiresPaid, true)

  const rows = events(dir)
  assert.equal(rows.at(-1).action, 'claim')
  assert.equal(rows.at(-1).after.expectedComplexity, 'T3', 'claim 事件里必须带标注（审计可追溯）')
})

test('claim：不带标注时不得把已有标注抹掉（心跳式 claim 不破坏规划信息）', (t) => {
  const { board } = setup(t)
  const task = board.create({ subject: 'S', byId: 'lead', expectedComplexity: 'T2', requiresPaid: true })
  const claimed = board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: 'bot-a' })
  assert.equal(claimed.expectedComplexity, 'T2')
  assert.equal(claimed.requiresPaid, true)
})

test('claim：非法标注同样在 claim 路径上被拒（不能绕过校验）', (t) => {
  const { dir, board } = setup(t)
  const task = board.create({ subject: 'S', byId: 'lead' })
  assert.throws(
    () => board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: 'bot', expectedComplexity: 'T9' }),
    (e) => e instanceof BoardError && e.code === 'BOARD_BAD_COMPLEXITY',
  )
  assert.equal(events(dir).length, 1, '只有 create 那条事件，claim 被拒后不得写入')
  assert.equal(board.get(task.id).status, 'pending', '被拒的 claim 不得改动状态')
})

test('set：expectedComplexity / requiresPaid 也走同一套校验（不是裸赋值）', (t) => {
  const { board } = setup(t)
  const task = board.create({ subject: 'S', byId: 'lead' })

  const set = board.update({
    id: task.id, expectedRev: 1, action: 'set', byId: 'lead',
    expectedComplexity: 't2', requiresPaid: false,
  })
  assert.equal(set.expectedComplexity, 'T2')
  assert.equal(set.requiresPaid, false)

  assert.throws(
    () => board.update({ id: task.id, expectedRev: 2, action: 'set', byId: 'lead', expectedComplexity: 'X' }),
    (e) => e instanceof BoardError && e.code === 'BOARD_BAD_COMPLEXITY',
  )

  const cleared = board.update({ id: task.id, expectedRev: 2, action: 'set', byId: 'lead', expectedComplexity: null })
  assert.equal('expectedComplexity' in cleared, false)
  assert.equal(cleared.requiresPaid, false, '清一个字段不应影响另一个')
})

// ── 4. 生命周期不丢标注 ──────────────────────────────────────────────────────

test('block/unblock/complete/reopen 之后标注仍在（规划信息属于任务，不属于状态）', (t) => {
  const { board } = setup(t)
  const task = board.create({ subject: 'S', byId: 'lead', expectedComplexity: 'T2', requiresPaid: true })

  const claimed = board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: 'bot' })
  const blocked = board.update({ id: task.id, expectedRev: claimed.rev, action: 'block', byId: 'bot', reason: '等接口' })
  assert.equal(blocked.expectedComplexity, 'T2')
  const unblocked = board.update({ id: task.id, expectedRev: blocked.rev, action: 'unblock', byId: 'bot' })
  assert.equal(unblocked.expectedComplexity, 'T2')
  assert.equal(unblocked.requiresPaid, true)

  const done = board.update({ id: task.id, expectedRev: unblocked.rev, action: 'complete', byId: 'bot', artifacts: ['out.js'] })
  assert.equal(done.expectedComplexity, 'T2')
  const reopened = board.update({ id: task.id, expectedRev: done.rev, action: 'reopen', byId: 'bot' })
  assert.equal(reopened.expectedComplexity, 'T2', 'reopen 不应抹掉路由标注')
  assert.equal(reopened.requiresPaid, true)
})

// ── 5. 回放一致性（重启后路由仍可追溯）────────────────────────────────────────

test('replay：从事件流重建后 expectedComplexity/requiresPaid 完全一致', (t) => {
  const { dir, board } = setup(t)
  const a = board.create({ subject: 'A', byId: 'lead', expectedComplexity: 'T1' })
  const b = board.create({ subject: 'B', byId: 'lead', expectedComplexity: 'T3', requiresPaid: true })
  board.update({ id: a.id, expectedRev: 1, action: 'edit', byId: 'lead', expectedComplexity: 'T2' })

  const result = board.replay()
  assert.equal(result.from, 'jsonl')
  assert.equal(board.get(a.id).expectedComplexity, 'T2')
  assert.equal(board.get(b.id).expectedComplexity, 'T3')
  assert.equal(board.get(b.id).requiresPaid, true)

  // 换一个实例读同一目录（真重启语义）
  const reopened = createBoard({}, { stateDir: dir })
  assert.equal(reopened.get(b.id).expectedComplexity, 'T3')
  assert.equal(reopened.get(b.id).requiresPaid, true)
})
