/**
 * cs-bots ScratchService —— 临时便签（自由 Markdown，按作用域隔离，原子写）。
 *
 * 对标 dsh-memory-evolve 的 scratch 子系统，但**完全自建、零第三方依赖**
 * （只用 `node:fs` / `node:*` 内置 + `./store.js` / `./kernel.js`）。
 *
 * ── 作用域（scope）为什么按文件隔离而不是塞一个大 JSON ──
 *   便签是**人写给人看的自由 Markdown**，最怕两件事：
 *     ① 一处写坏拖垮全部（大 JSON 里一个引号错，所有便签读不出来）；
 *     ② 两个人/两个项目同时写互相覆盖（同一文件必冲突）。
 *   按 `<scope>.md` 一文件一便签，天然满足：读坏一个不影响别的；
 *   不同 scope 落在不同 inode，写 A 不碰 B。
 *   项目便签用 cwd 的 hash（`project-<sha1前8位>`），由调用方算好传入 ——
 *   本模块**不猜测** cwd 的语义（谁的项目、是否同一项目由上层/调用方定义）。
 *
 * ── 为什么必须「临时文件 + rename」而不是直接写目标文件 ──
 *   直接 writeFileSync 目标文件时，进程崩在 write 中途、或断电，目标文件就变成
 *   半截 Markdown（前一半新内容 + 后一半旧内容 / 干脆空文件）。rename 在
 *   POSIX 上是原子的：读者要么看到旧全文、要么看到新全文，**不存在中间态**。
 *   另外先 fsync 临时文件再 rename：否则 rename 只是把「页缓存里的名字」换掉，
 *   掉电后新名字可能指向尚未落盘的数据 —— 这就是「rename 原子但仍丢内容」的经典坑。
 *
 * ── 与 board.js 相同的一条纪律：**不静默失败** ──
 *   读不存在 → 返回空（这是正常状态，不是错误，新便签天然为空）；
 *   其余任何 IO 失败 → 抛 `ScratchError`（带 code + detail），绝不假装成功。
 *
 * 依赖面：node 内置 + `./store.js` + `./kernel.js`。不 import 任何宿主包/第三方包。
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'

import { statePath } from './store.js'

// ── kernel 惰性桥（与 board.js 同款，原因见文件头）────────────────────────────
//
// kernel.js 静态 import 了宿主包（只在 DSH profile 内可解析）。本仓库是裸检出，
// 静态 import 会让任意用到 scratch 的测试连带加载失败。拿不到 kernel 时
// **不静默兜底**：调用方必须显式传 config.stateDir，否则抛可读错误。

/** @type {object | null} */
let kernel = null
/** @type {unknown} */
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 缺省作用域。 */
export const DEFAULT_SCOPE = 'global'

/** 单条便签上限：512 KiB（按 **UTF-8 字节**算，不是字符数）。 */
export const MAX_BYTES = 512 * 1024

/**
 * 作用域名白名单。
 *
 * 为什么必须白名单而不是「过滤掉 / 就行」：scope 直接拼进文件名，任何路径穿越
 * （`../memory`、`..`）或空字节（`\0`）都会让写入落到便签目录之外。
 * 白名单同时挡掉 Windows 非法字符与隐藏文件，规则简单到能一眼验证。
 */
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 文件后缀（`<scope>.md`）。 */
const FILE_EXT = '.md'

// ── 错误 ────────────────────────────────────────────────────────────────────

/**
 * 便签结构化错误。所有失败都走它，**绝不静默**。
 *
 * 同时挂 `detail` 与 `details`：前者是任务契约里的字段名，后者是本仓
 * board/discipline 的既有习惯，两边都认，避免调用方按哪种写法取都取不到。
 */
