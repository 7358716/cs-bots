/**
 * 复杂度路由 hint 注入测试（契约 §3 + §6）。
 *
 * 这一层的核心风险不是「功能没做」，而是**把对话请求搞挂**，所以每条用例都在断言
 * 「不该做的事没做」与「失败了也照样 next()」：
 *   1. 没有 cs-myfree 注册表 ⇒ `installed:false` 且**请求照常 next()**（不写任何东西）；
 *   2. `provider !== 'cs-myfree'` ⇒ 一次都不写（官方渠道不受影响）；
 *   3. hint 形状与契约 §3 **逐字对齐**（恰好六个键，值域正确）；
 *   4. 任何异常（注册表读取抛、setRequestHint 抛）⇒ fail-open，`next()` 仍被调用。
 *
 * 运行：`node --test test/routing-hints.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HINTS_SYMBOL,
  HINT_TTL_MS,
  HINTS_VERSION,
  SOURCE_LLM_STREAM,
  SOURCE_TASK_BOARD,
  applyTaskHint,
  detectToolUse,
  estimateContextTokens,
  getGlobalHintsRegistry,
  installLlmStreamHint,
  mergeHint,
  resolveHint,
  signalsFromRequest,
} from '../src/routing/hints.js'

// ── 夹具：假注册表 / 假 kernel ────────────────────────────────────────────────

/**
 * 在 globalThis 上装一个假的 cs-myfree 注册表（与真实现同形）。
 * `t.after` 保证清理 —— Symbol.for 是全局的，残留会污染其它用例。
 */
function installFakeRegistry(t, { setThrows = false } = {}) {
  const writes = []
  const api = {
    setRequestHint(sessionId, hint) {
      if (setThrows) throw new Error('boom: registry rejected hint')
      writes.push({ sessionId, hint })
    },
    getRequestHint: (sessionId) => writes.filter((w) => w.sessionId === sessionId).at(-1)?.hint ?? null,
    clearRequestHint: () => {},
  }
  const previous = globalThis[HINTS_SYMBOL]
  globalThis[HINTS_SYMBOL] = { version: HINTS_VERSION, api }
  t?.after?.(() => {
    if (previous === undefined) delete globalThis[HINTS_SYMBOL]
    else globalThis[HINTS_SYMBOL] = previous
  })
  return { writes, api }
}

/** 确保测试期间**没有**注册表（模拟「cs-myfree 未安装」）。 */
function removeRegistry(t) {
  const previous = globalThis[HINTS_SYMBOL]
  delete globalThis[HINTS_SYMBOL]
  t?.after?.(() => {
    if (previous !== undefined) globalThis[HINTS_SYMBOL] = previous
  })
}

/**
 * 造一个记录型 kernel 替身：捕获 handler，便于直接驱动（等价于宿主调用瀑布）。
 * `mode: 'ok' | 'no-service' | 'throwing'` 覆盖三种宿主形态。
 */
function fakeKernel(mode = 'ok') {
  const captured = {}
  const kernel = {
    onLlmStream(ctx, handler) {
      if (mode === 'no-service') return false
      if (mode === 'throwing') throw new Error('ctx.on exploded')
      captured.handler = handler
      captured.ctx = ctx
      return true
    },
  }
  return { kernel, captured }
}

/** 造一条可被 next() 观测的请求 + 计数器。 */
function makeRequest(over = {}) {
  const calls = { next: 0 }
  const request = {
    provider: 'cs-myfree',
    model: 'gpt-x',
    sessionId: 'sess-1',
    messages: [
      { role: 'system', content: 'you are a dev steward' },
      { role: 'user', content: '请把任务拆成四步并逐个验收' },
    ],
    ...over,
  }
  const next = () => {
    calls.next += 1
    return 'STREAM'
  }
  return { request, next, calls }
}

// ── 1. 信号提取（纯函数）─────────────────────────────────────────────────────

test('estimateContextTokens：string content / parts 数组 / 裸 text 三种形态都算，字符/4 向上取整', () => {
  assert.equal(estimateContextTokens([]), 0)
  assert.equal(estimateContextTokens(undefined), 0)
  assert.equal(estimateContextTokens([{ role: 'user', content: 'abcd' }]), 1)
  assert.equal(estimateContextTokens([{ role: 'user', content: 'a'.repeat(4000) }]), 1000)
  assert.equal(
    estimateContextTokens([
      { role: 'user', content: [{ type: 'text', text: 'abcd' }, { type: 'text', text: 'efgh' }] },
    ]),
    2,
  )
  assert.equal(estimateContextTokens([{ role: 'user', text: 'abcd' }]), 1)
  // 非对象/畸形元素不炸、按 0 计
  assert.equal(estimateContextTokens([null, 42, { role: 'user' }]), 0)
})

