/**
 * Admission Gate 测试 —— 房间消息的确定性准入闸（改造09 · 借鉴 superagent 两段式准入）。
 *
 * 重点：**逐格锁死官方准入表**（docs/002-authorization.md §Admission）。
 *
 * | | 点名 | 没点名 |
 * |---|---|---|
 * | 在名单上 | explicit（不在表里） | inferred |
 * | 不在名单上 | **ignore**（缺省） | ignore |
 *
 * 并锁死四条容易做错的地方：
 *   1. 不在名单上的人点名你 → 缺省 ignore（不是 explicit）；
 *   2. `inferred` 是「候选」不是「放行」；`off` 下候选不成立；
 *   3. 未点名的消息只在「收全部消息」的来源才可能成候选；
 *   4. 机器人永远不能造出 explicit。
 *
 * 运行：`node --test test/admission.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCEPT_MODES,
  DEFAULT_ACCEPT_MODE,
  ADMISSIONS,
  ADMISSION_CELLS,
  ADMISSION_OPTIONS,
  ADMISSION_DEFAULTS,
  DECIDED_BY,
  isAddressed,
  matchesRule,
  decideAdmission,
} from '../src/admission.js'

// ── 常量对齐官方 ────────────────────────────────────────────────────────────

test('枚举缺省值：off/observe/auto，缺省 observe（保守优先）', () => {
  assert.deepEqual([...ACCEPT_MODES], ['off', 'observe', 'auto'])
  assert.equal(DEFAULT_ACCEPT_MODE, 'observe')
})

test('三值准入枚举：explicit / inferred / ignore（对齐官方 Admission）', () => {
  assert.deepEqual(Object.values(ADMISSIONS), ['explicit', 'inferred', 'ignore'])
})

test('表格常量逐字对齐官方 src/admission.ts', () => {
  // ADMISSION_DEFAULTS：官方 unlisted 两格都是 ignore，listedUnaddressed 是 inferred
  assert.equal(ADMISSION_DEFAULTS.listedUnaddressed, 'inferred')
  assert.equal(ADMISSION_DEFAULTS.unlistedAddressed, 'ignore')
  assert.equal(ADMISSION_DEFAULTS.unlistedUnaddressed, 'ignore')
  // ADMISSION_OPTIONS：unlistedAddressed 可选 explicit（专用支持群场景）
  assert.deepEqual([...ADMISSION_OPTIONS.listedUnaddressed], ['inferred', 'ignore'])
  assert.deepEqual([...ADMISSION_OPTIONS.unlistedAddressed], ['explicit', 'inferred', 'ignore'])
  assert.deepEqual([...ADMISSION_OPTIONS.unlistedUnaddressed], ['inferred', 'ignore'])
  assert.equal(ADMISSION_CELLS.LISTED_UNADDRESSED, 'listedUnaddressed')
})

test('返回形状字段恒存在（调用方不用做 null 判断）', () => {
  const r = decideAdmission({ message: { text: 'hi' }, recipientId: 'bot' })
  for (const k of ['admission', 'decidedBy', 'reason', 'addressed', 'onList', 'mode', 'wouldAccept', 'matchedRules', 'wake']) {
    assert.ok(k in r, `返回应含 ${k}`)
  }
})

// ── 点名判定 ────────────────────────────────────────────────────────────────

test('isAddressed：三种点名形状（to / mentions / @text）都认', () => {
  assert.equal(isAddressed({ to: 'bot-a' }, 'bot-a'), true)
  assert.equal(isAddressed({ mentions: ['bot-a', 'bot-b'] }, 'bot-a'), true)
  assert.equal(isAddressed({ text: '@bot-a 请看下' }, 'bot-a'), true)
  assert.equal(isAddressed({ text: '@bot-a' }, 'bot-a'), true, '@id 结尾也算点名')
})

test('isAddressed：不误命中 —— @bot 不等于 @bot-2', () => {
  assert.equal(isAddressed({ text: '@bot-2 看下' }, 'bot'), false, '@bot-2 不应误判为 @bot')
  assert.equal(isAddressed({ text: '这是 @bot-x 的活' }, 'bot'), false)
})

test('isAddressed：没有点名信息时一律 false', () => {
  assert.equal(isAddressed({ text: '随便说点什么' }, 'bot'), false)
  assert.equal(isAddressed({}, 'bot'), false)
  assert.equal(isAddressed(null, 'bot'), false)
  assert.equal(isAddressed({ text: '@bot' }, ''), false, '空接收者不能匹配')
})

// ── 规则匹配 ────────────────────────────────────────────────────────────────

test('matchesRule：四种形状都认', () => {
  const msg = { from: 'lead', kind: 'notice', text: '部署完成，请验收上线' }
  assert.equal(matchesRule(msg, { from: 'lead' }), true)
  assert.equal(matchesRule(msg, { kind: 'notice' }), true)
  assert.equal(matchesRule(msg, { contains: '部署' }), true)
  assert.equal(matchesRule(msg, { regex: '^部署' }), true)
})

test('matchesRule：多键规则是「且」关系', () => {
  const msg = { from: 'lead', kind: 'notice', text: '部署完成' }
  assert.equal(matchesRule(msg, { from: 'lead', kind: 'notice' }), true)
  assert.equal(matchesRule(msg, { from: 'lead', kind: 'normal' }), false)
})

test('matchesRule：坏正则/未知键/空规则一律不匹配（绝不放行）', () => {
  const msg = { text: '任意内容' }
  assert.equal(matchesRule(msg, { regex: '([未闭合' }), false, '坏正则必须视为不匹配')
  assert.equal(matchesRule(msg, { because: '我说了算' }), false, '未知键不能变成万能放行')
  assert.equal(matchesRule(msg, {}), false)
  assert.equal(matchesRule(msg, null), false)
})

// ── 核心：准入表逐格 ────────────────────────────────────────────────────────

test('在名单上 + 点名 → explicit（不在表里，三档模式都准入）', () => {
  for (const mode of ACCEPT_MODES) {
    const r = decideAdmission({
      message: { to: 'bot-a', text: '@bot-a 看下' }, recipientId: 'bot-a',
      subscribed: true, acceptMode: mode,
    })
    assert.equal(r.admission, ADMISSIONS.EXPLICIT, `${mode} 下名单内点名必须 explicit`)
    assert.equal(r.decidedBy, DECIDED_BY.LISTED_ADDRESSED)
    assert.equal(r.addressed, true)
    assert.equal(r.onList, true)
  }
})

test('在名单上 + 没点名 + 收全部消息 → inferred（候选）', () => {
  const r = decideAdmission({
    message: { from: 'lead', text: '随便聊聊' }, recipientId: 'bot-a',
    subscribed: true, acceptMode: 'auto', receivesEveryMessage: true,
  })
  assert.equal(r.admission, ADMISSIONS.INFERRED)
  assert.equal(r.decidedBy, DECIDED_BY.LISTED_UNADDRESSED)
})

test('在名单上 + 没点名 + 不收全部消息 → ignore（官方格子不开放）', () => {
  const r = decideAdmission({
    message: { from: 'lead', text: '随便聊聊' }, recipientId: 'bot-a',
    subscribed: true, acceptMode: 'auto', receivesEveryMessage: false,
  })
  assert.equal(r.admission, ADMISSIONS.IGNORE)
  assert.match(r.reason, /不是「收全部消息」/)
})

test('🔴 不在名单上 + 点名 → 缺省 ignore（不是 explicit！）', () => {
  const r = decideAdmission({
    message: { to: 'bot-a', text: '@bot-a 帮个忙' }, recipientId: 'bot-a',
    subscribed: false, acceptMode: 'auto',
  })
  assert.equal(r.admission, ADMISSIONS.IGNORE,
    '官方：A LISTED sender who addresses the agent makes an explicit request —— 前提是在名单上')
  assert.equal(r.decidedBy, DECIDED_BY.NOT_ON_LIST)
  assert.equal(r.addressed, true, '点名是事实，要记下来')
  assert.equal(r.onList, false)
})

test('不在名单上 + 点名，但表格该格设为 explicit → explicit（专用支持群）', () => {
  const r = decideAdmission({
    message: { to: 'bot-a', text: '@bot-a 报个 bug' }, recipientId: 'bot-a',
    subscribed: false, acceptMode: 'auto',
    table: { unlistedAddressed: 'explicit' },
  })
  assert.equal(r.admission, ADMISSIONS.EXPLICIT)
  assert.equal(r.decidedBy, DECIDED_BY.TABLE_EXPLICIT)
})

test('不在名单上 + 点名，表格设为 inferred → 候选（不是明确）', () => {
  const r = decideAdmission({
    message: { to: 'bot-a', text: '@bot-a 看下' }, recipientId: 'bot-a',
    subscribed: false, acceptMode: 'auto',
    table: { unlistedAddressed: 'inferred' },
  })
  assert.equal(r.admission, ADMISSIONS.INFERRED)
  assert.match(r.reason, /不是明确/)
})

test('不在名单上 + 没点名 → ignore（两格缺省都是 ignore）', () => {
  const r = decideAdmission({
    message: { from: 'lead', text: '闲聊' }, recipientId: 'bot-a',
    subscribed: false, acceptMode: 'auto', receivesEveryMessage: true,
  })
  assert.equal(r.admission, ADMISSIONS.IGNORE)
})

test('不在名单上 + 没点名 + 收全部消息 + 格子 inferred → 候选', () => {
  const r = decideAdmission({
    message: { from: 'lead', text: '闲聊' }, recipientId: 'bot-a',
    subscribed: false, acceptMode: 'auto', receivesEveryMessage: true,
    table: { unlistedUnaddressed: 'inferred' },
  })
  assert.equal(r.admission, ADMISSIONS.INFERRED)
})

// ── 模式语义（官方 docs/002 §Accept mode and rules）─────────────────────────

test('🔴 off：候选不成立（连 inferred 都没有）', () => {
  const r = decideAdmission({
    message: { from: 'lead', text: '闲聊' }, recipientId: 'bot-a',
    subscribed: true, acceptMode: 'off', receivesEveryMessage: true,
  })
  assert.equal(r.admission, ADMISSIONS.IGNORE)
  assert.equal(r.decidedBy, DECIDED_BY.MODE_OFF)
  assert.match(r.reason, /off = 没有候选/)
})

test('🔴 observe 与 auto 都产出候选（差别在评估之后，不在 Gate）', () => {
  for (const mode of ['observe', 'auto']) {
    const r = decideAdmission({
      message: { from: 'lead', text: '闲聊' }, recipientId: 'bot-a',
      subscribed: true, acceptMode: mode, receivesEveryMessage: true,
    })
    assert.equal(r.admission, ADMISSIONS.INFERRED, `${mode} 都要产出候选`)
    assert.match(r.reason, mode === 'observe' ? /would accept/ : /会被接受/)
  }
})

test('🔴 Gate 阶段 wouldAccept 恒 false（它是评估结论，不能提前伪造）', () => {
  const cases = [
    { acceptMode: 'observe', receivesEveryMessage: true },
    { acceptMode: 'auto', receivesEveryMessage: true },
    { acceptMode: 'off', receivesEveryMessage: true },
  ]
  for (const c of cases) {
    const r = decideAdmission({
      message: { from: 'lead', text: '闲聊' }, recipientId: 'bot-a',
      subscribed: true, ...c,
    })
    assert.equal(r.wouldAccept, false, 'Gate 不产生 wouldAccept —— 那是评估阶段的记录')
  }
})

// ── 机器人约束 ──────────────────────────────────────────────────────────────

test('🔴 机器人不能造出 explicit（即使表格该格设为 explicit）', () => {
  const r = decideAdmission({
    message: { to: 'bot-a', text: '@bot-a 干活' }, recipientId: 'bot-a',
    subscribed: false, acceptMode: 'auto', senderIsBot: true,
    table: { unlistedAddressed: 'explicit' },
  })
  assert.equal(r.admission, ADMISSIONS.IGNORE)
  assert.match(r.reason, /机器人不能造出 explicit/)
})

// ── 保守与健壮 ──────────────────────────────────────────────────────────────

test('订阅已停（active_stopped）不算在名单上', () => {
  const r = decideAdmission({
    message: { text: '部署完成' }, recipientId: 'bot-a',
    subscribed: true, subscriptionState: 'active_stopped', acceptMode: 'auto',
  })
  assert.equal(r.onList, false)
  assert.equal(r.admission, ADMISSIONS.IGNORE)
})

test('acceptMode 缺省 = observe，不认识的值也退回 observe（不是 auto）', () => {
  const base = { message: { from: 'lead', text: '闲聊' }, recipientId: 'bot-a', subscribed: true, receivesEveryMessage: true }
  assert.equal(decideAdmission(base).mode, DEFAULT_ACCEPT_MODE)
  assert.equal(decideAdmission({ ...base, acceptMode: '全开' }).mode, 'observe', '不认识的值必须退回 observe')
})

test('非法表格格子值退回缺省（绝不退回更宽的 explicit）', () => {
  const r = decideAdmission({
    message: { to: 'bot-a', text: '@bot-a 看下' }, recipientId: 'bot-a',
    subscribed: false, acceptMode: 'auto',
    table: { unlistedAddressed: '什么都可以' },
  })
  assert.equal(r.admission, ADMISSIONS.IGNORE, '非法值必须退回缺省 ignore，不能升格成 explicit')
})

test('消息/接收者缺失时一律 ignore，不猜', () => {
  assert.equal(decideAdmission(null).admission, ADMISSIONS.IGNORE)
  assert.equal(decideAdmission({}).admission, ADMISSIONS.IGNORE)
  assert.equal(decideAdmission({ message: null, recipientId: 'bot' }).admission, ADMISSIONS.IGNORE)
  assert.equal(decideAdmission({ message: { text: 'x' }, recipientId: '' }).admission, ADMISSIONS.IGNORE)
  assert.equal(decideAdmission({}).decidedBy, DECIDED_BY.INVALID)
})

test('纯函数：同样的输入永远同样的输出（审计靠它）', () => {
  const args = {
    message: { from: 'lead', kind: 'notice', text: '部署完成' },
    recipientId: 'bot-a', subscribed: true, acceptMode: 'auto', receivesEveryMessage: true,
  }
  assert.deepEqual(decideAdmission(args), decideAdmission(args))
})

test('reason 必须是人话（人要能据此改规则）', () => {
  const cases = [
    { message: { to: 'bot-a' }, recipientId: 'bot-a', subscribed: true },
    { message: { text: 'hi' }, recipientId: 'bot-a', subscribed: false },
    { message: { text: 'hi' }, recipientId: 'bot-a', subscribed: true, receivesEveryMessage: true },
    { message: { text: 'hi' }, recipientId: 'bot-a', subscribed: true, acceptMode: 'off', receivesEveryMessage: true },
  ]
  for (const c of cases) {
    const r = decideAdmission(c)
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.reason.length > 0, 'reason 不能为空')
  }
})