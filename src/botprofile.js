/**
 * cs-bots /botprofile —— 每个 Bot 的「身份 / 经验 / 技能 / 预制记忆」。
 *
 * ── 为什么这样实现（不用动态注册预设）─────────────────────────────────────
 * DSH 的身份体系是三层官方机制，我们**直接复用**，不自造：
 *
 *   ① 身份 + 经验 → `<cwd>/AGENTS.md`
 *      `@deepseek-ai/dsh-agent-instructions` 是官方「工作区指令加载器」，
 *      文档原文：*"Baseline instructions enter durable context before the first request"*
 *      ⇒ 只要把文字写进 Bot 自己目录的 AGENTS.md，它**首次请求前**就会进上下文。
 *      这是最稳的一条：不碰组合、不需要重启、不依赖预设注册。
 *
 *   ② 技能 → `<cwd>/.agents/skills/<name>/SKILL.md`
 *      `dsh-skill-filesystem` 的 `skills.list({ cwd })` 用 **cwd 选项目根**
 *      ⇒ Bot 自己目录下的技能自动被发现，互不干扰。
 *
 *   ③ 预制记忆 → 双写
 *      · 写 MemoryService（带 botId）：可检索、可审计、可增删
 *      · 同时镜像进 AGENTS.md 托管段：保证**一定被注入**（检索可能不命中，注入不会漏）
 *
 * ── 托管段协议 ────────────────────────────────────────────────────────────
 * 我们在 AGENTS.md 里只用 `<!-- cs-bots:begin -->…<!-- cs-bots:end -->` 之间的区域，
 * **绝不改动用户在段外的任何内容**（人写的东西优先，我们不覆盖）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 托管段起止标记。 */
export const MARK_BEGIN = '<!-- cs-bots:begin —— 以下内容由 cs-bots 维护，改动可能被覆盖 -->'
export const MARK_END = '<!-- cs-bots:end -->'

/** AGENTS.md 文件名。 */
export const AGENTS_FILE = 'AGENTS.md'

/** 技能目录（相对 Bot 的 cwd）。 */
export const SKILLS_DIR = '.agents/skills'

/** 各段上限（防止把上下文撑爆）。 */
export const LIMITS = Object.freeze({
  identity: 4000,
  experience: 8000,
  memoryEach: 600,
  memoryCount: 50,
  skillsCount: 50,
  workflowsCount: 50,
  skillBody: 20000,
  // ── v2 档案增强（DESIGN-v2 特性 ③）──────────────────────────────────────
  // 为什么给 title 120：它是「岗位名」，一行标题的容量；再长就不是标题而是描述了，
  // 渲染成 `## <title>` 会把 AGENTS.md 的标题层级撑歪。
  // persona / boundaries 各 2000：这两段是**每次请求都注入**的常驻上下文，
  // 两段合计 4000 字符 ≈ 1000 token，已接近「不喧宾夺主」的上限。
  title: 120,
  persona: 2000,
  boundaries: 2000,
  disciplineIds: 50,
})

/** 档案校验错误。 */
export class ProfileError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'ProfileError'
    this.code = code
    this.detail = detail
  }
}

/** 取字符串，超长则报错（不静默截断 —— 截断会让用户以为写进去了）。 */
function takeText(value, field, max) {
  if (value === undefined || value === null) return undefined
  const s = String(value)
  if (s.length > max) {
    throw new ProfileError(
      `profile.${field} 超长：${s.length} > ${max} 字符`,
      'PROFILE_TOO_LONG',
      { field, length: s.length, max },
    )
  }
  return s
}

/** 取字符串数组。 */
function takeList(value, field, maxItems, maxEach) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new ProfileError(`profile.${field} 必须是数组`, 'PROFILE_BAD_FIELD', { field })
  }
  if (value.length > maxItems) {
    throw new ProfileError(
      `profile.${field} 条目过多：${value.length} > ${maxItems}`,
      'PROFILE_TOO_MANY',
      { field, count: value.length, maxItems },
    )
  }
  return value.map((v, i) => {
    const s = String(v ?? '')
    if (s.length > maxEach) {
      throw new ProfileError(
        `profile.${field}[${i}] 超长：${s.length} > ${maxEach} 字符`,
        'PROFILE_TOO_LONG',
        { field: `${field}[${i}]`, length: s.length, max: maxEach },
      )
    }
    return s
  })
}

/** 档案模型认识的字段（唯一清单：normalizeProfile 与 strict 校验共用，避免两处口径分叉）。 */
export const PROFILE_FIELDS = Object.freeze([
  'identity',
  'experience',
  'skills',
  'workflows',
  'memory',
  'title',
  'persona',
  'boundaries',
  'disciplineIds',
])

