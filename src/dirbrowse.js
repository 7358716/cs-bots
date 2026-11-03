/**
 * cs-bots /dirbrowse —— 给 Web UI 用的「目录浏览器」后端。
 *
 * ── 为什么自建（不用宿主原生目录选择器）───────────────────────────────────
 * 浏览器 / Web UI 里没有可靠的「选目录」原语：`<input type="file" webkitdirectory>`
 * 只能选文件、拿不到绝对路径；部分 Linux 环境 + 部分浏览器下宿主的选择器直接不可用。
 * ⇒ 我们在**服务端**做目录遍历，UI 只负责发 `list()` / `mkdir()` 请求。
 *
 * ── 安全模型（这是给浏览器开的文件系统口子，必须假定调用方不可信）────────────
 *   ① 一律 `resolve()` 后再做**存在性 / 类型**复核，绝不把原始字符串拼进路径。
 *   ② 名字（mkdir / rename / resolveSuggested）只允许单段文件名，
 *      `/`、`\`、`..`、控制字符、Windows 保留字符一律 `DIR_BAD_NAME`。
 *   ③ **写操作**（mkdir / rename）锚定在「允许范围」内：
 *      家目录 ∪ 进程 cwd ∪ config.roots。判定用 **realpath**，
 *      所以「允许范围内的符号链接指向范围外」也会被拦（`DIR_OUTSIDE_ROOTS`）。
 *      读操作不设限，只用一个 `outsideAllowedRoots` 标记告知 UI（用户要能往上翻）。
 *   ④ 权限不足（EACCES）**不抛**：返回空列表 + `error: 'EACCES'`，
 *      否则用户会卡在一个永远翻不上去的目录里。
 *
 * ── 与 botprofile.js 一致的约定 ─────────────────────────────────────────────
 * 零第三方依赖（只 node:fs / node:path / node:os）；参数校验抛错、不静默兜底；
 * 任何截断都显式告知（`truncated: true`），不让调用方误以为看到了全量。
 */

import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** 单次 list 最多返回的条目数（超出显式 truncated）。 */
export const MAX_ENTRIES = 500

/** 合法单段名：不含路径分隔符、Windows 保留字符、控制字符，长度 1..255。 */
export const NAME_PATTERN = /^[^/\\:*?"<>|\x00-\x1f]{1,255}$/

/**
 * 系统顶层目录名（小写）——Bot 工作目录放在这些位置只给 warning 不给 error：
 * 它们本身可写但语义上是系统区域，放 Bot 进去会「看起来能跑、实则污染系统」。
 * `/` 与盘符根单独判定（见 isSystemTopDir）。
 */
const SYSTEM_TOP_NAMES = new Set([
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'media', 'mnt',
  'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
])

/** 目录浏览器错误（带机器可读 code，HTTP 层直接映射状态码即可）。 */
export class DirBrowseError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'DirBrowseError'
    this.code = code
    this.detail = detail
  }
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** 造一个带 code 的错误（少写 new）。 */
function fail(message, code, detail) {
  return new DirBrowseError(message, code, detail)
}

/** 取错误里的 code（非标准错误返回 undefined）。 */
function errCode(error) {
  return typeof error?.code === 'string' ? error.code : undefined
}