test('detectToolUse：工具声明 / 工具历史 / 历史里的 tool 消息与 toolCalls 都判为 true', () => {
  assert.equal(detectToolUse({}), false)
  assert.equal(detectToolUse({ tools: [] }), false)
  assert.equal(detectToolUse({ tools: [{ name: 'bash' }] }), true)
  assert.equal(detectToolUse({ toolHistory: [{ id: 1 }] }), true)
  assert.equal(detectToolUse({ toolHistory: {} }), false)
  assert.equal(detectToolUse({ messages: [{ role: 'tool', content: 'ok' }] }), true)
  assert.equal(detectToolUse({ messages: [{ role: 'assistant', toolCalls: [{ name: 'x' }] }] }), true)
  assert.equal(detectToolUse({ messages: [{ role: 'user', content: 'hi' }] }), false)
})

test('signalsFromRequest：只读提取五项信号，且不修改传入的 options', () => {
  const options = {
    provider: 'cs-myfree',
    sessionId: 's1',
    messages: [{ role: 'user', content: 'a'.repeat(4000) }, { role: 'user', content: 'b' }],
    tools: [{ name: 'bash' }],
  }
  const snapshot = JSON.stringify(options)
  const signals = signalsFromRequest(options, { role: 'main', explicitComplexity: 't2' })
  assert.equal(signals.contextTokens, 1001)
  assert.equal(signals.historyDepth, 2)
  assert.equal(signals.hasToolCalls, true)
  assert.equal(signals.agentRole, 'main')
  assert.equal(signals.explicitComplexity, 'T2')
  assert.equal(JSON.stringify(options), snapshot, 'option 是宿主冻结对象，必须只读')
})

// ── 2. resolveHint：只对 cs-myfree 造 hint ───────────────────────────────────

test('resolveHint：provider !== cs-myfree ⇒ null（官方渠道一个字节都不碰）', () => {
  for (const provider of ['deepseek', 'openai', '', undefined, null, 'CS-MYFREE']) {
    const hint = resolveHint(
      { provider, sessionId: 'sess-1', messages: [] },
      { role: 'main', now: 1_700_000_000_000 },
    )
    assert.equal(hint, null, `provider=${JSON.stringify(provider)} 时不应造 hint`)
  }
})

test('resolveHint：无 sessionId ⇒ null（注册表按 sessionId 建索引，无键可写）', () => {
  for (const sessionId of [undefined, null, '', 42, {}]) {
    assert.equal(resolveHint({ provider: 'cs-myfree', sessionId, messages: [] }), null)
  }
  assert.equal(resolveHint(null), null)
  assert.equal(resolveHint(undefined), null)
})

test('resolveHint：hint 形状严格等于契约 §3（恰好六个键，值域正确）', () => {
  const hint = resolveHint(
    { provider: 'cs-myfree', sessionId: 'sess-42', messages: [{ role: 'user', content: 'hi' }] },
    { role: 'subagent', requiresPaid: false, now: 1_700_000_000_123 },
  )
  assert.deepEqual(Object.keys(hint).sort(), [
    'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
  ])
  assert.equal(hint.billing_tier, 'free_only', '子智能体默认 free_only（fail-closed）')
  assert.equal(hint.complexity_tier, 'T0', '一条短消息 ⇒ T0')
  assert.equal(hint.agent_role, 'subagent')
  assert.equal(hint.requires_paid, false)
  assert.equal(hint.source, SOURCE_LLM_STREAM)
  assert.equal(hint.at, 1_700_000_000_123)
  // 值域：billing_tier 只允许两值；complexity_tier 只允许四档或 null
  assert.match(hint.billing_tier, /^(free_only|paid_allowed)$/)
  assert.match(hint.complexity_tier, /^(T0|T1|T2|T3)$/)
})

