/**
 * cs-bots /library —— 技能库（SkillLibrary）+ 工作流库（WorkflowLibrary）。
 *
 * ── 这是什么 ──────────────────────────────────────────────────────────────
 * 两个**全局可复用**的条目库：技能（会落成 Bot 目录下的
 * `.agents/skills/<name>/SKILL.md`，落盘由调用方做）与工作流模板（纯数据）。
 * 本文件只管「存条目 + 保证条目没被写坏」，**不执行任何东西**：
 * 工作流的 `steps` 永远只是数组，库不是编排器 —— 这是纪律，不是偷懒。
 *
 * ── 为什么这样实现（踩过的坑）─────────────────────────────────────────────
 * ① **不复用 store.js 的 `readJson` 来做库文件读取**：
 *    它的契约是「坏文件返回 fallback」，对配置文件是对的，对**数据库**是灾难 ——
 *    坏一次就把整库静默重置成空，用户以为条目丢了是「自己记错了」。
 *    ⇒ 本文件自己读：缺文件=空库，坏 JSON=抛 `LIB_STORE_CORRUPT`（带路径）。
 *    其余能力仍复用 store.js（`writeJsonAtomic` / `ensureDir` / `statePath`）。
 * ② **先落盘、再换内存**（照 board.js 的 commit 顺序）：
 *    写失败时内存必须原封不动，否则内存与磁盘分叉 → 重启后数据凭空回退，
 *    属于最恶劣的静默失败。
 * ③ **name 必须能当目录名**：技能要落成 `<cwd>/.agents/skills/<name>/`，
 *    放行 `../evil` 等于把写入路径交给调用方拼 `..` ⇒ 这里用白名单正则硬拦。
 * ④ **越界一律抛错，不截断**：截断后假装成功，用户会以为写进去了。
 *
 * 本文件不 import 任何 `@deepseek-ai/*` 或 npm 包（零依赖 CI 检查 1 覆盖）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureDir, statePath, writeJsonAtomic } from './store.js'

/** 技能库文件名。 */
export const SKILLS_FILE = 'library-skills.json'

/** 工作流库文件名。 */
export const WORKFLOWS_FILE = 'library-workflows.json'

/** 落盘格式版本（结构不兼容时改它，让读取端显式吵起来）。 */
export const LIBRARY_VERSION = 1

/** 各字段上限。 */
export const LIMITS = Object.freeze({
  /** 技能名/工作流名长度上限（含首字符）。 */
  name: 64,
  /** 技能正文上限：与 botprofile 的 skillBody 对齐，避免库能存、落盘被拒。 */
  skillBody: 20000,
  /** 描述上限。 */
  description: 2000,
  /** 标签条数 / 单条标签长度上限。 */
  tags: 20,
  tagLength: 64,
  /** 工作流步数上限。 */
  steps: 50,
  stepTitle: 200,
  stepDetail: 4000,
  stepOwnerHint: 128,
})

/**
 * 技能名 / 工作流名白名单：字母数字开头，其后允许 `. _ -`。
 * 冒号、斜杠、空格、`..` 开头一律拒绝 —— 因为这个名字会变成磁盘上的目录名。
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 库错误（照 botprofile.js 的 `ProfileError` 写法：message + code + detail）。 */
export class LibraryError extends Error {
  /**
   * @param {string} message 人能看懂的原因
   * @param {string} code 稳定错误码（HTTP 层按它映射状态码，别去解析 message）
   * @param {object} [detail] 结构化上下文
   */
  constructor(message, code, detail) {
    super(message)
    this.name = 'LibraryError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 深拷贝 + JSON 归一（去掉 `undefined` 键）。
 * 必须走 JSON 而不能用 structuredClone：否则内存态可能比磁盘态多出
 * `{detail: undefined}` 这类键，导致重启回放后与内存值不等。
 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 非空字符串必填校验。 */
function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LibraryError(`${where}：${field} 必填（非空字符串）`, 'LIB_BAD_FIELD', { field, value })
  }
  return value.trim()
}

/** 操作者必填 —— 库没有审计流，但「谁改的」不许缺失，否则 HTTP 层无从追责。 */
function requireBy(by, where) {
  return requireString(by, 'by', where)
}

