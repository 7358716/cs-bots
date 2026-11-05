/**
 * cs-bots 复杂度分类器 —— **纯函数，零 I/O，零宿主依赖**。
 *
 * 契约：`design/17-并发感知路由层-接口契约-v1.md` §6。
 *
 * 为什么要有这一层：cs-myfree 的准入流水线只会问「这条请求允许用付费渠道吗」，
 * 它**不知道**这条请求值不值付费。判定必须发生在平台侧（这里），因为只有平台
 * 知道「这是主 Agent 的规划回合还是子智能体的一个窄任务」。于是：
 *
 *   请求信号 → classifyComplexity() → T0..T3 → billingTierFor() → 'free_only' | 'paid_allowed'
 *                                                            ↓
 *                                            旁路注册表 hint（见 ./hints.js）
 *
 * 设计纪律（本文件被 `test/ci-zero-dep.sh` 检查 1 覆盖）：
 *   1. **不 import 任何宿主包**（也不 import kernel.js —— 纯函数便于离线表驱动测试）。
 *   2. **全部确定性**：同一输入必得同一输出；不含 Date.now / 随机 / 环境变量。
 *   3. **可审计**：`reasons` 逐条给出「哪条信号把分数推到哪」，不出现「可能/大概」。
 *
 * 接口版本：v1（2026-11-04，与契约 §6 同步）。
 */

/** 复杂度档位（契约 §6 冻结）。 */
export const COMPLEXITY = Object.freeze({ T0: 'T0', T1: 'T1', T2: 'T2', T3: 'T3' })

/** 档位升序表（越靠后越复杂）。 */
export const COMPLEXITY_TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3'])

/** 合法 agent 角色（契约 §3 hint 形状）。 */
const AGENT_ROLES = Object.freeze(['main', 'subagent', 'unknown'])

/**
 * 分档阈值（score ∈ [0,1]）：`score < 0.15` → T0，`< 0.40` → T1，
 * `< 0.70` → T2，否则 T3。阈值是**常量而非配置**：路由档位一旦可配，
 * 「为什么这条走了付费」就无从复现（可审计性优先于灵活性）。
 */
const TIER_CUTOFFS = Object.freeze([
  { tier: 'T0', below: 0.15 },
  { tier: 'T1', below: 0.40 },
  { tier: 'T2', below: 0.70 },
  // score >= 0.70 → T3
])

/**
 * 信号权重表 —— 每条信号贡献多少分，以及触发的门限。
 *
 * 口径说明（为什么是这些数）：
 *   - `contextTokens`：上下文越长，失败一次越贵（重试成本 × token 量），故权重最高；
 *     token 数用「字符数 / 4」粗估（见 ./hints.js 的 estimateContextTokens），
 *     所以门限用**数量级**而不是实测精确值。
 *   - `historyDepth`：消息条数反映「已经绕了多少圈」，多轮 = 更可能需要强模型。
 *   - `hasToolCalls`：带工具的请求是多步任务的最小证据。
 *   - `agentRole`：`main` 是规划/验收方，值得付费；`subagent` 是窄执行者，默认免费。
 */
const SIGNAL_RULES = Object.freeze({
  contextTokens: [
    { atLeast: 120_000, weight: 0.40, label: '上下文极长' },
    { atLeast: 48_000, weight: 0.28, label: '上下文很长' },
    { atLeast: 16_000, weight: 0.15, label: '上下文偏长' },
  ],
  historyDepth: [
    { atLeast: 40, weight: 0.25, label: '历史轮次很多' },
    { atLeast: 16, weight: 0.15, label: '历史轮次较多' },
    { atLeast: 6, weight: 0.07, label: '历史轮次偏多' },
  ],
  hasToolCalls: { weight: 0.15, label: '请求带工具（多步任务）' },
  agentRole: { main: { weight: 0.12, label: '主 Agent 回合（规划/验收）' } },
})

// ── 归一化小工具 ────────────────────────────────────────────────────────────

