/**
 * 工具策略（tool policy）—— 2026-11-21 Boss 需求：
 * 「bot 设置可以初始定义使用标准模式或者创造模式或其他，也可以定义工具（工具的使用规则等等）」
 *
 * ## 为什么放在「Bot 档案」而不是预设
 *
 *   预设（agent preset）决定的是**组合层**：会话里挂哪些插件实例。它必须写进 profile 的
 *   `cordis.patch.yml` 并重启 dsh-host，而且**一个预设全局共享**，不能按 Bot 单独裁剪。
 *
 *   而 Boss 要的是「每个 Bot 能单独定义」。所以这里做的是**运行时策略层**：
 *     · 不动组合 ⇒ 不用重启；
 *     · 由宿主装配时把策略翻成 `<cwd>/AGENTS.md` 里的显式条款（工具规则进上下文），
 *       并把强约束（禁止写入/禁止执行）同时落成 Bot 的 permission 做硬拦截。
 *
 * ## 三档「模式」（mode）
 *
 *   | mode      | 中文   | 工具面            | 典型用途 |
 *   |-----------|--------|-------------------|----------|
 *   | standard  | 标准   | 预设给的全集      | 日常开发/测试/运维 |
 *   | creative  | 创造   | 全集 + 优先产出物 | 设计、写作、原型、方案 |
 *   | readonly  | 只读   | 全集但禁写入/执行 | 审计、调研、看板只读巡检 |
 *
 * ## 「工具规则」（rules）
 *
 *   每条规则是**给模型看的显式约束**，不是组合配置：
 *     { tool: 'bash',    allow: false, note: '禁止执行系统命令' }
 *     { tool: 'subagent',allow: true,  note: '仅在需要并行调研时用' }
 *   装配时按「禁止优先、同类合并」写进 AGENTS.md 的「工具使用规则」段。
 *
 * 纯数据 + 纯函数，零依赖，便于测试与跨平台。
 */

/** 合法模式。顺序即 UI 展示顺序。 */
export const BOT_MODES = Object.freeze(['standard', 'creative', 'readonly'])

/** 模式说明（给 UI 与 AGENTS.md 共用，避免两处文案漂移）。 */
export const MODE_META = Object.freeze({
  standard: { id: 'standard', label: '标准模式', desc: '按预设给的工具面工作，读写与执行都允许（受 cwd 边界约束）' },
  creative: { id: 'creative', label: '创造模式', desc: '同标准工具面，但优先产出可用成果（方案、原型、文档、插件），少问多做' },
  readonly: { id: 'readonly', label: '只读模式', desc: '只允许读取与分析，禁止写文件、禁止执行命令、禁止改配置' },
})

/** 工具名白名单（写错要报错，不能静默忽略一条规则）。 */
export const TOOL_NAMES = Object.freeze([
  'bash', 'pwsh', 'fs', 'fs_search', 'jobs', 'schedule', 'skill', 'subagent', 'workflow',
  'web', 'present', 'office', 'todo', 'plan', 'goal', 'ask_user',
])

const MAX_RULES = 32
const MAX_NOTE = 200