/**
 * `now` 允许外部注入（测试要可控时间）；不传用当前时间。
 * 传了就必须是合法时间戳 —— 静默忽略非法 `now` 会让调用方以为时间被采信了。
 */
function normalizeNow(now, where) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now) || now <= 0) {
    throw new LibraryError(`${where}：now 必须是正的时间戳（ms）`, 'LIB_BAD_FIELD', { field: 'now', now })
  }
  return Math.floor(now)
}

/** 名字校验（白名单正则，见 `NAME_RE` 的注释）。 */
function requireName(value, where, code) {
  const raw = typeof value === 'string' ? value.trim() : value
  if (typeof raw !== 'string' || !NAME_RE.test(raw)) {
    throw new LibraryError(
      `${where}：name 不合法 ${JSON.stringify(value)}（只允许字母数字开头，其后为字母数字 . _ -，长度 1-${LIMITS.name}）`,
      code,
      { name: value },
    )
  }
  return raw
}

/**
 * 显示名校验（用于**不会变成文件路径**的字段，例如工作流名）。
 *
 * 为什么和 requireName 分开：技能名要落成目录名 `.agents/skills/<name>/`，
 * 所以必须限 ASCII 防路径穿越；但工作流名只是给人看的标题，
 * 限 ASCII 会让中文用户没法起名（实测被拒过）。
 * 这里只禁控制字符与路径分隔符，其余放行。
 *
 * @param {unknown} value
 * @param {string} where
 * @param {string} code
 * @returns {string}
 */
function requireDisplayName(value, where, code) {
  const raw = typeof value === 'string' ? value.trim() : value
  const bad = typeof raw !== 'string' || raw === '' || raw.length > LIMITS.name
    || /[\u0000-\u001f\/\\]/.test(raw)
  if (bad) {
    throw new LibraryError(
      `${where}：name 不合法 ${JSON.stringify(value)}（不能为空、不能含 / \\ 或控制字符，长度 1-${LIMITS.name}）`,
      code,
      { name: value },
    )
  }
  return raw
}

/** 名字归一化：比较唯一性时大小写不敏感（`Refactor` 与 `refactor` 视为同一个）。 */
function nameKey(name) {
  return String(name).trim().toLowerCase()
}

/** 可选文本字段（undefined=不改/不填；null=显式清空）。 */
function normalizeText(value, field, max, where) {
  if (value === undefined) return undefined
  if (value === null) return ''
  if (typeof value !== 'string') {
    throw new LibraryError(`${where}：${field} 必须是字符串`, 'LIB_BAD_FIELD', { field })
  }
  if (value.length > max) {
    throw new LibraryError(`${where}：${field} 超长 ${value.length} > ${max} 字符`, 'LIB_TOO_LONG', { field, length: value.length, max })
  }
  return value
}

/** 标签数组：去空、按大小写不敏感去重，保留首次写法。 */
function normalizeTags(value, where) {
  if (value === undefined) return undefined
  if (value === null) return []
  if (!Array.isArray(value)) {
    throw new LibraryError(`${where}：tags 必须是字符串数组`, 'LIB_BAD_FIELD', { field: 'tags' })
  }
  if (value.length > LIMITS.tags) {
    throw new LibraryError(`${where}：tags 条数过多 ${value.length} > ${LIMITS.tags}`, 'LIB_TOO_MANY', { field: 'tags', count: value.length, max: LIMITS.tags })
  }
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new LibraryError(`${where}：tags 里每项必须是字符串`, 'LIB_BAD_FIELD', { field: 'tags', value: raw })
    }
    const tag = raw.trim()
    // 空标签本身没有内容，丢弃不算「静默丢数据」
    if (!tag) continue
    if (tag.length > LIMITS.tagLength) {
      throw new LibraryError(`${where}：tag 超长 ${tag.length} > ${LIMITS.tagLength} 字符`, 'LIB_TOO_LONG', { field: 'tags', tag })
    }
    if (seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out
}

