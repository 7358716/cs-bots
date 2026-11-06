/**
 * cs-bots — 子智能体路由跟随策略测试（`design/22` 契约 E4）
 *
 * 这一层的核心风险是**跨仓交叉兼容**：cs-bots 与 cs-myfree 的版本必然错开升级。
 * 所以每条用例都在断言「旧形状仍然可读、新键只在被声明时出现、未知键被丢弃」：
 *   1. **零回归**：没有 `subagentRouting` 时 hint 仍是**恰好六键**（v1 形状逐字不变）；
 *   2. 三选项：follow ⇒ `follow_parent_routing:true` 并继承上级授权；
 *              pinned ⇒ `follow_parent_routing:false` + `pinned_model`；
 *              auto ⇒ `follow_parent_routing:false`，不钉模型；
 *   3. 非法值 ⇒ 该键**不出现**（不是报错、不是写脏值）；
 *   4. 未知键 ⇒ 丢弃（`pickHintKeys` 出口白名单），绝不抛；
 *   5. `mergeHint`：声明式策略键「本次没声明就继承既有」，授权仍「只升不降」；
 *   6. `billingTierFor` 的 follow 继承 + 无上级/无配置时 fail-closed。
 *
 * 运行：`node --test test/routing-subagent.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HINTS_SYMBOL,
  HINTS_VERSION,
  HINT_KEYS_V1,
  HINT_KEYS_V2,
  KNOWN_HINT_KEYS,
  SOURCE_LLM_STREAM,
  SOURCE_TASK_BOARD,
  applyTaskHint,
  installLlmStreamHint,
  mergeHint,
  normalizeFollowParentRouting,
  normalizePinnedModel,
  pickHintKeys,
  resolveHint,
  subagentRoutingKeys,
} from '../src/routing/hints.js'

import {
  SUBAGENT_MODES,
  billingTierFor,
  normalizeBillingTier,
  normalizeSubagentMode,
} from '../src/routing/complexity.js'

/** 造一个合法请求（provider = cs-myfree 才会写 hint）。 */
const req = (over = {}) => ({
  provider: 'cs-myfree',
  sessionId: 'sess-sub-1',
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
})

const SUB_TASK_MODE = { role: 'subagent', requiresPaid: false, now: 1_700_000_000_000 }

// ── ① 版本与键表 ─────────────────────────────────────────────────────────────

test('契约 E4：HINTS_VERSION 升到 2，键表 = v1 六键 + v2 两键', () => {
  assert.equal(HINTS_VERSION, 2)
  assert.deepEqual([...HINT_KEYS_V1], [
    'billing_tier', 'complexity_tier', 'agent_role', 'requires_paid', 'source', 'at',
  ])
  assert.deepEqual([...HINT_KEYS_V2], ['follow_parent_routing', 'pinned_model'])
  assert.deepEqual([...KNOWN_HINT_KEYS], [...HINT_KEYS_V1, ...HINT_KEYS_V2])
})

// ── ② 零回归：没有策略配置时形状与今天逐字一致 ───────────────────────────────

test('★ 零回归：未配置 subagentRouting ⇒ hint 仍恰好六键（v1 形状不变）', () => {
  const hint = resolveHint(req(), SUB_TASK_MODE)
  assert.deepEqual(Object.keys(hint).sort(), [
    'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
  ])
  assert.equal(hint.follow_parent_routing, undefined, '没声明就不该出现（不是 null）')
  assert.equal(hint.pinned_model, undefined)
  assert.equal(hint.billing_tier, 'free_only', '子智能体默认仍 free_only（fail-closed）')
  assert.equal(hint.source, SOURCE_LLM_STREAM)

  // 非对象/垃圾配置同理：不能因为"配置读不到"就写出多余键
  for (const bad of [null, undefined, 'x', [], 42, {}]) {
    const h = resolveHint(req(), { ...SUB_TASK_MODE, subagentRouting: bad })
    assert.deepEqual(Object.keys(h).sort(), [
      'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
    ], `subagentRouting=${JSON.stringify(bad)} 时应保持六键`)
  }
})

