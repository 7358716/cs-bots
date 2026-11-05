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

import { accessSync, constants, existsSync, realpathSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { ensureDir, statePath, writeJsonAtomic } from './store.js'

/** 技能库文件名。 */
export const SKILLS_FILE = 'library-skills.json'

/** 工作流库文件名。 */
export const WORKFLOWS_FILE = 'library-workflows.json'

/** 自定义技能目录清单文件名（与库文件同目录、同原子写风格）。 */
export const SKILL_DIRS_FILE = 'library-skill-dirs.json'

/**
 * 技能来源分层（对标记忆进化插件的技能管理器）。
 *
 * 为什么要分层：用户需要一眼看出「这条技能是哪来的」——
 *   - bundled：宿主/插件随附（升级会被覆盖，用户不该在上面改）
 *   - user：   用户自己攒的全局技能（跨项目复用）
 *   - project：某个项目工作目录里带的技能（换项目就没了）
 *   - custom： 从别处导入/手工粘贴的（来源不明，缺省值）
 * 分层本身不改变技能行为，只用于 UI 分组与批量操作时的取舍。
 */
export const SKILL_SOURCES = Object.freeze(['bundled', 'user', 'custom', 'project'])

/** `browseSkillDir` 单层最多返回的条目数（防超大目录把页面撑爆）。 */
const BROWSE_LIMIT = 500

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

// ── 技能管理：来源 / 启用状态 / 目录安全（模块级纯工具）──────────────────────

/**
 * 归一技能来源。缺省 `custom`（从别处导入/手工粘贴的来源不明，最保守的归类）；
 * 取值不在白名单内一律抛错 —— 悄悄改写成 custom 会让用户的分类习惯失效。
 */
function normalizeSource(value, where) {
  if (value === undefined || value === null) return 'custom'
  if (typeof value !== 'string') {
    throw new LibraryError(`${where}：source 必须是字符串`, 'LIB_BAD_FIELD', { field: 'source', value })
  }
  const source = value.trim().toLowerCase()
  if (!SKILL_SOURCES.includes(source)) {
    throw new LibraryError(
      `${where}：source 只支持 ${SKILL_SOURCES.join(' / ')}，收到 ${JSON.stringify(value)}`,
      'LIB_BAD_FIELD',
      { field: 'source', source: value, allowed: SKILL_SOURCES },
    )
  }
  return source
}

/** 归一启用开关。缺省 `true`（老数据没有这个字段，语义上一直是「启用」）。 */
function normalizeEnabledFlag(value, where) {
  if (value === undefined || value === null) return true
  if (typeof value !== 'boolean') {
    throw new LibraryError(`${where}：enabled 必须是布尔值`, 'LIB_BAD_FIELD', { field: 'enabled', value })
  }
  return value
}

/**
 * 把磁盘上的技能记录补成当前模型（向后兼容的唯一入口）。
 *
 * 为什么只在读取时补、不立刻回写磁盘：读取可能发生在只读场景（列表/回放），
 * 一次查列表就触发写盘是意外的副作用。等下一次真实写操作 commit 时，
 * 归一后的记录自然落盘。
 *
 * 注意「缺字段」与「字段值非法」要区别对待：缺字段=老数据（补缺省），
 * 值非法=文件被改坏（抛 LIB_STORE_CORRUPT，绝不猜）。
 *
 * @param {object} item
 * @param {string} file
 * @returns {object}
 */
function normalizeSkillRecord(item, file) {
  const out = { ...item }
  if (out.source === undefined || out.source === null) {
    out.source = 'custom'
  } else if (typeof out.source !== 'string' || !SKILL_SOURCES.includes(out.source)) {
    throw new LibraryError(
      `技能库文件结构非法：${file} 里技能 ${out.id} 的 source=${JSON.stringify(out.source)} 不在白名单（${SKILL_SOURCES.join('/')}）`,
      'LIB_STORE_CORRUPT',
      { file, id: out.id, source: out.source },
    )
  }
  if (out.enabled === undefined || out.enabled === null) {
    out.enabled = true
  } else if (typeof out.enabled !== 'boolean') {
    throw new LibraryError(
      `技能库文件结构非法：${file} 里技能 ${out.id} 的 enabled=${JSON.stringify(out.enabled)} 不是布尔值`,
      'LIB_STORE_CORRUPT',
      { file, id: out.id, enabled: out.enabled },
    )
  }
  return out
}

/** `child` 是否等于 `parent` 或位于其下（**按路径分段**比较，避免 `/a/bc` 误判在 `/a/b` 里）。 */
function isInside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false
  if (child === parent) return true
  const base = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(base)
}