/**
 * 规范化档案输入（只取认识的字段，其余忽略；越界一律抛错）。
 *
 * ── 为什么「未知字段」默认忽略，而不是默认拒绝（重要，别照 DESIGN 字面改回去）──
 * DESIGN-v2 特性 ③ 写的是「未知字段仍拒绝」，但本仓既有实现与测试的口径是**忽略**：
 *   · `test/botprofile.test.mjs` 明确断言 `{ ..., junk: 1 }` 归一后 junk 被丢弃（不能变红）；
 *   · `src/library.js:220` 的注释把「多给的键属于调用方的自由」当作**本仓通用约定**。
 * 两者冲突时**向后兼容赢**：老调用方（含已部署的 UI/API）多传一个键不该一夜之间变成 400。
 * 因此默认宽松，同时提供 `{ strict: true }` 给新入口（API 层想收紧时）按需启用——
 * 这样「拒绝未知字段」是可交付的能力，且不必打破既有契约。
 *
 * @param {object} input
 * @param {{ strict?: boolean }} [options] strict=true → 出现未知字段即抛 PROFILE_UNKNOWN_FIELD
 * @returns {{ identity?: string, experience?: string, skills?: string[], workflows?: string[],
 *             memory?: string[], title?: string, persona?: string, boundaries?: string,
 *             disciplineIds?: string[] }}
 */
export function normalizeProfile(input, options = {}) {
  const src = input ?? {}
  if (typeof src !== 'object') {
    throw new ProfileError('profile 必须是对象', 'PROFILE_BAD_FIELD')
  }
  if (options?.strict) {
    for (const key of Object.keys(src)) {
      if (!PROFILE_FIELDS.includes(key)) {
        throw new ProfileError(
          `profile.${key} 不是认识的字段（合法字段：${PROFILE_FIELDS.join(' / ')}）`,
          'PROFILE_UNKNOWN_FIELD',
          { field: key, allowed: [...PROFILE_FIELDS] },
        )
      }
    }
  }
  const out = {}
  const identity = takeText(src.identity, 'identity', LIMITS.identity)
  if (identity !== undefined) out.identity = identity
  const experience = takeText(src.experience, 'experience', LIMITS.experience)
  if (experience !== undefined) out.experience = experience
  const skills = takeList(src.skills, 'skills', LIMITS.skillsCount, 64)
  if (skills !== undefined) out.skills = skills
  const workflows = takeList(src.workflows, 'workflows', LIMITS.workflowsCount, 64)
  if (workflows !== undefined) out.workflows = workflows
  const memory = takeList(src.memory, 'memory', LIMITS.memoryCount, LIMITS.memoryEach)
  if (memory !== undefined) out.memory = memory
  // ── v2 新增字段 ─────────────────────────────────────────────────────────
  // 为什么 title/persona/boundaries 走 takeText 而不是 takeList：它们是**单段文本**，
  // 超长必须报错（takeText 不截断），避免「用户以为写进去了，其实被砍掉一半」。
  const title = takeText(src.title, 'title', LIMITS.title)
  if (title !== undefined) out.title = title
  const persona = takeText(src.persona, 'persona', LIMITS.persona)
  if (persona !== undefined) out.persona = persona
  const boundaries = takeText(src.boundaries, 'boundaries', LIMITS.boundaries)
  if (boundaries !== undefined) out.boundaries = boundaries
  // disciplineIds 是引用（纪律条目 id），单项长度按 64 与 skills 同口径
  const disciplineIds = takeList(src.disciplineIds, 'disciplineIds', LIMITS.disciplineIds, 64)
  if (disciplineIds !== undefined) out.disciplineIds = disciplineIds
  return out
}

/**
 * 记忆条目去重键：`trim` + 压缩连续空白 + 大小写不敏感。
 *
 * 为什么归一化而不是直接比对原文：记忆是「人写/模型写」的混合输入，
 * 同一条内容常带不同的首尾空白、多余的连续空白与大小写
 * （`Production  DB is read-only` vs `  production db is READ-ONLY  `），
 * 直接字面比对会让**同一条记忆反复入库**，把 50 条的预算耗在重复内容上。
 *
 * ⚠️ 注意口径边界：归一化只「压缩」空白、不「删除」空白 ——
 * `生产库只读` 与 `生产库 只读`（中间多一个空格）归一后仍不相等，
 * 那是内容差异而不是空白差异，按「不同条目」保留（误合并比漏合并更难发现）。
 *
 * @param {string} text
 * @returns {string}
 */