// ── ③ 三选项各自行为 ────────────────────────────────────────────────────────

test('契约 E3 选项三：mode=follow ⇒ follow_parent_routing:true，且继承上级授权', () => {
  const paid = resolveHint(req(), {
    ...SUB_TASK_MODE,
    subagentRouting: { mode: 'follow', fallback: 'global' },
    parentBillingTier: 'paid_allowed',
  })
  assert.equal(paid.follow_parent_routing, true)
  assert.equal(paid.pinned_model, undefined, 'follow 不钉模型')
  assert.equal(paid.billing_tier, 'paid_allowed', 'follow ⇒ 继承上级的付费授权')

  // 上级也未知 ⇒ fail-closed 回 free_only（不能因为"说是跟随"就凭空放行）
  const orphan = resolveHint(req(), { ...SUB_TASK_MODE, subagentRouting: { mode: 'follow' } })
  assert.equal(orphan.billing_tier, 'free_only')
  assert.equal(orphan.follow_parent_routing, true)

  const parentFree = resolveHint(req(), {
    ...SUB_TASK_MODE,
    subagentRouting: { mode: 'follow' },
    parentBillingTier: 'free_only',
  })
  assert.equal(parentFree.billing_tier, 'free_only', '上级是免费 ⇒ 子也是免费（继承不是升级）')
})

test('契约 E3 选项二：mode=pinned ⇒ 不跟随 + pinned_model 固定模型', () => {
  const hint = resolveHint(req(), {
    ...SUB_TASK_MODE,
    subagentRouting: { mode: 'pinned', model: 'deepseek/deepseek-chat', fallback: 'scope' },
  })
  assert.equal(hint.follow_parent_routing, false, '明确「不跟随」')
  assert.equal(hint.pinned_model, 'deepseek/deepseek-chat')
  assert.equal(hint.billing_tier, 'free_only', 'pinned 只定模型，不改授权口径')

  // pinned 但没给 model ⇒ 不发 pinned_model（不写脏值），follow 仍是 false
  const noModel = resolveHint(req(), { ...SUB_TASK_MODE, subagentRouting: { mode: 'pinned' } })
  assert.equal(noModel.follow_parent_routing, false)
  assert.equal(noModel.pinned_model, undefined)
})

test('契约 E3 选项一：mode=auto ⇒ follow_parent_routing:false，不钉模型（今天的行为）', () => {
  const hint = resolveHint(req(), {
    ...SUB_TASK_MODE,
    subagentRouting: { mode: 'auto', model: 'p/m' },
  })
  assert.equal(hint.follow_parent_routing, false)
  assert.equal(hint.pinned_model, undefined, 'auto 不钉模型（配置里的 model 只在 pinned 生效）')
  assert.equal(hint.billing_tier, 'free_only')
})

test('subagentRoutingKeys：三选项映射 + 显式声明优先 + 非法值不落键', () => {
  assert.deepEqual(subagentRoutingKeys({ subagentRouting: { mode: 'follow' } }), { follow: true })
  assert.deepEqual(
    subagentRoutingKeys({ subagentRouting: { mode: 'pinned', model: ' p/m ' } }),
    { follow: false, pinned: 'p/m' },
  )
  assert.deepEqual(subagentRoutingKeys({ subagentRouting: { mode: 'auto' } }), { follow: false })
  assert.deepEqual(subagentRoutingKeys({}), {})
  assert.deepEqual(subagentRoutingKeys({ subagentRouting: { mode: 'bogus' } }), {})
  // 显式 followParentRouting / pinnedModel 覆盖 mode 推导
  assert.deepEqual(
    subagentRoutingKeys({ subagentRouting: { mode: 'auto' }, followParentRouting: true }),
    { follow: true },
  )
  assert.deepEqual(
    subagentRoutingKeys({ subagentRouting: { mode: 'pinned', model: 'a/b' }, pinnedModel: 'c/d' }),
    { follow: false, pinned: 'c/d' },
  )
  // 非法显式值 ⇒ 该键不出现
  assert.deepEqual(subagentRoutingKeys({ followParentRouting: 'yes', pinnedModel: 42 }), {})
})

