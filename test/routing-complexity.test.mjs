/**
 * 复杂度分类器测试（契约 §6）—— 纯函数，**零宿主依赖**，只碰 `node:test` + `node:assert`。
 *
 * 覆盖策略（表驱动，逐档给证据而不是「没抛错」）：
 *   1. 五个信号**各自单独命中**（含门限边界）；
 *   2. 优先级：`explicitComplexity` 覆盖一切；非法显式值退回打分并留审计记录；
 *   3. 边界：无信号 / 全信号 / 非法类型（字符串、NaN、Infinity、null）/ 未知角色；
 *   4. `billingTierFor` 的 fail-closed 口径；`pickModelForTier` 的分层选择。
 *
 * 运行：`node --test test/routing-complexity.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPLEXITY,
  COMPLEXITY_TIERS,
  billingTierFor,
  classifyComplexity,
  normalizeRole,
  normalizeTier,
  pickModelForTier,
} from '../src/routing/complexity.js'

// ── 1. 档位常量 ──────────────────────────────────────────────────────────────

test('COMPLEXITY：四档字面量与契约 §6 完全一致，且冻结不可改', () => {
  assert.deepEqual({ ...COMPLEXITY }, { T0: 'T0', T1: 'T1', T2: 'T2', T3: 'T3' })
  assert.deepEqual([...COMPLEXITY_TIERS], ['T0', 'T1', 'T2', 'T3'])
  assert.equal(Object.isFrozen(COMPLEXITY), true)
})

test('normalizeTier / normalizeRole：大小写与空白归一，非法值返回 null / unknown', () => {
  assert.equal(normalizeTier('t2'), 'T2')
  assert.equal(normalizeTier('  T3 '), 'T3')
  for (const bad of ['T4', 't', '', '  ', 3, null, undefined, {}, []]) {
    assert.equal(normalizeTier(bad), null, `normalizeTier(${JSON.stringify(bad)}) 应为 null`)
  }
  assert.equal(normalizeRole('MAIN'), 'main')
  assert.equal(normalizeRole('SubAgent'), 'subagent')
  for (const bad of ['root', '', 1, null, undefined, {}]) {
    assert.equal(normalizeRole(bad), 'unknown', `normalizeRole(${JSON.stringify(bad)}) 应为 unknown`)
  }
})

// ── 2. 无信号 / 全信号 ───────────────────────────────────────────────────────

test('无信号（空对象 / undefined / null / 非对象）：一律 T0、score=0，且 reasons 给出可审计说明', () => {
  for (const input of [{}, undefined, null, 42, 'x', []]) {
    const r = classifyComplexity(input)
    assert.equal(r.tier, 'T0', `输入 ${JSON.stringify(input)} 应为 T0`)
    assert.equal(r.score, 0)
    assert.ok(r.reasons.length >= 1, 'reasons 不能为空（否则不可审计）')
    assert.equal(r.signals.contextTokens, null)
    assert.equal(r.signals.historyDepth, null)
    assert.equal(r.signals.hasToolCalls, null)
    assert.equal(r.signals.agentRole, 'unknown')
    assert.equal(r.signals.explicitComplexity, null)
  }
})

test('全信号（长上下文 + 多轮 + 带工具 + 主 Agent）：score=0.92 → T3', () => {
  const r = classifyComplexity({
    contextTokens: 200_000,
    historyDepth: 80,
    hasToolCalls: true,
    agentRole: 'main',
  })
  assert.equal(r.score, 0.92)
  assert.equal(r.tier, 'T3')
  // 四条信号每条都有独立一句话（不是一句合并）
  assert.equal(r.reasons.filter((x) => x.includes('+')).length, 4, `reasons=${JSON.stringify(r.reasons)}`)
  assert.match(r.reasons.join('\n'), /200000/)
  assert.match(r.reasons.join('\n'), /historyDepth=80/)
})

// ── 3. 单信号表驱动（含门限边界）──────────────────────────────────────────────

const SINGLE_CASES = [
  // [名称, signals, 期望 tier, 期望 score]
  ['contextTokens 低于最小门限 → 不加分', { contextTokens: 15_999 }, 'T0', 0],
  ['contextTokens 命中第一档（16000）', { contextTokens: 16_000 }, 'T1', 0.15],
  ['contextTokens 命中第二档（48000）', { contextTokens: 48_000 }, 'T1', 0.28],
  ['contextTokens 命中第三档（120000）→ T2', { contextTokens: 120_000 }, 'T2', 0.4],
  ['historyDepth 命中第一档（6）→ 仍 T0', { historyDepth: 6 }, 'T0', 0.07],
  ['historyDepth 命中第二档（16）→ T1', { historyDepth: 16 }, 'T1', 0.15],
  ['historyDepth 命中第三档（40）→ T1', { historyDepth: 40 }, 'T1', 0.25],
  ['hasToolCalls=true → T1', { hasToolCalls: true }, 'T1', 0.15],
  ['agentRole=main → T0（0.12 未过 T1 线）', { agentRole: 'main' }, 'T0', 0.12],
  ['agentRole=subagent → 不加分', { agentRole: 'subagent' }, 'T0', 0],
  ['agentRole=root（未知角色）→ 不加分', { agentRole: 'root' }, 'T0', 0],
  ['三档信号叠加（16000+6+tool）→ T1 0.37', { contextTokens: 16_000, historyDepth: 6, hasToolCalls: true }, 'T1', 0.37],
]

for (const [name, signals, tier, score] of SINGLE_CASES) {
  test(`单信号：${name}`, () => {
    const r = classifyComplexity(signals)
    assert.equal(r.score, score, `score 应为 ${score}，reasons=${JSON.stringify(r.reasons)}`)
    assert.equal(r.tier, tier)
  })
}

test('分数上界：四条信号权重和为 0.92，任何合法输入都不会 >1（score 契约 ∈ [0,1]）', () => {
  const r = classifyComplexity({
    contextTokens: 1_000_000,
    historyDepth: 1_000,
    hasToolCalls: true,
    agentRole: 'main',
  })
  assert.equal(r.score, 0.92)
  assert.ok(r.score <= 1 && r.score >= 0)
  assert.equal(r.tier, 'T3')
})

// ── 4. 非法输入一律「视为无此信号」（不抛、不猜）────────────────────────────────

test('非法类型信号：字符串数字 / NaN / Infinity / 布尔字符串 一律忽略，不参与打分', () => {
  const r = classifyComplexity({
    contextTokens: '30000',
    historyDepth: Number.NaN,
    hasToolCalls: 'yes',
    agentRole: 7,
  })
  assert.equal(r.score, 0)
  assert.equal(r.tier, 'T0')
  assert.equal(r.signals.contextTokens, null, '字符串数字不认（避免隐式强转改变路由）')
  assert.equal(r.signals.historyDepth, null, 'NaN 不认')
  assert.equal(r.signals.hasToolCalls, null, "布尔字符串 'yes' 不认")
  assert.equal(r.signals.agentRole, 'unknown')

  const inf = classifyComplexity({ contextTokens: Number.POSITIVE_INFINITY })
  assert.equal(inf.score, 0, 'Infinity 不是有限数字 ⇒ 忽略')
})

// ── 5. 优先级：显式档位覆盖一切 ────────────────────────────────────────────────

test('explicitComplexity 覆盖信号打分：最低信号 + 显式 T3 ⇒ 直接 T3，且 reasons 说明来源', () => {
  const r = classifyComplexity({ explicitComplexity: 'T3' })
  assert.equal(r.tier, 'T3')
  assert.equal(r.score, 1)
  assert.match(r.reasons.join('\n'), /显式指定复杂度 T3/)
  assert.equal(r.signals.explicitComplexity, 'T3')
})

test('explicitComplexity 覆盖信号打分：全信号 + 显式 T0 ⇒ 直接 T0（信号只留档不生效）', () => {
  const r = classifyComplexity({
    contextTokens: 200_000,
    historyDepth: 80,
    hasToolCalls: true,
    agentRole: 'main',
    explicitComplexity: 't0',
  })
  assert.equal(r.tier, 'T0')
  assert.equal(r.score, 0)
  // 信号本身仍被记录（审计用），但没有任何「+权重」原因
  assert.equal(r.signals.contextTokens, 200_000)
  assert.equal(r.signals.historyDepth, 80)
  assert.equal(r.reasons.filter((x) => x.includes('+')).length, 0)
})

test('explicitComplexity 非法（T9 / 数字）：不静默吞掉 —— 退回打分，并在 reasons 留「已忽略」', () => {
  const r = classifyComplexity({ explicitComplexity: 'T9', hasToolCalls: true })
  assert.equal(r.tier, 'T1', '退回信号打分：hasToolCalls → 0.15 → T1')
  assert.match(r.reasons.join('\n'), /"T9" 非法/)
  assert.equal(r.signals.explicitComplexity, null)

  const numeric = classifyComplexity({ explicitComplexity: 3 })
  assert.equal(numeric.tier, 'T0')
  assert.match(numeric.reasons.join('\n'), /非法/)
})

// ── 6. 纯函数性 ──────────────────────────────────────────────────────────────

test('纯函数：同输入必同输出，且不修改入参（路由判定必须可复现）', () => {
  const signals = { contextTokens: 50_000, historyDepth: 20, hasToolCalls: true, agentRole: 'main' }
  const snapshot = JSON.stringify(signals)
  const a = classifyComplexity(signals)
  const b = classifyComplexity(signals)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(signals), snapshot, '入参不得被修改')
})

// ── 7. billingTierFor：fail-closed ───────────────────────────────────────────

test('billingTierFor：main 或 requiresPaid=true ⇒ paid_allowed；其余一律 free_only', () => {
  const cases = [
    [{ role: 'main' }, 'paid_allowed'],
    [{ role: 'MAIN' }, 'paid_allowed'],
    [{ role: 'subagent', requiresPaid: true }, 'paid_allowed'],
    [{ role: 'unknown', requiresPaid: true }, 'paid_allowed'],
    [{ requiresPaid: true }, 'paid_allowed'],
    [{ role: 'subagent' }, 'free_only'],
    [{ role: 'unknown' }, 'free_only'],
    [{ tier: 'T3', role: 'subagent', requiresPaid: false }, 'free_only'],
    [{}, 'free_only'],
    [undefined, 'free_only'],
    [null, 'free_only'],
    [{ role: 'main', requiresPaid: 'true' }, 'paid_allowed'], // 角色优先
    [{ role: 'root', requiresPaid: 'true' }, 'free_only'], // 字符串 'true' 不算授权
  ]
  for (const [input, expected] of cases) {
    assert.equal(
      billingTierFor(input),
      expected,
      `billingTierFor(${JSON.stringify(input)}) 应为 ${expected}`,
    )
  }
})

// ── 8. pickModelForTier：分层选择 ─────────────────────────────────────────────

const CHAIN = [
  { provider: 'p-paid', model: 'm-paid', tier: 1, billing: 'paid' },
  { provider: 'p-free', model: 'm-free', tier: 1, billing: 'free' },
  { provider: 'p-unknown', model: 'm-unknown', tier: 2, billing: 'unknown' },
]

test('pickModelForTier：T0/T1 跳过 paid（unknown 按免费处理，与准入器成本保守口径一致）', () => {
  assert.equal(pickModelForTier('T0', CHAIN).provider, 'p-free')
  assert.equal(pickModelForTier('T1', CHAIN).provider, 'p-free')

  const unknownFirst = [
    { provider: 'p-unknown', model: 'm', billing: 'unknown' },
    { provider: 'p-free', model: 'm2', billing: 'free' },
  ]
  assert.equal(pickModelForTier('T1', unknownFirst).provider, 'p-unknown')

  const noBilling = [{ provider: 'p-bare', model: 'm' }]
  assert.equal(pickModelForTier('T1', noBilling).provider, 'p-bare', 'billing 缺失按非 paid 处理')
})

test('pickModelForTier：T0/T1 全 paid ⇒ null（绝不偷偷选 paid）；T2/T3 同序取第一个', () => {
  const allPaid = CHAIN.filter((c) => c.billing === 'paid')
  assert.equal(pickModelForTier('T0', allPaid), null)
  assert.equal(pickModelForTier('T1', allPaid), null)

  assert.equal(pickModelForTier('T2', CHAIN).provider, 'p-paid', 'T2 同序：付费由 cs-myfree 按 hint 过滤')
  assert.equal(pickModelForTier('T3', CHAIN).provider, 'p-paid')
})

test('pickModelForTier：边界 —— 空数组 / 非法档位 / 非对象元素 ⇒ null 或跳过', () => {
  assert.equal(pickModelForTier('T1', []), null)
  assert.equal(pickModelForTier('T1'), null)
  assert.equal(pickModelForTier('T9', CHAIN), null, '非法档位不猜默认档')
  assert.equal(pickModelForTier(null, CHAIN), null)
  assert.equal(pickModelForTier('T1', [null, 'x', 3, [], { provider: 'p-ok', billing: 'free' }]).provider, 'p-ok')
  assert.equal(pickModelForTier('T1', 'not-an-array'), null)
})
