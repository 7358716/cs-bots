/**
 * paths-cross.js —— 跨平台路径纪律（0.20.0）
 *
 * ## 为什么需要这个文件（2026-11-18 Boss Win 截图实测）
 *
 *   插件跑在「桌面版 DSH」，用户可能是一台 Linux 导出的包，在 Windows 上导入，
 *   也可能反过来。实测踩到的三处硬伤：
 *
 *     ① `transfer.js` 拼警告文案时写死 `'/'`：
 *          `导入后会改到 ${root}/<部门>/<名字>`  ⇒ Win 上显示成 `...\.dsh\cs-bots/<部门>/<名字>`
 *        （Boss 截图红圈就是这个：一半反斜杠一半正斜杠）
 *     ② `startsWith(root)` 判「是否在主目录下」：Win 盘符大小写不同就永远 false
 *        ⇒ 每个 Bot 都被当成「外来目录」去重算。
 *     ③ 「同名冲突」只比 `name`（中文显示名），不看目录名
 *        ⇒ 两个不同部门的同名 Bot 会被合并成一个。
 *
 * ## 纪律（写进 ADR-002，CI 机械检查）
 *
 *   1. **凡是拼接文件路径，一律用 `node:path` 的 join/resolve**，禁止字符串里手写分隔符。
 *   2. **凡是给人看的路径**，用 `displayPath()`，按**当前运行平台**输出分隔符。
 *   3. **凡是比较路径**，用 `pathsEqual()` / `isInsideDir()`，大小写不敏感 + 分隔符归一 + 去尾斜杠。
 *   4. **凡是目录名**，用 `safeSegment()`（中文允许，拦截 Windows 保留名 / 非法字符 / 超长）。
 *
 * 依赖面：node 内置。零第三方依赖。
 */

import { sep, normalize, resolve, join, isAbsolute } from 'node:path'

/** 当前平台是否大小写不敏感（Win/macOS 默认是）。 */
const CASE_INSENSITIVE_HOST = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Windows 保留设备名（不区分大小写，且**带扩展名也保留**：`CON.txt` 同样非法）。
 * 这些名字在 Win 上建目录会得到「系统找不到指定的路径」这类迷惑报错。
 */
const WIN_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/** 目录名/文件名的单段上限（Win 255 就是硬上限；留 20 给后续加后缀）。 */
export const MAX_SEGMENT = 235

/**
 * 把路径归一化成可比较的字符串。
 *
 * 做什么：
 *   - 统一分隔符为 `/`（内部比较用，不是给人看的）
 *   - 折叠重复分隔符、去掉尾部分隔符
 *   - Win/macOS 上转小写（这两家文件系统默认大小写不敏感）
 *
 * **不做**：不 resolve 符号链接、不 realpath（那需要 IO，调用方自己决定）。
 *
 * @param {string} p
 * @returns {string}
 */
export function normPath(p) {
  if (typeof p !== 'string') return ''
  if (p.trim() === '') return ''
  let v = normalize(p).replace(/\\/g, '/')
  v = v.replace(/\/{2,}/g, '/')
  if (v.length > 1 && v.endsWith('/')) v = v.replace(/\/+$/, '')
  return CASE_INSENSITIVE_HOST ? v.toLowerCase() : v
}

/**
 * 两个路径是否指同一个东西（大小写/分隔符/尾斜杠都不算差异）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function pathsEqual(a, b) {
  const x = normPath(a)
  const y = normPath(b)
  return x !== '' && x === y && x !== '.' && x !== '/'
}

/**
 * 「两个字符串代表同一个已登记路径」。
 *
 * 与 `pathsEqual` 的差别：**允许 a===b 的原始相等**（防住 normPath 把某种路径
 * 归一成 `.` 的边角情况 —— 例如 Windows 上 `\.`，那仍然是同一个目录）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a === b) return true
  return pathsEqual(a, b)
}

/**
 * `child` 是否在 `parent` 目录**之内**（严格子孙，不含 parent 自己）。
 *
 * 与旧实现（`child.startsWith(parent + sep)`）的差别：
 *   - Win 上盘符大小写不同也能认（`C:\Users` vs `c:\users`）
 *   - Win 上 `\` 与 `/` 混写也能认（用户手粘的路径常见）
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const p = normPath(parent)
  const c = normPath(child)
  if (!p || !c) return false
  if (c === p) return false
  return c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

/**
 * 给人看的路径：按**当前平台**的分隔符输出。
 *
 * 只做分隔符替换，不 resolve（避免把用户输入的相对路径变成绝对路径，
 * 那会让错误提示跟用户输入对不上）。
 *
 * @param {string} p
 * @returns {string}
 */
export function displayPath(p) {
  if (typeof p !== 'string') return ''
  if (sep === '/') return p.replace(/\\/g, '/')
  // Win：所有 `/` 换 `\`，并折叠重复
  return p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
}