// ── ④ 非法值 / 未知键 ───────────────────────────────────────────────────────

test('非法值归一：normalizeFollowParentRouting / normalizePinnedModel 只认合法形状', () => {
  assert.equal(normalizeFollowParentRouting(true), true)
  assert.equal(normalizeFollowParentRouting(false), false)
  for (const bad of [undefined, null, 'true', 1, 0, {}, []]) {
    assert.equal(normalizeFollowParentRouting(bad), undefined, `${JSON.stringify(bad)} ⇒ 不发该键`)
  }
  assert.equal(normalizePinnedModel(' a/b '), 'a/b')
  for (const bad of [undefined, null, '', '   ', 7, {}, [], 'a b', 'bad\u0000ctrl']) {
    assert.equal(normalizePinnedModel(bad), undefined, `${JSON.stringify(bad)} ⇒ 不发该键`)
  }
  assert.equal(normalizePinnedModel('x'.repeat(300)).length, 128, '超长截断而不是丢弃')
})

test('★ 未知键必须被丢弃而不是报错（新旧 cs-bots ↔ cs-myfree 交叉兼容）', () => {
  const dirty = {
    billing_tier: 'paid_allowed',
    complexity_tier: 'T2',
    agent_role: 'subagent',
    requires_paid: true,
    source: SOURCE_TASK_BOARD,
    at: 1,
    unknown_key: 'drop me',
    granted_at: 2,
    mode: 'follow',
  }
  const clean = pickHintKeys(dirty)
  assert.deepEqual(Object.keys(clean).sort(), [
    'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
  ])
  assert.equal(pickHintKeys(null).constructor, Object)
  assert.deepEqual(pickHintKeys(undefined), {})
  assert.deepEqual(pickHintKeys('x'), {})

  // mergeHint 出口同样白名单：既有 hint 里的脏键不会传染给写回值
  const merged = mergeHint(
    { ...dirty, follow_parent_routing: true },
    { billing_tier: 'free_only', complexity_tier: 'T1', agent_role: 'subagent', requires_paid: false, source: SOURCE_LLM_STREAM, at: 3 },
    { now: 3 },
  )
  assert.equal(merged.unknown_key, undefined, '未知键不得写回注册表')
  assert.equal(merged.granted_at, undefined)
  assert.equal(merged.mode, undefined)
  assert.equal(merged.billing_tier, 'paid_allowed', '授权仍按"只升不降"保留')
  assert.equal(merged.follow_parent_routing, true, '策略键继承既有')
})

// ── ⑤ mergeHint：策略键继承 vs 授权只升不降 ─────────────────────────────────

test('mergeHint：本次未声明策略 ⇒ 继承既有策略键（防策略抖动 ⇒ 选路抖动）', () => {
  const existing = {
    billing_tier: 'paid_allowed',
    complexity_tier: 'T3',
    agent_role: 'subagent',
    requires_paid: true,
    source: SOURCE_TASK_BOARD,
    at: 1_000,
    follow_parent_routing: true,
    pinned_model: 'p/m',
  }
  const next = {
    billing_tier: 'free_only',
    complexity_tier: 'T1',
    agent_role: 'subagent',
    requires_paid: false,
    source: SOURCE_LLM_STREAM,
    at: 1_060,
  }
  const merged = mergeHint(existing, next, { now: next.at })
  assert.equal(merged.billing_tier, 'paid_allowed', '授权不得被踩成 free_only')
  assert.equal(merged.follow_parent_routing, true, '策略键继承既有')
  assert.equal(merged.pinned_model, 'p/m')
  assert.equal(merged.complexity_tier, 'T1', '复杂度用本次新鲜值')

  // 本次显式声明 ⇒ 本次为准（声明式覆盖，不是"只升不降"）
  const overridden = mergeHint(existing, { ...next, follow_parent_routing: false, pinned_model: 'q/m' }, { now: next.at })
  assert.equal(overridden.follow_parent_routing, false)
  assert.equal(overridden.pinned_model, 'q/m')

  // 既有也没声明 ⇒ 两键都不出现（v1 六键形状）
  const sixOnly = mergeHint(
    { ...existing, follow_parent_routing: undefined, pinned_model: undefined },
    next,
    { now: next.at },
  )
  assert.equal(sixOnly.follow_parent_routing, undefined)
  assert.equal(sixOnly.pinned_model, undefined)
  assert.deepEqual(Object.keys(sixOnly).sort(), [
    'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
  ])
})