/** realpath，失败则退回 resolve（目录可能在检查间隙被删）。 */
function realOrSelf(p) {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * child 是否在 parent 之内（含相等）。
 * 用 relative() 而不是字符串前缀 —— 前缀法会把 `/home/u2` 误判成在 `/home/u` 内。
 */
function isInside(child, parent) {
  const rel = relative(parent, child)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** 是否就是文件系统根（`/` 或 `C:\`）。 */
function isFsRoot(p) {
  return dirname(p) === p
}

/**
 * 是否是「系统顶层目录」——`/`、`/home`、`/usr`、`/etc`、`/tmp`、`C:\` 这类。
 * 只按深度 1 + 已知系统名判定，不对 `/home/ubuntu/work` 误报。
 */
function isSystemTopDir(p) {
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return true
  if (isFsRoot(p)) return true
  const parent = dirname(p)
  if (!isFsRoot(parent)) return false
  const name = p.slice(parent.length).replace(/^[\\/]+/, '').toLowerCase()
  return SYSTEM_TOP_NAMES.has(name)
}

/** 当前进程能否在该目录创建东西。 */
function canWrite(dir) {
  try {
    accessSync(dir, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 校验并规范化一个「必须存在且是目录」的绝对路径。
 * @returns {string} 绝对路径
 */
function takeDirPath(value, label) {
  const abs = takeAbsPath(value, label)
  let st
  try {
    st = statSync(abs)
  } catch (error) {
    const code = errCode(error)
    if (code === 'EACCES' || code === 'EPERM') {
      throw fail(`无权访问：${abs}`, 'DIR_EACCES', { label, path: abs })
    }
    throw fail(`目录不存在：${abs}`, 'DIR_NOT_FOUND', { label, path: abs, cause: String(error?.message ?? error) })
  }
  if (!st.isDirectory()) {
    throw fail(`不是目录：${abs}`, 'DIR_NOT_DIRECTORY', { label, path: abs })
  }
  return abs
}

/** 校验绝对路径（不要求存在）。 */
function takeAbsPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(`${label} 必填，且必须是字符串`, 'DIR_BAD_PATH', { label, value })
  }
  const raw = value.trim()
  if (!isAbsolute(raw)) {
    throw fail(`${label} 必须是绝对路径，收到 ${JSON.stringify(value)}`, 'DIR_NOT_ABSOLUTE', { label, value })
  }
  return resolve(raw)
}

/**
 * 校验单段目录名。`name` 里出现 `/`、`\`、`..` 直接拒 —— 这是防穿越的第一道闸。
 * @param {unknown} value
 * @returns {string} 去掉首尾空白后的合法名
 */
function takeName(value) {
  if (typeof value !== 'string') {
    throw fail(`name 必须是字符串，收到 ${typeof value}`, 'DIR_BAD_NAME', { value })
  }
  const name = value.trim()
  if (name === '') {
    throw fail('name 不能为空', 'DIR_BAD_NAME', { value })
  }
  if (name === '.' || name === '..' || name.includes('..')) {
    throw fail(`name 不允许出现 ".."：${JSON.stringify(value)}`, 'DIR_BAD_NAME', { value })
  }
  if (name.includes('/') || name.includes('\\')) {
    throw fail(`name 不允许包含路径分隔符：${JSON.stringify(value)}`, 'DIR_BAD_NAME', { value })
  }
  if (name.length > 255) {
    throw fail(`name 超长：${name.length} > 255`, 'DIR_BAD_NAME', { value, length: name.length })
  }
  if (!NAME_PATTERN.test(name)) {
    throw fail(
      `name 含非法字符：${JSON.stringify(value)}（不允许 / \\ : * ? " < > | 与控制字符）`,
      'DIR_BAD_NAME',
      { value },
    )
  }
  return name
}

/** 配置里的路径字段（stateDir / dshHome）：必须是字符串，缺省即抛，不静默兜底。 */
function takeConfigPath(value, field, hint) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(
      `dirbrowse.createDirBrowser：config.${field} 必填${hint ? `（${hint}）` : ''}`,
      'DIR_BAD_CONFIG',
      { field, value },
    )
  }
  return resolve(value.trim())
}

/** 额外的允许 roots（数组，逐项 resolve）。 */
function takeRoots(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw fail('config.roots 必须是字符串数组', 'DIR_BAD_CONFIG', { value })
  }
  return value.map((v, i) => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw fail(`config.roots[${i}] 必须是非空字符串`, 'DIR_BAD_CONFIG', { index: i, value: v })
    }
    return resolve(v.trim())
  })
}

