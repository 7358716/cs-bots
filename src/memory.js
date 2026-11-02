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
 * 依赖面：node 内置（`node:crypto` / `node:sqlite`）+ `./store.js` + `./kernel.js`。
 * **不 import 任何 `@deepseek-ai/*`**（`test/ci-zero-dep.sh` 检查 1 机械强制）。
 */

import { randomBytes } from 'node:crypto'

import {
  appendJsonl,
  ensureDir,
  readJson,
  readJsonl,
  statePath,
  writeJsonAtomic,
} from './store.js'

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
const ACTIONS = ['add', 'update', 'remove', 'archive', 'restore', 'review', 'consolidate']
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
    searchBackend: /** @type {'fts5'|'includes'} */ ('includes'),
    searchBackendReason: /** @type {string} */ ('未初始化'),
    ftsTokenize: /** @type {string|null} */ (null),
    lastSearchAt: /** @type {number|undefined} */ (undefined),
    lastReplayAt: /** @type {number|undefined} */ (undefined),
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
      if (!ev || typeof ev.id !== 'string' || !ev.after || typeof ev.after.id !== 'string') {
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
   *           tags?: string[], now?: number }} input
   * @returns {object} Entry（含 id + rev）
   */
  function add(input = {}) {
    const { layer, content, by, explicit, source, branch, tags, botId, now } = input ?? {}
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
    for (const part of parts) {
      const id = newId()
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
        tags: tagList.slice(),
        createdAt: at,
        createdBy: author,
        updatedAt: at,
        updatedBy: author,
      }
      if (parts.length > 1) {
        entry.splitIndex = created.length
        entry.splitTotal = parts.length
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
   *           explicit?: boolean, by: string, now?: number }} input
   * @returns {object} 变更后的 Entry
   */
  function update(input = {}) {
    const { layer, id, expectedRev, content, tags, explicit, by, now } = input ?? {}
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
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.updatedAt = at
    next.updatedBy = author
    if (explicit === true) next.explicit = true
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
        const created = add({ layer: targetLayer, content, by: author, source: 'review', tags: item.tags, now: at })
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
   * @param {{ layer?: string, branch?: string, limit?: number, query?: string,
   *           includeArchived?: boolean, onlyArchived?: boolean }} [options]
   * @returns {object[]}
   */
  function list(options = {}) {
    const { layer, branch, limit, query, includeArchived, onlyArchived } = options ?? {}
    const targetLayer = layer === undefined || layer === null ? undefined : requireLayer(layer, 'list')
    const lim = optionalLimit(limit, 'list')
    const q = optionalString(query, 'query', 'list')

    let rows = [...entries.values()]
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
   *           includeArchived?: boolean }} input
   * @returns {object[]} 命中条目（按 FTS5 rank / 稳定顺序）
   */
  function search(input = {}) {
    const { query, layers, branch, limit, includeArchived } = input ?? {}
    const q = requireString(query, 'query', 'search')
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
   * @param {{ layers?: string[], branch?: string, title?: string }} [options]
   * @returns {string}
   */
  function contextFor(options = {}) {
    const { layers, branch, title, botId: forBot } = options ?? {}
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

    const out = []
    out.push(`# cs-bots 分层记忆${title ? ` · ${title}` : ''}`)
    out.push(`# branch=${b ?? '(all)'} · layers=${want.join(',')} · entries=${entries.size}`
      + ` · search=${diagnostics.searchBackend}${forBot ? ` · bot=${forBot}` : ''}`)

    for (const layer of want) {
      out.push('')
      out.push(`## ${layer} ${LAYER_NAMES[layer] ?? ''}`.trim())
      if (layer === PERSONA_LAYER) {
        if (persona.length === 0) out.push('（未配置——人格层只能由人改配置，模型不可写）')
        else for (const line of persona) out.push(`- ${line}`)
        continue
      }
      const rows = [...entries.values()]
        .filter((e) => e.layer === layer && !e.archived && branchVisible(e, b) && visibleToBot(e, forBot))
        .sort((x, y) => (x.id < y.id ? -1 : 1))
      if (rows.length === 0) out.push('（空）')
      else for (const e of rows) out.push(renderLine(e))
    }
    return out.join('\n')
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

  /** 统计（给记忆中心页面与诊断用）。 */
  function stats() {
    const byLayer = {}
    for (const layer of LAYERS) byLayer[layer] = { active: 0, archived: 0, conflict: 0 }
    let archived = 0
    let conflict = 0
    const bySource = {}
    for (const e of entries.values()) {
      const slot = byLayer[e.layer] ?? (byLayer[e.layer] = { active: 0, archived: 0, conflict: 0 })
      if (e.archived) { slot.archived += 1; archived += 1 } else slot.active += 1
      if (e.conflict === true) { slot.conflict += 1; conflict += 1 }
      const src = e.source ?? 'unknown'
      bySource[src] = (bySource[src] ?? 0) + 1
    }
    return {
      stateDir,
      paths: { jsonl: jsonlPath, snapshot: snapPath, fts: ftsPath },
      layers: LAYERS,
      injectedLayers: INJECTED_LAYERS,
      entryMax,
      persona: persona.length,
      entries: entries.size,
      active: entries.size - archived,
      archived,
      conflicts: conflict,
      byLayer,
      bySource,
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
    entryMax,
    add,
    get,
    list,
    update,
    remove,
    archive,
    restore,
    review,
    consolidate,
    search,
    contextFor,
    history,
    replay,
    stats,
    dispose,
    diagnostics: () => clone(diagnostics),
  }
  return memory
}

export default createMemory