/** @returns {{ ok: true, value: { mode: string, rules: object[] } } | { ok: false, code: string, hint: string }} */
export function normalizeToolPolicy(input) {
  if (input === undefined || input === null) return { ok: true, value: { mode: 'standard', rules: [] } }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'BOT_POLICY_BAD_SHAPE', hint: 'toolPolicy 必须是对象 { mode, rules[] }' }
  }
  const mode = input.mode === undefined || input.mode === null || input.mode === ''
    ? 'standard'
    : String(input.mode).trim()
  if (!BOT_MODES.includes(mode)) {
    return { ok: false, code: 'BOT_POLICY_BAD_MODE', hint: `mode 只能是 ${BOT_MODES.join(' | ')}，收到 ${JSON.stringify(mode)}` }
  }
  const rawRules = input.rules === undefined || input.rules === null ? [] : input.rules
  if (!Array.isArray(rawRules)) return { ok: false, code: 'BOT_POLICY_BAD_RULES', hint: 'rules 必须是数组' }
  if (rawRules.length > MAX_RULES) {
    return { ok: false, code: 'BOT_POLICY_TOO_MANY_RULES', hint: `工具规则最多 ${MAX_RULES} 条，收到 ${rawRules.length}` }
  }
  const rules = []
  const seen = new Set()
  for (let i = 0; i < rawRules.length; i += 1) {
    const r = rawRules[i]
    if (!r || typeof r !== 'object') {
      return { ok: false, code: 'BOT_POLICY_BAD_RULE', hint: `第 ${i + 1} 条规则不是对象` }
    }
    const tool = String(r.tool ?? '').trim()
    if (!TOOL_NAMES.includes(tool)) {
      return { ok: false, code: 'BOT_POLICY_BAD_TOOL', hint: `第 ${i + 1} 条规则的工具 ${JSON.stringify(tool)} 不认识（可选：${TOOL_NAMES.join(' | ')}）` }
    }
    if (seen.has(tool)) {
      return { ok: false, code: 'BOT_POLICY_DUP_TOOL', hint: `工具 ${tool} 出现了两条规则 —— 请合并成一条` }
    }
    seen.add(tool)
    const allow = r.allow === false ? false : (r.allow === true ? true : undefined)
    if (allow === undefined) {
      return { ok: false, code: 'BOT_POLICY_BAD_ALLOW', hint: `第 ${i + 1} 条规则 allow 必须是 true / false` }
    }
    const note = r.note === undefined || r.note === null ? '' : String(r.note).trim()
    if (note.length > MAX_NOTE) {
      return { ok: false, code: 'BOT_POLICY_NOTE_TOO_LONG', hint: `第 ${i + 1} 条规则说明超过 ${MAX_NOTE} 字` }
    }
    rules.push({ tool, allow, ...(note ? { note } : {}) })
  }
  return { ok: true, value: { mode, rules } }
}

/**
 * 策略 → permission（**硬约束**）。
 * 只读模式必须落到 `read-only`，否则「禁止写入」只是口头约定。
 * @returns {'read-only'|'workspace-write'|undefined} undefined 表示不覆盖调用方显式给的权限
 */
export function permissionForPolicy(policy) {
  if (policy?.mode === 'readonly') return 'read-only'
  return undefined
}

/**
 * 策略 → AGENTS.md 条款（**软约束**：写进模型上下文）。
 * 没有任何规则且是标准模式时返回空数组（不往身份里塞噪音）。
 * @returns {string[]}
 */
export function policyLines(policy) {
  const p = policy ?? { mode: 'standard', rules: [] }
  const meta = MODE_META[p.mode] ?? MODE_META.standard
  const out = []
  const rules = Array.isArray(p.rules) ? p.rules : []
  if (p.mode === 'standard' && rules.length === 0) return out
  out.push(`- 工作模式：${meta.label}（${meta.desc}）`)
  if (p.mode === 'creative') {
    out.push('- 创造模式要求：先给出可运行/可验收的最小成果，再迭代；能用文件交付的不要只口头描述。')
  }
  if (p.mode === 'readonly') {
    out.push('- 只读模式要求：不得写文件、不得执行命令、不得改配置；需要变更时输出「变更建议 + 原因」交给人。')
  }
  const denied = rules.filter((r) => r.allow === false)
  const allowed = rules.filter((r) => r.allow === true && r.note)
  if (denied.length) {
    out.push('- 禁止使用以下工具：' + denied.map((r) => `\`${r.tool}\`${r.note ? `（${r.note}）` : ''}`).join('、'))
  }
  for (const r of allowed) out.push(`- 工具 \`${r.tool}\` 的使用规则：${r.note}`)
  return out
}