test('resolveHint：main 角色 / requiresPaid=true ⇒ paid_allowed；complexity_tier 可为 null 之外的合法档', () => {
  const mainHint = resolveHint(
    { provider: 'cs-myfree', sessionId: 's1', messages: [] },
    { role: 'main', now: 1 },
  )
  assert.equal(mainHint.billing_tier, 'paid_allowed')
  assert.equal(mainHint.agent_role, 'main')

  const paidHint = resolveHint(
    { provider: 'cs-myfree', sessionId: 's1', messages: [] },
    { role: 'subagent', requiresPaid: true, now: 1 },
  )
  assert.equal(paidHint.billing_tier, 'paid_allowed')
  assert.equal(paidHint.requires_paid, true)

  const explicit = resolveHint(
    { provider: 'cs-myfree', sessionId: 's1', messages: [] },
    { role: 'subagent', explicitComplexity: 'T3', now: 1, source: 'test-src' },
  )
  assert.equal(explicit.complexity_tier, 'T3')
  assert.equal(explicit.billing_tier, 'free_only', 'T3 本身不等于「值得付费」—— 授权只看角色/显式诉求')
  assert.equal(explicit.source, 'test-src')
})

// ── 3. 无 cs-myfree：installed:false，且请求照常 next() ──────────────────────

test('★ 无 cs-myfree 注册表：installLlmStreamHint → installed:false/reason，handler 仍 return next()', (t) => {
  removeRegistry(t)
  const { kernel, captured } = fakeKernel('ok')
  const result = installLlmStreamHint({ on() {} }, kernel, {})

  assert.equal(result.installed, false, 'cs-myfree 未安装时不能谎报 installed')
  assert.equal(result.hooked, true, '钩子本身仍应注册（cs-myfree 后装载也能生效）')
  assert.equal(result.reason, 'cs-myfree-registry-missing')
  assert.equal(typeof result.handler, 'function')

  const { request, next, calls } = makeRequest()
  const returned = result.handler(request, next)
  assert.equal(calls.next, 1, '没有注册表也必须 next() —— 请求照常进行')
  assert.equal(returned, 'STREAM', '必须原样透传 next() 的返回值（AsyncIterable 不可包装）')
  assert.equal(result.stats.calls, 1)
  assert.equal(result.stats.injected, 0)
  assert.equal(result.stats.skippedNoRegistry, 1)
  assert.equal(captured.handler, result.handler, '传给 kernel 的正是这个 handler')
})

test('kernel 无 onLlmStream（老宿主/测试替身）⇒ installed:false + reason，且不抛', (t) => {
  installFakeRegistry(t)
  for (const kernel of [undefined, null, {}, { onLlmStream: 'not-a-function' }]) {
    const result = installLlmStreamHint({}, kernel, {})
    assert.equal(result.installed, false)
    assert.equal(result.hooked, false)
    assert.equal(result.reason, 'llm-stream-hook-unavailable')
  }
})

test('ctx.on 抛错 ⇒ 降级为 hooked:false（不把插件装配搞崩）', () => {
  const { kernel } = fakeKernel('throwing')
  const warnings = []
  const result = installLlmStreamHint({ on() {} }, kernel, { warn: (m) => warnings.push(m) })
  assert.equal(result.installed, false)
  assert.equal(result.hooked, false)
  assert.equal(result.reason, 'llm-stream-hook-unavailable')
  assert.equal(warnings.length, 1, '必须留下可排查的 warn')
})

// ── 4. 有注册表：写入且形状正确 ───────────────────────────────────────────────

test('有 cs-myfree 注册表：installed:true，handler 写入 hint（sessionId 与形状都对）', (t) => {
  const { writes } = installFakeRegistry(t)
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, { now: () => 1_700_000_000_999 })
  assert.equal(result.installed, true)
  assert.equal(result.registryVersion, HINTS_VERSION)

  const { request, next, calls } = makeRequest()
  assert.equal(result.handler(request, next), 'STREAM')
  assert.equal(calls.next, 1)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].sessionId, 'sess-1')
  assert.deepEqual(Object.keys(writes[0].hint).sort(), [
    'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
  ])
  assert.equal(writes[0].hint.source, SOURCE_LLM_STREAM)
  assert.equal(writes[0].hint.at, 1_700_000_000_999)
  assert.equal(result.stats.injected, 1)
})

// ── 5. provider !== cs-myfree：一个字节都不写 ─────────────────────────────────