function memoryKey(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 把一批记忆条目合并进现有记忆（**纯函数，不写盘**）。
 *
 * 语义（DESIGN-v2 特性 ③ 固定签名）：
 *   · `dedup=true`（缺省）：按 `memoryKey` 归一后去重——既与 existing 比，也与本批先前条目比；
 *   · `dedup=false`：只跳过**空白条目**，重复内容原样保留（用于「我要留多份」的显式场景）；
 *   · 空白条目（trim 后为空）不写入，计入 `skipped`——空串进 AGENTS.md 只会渲染出一个空 bullet；
 *   · 总量超 `LIMITS.memoryCount` 或单条超 `LIMITS.memoryEach` **抛错不截断**：
 *     截断会让调用方以为写成功了，实际上下文里少了半句记忆（比报错危险得多）。
 *
 * 为什么返回 `memory` 全量数组而不是只返回新增：调用方（roster.addProfileMemory）
 * 要拿它直接覆盖 `profile.memory`，返回全量可避免调用方再拼一次（拼错就丢数据）。
 *
 * @param {{ existing?: string[], entries?: string[], dedup?: boolean }} input
 * @returns {{ memory: string[], added: number, skipped: number }}
 */
export function importMemoryToProfile({ existing, entries, dedup = true } = {}) {
  const base = existing === undefined || existing === null ? [] : existing
  if (!Array.isArray(base)) {
    throw new ProfileError('existing 必须是数组', 'PROFILE_BAD_FIELD', { field: 'existing' })
  }
  const incoming = entries === undefined || entries === null ? [] : entries
  if (!Array.isArray(incoming)) {
    throw new ProfileError('entries 必须是数组', 'PROFILE_BAD_FIELD', { field: 'entries' })
  }

  const memory = []
  const seen = new Set()
  /** 单条校验（既有条目同样校验：已损坏的数据不该被继续放大）。 */
  const pushChecked = (raw, index, field) => {
    const text = String(raw ?? '')
    if (text.length > LIMITS.memoryEach) {
      throw new ProfileError(
        `profile.${field}[${index}] 超长：${text.length} > ${LIMITS.memoryEach} 字符`,
        'PROFILE_TOO_LONG',
        { field: `${field}[${index}]`, length: text.length, max: LIMITS.memoryEach },
      )
    }
    return text
  }

  for (let i = 0; i < base.length; i += 1) {
    const text = pushChecked(base[i], i, 'memory')
    memory.push(text)
    seen.add(memoryKey(text))
  }

  let added = 0
  let skipped = 0
  for (let i = 0; i < incoming.length; i += 1) {
    const text = pushChecked(incoming[i], i, 'entries')
    if (text.trim() === '') {
      skipped += 1 // 空白条目没有信息量，留一行空 bullet 只会污染上下文
      continue
    }
    const key = memoryKey(text)
    if (dedup && seen.has(key)) {
      skipped += 1
      continue
    }
    memory.push(text)
    seen.add(key)
    added += 1
  }

  if (memory.length > LIMITS.memoryCount) {
    throw new ProfileError(
      `profile.memory 条目过多：${memory.length} > ${LIMITS.memoryCount}（既有 ${base.length} + 新增 ${added}）`,
      'PROFILE_TOO_MANY',
      { field: 'memory', count: memory.length, maxItems: LIMITS.memoryCount },
    )
  }
  return { memory, added, skipped }
}

/** 校验 cwd 可用于写档案（必须绝对路径且存在）。 */
export function assertWritableCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new ProfileError('cwd 必填', 'PROFILE_BAD_CWD', { cwd })
  }
  if (!isAbsolute(cwd)) {
    throw new ProfileError(`cwd 必须是绝对路径，收到 ${JSON.stringify(cwd)}`, 'PROFILE_BAD_CWD', { cwd })
  }
  const abs = resolve(cwd)
  try {
    if (!statSync(abs).isDirectory()) {
      throw new ProfileError(`cwd 不是目录：${abs}`, 'PROFILE_BAD_CWD', { cwd: abs })
    }
  } catch (error) {
    if (error instanceof ProfileError) throw error
    throw new ProfileError(`cwd 不存在或不可访问：${abs}`, 'PROFILE_BAD_CWD', { cwd: abs, cause: String(error?.message ?? error) })
  }
  return abs
}