export class ScratchError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息（scope / 路径）
   * @param {string} [code]
   * @param {object} [detail]
   */
  constructor(message, code = 'SCRATCH_ERROR', detail) {
    super(message)
    this.name = 'ScratchError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
      this.details = detail
    }
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 深拷贝 + JSON 归一（去掉 undefined 键，避免内存态与磁盘态不等）。 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 归一化 scope：缺省 `'global'`，非法即抛错（不静默改写成 global）。 */
function normalizeScope(scope, where) {
  if (scope === undefined || scope === null || scope === '') return DEFAULT_SCOPE
  if (typeof scope !== 'string') {
    throw new ScratchError(
      `scratch.${where}：scope 必须是字符串（收到 ${typeof scope}）`,
      'SCRATCH_BAD_SCOPE',
      { scope, where },
    )
  }
  if (!SCOPE_RE.test(scope)) {
    throw new ScratchError(
      `scratch.${where}：非法 scope=${JSON.stringify(scope)}（允许 [A-Za-z0-9._-]，`
      + '须以字母/数字开头，长度 1–64）——scope 会拼进文件名，必须挡路径穿越',
      'SCRATCH_BAD_SCOPE',
      { scope, where },
    )
  }
  return scope
}

/** 归一化正文：只接受字符串（不把对象 JSON.stringify 成"便签"，那是静默变形）。 */
function normalizeText(text, where) {
  if (typeof text !== 'string') {
    throw new ScratchError(
      `scratch.${where}：text 必须是字符串（收到 ${text === null ? 'null' : typeof text}）`,
      'SCRATCH_BAD_TEXT',
      { type: typeof text, where },
    )
  }
  return text
}

/** 归一化 now（可注入，测试用）：非有限数即兜底当前时间，保证永不 NaN。 */
function normalizeNow(now) {
  return Number.isFinite(now) ? Math.floor(now) : Date.now()
}

/** 归一化 by（可选的写入者标识，仅用于人读的审计统计）。 */
function normalizeBy(by) {
  if (by === undefined || by === null || by === '') return null
  return typeof by === 'string' ? by : String(by)
}

/** UTF-8 字节数（中文一字 3 字节，必须按字节判上限，否则 512KiB 会被悄悄突破）。 */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * 与 board.js 一致，**不做静默兜底**。
 * @param {{ stateDir?: string }} config
 * @returns {string}
 */
