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

/**
 * 规范化档案输入（只取认识的字段，其余忽略；越界一律抛错）。
 * @param {object} input
 * @returns {{ identity?: string, experience?: string, skills?: string[], memory?: string[] }}
 */
export function normalizeProfile(input) {
  const src = input ?? {}
  if (typeof src !== 'object') {
    throw new ProfileError('profile 必须是对象', 'PROFILE_BAD_FIELD')
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
  return out
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
 * @param {{ identity?: string, experience?: string, skills?: string[], memory?: string[], botName?: string, preset?: string }} profile
 * @returns {string}
 */
export function renderManagedSection(profile) {
  const p = profile ?? {}
  const lines = [MARK_BEGIN, '']
  lines.push(`# 你的身份（由 cs-bots 维护）`, '')
  if (p.botName) lines.push(`- 角色名：**${p.botName}**`)
  if (p.preset) lines.push(`- 预设：\`${p.preset}\``)
  if (p.identity && p.identity.trim()) {
    lines.push('', p.identity.trim())
  } else {
    lines.push('', '_（未填写身份描述）_')
  }

  if (p.experience && p.experience.trim()) {
    lines.push('', '## 经验与规矩', '', p.experience.trim())
  }

  if (Array.isArray(p.skills) && p.skills.length) {
    lines.push('', '## 可用技能', '')
    for (const s of p.skills) lines.push(`- \`${s}\``)
    lines.push('', `技能文件位于本工作目录的 \`${SKILLS_DIR}/<技能名>/SKILL.md\`，用 skill 工具加载。`)
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