test('★ provider !== cs-myfree：不写 hint（官方 deepseek 渠道零影响），但 next() 照常', (t) => {
  const { writes } = installFakeRegistry(t)
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, {})

  for (const provider of ['deepseek', 'openai', undefined, 'CS-MYFREE']) {
    const { request, next, calls } = makeRequest({ provider })
    assert.equal(result.handler(request, next), 'STREAM')
    assert.equal(calls.next, 1)
  }
  assert.equal(writes.length, 0, `provider 非 cs-myfree 时不得写 hint，实际写了 ${writes.length} 条`)
  assert.equal(result.stats.skippedProvider, 4)
  assert.equal(result.stats.injected, 0)
})

test('provider=cs-myfree 但缺 sessionId：跳过写入（不猜会话），next() 照常', (t) => {
  const { writes } = installFakeRegistry(t)
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, {})
  const { request, next, calls } = makeRequest({ sessionId: undefined })
  assert.equal(result.handler(request, next), 'STREAM')
  assert.equal(calls.next, 1)
  assert.equal(writes.length, 0)
  assert.equal(result.stats.skippedNoSession, 1)
})

// ── 6. fail-open：任何异常都不影响请求 ────────────────────────────────────────

test('★ fail-open：setRequestHint 抛错 ⇒ next() 仍被调用，只记 stats.errors + 一条 warn', (t) => {
  installFakeRegistry(t, { setThrows: true })
  const { kernel } = fakeKernel()
  const warnings = []
  const result = installLlmStreamHint({}, kernel, { warn: (m) => warnings.push(m) })

  const { request, next, calls } = makeRequest()
  assert.equal(result.handler(request, next), 'STREAM', '注册表内部抛错绝不能冒泡到宿主')
  assert.equal(calls.next, 1)
  assert.equal(result.stats.errors, 1)
  assert.equal(result.stats.injected, 0)
  assert.match(warnings.join('\n'), /写复杂度路由 hint 失败/)
})

test('fail-open：注册表读取本身抛错 ⇒ next() 仍被调用', (t) => {
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, {
    getRegistry: () => { throw new Error('symbol trap exploded') },
  })
  const { request, next, calls } = makeRequest()
  assert.equal(result.handler(request, next), 'STREAM')
  assert.equal(calls.next, 1)
  assert.equal(result.stats.errors, 1)
})

test('注册表形状不对（缺 api.setRequestHint）⇒ 视为未安装，resolve 时跳过而不是崩', () => {
  const previous = globalThis[HINTS_SYMBOL]
  globalThis[HINTS_SYMBOL] = { version: 1, api: {} }
  try {
    assert.equal(getGlobalHintsRegistry(), null, '缺 setRequestHint 的注册表必须判为不可用')
    const { kernel } = fakeKernel()
    const result = installLlmStreamHint({}, kernel, {})
    assert.equal(result.installed, false)
    assert.equal(result.reason, 'cs-myfree-registry-missing')
    const { request, next, calls } = makeRequest()
    assert.equal(result.handler(request, next), 'STREAM')
    assert.equal(calls.next, 1)
  } finally {
    if (previous === undefined) delete globalThis[HINTS_SYMBOL]
    else globalThis[HINTS_SYMBOL] = previous
  }
})

// ── 7. 任务板 → 会话 hint（claim / wake 用）────────────────────────────────────

test('applyTaskHint：requiresPaid=true ⇒ paid_allowed；缺省 ⇒ free_only；tier 透传', (t) => {
  const { writes } = installFakeRegistry(t)
  const paidTask = { id: 't-1', expectedComplexity: 'T3', requiresPaid: true }
  const freeTask = { id: 't-2', expectedComplexity: 'T1' }

  const paid = applyTaskHint(paidTask, 'sess-owner', { now: 7 })
  assert.equal(paid.ok, true)
  assert.equal(paid.hint.billing_tier, 'paid_allowed')
  assert.equal(paid.hint.complexity_tier, 'T3')
  assert.equal(paid.hint.agent_role, 'subagent', 'owner 默认按子智能体记账')
  assert.equal(paid.hint.source, SOURCE_TASK_BOARD)
  assert.equal(paid.hint.at, 7)

  const free = applyTaskHint(freeTask, 'sess-owner-2')
  assert.equal(free.ok, true)
  assert.equal(free.hint.billing_tier, 'free_only')
  assert.equal(free.hint.complexity_tier, 'T1')
  assert.equal(free.hint.requires_paid, false)

  assert.deepEqual(writes.map((w) => w.sessionId), ['sess-owner', 'sess-owner-2'])
})