/**
 * 把档案渲染成 AGENTS.md 里的一段 Markdown。
 *
 * 渲染顺序的「为什么」（先身份、再约束、后能力、最后记忆）：
 *   身份类（title/persona/boundaries）必须**靠前**——AGENTS.md 是顺序读的，
 *   人格与红线写在能力清单后面，模型容易「先看到技能再看到红线」，错误的暗示顺序反过来。
 *
 * v2 新增字段的渲染位置：
 *   · `title` 当**二级小标题**（`## 岗位名`）紧跟 H1 —— 一个小标题就够，不再套三层；
 *   · `persona` / `boundaries` 各自成节（`## 人格设定` / `## 边界与红线`）；
 *   · `disciplineIds` 渲染成「## 关联纪律」的 id 列表（条目正文由纪律体系注入，这里只留引用）。
 *
 * 向后兼容：老档案没有这些字段时**不渲染空节**（`_（未填写）_` 只保留 identity 一处，
 * 避免老 Bot 的 AGENTS.md 突然多出四行「未填写」的无意义内容）。
 *
 * @param {{ identity?: string, experience?: string, skills?: string[], workflows?: string[],
 *           memory?: string[], title?: string, persona?: string, boundaries?: string,
 *           disciplineIds?: string[], botName?: string, preset?: string }} profile
 * @returns {string}
 */
export function renderManagedSection(profile) {
  const p = profile ?? {}
  const lines = [MARK_BEGIN, '']
  lines.push(`# 你的身份（由 cs-bots 维护）`, '')
  // title 当小标题：老档案没有 title 时整行不出现，保持旧渲染结果不变
  if (typeof p.title === 'string' && p.title.trim()) {
    lines.push(`## ${p.title.trim()}`, '')
  }
  if (p.botName) lines.push(`- 角色名：**${p.botName}**`)
  if (p.preset) lines.push(`- 预设：\`${p.preset}\``)
  if (p.identity && p.identity.trim()) {
    lines.push('', p.identity.trim())
  } else {
    lines.push('', '_（未填写身份描述）_')
  }

  // 人格设定放在经验之前：它是「我是谁」，经验是「我做过什么」，由内而外更符合注入顺序
  if (typeof p.persona === 'string' && p.persona.trim()) {
    lines.push('', '## 人格设定', '', p.persona.trim())
  }

  // 红线紧跟人格：约束越早出现，越不容易被后面的任务描述冲淡
  if (typeof p.boundaries === 'string' && p.boundaries.trim()) {
    lines.push('', '## 边界与红线', '', p.boundaries.trim())
  }

  if (p.experience && p.experience.trim()) {
    lines.push('', '## 经验与规矩', '', p.experience.trim())
  }

  if (Array.isArray(p.skills) && p.skills.length) {
    lines.push('', '## 可用技能', '')
    for (const s of p.skills) lines.push(`- \`${s}\``)
    lines.push('', `技能文件位于本工作目录的 \`${SKILLS_DIR}/<技能名>/SKILL.md\`，用 skill 工具加载。`)
  }

  // 关联纪律只放 id：正文由纪律体系按层级合并注入，这里重复正文会导致「同一纪律两份、还可能互相矛盾」
  if (Array.isArray(p.disciplineIds) && p.disciplineIds.length) {
    lines.push('', '## 关联纪律', '')
    for (const d of p.disciplineIds) lines.push(`- \`${d}\``)
    lines.push('', '以上纪律条目由协作平台的纪律体系按「全局 → 工作区 → 房间 → Bot」层级合并注入，此处只登记关联关系。')
  }

  if (Array.isArray(p.workflows) && p.workflows.length) {
    lines.push('', '## 该遵循的工作流', '')
    for (const w of p.workflows) lines.push(`- \`${w}\``)
    lines.push('', '执行相关任务时，按以上工作流库里的步骤走（工作流库在协作平台的「工作流库」页）。')
  }

  if (Array.isArray(p.memory) && p.memory.length) {
    lines.push('', '## 预制记忆', '')
    for (const m of p.memory) lines.push(`- ${m}`)
  }

  lines.push('', MARK_END)
  return lines.join('\n')
}

/**
 * 读现有 AGENTS.md，替换或追加托管段，**保留段外内容原样**。
 * @param {string} cwd
 * @param {object} profile
 * @returns {{ path: string, created: boolean, hadManaged: boolean, outsideLength: number }}
 */