/** 技能正文：必填、非空、不超上限（超长抛错，不截断）。 */
function requireBody(value, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LibraryError(`${where}：body 必填（非空字符串）`, 'LIB_BAD_FIELD', { field: 'body' })
  }
  if (value.length > LIMITS.skillBody) {
    throw new LibraryError(
      `${where}：body 超长 ${value.length} > ${LIMITS.skillBody} 字符`,
      'LIB_TOO_LONG',
      { field: 'body', length: value.length, max: LIMITS.skillBody },
    )
  }
  return value
}

/**
 * 工作流步骤校验：非空数组、≤50 步、每步 title 必填。
 * 只取认识的字段（title / detail / ownerHint / done），其余忽略 —— 与
 * `botprofile.normalizeProfile` 的口径一致：多给的键属于调用方的自由，不是数据。
 */
function normalizeSteps(value, where) {
  if (!Array.isArray(value)) {
    throw new LibraryError(`${where}：steps 必须是数组`, 'LIB_BAD_FIELD', { field: 'steps' })
  }
  if (value.length === 0) {
    throw new LibraryError(`${where}：steps 不能为空（空工作流没有意义）`, 'LIB_STEPS_EMPTY', { field: 'steps' })
  }
  if (value.length > LIMITS.steps) {
    throw new LibraryError(
      `${where}：steps 步数过多 ${value.length} > ${LIMITS.steps}`,
      'LIB_TOO_MANY',
      { field: 'steps', count: value.length, max: LIMITS.steps },
    )
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new LibraryError(`${where}：steps[${index}] 必须是对象`, 'LIB_BAD_FIELD', { field: `steps[${index}]` })
    }
    const title = requireString(raw.title, `steps[${index}].title`, where)
    if (title.length > LIMITS.stepTitle) {
      throw new LibraryError(
        `${where}：steps[${index}].title 超长 ${title.length} > ${LIMITS.stepTitle} 字符`,
        'LIB_TOO_LONG',
        { field: `steps[${index}].title`, length: title.length, max: LIMITS.stepTitle },
      )
    }
    const detail = normalizeText(raw.detail, `steps[${index}].detail`, LIMITS.stepDetail, where)
    const ownerHint = normalizeText(raw.ownerHint, `steps[${index}].ownerHint`, LIMITS.stepOwnerHint, where)
    if (raw.done !== undefined && raw.done !== null && typeof raw.done !== 'boolean') {
      throw new LibraryError(`${where}：steps[${index}].done 必须是布尔值`, 'LIB_BAD_FIELD', { field: `steps[${index}].done` })
    }
    /** @type {{ title: string, detail?: string, ownerHint?: string, done: boolean }} */
    const step = { title }
    if (detail !== undefined) step.detail = detail
    if (ownerHint !== undefined) step.ownerHint = ownerHint
    // done 显式落成布尔值：模板被 UI 当清单展示时不该出现 undefined 分支
    step.done = raw.done === true
    return step
  })
}

/**
 * 读一个库文件。**缺文件=空库；坏 JSON=抛错**（绝不静默重置）。
 * @param {string} file
 * @returns {object[]}
 */
function readStore(file) {
  if (!existsSync(file)) return []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new LibraryError(
      `读取库文件失败：${file}（${error?.message ?? error}）`,
      'LIB_STORE_READ_FAILED',
      { file, cause: String(error?.message ?? error) },
    )
  }
  const trimmed = text.trim()
  // 空文件 = 没有任何数据，按空库处理并不丢东西（writeJsonAtomic 也不会留下空文件）
  if (!trimmed) return []

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new LibraryError(
      `库文件损坏（JSON 非法）：${file}。拒绝静默重置 —— 请人工确认后再修或删。`,
      'LIB_STORE_CORRUPT',
      { file, cause: String(error?.message ?? error) },
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LibraryError(`库文件结构非法（应为 { version, items }）：${file}`, 'LIB_STORE_CORRUPT', { file })
  }
  if (parsed.version !== LIBRARY_VERSION) {
    throw new LibraryError(
      `库文件版本不支持：${file} 是 version=${JSON.stringify(parsed.version)}，本程序只认 ${LIBRARY_VERSION}`,
      'LIB_STORE_VERSION',
      { file, version: parsed.version },
    )
  }
  if (!Array.isArray(parsed.items)) {
    throw new LibraryError(`库文件结构非法（items 不是数组）：${file}`, 'LIB_STORE_CORRUPT', { file })
  }
  for (const [index, item] of parsed.items.entries()) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
      throw new LibraryError(
        `库文件结构非法：${file} 的 items[${index}] 缺少字符串 id`,
        'LIB_STORE_CORRUPT',
        { file, index },
      )
    }
  }
  return parsed.items
}

