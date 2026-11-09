/**
 * 需求2 回归：会话事件 → 对话片段。
 *
 * ## 为什么必须有这组测试
 * 2026-11-09 实测发现：早期 `eventsToMessages` 只读 `ev.content`，
 * 而官方 SessionEvent 的形状是 `{ type, seq, time, data }`，内容在 `data` 里。
 * 结果对**任何真实会话**都产出空数组 —— 用户看到的就是「没有对话内容可看」。
 * 这组测试用**真实事件形状**钉住它，防止再退回去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { eventsToMessages, readSessionMessages } from '../src/kernel.js'

test('K1 user/message：内容在 data.content 里也要能读出来', () => {
  const events = [
    {
      type: 'user/message', seq: 1, time: 1793837680514,
      data: { content: [{ type: 'text', text: '把登录接口写出来' }], role: 'user' },
    },
  ]
  const msgs = eventsToMessages(events)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'user')
  assert.equal(msgs[0].kind, 'text')
  assert.equal(msgs[0].text, '把登录接口写出来')
  assert.equal(msgs[0].at, 1793837680514, '时间戳要带出来（界面上要显示先后）')
})

test('K2 assistant/message：内容在 data.message.content 里也要能读出来', () => {
  const events = [
    {
      type: 'assistant/message', seq: 2, time: 1793837683480,
      data: {
        turn: 1, step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先想想限流怎么加' },
            { type: 'text', text: '已完成 /login，顺带补了限流' },
          ],
        },
      },
    },
  ]
  const msgs = eventsToMessages(events)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].kind, 'reasoning')
  assert.match(msgs[0].text, /限流/)
  assert.equal(msgs[1].kind, 'text')
  assert.match(msgs[1].text, /\/login/)
})

test('K3 tool/call：顶层事件（data.name + data.arguments），不是嵌在助手消息里', () => {
  const events = [
    {
      type: 'tool/call', seq: 3, time: 1793837683482,
      data: { turn: 1, step: 1, callId: 'call_00_x', name: 'bash', arguments: '{"command":"pwd"}' },
    },
  ]
  const msgs = eventsToMessages(events)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'assistant')
  assert.equal(msgs[0].kind, 'tool-call')
  assert.equal(msgs[0].toolName, 'bash')
  assert.match(msgs[0].text, /pwd/, '入参摘要要能看到调用在干什么')
})

test('K4 tool/result：内容在 data.message.content，超长要截断', () => {
  const long = 'x'.repeat(2000)
  const events = [
    {
      type: 'tool/result', seq: 4, time: 1793837683513,
      data: { message: { role: 'tool', toolCallId: 'call_00_x', content: [{ type: 'text', text: long }] } },
    },
  ]
  const msgs = eventsToMessages(events)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'tool')
  assert.equal(msgs[0].kind, 'tool-result')
  assert.ok(msgs[0].text.length <= 1600, '工具结果必须截断（不然界面被日志淹没）')
})

test('K5 真实混合流：对话、思维链、工具三类都在，且顺序不丢', () => {
  const events = [
    { type: 'session', seq: 0, data: { id: 's-1' } },
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '跑一下测试' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'reasoning', text: '先跑测试' }, { type: 'text', text: '好，我去跑' }] } } },
    { type: 'tool/call', seq: 3, time: 3, data: { name: 'bash', arguments: '{"cmd":"npm test"}' } },
    { type: 'tool/result', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: '1028 pass' }] } } },
    { type: 'job/registered', seq: 5, time: 5, data: {} },
    { type: 'compaction/prune', seq: 6, time: 6, data: {} },
  ]
  const msgs = eventsToMessages(events)
  assert.equal(msgs.length, 5, '只保留有对话价值的事件（元数据/任务注册类一律跳过）')
  assert.deepEqual(msgs.map((m) => `${m.role}/${m.kind}`), [
    'user/text', 'assistant/reasoning', 'assistant/text', 'assistant/tool-call', 'tool/tool-result',
  ])
})

test('K6 旧扁平形状（ev.content）仍然兼容，不因改形状而丢老数据', () => {
  const msgs = eventsToMessages([
    { type: 'user/message', time: 1, content: [{ type: 'text', text: '老形状也要能读' }] },
  ])
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].text, '老形状也要能读')
})

test('K7 脏数据不炸：null 事件、缺 content、非对象块一律跳过', () => {
  const msgs = eventsToMessages([
    null, undefined, 42, 'str',
    { type: 'user/message' },
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: {} },
    { type: 'user/message', data: { content: [null, 'x', { type: 'text' }, { type: 'text', text: '   ' }] } },
  ])
  assert.deepEqual(msgs, [], '全是脏数据时必须返回空数组，不能抛错')
})

test('K8 sessionPersistence 不可用时如实返回 available:false（不假装读到了）', async () => {
  const out = await readSessionMessages({}, 's-1')
  assert.equal(out.ok, false)
  assert.equal(out.available, false)
  assert.match(out.reason, /sessionPersistence/)
})