function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') {
    return config.stateDir.trim()
  }
  if (kernel && typeof kernel.stateDir === 'function') {
    return kernel.stateDir()
  }
  const reason = kernelError?.message ?? (kernel ? 'kernel.stateDir 不存在' : 'kernel 未加载')
  throw new ScratchError(
    `scratch.createScratch：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'SCRATCH_NO_STATE_DIR',
  )
}

/**
 * 把 `(ctx, config)` 归一，允许「只传一个 config 对象」的简写（`{ stateDir }`）。
 * 与 discipline.js 的 splitArgs 同款：两种写法语义完全一致。
 */
function splitArgs(ctx, config) {
  const cfgGiven = config && typeof config === 'object' && Object.keys(config).length > 0
  if (cfgGiven) return { context: ctx ?? {}, config }
  if (ctx && typeof ctx === 'object' && typeof ctx.stateDir === 'string') {
    return { context: {}, config: ctx }
  }
  return { context: ctx ?? {}, config: config ?? {} }
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 创建一个便签实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（缺失即降级为 no-op 日志）
 * @param {{ stateDir?: string, name?: string }} [config]
 * @returns {object} scratch service
 */
export function createScratch(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  /** 便签目录（`<stateDir>/scratch/`；与 jsonl 混在根目录会让 `listScopes` 到处误扫）。 */
  const dir = statePath(stateDir, 'scratch')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  let disposed = false
  /** 运行期统计（不落盘：便签正文本身就是唯一真相，统计只是给 /status 看）。 */
  const diagnostics = {
    stateDir,
    dir,
    writes: 0,
    reads: 0,
    listCalls: 0,
    lastWrite: /** @type {null|{scope:string, by:string|null, at:number, bytes:number}} */ (null),
    lastError: /** @type {null|string} */ (null),
  }

  /** 已销毁实例的调用一律抛错：静默返回空便签会让人以为「内容没了」，比崩掉更难查。 */
  function assertAlive(where) {
    if (disposed) {
      throw new ScratchError(
        `scratch.${where}：实例已 dispose()，请重新 createScratch()（拒绝在已销毁实例上静默返回空数据）`,
        'SCRATCH_DISPOSED',
        { where },
      )
    }
  }

  /** scope → 文件绝对路径。 */
  function fileOf(scope) {
    return statePath(dir, `${scope}${FILE_EXT}`)
  }

  /** 建目录（失败即抛错，不静默继续写）。 */
  function ensureDir() {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      throw new ScratchError(
        `scratch：无法创建便签目录 ${dir}（${error?.message ?? error}）`,
        'SCRATCH_MKDIR_FAILED',
        { dir, error: String(error?.message ?? error) },
      )
    }
  }

  /**
   * 读一条便签。
   *
   * **不存在 → 返回空**（`exists:false`），不抛错：新便签天然为空，
   * 「还没写过」不是异常。其余 IO 错误（EACCES/ENOTDIR…）才抛。
   *
   * @param {{ scope?: string }} [input]
   * @returns {{ scope: string, text: string, updatedAt: number, bytes: number, exists: boolean }}
   */
  function read(input = {}) {
    assertAlive('read')
    const scope = normalizeScope(input?.scope, 'read')
    const file = fileOf(scope)
    diagnostics.reads += 1
    try {
      const st = statSync(file)
      if (!st.isFile()) {
        throw new ScratchError(
          `scratch.read：${file} 存在但不是普通文件（scope=${scope}）`,
          'SCRATCH_READ_FAILED',
          { scope, file },
        )
      }
      const text = readFileSync(file, 'utf8')
      return {
        scope,
        text,
        // mtime 是**磁盘真相**：用 round 而不是 floor —— utimesSync 写入整数毫秒后
        // stat 会回读成 x.999（浮点误差），floor 会平白少 1 毫秒。
        updatedAt: Math.round(st.mtimeMs),
        bytes: st.size,
        exists: true,
      }
    } catch (error) {
      if (error instanceof ScratchError) throw error
      if (error?.code === 'ENOENT') {
        return { scope, text: '', updatedAt: 0, bytes: 0, exists: false }
      }
      diagnostics.lastError = String(error?.message ?? error)
      throw new ScratchError(
        `scratch.read：读取 ${file} 失败（${error?.message ?? error}）`,
        'SCRATCH_READ_FAILED',
        { scope, file, error: String(error?.message ?? error) },
      )
    }
  }

  /**
   * 写一条便签（原子覆盖）。
   *
   * 顺序：临时文件 → write → fsync →（可选 utimes）→ rename → fsync 目录。
   * 任何一步失败都清掉临时文件并抛错；**目标文件在 rename 之前始终是旧的完整内容**。
   *
   * @param {{ scope?: string, text: string, by?: string, now?: number }} input
   * @returns {{ scope: string, text: string, updatedAt: number, bytes: number, exists: boolean }}
   */
  function write(input = {}) {
    assertAlive('write')
    const scope = normalizeScope(input?.scope, 'write')
    const text = normalizeText(input?.text, 'write')
    const by = normalizeBy(input?.by)
    const at = normalizeNow(input?.now)
    const bytes = byteLength(text)

    if (bytes > MAX_BYTES) {
      throw new ScratchError(
        `scratch.write：便签 ${scope} 正文 ${bytes} 字节，超过上限 ${MAX_BYTES} 字节（512 KiB）——`
        + '请拆分到多个 scope 或先精简内容',
        'SCRATCH_TOO_LARGE',
        { scope, bytes, max: MAX_BYTES },
      )
    }

    ensureDir()
    const file = fileOf(scope)
    // 临时文件名带 pid + 随机串：多进程/多实例同时写同一 scope 时互不踩踏，
    // 最后 rename 者胜（最后一次写赢，符合"保存"语义）；不共享固定 tmp 名是为了
    // 避免 A 进程 rename 掉 B 进程正在写的 tmp（那会丢 B 的整次保存）。
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`

    try {
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, text, null, 'utf8')
        // fsync 必须在 rename 之前：只 rename 不 fsync，掉电后新名字可能指向空数据。
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      // 调用方给了 now → 把它落到文件 mtime 上，使 read() 的 updatedAt 与
      // write() 的逻辑时间一致（否则测试/审计会看到"刚写完却显示旧时间"）。
      // 失败不算致命：内容已写对，mtime 只是元数据，记 warn 继续。
      if (input?.now !== undefined) {
        try {
          utimesSync(tmp, new Date(at), new Date(at))
        } catch (error) {
          warn(`[cs-bots/scratch] 设置 ${file} 的 mtime 失败（${error?.message ?? error}）——内容不受影响`)
        }
      }
      renameSync(tmp, file)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* 临时文件可能根本没建成；清理失败不掩盖原始错误 */ }
      diagnostics.lastError = String(error?.message ?? error)
      throw new ScratchError(
        `scratch.write：写入 ${file} 失败（${error?.message ?? error}）——原便签保持完整未被破坏`,
        'SCRATCH_WRITE_FAILED',
        { scope, file, tmp, error: String(error?.message ?? error) },
      )
    }

    // 目录 fsync：rename 的**目录项**落盘也需要它，否则断电后可能出现
    // 「文件内容在、但目录里看不到这个名字」。best-effort，失败只 warn。
    try {
      const dfd = openSync(dir, 'r')
      try { fsyncSync(dfd) } finally { closeSync(dfd) }
    } catch (error) {
      warn(`[cs-bots/scratch] fsync 目录 ${dir} 失败（${error?.message ?? error}）`)
    }

    diagnostics.writes += 1
    diagnostics.lastWrite = { scope, by, at, bytes }
    info(`[cs-bots/scratch] 已保存 scope=${scope} bytes=${bytes} by=${by ?? 'unknown'}`)

    let updatedAt = at
    try {
      updatedAt = Math.round(statSync(file).mtimeMs)
    } catch { /* stat 失败就用逻辑时间；内容已落盘 */ }
    return { scope, text, updatedAt, bytes, exists: true }
  }

  /**
   * 列出所有已存在的便签（按 scope 字典序，保证跨平台/跨次调用顺序稳定）。
   *
   * 只认 `<scope>.md`：临时文件（`.md.tmp-<pid>-<rand>`）与别的东西一律忽略，
   * 否则并发写期间的半成品会被误报成"一条便签"。
   *
   * @returns {{ scope: string, updatedAt: number, bytes: number }[]}
   */
  function listScopes() {
    assertAlive('listScopes')
    diagnostics.listCalls += 1
    let names
    try {
      names = readdirSync(dir)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw new ScratchError(
        `scratch.listScopes：读取目录 ${dir} 失败（${error?.message ?? error}）`,
        'SCRATCH_LIST_FAILED',
        { dir, error: String(error?.message ?? error) },
      )
    }

    const out = []
    for (const name of names) {
      if (typeof name !== 'string' || !name.endsWith(FILE_EXT)) continue
      const scope = name.slice(0, -FILE_EXT.length)
      if (!SCOPE_RE.test(scope)) continue
      try {
        const st = statSync(statePath(dir, name))
        if (!st.isFile()) continue
        out.push({ scope, updatedAt: Math.round(st.mtimeMs), bytes: st.size })
      } catch {
        // 列目录与 stat 之间被删（并发/外部清理）→ 跳过这一条，不炸整个列表
      }
    }
    out.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0))
    return out
  }

  /**
   * 统计（给 /status 与 UI 概览用）。
   * @returns {{ scopes: number, bytes: number, maxBytes: number, dir: string,
   *            writes: number, reads: number, lastWrite: object|null, lastError: string|null }}
   */
  function stats() {
    assertAlive('stats')
    const items = listScopes()
    let bytes = 0
    for (const item of items) bytes += item.bytes
    return {
      scopes: items.length,
      bytes,
      maxBytes: MAX_BYTES,
      dir,
      writes: diagnostics.writes,
      reads: diagnostics.reads,
      lastWrite: clone(diagnostics.lastWrite),
      lastError: diagnostics.lastError,
    }
  }

  /**
   * 销毁实例（拒绝后续调用）。
   * 为什么不删文件：便签是用户资产，dispose 只是「这个实例下班了」。
   * @returns {{ disposed: boolean, scopes: number }}
   */
  function dispose() {
    const scopes = (() => {
      try { return listScopes().length } catch { return 0 }
    })()
    disposed = true
    return { disposed: true, scopes }
  }

  const service = {
    name: cfg.name ?? 'scratch',
    paths: Object.freeze({ stateDir, dir }),
    read,
    write,
    listScopes,
    stats,
    dispose,
    diagnostics: () => clone(diagnostics),
  }
  return service
}

export default createScratch
