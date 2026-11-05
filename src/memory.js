/**
 * cs-bots MemoryService —— 分层记忆。
 *
 * 设计依据：`multiagent/10-初步架构设计方案-v1.md` §3.4（六层设计）。
 *
 * ── 为什么要自建（硬事实）──
 *   官方**没有**记忆系统；第三方 `dsh-memory-evolve` **不能依赖**（零依赖纪律，见 key 记忆：
 *   禁依赖 6 个插件）。⇒ 平台必须自建。本文件即该自建实现。
 *
 * ── 六层（§3.4 原文）──
 *   | 层 | 名称 | 写入者 | 常驻注入 |
 *   | L0 | 人格 persona      | **模型不可写**，仅人改配置 | ✅ |
 *   | L1 | 用户偏好          | 自动 review + 人          | ✅ |
 *   | L2 | 团队全局          | 主 Bot / 房间管理员       | ✅ |
 *   | L3 | 项目 key（按 git 分支过滤） | 任一成员（限本项目） | ✅ |
 *   | L4 | 任务与会话笔记    | 成员本人                  | ❌ 按需 recall |
 *   | L5 | 日札              | 后台 consolidate          | ❌ 按需 recall |
 *
 * ── 四条规定（治「review 与显式写入打架」，逐条机械化，**不靠自觉**）──
 *   1. **条目身份证**：每条带 8 位 `[id:xxxxxxxx]` + `[rev:N]`；一切修改**按 id 定位**
 *      （`update`/`remove`/`archive`/`restore` 都要求 id，不存在「按编号改第 3 条」这种易错面）。
 *   2. **权限分级**：`explicit:true` 条目（人显式说的）**review 只能建议不能改** ——
 *      `review()` 命中 explicit 条目时**不写盘**，只在返回值里给 `{ action:'suggest', ... }`；
 *      `update()` 不带 `explicit:true` 改 explicit 条目 → 抛 `MEMORY_EXPLICIT_PROTECTED`。
 *   3. **冲突不静默**：矛盾两条**都留**，两条都标 `[conflict]` + 互相 `conflictWith`，
 *      `contextFor()` 渲染时显式输出 `[conflict]` 标记。
 *   4. **写入优先级**：显式工具 > 自动 review > 后台 consolidate。落点：`source` 三值
 *      (`explicit`/`review`/`consolidate`)，低优先级写者不得改写高优先级条目（见 `assertWriteAllowed`）。
 *
 * ── 上限取值：600，**不用** ds-bot 的 300 ──
 *   依据（§3.4）：实测本机 `~/.dsh/memories/MEMORY.md` 最长单行 **826 字符** ——
 *   ds-bot 的 `entry:300` 会把这类真实条目**全拒收**。⇒ `entryMax = 600`，
 *   且 `add()` 对超长内容**自动切分**为多条（**无损**：切分只按码点切，不插入任何标记，
 *   各片段拼回 === 原文），并在返回条目上显式给 `split:true` + `parts:[...]`
 *   ——「超上限」这件事**看得见**，不是静默截断。`update()` 无法切分（它是单条 CAS），
 *   故超长直接抛 `MEMORY_ENTRY_TOO_LONG`。
 *
 * ── cwd 作用域（按工作目录隔离，2026-11-04 对齐记忆进化 #2）──
 *   问题：改造前所有条目是**全局单库**，多个项目的记忆互相串味
 *   （A 项目的「密钥在 .env.local」会出现在 B 项目的上下文里）。证据：`ANALYSIS-memory-evolve-parity.md` #2。
 *   方案：
 *     - 只有 **L3 项目 key / L4 任务笔记 / L5 日札**带 `cwd` 字段（归一化：`resolve()` 后去尾斜杠，只收绝对路径）；
 *     - **L0/L1/L2 是全局层**（人的身份 / 偏好 / 团队规矩属于「这个人 / 这个团队」，不属于某个项目），
 *       传了 cwd 也**不记**（记下来会让全局条目被某个项目锁住，别的项目反而看不见 —— 反直觉）；
 *     - `list()` / `search()` / `contextFor()` 新增可选 `cwd`：**缺省不过滤**（保持旧行为，兼容既有调用方与 33 个用例），
 *       `'*'` = 显式跨项目视图，具体路径 = 「全局条目 + 该 cwd 的 L3/L4/L5」；
 *     - `migrateCwd()` 是把「未归属项目」的老条目批量归属到某个项目的迁移入口。
 *   老条目兼容取舍见 `cwdVisible()` 的注释（**故意**不让它们出现在具体项目视图里）。
 *
 * ── 存储 ──
 *   `memory.jsonl`     事件流（**真相源**，append-only）
 *   `memory.snap.json` 原子快照（加速启动；事件流为空时才作为回落）
 *   `memory-fts.db`    FTS5 检索索引（**派生缓存**，可随时重建；坏了不影响真相）
 *
 * ── 检索的两条路径（都必须可用）──
 *   a) `node:sqlite` FTS5 + **trigram** 分词器。为什么必须 trigram：实测 unicode61/porter
 *      对中文整段不分词，`MATCH '分层记忆'` 返回 0；trigram 可用（2026-11-01 本机实测：
 *      `分支策略`/`主干开发`/`discipline` 均命中）。查询一律**加引号短语 + 双引号转义**，
 *      杜绝 FTS5 运算符注入（`NEAR`/`*`/`:` 等实测均被安全降级为字面短语）。
 *   b) 退化路径 `String.includes`：sqlite 不可用、或词表无法建立、或查询短于 3 个码点
 *      （trigram 的物理下限）时启用。走哪条由 `diagnostics().searchBackend` **可见地**记录。
 *
 * ── 为什么 kernel.js 是动态导入（照 board.js，勿改成静态）──
 *   本仓库是**裸检出**（无 node_modules），静态 import 会让本文件连带 kernel.js 加载失败。
 *   拿不到 kernel 且调用方也没给 `config.stateDir` → **抛可读错误**（不静默兜底）。
 *
 * 依赖面：node 内置（`node:crypto` / `node:sqlite` / `node:path`）+ `./store.js` + `./kernel.js`。
 * **不 import 任何 `@deepseek-ai/*`**（`test/ci-zero-dep.sh` 检查 1 机械强制）。
 */

import { randomBytes } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'

import {
  appendJsonl,
  ensureDir,
  readJson,
  readJsonl,
  statePath,
  writeJsonAtomic,
} from './store.js'

// ── store.appendAudit 软导入（P1-D §4）───────────────────────────────────────
// 软用：拿不到就只 warn 一次 + 计数，绝不阻断主流程，也绝不自己另造审计格式。
// 用顶层 await 一次性判定（memory.js 已是 ESM + 顶层 await），commit() 里同步判定。
let storeAppendAudit = /** @type {null | ((dir: string, entry: object) => unknown)} */ (null)
let storeAuditMissing = false
try {
  const storeMod = await import('./store.js')
  if (typeof storeMod.appendAudit === 'function') storeAppendAudit = storeMod.appendAudit
  else storeAuditMissing = true
} catch {
  storeAuditMissing = true
}

// ── kernel 惰性桥（见文件头「为什么是动态导入」）──────────────────────────────

/** @type {object | null} */
let kernel = null
/** @type {unknown} */
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

// ── node:sqlite 惰性桥（可用则用 FTS5，不可用则退化 includes）──────────────────

/** @type {object | null} */
let sqliteModule = null
/** @type {string | null} */
let sqliteError = null
try {
  // 显式 catch：Node < 22.5 无此模块，宿主机差异不该让整个记忆服务装配失败。
  sqliteModule = await import('node:sqlite')
} catch (error) {
  sqliteError = error?.message ?? String(error)
}

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 六层（顺序即注入顺序）。 */
export const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']
/** 常驻注入的层（§3.4「常驻注入 ✅」= L0–L3）；L4/L5 按需 recall。 */
export const INJECTED_LAYERS = ['L0', 'L1', 'L2', 'L3']
/** 层的中文名（渲染用）。 */
const LAYER_NAMES = {
  L0: '人格 persona（人改，模型不可写）',
  L1: '用户偏好',
  L2: '团队全局',
  L3: '项目 key（按 git 分支过滤）',
  L4: '任务与会话笔记（按需 recall）',
  L5: '日札（按需 recall）',
}
/** 唯一天然不可写的层。 */
const PERSONA_LAYER = 'L0'
/** 单条内容上限（**不是** ds-bot 的 300，见文件头「上限取值」）。 */
const DEFAULT_ENTRY_MAX = 600
/** id 长度（8 位 hex，渲染为 `[id:xxxxxxxx]`）。 */
const ID_LEN = 8
/** 切分时的软边界回溯窗口占 max 的比例（在窗口内找换行/空格，找不到就硬切）。 */
const SOFT_BOUNDARY_RATIO = 0.5
/** 事件动作集合。 */
const ACTIONS = ['add', 'update', 'remove', 'archive', 'restore', 'review', 'consolidate', 'migrate', 'purge']
/** 按 cwd 隔离的层（见文件头「cwd 作用域」）：只有 L3/L4/L5 归属某个项目。 */
export const CWD_LAYERS = ['L3', 'L4', 'L5']
/** `cwd:'*'` = 显式要求跨项目视图（UI 的「全部项目」按钮）。 */
export const CWD_ALL = '*'
/** 否定极性标记（用于「冲突 vs 重复」判定，见 `polarityOf`）。 */
const NEG_MARKERS = ['不', '禁止', '不要', '别', 'never', 'must not', 'mustn\'t', '避免', '不可', '无需', '不应']
/** 肯定极性标记（存在即视为「有极性主张」，用于与否定对照）。 */
const POS_MARKERS = ['必须', '要', '应该', 'always', 'must', 'should', '推荐', '优先', '使用']

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 记忆服务结构化错误。所有失败都走它，**绝不静默**。 */
export class MemoryError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息（层 / id / rev / 字段名）
   * @param {string} [code]
   * @param {object} [details]
   */
  constructor(message, code = 'MEMORY_ERROR', details) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/**
 * 深拷贝 + **JSON 归一**（去掉值为 undefined 的键）。
 * 必须走 JSON 而不是 structuredClone：否则内存态会比磁盘态多出 `{archived: undefined}`
 * 这类键，导致 `replay()` 重建后的 `list()` 与原值不等（照 board.js 的教训）。
 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 码点长度（切分与上限判定都用码点数，避免代理对被切开）。 */
function cpLength(text) {
  return Array.from(String(text ?? '')).length
}

/** 非空字符串字段校验。 */
function requireString(value, field, where) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MemoryError(
      `memory.${where}：字段 ${field} 缺失或类型错误（要求非空字符串，收到 ${JSON.stringify(value)}）`,
      'MEMORY_MISSING_FIELD',
      { field, where },
    )
  }
  return value
}

/** 可选字符串字段校验（给了就必须是非空字符串）。 */
function optionalString(value, field, where) {
  if (value === undefined || value === null) return undefined
  return requireString(value, field, where)
}

/** 字符串数组归一：接受 `string | string[]`，去空、去重、保序。 */
function stringList(value, field, where) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new MemoryError(
        `memory.${where}：字段 ${field} 的元素必须是非空字符串，收到 ${JSON.stringify(item)}`,
        'MEMORY_BAD_FIELD',
        { field, where },
      )
    }
    const v = item.trim()
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** 层名校验。 */
function requireLayer(value, where) {
  const layer = requireString(value, 'layer', where)
  if (!LAYERS.includes(layer)) {
    throw new MemoryError(
      `memory.${where}：非法 layer=${JSON.stringify(layer)}（合法值：${LAYERS.join(' | ')}）`,
      'MEMORY_BAD_LAYER',
      { layer, valid: LAYERS },
    )
  }
  return layer
}

/** 正整数校验（limit 用）。 */
function optionalLimit(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new MemoryError(
      `memory.${where}：limit 必须是正整数，收到 ${JSON.stringify(value)}`,
      'MEMORY_BAD_FIELD',
      { field: 'limit', where },
    )
  }
  return value
}

/** 时间参数归一：缺省 now；支持 ms 数字与 Date。 */
function normalizeNow(value, where) {
  if (value === undefined || value === null) return Date.now()
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new MemoryError(
    `memory.${where}：now 必须是毫秒时间戳或 Date，收到 ${JSON.stringify(value)}`,
    'MEMORY_BAD_NOW',
    { where },
  )
}

// ── cwd 作用域（按工作目录隔离）───────────────────────────────────────────────

/** 层是否按 cwd 隔离（L0/L1/L2 是全局层，见文件头「cwd 作用域」）。 */
function cwdScopedLayer(layer) {
  return CWD_LAYERS.includes(layer)
}

/**
 * cwd 归一化：`resolve()` 后去掉结尾斜杠。
 *
 * 两条硬规定：
 *   1. **只收绝对路径**。相对路径要按「某个进程的当前目录」解释，而记忆是跨会话、跨 Bot
 *      共享的 —— 同一个相对路径在不同进程里指向不同项目，会把记忆静默挂错项目。
 *      所以直接拒收（`MEMORY_BAD_FIELD`），不做「猜一个 cwd」的兜底。
 *   2. **去尾斜杠**（根 `/` 除外）。`/a/b` 与 `/a/b/` 必须算同一个项目，
 *      否则同一项目会分裂成两个视图、迁移看起来「一半成功」。
 *
 * @param {unknown} value
 * @param {string} field
 * @param {string} where
 * @returns {string}
 */