// ── ⑥ applyTaskHint / 安装器接线 ────────────────────────────────────────────

test('applyTaskHint：任务级策略写入 hint；不传策略时仍是六键', (t) => {
  const writes = []
  const previous = globalThis[HINTS_SYMBOL]
  globalThis[HINTS_SYMBOL] = {
    version: HINTS_VERSION,
    api: {
      setRequestHint: (sessionId, hint) => writes.push({ sessionId, hint }),
      getRequestHint: () => null,
      clearRequestHint: () => {},
    },
  }
  t.after(() => {
    if (previous === undefined) delete globalThis[HINTS_SYMBOL]
    else globalThis[HINTS_SYMBOL] = previous
  })

  const task = { id: 't-1', expectedComplexity: 'T2', requiresPaid: false }
  const plain = applyTaskHint(task, 'sess-a', { now: 10 })
  assert.equal(plain.ok, true)
  assert.deepEqual(Object.keys(plain.hint).sort(), [
    'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
  ])

  const follow = applyTaskHint(task, 'sess-b', {
    now: 10,
    subagentRouting: { mode: 'follow' },
    parentBillingTier: 'paid_allowed',
  })
  assert.equal(follow.hint.follow_parent_routing, true)
  assert.equal(follow.hint.billing_tier, 'paid_allowed', 'follow ⇒ 继承上级授权')

  const pinned = applyTaskHint(task, 'sess-c', {
    now: 10,
    subagentRouting: { mode: 'pinned', model: 'm/n' },
  })
  assert.equal(pinned.hint.follow_parent_routing, false)
  assert.equal(pinned.hint.pinned_model, 'm/n')

  assert.equal(writes.length, 3)
})

test('installLlmStreamHint：subagentRoutingOf 逐请求解析；抛错按「未配置」处理（fail-open）', async () => {
  const writes = []
  const previous = globalThis[HINTS_SYMBOL]
  globalThis[HINTS_SYMBOL] = {
    version: HINTS_VERSION,
    api: {
      setRequestHint: (sessionId, hint) => writes.push({ sessionId, hint }),
      getRequestHint: () => null,
      clearRequestHint: () => {},
    },
  }
  try {
    const kernel = { onLlmStream: () => true }
    const result = installLlmStreamHint({}, kernel, {
      roleOf: () => 'subagent',
      now: () => 5,
      subagentRoutingOf: (sessionId) => {
        if (sessionId === 'boom') throw new Error('strategy exploded')
        return { mode: 'pinned', model: 'p/m' }
      },
      warnings: [],
    })
    assert.equal(result.installed, true)
    const next = () => 'CHUNKS'
    assert.equal(result.handler(req({ sessionId: 'ok' }), next), 'CHUNKS', '永远 next()（fail-open）')
    assert.equal(writes.at(-1).hint.pinned_model, 'p/m')
    assert.equal(writes.at(-1).hint.follow_parent_routing, false)

    // 策略解析抛错 ⇒ 不写 v2 键，请求照常
    assert.equal(result.handler(req({ sessionId: 'boom' }), next), 'CHUNKS')
    const boomHint = writes.at(-1).hint
    assert.equal(boomHint.follow_parent_routing, undefined)
    assert.equal(boomHint.pinned_model, undefined)
    assert.equal(result.stats.subagentRoutingErrors, 1)
  } finally {
    if (previous === undefined) delete globalThis[HINTS_SYMBOL]
    else globalThis[HINTS_SYMBOL] = previous
  }
})