/**
 * 把任意值归一成合法档位；非法返回 `null`（**不抛**，分类器永不因脏输入崩）。
 * @param {unknown} value
 * @returns {'T0'|'T1'|'T2'|'T3'|null}
 */
export function normalizeTier(value) {
  if (typeof value !== 'string') return null
  const v = value.trim().toUpperCase()
  return COMPLEXITY_TIERS.includes(v) ? v : null
}

/**
 * 归一化 agent 角色：除 `'main'` / `'subagent'` 外一律 `'unknown'`（fail-safe 展示口径）。
 * @param {unknown} value
 * @returns {'main'|'subagent'|'unknown'}
 */
export function normalizeRole(value) {
  if (typeof value !== 'string') return 'unknown'
  const v = value.trim().toLowerCase()
  return AGENT_ROLES.includes(v) ? /** @type {any} */ (v) : 'unknown'
}

/** 有限数字才认；其它（null/NaN/字符串/'12'/Infinity）一律视为「无此信号」。 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 布尔才认；其它视为无信号。 */
function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

/** 按阈值表取「最大命中的那一档」权重（表内按 atLeast 降序，便于阅读）。 */
function weightFor(value, rules) {
  if (value === null) return null
  // 不假设调用方按顺序传入：按 atLeast 降序挑第一个满足的
  const sorted = [...rules].sort((a, b) => b.atLeast - a.atLeast)
  const hit = sorted.find((rule) => value >= rule.atLeast)
  return hit ?? null
}

// ── 分类 ────────────────────────────────────────────────────────────────────

/**
 * 把请求信号分类到 T0–T3。
 *
 * **优先级**：`explicitComplexity` 最高 —— 调用方/任务标注一旦显式给出合法档位，
 * 信号分数**完全不参与**（只作为审计信息保留在 `signals` 里），因为「规划 Agent 已经
 * 决定这是 T3」比任何启发式都更可信。给非法显式值时不静默吞掉：退回信号打分，
 * 并在 `reasons` 里留下 `忽略` 记录（可审计）。
 *
 * @param {{
 *   contextTokens?: number, historyDepth?: number, hasToolCalls?: boolean,
 *   agentRole?: string, explicitComplexity?: string,
 * }} [signals]
 * @returns {{
 *   tier: 'T0'|'T1'|'T2'|'T3',
 *   score: number,
 *   reasons: string[],
 *   signals: { contextTokens: number|null, historyDepth: number|null,
 *              hasToolCalls: boolean|null, agentRole: string, explicitComplexity: string|null },
 * }}
 */