/** realpath 失败返回 null（目录可能已删除/断链），调用方决定怎么报错。 */
function realpathOrNull(target) {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

/**
 * 受保护目录白名单（挡住「手滑把密钥目录当技能目录挂进来」）。
 *
 * 为什么按白名单硬拦而不是给个警告：`~/.ssh`、`~/.dsh` 里是凭据与运行状态，
 * 一旦被登记成技能目录，后续的「扫描→导入」会把里面的文件当技能读取，
 * 甚至让 UI 浏览/编辑它们 —— 这不是「提醒一下」能兜住的，必须拒绝。
 *
 * 判定在 **realpath 之后**做：`ln -s ~/.ssh /tmp/skills` 这种绕过必须一起拦。
 */
const SYSTEM_SENSITIVE_DIRS = Object.freeze([
  '/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/run',
  '/bin', '/sbin', '/lib', '/lib64', '/usr', '/var', '/opt', '/srv',
])

/** 用户主目录下受保护的子目录（名字，相对主目录）。 */
const HOME_SENSITIVE_NAMES = Object.freeze([
  '.dsh', '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store',
])

/**
 * 判断一个**已 realpath 规范化**的目录是否属于受保护路径。
 * @returns {string|null} 拒绝原因（null = 允许登记）
 */
function describeProtectedDir(canonical) {
  if (canonical === '/') return '不能把根目录登记为技能目录'
  for (const protectedDir of SYSTEM_SENSITIVE_DIRS) {
    if (isInside(canonical, protectedDir) || isInside(protectedDir, canonical)) {
      return `目录位于受保护的系统路径 ${protectedDir} 附近，拒绝登记（防止误挂系统/凭据目录）`
    }
  }
  let home
  try { home = homedir() } catch { home = undefined }
  if (home) {
    if (canonical === home) return '不能把用户主目录本身登记为技能目录'
    for (const name of HOME_SENSITIVE_NAMES) {
      const protectedPath = join(home, name)
      if (isInside(canonical, protectedPath) || isInside(protectedPath, canonical)) {
        return `目录与受保护路径 ${protectedPath} 重叠，拒绝登记（含凭据/运行状态，不能当技能目录）`
      }
    }
    // 主目录的上级（如 /home）也不许登记：会把别人的目录一起纳入浏览范围
    if (isInside(home, canonical)) return `不能把用户主目录的上级目录 ${canonical} 登记为技能目录`
  }
  return null
}

/**
 * 工作流步骤校验：非空数组、≤50 步、每步 title 必填。
 * 只取认识的字段（title / detail / ownerHint / done），其余忽略 —— 与
 * `botprofile.normalizeProfile` 的口径一致：多给的键属于调用方的自由，不是数据。
 */function normalizeSteps(value, where) {
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

// ── SKILL.md 解析 / 目录扫描（纯函数，不碰库状态）────────────────────────────
//
// 为什么不引 yaml：① 零第三方依赖是 cs-bots 铁律（CI 检查 2 机械拦截）；
// ② 我们只需要 name/description/tags 三个标量，frontmatter 的实际写法极窄，
//    引一个 yaml 解析器换来的复杂度（别名、多文档、锚点）远大于收益。
// 因此这里自己做**行级**解析：`key: value`，遇到不认识的键跳过（真实世界的
// SKILL.md 常带 allowed-tools/license 等扩展键，硬拒会让扫描真实目录全军覆没），
// 但语法坏（未闭合 fence、不是 key: value、引号不闭合）必须抛错，不静默吞。

/** 合法 kebab-case：小写字母/数字分段，段间单个 `-`。 */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** frontmatter 的 fence（官方约定就是三个短横线）。 */
const FENCE = '---'

/**
 * 导出多技能时的分隔标记。
 *
 * 为什么要有显式分隔：`exportSkills` 返回的是一段 markdown，导入方（人或另一个
 * 实例）必须能把「一份 SKILL.md」切出来才能逐条 parse。用 `---` 当分隔会和
 * frontmatter 的 fence 撞车，所以用一条 HTML 注释当分隔符（Markdown 渲染时不可见）。
 */
export const EXPORT_SEPARATOR = '\n<!-- cs-bots:skill-break -->\n'

/** 构造 LIB_BAD_SKILL_MD（解析失败的唯一错误码，HTTP 层按它映射 400）。 */
function badSkillMd(message, detail) {
  return new LibraryError(message, 'LIB_BAD_SKILL_MD', detail)
}

/**
 * 从文件名兜底推技能名：
 *   - `<dir>/<name>/SKILL.md` → 取**目录名**（官方技能标准布局）；
 *   - `<dir>/<name>.md`       → 取文件名去 `.md`。
 * 为什么要兜底：手写 SKILL.md 常漏 frontmatter，而目录名已经表达了技能名；
 * 此时因为「没写 name」整份文件作废，对用户是纯损失。
 */
function nameFromFilename(filename) {
  if (typeof filename !== 'string' || filename.trim() === '') return undefined
  let stem
  try {
    stem = basename(filename.trim()).replace(/\.md$/i, '')
    if (stem.toLowerCase() === 'skill') {
      const parent = basename(dirname(filename.trim()))
      stem = parent && parent !== '.' && parent !== '..' ? parent : ''
    }
  } catch {
    return undefined
  }
  return stem || undefined
}

/** 去掉值两侧引号：支持 JSON 双引号（含转义）与单引号；引号没闭合=语法坏。 */
function unquote(raw, where) {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw badSkillMd(`${where}：frontmatter 值引号未闭合：${JSON.stringify(value)}`, { value })
    }
    try {
      return JSON.parse(value)
    } catch {
      throw badSkillMd(`${where}：frontmatter 双引号值不是合法 JSON 字符串：${JSON.stringify(value)}`, { value })
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw badSkillMd(`${where}：frontmatter 值引号未闭合：${JSON.stringify(value)}`, { value })
    }
    return value.slice(1, -1)
  }
  return value
}

/**
 * 按逗号切分 tags，**尊重引号**。
 *
 * 为什么不能裸 `split(',')`：标签本身可以合法地含有逗号（例如 `["a,b"]`），
 * 裸切会把一个 tag 劈成两个，属于静默数据破坏。这里用一个极小的状态机。
 */
function splitTagList(inner, where) {
  /** @type {string[]} */
  const parts = []
  let current = ''
  let quote = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      // 双引号里允许反斜杠转义，原样带下去交给 unquote 的 JSON.parse 处理
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        current += ch + inner[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = null
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (quote) throw badSkillMd(`${where}：tags 里的引号未闭合：${JSON.stringify(inner)}`, { inner })
  parts.push(current)
  return parts.map((part) => unquote(part, where)).filter((tag) => tag !== '')
}

/**
 * 解析一行 `tags:` 的值。支持两种真实写法：
 *   - `tags: [review, quality]`（方括号数组）
 *   - `tags: review, quality`（裸逗号分隔）
 * 不支持 YAML 对象形态（`tags: {a: b}`）—— 我们不是 YAML 解析器，遇到就明确报错。
 */
function parseTagsValue(raw, where) {
  const value = String(raw ?? '').trim()
  if (value === '') return []
  if (value.startsWith('{')) {
    throw badSkillMd(`${where}：tags 不支持对象写法（只支持 [a, b] 或逗号分隔）：${JSON.stringify(value)}`, { value })
  }
  const bracketOpen = value.startsWith('[')
  const bracketClose = value.endsWith(']')
  if (bracketOpen !== bracketClose) {
    throw badSkillMd(`${where}：tags 的方括号不配对：${JSON.stringify(value)}`, { value })
  }
  const inner = bracketOpen ? value.slice(1, -1) : value
  return splitTagList(inner, where)
}

/**
 * 解析 SKILL.md（`--- frontmatter ---` + 正文）。
 *
 * 返回四字段固定结构（调用方据此落库）。**本函数只做提取**：
 * name 是否为 kebab-case、body 是否超长这类「业务校验」留给 importSkills ——
 * 因为导入契约要求非法条目进 `errors` 而不是让整批炸掉。
 *
 * @param {{ text: string, filename?: string }} input
 * @returns {{ name: string, description: string, body: string, tags: string[] }}
 */
export function parseSkillMarkdown(input = {}) {
  const text = input?.text
  if (typeof text !== 'string') {
    throw new LibraryError('parseSkillMarkdown：text 必填（SKILL.md 全文）', 'LIB_BAD_FIELD', { field: 'text' })
  }
  const filename = input?.filename
  const where = typeof filename === 'string' && filename ? `parseSkillMarkdown(${filename})` : 'parseSkillMarkdown'

  // Windows 换行与 BOM 都要兼容：自己下载/复制的技能文件常带 BOM
  const source = text.replace(/^\uFEFF/, '')
  const lines = source.split(/\r?\n/)

  // 允许 frontmatter 之前有空行（有宿主会在文件头插空行）
  let cursor = 0
  while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1

  let name
  let description = ''
  let tags = []
  let bodyStart = 0

  if (cursor < lines.length && lines[cursor].trim() === FENCE) {
    let end = -1
    for (let i = cursor + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === FENCE) { end = i; break }
    }
    if (end < 0) {
      throw badSkillMd(`${where}：frontmatter 未闭合（找不到结束的 ${FENCE}）`, { filename })
    }
    const rows = lines.slice(cursor + 1, end)
    for (const [offset, row] of rows.entries()) {
      const trimmed = row.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const colon = row.indexOf(':')
      if (colon < 0) {
        throw badSkillMd(
          `${where}：frontmatter 第 ${offset + 1} 行不是 key: value 形式：${JSON.stringify(row)}`,
          { filename, line: offset + 1 },
        )
      }
      const key = row.slice(0, colon).trim().toLowerCase()
      const value = row.slice(colon + 1)
      if (key === 'name') name = unquote(value, where)
      else if (key === 'description') description = unquote(value, where)
      else if (key === 'tags') tags = parseTagsValue(value, where)
      // 其余键（allowed-tools / license / version …）忽略：不是本库的数据，拒绝反而会
      // 让真实世界的技能文件整批导入失败。
    }
    bodyStart = end + 1
  }

  // 名字缺失时退到文件名/目录名；仍然没有才报错（此时无法确定它叫什么）
  if (typeof name !== 'string' || name.trim() === '') {
    const fallback = nameFromFilename(filename)
    if (!fallback) {
      throw badSkillMd(`${where}：缺少 name（frontmatter 没写，文件路径也推不出来）`, { filename })
    }
    name = fallback
  }
  name = name.trim()
  if (/[\u0000-\u001f]/.test(name)) {
    throw badSkillMd(`${where}：name 含控制字符：${JSON.stringify(name)}`, { filename, name })
  }

  // 正文：去掉 frontmatter 后的分隔空行与尾部空白。末尾空白一律裁掉 ——
  // Markdown 结构里它不承载语义，留着只会在往返导出时制造噪声 diff。
  const body = lines.slice(bodyStart).join('\n').replace(/^[\r\n]+/, '').replace(/\s+$/, '')

  return { name, description: String(description ?? '').trim(), body, tags }
}