// ── ⑦ billingTierFor（契约 E4 的唯一授权改动点）──────────────────────────────

test('normalizeSubagentMode / normalizeBillingTier：大小写归一，非法 ⇒ null', () => {
  assert.deepEqual([...SUBAGENT_MODES], ['auto', 'pinned', 'follow'])
  assert.equal(normalizeSubagentMode('FOLLOW'), 'follow')
  assert.equal(normalizeSubagentMode(' pinned '), 'pinned')
  for (const bad of ['inherit', '', 1, null, undefined, {}, []]) {
    assert.equal(normalizeSubagentMode(bad), null)
  }
  assert.equal(normalizeBillingTier(' PAID_ALLOWED '), 'paid_allowed')
  for (const bad of ['paid', '', 1, null, {}]) assert.equal(normalizeBillingTier(bad), null)
})

test('★ 零回归：无 subagentRouting 时 billingTierFor 与今天逐字一致', () => {
  const cases = [
    [{ role: 'main' }, 'paid_allowed'],
    [{ role: 'MAIN', requiresPaid: false }, 'paid_allowed'],
    [{ role: 'subagent' }, 'free_only'],
    [{ role: 'subagent', requiresPaid: true }, 'paid_allowed'],
    [{ role: 'unknown' }, 'free_only'],
    [{ role: 'unknown', requiresPaid: true }, 'paid_allowed'],
    [{}, 'free_only'],
    [undefined, 'free_only'],
    // 顶层已给 subagentRouting 之外的字段也不得改变结果
    [{ role: 'subagent', subagentRouting: null }, 'free_only'],
    [{ role: 'subagent', subagentRouting: { mode: 'bogus' } }, 'free_only'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(billingTierFor(input), expected, `billingTierFor(${JSON.stringify(input)})`)
  }
})

test('契约 E4：follow ⇒ 继承上级授权；auto/pinned ⇒ 现状；无上级 ⇒ fail-closed', () => {
  assert.equal(
    billingTierFor({ role: 'subagent', subagentRouting: { mode: 'follow' }, parentBillingTier: 'paid_allowed' }),
    'paid_allowed',
  )
  assert.equal(
    billingTierFor({ role: 'subagent', subagentRouting: { mode: 'follow' }, parentBillingTier: 'free_only' }),
    'free_only',
    '继承不是升级：上级免费 ⇒ 子免费',
  )
  assert.equal(
    billingTierFor({ role: 'subagent', subagentRouting: { mode: 'follow' } }),
    'free_only',
    '无上级信息 ⇒ fail-closed',
  )
  assert.equal(
    billingTierFor({ role: 'subagent', subagentRouting: { mode: 'follow' }, parentBillingTier: 'garbage' }),
    'free_only',
  )
  // auto / pinned：不继承上级授权（"不跟随"= 不继承 billing_tier）
  for (const mode of ['auto', 'pinned']) {
    assert.equal(
      billingTierFor({ role: 'subagent', subagentRouting: { mode }, parentBillingTier: 'paid_allowed' }),
      'free_only',
      `mode=${mode} 不得继承上级付费授权（只降不升）`,
    )
  }
  // main 永远是 paid_allowed（不受策略影响）
  assert.equal(billingTierFor({ role: 'main', subagentRouting: { mode: 'follow' } }), 'paid_allowed')
  // 任务显式 requiresPaid 依然压过策略
  assert.equal(
    billingTierFor({ role: 'subagent', requiresPaid: true, subagentRouting: { mode: 'auto' } }),
    'paid_allowed',
  )
})