test('applyTaskHint：任务没标复杂度 ⇒ complexity_tier=null（不是猜一个）；非法标注被 normalize 掉', (t) => {
  installFakeRegistry(t)
  const bare = applyTaskHint({ id: 't-3' }, 'sess-x')
  assert.equal(bare.ok, true)
  assert.equal(bare.hint.complexity_tier, null, '未标注就给 null —— 不伪造档位')
  assert.equal(bare.hint.billing_tier, 'free_only')

  const bogus = applyTaskHint({ id: 't-4', expectedComplexity: 'T9' }, 'sess-y')
  assert.equal(bogus.hint.complexity_tier, null)
})

test('applyTaskHint：无注册表 / 缺参数 / 写入抛错 ⇒ 返回可读失败，绝不抛', (t) => {
  removeRegistry(t)
  assert.deepEqual(applyTaskHint({ id: 't-1' }, 's'), { ok: false, reason: 'cs-myfree-registry-missing' })
  assert.deepEqual(applyTaskHint(null, 's'), { ok: false, reason: 'no-task' })
  assert.deepEqual(applyTaskHint({ id: 't-1' }, ''), { ok: false, reason: 'no-session' })

  installFakeRegistry(t, { setThrows: true })
  const failed = applyTaskHint({ id: 't-1' }, 's')
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /^hint-write-failed:/)
})


// ── 8. mergeHint：只升不降（P3-fix 核心）────────────────────────────────────

const TASK_AUTH = Object.freeze({
  billing_tier: 'paid_allowed',
  complexity_tier: 'T3',
  agent_role: 'subagent',
  requires_paid: true,
  source: SOURCE_TASK_BOARD,
  at: 1_000_000,
})

const NEXT_FREE = Object.freeze({
  billing_tier: 'free_only',
  complexity_tier: 'T1',
  agent_role: 'subagent',
  requires_paid: false,
  source: SOURCE_LLM_STREAM,
  at: 1_060_000,
})

test('mergeHint：next 是 paid_allowed ⇒ 直接用 next（平台已判定本次该付费）', () => {
  const nextPaid = { ...NEXT_FREE, billing_tier: 'paid_allowed', complexity_tier: 'T2' }
  assert.deepEqual(mergeHint(TASK_AUTH, nextPaid, { now: nextPaid.at }), nextPaid)
  assert.deepEqual(mergeHint(null, nextPaid, { now: nextPaid.at }), nextPaid)
  assert.deepEqual(mergeHint({ ...TASK_AUTH, source: 'other' }, nextPaid, { now: nextPaid.at }), nextPaid)
})

test('★ mergeHint：未过期的任务板授权 ⇒ 保留 paid_allowed，同时刷新 complexity_tier/at', () => {
  const merged = mergeHint(TASK_AUTH, NEXT_FREE, { now: NEXT_FREE.at })
  assert.equal(merged.billing_tier, 'paid_allowed', '任务授权不得被下一条请求踩成 free_only')
  assert.equal(merged.requires_paid, true, 'requires_paid 保留 true（授权来源可追溯）')
  assert.equal(merged.complexity_tier, 'T1', '复杂度档位用本次请求的新鲜值')
  assert.equal(merged.at, NEXT_FREE.at, 'at 刷新为本次请求时间')
  assert.equal(merged.source, SOURCE_LLM_STREAM, '写入方仍是 llm/stream')
  assert.deepEqual(Object.keys(merged).sort(), [
    'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
  ])
})

test('mergeHint：任务授权过期 ⇒ 降回 next（free_only）；边界 exactly ttl 即视为过期', () => {
  const justBefore = mergeHint(TASK_AUTH, { ...NEXT_FREE, at: TASK_AUTH.at + HINT_TTL_MS - 1 }, {})
  assert.equal(justBefore.billing_tier, 'paid_allowed')
  const exactly = mergeHint(TASK_AUTH, { ...NEXT_FREE, at: TASK_AUTH.at + HINT_TTL_MS }, {})
  assert.equal(exactly.billing_tier, 'free_only', '恰好到期即不允许延续')
  const longAfter = mergeHint(TASK_AUTH, { ...NEXT_FREE, at: TASK_AUTH.at + 10 * HINT_TTL_MS }, {})
  assert.equal(longAfter.billing_tier, 'free_only')
})