/** 排序键：创建时间 → 名字（大小写不敏感）→ id，保证落盘与列表顺序都确定。 */
function ordered(map) {
  return [...map.values()].sort((a, b) => {
    const at = Number(a.createdAt) || 0
    const bt = Number(b.createdAt) || 0
    if (at !== bt) return at - bt
    const an = nameKey(a.name ?? '')
    const bn = nameKey(b.name ?? '')
    if (an !== bn) return an < bn ? -1 : 1
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
  })
}

/**
 * 创建技能库/工作流库实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（仅用于日志，缺失即静默降级）
 * @param {{ stateDir: string }} config stateDir 必填：本模块不猜状态目录（裸检出无宿主时也没得猜）
 * @returns {object} 库实例（方法见 README/HTTP 层契约）
 */
export function createLibrary(ctx, config = {}) {
  const rawStateDir = config?.stateDir
  if (typeof rawStateDir !== 'string' || rawStateDir.trim() === '') {
    throw new LibraryError(
      'createLibrary：config.stateDir 必填（形如 { stateDir: "/path/to/state" }）',
      'LIB_BAD_STATE_DIR',
      { stateDir: rawStateDir },
    )
  }
  const stateDir = resolve(rawStateDir.trim())
  if (!ensureDir(stateDir)) {
    throw new LibraryError(`状态目录不可创建或不可写：${stateDir}`, 'LIB_BAD_STATE_DIR', { stateDir })
  }

  const skillsFile = statePath(stateDir, SKILLS_FILE)
  const workflowsFile = statePath(stateDir, WORKFLOWS_FILE)
  const paths = Object.freeze({ stateDir, skillsFile, workflowsFile })

  const info = (...args) => { try { ctx?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { ctx?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} 技能 id → 技能条目（创建序不可靠，输出时统一排序） */
  let skills = new Map()
  /** @type {Map<string, object>} 工作流 id → 工作流条目 */
  let workflows = new Map()
  let disposed = false

  // ── 生命周期与持久化 ──────────────────────────────────────────────────────

  function assertAlive(where) {
    if (disposed) {
      throw new LibraryError(`${where}：库实例已 dispose，不能继续使用`, 'LIB_DISPOSED', { where })
    }
  }

  /** 写入一个库文件；失败**抛错**（writeJsonAtomic 只回 false，不解释原因）。 */
  function persist(file, items, kind) {
    if (!writeJsonAtomic(file, { version: LIBRARY_VERSION, items })) {
      throw new LibraryError(`写入${kind}失败：${file}`, 'LIB_STORE_WRITE_FAILED', { file })
    }
  }

  /** 技能库走一条提交路径：先落盘，成功后再换内存。 */
  function commitSkills(next) {
    persist(skillsFile, ordered(next), '技能库')
    skills = next
  }

  /** 工作流库同上。 */
  function commitWorkflows(next) {
    persist(workflowsFile, ordered(next), '工作流库')
    workflows = next
  }

  /** 从磁盘重建内存态（构造与 `replay()` 都用它）。坏文件在这里抛，不在读取时偷偷吞掉。 */
  function hydrate() {
    const nextSkills = new Map()
    for (const item of readStore(skillsFile)) {
      if (nextSkills.has(item.id)) {
        throw new LibraryError(`技能库文件里有重复 id：${item.id}（${skillsFile}）`, 'LIB_STORE_CORRUPT', { file: skillsFile, id: item.id })
      }
      nextSkills.set(item.id, item)
    }
    const nextWorkflows = new Map()
    for (const item of readStore(workflowsFile)) {
      if (nextWorkflows.has(item.id)) {
        throw new LibraryError(`工作流库文件里有重复 id：${item.id}（${workflowsFile}）`, 'LIB_STORE_CORRUPT', { file: workflowsFile, id: item.id })
      }
      nextWorkflows.set(item.id, item)
    }
    skills = nextSkills
    workflows = nextWorkflows
  }

  // ── 内部小工具 ────────────────────────────────────────────────────────────

  /** 生成 id：时间戳 + 随机后缀，跨重启不需要持久化计数器也不会撞。 */
  function nextId(prefix, map) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      if (!map.has(candidate)) return candidate
    }
    throw new LibraryError(`生成 id 失败：${prefix} 连续 5 次碰撞`, 'LIB_ID_CONFLICT', { prefix })
  }

  /** expectRev 必填且为正整数 —— CAS 少了它就等于无条件覆盖。 */
  function requireRev(expectedRev, where) {
    if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev) || expectedRev < 1) {
      throw new LibraryError(`${where}：expectedRev 必填（正整数，用于乐观并发校验）`, 'LIB_BAD_FIELD', { field: 'expectedRev', expectedRev })
    }
    return expectedRev
  }

  function findById(map, id, notFoundCode, where) {
    const item = typeof id === 'string' ? map.get(id) : undefined
    if (!item) {
      throw new LibraryError(`${where}：找不到 id=${JSON.stringify(id)}`, notFoundCode, { id })
    }
    return item
  }

  /** 名字唯一性（大小写不敏感），selfId 用于 update 时排除自己。 */
  function assertFreeName(map, name, selfId, code, where) {
    const key = nameKey(name)
    for (const item of map.values()) {
      if (item.id === selfId) continue
      if (nameKey(item.name) === key) {
        throw new LibraryError(
          `${where}：名字已被占用 ${JSON.stringify(name)}（大小写不敏感比较）`,
          code,
          { name, existingId: item.id },
        )
      }
    }
  }

  /** 按 tag 过滤（大小写不敏感），tags 为空 = 不筛。 */
  function filterByTag(items, tag) {
    if (tag === undefined || tag === null) return items
    if (typeof tag !== 'string') {
      throw new LibraryError('listX：tag 必须是字符串', 'LIB_BAD_FIELD', { field: 'tag', tag })
    }
    const key = tag.trim().toLowerCase()
    if (!key) return items
    return items.filter((item) => (item.tags ?? []).some((t) => String(t).toLowerCase() === key))
  }

  /** 当前技能条目快照（排序后，深拷贝）。 */
  function skillsList() {
    return ordered(skills).map((item) => clone(item))
  }

  /** 当前工作流条目快照（排序后，深拷贝）。 */
  function workflowsList() {
    return ordered(workflows).map((item) => clone(item))
  }

  // ── 技能库 ────────────────────────────────────────────────────────────────

  /**
   * 新建技能条目。
   * @param {{ name: string, description?: string, body: string, tags?: string[], by: string, now?: number }} input
   * @returns {object}
   */
  function createSkill(input = {}) {
    assertAlive('createSkill')
    requireBy(input.by, 'createSkill')
    const at = normalizeNow(input.now, 'createSkill')
    const name = requireName(input.name, 'createSkill', 'LIB_BAD_NAME')
    assertFreeName(skills, name, null, 'LIB_SKILL_NAME_TAKEN', 'createSkill')
    const description = normalizeText(input.description, 'description', LIMITS.description, 'createSkill') ?? ''
    const body = requireBody(input.body, 'createSkill')
    const tags = normalizeTags(input.tags, 'createSkill') ?? []

    const item = {
      id: nextId('sk', skills),
      name,
      description,
      body,
      tags,
      createdAt: at,
      updatedAt: at,
      rev: 1,
    }
    const next = new Map(skills)
    next.set(item.id, item)
    commitSkills(next)
    info('[cs-bots] library.createSkill', { id: item.id, name })
    return clone(item)
  }

  /**
   * 按 `expectedRev` 做 CAS 更新。**rev 不匹配即抛错，绝不静默覆盖。**
   * @param {{ id: string, expectedRev: number, name?: string, description?: string, body?: string, tags?: string[], by: string, now?: number }} input
   * @returns {object}
   */
  function updateSkill(input = {}) {
    assertAlive('updateSkill')
    requireBy(input.by, 'updateSkill')
    const at = normalizeNow(input.now, 'updateSkill')
    const id = requireString(input.id, 'id', 'updateSkill')
    const expectedRev = requireRev(input.expectedRev, 'updateSkill')
    const current = findById(skills, id, 'LIB_SKILL_NOT_FOUND', 'updateSkill')
    if (current.rev !== expectedRev) {
      throw new LibraryError(
        `updateSkill：rev 冲突（期望 ${expectedRev}，实际 ${current.rev}）—— 请重新读取后再改`,
        'LIB_CAS_CONFLICT',
        { id, expectedRev, actualRev: current.rev },
      )
    }

    const next = { ...current }
    if (input.name !== undefined) {
      const name = requireName(input.name, 'updateSkill', 'LIB_BAD_NAME')
      assertFreeName(skills, name, current.id, 'LIB_SKILL_NAME_TAKEN', 'updateSkill')
      next.name = name
    }
    if (input.description !== undefined) {
      next.description = normalizeText(input.description, 'description', LIMITS.description, 'updateSkill') ?? ''
    }
    if (input.body !== undefined) next.body = requireBody(input.body, 'updateSkill')
    if (input.tags !== undefined) next.tags = normalizeTags(input.tags, 'updateSkill') ?? []
    next.rev = current.rev + 1
    next.updatedAt = at

    const map = new Map(skills)
    map.set(next.id, next)
    commitSkills(map)
    return clone(next)
  }

  /**
   * 真删除（技能是库条目，不是审计对象 —— 删了就是删了）。
   * @param {{ id: string, by: string, now?: number }} input
   * @returns {{ id: string, removed: true }}
   */
  function removeSkill(input = {}) {
    assertAlive('removeSkill')
    requireBy(input.by, 'removeSkill')
    normalizeNow(input.now, 'removeSkill')
    const id = requireString(input.id, 'id', 'removeSkill')
    findById(skills, id, 'LIB_SKILL_NOT_FOUND', 'removeSkill')
    const map = new Map(skills)
    map.delete(id)
    commitSkills(map)
    warn('[cs-bots] library.removeSkill', { id })
    return { id, removed: true }
  }

  /**
   * @param {string} id
   * @returns {object}
   */
  function getSkill(id) {
    assertAlive('getSkill')
    return clone(findById(skills, id, 'LIB_SKILL_NOT_FOUND', 'getSkill'))
  }

  /**
   * @param {{ tag?: string }} [query]
   * @returns {object[]}
   */
  function listSkills(query = {}) {
    assertAlive('listSkills')
    return filterByTag(skillsList(), query?.tag)
  }

  // ── 工作流库 ──────────────────────────────────────────────────────────────

  /**
   * 新建工作流模板。`steps` 只是数据，本模块不执行、不调度任何一步。
   * @param {{ name: string, description?: string, steps: object[], tags?: string[], by: string, now?: number }} input
   * @returns {object}
   */
  function createWorkflow(input = {}) {
    assertAlive('createWorkflow')
    requireBy(input.by, 'createWorkflow')
    const at = normalizeNow(input.now, 'createWorkflow')
    const name = requireDisplayName(input.name, 'createWorkflow', 'LIB_BAD_NAME')
    assertFreeName(workflows, name, null, 'LIB_WORKFLOW_NAME_TAKEN', 'createWorkflow')
    const description = normalizeText(input.description, 'description', LIMITS.description, 'createWorkflow') ?? ''
    const steps = normalizeSteps(input.steps, 'createWorkflow')
    const tags = normalizeTags(input.tags, 'createWorkflow') ?? []

    const item = {
      id: nextId('wf', workflows),
      name,
      description,
      steps,
      tags,
      createdAt: at,
      updatedAt: at,
      rev: 1,
    }
    const next = new Map(workflows)
    next.set(item.id, item)
    commitWorkflows(next)
    info('[cs-bots] library.createWorkflow', { id: item.id, name, steps: steps.length })
    return clone(item)
  }

  /**
   * @param {{ id: string, expectedRev: number, name?: string, description?: string, steps?: object[], tags?: string[], by: string, now?: number }} input
   * @returns {object}
   */
  function updateWorkflow(input = {}) {
    assertAlive('updateWorkflow')
    requireBy(input.by, 'updateWorkflow')
    const at = normalizeNow(input.now, 'updateWorkflow')
    const id = requireString(input.id, 'id', 'updateWorkflow')
    const expectedRev = requireRev(input.expectedRev, 'updateWorkflow')
    const current = findById(workflows, id, 'LIB_WORKFLOW_NOT_FOUND', 'updateWorkflow')
    if (current.rev !== expectedRev) {
      throw new LibraryError(
        `updateWorkflow：rev 冲突（期望 ${expectedRev}，实际 ${current.rev}）—— 请重新读取后再改`,
        'LIB_CAS_CONFLICT',
        { id, expectedRev, actualRev: current.rev },
      )
    }

    const next = { ...current }
    if (input.name !== undefined) {
      const name = requireDisplayName(input.name, 'updateWorkflow', 'LIB_BAD_NAME')
      assertFreeName(workflows, name, current.id, 'LIB_WORKFLOW_NAME_TAKEN', 'updateWorkflow')
      next.name = name
    }
    if (input.description !== undefined) {
      next.description = normalizeText(input.description, 'description', LIMITS.description, 'updateWorkflow') ?? ''
    }
    if (input.steps !== undefined) next.steps = normalizeSteps(input.steps, 'updateWorkflow')
    if (input.tags !== undefined) next.tags = normalizeTags(input.tags, 'updateWorkflow') ?? []
    next.rev = current.rev + 1
    next.updatedAt = at

    const map = new Map(workflows)
    map.set(next.id, next)
    commitWorkflows(map)
    return clone(next)
  }

  /**
   * @param {{ id: string, by: string, now?: number }} input
   * @returns {{ id: string, removed: true }}
   */
  function removeWorkflow(input = {}) {
    assertAlive('removeWorkflow')
    requireBy(input.by, 'removeWorkflow')
    normalizeNow(input.now, 'removeWorkflow')
    const id = requireString(input.id, 'id', 'removeWorkflow')
    findById(workflows, id, 'LIB_WORKFLOW_NOT_FOUND', 'removeWorkflow')
    const map = new Map(workflows)
    map.delete(id)
    commitWorkflows(map)
    warn('[cs-bots] library.removeWorkflow', { id })
    return { id, removed: true }
  }

  /**
   * @param {string} id
   * @returns {object}
   */
  function getWorkflow(id) {
    assertAlive('getWorkflow')
    return clone(findById(workflows, id, 'LIB_WORKFLOW_NOT_FOUND', 'getWorkflow'))
  }

  /**
   * @param {{ tag?: string }} [query]
   * @returns {object[]}
   */
  function listWorkflows(query = {}) {
    assertAlive('listWorkflows')
    return filterByTag(workflowsList(), query?.tag)
  }

  // ── 通用 ──────────────────────────────────────────────────────────────────

  /** @returns {{ skills: number, workflows: number }} */
  function stats() {
    assertAlive('stats')
    return { skills: skills.size, workflows: workflows.size }
  }

  /**
   * 从磁盘重建并返回当前内容（重启一致性用：磁盘是真相源）。
   * @returns {{ skills: object[], workflows: object[] }}
   */
  function replay() {
    assertAlive('replay')
    hydrate()
    return { skills: skillsList(), workflows: workflowsList() }
  }

  /** 释放实例：清空内存态并拒绝后续调用（避免半死对象被继续用）。 */
  function dispose() {
    skills = new Map()
    workflows = new Map()
    disposed = true
  }

  /** 构造即 hydrate：坏文件在**创建时**就炸，而不是等第一次写入才炸。 */
  hydrate()

  return {
    paths,
    createSkill,
    updateSkill,
    removeSkill,
    getSkill,
    listSkills,
    createWorkflow,
    updateWorkflow,
    removeWorkflow,
    getWorkflow,
    listWorkflows,
    stats,
    replay,
    dispose,
  }
}

export default createLibrary