/** 排序：目录在前，其次按名字（大小写不敏感，再用原串兜底以保稳定）。 */
function compareEntries(a, b) {
  const aDir = a.kind === 'dir' ? 0 : 1
  const bDir = b.kind === 'dir' ? 0 : 1
  if (aDir !== bDir) return aDir - bDir
  const al = a.name.toLowerCase()
  const bl = b.name.toLowerCase()
  if (al < bl) return -1
  if (al > bl) return 1
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

// ── 工厂 ─────────────────────────────────────────────────────────────────────

/**
 * 创建一个目录浏览器实例。
 * @param {{ stateDir: string, roots?: string[], dshHome?: string }} config
 * @returns {{
 *   list: (args?: { path?: string, showHidden?: boolean }) => object,
 *   mkdir: (args: { path: string, name: string }) => object,
 *   rename: (args: { path: string, name: string }) => object,
 *   validateAsBotCwd: (args: { path: string }) => object,
 *   resolveSuggested: (args: { parent: string, name: string }) => object,
 *   roots: () => { home: string, cwd: string, roots: string[] },
 *   dispose: () => void,
 * }}
 */
export function createDirBrowser(config) {
  const cfg = config ?? {}
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw fail('dirbrowse.createDirBrowser：config 必须是对象', 'DIR_BAD_CONFIG')
  }

  // stateDir 是「必须保护」的区域之一，缺了就无法判断，所以强制要求显式给出。
  const stateDir = takeConfigPath(cfg.stateDir, 'stateDir', '裸检出必须显式传')
  const dshHome = takeConfigPath(
    cfg.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    'dshHome',
    '未传也未设 DSH_HOME 时默认 ~/.dsh',
  )
  const extraRoots = takeRoots(cfg.roots)
  const home = resolve(homedir())
  /** 家目录下永远不许当 Bot cwd 的目录（官方技能目录）。 */
  const agentsDir = join(home, '.agents')

  /** 允许范围：读不限制，写只允许落在这里面（realpath 判定）。 */
  function allowedRoots() {
    return [realOrSelf(home), realOrSelf(resolve(process.cwd())), ...extraRoots.map(realOrSelf)]
  }

  /** 是否落在允许范围内（用于读侧标记：字面路径或 realpath 任一命中都算）。 */
  function withinAllowed(abs) {
    const candidates = [abs, realOrSelf(abs)]
    return allowedRoots().some((root) => candidates.some((c) => isInside(c, root)))
  }

  /**
   * 写侧判定：**只认 realpath**。
   * 字面路径在范围内但软链指向范围外 ⇒ 不算在范围内（否则软链就是越狱通道）。
   */
  function withinAllowedForWrite(dir) {
    let real
    try {
      real = realpathSync(dir)
    } catch {
      real = resolve(dir) // 父目录刚被删的竞态：退回字面路径
    }
    return allowedRoots().some((root) => isInside(real, root))
  }

  /** 写操作的位置闸门。 */
  function assertWritableLocation(dir, label) {
    if (!withinAllowedForWrite(dir)) {
      throw fail(
        `拒绝在允许范围外写入：${dir}（允许：家目录 / 进程 cwd / config.roots；软链指向范围外同样拒绝）`,
        'DIR_OUTSIDE_ROOTS',
        { label, path: dir, real: realOrSelf(dir), roots: allowedRoots() },
      )
    }
  }

  /**
   * 列出目录内容。
   * @param {{ path?: string, showHidden?: boolean }} [args]
   */
  function list(args = {}) {
    const opts = args ?? {}
    const showHidden = opts.showHidden === true
    const abs = opts.path === undefined ? resolve(homedir()) : takeAbsPath(opts.path, 'path')
    const parentPath = dirname(abs)
    const parent = parentPath === abs ? null : parentPath
    const outside = !withinAllowed(abs)

    let st
    try {
      st = statSync(abs)
    } catch (error) {
      const code = errCode(error)
      if (code === 'EACCES' || code === 'EPERM') {
        // 权限不足：返回空列表而不是抛错，用户才能继续往上翻。
        return { path: abs, parent, entries: [], writable: false, outsideAllowedRoots: outside, error: 'EACCES' }
      }
      throw fail(`目录不存在：${abs}`, 'DIR_NOT_FOUND', { path: abs, cause: String(error?.message ?? error) })
    }
    if (!st.isDirectory()) {
      throw fail(`不是目录：${abs}`, 'DIR_NOT_DIRECTORY', { path: abs })
    }

    let names
    try {
      names = readdirSync(abs)
    } catch (error) {
      const code = errCode(error)
      if (code === 'EACCES' || code === 'EPERM') {
        return { path: abs, parent, entries: [], writable: false, outsideAllowedRoots: outside, error: 'EACCES' }
      }
      throw fail(`读取目录失败：${abs}（${error?.message ?? error}）`, 'DIR_READ_FAILED', {
        path: abs,
        cause: String(error?.message ?? error),
      })
    }

    const entries = []
    for (const name of names) {
      if (!showHidden && name.startsWith('.')) continue
      const full = join(abs, name)
      let est
      try {
        // 跟随符号链接取类型（读操作允许指向范围外）。
        est = statSync(full)
      } catch {
        // 坏链接 / 权限不足：仍然展示，标成 other，别让用户以为目录里"少了东西"。
        entries.push({ name, path: full, kind: 'other', mtime: null })
        continue
      }
      const kind = est.isDirectory() ? 'dir' : est.isFile() ? 'file' : 'other'
      const entry = { name, path: full, kind }
      if (kind === 'file') entry.size = est.size
      entry.mtime = Math.floor(est.mtimeMs / 1000)
      entries.push(entry)
    }

    entries.sort(compareEntries)
    const truncated = entries.length > MAX_ENTRIES
    const out = {
      path: abs,
      parent,
      entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
      writable: canWrite(abs),
      outsideAllowedRoots: outside,
    }
    if (truncated) {
      out.truncated = true
      out.total = entries.length
    }
    return out
  }

  /**
   * 在 `path` 下新建子目录 `name`。
   * @param {{ path: string, name: string }} args
   */
  function mkdir(args) {
    const opts = args ?? {}
    const dir = takeDirPath(opts.path, 'path')
    const name = takeName(opts.name)
    const target = join(dir, name)

    // 用 lstat：坏符号链接也算「已存在」，不能悄悄覆盖。
    let exists = false
    try {
      lstatSync(target)
      exists = true
    } catch (error) {
      if (errCode(error) !== 'ENOENT' && errCode(error) !== 'ENOTDIR') {
        throw fail(`无法检查目标：${target}（${error?.message ?? error}）`, 'DIR_READ_FAILED', {
          path: target,
          cause: String(error?.message ?? error),
        })
      }
    }
    if (exists) {
      throw fail(`同名目录/文件已存在：${target}`, 'DIR_EXISTS', { path: target })
    }

    assertWritableLocation(dir, 'path')

    try {
      // 非 recursive：父目录必须已存在（父缺失已在上面 takeDirPath 拦掉）
      mkdirSync(target)
    } catch (error) {
      const code = errCode(error)
      if (code === 'EEXIST') throw fail(`同名目录/文件已存在：${target}`, 'DIR_EXISTS', { path: target })
      if (code === 'ENOENT') throw fail(`父目录不存在：${dir}`, 'DIR_NOT_FOUND', { path: dir })
      if (code === 'EACCES' || code === 'EPERM') {
        throw fail(`无权在 ${dir} 下创建目录`, 'DIR_EACCES', { path: target })
      }
      throw fail(`创建目录失败：${target}（${error?.message ?? error}）`, 'DIR_WRITE_FAILED', {
        path: target,
        cause: String(error?.message ?? error),
      })
    }
    return { path: target, created: true }
  }

  /**
   * 把 `path` 重命名为同级的新名字 `name`（只改名，不移动）。
   * @param {{ path: string, name: string }} args
   */
  function rename(args) {
    const opts = args ?? {}
    const from = takeDirPath(opts.path, 'path')
    const parentPath = dirname(from)
    if (parentPath === from) {
      // 根目录 / 盘符根：parent 为 null ⇒ 不允许改名（挂载点也走这条语义）。
      throw fail(`不允许重命名根目录或挂载点：${from}`, 'DIR_CANNOT_RENAME_ROOT', { path: from })
    }
    const name = takeName(opts.name)
    const to = join(parentPath, name)
    if (to === from) return { from, to }

    let exists = false
    try {
      lstatSync(to)
      exists = true
    } catch (error) {
      if (errCode(error) !== 'ENOENT' && errCode(error) !== 'ENOTDIR') {
        throw fail(`无法检查目标：${to}（${error?.message ?? error}）`, 'DIR_READ_FAILED', {
          path: to,
          cause: String(error?.message ?? error),
        })
      }
    }
    if (exists) {
      throw fail(`目标已存在：${to}`, 'DIR_EXISTS', { path: to, from })
    }

    assertWritableLocation(parentPath, 'path')

    try {
      renameSync(from, to)
    } catch (error) {
      const code = errCode(error)
      if (code === 'EEXIST' || code === 'ENOTEMPTY') throw fail(`目标已存在：${to}`, 'DIR_EXISTS', { path: to, from })
      if (code === 'ENOENT') throw fail(`目录不存在：${from}`, 'DIR_NOT_FOUND', { path: from })
      if (code === 'EACCES' || code === 'EPERM') throw fail(`无权重命名：${from}`, 'DIR_EACCES', { path: from })
      throw fail(`重命名失败：${from} → ${to}（${error?.message ?? error}）`, 'DIR_WRITE_FAILED', {
        path: from,
        to,
        cause: String(error?.message ?? error),
      })
    }
    return { from, to }
  }

  /**
   * 校验「把 Bot 工作目录设成 path」是否可接受。
   * errors 非空 ⇒ ok:false；只有 warnings ⇒ ok:true（用户可继续，但要知道风险）。
   * @param {{ path: string }} args
   */
  function validateAsBotCwd(args) {
    const opts = args ?? {}
    const warnings = []
    const errors = []

    if (typeof opts.path !== 'string' || opts.path.trim() === '') {
      errors.push('path 必填：需要给出 Bot 的工作目录（绝对路径）')
      return { ok: false, path: null, warnings, errors }
    }
    const raw = opts.path.trim()
    if (!isAbsolute(raw)) {
      errors.push(`必须是绝对路径，收到 ${JSON.stringify(opts.path)}`)
      return { ok: false, path: null, warnings, errors }
    }
    const abs = resolve(raw)

    let st
    try {
      st = statSync(abs)
    } catch (error) {
      const code = errCode(error)
      if (code === 'EACCES' || code === 'EPERM') errors.push(`目录不可访问：${abs}`)
      else if (code === 'ENOENT' || code === 'ENOTDIR') errors.push(`目录不存在：${abs}`)
      else errors.push(`目录不可用：${abs}（${error?.message ?? error}）`)
      return { ok: false, path: abs, warnings, errors }
    }
    if (!st.isDirectory()) {
      errors.push(`不是目录：${abs}`)
      return { ok: false, path: abs, warnings, errors }
    }

    // 受保护区域：用 realpath 判，防止「软链绕进来」。
    const real = realOrSelf(abs)
    const guarded = [
      { dir: dshHome, label: 'DSH 家目录（Bot 会改坏宿主配置）' },
      { dir: agentsDir, label: '~/.agents（宿主技能目录）' },
      { dir: stateDir, label: 'cs-bots 状态目录' },
    ]
    for (const { dir, label } of guarded) {
      const root = realOrSelf(dir)
      if (isInside(real, root) || isInside(abs, dir)) {
        errors.push(`不能在${label} 之内：${abs}`)
      }
    }

    if (!canWrite(abs)) {
      errors.push(`当前进程不可写：${abs}（Bot 无法在此创建文件）`)
    }

    if (isSystemTopDir(abs)) {
      warnings.push(`不要把 Bot 放在系统根目录：${abs}`)
    }

    return { ok: errors.length === 0, path: abs, warnings, errors }
  }

  /**
   * 计算「在 parent 下新建 name 给 Bot 用」的目标路径 —— 不创建任何东西。
   * @param {{ parent: string, name: string }} args
   */
  function resolveSuggested(args) {
    const opts = args ?? {}
    const parent = takeAbsPath(opts.parent, 'parent')
    const name = takeName(opts.name)
    return { path: join(parent, name) }
  }

  /** 给 UI 的快捷入口：家目录 / 当前目录 / 额外 roots。 */
  function roots() {
    return { home, cwd: process.cwd(), roots: [...extraRoots] }
  }

  /** 无状态实现，dispose 只作为接口占位（保持与其他服务一致的生命周期）。 */
  function dispose() {}

  return { list, mkdir, rename, validateAsBotCwd, resolveSuggested, roots, dispose }
}

export default createDirBrowser