function normalizeCwd(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MemoryError(
      `memory.${where}：字段 ${field} 必须是非空字符串（绝对路径），收到 ${JSON.stringify(value)}`,
      'MEMORY_BAD_FIELD',
      { field, where },
    )
  }
  const raw = value.trim()
  if (!isAbsolute(raw)) {
    throw new MemoryError(
      `memory.${where}：字段 ${field} 必须是绝对路径（收到 ${JSON.stringify(raw)}）—— `
      + '相对路径要按某个进程的当前目录解释，跨会话会指向别的项目，故拒收',
      'MEMORY_BAD_FIELD',
      { field, where, value: raw },
    )
  }
  let abs = resolve(raw)
  while (abs.length > 1 && (abs.endsWith('/') || abs.endsWith(sep))) abs = abs.slice(0, -1)
  return abs
}

/**
 * 读侧过滤参数归一。
 *
 * **`undefined` / `null` → 不过滤**：这是兼容前提 —— `api.js` / `tools.js` 与既有
 * 33 个用例都按「不传 cwd = 看全部」消费；若把缺省改成「只看当前项目」，
 * 那些调用方会突然少一半记忆（静默行为变更）。
 * `''`（空串）也按「未提供」处理：HTTP 查询串里 `?cwd=` 与「没有这个参数」在语义上
 * 无法区分（UI 的「全部项目」很可能就发空串），读侧宽容比让 UI 报 400 更合理；
 * 注意**写侧**相反 —— `add({cwd:''})` 是「要归属但没给路径」，必须报错（见 cwdForWrite）。
 * `'*'` → 不过滤（语义上不同：调用方**显式**要求跨项目视图，如 UI 的「全部项目」）。
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {string | undefined} undefined = 不过滤
 */
function normalizeCwdFilter(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && (value.trim() === '' || value.trim() === CWD_ALL)) return undefined
  return normalizeCwd(value, 'cwd', where)
}

/**
 * 条目在某个 cwd 视图里是否可见（`targetCwd === undefined` 表示不过滤）。
 *
 * ── 老数据（无 cwd 字段）的处置：**故意如此，不是 bug** ──
 * 改造前写入的 L3/L4/L5 条目没有 `cwd` 字段 = 「未归属项目」。按 cwd 过滤时
 * **它们不出现在任何具体 cwd 视图里**（只在不传 cwd / `cwd:'*'` 时可见）。
 *
 * 为什么故意这样（取舍理由）：
 *   - 老条目来自全局单库，**没人知道它属于哪个项目** —— 让它们出现在每个项目视图
 *     就等于把「A 项目的密钥在 .env.local」原封不动搬进 B 项目，而那正是本次改造要消灭的串味。
 *   - **宁可少看见，不可看错**：多看见一条不属于本项目的记忆，会让 Bot 做出错误决定
 *     （且这种错误静默、难追溯）；少看见一条只是信息不全，用户有明确的补救入口 —— `migrateCwd()`。
 *   - 恢复可见性是**一次显式、可审计的动作**（人点「把历史记忆归到当前项目」），
 *     而不是靠启发式猜测归属（猜错的代价比不猜高）。
 *
 * 注意「全局层永远可见」的判据是 **layer**，不是「有没有 cwd 字段」：
 * L0/L1/L2 即使记录里意外带了 cwd（手改 jsonl 等）也仍然全局可见 —— 层语义优先。
 *
 * @param {object} entry
 * @param {string | undefined} targetCwd
 * @returns {boolean}
 */
function cwdVisible(entry, targetCwd) {
  if (targetCwd === undefined) return true
  if (!cwdScopedLayer(entry?.layer)) return true
  return entry.cwd === targetCwd
}

// ── 极性 / 签名（规定 3 的判定基础）────────────────────────────────────────────

/**
 * 极性探测：条目是否含「否定」标记（`neg`）或「肯定主张」标记（`pos`）。
 * @param {string} text
 * @returns {{ neg: boolean, pos: boolean }}
 */
function polarityOf(text) {
  const lower = String(text ?? '').toLowerCase()
  const hit = (markers) => markers.some((m) => lower.includes(m.toLowerCase()))
  return { neg: hit(NEG_MARKERS), pos: hit(POS_MARKERS) }
}

/**
 * 条目签名：**剥掉否定标记**后做归一（小写 + 去标点 + 折叠空白）。
 *
 * 用途：判断两条是否在讨论「同一件事」——例如
 *   `本项目使用 pnpm`  与  `本项目不使用 pnpm`
 * 归一后签名相同、极性相反 ⇒ **矛盾**（规定 3：两条都留并标 conflict），
 * 而不是被当成重复合并掉。**冲突判定先于去重判定**，顺序不可颠倒。
 *
 * @param {string} text
 * @returns {string}
 */
function signatureOf(text) {
  let s = String(text ?? '').toLowerCase()
  for (const m of NEG_MARKERS) s = s.split(m.toLowerCase()).join('')
  return s
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；、！？：,.;!?:'"“”‘’()（）[\]【】{}<>《》~`|/\\_\-+*=#*&^%$@!]/g, '')
}

/**
 * 重复判定用的归一：小写 + 折叠空白 + 去首尾标点（**不**剥否定标记）。
 * @param {string} text
 * @returns {string}
 */