/**
 * 把一段字符串洗成**跨平台安全的目录名**。
 *
 * 规则（按顺序，每条都对应一个真实坑）：
 *   1. NFC 归一化 —— macOS 导出的是 NFD（`é` 拆成 `e`+`◌́`），Win/Linux 是 NFC，
 *      不归一会导致「看起来一样的名字」在另一台机器上是两个目录。
 *   2. 删掉路径分隔符 `/` `\` —— 否则一个名字能多套一层目录（穿越）。
 *   3. 删掉控制字符 —— `\n` `\t` 会让路径莫名其妙。
 *   4. 删掉 Windows 非法字符 `: * ? " < > |` —— 这些在 Linux 合法但到 Win 必炸。
 *   5. 折叠连续空白；去首尾空白。
 *   6. 去首尾的点 —— `.`/`..`/`.hidden` 在不同系统行为不同。
 *   7. Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名）⇒ 加 `-` 后缀。
 *   8. 去**结尾的空格与点** —— Win 会静默丢弃它们，导致「建出来的目录名和显示的不一样」。
 *   9. 超长截断到 MAX_SEGMENT（按码点截，不切断代理对）。
 *
 * **刻意不做**：不把中文转拼音、不转义中文。
 *   Boss 2026-11-18 明确：「部门名称可以汉字」。中文目录名在三个平台上都合法。
 *
 * @param {string} raw
 * @returns {string} 安全目录名；无法得到安全名时返回 `''`
 */
export function safeSegment(raw) {
  if (typeof raw !== 'string') return ''
  let v = raw.normalize('NFC')
  v = v.replace(/[/\\]/g, '')
  // eslint-disable-next-line no-control-regex
  v = v.replace(/[\x00-\x1f\x7f]/g, '')
  v = v.replace(/[:*?"<>|]/g, '')
  v = v.replace(/\s+/g, ' ').trim()
  v = v.replace(/^\.+/, '')
  v = v.replace(/[.\s]+$/, '')
  if (!v) return ''
  // Windows 保留名：整段（去掉扩展名后）命中就加后缀
  const lower = v.toLowerCase()
  const stem = lower.split('.')[0] ?? ''
  if (WIN_RESERVED.has(lower) || WIN_RESERVED.has(stem)) {
    // 插在主干末尾而不是整串末尾：`CON.txt` ⇒ `CON-.txt`
    // 为什么不是 `CON.txt-`：那仍然以 `CON` 开头，部分 Win API 会看主干当设备名。
    const head = v.includes('.') ? `${v.split('.')[0]}-.${v.split('.').slice(1).join('.')}` : `${v}-`
    v = head
  }
  if (!v) return ''
  if (v.length > MAX_SEGMENT) {
    v = Array.from(v).slice(0, MAX_SEGMENT).join('')
    v = v.replace(/[.\s]+$/, '')
  }
  if (v === '' || v === '.' || v === '..') return ''
  return v
}

/**
 * 校验一个「目录要用的 id」（部门 id / Bot 目录名）是否合法，并给出**可执行**的修法。
 *
 * 与 `safeSegment` 的分工：
 *   - `safeSegment`：**洗**（尽量救回来，建 Bot 时静默洗用户输入）
 *   - `checkSegment`：**判**（导入/手填 id 时**不许静默改**，必须告诉用户改哪个）
 *
 * @param {string} raw
 * @returns {{ ok: true, value: string } | { ok: false, code: string, hint: string }}
 */
export function checkSegment(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  const value = trimmed
  if (value === '.' || value === '..') {
    return { ok: false, code: 'SEGMENT_DOTS', hint: '目录名不能是 . 或 ..' }
  }
  if (typeof raw === 'string' && raw !== '' && raw !== trimmed) {
    // 首尾空格：Win 会静默丢弃，导致「显示的名字」和「磁盘上的目录」不一致
    return { ok: false, code: 'SEGMENT_TRAILING', hint: '目录名首尾不能有空格' }
  }
  if (!value) return { ok: false, code: 'SEGMENT_EMPTY', hint: '目录名不能为空' }
  if (/[/\\]/.test(value)) {
    return { ok: false, code: 'SEGMENT_HAS_SEP', hint: `目录名不能包含路径分隔符：${JSON.stringify(value)}` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, code: 'SEGMENT_HAS_CTRL', hint: '目录名不能包含控制字符（含换行/制表符）' }
  }
  const bad = value.match(/[:*?"<>|]/)
  if (bad) {
    return {
      ok: false, code: 'SEGMENT_WIN_ILLEGAL',
      hint: `目录名含 Windows 非法字符 ${JSON.stringify(bad[0])}（: * ? " < > |）—— 换一个`,
    }
  }
  if (/[.\s]$/.test(value)) {
    return { ok: false, code: 'SEGMENT_TRAILING', hint: '目录名不能以点或空格结尾（Windows 会静默丢弃）' }
  }
  if (value === '.' || value === '..') {
    return { ok: false, code: 'SEGMENT_DOTS', hint: '目录名不能是 . 或 ..' }
  }
  const stem = value.split('.')[0]?.toLowerCase() ?? ''
  if (WIN_RESERVED.has(stem)) {
    return {
      ok: false, code: 'SEGMENT_WIN_RESERVED',
      hint: `${JSON.stringify(value)} 是 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）—— 换一个`,
    }
  }
  if (Array.from(value).length > MAX_SEGMENT) {
    return { ok: false, code: 'SEGMENT_TOO_LONG', hint: `目录名超过 ${MAX_SEGMENT} 个字符 —— 换短一点` }
  }
  return { ok: true, value }
}

/**
 * 安全 join：任一段非法就返回 `{ ok:false }`，**绝不抛出**（调用方决定怎么报）。
 * @param {...string} parts
 * @returns {{ ok: true, path: string } | { ok: false, code: string, hint: string }}
 */
export function safeJoin(...parts) {
  const list = parts.filter((p) => typeof p === 'string' && p !== '')
  if (!list.length) return { ok: false, code: 'SEGMENT_EMPTY', hint: '没有可拼接的路径段' }
  const [base, ...rest] = list
  for (const seg of rest) {
    const c = checkSegment(seg)
    if (!c.ok) return c
  }
  return { ok: true, path: join(base, ...rest) }
}

export { isAbsolute, resolve }