export function writeAgentsFile(cwd, profile) {
  const dir = assertWritableCwd(cwd)
  const file = join(dir, AGENTS_FILE)
  let existing = ''
  let created = false
  if (existsSync(file)) {
    try {
      existing = readFileSync(file, 'utf8')
    } catch (error) {
      throw new ProfileError(`读取 ${file} 失败：${error?.message ?? error}`, 'PROFILE_READ_FAILED', { file })
    }
  } else {
    created = true
  }

  const begin = existing.indexOf(MARK_BEGIN)
  const end = existing.indexOf(MARK_END)
  const hadManaged = begin !== -1 && end !== -1 && end > begin

  let outside = existing
  if (hadManaged) {
    outside = existing.slice(0, begin) + existing.slice(end + MARK_END.length)
  }
  outside = outside.replace(/\n{3,}/g, '\n\n').trim()

  const managed = renderManagedSection(profile)
  const next = outside ? `${outside}\n\n${managed}\n` : `${managed}\n`

  try {
    writeFileSync(file, next, 'utf8')
  } catch (error) {
    throw new ProfileError(`写入 ${file} 失败：${error?.message ?? error}`, 'PROFILE_WRITE_FAILED', { file })
  }
  return { path: file, created, hadManaged, outsideLength: outside.length }
}

/**
 * 读回 AGENTS.md 的托管段（不含标记）。
 * @param {string} cwd
 * @returns {{ path: string, exists: boolean, managed?: string, outside?: string }}
 */
export function readAgentsFile(cwd) {
  const dir = assertWritableCwd(cwd)
  const file = join(dir, AGENTS_FILE)
  if (!existsSync(file)) return { path: file, exists: false }
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new ProfileError(`读取 ${file} 失败：${error?.message ?? error}`, 'PROFILE_READ_FAILED', { file })
  }
  const begin = text.indexOf(MARK_BEGIN)
  const end = text.indexOf(MARK_END)
  if (begin === -1 || end === -1 || end <= begin) {
    return { path: file, exists: true, outside: text }
  }
  const managed = text.slice(begin + MARK_BEGIN.length, end).trim()
  const outside = (text.slice(0, begin) + text.slice(end + MARK_END.length)).trim()
  return { path: file, exists: true, managed, outside }
}

/**
 * 为一个技能写 `<cwd>/.agents/skills/<name>/SKILL.md`。
 *
 * 技能名必须安全（字母数字 - _），防止路径穿越。
 * @param {string} cwd
 * @param {string} name
 * @param {{ description?: string, body: string }} spec
 * @returns {{ dir: string, file: string }}
 */
export function writeSkill(cwd, name, spec) {
  const dir = assertWritableCwd(cwd)
  const safe = String(name ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(safe)) {
    throw new ProfileError(
      `技能名不合法：${JSON.stringify(name)}（只允许字母、数字、. _ -，且以字母数字开头）`,
      'PROFILE_BAD_SKILL_NAME',
      { name },
    )
  }
  const body = String(spec?.body ?? '')
  if (body.length > LIMITS.skillBody) {
    throw new ProfileError(
      `技能正文超长：${body.length} > ${LIMITS.skillBody}`,
      'PROFILE_TOO_LONG',
      { name: safe, length: body.length },
    )
  }
  const skillDir = join(dir, SKILLS_DIR, safe)
  try {
    mkdirSync(skillDir, { recursive: true })
  } catch (error) {
    throw new ProfileError(`创建技能目录失败：${error?.message ?? error}`, 'PROFILE_WRITE_FAILED', { dir: skillDir })
  }
  const desc = String(spec?.description ?? '').trim()
  // SKILL.md 的头部是 YAML frontmatter（官方约定）
  const head = ['---', `name: ${safe}`, desc ? `description: ${JSON.stringify(desc)}` : '', '---', ''].filter(Boolean).join('\n')
  const file = join(skillDir, 'SKILL.md')
  try {
    writeFileSync(file, `${head}\n${body}\n`, 'utf8')
  } catch (error) {
    throw new ProfileError(`写入技能失败：${error?.message ?? error}`, 'PROFILE_WRITE_FAILED', { file })
  }
  return { dir: skillDir, file }
}

/** 列出 Bot 目录下已有的技能名。 */
export function listSkills(cwd) {
  const dir = assertWritableCwd(cwd)
  const root = join(dir, SKILLS_DIR)
  if (!existsSync(root)) return []
  try {
    return readdirSafe(root).filter((n) => {
      try {
        return statSync(join(root, n)).isDirectory() && existsSync(join(root, n, 'SKILL.md'))
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function readdirSafe(p) {
  try {
    // 动态取 fs.readdirSync，避免顶层多引一个符号
    const fs = require('node:fs')
    return fs.readdirSync(p)
  } catch {
    return []
  }
}

function require(spec) {
  try {
    if (typeof process.getBuiltinModule === 'function') return process.getBuiltinModule(spec)
  } catch {}
  return {}
}
