/**
 * cs-bots MemoryService · **任务笔记（L4 taskId/phase）**测试 —— 对齐 `docs/长期记忆方案-v1.md` §2。
 *
 * 为什么必须机械化守住：
 *   任务笔记是跨会话交接的真相源：worker 接手任务时靠 `notesForTask(taskId)` 恢复上下文，
 *   不依赖旧会话消息。这个能力一旦退化，**不会报错**、只会让 Bot 在空上下文里重蹈覆辙。
 *
 * 覆盖：
 *   1. add 支持 taskId/phase → 条目落盘带 taskId/phase（读回来仍在，不重演 split 标记老坑）
 *   2. notesForTask 返回该任务全部 L4 笔记（倒序，最新在前）
 *   3. notesForTask 不串到其他任务 / 非 L4 层
 *   4. notesForTask 的 cwd 过滤（跨项目隔离）
 *   5. replay 后笔记仍在（事件流为真相源）
 *   6. add 不带 taskId → 条目没有 taskId 字段（向后兼容）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemory } from '../src/memory.js'

/** 造隔离状态目录 + 记忆实例。 */
function harness(config = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-mem-task-'))
  const mem = createMemory({}, { stateDir, ...config })
  return {
    mem,
    stateDir,
    cleanup() {
      mem.dispose?.()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

test('add 支持 taskId/phase：条目落盘带 taskId/phase，读回来仍在', async (t) => {
  const { mem, cleanup } = harness()
  t.after(cleanup)
  const e = mem.add({
    layer: 'L4', content: '第一步：搭骨架', by: 'worker-1',
    taskId: 't-100', phase: 'plan',
  })
  assert.equal(e.taskId, 't-100')
  assert.equal(e.phase, 'plan')
  // 读回来（重放后）字段仍在——不重演 split 标记「只挂返回克隆」的老坑
  const got = mem.get({ layer: 'L4', id: e.id })
  assert.equal(got.taskId, 't-100')
  assert.equal(got.phase, 'plan')
})

test('notesForTask 返回该任务全部 L4 笔记，倒序（最新在前）', async (t) => {
  const { mem, cleanup } = harness()
  t.after(cleanup)
  mem.add({ layer: 'L4', content: '计划', by: 'worker-1', taskId: 't-200', phase: 'plan' })
  mem.add({ layer: 'L4', content: '做完了第一步', by: 'worker-1', taskId: 't-200', phase: 'doing' })
  mem.add({ layer: 'L4', content: '阻塞：依赖第三方', by: 'worker-1', taskId: 't-200', phase: 'block' })
  const notes = mem.notesForTask({ taskId: 't-200' })
  assert.equal(notes.length, 3)
  // 倒序：block（最新）在最前
  assert.equal(notes[0].content, '阻塞：依赖第三方')
  assert.equal(notes[2].content, '计划')
})

test('notesForTask 不串到其他任务 / 非 L4 层', async (t) => {
  const { mem, cleanup } = harness()
  t.after(cleanup)
  mem.add({ layer: 'L4', content: '本任务笔记', by: 'w', taskId: 't-A', phase: 'plan' })
  mem.add({ layer: 'L4', content: '别的任务笔记', by: 'w', taskId: 't-B', phase: 'plan' })
  mem.add({ layer: 'L3', content: 'L3 项目记忆', by: 'w', taskId: 't-A', phase: 'plan' })
  const notes = mem.notesForTask({ taskId: 't-A' })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].content, '本任务笔记')
})

test('notesForTask 的 cwd 过滤（跨项目隔离）', async (t) => {
  const { mem, cleanup } = harness()
  t.after(cleanup)
  mem.add({ layer: 'L4', content: '项目甲笔记', by: 'w', taskId: 't-C', phase: 'plan', cwd: '/proj/a' })
  mem.add({ layer: 'L4', content: '项目乙笔记', by: 'w', taskId: 't-C', phase: 'plan', cwd: '/proj/b' })
  const onlyA = mem.notesForTask({ taskId: 't-C', cwd: '/proj/a' })
  assert.equal(onlyA.length, 1)
  assert.equal(onlyA[0].content, '项目甲笔记')
  const all = mem.notesForTask({ taskId: 't-C', cwd: '*' })
  assert.equal(all.length, 2)
})

test('replay 后笔记仍在（事件流为真相源）', async (t) => {
  const { mem, stateDir, cleanup } = harness()
  t.after(cleanup)
  mem.add({ layer: 'L4', content: '落盘的笔记', by: 'w', taskId: 't-D', phase: 'done' })
  mem.dispose?.()
  // 重建实例（触发 replay）
  const mem2 = createMemory({}, { stateDir })
  t.after(() => mem2.dispose?.())
  const notes = mem2.notesForTask({ taskId: 't-D' })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].content, '落盘的笔记')
  assert.equal(notes[0].phase, 'done')
})

test('add 不带 taskId：条目没有 taskId 字段（向后兼容）', async (t) => {
  const { mem, cleanup } = harness()
  t.after(cleanup)
  const e = mem.add({ layer: 'L4', content: '普通 L4 笔记', by: 'w' })
  assert.ok(!('taskId' in e))
  const notes = mem.notesForTask({ taskId: e.id })
  assert.equal(notes.length, 0)
})

test('notesForTask 缺 taskId 抛可读错误', async (t) => {
  const { mem, cleanup } = harness()
  t.after(cleanup)
  assert.throws(() => mem.notesForTask({}), /taskId/)
})