/**
 * 扫描一个技能根目录（纯读取，不写库、不落盘）。
 *
 * 兼容两种布局：
 *   - `<dir>/<name>/SKILL.md`（官方标准）
 *   - `<dir>/<name>.md`（单文件技能，常见于手工导出）
 *
 * 为什么要显式排序：`readdirSync` 的顺序由文件系统决定（ext4 与 APFS 不同），
 * 同一目录在两台机器上得到不同顺序会让「扫描→导入」的结果不可复现。
 *
 * @param {{ dir: string }} input
 * @returns {{ items: object[], errors: { path: string, reason: string }[] }}
 */
export function scanSkillsDir(input = {}) {
  const rawDir = input?.dir
  if (typeof rawDir !== 'string' || rawDir.trim() === '') {
    throw new LibraryError('scanSkillsDir：dir 必填（技能根目录，如 <cwd>/.agents/skills）', 'LIB_BAD_DIR', { dir: rawDir })
  }
  const dir = resolve(rawDir.trim())
  try {
    if (!statSync(dir).isDirectory()) {
      throw new LibraryError(`scanSkillsDir：不是目录：${dir}`, 'LIB_BAD_DIR', { dir })
    }
  } catch (error) {
    if (error instanceof LibraryError) throw error
    throw new LibraryError(`scanSkillsDir：目录不存在或不可访问：${dir}`, 'LIB_BAD_DIR', { dir, cause: String(error?.message ?? error) })
  }

  let names
  try {
    // 只取名字，类型用 statSync 再判：这样**符号链接**（把共享技能仓 link 进来的
    // 常见做法）也能被正确识别 —— Dirent 的 isDirectory() 对符号链接一律 false，
    // 会导致「目录明明在、扫出来却是空的」。
    names = readdirSync(dir)
  } catch (error) {
    throw new LibraryError(`scanSkillsDir：读取目录失败：${dir}`, 'LIB_BAD_DIR', { dir, cause: String(error?.message ?? error) })
  }
  names.sort()

  const items = []
  const errors = []
  for (const name of names) {
    // 跳过隐藏项（.git / .DS_Store / .tmp-*）：它们不是技能
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue // 断链符号链接之类：不是可读技能，跳过
    }
    let file
    if (stat.isDirectory()) {
      file = join(full, 'SKILL.md')
      let hasFile = false
      try { hasFile = statSync(file).isFile() } catch { hasFile = false }
      // 没有 SKILL.md 的子目录不是技能目录（技能根下常有 notes/、assets/），
      // 静默跳过而不是记 error —— 记 error 会把正常目录噪音化成失败。
      if (!hasFile) continue
    } else if (stat.isFile() && /\.md$/i.test(name)) {
      file = full
    } else {
      continue
    }

    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      errors.push({ path: file, reason: `LIB_SKILL_READ_FAILED：${error?.message ?? error}` })
      continue
    }
    try {
      items.push({ ...parseSkillMarkdown({ text, filename: file }), sourcePath: file })
    } catch (error) {
      errors.push({ path: file, reason: `${error?.code ?? 'ERROR'}：${error?.message ?? error}` })
    }
  }
  return { items, errors }
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
  const skillDirsFile = statePath(stateDir, SKILL_DIRS_FILE)
  const paths = Object.freeze({ stateDir, skillsFile, workflowsFile, skillDirsFile })

  const info = (...args) => { try { ctx?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { ctx?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} 技能 id → 技能条目（创建序不可靠，输出时统一排序） */
  let skills = new Map()
  /** @type {Map<string, object>} 工作流 id → 工作流条目 */
  let workflows = new Map()
  /**
   * 已登记的自定义技能目录：id = 规范化后的绝对路径（目录本身唯一，无需再生成 id）。
   * @type {Map<string, {id: string, dir: string, label: string, addedAt: number, addedBy: string}>}
   */
  let skillDirs = new Map()
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

  /**
   * 技能目录清单提交：先落盘、成功后再换内存（同 commitSkills 顺序）。
   * 排序口径：登记时间 → 目录路径，保证同一个状态目录在不同机器上落盘字节一致。
   */
  function commitSkillDirs(next) {
    const items = [...next.values()].sort((a, b) => {
      const at = Number(a.addedAt) || 0
      const bt = Number(b.addedAt) || 0
      if (at !== bt) return at - bt
      return String(a.dir) < String(b.dir) ? -1 : String(a.dir) > String(b.dir) ? 1 : 0
    })
    persist(skillDirsFile, items, '技能目录清单')
    skillDirs = next
  }

  /** 从磁盘重建内存态（构造与 `replay()` 都用它）。坏文件在这里抛，不在读取时偷偷吞掉。 */
  function hydrate() {
    const nextSkills = new Map()
    for (const item of readStore(skillsFile)) {
      if (nextSkills.has(item.id)) {
        throw new LibraryError(`技能库文件里有重复 id：${item.id}（${skillsFile}）`, 'LIB_STORE_CORRUPT', { file: skillsFile, id: item.id })
      }
      // 老数据没有 source/enabled：读取时补缺省值（enable=true / source=custom），
      // 不在这里回写磁盘（读取不该有写副作用），下次真实写操作时自然归一。
      nextSkills.set(item.id, normalizeSkillRecord(item, skillsFile))
    }
    const nextWorkflows = new Map()
    for (const item of readStore(workflowsFile)) {
      if (nextWorkflows.has(item.id)) {
        throw new LibraryError(`工作流库文件里有重复 id：${item.id}（${workflowsFile}）`, 'LIB_STORE_CORRUPT', { file: workflowsFile, id: item.id })
      }
      nextWorkflows.set(item.id, item)
    }
    const nextSkillDirs = new Map()
    for (const item of readStore(skillDirsFile)) {
      // id 必须等于 dir（登记时就是这样写的）；不一致说明文件被手改坏，拒绝猜
      if (item.id !== item.dir) {
        throw new LibraryError(
          `技能目录清单结构非法：${skillDirsFile} 里 id 与 dir 不一致（${JSON.stringify(item.id)} vs ${JSON.stringify(item.dir)}）`,
          'LIB_STORE_CORRUPT',
          { file: skillDirsFile, id: item.id, dir: item.dir },
        )
      }
      if (nextSkillDirs.has(item.id)) {
        throw new LibraryError(`技能目录清单里有重复目录：${item.id}（${skillDirsFile}）`, 'LIB_STORE_CORRUPT', { file: skillDirsFile, dir: item.id })
      }
      nextSkillDirs.set(item.id, item)
    }
    skills = nextSkills
    workflows = nextWorkflows
    skillDirs = nextSkillDirs
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
   * `source` 缺省 `custom`、`enabled` 缺省 `true`（见 SKILL_SOURCES / normalizeEnabledFlag）。
   * @param {{ name: string, description?: string, body: string, tags?: string[], source?: string, enabled?: boolean, by: string, now?: number }} input
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
    const source = normalizeSource(input.source, 'createSkill')
    const enabled = normalizeEnabledFlag(input.enabled, 'createSkill')

    const item = {
      id: nextId('sk', skills),
      name,
      description,
      body,
      tags,
      source,
      enabled,
      createdAt: at,
      updatedAt: at,
      rev: 1,
    }
    const next = new Map(skills)
    next.set(item.id, item)
    commitSkills(next)
    info('[cs-bots] library.createSkill', { id: item.id, name, source, enabled })
    return clone(item)
  }

  /**
   * 按 `expectedRev` 做 CAS 更新。**rev 不匹配即抛错，绝不静默覆盖。**
   * `source`/`enabled` 也可在这里改（可选）；专门的开关/来源入口见 setSkillEnabled / setSkillSource。
   * @param {{ id: string, expectedRev: number, name?: string, description?: string, body?: string, tags?: string[], source?: string, enabled?: boolean, by: string, now?: number }} input
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
    // source/enabled 只在显式传了才改：不传保持原值（老调用方无感知）
    if (input.source !== undefined) next.source = normalizeSource(input.source, 'updateSkill')
    if (input.enabled !== undefined) next.enabled = normalizeEnabledFlag(input.enabled, 'updateSkill')
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
   * 列技能（支持按 tag / 来源 / 启用状态 / 关键词过滤 + 条数上限）。
   *
   * 缺省**不返回禁用技能**（禁用=「先别用」，不是「删了」；列表里不该出现）；
   * 要连禁用一起看，显式传 `enabled:false`（只看禁用）或 `all:true`（全要）。
   *
   * @param {{ tag?: string, source?: string, enabled?: boolean, all?: boolean, query?: string, limit?: number }} [query]
   * @returns {object[]}
   */
  function listSkills(query = {}) {
    assertAlive('listSkills')
    const q = query ?? {}
    const all = q.all === true
    if (q.all !== undefined && typeof q.all !== 'boolean') {
      throw new LibraryError('listSkills：all 必须是布尔值', 'LIB_BAD_FIELD', { field: 'all', all: q.all })
    }

    let items = filterByTag(skillsList(), q.tag)
    if (q.enabled !== undefined && q.enabled !== null) {
      if (typeof q.enabled !== 'boolean') {
        throw new LibraryError('listSkills：enabled 必须是布尔值', 'LIB_BAD_FIELD', { field: 'enabled', enabled: q.enabled })
      }
      items = items.filter((item) => (item.enabled !== false) === q.enabled)
    } else if (!all) {
      // 缺省视图：只看启用中的
      items = items.filter((item) => item.enabled !== false)
    }

    if (q.source !== undefined && q.source !== null) {
      if (typeof q.source !== 'string') {
        throw new LibraryError('listSkills：source 必须是字符串', 'LIB_BAD_FIELD', { field: 'source', source: q.source })
      }
      const source = q.source.trim().toLowerCase()
      if (source && !SKILL_SOURCES.includes(source)) {
        throw new LibraryError(
          `listSkills：source 只支持 ${SKILL_SOURCES.join(' / ')}，收到 ${JSON.stringify(q.source)}`,
          'LIB_BAD_FIELD',
          { field: 'source', source: q.source, allowed: SKILL_SOURCES },
        )
      }
      if (source) items = items.filter((item) => item.source === source)
    }

    if (q.query !== undefined && q.query !== null) {
      if (typeof q.query !== 'string') {
        throw new LibraryError('listSkills：query 必须是字符串', 'LIB_BAD_FIELD', { field: 'query', query: q.query })
      }
      const key = q.query.trim().toLowerCase()
      if (key) {
        // 搜名字/说明/标签/正文：UI 只有一个搜索框，用户不会先想「我要搜哪个字段」
        items = items.filter((item) => [item.name, item.description, ...(item.tags ?? []), item.body]
          .some((value) => String(value ?? '').toLowerCase().includes(key)))
      }
    }

    if (q.limit !== undefined && q.limit !== null) {
      if (typeof q.limit !== 'number' || !Number.isInteger(q.limit) || q.limit < 1) {
        throw new LibraryError('listSkills：limit 必须是正整数', 'LIB_BAD_FIELD', { field: 'limit', limit: q.limit })
      }
      items = items.slice(0, q.limit)
    }
    return items
  }

  /**
   * CAS 补丁：把 `patch` 应用到指定技能上（rev+1、updatedAt=now）。
   * 单独抽出来是因为「启用开关」和「改来源」除了改的字段不同，其余校验/落盘完全一样，
   * 复制两遍必然有一处将来漏改（例如忘了 CAS）。
   */
  function patchSkill(input, where, patch) {
    assertAlive(where)
    requireBy(input.by, where)
    const at = normalizeNow(input.now, where)
    const id = requireString(input.id, 'id', where)
    const expectedRev = requireRev(input.expectedRev, where)
    const current = findById(skills, id, 'LIB_SKILL_NOT_FOUND', where)
    if (current.rev !== expectedRev) {
      throw new LibraryError(
        `${where}：rev 冲突（期望 ${expectedRev}，实际 ${current.rev}）—— 请重新读取后再改`,
        'LIB_CAS_CONFLICT',
        { id, expectedRev, actualRev: current.rev },
      )
    }
    const next = { ...current, ...patch(current), rev: current.rev + 1, updatedAt: at }
    const map = new Map(skills)
    map.set(next.id, next)
    commitSkills(map)
    return clone(next)
  }

  /**
   * 启用/停用技能（不删除就能停用）。重复设成同一个值也会 rev+1 —— 保持
   * 「每次调用都是一次写入」的简单语义，UI 靠 rev 判断是否有变化。
   * @param {{ id: string, enabled: boolean, by: string, expectedRev: number, now?: number }} input
   * @returns {object}
   */
  function setSkillEnabled(input = {}) {
    const enabled = normalizeEnabledFlag(input?.enabled, 'setSkillEnabled')
    if (input?.enabled === undefined || input?.enabled === null) {
      throw new LibraryError('setSkillEnabled：enabled 必填（布尔值）', 'LIB_BAD_FIELD', { field: 'enabled' })
    }
    const skill = patchSkill(input, 'setSkillEnabled', () => ({ enabled }))
    info('[cs-bots] library.setSkillEnabled', { id: skill.id, enabled })
    return skill
  }

  /**
   * 改技能来源分层（只改分类，不动内容）。
   * @param {{ id: string, source: string, by: string, expectedRev: number, now?: number }} input
   * @returns {object}
   */
  function setSkillSource(input = {}) {
    if (input?.source === undefined || input?.source === null) {
      throw new LibraryError('setSkillSource：source 必填（bundled / user / custom / project）', 'LIB_BAD_FIELD', { field: 'source' })
    }
    const source = normalizeSource(input.source, 'setSkillSource')
    const skill = patchSkill(input, 'setSkillSource', () => ({ source }))
    info('[cs-bots] library.setSkillSource', { id: skill.id, source })
    return skill
  }

  // ── 技能批量导入 / 导出 ───────────────────────────────────────────────────
  //
  // 导入的纪律：**单条非法只记进 errors，绝不中断整批**。
  // 依据需求场景 —— 用户从别处拖进来 30 个技能，其中 2 个名字不合法；
  // 若整批抛错，用户得自己一个个试，28 个合法条目也白等了。
  // 但「存储写失败」是环境故障，不能当成单条错误吞掉（否则每条都失败一遍、
  // 返回一堆 errors 让人以为只是数据问题）—— 这类错误一律原样抛出。

  /** 导入模式白名单。 */
  const IMPORT_MODES = new Set(['skip', 'overwrite', 'rename'])

  /** 这些错误码属于「环境/存储」故障，导入时不可降级成单条 errors。 */
  const FATAL_IMPORT_CODES = new Set([
    'LIB_STORE_WRITE_FAILED',
    'LIB_STORE_READ_FAILED',
    'LIB_STORE_CORRUPT',
    'LIB_STORE_VERSION',
    'LIB_BAD_STATE_DIR',
    'LIB_DISPOSED',
  ])

  /** 判断一个错误是否该中断整批（存储故障/实例已释放）。 */
  function isFatalLibraryError(error) {
    return error instanceof LibraryError && FATAL_IMPORT_CODES.has(error.code)
  }

  /** 按名字（大小写不敏感）找已有技能。 */
  function findSkillByNameKey(name) {
    const key = nameKey(name)
    for (const item of skills.values()) {
      if (nameKey(item.name) === key) return item
    }
    return undefined
  }

  /**
   * 为 `rename` 模式生成一个空位名字：`base-2`、`base-3`…
   *
   * 长度保护：技能名上限 64，`base` 刚好 64 时直接拼 `-2` 会超限甚至被
   * requireName 拒掉，所以先裁 `base` 再拼；裁完去掉尾部连字符，保持 kebab 合法。
   */
  function nextFreeSkillName(base) {
    for (let n = 2; n <= 100; n += 1) {
      const suffix = `-${n}`
      let stem = base
      if (stem.length + suffix.length > LIMITS.name) stem = stem.slice(0, Math.max(1, LIMITS.name - suffix.length))
      stem = stem.replace(/-+$/, '') || 'skill'
      const candidate = `${stem}${suffix}`
      if (!KEBAB_RE.test(candidate)) continue
      if (!findSkillByNameKey(candidate)) return candidate
    }
    throw new LibraryError(
      `importSkills：改名失败，${JSON.stringify(base)} 的 -2 … -100 后缀全部被占用`,
      'LIB_SKILL_NAME_TAKEN',
      { name: base },
    )
  }

  /**
   * 把一条 import 输入归一成 `{ name, description, body, tags, source?, enabled? }`。
   * 支持三种输入（都为了「少让调用方写转换代码」）：
   *   - 完整对象 `{ name, description, body, tags }`（parseSkillMarkdown 的输出）
   *   - 带原文的对象 `{ text, filename }`（直接从文件读出来的内容）
   *   - 纯字符串（一段 SKILL.md 全文，名字从 frontmatter 取）
   * source/enabled 只在对象输入里透传（SKILL.md 的 frontmatter 契约只认
   * name/description/tags，不在这里夹带私有字段，否则导出给别的工具会变脏）。
   */
  function normalizeImportItem(raw, index) {
    const where = `importSkills.items[${index}]`
    let doc
    let source
    let enabled
    if (typeof raw === 'string') {
      doc = parseSkillMarkdown({ text: raw })
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      doc = typeof raw.text === 'string'
        ? parseSkillMarkdown({ text: raw.text, filename: raw.filename })
        : { name: raw.name, description: raw.description, body: raw.body, tags: raw.tags }
      source = raw.source
      enabled = raw.enabled
    } else {
      throw new LibraryError(`${where}：条目必须是对象或 SKILL.md 字符串`, 'LIB_BAD_FIELD', { index })
    }
    return {
      name: typeof doc.name === 'string' ? doc.name.trim() : '',
      description: doc.description === undefined ? '' : doc.description,
      body: doc.body,
      tags: doc.tags,
      source,
      enabled,
    }
  }

  /**
   * 批量导入技能（去重规则见 DESIGN-v2 特性 ⑤）。
   *
   * @param {{
   *   items: (object|string)[],
   *   by: string,
   *   mode?: 'skip'|'overwrite'|'rename',
   *   now?: number,
   * }} input
   * @returns {{
   *   created: object[],
   *   updated: object[],
   *   skipped: { name: string, id: string }[],
   *   errors: { name: string, reason: string }[],
   * }}
   */
  function importSkills(input = {}) {
    assertAlive('importSkills')
    const by = requireBy(input.by, 'importSkills')
    const at = normalizeNow(input.now, 'importSkills')
    const mode = input.mode === undefined || input.mode === null ? 'skip' : input.mode
    if (!IMPORT_MODES.has(mode)) {
      throw new LibraryError(
        `importSkills：mode 只支持 skip / overwrite / rename，收到 ${JSON.stringify(input.mode)}`,
        'LIB_BAD_FIELD',
        { field: 'mode', mode: input.mode },
      )
    }
    const rawItems = input.items
    if (!Array.isArray(rawItems)) {
      throw new LibraryError('importSkills：items 必须是数组', 'LIB_BAD_FIELD', { field: 'items' })
    }

    /** @type {object[]} */ const created = []
    /** @type {object[]} */ const updated = []
    /** @type {{name: string, id: string}[]} */ const skipped = []
    /** @type {{name: string, reason: string}[]} */ const errors = []

    for (const [index, raw] of rawItems.entries()) {
      let spec
      try {
        spec = normalizeImportItem(raw, index)
      } catch (error) {
        if (isFatalLibraryError(error)) throw error
        errors.push({ name: `#${index}`, reason: `${error?.code ?? 'ERROR'}：${error?.message ?? error}` })
        continue
      }

      const label = spec.name || `#${index}`
      try {
        // kebab-case 硬校验：导入是外部数据的入口，这里比库内 NAME_RE 更严 ——
        // 目标是「一处写、处处能当目录名」，大写/下划线/点一律不收。
        if (!KEBAB_RE.test(spec.name)) {
          throw new LibraryError(
            `name 不是 kebab-case：${JSON.stringify(spec.name)}（只允许小写字母/数字，段间单个 -）`,
            'LIB_BAD_NAME',
            { name: spec.name },
          )
        }
        // 正文必填前置校验：否则 overwrite 时 updateSkill 拿到 undefined body 会
        // 「什么都不改」还返回成功 —— 那是静默失败。
        requireBody(spec.body, 'importSkills')

        const existing = findSkillByNameKey(spec.name)
        if (!existing) {
          created.push(createSkill({
            name: spec.name,
            description: spec.description,
            body: spec.body,
            tags: spec.tags,
            source: spec.source,
            enabled: spec.enabled,
            by,
            now: at,
          }))
          continue
        }
        if (mode === 'skip') {
          // 跳过只看名字：同名即视为「已经有了」，不做内容比较（内容比较会把
          // 一次导入变成一次 diff 服务，且「一样但仍写一次」也无意义）。
          skipped.push({ name: existing.name, id: existing.id })
          continue
        }
        if (mode === 'overwrite') {
          updated.push(updateSkill({
            id: existing.id,
            expectedRev: existing.rev,
            name: spec.name,
            description: spec.description ?? '',
            body: spec.body,
            tags: spec.tags ?? [],
            // source/enabled 未给（undefined）时 updateSkill 保持原值：
            // 「覆盖正文」不该顺手把用户设的停用状态/来源分类重置掉
            source: spec.source,
            enabled: spec.enabled,
            by,
            now: at,
          }))
          continue
        }
        // rename：目标名被占，换一个不冲突的后缀
        const target = nextFreeSkillName(spec.name)
        created.push(createSkill({
          name: target,
          description: spec.description,
          body: spec.body,
          tags: spec.tags,
          source: spec.source,
          enabled: spec.enabled,
          by,
          now: at,
        }))
      } catch (error) {
        if (isFatalLibraryError(error)) throw error
        errors.push({ name: label, reason: `${error?.code ?? 'ERROR'}：${error?.message ?? error}` })
      }
    }

    info('[cs-bots] library.importSkills', {
      mode,
      created: created.length,
      updated: updated.length,
      skipped: skipped.length,
      errors: errors.length,
    })
    return { created, updated, skipped, errors }
  }

  /** 渲染单条技能为 SKILL.md 文本（frontmatter + 正文）。 */
  function renderSkillMarkdown(item) {
    const head = [FENCE, `name: ${item.name}`]
    if (item.description) head.push(`description: ${JSON.stringify(item.description)}`)
    if (Array.isArray(item.tags) && item.tags.length > 0) {
      // 含逗号/方括号/引号的 tag 必须加引号，否则 parse 时会被逗号切开
      const rendered = item.tags.map((tag) => (/[,[\]"']/.test(tag) ? JSON.stringify(tag) : tag))
      head.push(`tags: [${rendered.join(', ')}]`)
    }
    head.push(FENCE, '')
    return `${head.join('\n')}${String(item.body ?? '').trimEnd()}\n`
  }

  /**
   * 导出技能为 markdown（多份之间用 `EXPORT_SEPARATOR` 分隔）。
   *
   * `ids` 省略 = 导出全部（备份/迁移场景的默认期望）；显式给 id 时**未知 id 抛错**，
   * 不静默丢弃 —— 迁移少一条技能，事后没人能发现。
   *
   * **禁用的技能不导出**：导出是为了「拿去别处用」，把一个用户明确停用的技能
   * 带到新机器上并默认启用，等于绕过他的决定。想导出请先启用。
   *
   * @param {{ ids?: string[] }} [input]
   * @returns {{ markdown: string, count: number }}
   */
  function exportSkills(input = {}) {
    assertAlive('exportSkills')
    const rawIds = input?.ids
    let items
    if (rawIds === undefined || rawIds === null) {
      items = skillsList().filter((item) => item.enabled !== false)
    } else {
      if (!Array.isArray(rawIds)) {
        throw new LibraryError('exportSkills：ids 必须是技能 id 数组', 'LIB_BAD_FIELD', { field: 'ids' })
      }
      /** @type {Set<string>} */ const seen = new Set()
      items = []
      for (const rawId of rawIds) {
        const id = requireString(rawId, 'ids 里的 id', 'exportSkills')
        const item = findById(skills, id, 'LIB_SKILL_NOT_FOUND', 'exportSkills')
        if (seen.has(item.id)) continue // 重复 id 只导一份，count 才可信
        seen.add(item.id)
        if (item.enabled === false) continue // 禁用项跳过（见上面的注释）
        items.push(clone(item))
      }
    }
    const markdown = items.map(renderSkillMarkdown).join(EXPORT_SEPARATOR)
    return { markdown, count: items.length }
  }

  /** 实例方法版 parseSkillMarkdown（只是加 dispose 检查，逻辑全在模块级纯函数里）。 */
  function skillMdParser(input) {
    assertAlive('parseSkillMarkdown')
    return parseSkillMarkdown(input)
  }

  /** 实例方法版 scanSkillsDir（同上）。 */
  function skillDirScanner(input) {
    assertAlive('scanSkillsDir')
    return scanSkillsDir(input)
  }

  // ── 技能管理器：自定义目录 + 目录树浏览（特性⑩）──────────────────────────
  //
  // 设计取舍：**登记的是「目录」，不是「目录里的技能」**。
  // 技能内容留在磁盘上（那是真相源，用户可能用 git 管理），库里只存
  // 「哪些目录值得扫/浏览/导入」。这样不会出现「库里的技能副本与磁盘文件
  // 谁为准」的第二真相源问题。

  /** 目录标签：缺省用目录名（UI 需要一个短名字，不能让用户看到一长串路径）。 */
  function normalizeDirLabel(value, dir, where) {
    if (value === undefined || value === null) {
      const base = basename(dir)
      return base || dir
    }
    if (typeof value !== 'string') {
      throw new LibraryError(`${where}：label 必须是字符串`, 'LIB_BAD_FIELD', { field: 'label' })
    }
    const label = value.trim()
    if (label === '') {
      throw new LibraryError(`${where}：label 不能是空字符串（不需要就干脆不传）`, 'LIB_BAD_FIELD', { field: 'label' })
    }
    if (label.length > LIMITS.name * 2) {
      throw new LibraryError(`${where}：label 超长 ${label.length} > ${LIMITS.name * 2} 字符`, 'LIB_TOO_LONG', { field: 'label', length: label.length })
    }
    if (/[\u0000-\u001f]/.test(label)) {
      throw new LibraryError(`${where}：label 不能含控制字符`, 'LIB_BAD_FIELD', { field: 'label' })
    }
    return label
  }

  /** 登记顺序稳定（addedAt → dir），保证 listSkillDirs 输出可复现。 */
  function sortedSkillDirRecords() {
    return [...skillDirs.values()].sort((a, b) => {
      const at = Number(a.addedAt) || 0
      const bt = Number(b.addedAt) || 0
      if (at !== bt) return at - bt
      return String(a.dir) < String(b.dir) ? -1 : String(a.dir) > String(b.dir) ? 1 : 0
    })
  }

  /**
   * 扫描单个**已登记**目录（listSkillDirs 与 scanAllSkillDirs 共用，避免一次调用扫两遍）。
   * 目录被删/被移走返回 exists:false，不抛错 —— 「列清单」这个动作本身不该因为
   * 某个目录消失就整页失败。
   */
  function scanRegisteredDir(record) {
    let stat
    try {
      stat = statSync(record.dir)
    } catch {
      return { exists: false, skillCount: 0, items: [], errors: [] }
    }
    if (!stat.isDirectory()) return { exists: false, skillCount: 0, items: [], errors: [] }
    try {
      const scanned = scanSkillsDir({ dir: record.dir })
      return { exists: true, skillCount: scanned.items.length, items: scanned.items, errors: scanned.errors }
    } catch (error) {
      return {
        exists: true,
        skillCount: 0,
        items: [],
        errors: [{ path: record.dir, reason: `${error?.code ?? 'ERROR'}：${error?.message ?? error}` }],
      }
    }
  }

  /**
   * 列出已登记的自定义技能目录。
   * `exists` / `skillCount` 是**实时探测**的（磁盘是真相源），不落盘缓存：
   * 目录可能随时被移动/删除，缓存只会让 UI 显示过期信息。
   *
   * @returns {{ dir: string, label: string, addedAt: number, exists: boolean, skillCount: number }[]}
   */
  function listSkillDirs() {
    assertAlive('listSkillDirs')
    return sortedSkillDirRecords().map((record) => {
      const scanned = scanRegisteredDir(record)
      return {
        dir: record.dir,
        label: record.label,
        addedAt: record.addedAt,
        exists: scanned.exists,
        skillCount: scanned.skillCount,
      }
    })
  }

  /**
   * 登记一个自定义技能目录（用户可以把别处的技能目录挂进来）。
   *
   * 安全检查顺序很关键：**先 realpath、再判敏感目录、最后才落库**。
   * 先 realpath 是为了挡住 `ln -s ~/.ssh /tmp/skills` 这种绕过；
   * 敏感目录一律 `LIB_BAD_DIR` 且说明原因（用户手滑把密钥目录挂进来是真事）。
   *
   * @param {{ dir: string, label?: string, by: string, now?: number }} input
   * @returns {{ dirs: object[], added: string }}
   */
  function addSkillDir(input = {}) {
    assertAlive('addSkillDir')
    const by = requireBy(input.by, 'addSkillDir')
    const at = normalizeNow(input.now, 'addSkillDir')
    const raw = input.dir
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new LibraryError('addSkillDir：dir 必填（绝对路径，如 ~/my-skills）', 'LIB_BAD_DIR', { dir: raw })
    }
    const lexical = raw.trim()
    if (!isAbsolute(lexical)) {
      throw new LibraryError(`addSkillDir：dir 必须是绝对路径，收到 ${JSON.stringify(lexical)}`, 'LIB_BAD_DIR', { dir: lexical })
    }
    // 规范化到真实路径：同一目录的不同写法（尾斜杠/符号链接）只算一个
    const canonical = realpathOrNull(resolve(lexical))
    if (!canonical) {
      throw new LibraryError(`addSkillDir：目录不存在或不可访问：${lexical}`, 'LIB_BAD_DIR', { dir: lexical })
    }
    let stat
    try {
      stat = statSync(canonical)
    } catch (error) {
      throw new LibraryError(`addSkillDir：无法读取目录信息：${canonical}`, 'LIB_BAD_DIR', { dir: canonical, cause: String(error?.message ?? error) })
    }
    if (!stat.isDirectory()) {
      throw new LibraryError(`addSkillDir：不是目录：${canonical}`, 'LIB_BAD_DIR', { dir: canonical })
    }
    const protectedReason = describeProtectedDir(canonical)
    if (protectedReason) {
      throw new LibraryError(`addSkillDir：${protectedReason}（${canonical}）`, 'LIB_BAD_DIR', { dir: canonical, reason: protectedReason })
    }
    if (skillDirs.has(canonical)) {
      throw new LibraryError(`addSkillDir：该目录已登记：${canonical}`, 'LIB_DIR_EXISTS', { dir: canonical })
    }

    const record = {
      id: canonical,
      dir: canonical,
      label: normalizeDirLabel(input.label, canonical, 'addSkillDir'),
      addedAt: at,
      addedBy: by,
    }
    const next = new Map(skillDirs)
    next.set(record.id, record)
    commitSkillDirs(next)
    info('[cs-bots] library.addSkillDir', { dir: record.dir, label: record.label })
    return { dirs: listSkillDirs(), added: record.dir }
  }

  /**
   * 取消登记（只从清单里移除，**绝不动磁盘上的目录/文件**）。
   * @param {{ dir: string, by: string }} input
   * @returns {{ dirs: object[] }}
   */
  function removeSkillDir(input = {}) {
    assertAlive('removeSkillDir')
    requireBy(input.by, 'removeSkillDir')
    const raw = input.dir
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new LibraryError('removeSkillDir：dir 必填', 'LIB_BAD_DIR', { dir: raw })
    }
    const lexical = resolve(raw.trim())
    // 目录可能已被删除：realpath 不出来时退回词法路径再查（否则「删不掉的登记」会卡住用户）
    const canonical = realpathOrNull(lexical) ?? lexical
    if (!skillDirs.has(canonical)) {
      throw new LibraryError(`removeSkillDir：该目录未登记：${canonical}`, 'LIB_DIR_NOT_FOUND', { dir: canonical })
    }
    const next = new Map(skillDirs)
    next.delete(canonical)
    commitSkillDirs(next)
    warn('[cs-bots] library.removeSkillDir', { dir: canonical })
    return { dirs: listSkillDirs() }
  }

  /**
   * 扫描全部已登记目录，返回**可导入条目**（不自动入库 —— 导入与否由人决定）。
   * 条目标注了 `dir` / `dirLabel`，UI 可以按来源目录分组显示。
   *
   * @returns {{ items: object[], errors: object[], dirs: object[] }}
   */
  function scanAllSkillDirs() {
    assertAlive('scanAllSkillDirs')
    const items = []
    const errors = []
    const dirs = []
    for (const record of sortedSkillDirRecords()) {
      const scanned = scanRegisteredDir(record)
      dirs.push({
        dir: record.dir,
        label: record.label,
        addedAt: record.addedAt,
        exists: scanned.exists,
        skillCount: scanned.skillCount,
      })
      if (!scanned.exists) {
        errors.push({ dir: record.dir, path: record.dir, reason: 'LIB_BAD_DIR：目录已不存在（可能被移动或删除）' })
        continue
      }
      for (const item of scanned.items) items.push({ ...item, dir: record.dir, dirLabel: record.label })
      for (const error of scanned.errors) errors.push({ ...error, dir: record.dir })
    }
    return { items, errors, dirs }
  }

  /**
   * 浏览已登记目录的下一层（给 UI 的只读目录树，不递归）。
   *
   * 安全边界：只允许**已登记目录及其子目录**；`sub` 必须是相对路径，
   * 词法与 realpath 两道都校验（第二道专门挡「目录里有个符号链接指向外部」
   * 这种越界，只查字符串前缀是挡不住的）。
   *
   * @param {{ dir: string, sub?: string }} input
   * @returns {{ path: string, entries: {name: string, type: 'dir'|'file', size: number, mtime: number, readable: boolean}[], truncated: boolean }}
   */
  function browseSkillDir(input = {}) {
    assertAlive('browseSkillDir')
    const rawDir = input?.dir
    if (typeof rawDir !== 'string' || rawDir.trim() === '') {
      throw new LibraryError('browseSkillDir：dir 必填（已登记的技能目录）', 'LIB_BAD_DIR', { dir: rawDir })
    }
    const lexicalBase = resolve(rawDir.trim())
    const base = realpathOrNull(lexicalBase)
    if (!base) {
      throw new LibraryError(`browseSkillDir：目录不存在或不可访问：${lexicalBase}`, 'LIB_BAD_DIR', { dir: lexicalBase })
    }
    if (!skillDirs.has(base)) {
      throw new LibraryError(
        `browseSkillDir：只能浏览已登记的技能目录（${base} 未登记）`,
        'LIB_BAD_DIR',
        { dir: base },
      )
    }

    const rawSub = input?.sub ?? ''
    if (typeof rawSub !== 'string') {
      throw new LibraryError('browseSkillDir：sub 必须是相对路径字符串', 'LIB_BAD_FIELD', { field: 'sub', sub: rawSub })
    }
    const sub = rawSub.trim()
    if (sub !== '' && isAbsolute(sub)) {
      throw new LibraryError(`browseSkillDir：sub 必须是相对路径，收到绝对路径 ${JSON.stringify(sub)}`, 'LIB_BAD_DIR', { dir: base, sub })
    }
    const target = sub === '' || sub === '.' ? base : resolve(base, sub)
    if (!isInside(target, base)) {
      throw new LibraryError(`browseSkillDir：访问越界（sub=${JSON.stringify(sub)} 指向登记目录之外）`, 'LIB_BAD_DIR', { dir: base, sub })
    }
    const targetReal = realpathOrNull(target)
    if (!targetReal) {
      throw new LibraryError(`browseSkillDir：目录不存在：${target}`, 'LIB_BAD_DIR', { dir: base, sub })
    }
    if (!isInside(targetReal, base)) {
      throw new LibraryError(
        `browseSkillDir：访问越界（sub=${JSON.stringify(sub)} 经符号链接指向登记目录之外）`,
        'LIB_BAD_DIR',
        { dir: base, sub, resolved: targetReal },
      )
    }
    let stat
    try {
      stat = statSync(targetReal)
    } catch (error) {
      throw new LibraryError(`browseSkillDir：无法读取目录信息：${targetReal}`, 'LIB_BAD_DIR', { dir: targetReal, cause: String(error?.message ?? error) })
    }
    if (!stat.isDirectory()) {
      throw new LibraryError(`browseSkillDir：目标不是目录：${targetReal}`, 'LIB_BAD_DIR', { dir: targetReal })
    }

    let names
    try {
      names = readdirSync(targetReal)
    } catch (error) {
      throw new LibraryError(`browseSkillDir：读取目录失败：${targetReal}`, 'LIB_BAD_DIR', { dir: targetReal, cause: String(error?.message ?? error) })
    }
    names.sort()

    /** @type {{name: string, type: 'dir'|'file', size: number, mtime: number, readable: boolean}[]} */
    const entries = []
    for (const name of names) {
      const full = join(targetReal, name)
      let entryStat = null
      try {
        entryStat = statSync(full)
      } catch {
        entryStat = null // 断链符号链接等：下面按不可读处理，不抛
      }
      let readable = true
      try {
        // 用 access 而不是真的读文件：浏览目录不该把几 MB 的技能正文读进内存，
        // 更不能因为没有读权限就让整页崩掉。一个坏文件只标 readable:false。
        accessSync(full, constants.R_OK)
      } catch {
        readable = false
      }
      entries.push({
        name,
        type: entryStat?.isDirectory() ? 'dir' : 'file',
        size: entryStat ? entryStat.size : 0,
        mtime: entryStat ? Math.floor(entryStat.mtimeMs) : 0,
        readable,
      })
    }
    // 目录在前、文件在后，各自按名字 —— 文件系统顺序不可复现，必须自己定序
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })

    const truncated = entries.length > BROWSE_LIMIT
    return {
      path: targetReal,
      entries: truncated ? entries.slice(0, BROWSE_LIMIT) : entries,
      truncated,
    }
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
    skillDirs = new Map()
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
    // 特性 ⑤：技能导入/导出（签名见 DESIGN-v2，别改）
    parseSkillMarkdown: skillMdParser,
    importSkills,
    scanSkillsDir: skillDirScanner,
    exportSkills,
    // 特性 ⑩：技能管理器（来源分层 / 启停 / 自定义目录 / 目录树浏览）
    setSkillEnabled,
    setSkillSource,
    addSkillDir,
    removeSkillDir,
    listSkillDirs,
    scanAllSkillDirs,
    browseSkillDir,
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