function dupKeyOf(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[\s，。；、！？：,.;!?:'"“”()（）[\]【】]+|[\s，。；、！？：,.;!?:'"“”()（）[\]【】]+$/g, '')
}

// ── 内容切分（无损）──────────────────────────────────────────────────────────

/**
 * 把超长内容切成每段 ≤ `max` 码点的片段。**无损**：`parts.join('') === content`。
 * 软边界优先（回溯窗口内找最后的换行，其次空格），找不到就硬切 —— 但**绝不丢字符**、
 * 也绝不插入 `[1/2]` 之类的标记（那会污染记忆正文）。
 *
 * @param {string} content
 * @param {number} max
 * @returns {string[]} 至少一段；内容为空时返回 `['']`（调用方另行校验非空）
 */
function partitionContent(content, max) {
  const cps = Array.from(String(content ?? ''))
  if (cps.length <= max) return [String(content ?? '')]
  const softFloor = Math.max(1, Math.floor(max * SOFT_BOUNDARY_RATIO))
  const parts = []
  let i = 0
  while (i < cps.length) {
    let end = Math.min(i + max, cps.length)
    if (end < cps.length) {
      let cut = -1
      for (let j = end - 1; j >= i + softFloor; j -= 1) {
        if (cps[j] === '\n') { cut = j + 1; break }
      }
      if (cut < 0) {
        for (let j = end - 1; j >= i + softFloor; j -= 1) {
          if (cps[j] === ' ') { cut = j + 1; break }
        }
      }
      if (cut > i) end = cut
    }
    parts.push(cps.slice(i, end).join(''))
    i = end
  }
  return parts
}

/**
 * 粗略估 token（调研驱动：cs-myfree 用 4 字符/英文 + 1.5/中文）。
 * 不追求精确（精确要 tokenizer，代价大于收益），只用于预算判断。
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  const s = String(text ?? '')
  if (s === '') return 0
  let wide = 0
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x2e80) wide += 1
  }
  const narrow = s.length - wide
  return Math.ceil(narrow / 4 + wide / 1.5)
}

/** 注入层的保留优先级（高者在预算不足时优先保留）：L3 项目 key 离当前任务最近。 */
const INJECT_PRIORITY = { L3: 4, L2: 3, L1: 2, L0: 1 }

// ── 写入优先级（规定 4）───────────────────────────────────────────────────────

/** 写者优先级：数值越大越优先（规定 4：显式工具 > review > consolidate）。 */
const WRITE_RANK = { explicit: 3, review: 2, consolidate: 1 }

/**
 * 条目的「被保护等级」——**由 `explicit` 布尔与来源共同决定**。
 *
 * ⚠️ 这里有一个必须讲清的取舍（2026-11-01 实测踩到，不是想当然）：
 *   若按字面把「规定 4 的阶梯」直接映射成 `protection = rank(source)`，那么
 *   `add()` 默认 `source='explicit'`（**经显式工具写入**）→ 保护级 3 → `consolidate`(1)
 *   永远无权改动**任何一条正常写入的记忆** ⇒ 合并/冲突标记功能当场死掉，
 *   而这恰恰是 §3.4 给 consolidate 的职责。
 *
 * 故正确模型是分开两件事：
 *   - **`explicit:true`（人显式说的）** = 硬保护（保护级 3）：review 只能建议、consolidate 不得改写（规定 2）。
 *   - **`source`** = 来源留痕 + 在**自动写者之间**排先后（规定 4）：review 写的条目保护级 2，
 *     consolidate 写的保护级 0 —— 于是「review > consolidate」仍然可观测，而工具直写的条目
 *     保护级 0，任何自动写者都能处理。
 *
 * @param {object} entry
 * @returns {number} 0/2/3
 */
function protectionOf(entry) {
  if (entry?.explicit === true) return 3 // 规定 2：人显式说的，只有显式写入才能动
  if (entry?.source === 'review') return 2 // 规定 4：自动 review 的产出，consolidate 不得改写
  return 0 // 工具直写（source='explicit' 但非人显式）或 consolidate 自身产出 → 可被自动写者处理
}

/**
 * 规定 2 / 4 的机械化闸门：低优先级写者不得改写高优先级条目。
 *
 * @param {object} entry 目标条目（已存在）
 * @param {'explicit'|'review'|'consolidate'} writer 本次写者身份
 * @param {string} where 调用点（错误信息定位用）
 * @throws {MemoryError} code = `MEMORY_WRITE_PRIORITY_DENIED`
 */
function assertWriteAllowed(entry, writer, where) {
  if (!WRITE_RANK[writer]) {
    throw new MemoryError(
      `memory.${where}：未知写者身份 source=${JSON.stringify(writer)}（合法值：${Object.keys(WRITE_RANK).join(' | ')}）`,
      'MEMORY_BAD_FIELD',
      { field: 'source', where },
    )
  }
  if (entry?.explicit === true && writer !== 'explicit') {
    throw new MemoryError(
      `memory.${where}：条目 [id:${entry.id}] 是 explicit（人显式说的），${writer} 写者无权改写 —— `
      + 'review 请改用 review()（只返回建议、不落盘）；consolidate 请把它报为建议（规定 2）',
      'MEMORY_WRITE_PRIORITY_DENIED',
      { id: entry.id, layer: entry.layer, writer, entrySource: entry.source, explicit: true },
    )
  }
  const guard = protectionOf(entry)
  if (WRITE_RANK[writer] < guard) {
    throw new MemoryError(
      `memory.${where}：写入优先级不足 —— ${writer}(${WRITE_RANK[writer]}) 不能改写 ${entry.source}(保护级 ${guard}) `
      + `的条目 [id:${entry.id}]（规定 4）`,
      'MEMORY_WRITE_PRIORITY_DENIED',
      { id: entry.id, layer: entry.layer, writer, entrySource: entry.source, protection: guard },
    )
  }
}

// ── 状态目录 ────────────────────────────────────────────────────────────────

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**：两条路都不通时必须让调用方看见。
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
  throw new MemoryError(
    `memory.createMemory：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'MEMORY_NO_STATE_DIR',
  )
}

// ── 主体 ────────────────────────────────────────────────────────────────────

/**
 * 创建一个分层记忆实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（只用于日志，缺失即降级 no-op）
 * @param {{ stateDir?: string, entryMax?: number, persona?: string|string[],
 *           searchBackend?: 'auto'|'fts5'|'includes', splitOnOverflow?: boolean,
 *           name?: string }} [config]
 * @returns {object} memory
 */
export function createMemory(ctx, config = {}) {
  const stateDir = resolveStateDir(config)
  const entryMax = Number.isInteger(config.entryMax) && config.entryMax > 0
    ? config.entryMax
    : DEFAULT_ENTRY_MAX
  const splitOnOverflow = config.splitOnOverflow !== false
  /** `searchBackend: 'includes'` 用于**强制**走退化路径（CI 要覆盖两条路）。 */
  const forcedBackend = config.searchBackend ?? 'auto'
  if (!['auto', 'fts5', 'includes'].includes(forcedBackend)) {
    throw new MemoryError(
      `memory.createMemory：config.searchBackend 必须是 auto | fts5 | includes，收到 ${JSON.stringify(forcedBackend)}`,
      'MEMORY_BAD_FIELD',
      { field: 'searchBackend' },
    )
  }

  const jsonlPath = statePath(stateDir, 'memory.jsonl')
  const snapPath = statePath(stateDir, 'memory.snap.json')
  const ftsPath = statePath(stateDir, 'memory-fts.db')

  const info = (...args) => { try { ctx?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { ctx?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** L0 人格：**只来自人改的配置**，永不进事件流（模型不可写的机械保证）。 */
  const persona = stringList(config.persona, 'persona', 'createMemory')

  /** @type {Map<string, object>} id → Entry */
  const entries = new Map()
  /** @type {object[]} 全部 MemoryEvent（审计流，按落盘顺序） */
  const events = []

  const diagnostics = {
    stateDir,
    jsonlPath,
    snapPath,
    ftsPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: /** @type {null|'jsonl'|'snapshot'|'empty'} */ (null),
    replayedEvents: 0,
    badLines: 0,
    snapshotWriteFailures: 0,
    auditWriteFailures: 0,
    auditWarnedOnce: false,
    searchBackend: /** @type {'fts5'|'includes'} */ ('includes'),
    searchBackendReason: /** @type {string} */ ('未初始化'),
    ftsTokenize: /** @type {string|null} */ (null),
    lastSearchAt: /** @type {number|undefined} */ (undefined),
    lastReplayAt: /** @type {number|undefined} */ (undefined),
    // cwd 作用域诊断：上层（UI/调度）可据此判断「上次注入是按项目裁剪的，还是全局的」
    lastContextCwd: /** @type {string|null|undefined} */ (undefined),
    lastContextCwdScoped: /** @type {boolean} */ (false),
  }

  // ── FTS5 索引（派生缓存；坏了不影响真相源）──────────────────────────────────

  /** @type {object | null} */ let db = null

  /**
   * 建立 FTS5 索引。分词器**必须**是 trigram —— 实测 unicode61/porter 对中文整段不分词
   * （`MATCH '分层记忆'` 返回 0），会让中文检索整体失效。
   * 建不起来就退化 `String.includes`，并把原因记进 diagnostics（**可见的降级**）。
   */
  function openIndex() {
    if (forcedBackend === 'includes') {
      diagnostics.searchBackend = 'includes'
      diagnostics.searchBackendReason = 'config.searchBackend=includes（显式强制退化路径）'
      return
    }
    if (!sqliteModule?.DatabaseSync) {
      diagnostics.searchBackend = 'includes'
      diagnostics.searchBackendReason = `node:sqlite 不可用（${sqliteError ?? '无 DatabaseSync 导出'}）`
      return
    }
    try {
      ensureDir(stateDir)
      db = new sqliteModule.DatabaseSync(ftsPath)
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5("
        + "id UNINDEXED, layer UNINDEXED, rev UNINDEXED, body, tokenize='trigram')",
      )
      diagnostics.ftsTokenize = 'trigram'
      diagnostics.searchBackend = 'fts5'
      diagnostics.searchBackendReason = 'node:sqlite FTS5 + trigram'
    } catch (error) {
      try { db?.close?.() } catch { /* 关不掉不影响降级 */ }
      db = null
      diagnostics.searchBackend = 'includes'
      diagnostics.searchBackendReason = `FTS5 建表失败，已退化：${error?.message ?? error}`
      warn(`[cs-bots/memory] ${diagnostics.searchBackendReason}`)
    }
  }

  /** 索引里各 id 的 rev（用于增量判断）。 */
  const indexedRev = new Map()

  /** 清空并全量重建索引。 */
  function indexRebuild() {
    indexedRev.clear()
    if (!db) return
    try {
      db.exec('DELETE FROM mem_fts')
      const ins = db.prepare('INSERT INTO mem_fts(id, layer, rev, body) VALUES (?, ?, ?, ?)')
      for (const e of entries.values()) {
        ins.run(e.id, e.layer, e.rev, e.content)
        indexedRev.set(e.id, e.rev)
      }
    } catch (error) {
      // 索引是派生缓存：失败不阻断业务，但**必须可见**（否则检索静默漏结果）
      diagnostics.searchBackend = 'includes'
      diagnostics.searchBackendReason = `索引重建失败，本次已退化：${error?.message ?? error}`
      warn(`[cs-bots/memory] ${diagnostics.searchBackendReason}`)
      try { db?.close?.() } catch { /* ignore */ }
      db = null
    }
  }

  /** 单条增量同步（commit 后调用）。 */
  function indexUpsert(entry) {
    if (!db) return
    try {
      db.prepare('DELETE FROM mem_fts WHERE id = ?').run(entry.id)
      db.prepare('INSERT INTO mem_fts(id, layer, rev, body) VALUES (?, ?, ?, ?)')
        .run(entry.id, entry.layer, entry.rev, entry.content)
      indexedRev.set(entry.id, entry.rev)
    } catch (error) {
      // 增量失败 → 标脏，交给下一次检索前的自愈（见 ensureIndexFresh）
      indexedRev.delete(entry.id)
      warn(`[cs-bots/memory] 索引增量同步失败（id=${entry.id}）：${error?.message ?? error}`)
    }
  }

  /**
   * 检索前自愈：内存态里任一活跃条目的 id/rev 与索引不一致 → 全量重建。
   * 索引是缓存，宁可重建也不能让检索**静默漏条目**。
   */
  function ensureIndexFresh() {
    if (!db) return
    if (indexedRev.size !== entries.size) { indexRebuild(); return }
    for (const e of entries.values()) {
      if (indexedRev.get(e.id) !== e.rev) { indexRebuild(); return }
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 快照内容（落盘形态）。 */
  const snapshot = () => ({
    version: 1,
    savedAt: Date.now(),
    entries: [...entries.values()],
  })

  /**
   * 提交一次变更：**先落事件，再改内存，最后写快照**。
   *
   * 顺序不可颠倒：append 失败时内存必须原封不动（否则内存与磁盘分叉，
   * 重启回放后状态凭空回退，属于最恶劣的静默失败）。
   *
   * @param {string} id
   * @param {string} action
   * @param {string|null} byId
   * @param {number} at
   * @param {object|null} before 变更前 Entry（add 为 null）
   * @param {object} after 变更后 Entry
   * @returns {object} 克隆后的 after
   */
  function commit(id, action, byId, at, before, after) {
    const event = {
      id,
      layer: after.layer,
      rev: after.rev,
      action,
      byId: byId ?? null,
      at,
      before: before ? clone(before) : null,
      after: clone(after),
    }
    if (!appendJsonl(jsonlPath, event)) {
      throw new MemoryError(
        `memory.${action}：事件追加失败（${jsonlPath}）——拒绝「只改内存不落盘」`,
        'MEMORY_APPEND_FAILED',
        { id, action },
      )
    }
    entries.set(id, clone(after))
    events.push(event)
    indexUpsert(after)
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/memory] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可完整恢复`)
    }
    // ── 审计接线（P1-D §4）────────────────────────────────────────────────
    // 软用 store.appendAudit：拿不到/写失败 → 只 warn 一次 + 计数，绝不阻断主流程。
    if (storeAuditMissing) {
      diagnostics.auditWriteFailures += 1
      if (!diagnostics.auditWarnedOnce) {
        diagnostics.auditWarnedOnce = true
        warn('[cs-bots/memory] store.appendAudit 尚不可用 → 审计接线跳过；主流程不受影响')
      }
    } else {
      try {
        const digest = (e) => (e
          ? { id: e.id, layer: e.layer ?? null, rev: e.rev, source: e.source ?? null }
          : null)
        const result = storeAppendAudit(stateDir, {
          ts: at, actor: byId, action, target: id, before: digest(before), after: digest(after),
        })
        const failed = result === false || Boolean(result && typeof result === 'object' && result.ok === false)
        if (failed) {
          diagnostics.auditWriteFailures += 1
          if (!diagnostics.auditWarnedOnce) {
            diagnostics.auditWarnedOnce = true
            warn('[cs-bots/memory] store.appendAudit 返回失败——主流程不受影响')
          }
        }
      } catch (error) {
        diagnostics.auditWriteFailures += 1
        if (!diagnostics.auditWarnedOnce) {
          diagnostics.auditWarnedOnce = true
          warn(`[cs-bots/memory] store.appendAudit 抛错：${error?.message ?? error}——主流程不受影响`)
        }
      }
    }
    return clone(after)
  }

  // ── 回放 ──────────────────────────────────────────────────────────────────

  /**
   * 从 `memory.jsonl`（真相源）重建内存态；jsonl 为空才回落到 `memory.snap.json`。
   * 坏行**不静默丢弃**：计入 diagnostics 并 warn。
   */
  function hydrate() {
    entries.clear()
    events.length = 0

    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) {
      warn(`[cs-bots/memory] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }

    if (rows.length === 0) {
      const snap = readJson(snapPath, null)
      const snapEntries = Array.isArray(snap?.entries) ? snap.entries : null
      if (snapEntries) {
        for (const raw of snapEntries) {
          if (!raw || typeof raw.id !== 'string' || typeof raw.layer !== 'string') continue
          entries.set(raw.id, clone(raw))
        }
        diagnostics.hydratedFrom = 'snapshot'
        indexRebuild()
        info(`[cs-bots/memory] 回放完成：无事件流 → 由快照恢复 ${entries.size} 条`)
        return
      }
      diagnostics.hydratedFrom = 'empty'
      indexRebuild()
      info('[cs-bots/memory] 回放完成：空记忆（无事件流、无快照）')
      return
    }

    // 事件流是真相源：只接受 rev 递增的事件（同 rev 重放幂等，容忍重复投递）
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.id !== 'string') {
        skipped += 1
        continue
      }
      // `after === null` = **彻底删除墓碑**（purge）：从内存移除，但事件本身
      // 仍进 events 供审计/历史查询。为什么不在文件里抹掉这一行：
      // 事件流是只追加的真相源，改写历史会让「谁在什么时候删了什么」永久丢失。
      if (ev.after === null) {
        const beforePurge = entries.get(ev.id)
        if (beforePurge && Number.isFinite(ev.rev) && ev.rev <= beforePurge.rev) {
          skipped += 1
          continue
        }
        entries.delete(ev.id)
        events.push(clone(ev))
        continue
      }
      if (!ev.after || typeof ev.after.id !== 'string') {
        skipped += 1
        continue
      }
      const before = entries.get(ev.id)
      if (before && Number.isFinite(ev.rev) && ev.rev <= before.rev) {
        skipped += 1
        continue
      }
      entries.set(ev.id, clone(ev.after))
      events.push(clone(ev))
    }
    if (skipped > 0) {
      warn(`[cs-bots/memory] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }
    diagnostics.hydratedFrom = 'jsonl'
    indexRebuild()
    info(`[cs-bots/memory] 回放完成：${rows.length} 条事件 → ${entries.size} 条记忆`)
  }

  // ── 内部读取 ──────────────────────────────────────────────────────────────

  /** 生成一个未占用的 8 位 hex id。 */
  function newId() {
    for (let i = 0; i < 1000; i += 1) {
      const id = randomBytes(Math.ceil(ID_LEN / 2)).toString('hex').slice(0, ID_LEN)
      if (!entries.has(id)) return id
    }
    throw new MemoryError('memory：连续 1000 次生成的 id 均已存在（疑似熵源异常）', 'MEMORY_ID_EXHAUSTED')
  }

  /**
   * 按 id 取条目（**按 id 定位是规定 1 的机械落点**）。
   * @param {string} id
   * @param {string|undefined} layer 给了就校验层归属（跨层拿 id 是调用方 bug，必须可见）
   * @param {string} where
   * @returns {object}
   */
  function requireEntry(id, layer, where) {
    const entryId = requireString(id, 'id', where)
    const entry = entries.get(entryId)
    if (!entry) {
      throw new MemoryError(
        `memory.${where}：未知 id=${entryId}（记忆按 id 定位，请先用 list()/search() 取 id）`,
        'MEMORY_ENTRY_NOT_FOUND',
        { id: entryId, layer },
      )
    }
    if (layer !== undefined && layer !== null && entry.layer !== layer) {
      throw new MemoryError(
        `memory.${where}：id=${entryId} 属于 ${entry.layer}，不是 ${layer} —— 拒绝跨层误改`,
        'MEMORY_LAYER_MISMATCH',
        { id: entryId, layer, actualLayer: entry.layer },
      )
    }
    return entry
  }

  /** L0 防线：任何写路径都先过这里。 */
  function assertNotPersonaLayer(layer, where) {
    if (layer === PERSONA_LAYER) {
      throw new MemoryError(
        `memory.${where}：${PERSONA_LAYER} 是人格层，**模型不可写**，只能由人改配置（config.persona）—— 拒绝写入`,
        'MEMORY_PERSONA_IMMUTABLE',
        { layer: PERSONA_LAYER, where },
      )
    }
  }

  /**
   * Bot 可见性：条目不带 `botId` = 全局可见；带了 = 只对该 Bot 可见。
   * @param {object} entry
   * @param {string | undefined} forBot
   */
  function visibleToBot(entry, forBot) {
    if (!entry?.botId) return true
    return entry.botId === forBot
  }

  /** 分支可见性：`branches` 为空 = 全分支可见；否则要求包含目标分支。 */
  function branchVisible(entry, branch) {
    if (branch === undefined || branch === null) return true
    const branches = Array.isArray(entry.branches) ? entry.branches : []
    return branches.length === 0 || branches.includes(branch)
  }

  /**
   * 写侧 cwd 归属计算（add/update 共用）。
   *
   * - 隔离层（L3/L4/L5）：归一化后**返回要落盘的 cwd**；
   * - 全局层（L0/L1/L2）：**忽略**（返回 undefined，不落字段）。为什么不报错：
   *   调用方（工具 / UI）常把「当前工作目录」无脑透传，对 L1/L2 报错会让
   *   「我在这条路径下写的偏好」整条写不进去 —— 那是把一次便利调用变成硬失败；
   *   但**记下来**更糟（全局条目被某个项目锁住，别的项目反而看不见它，反直觉）。
   *   故：忽略 + `warn` 留痕（绝不静默），层语义不受影响。
   * - `'*'` 只能用于**过滤**，不能当作写入归属（会写出一个谁都看不见的 cwd）→ 拒收。
   *
   * @param {string} layer
   * @param {unknown} rawCwd
   * @param {string} where
   * @returns {string | undefined}
   */
  function cwdForWrite(layer, rawCwd, where) {
    if (rawCwd === undefined || rawCwd === null) return undefined
    // 全局层先判：规格是「传了也不记」，故连非法值也一并忽略（不因一个与它无关的字段报错）
    if (!cwdScopedLayer(layer)) {
      warn(`[cs-bots/memory] ${where}：${layer} 是全局层，忽略传入的 cwd=${JSON.stringify(rawCwd)}（L0/L1/L2 不按项目隔离）`)
      return undefined
    }
    if (typeof rawCwd === 'string' && rawCwd.trim() === CWD_ALL) {
      throw new MemoryError(
        `memory.${where}：cwd='*' 是**读侧**的跨项目视图标记，不能作为写入归属 —— `
        + '请传具体项目目录的绝对路径',
        'MEMORY_BAD_FIELD',
        { field: 'cwd', where },
      )
    }
    return normalizeCwd(rawCwd, 'cwd', where)
  }

  // ── API：写 ───────────────────────────────────────────────────────────────

  /**
   * 新增记忆条目（规定 1：返回带 `id` + `rev` 的 Entry）。
   *
   * 超长（> `entryMax` 码点）时**自动无损切分**为多条，返回**首条**并带
   * `split:true` + `parts:[其余 id]`；`splitOnOverflow:false` 时改为抛
   * `MEMORY_ENTRY_TOO_LONG`（两条路都**可见**，绝不静默截断）。
   *
   * @param {{ layer: string, content: string, by: string, explicit?: boolean,
   *           source?: 'explicit'|'review'|'consolidate', branch?: string|string[],
   *           tags?: string[], cwd?: string, now?: number }} input
   * @returns {object} Entry（含 id + rev）
   */
  function add(input = {}) {
    const { layer, content, by, explicit, source, branch, tags, botId, now, cwd } = input ?? {}
    const targetLayer = requireLayer(layer, 'add')
    assertNotPersonaLayer(targetLayer, 'add')
    const author = requireString(by, 'by', 'add')
    const text = requireString(content, 'content', 'add')
    const writer = source === undefined || source === null
      ? 'explicit'
      : requireString(source, 'source', 'add')
    if (!WRITE_RANK[writer]) {
      throw new MemoryError(
        `memory.add：非法 source=${JSON.stringify(source)}（合法值：${Object.keys(WRITE_RANK).join(' | ')}）`,
        'MEMORY_BAD_FIELD',
        { field: 'source' },
      )
    }
    const branches = stringList(branch, 'branch', 'add')
    // Bot 维度：不传 = 全局记忆；传了 = 只在那个 Bot 的 contextFor 里出现
    const ownerBot = optionalString(botId, 'botId', 'add')
    const tagList = stringList(tags, 'tags', 'add')
    // cwd 维度：只有 L3/L4/L5 记录（全局层忽略，见 cwdForWrite 注释）
    const ownerCwd = cwdForWrite(targetLayer, cwd, 'add')
    const at = normalizeNow(now, 'add')

    const parts = cpLength(text) > entryMax ? partitionContent(text, entryMax) : [text]
    if (parts.length > 1 && !splitOnOverflow) {
      throw new MemoryError(
        `memory.add：内容超长（${cpLength(text)} > ${entryMax} 码点上限），且 config.splitOnOverflow=false —— 拒绝写入`,
        'MEMORY_ENTRY_TOO_LONG',
        { length: cpLength(text), max: entryMax, layer: targetLayer },
      )
    }

    /** @type {object[]} */
    const created = []
    // ⚠️ 修复（2026-11-04 测试，P1-2）：原来 `split`/`parts` 只挂在返回给调用方的
    //   克隆上（commit 已落盘之后才挂），⇒ 读回来（list/search/replay）全部丢失，
    //   切分状态"不可持久、不可审计"，UI 会显示成"单条完整"。
    //   现在：先算出全量 id，把 `splitGroup`（同一原文的组标识）+ `splitIndex` +
    //   `splitTotal` **写进每条 entry 本身**，然后一起落盘。
    const groupId = parts.length > 1 ? newId() : null
    const ids = parts.map(() => newId())
    for (const [i, part] of parts.entries()) {
      const id = ids[i]
      /** @type {Record<string, unknown>} */
      const entry = {
        id,
        rev: 1,
        layer: targetLayer,
        content: part,
        source: writer,
        explicit: explicit === true,
        branches,
        ...(ownerBot !== undefined ? { botId: ownerBot } : {}),
        // cwd 必须写进**条目本身**（随 commit → 事件流 → 落盘）；
        // 只挂在返回克隆上会重演 split 标记的老坑：读回来就丢（P1-2 教训）。
        ...(ownerCwd !== undefined ? { cwd: ownerCwd } : {}),
        tags: tagList.slice(),
        createdAt: at,
        createdBy: author,
        updatedAt: at,
        updatedBy: author,
      }
      if (groupId !== null) {
        // 持久化的切分元数据：组标识 + 序号 + 总数 + 组内全部 id（便于无损还原原文）
        entry.splitGroup = groupId
        entry.splitIndex = i
        entry.splitTotal = parts.length
        entry.splitParts = ids.slice()
      }
      try {
        created.push(commit(id, 'add', author, at, null, entry))
      } catch (error) {
        // 绝不静默：已落盘的部分必须被调用方看见
        throw new MemoryError(
          `memory.add：切分写入第 ${created.length + 1}/${parts.length} 段失败 —— `
          + `已落盘 ${created.length} 段（id: ${created.map((e) => e.id).join(', ') || '无'}）：${error?.message ?? error}`,
          'MEMORY_PARTIAL_SPLIT',
          { layer: targetLayer, created: created.map((e) => e.id), failedPart: created.length + 1, total: parts.length },
        )
      }
    }

    const first = created[0]
    if (created.length > 1) {
      first.split = true
      first.parts = created.slice(1).map((e) => e.id)
      info(`[cs-bots/memory] add：内容 ${cpLength(text)} 码点 > ${entryMax} 上限 → 无损切分为 ${created.length} 条（首条 ${first.id}）`)
    }
    return first
  }

  /**
   * 按 id 做 CAS 变更。**rev 不匹配即抛错，绝不静默覆盖**。
   *
   * 规定 2 的硬闸门：目标条目 `explicit:true` 而本次调用未带 `explicit:true` →
   * 抛 `MEMORY_EXPLICIT_PROTECTED`（并指向 `review()`）。
   *
   * @param {{ layer: string, id: string, expectedRev: number, content?: string, tags?: string[],
   *           cwd?: string, explicit?: boolean, by: string, now?: number }} input
   * @returns {object} 变更后的 Entry
   */
  function update(input = {}) {
    const { layer, id, expectedRev, content, tags, explicit, by, now, cwd } = input ?? {}
    const targetLayer = requireLayer(layer, 'update')
    assertNotPersonaLayer(targetLayer, 'update')
    const author = requireString(by, 'by', 'update')
    const current = requireEntry(id, targetLayer, 'update')

    if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev)) {
      throw new MemoryError(
        `memory.update：expectedRev 必须是整数（CAS 需要显式期望版本；条目 ${current.id} 当前 rev=${current.rev}，`
        + `收到 ${JSON.stringify(expectedRev)}）`,
        'MEMORY_BAD_FIELD',
        { field: 'expectedRev', id: current.id, rev: current.rev },
      )
    }
    if (current.rev !== expectedRev) {
      throw new MemoryError(
        `memory.update CAS 冲突：条目 [id:${current.id}] 期望 rev=${expectedRev}，实际 rev=${current.rev} —— `
        + '拒绝静默覆盖，请重新 get() 后按最新 rev 重试',
        'MEMORY_CAS_CONFLICT',
        { id: current.id, layer: targetLayer, expectedRev, rev: current.rev },
      )
    }
    if (current.archived) {
      throw new MemoryError(
        `memory.update：条目 [id:${current.id}] 已归档（reason=${current.archived.reason ?? 'n/a'}），需先 restore() 才能改`,
        'MEMORY_ENTRY_ARCHIVED',
        { id: current.id, layer: targetLayer },
      )
    }
    if (current.explicit === true && explicit !== true) {
      throw new MemoryError(
        `memory.update：条目 [id:${current.id}] 是 explicit（人显式说的），本次调用未带 explicit:true —— `
        + '规定 2：review 只能建议不能改，请改用 review()（它会返回建议而不落盘）',
        'MEMORY_EXPLICIT_PROTECTED',
        { id: current.id, layer: targetLayer, hint: 'use review()' },
      )
    }
    // 到这里已过 explicit 闸门；本调用是**显式工具直写**（规定 4 的最高优先级）
    assertWriteAllowed(current, 'explicit', 'update')

    const at = normalizeNow(now, 'update')
    // cwd 重新归属：不传 = 保持原归属（clone 已带上）；传了 = 归一化后覆盖。
    // 注意这里**不清理**旧 cwd 字段 —— 显式「清空归属」没有对应语义（要改归属就传新路径，
    // 回到「未归属」状态只能靠手改数据，避免一次误传把条目打回谁都看不见的状态）。
    const nextCwd = cwdForWrite(targetLayer, cwd, 'update')
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.updatedAt = at
    next.updatedBy = author
    if (explicit === true) next.explicit = true
    if (nextCwd !== undefined) next.cwd = nextCwd
    if (content !== undefined && content !== null) {
      const text = requireString(content, 'content', 'update')
      if (cpLength(text) > entryMax) {
        throw new MemoryError(
          `memory.update：内容超长（${cpLength(text)} > ${entryMax} 码点上限）—— update 是单条 CAS 无法切分，`
          + '请用 add()（它会自动无损切分）或先自行拆分',
          'MEMORY_ENTRY_TOO_LONG',
          { length: cpLength(text), max: entryMax, id: current.id },
        )
      }
      next.content = text
    }
    if (tags !== undefined) next.tags = stringList(tags, 'tags', 'update')
    return commit(current.id, 'update', author, at, before, next)
  }

  /**
   * 删除 = **归档**（规定：不物理删，可恢复）。
   * @param {{ layer: string, id: string, expectedRev: number, by: string, reason?: string, now?: number }} input
   * @returns {object} 归档后的 Entry
   */
  function remove(input = {}) {
    const { layer, id, expectedRev, by, reason, now } = input ?? {}
    return doArchive({ layer, id, expectedRev, by, reason: reason ?? 'removed', now, action: 'remove' })
  }

  /**
   * 归档（同 `remove`，语义上更强调「不是删除」）。
   * @param {{ layer: string, id: string, by: string, reason?: string, expectedRev?: number, now?: number }} input
   * @returns {object} 归档后的 Entry
   */
  function archive(input = {}) {
    const { layer, id, by, reason, expectedRev, now } = input ?? {}
    return doArchive({ layer, id, expectedRev, by, reason: reason ?? 'manual-archive', now, action: 'archive' })
  }

  /**
   * 归档实现。`expectedRev` 给了就强制 CAS；没给也**必须**在已归档时抛错（不静默重复归档）。
   * @param {{ layer: string, id: string, expectedRev?: number, by: string, reason: string, now?: number, action: string }} input
   * @returns {object}
   */
  function doArchive(input) {
    const { layer, id, expectedRev, by, reason, now, action } = input
    const targetLayer = requireLayer(layer, action)
    assertNotPersonaLayer(targetLayer, action)
    const author = requireString(by, 'by', action)
    const current = requireEntry(id, targetLayer, action)
    const why = requireString(reason, 'reason', action)

    if (expectedRev !== undefined && expectedRev !== null) {
      if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev)) {
        throw new MemoryError(
          `memory.${action}：expectedRev 必须是整数（收到 ${JSON.stringify(expectedRev)}）`,
          'MEMORY_BAD_FIELD',
          { field: 'expectedRev', id: current.id },
        )
      }
      if (current.rev !== expectedRev) {
        throw new MemoryError(
          `memory.${action} CAS 冲突：条目 [id:${current.id}] 期望 rev=${expectedRev}，实际 rev=${current.rev} —— 拒绝静默覆盖`,
          'MEMORY_CAS_CONFLICT',
          { id: current.id, expectedRev, rev: current.rev },
        )
      }
    }
    if (current.archived) {
      throw new MemoryError(
        `memory.${action}：条目 [id:${current.id}] 已于 ${new Date(current.archived.at).toISOString()} 归档`
        + `（reason=${current.archived.reason ?? 'n/a'}）—— 拒绝静默重复归档`,
        'MEMORY_ALREADY_ARCHIVED',
        { id: current.id, archived: current.archived },
      )
    }
    assertWriteAllowed(current, 'explicit', action)

    const at = normalizeNow(now, action)
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.updatedAt = at
    next.updatedBy = author
    next.archived = { by: author, at, reason: why }
    return commit(current.id, action, author, at, before, next)
  }

  /**
   * **彻底删除**（purge）——与 `remove`（软删除，进归档区可恢复）的区别：
   *   - `remove` = 归档，`archived.reason='removed'`，列表不可见但**可恢复**，可追溯；
   *   - `purge`  = 真删，条目从内存与快照中移除，**不可恢复**；事件流只留一条
   *     `after:null` 的墓碑，记录「谁在什么时候删了什么」，审计不丢、内容不留。
   *
   * 为什么两者都要有：`remove` 是对用户的保护（误删可救），`purge` 是对用户的
   * 承诺（说删就真的删 —— 比如密钥/口令误写进记忆时必须能彻底清掉）。
   * 只有 `remove` 时用户会遇到「删了还在归档区躺着」；只有 `purge` 时误删无从挽回。
   *
   * 仍然禁止 L0：人格层只允许人改，删除同样要人显式发起（by 必填）。
   *
   * @param {{ layer: string, id: string, by: string, expectedRev?: number, now?: number }} input
   * @returns {object} 被删除的条目（删除前的样子，供 UI 回显）
   */
  function purge(input = {}) {
    const { layer, id, by, expectedRev, now } = input ?? {}
    const targetLayer = requireLayer(layer, 'purge')
    assertNotPersonaLayer(targetLayer, 'purge')
    const author = requireString(by, 'by', 'purge')
    const current = requireEntry(id, targetLayer, 'purge')

    if (expectedRev !== undefined && expectedRev !== null) {
      if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev)) {
        throw new MemoryError(
          `memory.purge：expectedRev 必须是整数（收到 ${JSON.stringify(expectedRev)}）`,
          'MEMORY_BAD_FIELD',
          { field: 'expectedRev', id: current.id },
        )
      }
      if (current.rev !== expectedRev) {
        throw new MemoryError(
          `memory.purge CAS 冲突：条目 [id:${current.id}] 期望 rev=${expectedRev}，实际 rev=${current.rev} —— 拒绝误删`,
          'MEMORY_CAS_CONFLICT',
          { id: current.id, expectedRev, rev: current.rev },
        )
      }
    }

    const at = normalizeNow(now, 'purge')
    const event = {
      id: current.id,
      layer: targetLayer,
      rev: current.rev + 1,
      action: 'purge',
      byId: author,
      at,
      before: clone(current),
      after: null,
    }
    if (!appendJsonl(jsonlPath, event)) {
      throw new MemoryError(
        `memory.purge：事件追加失败（${jsonlPath}）——拒绝「只改内存不落盘」`,
        'MEMORY_APPEND_FAILED',
        { id: current.id, action: 'purge' },
      )
    }
    entries.delete(current.id)
    events.push(event)
    // 全文索引重建：purge 是低频操作，整体重建比增量删除更不容易出错
    try { indexRebuild() } catch { /* 索引失败不影响正确性，检索会退化 */ }
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/memory] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可完整恢复`)
    }
    return clone(current)
  }

  /**
   * 从归档恢复（与 `remove`/`archive` 构成往返一致）。归档不是删除，恢复后原文照旧。
   * @param {{ layer: string, id: string, by?: string, now?: number }} input
   * @returns {object} 恢复后的 Entry
   */
  function restore(input = {}) {
    const { layer, id, by, now } = input ?? {}
    const targetLayer = requireLayer(layer, 'restore')
    assertNotPersonaLayer(targetLayer, 'restore')
    const current = requireEntry(id, targetLayer, 'restore')
    if (!current.archived) {
      throw new MemoryError(
        `memory.restore：条目 [id:${current.id}] 未处于归档状态，无需恢复 —— 拒绝静默空操作`,
        'MEMORY_NOT_ARCHIVED',
        { id: current.id, layer: targetLayer },
      )
    }
    const author = by === undefined || by === null ? 'human' : requireString(by, 'by', 'restore')
    const at = normalizeNow(now, 'restore')
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.updatedAt = at
    next.updatedBy = author
    delete next.archived
    delete next.mergedInto
    return commit(current.id, 'restore', author, at, before, next)
  }

  // ── API：review（规定 2 的主战场）────────────────────────────────────────────

  /**
   * 自动 review：**只对非 explicit 条目生效**；碰到 explicit 条目**只返回建议、不改写**（规定 2）。
   *
   * `proposed` 每项：
   *   - 带 `id`：定位该条目；explicit → 建议；否则 CAS 改内容（source='review'）。
   *   - 不带 `id`：按签名匹配既有条目（explicit 优先给建议），匹配不到则新增（source='review'）。
   *
   * @param {{ layer: string, proposed: object|object[], by: string, now?: number }} input
   * @returns {{ layer: string, applied: object[], suggested: object[], rejected: object[], results: object[] }}
   */
  function review(input = {}) {
    const { layer, proposed, by, now } = input ?? {}
    const targetLayer = requireLayer(layer, 'review')
    assertNotPersonaLayer(targetLayer, 'review')
    const author = requireString(by, 'by', 'review')
    const items = Array.isArray(proposed) ? proposed : (proposed === undefined ? [] : [proposed])
    if (items.length === 0) {
      throw new MemoryError(
        'memory.review：proposed 为空 —— 无内容可 review（拒绝静默空转）',
        'MEMORY_MISSING_FIELD',
        { field: 'proposed', layer: targetLayer },
      )
    }

    const results = []
    const applied = []
    const suggested = []
    const rejected = []

    for (const raw of items) {
      const item = raw ?? {}
      const content = requireString(item.content, 'content', 'review')
      const at = normalizeNow(item.now ?? now, 'review')

      /** 定位目标：显式 id 优先，否则按签名匹配 */
      /** @type {object|undefined} */
      let target
      if (item.id !== undefined && item.id !== null) {
        target = requireEntry(item.id, targetLayer, 'review')
      } else {
        const sig = signatureOf(content)
        target = [...entries.values()].find(
          (e) => e.layer === targetLayer && !e.archived && signatureOf(e.content) === sig,
        )
      }

      if (!target) {
        // cwd 透传：review 若带着项目上下文来（`item.cwd`），新增条目就归属该项目；
        // 不带则保持「未归属」——**故意不猜**（猜错归属比不归属更糟，见 cwdVisible 注释）。
        // 注意：更新既有条目时**不**透传 cwd —— review 按内容签名匹配，命中可能是别的项目的
        // 同文条目，跟着当前 cwd 改写会把记忆静默搬到另一个项目去。
        const created = add({
          layer: targetLayer,
          content,
          by: author,
          source: 'review',
          tags: item.tags,
          cwd: item.cwd,
          now: at,
        })
        const row = { action: 'added', id: created.id, rev: created.rev }
        results.push(row)
        applied.push(row)
        continue
      }

      if (target.archived) {
        const row = {
          action: 'rejected',
          id: target.id,
          code: 'MEMORY_ENTRY_ARCHIVED',
          reason: '目标条目已归档，review 不改归档内容；如需恢复请 restore()',
          current: target.content,
        }
        results.push(row)
        rejected.push(row)
        continue
      }

      // ★ 规定 2：explicit 条目只给建议，**不写盘**
      if (target.explicit === true) {
        const row = {
          action: 'suggest',
          id: target.id,
          layer: targetLayer,
          rev: target.rev,
          current: target.content,
          suggested: content,
          reason: 'explicit 条目是人显式写的，review 只能建议不能改（规定 2）',
        }
        results.push(row)
        suggested.push(row)
        info(`[cs-bots/memory] review：命中 explicit 条目 ${target.id} → 仅返回建议，未改写`)
        continue
      }

      /**
       * 单条失败的处置：**整批不中断，但绝不静默**。
       * review 是批量 pass，一条撞上优先级/归档等闸门不该让其余条目全不处理；
       * 失败以 `action:'rejected'` + 原始 code 出现在返回里（可见 = 合规）。
       */
      try {
        assertWriteAllowed(target, 'review', 'review')
        const updated = update({
          layer: targetLayer,
          id: target.id,
          expectedRev: target.rev,
          content,
          by: author,
          tags: item.tags,
          now: at,
        })
        const row = { action: 'updated', id: updated.id, rev: updated.rev, from: target.content, to: updated.content }
        results.push(row)
        applied.push(row)
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error
        const row = {
          action: 'rejected',
          id: target.id,
          rev: target.rev,
          code: error.code,
          reason: error.message,
          current: target.content,
          suggested: content,
        }
        results.push(row)
        rejected.push(row)
        warn(`[cs-bots/memory] review 跳过 ${target.id}：${error.code} —— ${error.message}`)
      }
    }

    if (applied.length > 0 || suggested.length > 0) {
      info(`[cs-bots/memory] review(${targetLayer})：改 ${applied.length} 条 / 建议 ${suggested.length} 条 / 拒 ${rejected.length} 条`)
    }
    return { layer: targetLayer, by: author, applied, suggested, rejected, results }
  }

  // ── API：consolidate（规定 3 与 4）─────────────────────────────────────────────

  /**
   * 后台合并：**重复**合并（被并方归档、保留 `mergedInto` 证据）；
   * **矛盾**两条都留并标 `[conflict]`（规定 3）；**explicit 条目一律不动**，只给建议（规定 2/4）。
   *
   * 判定顺序**不可颠倒**：先判冲突（极性相反），再判重复（归一后全等）。
   * 否则 `使用 pnpm` 与 `不使用 pnpm` 会被当成重复合并掉，那正是规定 3 要禁止的静默冲突消除。
   *
   * @param {{ layer: string, by: string, conflicts?: Array<[string,string]>, daily?: boolean, now?: number }} input
   * @returns {{ layer: string, scanned: number, merged: object[], conflicts: object[], suggested: object[], unchanged: number, dailyId: string|null }}
   */
  function consolidate(input = {}) {
    const { layer, by, conflicts, daily, now } = input ?? {}
    const targetLayer = requireLayer(layer, 'consolidate')
    assertNotPersonaLayer(targetLayer, 'consolidate')
    const author = requireString(by, 'by', 'consolidate')
    const at = normalizeNow(now, 'consolidate')

    const live = [...entries.values()].filter((e) => e.layer === targetLayer && !e.archived)
    const merged = []
    const conflictRows = []
    const suggested = []
    const rejectedConflicts = []
    /** @type {Set<string>} 已被本次处理的 id（避免同一条被合并两次） */
    const handled = new Set()

    /**
     * 冲突集**传递闭包**：矛盾关系是「同题反主张」，它天然成团。
     * 例如 `用 pnpm` / `不用 pnpm` / `用 pnpm`（重复）三条里，
     * 前两条矛盾、后两条只差重复 —— 团内每条都该与**其余冲突成员**互标，
     * 否则 `不用 pnpm` 那条看起来「只跟一份副本冲突」，另一份副本仍是干净态，
     * 注入时读者会以为它没争议。故对团取闭包，一次把团内两两全部登记。
     * @param {Array<[string, string]>} edges 已确认的矛盾边（id 对）
     * @returns {Array<[string, string]>} 闭包后的边（去重、无自环）
     */
    function closeConflictEdges(edges) {
      const adj = new Map()
      const add = (x, y) => {
        if (!adj.has(x)) adj.set(x, new Set())
        adj.get(x).add(y)
      }
      for (const [x, y] of edges) {
        if (x === y) continue
        add(x, y)
        add(y, x)
      }
      const out = []
      const seen = new Set()
      const nodes = [...adj.keys()]
      for (const start of nodes) {
        // 该连通分量（BFS）
        const comp = new Set([start])
        const queue = [start]
        while (queue.length > 0) {
          const cur = queue.pop()
          for (const nxt of adj.get(cur) ?? []) {
            if (!comp.has(nxt)) { comp.add(nxt); queue.push(nxt) }
          }
        }
        const members = [...comp].sort()
        for (let i = 0; i < members.length; i += 1) {
          for (let j = i + 1; j < members.length; j += 1) {
            const key = `${members[i]}|${members[j]}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push([members[i], members[j]])
          }
        }
      }
      return out
    }

    /**
     * 把最终态 = **每一个连通分量内全量两两标记**。
     * 逐边 apply 会退化成「最后一次调用胜出」的半截态（实测踩到），
     * 故这里按分量算**最终 marked 集合**，再逐条按当前 rev 落盘。
     *
     * @param {Array<[object, object, string]>} pairList 已确认的矛盾对
     * @returns {object[]} conflictRows
     */
    function applyConflictClosure(pairList) {
      const rows = []
      const edges = pairList.map(([a, b]) => [a.id, b.id])
      const closedEdges = closeConflictEdges(edges)

      /** 分量成员 id → 该成员应登记的 conflictWith 全集合 */
      const want = new Map()
      for (const [x, y] of closedEdges) {
        if (!want.has(x)) want.set(x, new Set())
        if (!want.has(y)) want.set(y, new Set())
        want.get(x).add(y)
        want.get(y).add(x)
      }
      /** 原因：取该成员参与的第一条边的判定来源（declared 优先，便于人回溯） */
      const reasonOf = new Map()
      for (const [a, b, how] of pairList) {
        const label = how === 'declared' ? 'declared-conflict' : 'polarity-conflict'
        for (const id of [a.id, b.id]) {
          if (!reasonOf.has(id) || label === 'declared-conflict') reasonOf.set(id, label)
        }
      }

      for (const [id, withSet] of want) {
        const cur = entries.get(id)
        if (!cur) {
          rows.push({
            action: 'rejected', id, code: 'MEMORY_ENTRY_NOT_FOUND',
            reason: '冲突闭包的成员在处理过程中已不存在 → 跳过并回报（不写半截）',
          })
          continue
        }
        const missing = [...withSet].filter((x) => !(Array.isArray(cur.conflictWith) && cur.conflictWith.includes(x)))
        if (missing.length === 0 && cur.conflict === true) continue // 已是最新，幂等
        const bad = checkWritable(cur, 'consolidate')
        if (bad) {
          rows.push({ action: 'rejected', id, code: bad.code, reason: `冲突闭包成员不可改写 → 跳过：${bad.message}` })
          warn(`[cs-bots/memory] consolidate：冲突闭包跳过 ${id}：${bad.message}`)
          continue
        }
        try {
          const next = commit(
            id,
            'consolidate',
            author,
            at,
            clone(cur),
            conflictMarkNext(cur, [...withSet], author, at, reasonOf.get(id) ?? 'conflict-closure'),
          )
          rows.push({ a: id, conflictWith: next.conflictWith, rev: next.rev, kind: 'marked' })
        } catch (error) {
          if (!(error instanceof MemoryError)) throw error
          rows.push({ action: 'rejected', id, code: error.code, reason: error.message })
          warn(`[cs-bots/memory] consolidate：冲突闭包写 ${id} 失败：${error.message}`)
        }
      }
      return rows
    }

    // ── 第 1 步：冲突判定（先于去重）─────────────────────────────────────────
    /** 外部显式声明的矛盾对（检测器判不出时由 review/人补） */
    const declared = Array.isArray(conflicts) ? conflicts : []
    /** @type {Array<[object, object, string]>} */
    const pairs = []
    for (const pair of declared) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new MemoryError(
          `memory.consolidate：conflicts 每项必须是 [idA, idB]，收到 ${JSON.stringify(pair)}`,
          'MEMORY_BAD_FIELD',
          { field: 'conflicts' },
        )
      }
      pairs.push([
        requireEntry(pair[0], targetLayer, 'consolidate'),
        requireEntry(pair[1], targetLayer, 'consolidate'),
        'declared',
      ])
    }
    const bySignature = new Map()
    for (const e of live) {
      const sig = signatureOf(e.content)
      if (!bySignature.has(sig)) bySignature.set(sig, [])
      bySignature.get(sig).push(e)
    }
    for (const [, group] of bySignature) {
      if (group.length < 2) continue
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i]
          const b = group[j]
          const pa = polarityOf(a.content)
          const pb = polarityOf(b.content)
          if (pa.neg !== pb.neg) pairs.push([a, b, 'polarity'])
        }
      }
    }

    for (const [a, b, how] of pairs) {
      if (a.id === b.id) continue
      if (isConflicted(a, b)) {
        conflictRows.push({ a: a.id, b: b.id, how, already: true })
        continue
      }
      if (a.explicit === true || b.explicit === true) {
        // 规定 2/4：explicit 条目不动，只建议
        const row = {
          action: 'suggest',
          conflict: [a.id, b.id],
          reason: '其中含 explicit 条目，consolidate 不得改写，只能建议（规定 2/4）',
          a: { id: a.id, content: a.content },
          b: { id: b.id, content: b.content },
        }
        suggested.push(row)
        continue
      }

      /**
       * **先查可写性再落盘**：宁可整对跳过，也不留「只标了一边」的半截冲突态。
       * （另一条路是标完再回滚，但回滚本身要写两个事件，净效果更乱、更难审计。）
       * 跳过原因以 `action:'rejected'` + code 出现在返回里 —— 可见即合规，绝不静默。
       */
      const blocked = [a, b].map((e) => checkWritable(e, 'consolidate')).find((r) => r !== null)
      if (blocked) {
        const row = {
          action: 'rejected',
          a: a.id,
          b: b.id,
          code: blocked.code,
          reason: `冲突对含不可由 consolidate 改写的条目（${blocked.id}）→ 整对跳过并回报，不标半截：${blocked.message}`,
        }
        conflictRows.push(row)
        rejectedConflicts.push(row)
        warn(`[cs-bots/memory] consolidate：${row.reason}`)
        continue
      }

      const pa = markConflict(a, [b.id], author, at, how === 'declared' ? 'declared-conflict' : 'polarity-conflict')
      const pb = markConflict(b, [a.id], author, at, how === 'declared' ? 'declared-conflict' : 'polarity-conflict')
      conflictRows.push({ a: pa.id, b: pb.id, aRev: pa.rev, bRev: pb.rev, how })
      handled.add(a.id)
      handled.add(b.id)
      info(`[cs-bots/memory] consolidate：检测到矛盾 ${a.id} ⇄ ${b.id}（${how}）→ 两条都留并标 [conflict]（规定 3）`)
    }

    // ── 第 2 步：重复合并（归一后全等；已被判为冲突的 id 不再参与）────────────
    const byDup = new Map()
    for (const e of live) {
      if (handled.has(e.id)) continue
      const key = dupKeyOf(e.content)
      if (!byDup.has(key)) byDup.set(key, [])
      byDup.get(key).push(e)
    }
    for (const [, group] of byDup) {
      if (group.length < 2) continue
      // 保留规则：等级高者 → 更新时间新者 → id 小者（确定性，不靠遍历顺序）
      const sorted = group.slice().sort((x, y) => {
        const r = protectionOf(y) - protectionOf(x)
        if (r !== 0) return r
        const t = (y.updatedAt ?? 0) - (x.updatedAt ?? 0)
        if (t !== 0) return t
        return x.id < y.id ? -1 : 1
      })
      const keeper = sorted[0]
      if (keeper.explicit === true || group.some((e) => e.explicit === true)) {
        const row = {
          action: 'suggest',
          duplicates: group.map((e) => e.id),
          reason: '重复组中含 explicit 条目，consolidate 不得合并，只能建议（规定 2/4）',
          keepSuggestion: keeper.id,
        }
        suggested.push(row)
        continue
      }
      /** 与冲突分支同款纪律：**先查可写性**，保证 keeper 一定留得住、被并方一定过得去。 */
      const keepBlocked = checkWritable(keeper, 'consolidate')
      const losers = sorted.slice(1).filter((e) => checkWritable(e, 'consolidate') === null)
      const losersBlocked = sorted.slice(1).filter((e) => !losers.includes(e))
      if (keepBlocked || losers.length === 0) {
        const row = {
          action: 'rejected',
          duplicates: group.map((e) => e.id),
          code: keepBlocked?.code ?? 'MEMORY_WRITE_PRIORITY_DENIED',
          reason: '重复组中保留者不可由 consolidate 改写 → 整组不合并，只回报（绝不静默消失）',
        }
        suggested.push(row)
        warn(`[cs-bots/memory] consolidate：${row.reason}（组：${row.duplicates.join(', ')}）`)
        continue
      }
      if (losersBlocked.length > 0) {
        const row = {
          action: 'suggest',
          duplicates: group.map((e) => e.id),
          keepSuggestion: keeper.id,
          unmergeable: losersBlocked.map((e) => e.id),
          reason: '部分重复条目不可由 consolidate 改写 → 只合并可动的那几条，其余留原样',
        }
        suggested.push(row)
      }
      for (const loser of losers) {
        const archived = mergeAway(loser, keeper.id, author, at)
        merged.push({ kept: keeper.id, archived: archived.id, rev: archived.rev, content: loser.content })
        handled.add(loser.id)
        info(`[cs-bots/memory] consolidate：重复合并 ${loser.id} → ${keeper.id}（被并方已归档，保留 mergedInto 证据）`)
      }
    }

    // ── 第 3 步：可选写 L5 日札（§3.4：L5 的写入者是后台 consolidate）──────────
    let dailyId = null
    if (daily === true) {
      const digest = `consolidate ${targetLayer}：扫描 ${live.length} 条；合并 ${merged.length} 条；`
        + `矛盾 ${conflictRows.length} 对（均已保留并标 [conflict]）；建议 ${suggested.length} 条；`
        + `拒 ${rejectedConflicts.length} 对；未变动 ${live.length - handled.size}`
      // ⚠️ L5 的 source 必须是 consolidate —— 规定 4 靠 source 机械排序，
      //    若这里误用默认的 explicit，日札会被当成「人显式说的」而不可再动。
      const created = add({ layer: 'L5', content: digest, by: author, source: 'consolidate', now: at })
      dailyId = created.id
    }

    return {
      layer: targetLayer,
      scanned: live.length,
      merged,
      conflicts: conflictRows,
      suggested,
      rejectedConflicts,
      unchanged: live.length - handled.size,
      dailyId,
    }
  }

  /** 撤销一次冲突标记（只回滚本次刚加的那一边，**不碰**此前的 conflictWith 集合）。 */
  function unmarkConflict(entry, dropIds, author, at, reason) {
    const before = clone(entry)
    const next = clone(entry)
    next.rev = entry.rev + 1
    next.updatedAt = at
    next.updatedBy = author
    next.conflictWith = (Array.isArray(entry.conflictWith) ? entry.conflictWith : []).filter((x) => !dropIds.includes(x))
    if (next.conflictWith.length === 0) {
      delete next.conflict
      delete next.conflictReason
      next.tags = (Array.isArray(entry.tags) ? entry.tags : []).filter((t) => t !== 'conflict')
    }
    next.rollbackReason = reason
    return commit(entry.id, 'consolidate', author, at, before, next)
  }

  /** two-step 重试（保证「成对」或「都不标」）。 */
  const SETTLE_MAX_RETRY = 3
  const SETTLE_RETRY_WAIT_MS = 1

  /**
   * **成对**完成一次双条目变更（规定 3 的机械保证）。
   *
   * 为什么不能边算边写：做「两条都留并标 [conflict]」时，第二条可能临场失败
   * （并发下 rev 变了、或者某条是 explicit 的硬保护条目）。若第一条已落盘，
   * 内存里就留下**只标了一边**的半截冲突态 —— 那正是规定 3「冲突不静默」要防的东西。
   *
   * 本函数按**两遍**走：第一遍 plan（只读、不落盘、不产生副作用），第二遍 exec。
   * exec 里若**第一条**就失败 ⇒ 什么都没写，抛错即可；若**第二条**失败 ⇒ 重跑 plan
   * 后再 exec（把第一条的新 rev 兜进来），直到两条都成或重试耗尽。
   * 重试耗尽仍不成 ⇒ 抛**合成**错误（声称配对失败），重放后状态是一致可解释的。
   *
   * @param {() => Array<{ check: () => ({ ok: true } | { ok: false, reason: string }), run: () => object }>} plan
   * @param {string} what 失败信息里的动作名
   * @returns {object[]} 两条变更后的条目
   */
  function settlePair(plan, what) {
    let lastReason = 'unknown'
    for (let attempt = 1; attempt <= SETTLE_MAX_RETRY; attempt += 1) {
      const ops = plan()
      if (ops.length !== 2) {
        throw new MemoryError(
          `memory：${what} 的 settlePair 必须恰好得到 2 项操作，收到 ${ops.length}`,
          'MEMORY_INTERNAL_INVARIANT',
          { what },
        )
      }
      const blocked = ops.map((op) => op.check()).find((r) => r && r.ok === false)
      if (blocked) {
        throw new MemoryError(
          `memory：${what} 不可执行 —— ${blocked.reason}`,
          'MEMORY_WRITE_PRIORITY_DENIED',
          { what, reason: blocked.reason },
        )
      }
      try {
        return [ops[0].run(), ops[1].run()]
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error
        lastReason = `${error.code}: ${error.message}`
        warn(`[cs-bots/memory] ${what} 第 ${attempt}/${SETTLE_MAX_RETRY} 次尝试第二条失败，将重试：${lastReason}`)
        if (attempt < SETTLE_MAX_RETRY) sleepSync(SETTLE_RETRY_WAIT_MS)
      }
    }
    throw new MemoryError(
      `memory：${what} 配对失败（已重试 ${SETTLE_MAX_RETRY} 次）—— 最后原因：${lastReason}。`
      + '本次未留下半截状态；请重新 list() 后重试',
      'MEMORY_PAIR_SETTLE_FAILED',
      { what, attempts: SETTLE_MAX_RETRY },
    )
  }

  /** 极短同步等待（仅用于配对重试的退避；不依赖任何第三方库）。 */
  function sleepSync(ms) {
    const end = Date.now() + ms
    // eslint-disable-next-line no-empty
    while (Date.now() < end) { /* busy-wait：毫秒级，且只在罕见的重试路径上发生 */ }
  }

  /** 两条是否已互相标记为冲突（幂等，避免重复写事件）。 */
  function isConflicted(a, b) {
    return a.conflict === true && b.conflict === true
      && Array.isArray(a.conflictWith) && a.conflictWith.includes(b.id)
      && Array.isArray(b.conflictWith) && b.conflictWith.includes(a.id)
  }

  /**
   * 非抛错的「可写性预检」：批量操作（consolidate）先用它整对判断，
   * 避免「标了一半才发现另一边不可写」。单条 API 仍用 `assertWriteAllowed` 直接抛。
   * @param {object} entry
   * @param {'explicit'|'review'|'consolidate'} writer
   * @returns {{ code: string, id: string, message: string } | null} null = 可写
   */
  function checkWritable(entry, writer) {
    try {
      assertWriteAllowed(entry, writer, 'consolidate')
      return null
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error
      return { code: error.code, id: entry.id, message: error.message }
    }
  }

  /**
   * 计算「标 `[conflict]`」的下一步形态（**纯函数，不落盘**）。
   *
   * 为什么要拆出纯函数：`settlePair` 需要先 plan（只读）后 exec（落盘）两遍，
   * 而 plan 必须**用最新 rev** —— 直接读内存态即可，不产生任何副作用。
   * @param {object} entry
   * @param {string[]} withIds
   * @param {string} author
   * @param {number} at
   * @param {string} reason
   * @returns {object} next（未落盘的下一版）
   */
  function conflictMarkNext(entry, withIds, author, at, reason) {
    const next = clone(entry)
    next.rev = entry.rev + 1
    next.updatedAt = at
    next.updatedBy = author
    next.conflict = true
    const set = new Set([...(Array.isArray(entry.conflictWith) ? entry.conflictWith : []), ...withIds])
    next.conflictWith = [...set]
    next.conflictReason = reason
    const tags = new Set([...(Array.isArray(entry.tags) ? entry.tags : []), 'conflict'])
    next.tags = [...tags]
    return next
  }

  /** 标 `[conflict]`（不删内容）—— **单条**落盘；成对场景走 `settleConflictPair`。 */
  function markConflict(entry, withIds, author, at, reason) {
    assertWriteAllowed(entry, 'consolidate', 'consolidate')
    return commit(entry.id, 'consolidate', author, at, clone(entry), conflictMarkNext(entry, withIds, author, at, reason))
  }

  /**
   * **规定 3 的核心动作**：把两条矛盾记忆都标 `[conflict]` 并互相登记 `conflictWith`，
   * 内容一条都不删。走 `settlePair` 保证「成对成功」——不留半截冲突态。
   *
   * @param {string} idA
   * @param {string} idB
   * @param {string} author
   * @param {number} at
   * @param {string} reason
   * @returns {object[]} [a', b']
   */
  function settleConflictPair(idA, idB, author, at, reason) {
    return settlePair(() => {
      const a = entries.get(idA)
      const b = entries.get(idB)
      if (!a || !b) {
        throw new MemoryError(
          `memory.consolidate：冲突对 ${idA} ⇄ ${idB} 的成员已不存在 —— 拒绝写半截`,
          'MEMORY_ENTRY_NOT_FOUND',
          { idA, idB },
        )
      }
      return [
        {
          check: () => {
            const bad = checkWritable(a, 'consolidate')
            return bad ? { ok: false, reason: `冲突方 ${a.id} 不可改写：${bad.message}` } : { ok: true }
          },
          run: () => commit(a.id, 'consolidate', author, at, clone(a), conflictMarkNext(a, [b.id], author, at, reason)),
        },
        {
          check: () => {
            const bad = checkWritable(entries.get(idB) ?? b, 'consolidate')
            return bad ? { ok: false, reason: `冲突方 ${b.id} 不可改写：${bad.message}` } : { ok: true }
          },
          run: () => {
            // ⚠️ 必须在 run 时重新取内存态：第一条已经 +1 rev（CAS 依据由此保持正确）
            const cur = entries.get(idB)
            const bad = checkWritable(cur, 'consolidate')
            if (bad) {
              throw new MemoryError(bad.message, bad.code, { id: cur.id, layer: cur.layer })
            }
            return commit(cur.id, 'consolidate', author, at, clone(cur), conflictMarkNext(cur, [idA], author, at, reason))
          },
        },
      ]
    }, `consolidate 冲突配对 ${idA} ⇄ ${idB}`)
  }

  /** 重复合并：被并方**归档**（不物理删），带 `mergedInto` 证据。 */
  function mergeAway(loser, keeperId, author, at) {
    assertWriteAllowed(loser, 'consolidate', 'consolidate')
    const before = clone(loser)
    const next = clone(loser)
    next.rev = loser.rev + 1
    next.updatedAt = at
    next.updatedBy = author
    next.mergedInto = keeperId
    next.archived = { by: author, at, reason: 'merged-duplicate' }
    return commit(loser.id, 'consolidate', author, at, before, next)
  }

  // ── API：读 ───────────────────────────────────────────────────────────────

  /**
   * 按 id 取单条（规定 1：**按 id 定位**）。
   * @param {{ layer: string, id: string }} input
   * @returns {object} Entry
   */
  function get(input = {}) {
    const { layer, id } = input ?? {}
    const targetLayer = requireLayer(layer, 'get')
    return clone(requireEntry(id, targetLayer, 'get'))
  }

  /**
   * 列出条目。
   *
   * `cwd` 语义（见文件头「cwd 作用域」）：
   *   - **不传 / `null`** → 与改造前完全一致（返回全部，含未归属与他项目条目）；
   *   - **传具体路径** → 全局条目（L0/L1/L2）+ 该 cwd 的 L3/L4/L5；其他 cwd 与
   *     **未归属项目的**老条目都不返回（故意，见 `cwdVisible`）；
   *   - **传 `'*'`** → 全部（UI「全部项目」视图）。
   *
   * @param {{ layer?: string, branch?: string, limit?: number, query?: string,
   *           includeArchived?: boolean, onlyArchived?: boolean, botId?: string,
   *           cwd?: string }} [options]
   * @returns {object[]}
   */
  function list(options = {}) {
    // ⚠️ 修复（2026-11-04 测试，P1-3）：list/search 之前不按 botId 过滤，
    //   Bot 私有记忆对任何 API 调用者可见（与「只在那个 Bot 的 contextFor 里出现」
    //   的注释自相矛盾）。现在与 contextFor 口径一致：
    //   ① 传 botId → 只见该 Bot 的私有记忆（可见的可见性，不静默泄露）；
    //   ② 不传 botId → 只见非私有（无 botId）的记忆。
    const { layer, branch, limit, query, includeArchived, onlyArchived, botId, cwd } = options ?? {}
    const targetLayer = layer === undefined || layer === null ? undefined : requireLayer(layer, 'list')
    const lim = optionalLimit(limit, 'list')
    const q = optionalString(query, 'query', 'list')
    // 先归一化（非法 cwd 早失败，避免「查了半天才报错」）
    const targetCwd = normalizeCwdFilter(cwd, 'list')

    let rows = [...entries.values()]
    if (botId !== undefined && botId !== null && botId !== '') {
      const bid = requireString(botId, 'botId', 'list')
      rows = rows.filter((e) => e.botId === bid)
    } else {
      rows = rows.filter((e) => !e.botId)
    }
    if (targetCwd !== undefined) rows = rows.filter((e) => cwdVisible(e, targetCwd))
    if (targetLayer) rows = rows.filter((e) => e.layer === targetLayer)
    if (onlyArchived === true) rows = rows.filter((e) => e.archived)
    else if (includeArchived !== true) rows = rows.filter((e) => !e.archived)
    if (branch !== undefined && branch !== null) {
      const b = requireString(branch, 'branch', 'list')
      rows = rows.filter((e) => branchVisible(e, b))
    }
    if (q !== undefined) {
      const needle = q.toLowerCase()
      rows = rows.filter((e) => String(e.content).toLowerCase().includes(needle)
        || (Array.isArray(e.tags) && e.tags.some((t) => String(t).toLowerCase().includes(needle))))
    }
    if (lim !== undefined) rows = rows.slice(0, lim)
    return clone(rows)
  }

  /** 审计流查询。@param {string} [id] 省略则返回全部事件 */
  function history(id) {
    const rows = id ? events.filter((e) => e.id === id) : events
    return clone(rows)
  }

  /**
   * 检索（规定：**用 node:sqlite FTS5**，不可用则退化 `String.includes`）。
   *
   * @param {{ query: string, layers?: string[], branch?: string, limit?: number,
   *           includeArchived?: boolean, botId?: string, cwd?: string }} input
   * @returns {object[]} 命中条目（按 FTS5 rank / 稳定顺序）
   */
  function search(input = {}) {
    // ⚠️ 修复（2026-11-04 测试，P1-3）：与 list 口径一致，见 list() 顶部注释。
    const { query, layers, branch, limit, includeArchived, botId, cwd } = input ?? {}
    const q = requireString(query, 'query', 'search')
    const targetCwd = normalizeCwdFilter(cwd, 'search')
    const layerFilter = layers === undefined || layers === null ? undefined : stringList(layers, 'layers', 'search')
    if (layerFilter) {
      for (const l of layerFilter) {
        if (!LAYERS.includes(l)) {
          throw new MemoryError(
            `memory.search：非法 layer=${JSON.stringify(l)}（合法值：${LAYERS.join(' | ')}）`,
            'MEMORY_BAD_LAYER',
            { layer: l, valid: LAYERS },
          )
        }
      }
    }
    const lim = optionalLimit(limit, 'search')
    const b = branch === undefined || branch === null ? undefined : requireString(branch, 'branch', 'search')

    /** 命中判定：FTS5 需要 ≥3 码点（trigram 物理下限），短查询直接走 includes（可见地记录） */
    const cps = cpLength(q)
    const useFts = db && cps >= 3
    diagnostics.lastSearchAt = Date.now()

    /** @type {string[] | null} */
    let ids = null
    if (useFts) {
      ensureIndexFresh()
      if (db) {
        try {
          const phrase = `"${q.replace(/"/g, '""')}"` // 加引号短语 + 转义：杜绝 FTS 运算符注入
          const rows = db.prepare('SELECT id FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank').all(phrase)
          ids = rows.map((r) => r.id)
          diagnostics.searchBackend = 'fts5'
          diagnostics.searchBackendReason = 'node:sqlite FTS5 + trigram'
        } catch (error) {
          // 词法错误等一律退化，**不静默**：把原因记下来
          ids = null
          diagnostics.searchBackend = 'includes'
          diagnostics.searchBackendReason = `FTS5 查询失败，本次退化：${error?.message ?? error}`
          warn(`[cs-bots/memory] ${diagnostics.searchBackendReason}`)
        }
      }
    }
    if (ids === null) {
      const lower = q.toLowerCase()
      ids = [...entries.values()]
        .filter((e) => String(e.content).toLowerCase().includes(lower))
        .map((e) => e.id)
      // 降级原因**必须**能区分三种情形，否则排障时看不出是「配置强制」还是「环境缺失」
      const reason = diagnostics.searchBackend === 'fts5' || diagnostics.searchBackendReason.startsWith('FTS5 查询失败')
        ? diagnostics.searchBackendReason            // 上一轮/本轮 FTS5 失败留下的原因，保留
        : forcedBackend === 'includes'
          ? 'config.searchBackend=includes（显式强制退化路径）'
          : cps < 3
            ? `查询短于 3 码点（trigram 物理下限）→ 退化 includes`
            : `FTS5 不可用（${sqliteError ?? '无 DatabaseSync 导出'}）→ 退化 includes`
      diagnostics.searchBackend = 'includes'
      diagnostics.searchBackendReason = reason
    }

    /** @type {object[]} */
    let hits = ids
      .map((id) => entries.get(id))
      .filter((e) => Boolean(e))
      .filter((e) => (includeArchived === true ? true : !e.archived))
      .filter((e) => (layerFilter ? layerFilter.includes(e.layer) : true))
      .filter((e) => branchVisible(e, b))
      .filter((e) => cwdVisible(e, targetCwd))
      .filter((e) => visibleToBot(e, botId))
    if (lim !== undefined) hits = hits.slice(0, lim)
    return clone(hits)
  }

  // ── API：常驻注入 ──────────────────────────────────────────────────────────

  /** 渲染一行：`[id:xxxxxxxx] [rev:N] [conflict] 内容`。 */
  function renderLine(entry) {
    const bits = [`[id:${entry.id}]`, `[rev:${entry.rev}]`]
    if (entry.conflict === true) bits.push('[conflict]')
    if (entry.explicit === true) bits.push('[explicit]')
    if (Array.isArray(entry.branches) && entry.branches.length > 0) bits.push(`[branch:${entry.branches.join(',')}]`)
    return `${bits.join(' ')} ${entry.content}`
  }

  /**
   * 常驻注入文本（**L0–L3 冻结快照**）：值一旦返回即不受后续变更影响。
   * L0 来自 `config.persona`（人改），其余来自条目；L4/L5 永不进入常驻注入。
   *
   * ⚠️ 2026-11-04 增强（调研驱动）：新增 **tokenBudget** —— 按 contextWindow
   *   （cs-myfree 上报的模型窗口）动态裁剪注入量。小窗模型（8k–32k）上
   *   L0–L3 全量注入可能挤占工具/用户空间（调研：MemOS/Mem0 分级预算）。
   *   预算耗尽时按「L3 项目 key > L2 团队 > L1 用户 > L0 人格」的**保留优先级**
   *   截断（L3 离当前任务最近，优先保留）。
   *
   * ── cwd 作用域（2026-11-04 对齐记忆进化 #2）──
   *   传 `cwd` 时只注入「全局条目（L0/L1/L2）+ 当前 cwd 的 L3」（L4/L5 本来就不常驻）；
   *   不传时保持旧行为（全部可见），并在**诊断**里标 `cwdScoped:false`。
   *
   *   为什么默认仍返回**字符串**、`cwdScoped` 走 `withMeta`：`api.js` 的 `/memory/context`
   *   与 `tools.js` 的 `bot_memory_context` 都按字符串消费 `contextFor()`，33 个既有用例也用
   *   `assert.match(text, ...)` 断言；把返回值直接改成对象是破坏性变更（且这两个文件不在
   *   本次改造的写入范围内）。故用显式开关：`withMeta:true` → 返回
   *   `{ text, cwd, cwdScoped, layers }`；缺省 → 返回字符串。同样的诊断信息另见 `diagnostics()`。
   *
   * @param {{ layers?: string[], branch?: string, title?: string, botId?: string,
   *           tokenBudget?: number, cwd?: string, withMeta?: boolean }} [options]
   * @returns {string | { text: string, cwd: string|null, cwdScoped: boolean, layers: string[] }}
  */
  function contextFor(options = {}) {
    const { layers, branch, title, botId: forBot, tokenBudget, cwd, withMeta } = options ?? {}
    const rawCwd = cwd
    const targetCwd = normalizeCwdFilter(cwd, 'contextFor')
    const want = layers === undefined || layers === null
      ? INJECTED_LAYERS.slice()
      : stringList(layers, 'layers', 'contextFor')
    for (const l of want) {
      if (!LAYERS.includes(l)) {
        throw new MemoryError(
          `memory.contextFor：非法 layer=${JSON.stringify(l)}（合法值：${LAYERS.join(' | ')}）`,
          'MEMORY_BAD_LAYER',
          { layer: l, valid: LAYERS },
        )
      }
    }
    const b = branch === undefined || branch === null ? undefined : requireString(branch, 'branch', 'contextFor')
    if (b !== undefined && !INJECTED_LAYERS.includes('L3')) {
      throw new MemoryError('memory.contextFor：branch 过滤只对 L3 有意义', 'MEMORY_BAD_FIELD', { field: 'branch' })
    }

    // ⚠️ tokenBudget 计算（2026-11-04 增强）：
    //   先把所有层渲染成行数组，再按预算裁剪。预算不足时从低优先级层开始整层丢弃，
    //   并在输出尾部**可见地**标记被丢弃的层（不静默）。
    const budget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? Math.floor(tokenBudget) : 0

    const header = [
      `# cs-bots 分层记忆${title ? ` · ${title}` : ''}`,
      `# branch=${b ?? '(all)'} · layers=${want.join(',')} · entries=${entries.size}`
        + ` · search=${diagnostics.searchBackend}${forBot ? ` · bot=${forBot}` : ''}`
        // 只有真按项目裁剪时才在头部标 cwd：不传 cwd 时输出与改造前保持逐字一致（兼容前提）
        + (targetCwd !== undefined ? ` · cwd=${targetCwd}` : ''),
    ]

    /** 逐层收集渲染行 */
    const layersOut = []
    for (const layer of want) {
      const lines = [`## ${layer} ${LAYER_NAMES[layer] ?? ''}`.trim()]
      if (layer === PERSONA_LAYER) {
        if (persona.length === 0) lines.push('（未配置——人格层只能由人改配置，模型不可写）')
        else for (const line of persona) lines.push(`- ${line}`)
      } else {
        const rows = [...entries.values()]
          .filter((e) => e.layer === layer && !e.archived && branchVisible(e, b)
            && cwdVisible(e, targetCwd) && visibleToBot(e, forBot))
          .sort((x, y) => (x.id < y.id ? -1 : 1))
        if (rows.length === 0) lines.push('（空）')
        else for (const e of rows) lines.push(renderLine(e))
      }
      layersOut.push({
        layer,
        lines,
        tokens: estimateTokens(lines.join('\n')),
        priority: INJECT_PRIORITY[layer] ?? 0,
      })
    }

    /**
     * 统一出口：默认返回字符串（向后兼容），`withMeta:true` 返回带 `cwdScoped` 的结构。
     * 同时把「本次注入是否按项目裁剪」写进 diagnostics —— 即使调用方只要字符串，
     * 上层诊断（UI / 调度器）也能查到。
     * @param {string} text
     */
    function finish(text) {
      diagnostics.lastContextCwd = rawCwd ?? null
      diagnostics.lastContextCwdScoped = targetCwd !== undefined
      if (withMeta === true) {
        return { text, cwd: targetCwd ?? null, cwdScoped: targetCwd !== undefined, layers: want.slice() }
      }
      return text
    }

    if (budget <= 0) {
      const out = header.slice()
      for (const ly of layersOut) out.push('', ...ly.lines)
      return finish(out.join('\n'))
    }

    // 按**优先级**（L3 > L2 > L1 > L0）从高到低决定保留顺序，而不是按渲染顺序
    // （渲染顺序是 L0→L3，直接遍历会让"最先渲染的层"占满预算，与注释说的
    // 「L3 离当前任务最近、优先保留」相反 —— 2026-11-04 实测抓到并修）。
    // 例外：L0 人格是身份，即使优先级最低也**永远保留**（丢了身份比丢几条偏好严重）。
    const headerTokens = estimateTokens(header.join('\n'))
    const byPriority = [...layersOut].sort((x, y) => (y.priority - x.priority) || (x.layer < y.layer ? -1 : 1))
    let used = headerTokens
    const kept = []
    // 先无条件保留 L0
    for (const ly of byPriority) {
      if (ly.layer === PERSONA_LAYER) { kept.push(ly); used += ly.tokens }
    }
    for (const ly of byPriority) {
      if (ly.layer === PERSONA_LAYER) continue
      if (used + ly.tokens <= budget) { kept.push(ly); used += ly.tokens }
    }
    // 渲染仍按 L0→L3 的自然阅读顺序
    const out2 = header.slice()
    for (const layer of want) {
      const ly = kept.find((k) => k.layer === layer)
      if (ly) out2.push('', ...ly.lines)
    }
    if (layersOut.length !== kept.length) {
      const dropped = layersOut.filter((l) => !kept.includes(l)).map((l) => l.layer).join(',')
      out2.push(`\n# ⚠️ tokenBudget 生效（预算 ${budget} token）：已丢弃 ${dropped} 层`
        + '（按 L3>L2>L1>L0 优先级保留，L0 人格永不丢弃）')
    }
    return finish(out2.join('\n'))
  }

  // ── API：回放与统计 ────────────────────────────────────────────────────────

  /**
   * 从 `memory.jsonl` 重建内存态（重启回放一致性）。
   * @returns {{ from: string, entries: number, events: number, bad: number, search: string }}
   */
  function replay() {
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      entries: entries.size,
      events: events.length,
      bad: diagnostics.badLines,
      search: diagnostics.searchBackend,
    }
  }

  /**
   * 迁移入口：把「未归属项目」的 L3/L4/L5 老条目**批量**打上指定 `cwd`。
   *
   * 为什么需要它：改造前写入的老条目没有 `cwd` 字段，按 cwd 过滤时它们在任何具体项目
   * 视图里都不可见（见 `cwdVisible` 的取舍）。用户需要一个「把历史记忆归到当前项目」的
   * **显式、可审计**入口 —— 本函数就是那个入口：一次性归属、返回计数与明细，不猜归属。
   *
   * 语义细节（都有明确理由，不是随手写的）：
   *   - 只处理 **L3/L4/L5**：L0/L1/L2 是全局层，没有「归属项目」这回事。
   *   - 只处理 **`cwd` 尚未设置**的条目：已归属其他项目的**不动**（避免把 B 项目的记忆
   *     偷到 A 项目），它们计入 `alreadyScoped`，不算 migrated 也不算 skipped。
   *   - **已归档的未归属条目不动**（计入 `skipped`，code=`MEMORY_ENTRY_ARCHIVED`）：
   *     归档是审计证据，迁移只作用于活跃条目；`restore()` 之后可以再迁一次。
   *   - 迁移只改 `cwd` 元数据、**不动正文**，因此按 `explicit` 写者身份执行
   *     （这是人发起的显式动作，不违反规定 2 的「review/consolidate 不得改 explicit」）。
   *   - 每条一次 `commit`（rev+1 + 事件流 `action:'migrate'`），所以迁移本身也可回放/可审计；
   *     单条失败不中断整批，失败条目进 `skippedEntries`（可见，不静默）。
   *
   * @param {{ cwd: string, by?: string, now?: number }} input
   * @returns {{ cwd: string, migrated: number, skipped: number, alreadyScoped: number,
   *            migratedIds: string[], skippedEntries: object[] }}
   */
  function migrateCwd(input = {}) {
    const { cwd, by, now } = input ?? {}
    const target = normalizeCwd(cwd, 'cwd', 'migrateCwd')
    const author = by === undefined || by === null ? 'human' : requireString(by, 'by', 'migrateCwd')
    const at = normalizeNow(now, 'migrateCwd')

    const migratedIds = []
    const skippedEntries = []
    let alreadyScoped = 0

    for (const entry of [...entries.values()]) {
      if (!cwdScopedLayer(entry.layer)) continue
      if (typeof entry.cwd === 'string' && entry.cwd !== '') { alreadyScoped += 1; continue }
      if (entry.archived) {
        skippedEntries.push({
          id: entry.id,
          layer: entry.layer,
          code: 'MEMORY_ENTRY_ARCHIVED',
          reason: '已归档条目不改（归档是证据；restore() 后可再迁移一次）',
        })
        continue
      }
      // cwd 未归属且活跃 → 归属到目标项目（只改 cwd 元数据，正文一字不动）
      const before = clone(entry)
      const next = clone(entry)
      next.rev = entry.rev + 1
      next.updatedAt = at
      next.updatedBy = author
      next.cwd = target
      try {
        migratedIds.push(commit(entry.id, 'migrate', author, at, before, next).id)
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error
        skippedEntries.push({ id: entry.id, layer: entry.layer, code: error.code, reason: error.message })
        warn(`[cs-bots/memory] migrateCwd 跳过 ${entry.id}：${error.code} —— ${error.message}`)
      }
    }

    if (migratedIds.length > 0) {
      info(`[cs-bots/memory] migrateCwd：${migratedIds.length} 条未归属条目 → cwd=${target}`
        + `（跳过 ${skippedEntries.length} 条，已归属他处 ${alreadyScoped} 条）`)
    }
    return {
      cwd: target,
      migrated: migratedIds.length,
      skipped: skippedEntries.length,
      alreadyScoped,
      migratedIds,
      skippedEntries,
    }
  }

  /** 统计（给记忆中心页面与诊断用）。 */
  function stats() {
    const byLayer = {}
    for (const layer of LAYERS) byLayer[layer] = { active: 0, archived: 0, conflict: 0 }
    let archived = 0
    let conflict = 0
    const bySource = {}
    // 2026-11-04 增强（调研驱动）：按层估 token（token 计量），
    // 让 UI/诊断能看到"记忆注入花了多少 token"（MemOS/Mem0 统一 token 计量的落地）。
    const layerTokens = {}
    let injectedTokens = 0
    // cwd 聚合（2026-11-04 对齐记忆进化 #2）：byCwd 只统计**有 cwd 的条目**（含归档 ——
    // 这是库分布，不是注入量）；未归属的隔离层条目单独计数，供 UI 提示「去迁移」。
    const byCwd = {}
    let cwdUnassignedActive = 0
    let cwdUnassignedArchived = 0
    for (const e of entries.values()) {
      const slot = byLayer[e.layer] ?? (byLayer[e.layer] = { active: 0, archived: 0, conflict: 0 })
      if (e.archived) { slot.archived += 1; archived += 1 } else { slot.active += 1; injectedTokens += estimateTokens(renderLine(e)) }
      layerTokens[e.layer] = (layerTokens[e.layer] ?? 0) + estimateTokens(renderLine(e))
      if (e.conflict === true) { slot.conflict += 1; conflict += 1 }
      const src = e.source ?? 'unknown'
      bySource[src] = (bySource[src] ?? 0) + 1
      if (typeof e.cwd === 'string' && e.cwd !== '') {
        byCwd[e.cwd] = (byCwd[e.cwd] ?? 0) + 1
      } else if (cwdScopedLayer(e.layer)) {
        if (e.archived) cwdUnassignedArchived += 1
        else cwdUnassignedActive += 1
      }
    }
    return {
      stateDir,
      paths: { jsonl: jsonlPath, snapshot: snapPath, fts: ftsPath },
      layers: LAYERS,
      injectedLayers: INJECTED_LAYERS,
      entryMax,
      // ⚠️ 修复（2026-11-04 测试，P2-2）：UI 概览读 `stats.total`，此处之前没有 ⇒ 恒显示 `—`
      total: entries.size,
      persona: persona.length,
      entries: entries.size,
      active: entries.size - archived,
      archived,
      conflicts: conflict,
      byLayer,
      bySource,
      // cwd 聚合：`byCwd` 是需求要求的形态（cwd → 条数，只含有 cwd 的条目）；
      // `cwd` 段是给 UI 的完整视图（隔离层清单 + 未归属计数，用于提示「历史记忆待归项目」）。
      byCwd,
      cwd: {
        layers: CWD_LAYERS,
        all: CWD_ALL,
        byCwd,
        unassignedActive: cwdUnassignedActive,
        unassignedArchived: cwdUnassignedArchived,
      },
      tokens: {
        byLayer: layerTokens,
        injected: INJECTED_LAYERS,
        injectedEstimate: injectedTokens,
      },
      events: events.length,
      search: { backend: diagnostics.searchBackend, reason: diagnostics.searchBackendReason, tokenize: diagnostics.ftsTokenize },
      hydration: {
        from: diagnostics.hydratedFrom,
        replayedEvents: diagnostics.replayedEvents,
        badLines: diagnostics.badLines,
        snapshotWriteFailures: diagnostics.snapshotWriteFailures,
      },
    }
  }

  /** 关闭 sqlite 句柄（测试与卸载用；不关也不影响正确性）。 */
  function dispose() {
    try { db?.close?.() } catch { /* ignore */ }
    db = null
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  openIndex()
  /** 首次构造即回放，保证 `list()` 在重启后马上可用。 */
  hydrate()

  const memory = {
    name: config.name ?? 'memory',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath, fts: ftsPath }),
    layers: LAYERS,
    injectedLayers: INJECTED_LAYERS,
    cwdLayers: CWD_LAYERS,
    entryMax,
    add,
    get,
    list,
    update,
    remove,
    purge,
    archive,
    restore,
    review,
    consolidate,
    search,
    contextFor,
    migrateCwd,
    history,
    replay,
    stats,
    dispose,
    diagnostics: () => clone(diagnostics),
  }
  return memory
}

export default createMemory
