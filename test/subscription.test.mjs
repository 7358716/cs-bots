/**
 * SubscriptionService 测试 —— 任务订阅（改造07 · 借鉴 Super-agent Subscription 扇出）。
 *
 * 重点：幂等订阅、扇出只加上下文不改任务、滚动窗口、CAS。
 * 运行：`node --test test/subscription.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createSubscription, { SubscriptionError } from '../src/subscription.js'

let counter = 0
function setup(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), `cs-bots-sub-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const svc = createSubscription({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

function readEvents(dir) {
  const f = join(dir, 'subscription.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('subscribe：创建订阅 + 落盘', (t) => {
  const { dir, svc } = setup(t)
  const sub = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  assert.match(sub.id, /^sub-\d+$/)
  assert.equal(sub.taskId, 't-1')
  assert.equal(sub.roomId, 'room-a')
  assert.equal(sub.state, 'active')
  assert.deepEqual(sub.context, [])
  assert.equal(readEvents(dir).length, 1)
})

test('subscribe：幂等——同一 (taskId, roomId) 重复订阅返回既有记录', (t) => {
  const { dir, svc } = setup(t)
  const first = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  const second = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  assert.equal(first.id, second.id)
  // 不产生第二条事件
  assert.equal(readEvents(dir).length, 1)
})

test('subscribe：不同房间 / 不同任务各自独立', (t) => {
  const { svc } = setup(t)
  const a = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  const b = svc.subscribe({ taskId: 't-1', roomId: 'room-b', by: 'ui' })
  const c = svc.subscribe({ taskId: 't-2', roomId: 'room-a', by: 'ui' })
  assert.notEqual(a.id, b.id)
  assert.notEqual(a.id, c.id)
  assert.notEqual(b.id, c.id)
})

test('subscribe：缺 taskId / roomId / by 必须抛错（绝不静默）', (t) => {
  const { svc } = setup(t)
  assert.throws(() => svc.subscribe({ roomId: 'r', by: 'ui' }), (e) => e.code === 'SUBSCRIPTION_BAD_FIELD')
  assert.throws(() => svc.subscribe({ taskId: 't', by: 'ui' }), (e) => e.code === 'SUBSCRIPTION_BAD_FIELD')
  assert.throws(() => svc.subscribe({ taskId: 't', roomId: 'r' }), (e) => e.code === 'SUBSCRIPTION_BAD_FIELD')
})

test('fanout：房间消息扇出到订阅的任务，上下文滚动窗口', async (t) => {
  const { svc } = setup(t, { fanoutKeep: 2 })
  svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })

  const msg1 = { id: 'm-1', roomId: 'room-a', seq: 1, from: 'bot-a', text: '第一条消息', at: 1 }
  const msg2 = { id: 'm-2', roomId: 'room-a', seq: 2, from: 'bot-b', text: '第二条消息', at: 2 }
  const msg3 = { id: 'm-3', roomId: 'room-a', seq: 3, from: 'bot-c', text: '第三条消息', at: 3 }

  await svc.fanout({ roomId: 'room-a', message: msg1 })
  await svc.fanout({ roomId: 'room-a', message: msg2 })
  await svc.fanout({ roomId: 'room-a', message: msg3 })

  const sub = svc.listByTask('t-1')[0]
  // 滚动窗口：只留最后 2 条
  assert.equal(sub.context.length, 2)
  assert.equal(sub.context[0].text, '第二条消息')
  assert.equal(sub.context[1].text, '第三条消息')
  assert.equal(sub.fanoutCount, 3)
})

test('fanout：只扇出订阅了该房间的任务（互不串扰）', async (t) => {
  const { svc } = setup(t)
  svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  svc.subscribe({ taskId: 't-2', roomId: 'room-b', by: 'ui' })

  const result = await svc.fanout({
    roomId: 'room-a',
    message: { id: 'm-1', roomId: 'room-a', seq: 1, from: 'bot-a', text: '消息', at: 1 },
  })
  assert.equal(result.fanned, 1)
  // 只有 t-1 收到
  const t1 = svc.listByTask('t-1')[0]
  const t2 = svc.listByTask('t-2')[0]
  assert.equal(t1.context.length, 1)
  assert.equal(t2.context.length, 0)
})

test('fanout：wake=false 时不唤醒（默认）', async (t) => {
  const { svc } = setup(t)
  svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  const result = await svc.fanout({
    roomId: 'room-a',
    message: { id: 'm-1', roomId: 'room-a', seq: 1, from: 'bot-a', text: '消息', at: 1 },
    wake: false,
  })
  assert.equal(result.woke, 0)
  assert.equal(result.failed, 0)
})

test('fanout：无订阅时 fanned=0', async (t) => {
  const { svc } = setup(t)
  const result = await svc.fanout({
    roomId: 'room-none',
    message: { id: 'm-1', roomId: 'room-none', seq: 1, from: 'bot-a', text: '消息', at: 1 },
  })
  assert.equal(result.fanned, 0)
})

test('fanout：长消息截断到 2000 字符（防上下文爆炸）', async (t) => {
  const { svc } = setup(t)
  svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  const longText = 'x'.repeat(5000)
  await svc.fanout({
    roomId: 'room-a',
    message: { id: 'm-1', roomId: 'room-a', seq: 1, from: 'bot-a', text: longText, at: 1 },
  })
  const sub = svc.listByTask('t-1')[0]
  assert.ok(sub.context[0].text.length <= 2000)
})

test('unsubscribe：活订阅变 dropped，之后不再扇出', async (t) => {
  const { svc } = setup(t)
  const sub = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  const out = svc.unsubscribe({ id: sub.id, by: 'ui' })
  assert.equal(out.state, 'dropped')
  assert.ok(out.droppedAt)

  // 再扇出：不再到达
  await svc.fanout({
    roomId: 'room-a',
    message: { id: 'm-1', roomId: 'room-a', seq: 1, from: 'bot-a', text: '消息', at: 1 },
  })
  await svc.fanout({ roomId: 'room-a', message: { id: 'm-2', seq: 2, from: 'x', text: 'x', at: 2 } })
  assert.equal(svc.stats().fanouts, 0)
})

test('unsubscribe：已 dropped 的订阅再次取消必须抛错（终态不可逆）', (t) => {
  const { svc } = setup(t)
  const sub = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  svc.unsubscribe({ id: sub.id, by: 'ui' })
  assert.throws(
    () => svc.unsubscribe({ id: sub.id, by: 'ui' }),
    (e) => e.code === 'SUBSCRIPTION_ALREADY_DROPPED',
  )
})

test('unsubscribe：CAS 冲突必须抛错（绝不静默覆盖）', (t) => {
  const { svc } = setup(t)
  const sub = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  assert.throws(
    () => svc.unsubscribe({ id: sub.id, expectedRev: 999, by: 'ui' }),
    (e) => e.code === 'SUBSCRIPTION_REV_CONFLICT',
  )
})

test('subscribe 后可重新订阅（dropped 不算占用）', (t) => {
  const { svc } = setup(t)
  const sub1 = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  svc.unsubscribe({ id: sub1.id, by: 'ui' })
  // 可以重新订阅
  const sub2 = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  assert.equal(sub2.state, 'active')
  assert.notEqual(sub1.id, sub2.id)
})

test('stats：计数正确', (t) => {
  const { svc } = setup(t)
  const a = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  const b = svc.subscribe({ taskId: 't-1', roomId: 'room-b', by: 'ui' })
  svc.unsubscribe({ id: a.id, by: 'ui' })
  const s = svc.stats()
  assert.equal(s.total, 2)
  assert.equal(s.active, 1)
  assert.equal(s.dropped, 1)
})

test('subscribersOf：返回订阅该房间的活任务 id', (t) => {
  const { svc } = setup(t)
  svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  svc.subscribe({ taskId: 't-2', roomId: 'room-a', by: 'ui' })
  svc.subscribe({ taskId: 't-3', roomId: 'room-b', by: 'ui' })
  const ids = svc.subscribersOf('room-a')
  assert.deepEqual(ids.sort(), ['t-1', 't-2'])
  assert.deepEqual(svc.subscribersOf('room-b'), ['t-3'])
})

test('replay：从事件流重建内存态', async (t) => {
  const { svc } = setup(t)
  const a = svc.subscribe({ taskId: 't-1', roomId: 'room-a', by: 'ui' })
  await svc.fanout({ roomId: 'room-a', message: { id: 'm-1', seq: 1, from: 'x', text: 'x', at: 1 } })
  svc.unsubscribe({ id: a.id, by: 'ui' })

  const r = svc.replay()
  assert.equal(r.from, 'jsonl')
  assert.equal(svc.stats().total, 1)
  assert.equal(svc.stats().active, 0)
})

test('空状态目录启动：stats 全 0，不抛错', (t) => {
  const { svc } = setup(t)
  const s = svc.stats()
  assert.equal(s.total, 0)
  assert.equal(s.active, 0)
  assert.equal(s.dropped, 0)
})

function dir(t) {
  // 辅助：返回 setup 的 dir（用于断言落盘事件数）
  return t._dir
}