export function classifyComplexity(signals = {}) {
  const input = signals && typeof signals === 'object' ? signals : {}
  const contextTokens = finiteOrNull(input.contextTokens)
  const historyDepth = finiteOrNull(input.historyDepth)
  const hasToolCalls = boolOrNull(input.hasToolCalls)
  const agentRole = normalizeRole(input.agentRole)
  const explicitRaw = input.explicitComplexity
  const explicitTier = normalizeTier(explicitRaw)

  /** @type {string[]} */
  const reasons = []

  // ── 优先级 1：显式档位 ────────────────────────────────────────────────────
  if (explicitTier) {
    const idx = COMPLEXITY_TIERS.indexOf(explicitTier)
    reasons.push(
      `显式指定复杂度 ${explicitTier}（来源：任务标注/调用方），已直接定档，忽略信号打分`,
    )
    return {
      tier: explicitTier,
      // 让分数与档位自洽：T0=0 / T1=1/3 / T2=2/3 / T3=1（纯审计用途）
      score: Number((idx / (COMPLEXITY_TIERS.length - 1)).toFixed(3)),
      reasons,
      signals: {
        contextTokens,
        historyDepth,
        hasToolCalls,
        agentRole,
        explicitComplexity: explicitTier,
      },
    }
  }
  if (explicitRaw !== undefined && explicitRaw !== null && explicitRaw !== '') {
    reasons.push(
      `显式复杂度 ${JSON.stringify(explicitRaw)} 非法（合法值：${COMPLEXITY_TIERS.join(' | ')}）——已忽略，退回信号打分`,
    )
  }

  // ── 优先级 2：信号打分 ────────────────────────────────────────────────────
  let score = 0

  const ctxHit = weightFor(contextTokens, SIGNAL_RULES.contextTokens)
  if (ctxHit) {
    score += ctxHit.weight
    reasons.push(`${ctxHit.label}（contextTokens≈${contextTokens} ≥ ${ctxHit.atLeast}）：+${ctxHit.weight}`)
  }

  const histHit = weightFor(historyDepth, SIGNAL_RULES.historyDepth)
  if (histHit) {
    score += histHit.weight
    reasons.push(`${histHit.label}（historyDepth=${historyDepth} ≥ ${histHit.atLeast}）：+${histHit.weight}`)
  }

  if (hasToolCalls === true) {
    score += SIGNAL_RULES.hasToolCalls.weight
    reasons.push(`${SIGNAL_RULES.hasToolCalls.label}：+${SIGNAL_RULES.hasToolCalls.weight}`)
  }

  if (agentRole === 'main') {
    score += SIGNAL_RULES.agentRole.main.weight
    reasons.push(`${SIGNAL_RULES.agentRole.main.label}：+${SIGNAL_RULES.agentRole.main.weight}`)
  }

  score = Math.max(0, Math.min(1, score))
  const rounded = Number(score.toFixed(3))
  const cutoff = TIER_CUTOFFS.find((c) => rounded < c.below)
  const tier = cutoff ? cutoff.tier : 'T3'

  if (reasons.length === 0) {
    reasons.push('无命中信号（无上下文/tool/角色证据）⇒ 最低档 T0')
  }
  reasons.push(`合计 score=${rounded} ⇒ ${tier}`)

  return {
    tier,
    score: rounded,
    reasons,
    signals: {
      contextTokens,
      historyDepth,
      hasToolCalls,
      agentRole,
      explicitComplexity: null,
    },
  }
}

// ── 授权标签 / 模型选择 ──────────────────────────────────────────────────────

/**
 * 复杂度 + 角色 + 显式诉求 → 付费授权标签（契约 §6）。
 *
 * **fail-closed 是刻意的**：只有 `role === 'main'`（规划/验收方）或任务显式标了
 * `requiresPaid: true` 才给 `paid_allowed`；其余一律 `free_only`。理由：误判成付费
 * 只会多花钱，误判成免费只是慢一点 —— 两者的代价不对称。
 *
 * @param {{ tier?: string, role?: string, requiresPaid?: boolean }} [input]
 * @returns {'free_only'|'paid_allowed'}
 */
export function billingTierFor(input = {}) {
  const role = normalizeRole(input?.role)
  if (role === 'main') return 'paid_allowed'
  if (input?.requiresPaid === true) return 'paid_allowed'
  return 'free_only'
}

/**
 * 分层模型选择（契约 §6）。
 *
 * - `T0` / `T1`：**只**在 `billing !== 'paid'` 的候选里选（`unknown` 按免费处理，
 *   与 cs-myfree 准入器的成本保守口径一致）。
 * - `T2` / `T3`：**同序**取第一个候选 —— 真正的付费过滤由 cs-myfree 按 hint 的
 *   `billing_tier` 决定，平台侧不越权（避免两处授权口径打架）。
 *
 * @param {'T0'|'T1'|'T2'|'T3'} tier
 * @param {Array<{ provider?: string, model?: string, tier?: string, billing?: string }>} [candidates]
 * @returns {object|null} 中选候选（原对象引用），无可选返回 `null`
 */
export function pickModelForTier(tier, candidates = []) {
  const t = normalizeTier(tier)
  if (!t) return null
  const list = Array.isArray(candidates)
    ? candidates.filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    : []
  if (list.length === 0) return null
  if (t === 'T0' || t === 'T1') {
    return list.find((c) => c.billing !== 'paid') ?? null
  }
  return list[0]
}

export default classifyComplexity