test('mergeHint：自定义 ttlMs 生效（短 TTL 下更早降级）', () => {
  const merged = mergeHint(TASK_AUTH, { ...NEXT_FREE, at: TASK_AUTH.at + 60_000 }, { ttlMs: 30_000 })
  assert.equal(merged.billing_tier, 'free_only')
})

test('mergeHint：合并后的续期态（source=llm-stream + requires_paid）仍算授权 ⇒ 不会在第二条请求衰减', () => {
  const merged = mergeHint(TASK_AUTH, NEXT_FREE, { now: NEXT_FREE.at })
  const nextFree = { ...NEXT_FREE, at: NEXT_FREE.at + 1_000 }
  const again = mergeHint(merged, nextFree, { now: nextFree.at })
  assert.equal(again.billing_tier, 'paid_allowed', '授权必须能跨多条请求延续')
  assert.equal(again.requires_paid, true)
  assert.equal(again.complexity_tier, 'T1', '档位仍是本次请求的新鲜值')
})

test('mergeHint：授权来源不成立时一律用 next（不越权延续）', () => {
  const cases = [
    [{ ...TASK_AUTH, source: 'cs-bots/other-plugin' }, '未知来源'],
    [{ ...TASK_AUTH, requires_paid: false }, 'requires_paid 不为 true'],
    [{ ...TASK_AUTH, billing_tier: 'free_only' }, '旧 hint 本身是 free_only'],
    [{ ...TASK_AUTH, at: undefined }, '旧 hint 无时间戳（无法判过期）'],
    [{ ...TASK_AUTH, at: 'not-a-number' }, '旧 hint 时间戳非法'],
    [null, '无旧 hint'],
    [undefined, '无旧 hint'],
    ['garbage', '旧 hint 不是对象'],
    [42, '旧 hint 不是对象'],
  ]
  for (const [existing, why] of cases) {
    assert.equal(
      mergeHint(existing, NEXT_FREE, { now: NEXT_FREE.at }).billing_tier,
      'free_only',
      `情形「${why}」不应延续付费授权`,
    )
  }
})

test('mergeHint：next 非法 ⇒ 原样返回（不抛），保证 handler 的 fail-open 通道不断', () => {
  assert.equal(mergeHint(TASK_AUTH, null), null)
  assert.equal(mergeHint(TASK_AUTH, undefined), undefined)
  assert.equal(mergeHint(TASK_AUTH, 'x'), 'x')
})

// ── 9. handler：按请求动态解析角色 + 写入前合并 ───────────────────────────────

test('roleOf 每次请求动态解析：同一注册表里 main 与 subagent 会话各得其所', (t) => {
  const { writes } = installFakeRegistry(t)
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, {
    roleOf: (sessionId) => (sessionId === 'sess-bot' ? 'subagent' : 'main'),
  })

  const main = makeRequest({ sessionId: 'sess-main' })
  assert.equal(result.handler(main.request, main.next), 'STREAM')
  const bot = makeRequest({ sessionId: 'sess-bot' })
  assert.equal(result.handler(bot.request, bot.next), 'STREAM')

  assert.deepEqual(writes.map((w) => [w.sessionId, w.hint.billing_tier, w.hint.agent_role]), [
    ['sess-main', 'paid_allowed', 'main'],
    ['sess-bot', 'free_only', 'subagent'],
  ])
})

test('roleOf 返回垃圾值 ⇒ 归一为 unknown ⇒ free_only（不猜 main）', (t) => {
  const { writes } = installFakeRegistry(t)
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, { roleOf: () => 'root' })
  const { request, next } = makeRequest({ sessionId: 'sess-x' })
  result.handler(request, next)
  assert.equal(writes.at(-1).hint.agent_role, 'unknown')
  assert.equal(writes.at(-1).hint.billing_tier, 'free_only')
})

test('★ roleOf 抛错 ⇒ 仍 next()，且 billing 为 free_only（fail-open + fail-closed 同时成立）', (t) => {
  const { writes } = installFakeRegistry(t)
  const { kernel } = fakeKernel()
  const warnings = []
  const result = installLlmStreamHint({}, kernel, {
    roleOf: () => { throw new Error('roster lookup exploded') },
    warn: (m) => warnings.push(m),
  })
  const { request, next, calls } = makeRequest({ sessionId: 'sess-err' })
  assert.equal(result.handler(request, next), 'STREAM', '角色解析失败绝不能让请求失败')
  assert.equal(calls.next, 1)
  assert.equal(result.stats.roleOfErrors, 1)
  assert.equal(result.stats.injected, 1)
  assert.equal(writes.at(-1).hint.billing_tier, 'free_only', '拿不到角色就按免费走')
  assert.match(warnings.join('\n'), /roleOf 解析失败/)
})

