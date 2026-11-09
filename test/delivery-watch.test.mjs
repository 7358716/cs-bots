/**
 * 投递回执看护（2026-11-09 · 补 superagent 的 inputsRead 那一层）。
 *
 * ## 现场
 *   wake 记 `sent`、会话 `turns: 0 / steps: 0`、事件文件还停在几天前，
 *   任务卡在「进行中」，页面看不到任何异常。**投递成功 ≠ 真的在跑。**
 *
 * ## 本模块的判据（两条任一算兑现）
 *   - 最新事件 seq 增长
 *   - `user/message` 条数增长
 *   超期没涨 ⇒ 写 `task.delivery.error` ⇒ `stage.js` 派 `person/delivery` 显形。
 *
 * ## 最重要的不变量：**宁可漏判，不可误报**
 *   读不到水位（宿主没有持久化层）时**不写失败**——误报会训练人忽略提示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDeliveryWatch, DEFAULT_GRACE_MS } from '../src/delivery-watch.js'

/** 手动时钟 + 立即执行定时器（确定性测试，不依赖真实时间）。 */
function harness({ watermark, markFailure } = {}) {
  let clock = 1_000_000
  const timers = []
  const marked = []
  const logs = []
  const w = createDeliveryWatch({}, {
    watermark: watermark ?? (async () => ({ ok: true, seq: -1, userMessages: 0 })),
    markFailure: markFailure ?? (async (taskId, reason) => { marked.push([taskId, reason]); return true }),
    logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
    options: {
      now: () => clock,
      schedule: (fn) => { timers.push(fn); return fn },
      cancel: () => {},
    },
  })
  return {
    w, marked, logs,
    advance: (ms) => { clock += ms },
    tick: async () => {
      const fns = timers.splice(0)
      for (const fn of fns) await fn()
    },
  }
}

test('D1 水位涨了 ⇒ 兑现，不写失败', async () => {
  let seq = 3
  const h = harness({ watermark: async () => ({ ok: true, seq, userMessages: 1 }) })
  h.w.expect({ taskId: 't-1', sessionId: 'bot-a', baselineSeq: 3, baselineUserMessages: 0 })
  seq = 5
  h.advance(DEFAULT_GRACE_MS + 1000)
  const out = await h.w.sweep()
  assert.equal(out.fulfilled, 1)
  assert.equal(h.marked.length, 0, '涨了就不该写失败')
})

test('D2 宽限期内没动静 ⇒ 先不动，不误报', async () => {
  const h = harness({ watermark: async () => ({ ok: true, seq: 3, userMessages: 0 }) })
  h.w.expect({ taskId: 't-2', sessionId: 'bot-b', baselineSeq: 3 })
  h.advance(10_000) // 远小于 90s
  const out = await h.w.sweep()
  assert.equal(out.unfulfilled, 0, '宽限期内绝不能判死')
  assert.equal(h.w.stats().pending, 1, '仍在跟踪')
})

test('D3 超过宽限仍无新事件 ⇒ 写 delivery，原因说清「已投递但未开始动作」', async () => {
  const h = harness({ watermark: async () => ({ ok: true, seq: 3, userMessages: 0 }) })
  h.w.expect({ taskId: 't-3', sessionId: 'bot-c', baselineSeq: 3 })
  h.advance(DEFAULT_GRACE_MS + 1000)
  const out = await h.w.sweep()
  assert.equal(out.unfulfilled, 1)
  assert.equal(h.marked.length, 1)
  assert.equal(h.marked[0][0], 't-3')
  assert.match(h.marked[0][1], /已投递但执行者未开始动作/, '必须是人能看懂并知道下一步的话')
  assert.match(h.marked[0][1], /重试唤醒/, '要给出下一步动作')
})

test('D4 只有 user/message 增长也算兑现（seq 不动也可能是外部写入）', async () => {
  const h = harness({ watermark: async () => ({ ok: true, seq: 3, userMessages: 2 }) })
  h.w.expect({ taskId: 't-4', sessionId: 'bot-d', baselineSeq: 3, baselineUserMessages: 0 })
  h.advance(DEFAULT_GRACE_MS + 1000)
  const out = await h.w.sweep()
  assert.equal(out.fulfilled, 1, 'user/message 增长 = 这条输入被吸进历史')
})

test('D5 读不到水位 ⇒ 到点放弃跟踪但**不写失败**（宁可漏判不可误报）', async () => {
  const h = harness({ watermark: async () => ({ ok: false, available: false, reason: 'sessionPersistence 不可用' }) })
  h.w.expect({ taskId: 't-5', sessionId: 'bot-e' })
  h.advance(DEFAULT_GRACE_MS + 1000)
  const out = await h.w.sweep()
  assert.equal(out.undecidable, 1)
  assert.equal(h.marked.length, 0, '读不到就不能判死')
  assert.equal(h.w.stats().pending, 0, '到点就停止跟踪，别占着内存')
})

test('D6 同一任务重复登记 ⇒ 只保留最新一条（新唤醒重置宽限期）', async () => {
  const h = harness()
  h.w.expect({ taskId: 't-6', sessionId: 'bot-f', baselineSeq: 1 })
  h.w.expect({ taskId: 't-6', sessionId: 'bot-f', baselineSeq: 9 })
  assert.equal(h.w.stats().pending, 1)
  assert.equal(h.w.list()[0].baselineSeq, 9, '基线要是最新那次投递的')
})

test('D7 cancelByTask：人点重试时清掉旧期望，避免拿旧基线误判', async () => {
  const h = harness()
  h.w.expect({ taskId: 't-7', sessionId: 'bot-g' })
  assert.equal(h.w.cancelByTask('t-7'), 1)
  assert.equal(h.w.stats().pending, 0)
})

test('D8 dispose 后不再巡检（插件卸载不得留幽灵定时器）', async () => {
  const h = harness()
  h.w.expect({ taskId: 't-8', sessionId: 'bot-h' })
  h.w.dispose()
  const out = await h.w.sweep()
  assert.equal(out.checked, 0)
  assert.equal(h.w.stats().pending, 0)
})

test('D9 写失败本身不抛（看护绝不能把主流程带崩）', async () => {
  const h = harness({
    watermark: async () => ({ ok: true, seq: 0 }),
    markFailure: async () => { throw new Error('board 炸了') },
  })
  // 基线必须显式给成同一个值，否则 seq 0 > 基线 -1 会被判成「涨了」——那就测不到写失败路径
  h.w.expect({ taskId: 't-9', sessionId: 'bot-i', baselineSeq: 0 })
  h.advance(DEFAULT_GRACE_MS + 1000)
  await assert.doesNotReject(() => h.w.sweep())
  assert.ok(h.logs.some(([lvl]) => lvl === 'warn'), '失败要留 warn，但不能抛')
})