test('getRequestHint 缺失 ⇒ 按无 existing 处理，行为与修复前一致（不崩）', (t) => {
  const writes = []
  const previous = globalThis[HINTS_SYMBOL]
  globalThis[HINTS_SYMBOL] = {
    version: HINTS_VERSION,
    api: { setRequestHint: (sid, hint) => writes.push({ sessionId: sid, hint }) }, // 故意不给 getRequestHint
  }
  t?.after?.(() => {
    if (previous === undefined) delete globalThis[HINTS_SYMBOL]
    else globalThis[HINTS_SYMBOL] = previous
  })
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, { roleOf: () => 'subagent' })
  const { request, next, calls } = makeRequest({ sessionId: 'sess-old' })
  assert.equal(result.handler(request, next), 'STREAM')
  assert.equal(calls.next, 1)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].hint.billing_tier, 'free_only')
  assert.equal(result.stats.existingUnavailable, 1)
})

test('getRequestHint 抛错 ⇒ 照常写 next（fail-open），统计里留痕', (t) => {
  const { writes, api } = installFakeRegistry(t)
  const original = api.getRequestHint
  api.getRequestHint = () => { throw new Error('registry get broke') }
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, { roleOf: () => 'main' })
  const { request, next, calls } = makeRequest({ sessionId: 'sess-gerr' })
  assert.equal(result.handler(request, next), 'STREAM')
  assert.equal(calls.next, 1)
  assert.equal(result.stats.existingReadErrors, 1)
  assert.equal(writes.at(-1).hint.billing_tier, 'paid_allowed')
  api.getRequestHint = original
})

// ── 10. ★ 缺陷回归：claim 的任务授权不被后续请求覆盖 ──────────────────────────

test('★ claim(requires_paid:true) 后连续 3 次 llm/stream 请求：每次前后 hint 都是 paid_allowed', (t) => {
  const { writes, api } = installFakeRegistry(t)
  const { kernel } = fakeKernel()
  let clock = 1_700_000_000_000
  // roleOf 恒为 subagent：若没有 mergeHint，每次请求都会算成 free_only 并踩掉授权（缺陷现场）
  const result = installLlmStreamHint({}, kernel, {
    roleOf: () => 'subagent',
    now: () => (clock += 1_000),
  })

  // claim 的副作用（bot_task_update action=claim 走的就是这个函数）
  const granted = applyTaskHint(
    { id: 't-9', expectedComplexity: 'T3', requiresPaid: true },
    'sess-claimed',
    { now: clock },
  )
  assert.equal(granted.ok, true)
  assert.equal(granted.hint.billing_tier, 'paid_allowed')

  for (let i = 1; i <= 3; i += 1) {
    const before = api.getRequestHint('sess-claimed')
    assert.equal(before?.billing_tier, 'paid_allowed', `第 ${i} 次请求**之前** hint 必须是 paid_allowed`)
    const { request, next, calls } = makeRequest({ sessionId: 'sess-claimed' })
    assert.equal(result.handler(request, next), 'STREAM')
    assert.equal(calls.next, 1)
    const after = api.getRequestHint('sess-claimed')
    assert.equal(after.billing_tier, 'paid_allowed', `第 ${i} 次请求**之后**不得被覆盖成 free_only`)
    assert.equal(after.requires_paid, true)
  }
  assert.equal(result.stats.carriedTaskAuth, 3, '三次请求都应识别为「延续任务授权」')
  assert.equal(writes.length, 4, '1 次任务授权 + 3 次请求写入')
})

test('对照：没有任务授权时，子智能体的请求就是 free_only（证明上一条不是硬编码 paid）', (t) => {
  const { api } = installFakeRegistry(t)
  const { kernel } = fakeKernel()
  const result = installLlmStreamHint({}, kernel, { roleOf: () => 'subagent' })
  for (let i = 0; i < 3; i += 1) {
    const { request, next } = makeRequest({ sessionId: 'sess-plain' })
    result.handler(request, next)
    assert.equal(api.getRequestHint('sess-plain').billing_tier, 'free_only')
  }
  assert.equal(result.stats.carriedTaskAuth, 0)
})
