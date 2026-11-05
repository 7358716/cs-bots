/**
 * cs-bots TodoService —— 四轨待办（对标 dsh-memory-evolve 的 dtodo，**完全自建、零依赖**）。
 *
 * 设计依据：`ANALYSIS-memory-evolve-parity.md` 第 #10 项 + 第三节表格
 *   （四轨：life/work/project/daily + 四象限 + 截止 + 状态机 + 智能视图），
 *   持久化与错误处理照抄本仓 `src/board.js` 的标准写法（jsonl 事件流 + snap 快照 + replay）。
 *
 * ── 四条不变量（与 board.js / discipline.js 同款，机械保证）──
 *   1. **CAS 优先**：任何变更都要带 `expectedRev`；不匹配即抛错，绝不静默覆盖。
 *   2. **事件流是真相源**：先 append `todo.jsonl`（失败即抛错，内存原封不动），
 *      再更新内存，最后原子写 `todo.snap.json`（快照失败只降级 warn ——
 *      事件流已落盘，`replay()` 能完整重建）。
 *   3. **写失败绝不静默**：append 失败抛 `TODO_APPEND_FAILED`，不留下「内存有、磁盘无」的幽灵条目。
 *   4. **project 轨按 cwd 隔离**：项目待办只对同一个工作目录可见，跨项目零泄露。
 *
 * ── 关键语义（都是实测踩坑点，勿"简化"）──
 *   · **智能视图不是"全部未完成"**：只列「需要关注」的未完成项
 *     （逾期 → 今日到期 → 本项目未完成 → 重要紧急 q1/q2 → 今日每日待办），
 *     其余 q3/q4 且无截止的条目要显式查（`all:true` 或按 track/status 查），
 *     否则列表会被琐事淹没。硬上限 8 条（`SMART_VIEW_LIMIT`）。
 *   · **过往每日待办默认隐藏**：daily 的"截止"就是它所属的那一天（`date`），
 *     `date < 今天` 的条目属于历史。要查历史必须显式 `past:true`；
 *     而历史里「未完成且已过期」的遗留默认仍被藏起来 —— 只带 `past:true`
 *     会得到"昨天没有待办"的错觉，必须再带 `expired:true` 才能挖出遗留任务。
 *     本模块在 `past:true && expired!==true` 时返回 `hint` 点明这一点。
 *   · **done 自动盖 doneAt**：`status` 变成 done 的那一刻写入 `doneAt`；
 *     离开 done（改回 doing / cancelled 等）清空，避免"已完成时间"长期挂着。
 *   · **四象限与 important/urgent 必须自洽**：只给 quadrant 就反推两个布尔；
 *     只给布尔就推出 quadrant；两边都给但互相矛盾则抛错（不允许歧义态）。
 *
 * ── 为什么 kernel.js 是「动态导入」而不是静态 import（与 board.js 相同，勿改）──
 *   `kernel.js` 静态 import 了宿主包（DSH 提供，只在 DSH profile 内可解析）。
 *   本仓库是**裸检出**（无 node_modules），静态 import 会让 todo.js 连带
 *   kernel.js 一并加载失败 → `test/todo.test.mjs` 根本起不来。
 *   故此处用顶层 `await import()` 并在失败时记下原因：
 *     - 拿得到 kernel → `config.stateDir` 缺省走 `kernel.stateDir()`
 *     - 拿不到 kernel 且调用方也没给 `config.stateDir` → **抛可读错误**（不静默兜底）
 *   零依赖 CI（`test/ci-zero-dep.sh` 检查 1）依然成立：这里引用的只是 `./kernel.js`。
 *
 * 依赖面：node 内置（`node:crypto` / `node:path`）+ `./store.js` + `./kernel.js`。
 * **不 import 任何宿主包或第三方包**（CI 机械校验）。
 */

import { randomBytes } from 'node:crypto'
import { normalize as normalizePath } from 'node:path'

import {
  appendJsonl,
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

// ── store.appendAudit 软导入（P1-D §4）───────────────────────────────────────
// 软用：拿不到就只 warn 一次 + 计数，绝不阻断主流程，也绝不自己另造审计格式。
// 动态 `await import` 而非具名静态 import：store.js 正被并行修改，静态具名 import 在
// 对方重构掉该导出时是**加载期**失败（整个服务起不来）；动态判定只少一条审计。
let storeAppendAudit = /** @type {null | ((dir: string, entry: object) => unknown)} */ (null)
let storeAuditMissing = false
try {
  const storeMod = await import('./store.js')
  if (typeof storeMod.appendAudit === 'function') storeAppendAudit = storeMod.appendAudit
  else storeAuditMissing = true
} catch {
  storeAuditMissing = true
}

// ── 常量（契约冻结）─────────────────────────────────────────────────────────

/** 四轨：生活 / 工作 / 本项目 / 每日。 */
export const TRACKS = ['life', 'work', 'project', 'daily']
/** 状态机（缺省 pending）。 */
export const STATUSES = ['pending', 'doing', 'done', 'blocked', 'cancelled']
/** 四象限：q1 重要且紧急 / q2 重要不紧急 / q3 紧急不重要 / q4 都不。 */
export const QUADRANTS = ['q1', 'q2', 'q3', 'q4']
/** 字段上限。content 首行是标题、其余是详情，4000 与 discipline 的正文口径一致。 */
export const LIMITS = { content: 4000, cat: 64 }
/** 智能视图硬上限（对齐 dtodo 的 DEFAULT_VIEW_LIMIT）。 */
export const SMART_VIEW_LIMIT = 8
/** "需要关注"的状态集合：done/cancelled 已结束，不再进智能视图。 */
export const ACTIVE_STATUSES = ['pending', 'doing', 'blocked']
/** 严格日期形态（真正合法性还要过日历校验，见 `parseDateString`）。 */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** update 可补丁的字段（status 也走这里，但 doneAt 只能由 status 推导，不许外部直接写）。 */
const PATCH_FIELDS = ['track', 'cwd', 'date', 'content', 'quadrant', 'important', 'urgent', 'due', 'cat', 'status']

// ── 错误 ────────────────────────────────────────────────────────────────────

/**
 * 待办模块结构化错误。所有失败都走它，**绝不静默**。
 *
 * `code` 一律 `TODO_` 前缀；`detail` 带机器可读定位信息（id / 字段 / 当前 rev）。
 * 同时挂 `details` 别名：本仓 board.js 用的是 `details`，兼容两种读法，
 * 免得调用方因为命名差异把一个真实错误读成 `undefined`。
 */
export class TodoError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息
   * @param {string} [code]
   * @param {object} [detail]
   */
  constructor(message, code = 'TODO_ERROR', detail) {
    super(message)
    this.name = 'TodoError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
      this.details = detail
    }
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/**
 * 深拷贝 + **JSON 归一**（去掉值为 undefined 的键）。
 * 必须走 JSON 而不是 structuredClone：否则内存态会比磁盘态多出
 * `{cat: undefined}` 这类键，`replay()` 重建后与内存值不等。
 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 两位补零。 */
function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * 毫秒时间戳 → 本地日历日 `YYYY-MM-DD`。
 *
 * 为什么不用 `toISOString().slice(0, 10)`：它按 **UTC** 算日期。
 * 本机时区是 Asia/Shanghai（UTC+8），早上 8 点前 UTC 还停在前一天，
 * 会把「今天」算成昨天，导致今日待办被当成过往、逾期待办少算一天。
 */
export function localDate(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 某年某月的天数（month 为 1–12）。用 Date 兜住闰年，不引日期库。 */
function daysInMonth(year, month) {
  // Date.UTC(year, month, 0)：month 作为「下个月」的 0 号 = 本月最后一天
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 非空字符串字段校验（返回原值，不 trim —— 由调用方决定是否 trim）。 */
function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TodoError(
      `todo.${where}：字段 ${field} 缺失或类型错误（要求非空字符串，收到 ${JSON.stringify(value)}）`,
      'TODO_MISSING_FIELD',
      { field, where },
    )
  }
  return value
}

/** 时间参数归一：可注入（测试友好），缺省 Date.now()。 */
function normalizeNow(now, where) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
    throw new TodoError(
      `todo.${where}：now 必须是有限的非负数毫秒时间戳（收到 ${JSON.stringify(now)}）`,
      'TODO_BAD_FIELD',
      { field: 'now', where },
    )
  }
  return now
}

/**
 * 取操作者 id。契约参数名是 `by`；同时容忍 board 风格的 `byId`，
 * 避免 api/tools 层混用时把一次正确调用误判成「缺 by」。
 */
function requireActor(input, where) {
  const value = input?.by ?? input?.byId
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TodoError(
      `todo.${where}：操作者缺失（字段 by，兼容别名 byId；收到 ${JSON.stringify(value)}）`,
      'TODO_MISSING_FIELD',
      { field: 'by', where },
    )
  }
  return value.trim()
}

/** 取 id 参数（本模块 id 统一 `td-<8hex>`）。 */
function requireId(id, where) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TodoError(
      `todo.${where}：id 必须是非空字符串（形如 td-1a2b3c4d，收到 ${JSON.stringify(id)}）`,
      'TODO_MISSING_FIELD',
      { field: 'id', where },
    )
  }
  return id.trim()
}

/** 严格日期校验：形态 + 日历合法性（2026-02-30 这类必须在入口拒绝）。 */
function parseDateString(value, field, where) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new TodoError(
      `todo.${where}：字段 ${field} 必须是 YYYY-MM-DD 字符串（收到 ${JSON.stringify(value)}）`,
      'TODO_BAD_DATE',
      { field, where, value },
    )
  }
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new TodoError(
      `todo.${where}：字段 ${field} 不是合法日历日（${value}，${year} 年 ${month} 月没有 ${day} 日）`,
      'TODO_BAD_DATE',
      { field, where, value },
    )
  }
  return value
}

/**
 * cwd 归一（只用于**比较与存储**）：
 * 去首尾空白、按平台 normalize、去掉尾部分隔符；Windows 下统一小写。
 *
 * 为什么必须归一：project 轨的隔离键就是 cwd。`/a/b` 与 `/a/b/` 若被当成
 * 两个项目，同一个项目的待办会分裂成两份，且互相看不见 —— 这是静默的数据丢失。
 */
function normalizeCwd(cwd, where) {
  requireString(cwd, 'cwd', where)
  let s = cwd.trim()
  try {
    s = normalizePath(s)
  } catch {
    /* 非法路径按原样比较，不抛 —— 比较不该比写还脆 */
  }
  if (s.length > 1) s = s.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') s = s.toLowerCase()
  if (s === '') {
    throw new TodoError(
      `todo.${where}：cwd 解析后为空（收到 ${JSON.stringify(cwd)}）`,
      'TODO_BAD_FIELD',
      { field: 'cwd', where },
    )
  }
  return s
}

/** 判断"调用方到底给没给这个字段"：undefined / null / '' 都算没给。 */
function given(value) {
  return value !== undefined && value !== null && value !== ''
}

/** 布尔字段归一。 */
function normalizeBoolean(value, field, where) {
  if (typeof value !== 'boolean') {
    throw new TodoError(
      `todo.${where}：字段 ${field} 必须是布尔（收到 ${JSON.stringify(value)}）`,
      'TODO_BAD_FIELD',
      { field, where },
    )
  }
  return value
}

/** 四象限 → 两个布尔（q1/q2 重要；q1/q3 紧急）。 */
function flagsOfQuadrant(quadrant) {
  return {
    important: quadrant === 'q1' || quadrant === 'q2',
    urgent: quadrant === 'q1' || quadrant === 'q3',
  }
}

/** 两个布尔 → 四象限。 */
function quadrantOfFlags(important, urgent) {
  if (important) return urgent ? 'q1' : 'q2'
  return urgent ? 'q3' : 'q4'
}

/** quadrant 字面量校验。 */
function normalizeQuadrantValue(quadrant, where) {
  if (typeof quadrant !== 'string' || !QUADRANTS.includes(quadrant)) {
    throw new TodoError(
      `todo.${where}：非法 quadrant=${JSON.stringify(quadrant)}（合法值：${QUADRANTS.join(' | ')}）`,
      'TODO_BAD_QUADRANT',
      { field: 'quadrant', where, quadrant },
    )
  }
  return quadrant
}

/**
 * 四象限字段组合归一（create / update 共用）。
 *
 * 规则（为什么这么定）：
 *   · 只给 `quadrant` → 由它反推 important/urgent，保证三字段永远自洽；
 *   · 只给布尔 → 由布尔推出 quadrant；
 *   · 两边都给且矛盾 → **抛错**。静默让某一方赢会让 UI 的色块与文字对不上，
 *     而且调用方永远不知道自己的入参被改写了。
 *
 * @param {object} input 调用入参
 * @param {object|null} current 更新时的当前记录（create 传 null）
 * @param {string} where
 * @returns {{ quadrant: string, important: boolean, urgent: boolean }}
 */
function normalizeQuadrantFields(input, current, where) {
  const hasQuadrant = given(input?.quadrant)
  if (hasQuadrant) {
    const quadrant = normalizeQuadrantValue(input.quadrant, where)
    const flags = flagsOfQuadrant(quadrant)
    if (given(input?.important)) {
      const important = normalizeBoolean(input.important, 'important', where)
      if (important !== flags.important) {
        throw new TodoError(
          `todo.${where}：quadrant=${quadrant} 蕴含 important=${flags.important}，但入参 important=${important} —— `
          + '两个字段互相矛盾，拒绝猜测哪边为准',
          'TODO_QUADRANT_CONFLICT',
          { field: 'important', where, quadrant, important },
        )
      }
    }
    if (given(input?.urgent)) {
      const urgent = normalizeBoolean(input.urgent, 'urgent', where)
      if (urgent !== flags.urgent) {
        throw new TodoError(
          `todo.${where}：quadrant=${quadrant} 蕴含 urgent=${flags.urgent}，但入参 urgent=${urgent} —— `
          + '两个字段互相矛盾，拒绝猜测哪边为准',
          'TODO_QUADRANT_CONFLICT',
          { field: 'urgent', where, quadrant, urgent },
        )
      }
    }
    return { quadrant, important: flags.important, urgent: flags.urgent }
  }

  const important = given(input?.important)
    ? normalizeBoolean(input.important, 'important', where)
    : Boolean(current?.important)
  const urgent = given(input?.urgent)
    ? normalizeBoolean(input.urgent, 'urgent', where)
    : Boolean(current?.urgent)
  return { quadrant: quadrantOfFlags(important, urgent), important, urgent }
}

/** track 字面量校验。 */
function normalizeTrack(track, where) {
  if (typeof track !== 'string' || !TRACKS.includes(track)) {
    throw new TodoError(
      `todo.${where}：非法 track=${JSON.stringify(track)}（合法值：${TRACKS.join(' | ')}）`,
      'TODO_BAD_TRACK',
      { field: 'track', where, track },
    )
  }
  return track
}

/** status 字面量校验。 */
function normalizeStatus(status, where) {
  if (typeof status !== 'string' || !STATUSES.includes(status)) {
    throw new TodoError(
      `todo.${where}：非法 status=${JSON.stringify(status)}（合法值：${STATUSES.join(' | ')}）`,
      'TODO_BAD_STATUS',
      { field: 'status', where, status },
    )
  }
  return status
}

/**
 * 轨 ↔ cwd/date 绑定归一（**track 决定必填项，不允许歧义态**）。
 *
 *   · project：cwd 必填（隔离键）；date 必须为空（项目待办的"日期"用 due 表达）；
 *   · daily  ：date 必填（缺省=今天，本地日历日）；cwd 必须为空；
 *   · life/work：cwd、date 都必须为空。
 *
 * 换轨时（例如 project → life）旧的 cwd/date 自动清空，避免带着上个轨的
 * 隔离键"串味"。
 *
 * @param {object} input 调用入参
 * @param {object|null} current 当前记录（create 为 null）
 * @param {number} at 本次操作时间（daily 缺省日期由它推出）
 * @param {string} where
 * @returns {{ track: string, cwd: string|null, date: string|null }}
 */
function normalizeBinding(input, current, at, where) {
  let track
  if (given(input?.track)) track = normalizeTrack(input.track, where)
  else if (current) track = current.track
  else {
    throw new TodoError(
      `todo.${where}：字段 track 缺失（合法值：${TRACKS.join(' | ')}）`,
      'TODO_MISSING_FIELD',
      { field: 'track', where },
    )
  }

  // 换轨后，旧轨的 cwd/date 一律不再沿用（否则会留下"life 却带 cwd"的歧义态）
  const previous = current && current.track === track ? current : null

  if (track === 'project') {
    const cwd = given(input?.cwd)
      ? normalizeCwd(input.cwd, where)
      : (previous?.cwd ?? null)
    if (!cwd) {
      throw new TodoError(
        `todo.${where}：track=project 时必须给 cwd（项目待办按工作目录隔离，否则会串项目），`
        + `收到 ${JSON.stringify(input?.cwd)}`,
        'TODO_CWD_REQUIRED',
        { field: 'cwd', where, track },
      )
    }
    if (given(input?.date)) {
      throw new TodoError(
        `todo.${where}：track=project 不使用 date（收到 ${JSON.stringify(input.date)}）——`
        + '项目待办的日期语义请用 due 表达',
        'TODO_BAD_FIELD',
        { field: 'date', where, track },
      )
    }
    return { track, cwd, date: null }
  }

  if (track === 'daily') {
    if (given(input?.cwd)) {
      throw new TodoError(
        `todo.${where}：track=daily 不使用 cwd（收到 ${JSON.stringify(input.cwd)}）——`
        + '每日待办跨项目共享，它只按 date 归属',
        'TODO_BAD_FIELD',
        { field: 'cwd', where, track },
      )
    }
    const date = given(input?.date)
      ? parseDateString(input.date, 'date', where)
      : (previous?.date ?? localDate(at))
    return { track, cwd: null, date }
  }

  // life / work：不挂 cwd、不挂 date
  if (given(input?.cwd)) {
    throw new TodoError(
      `todo.${where}：track=${track} 不使用 cwd（收到 ${JSON.stringify(input.cwd)}）——cwd 只属于 project 轨`,
      'TODO_BAD_FIELD',
      { field: 'cwd', where, track },
    )
  }
  if (given(input?.date)) {
    throw new TodoError(
      `todo.${where}：track=${track} 不使用 date（收到 ${JSON.stringify(input.date)}）——date 只属于 daily 轨`,
      'TODO_BAD_FIELD',
      { field: 'date', where, track },
    )
  }
  return { track, cwd: null, date: null }
}

/**
 * 正文归一：非空、≤4000，去掉首尾空白（首行=标题，尾部空白只会污染展示）。
 * 中间的换行与缩进**保留**（多行详情有意义）。
 */
function normalizeContent(content, where) {
  requireString(content, 'content', where)
  const text = content.trim()
  if (text === '') {
    throw new TodoError(
      `todo.${where}：content 只有空白，无法作为待办标题`,
      'TODO_MISSING_FIELD',
      { field: 'content', where },
    )
  }
  if (text.length > LIMITS.content) {
    throw new TodoError(
      `todo.${where}：content 超长（${text.length} > ${LIMITS.content}）——`
      + '待办是行动项不是文档，超长请拆条或写进便签',
      'TODO_CONTENT_TOO_LONG',
      { field: 'content', where, length: text.length, max: LIMITS.content },
    )
  }
  return text
}

/** due 归一：没给就沿用旧值；''/null 表示清空；否则严格日期。 */
function normalizeDue(value, current, where) {
  if (value === undefined) return current?.due ?? null
  if (value === null || value === '') return null
  return parseDateString(value, 'due', where)
}

/** cat 归一：没给沿用旧值；''/null 清空；否则 ≤64 的非空分类名。 */
function normalizeCat(value, current, where) {
  if (value === undefined) return current?.cat ?? null
  if (value === null || value === '') return null
  const s = requireString(value, 'cat', where).trim()
  if (s.length > LIMITS.cat) {
    throw new TodoError(
      `todo.${where}：cat 超长（${s.length} > ${LIMITS.cat}）`,
      'TODO_CAT_TOO_LONG',
      { field: 'cat', where, length: s.length, max: LIMITS.cat },
    )
  }
  return s
}

/** CAS 前置校验：expectedRev 必须显式给、且与当前 rev 一致。 */
function assertExpectedRev(current, expectedRev, where) {
  if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev)) {
    throw new TodoError(
      `todo.${where}：expectedRev 必须是整数（CAS 需要显式期望版本，条目 ${current.id} 当前 rev=${current.rev}，`
      + `收到 ${JSON.stringify(expectedRev)}）`,
      'TODO_MISSING_EXPECTED_REV',
      { id: current.id, rev: current.rev, where },
    )
  }
  if (current.rev !== expectedRev) {
    throw new TodoError(
      `todo.${where} CAS 冲突：条目 ${current.id} 期望 rev=${expectedRev}，实际 rev=${current.rev} —— `
      + '拒绝静默覆盖，请重新 getTodo() 后按最新 rev 重试',
      'TODO_REV_CONFLICT',
      { id: current.id, expectedRev, rev: current.rev, where },
    )
  }
}

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**：两条路都不通时必须让调用方看见。
 */
function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') {
    return config.stateDir.trim()
  }
  if (kernel && typeof kernel.stateDir === 'function') {
    return kernel.stateDir()
  }
  const reason = kernelError?.message ?? (kernel ? 'kernel.stateDir 不存在' : 'kernel 未加载')
  throw new TodoError(
    `todo.createTodo：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'TODO_NO_STATE_DIR',
  )
}

/**
 * 把 `(ctx, config)` 归一。允许「只传一个 config 对象」的简写（`{ stateDir }`），
 * 因为工具层/测试里手写实例时更顺手；两种写法语义完全一致（与 discipline.js 同款）。
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
 * 创建一个待办服务实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文（只用于日志，缺失即降级为 no-op）
 * @param {{ stateDir?: string, name?: string }} [config]
 * @returns {object} todo service
 */
export function createTodo(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'todo.jsonl')
  const snapPath = statePath(stateDir, 'todo.snap.json')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} id → Todo（插入序 = 创建序） */
  const todos = new Map()
  /** @type {object[]} 全部事件（审计流，按落盘顺序） */
  const events = []
  /** @type {Map<string, number>} id → 已见到的最新 rev（回放幂等用） */
  const lastRev = new Map()
  /** 曾出现过的全部 id（含已删除）——随机 id 绝不能重复使用，否则历史事件会串号 */
  const seenIds = new Set()

  let disposed = false

  const diagnostics = {
    stateDir,
    jsonlPath,
    snapPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: /** @type {null|'jsonl'|'snapshot'|'empty'} */ (null),
    replayedEvents: 0,
    badLines: 0,
    snapshotWriteFailures: 0,
    auditWriteFailures: 0,
    auditWarnedOnce: false,
    lastReplayAt: /** @type {number|undefined} */ (undefined),
  }

  /** 已销毁实例的调用一律抛错：静默返回空数据比崩掉更难查。 */
  function assertAlive(where) {
    if (disposed) {
      throw new TodoError(
        `todo.${where}：实例已 dispose()，请重新 createTodo()（拒绝在已销毁实例上静默返回空数据）`,
        'TODO_DISPOSED',
        { where },
      )
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 快照内容（落盘形态）。 */
  const snapshot = () => ({
    version: 1,
    savedAt: Date.now(),
    todos: [...todos.values()],
    seenIds: [...seenIds],
  })

  /**
   * 提交一次变更：**先落事件，再改内存，最后写快照**。
   *
   * 顺序不可颠倒：append 失败时内存必须原封不动（否则内存与磁盘分叉，
   * 重启回放后状态凭空回退 —— 这是最恶劣的静默失败）。
   *
   * @param {string} todoId
   * @param {'create'|'update'|'remove'} action
   * @param {string|null} byId
   * @param {number} at
   * @param {object|null} before 变更前记录（create 为 null）
   * @param {object|null} after 变更后记录（remove 为 null）
   * @returns {object|null} 克隆后的 after
   */
  function commit(todoId, action, byId, at, before, after) {
    /** @type {Record<string, unknown>} */
    const event = {
      todoId,
      rev: after ? after.rev : ((before?.rev ?? 0) + 1),
      action,
      byId: byId ?? null,
      at,
      before: before ? clone(before) : null,
      after: after ? clone(after) : null,
    }
    if (!appendJsonl(jsonlPath, event)) {
      throw new TodoError(
        `todo.${action}：事件追加失败（${jsonlPath}）——拒绝「只改内存不落盘」`,
        'TODO_APPEND_FAILED',
        { id: todoId, action, path: jsonlPath },
      )
    }
    seenIds.add(todoId)
    if (after) {
      todos.set(todoId, clone(after))
      lastRev.set(todoId, after.rev)
    } else {
      todos.delete(todoId)
      lastRev.set(todoId, event.rev)
    }
    events.push(event)
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/todo] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可完整恢复`)
    }
    // ── 审计接线（P1-D §4）────────────────────────────────────────────────
    // 软用 store.appendAudit：拿不到/写失败 → 只 warn 一次 + 计数，绝不阻断主流程。
    if (storeAuditMissing) {
      diagnostics.auditWriteFailures += 1
      if (!diagnostics.auditWarnedOnce) {
        diagnostics.auditWarnedOnce = true
        warn('[cs-bots/todo] store.appendAudit 尚不可用 → 审计接线跳过；主流程不受影响')
      }
    } else {
      try {
        const digest = (t) => (t
          ? { id: t.id, track: t.track ?? null, rev: t.rev, status: t.status ?? null }
          : null)
        const result = storeAppendAudit(stateDir, {
          ts: at, actor: byId, action, target: todoId, before: digest(before), after: digest(after),
        })
        const failed = result === false || Boolean(result && typeof result === 'object' && result.ok === false)
        if (failed) {
          diagnostics.auditWriteFailures += 1
          if (!diagnostics.auditWarnedOnce) {
            diagnostics.auditWarnedOnce = true
            warn('[cs-bots/todo] store.appendAudit 返回失败——主流程不受影响')
          }
        }
      } catch (error) {
        diagnostics.auditWriteFailures += 1
        if (!diagnostics.auditWarnedOnce) {
          diagnostics.auditWarnedOnce = true
          warn(`[cs-bots/todo] store.appendAudit 抛错：${error?.message ?? error}——主流程不受影响`)
        }
      }
    }
    return after ? clone(after) : null
  }

  // ── 回放 ──────────────────────────────────────────────────────────────────

  /**
   * 旧版本/半损坏记录补齐字段（向后兼容，不改语义）。
   * 快照可能来自更早的版本；缺字段时补默认值，而不是让消费方拿到 undefined。
   * @param {object} raw
   * @returns {object|null}
   */
  function normalizeStoredRecord(raw) {
    if (!raw || typeof raw.id !== 'string' || raw.id.trim() === '') return null
    const record = clone(raw)
    if (!TRACKS.includes(record.track)) return null
    if (!STATUSES.includes(record.status)) record.status = 'pending'
    if (typeof record.content !== 'string') return null
    if (record.track === 'project') {
      if (typeof record.cwd !== 'string' || record.cwd === '') return null
      record.date = null
    } else if (record.track === 'daily') {
      if (typeof record.date !== 'string') return null
      record.cwd = null
    } else {
      record.cwd = null
      record.date = null
    }
    if (!QUADRANTS.includes(record.quadrant)) {
      record.quadrant = quadrantOfFlags(Boolean(record.important), Boolean(record.urgent))
    }
    const flags = flagsOfQuadrant(record.quadrant)
    record.important = flags.important
    record.urgent = flags.urgent
    record.due = typeof record.due === 'string' && DATE_RE.test(record.due) ? record.due : null
    record.cat = typeof record.cat === 'string' && record.cat !== '' ? record.cat : null
    record.doneAt = record.status === 'done' && Number.isFinite(record.doneAt) ? record.doneAt : null
    record.rev = Number.isFinite(record.rev) ? record.rev : 1
    record.createdAt = Number.isFinite(record.createdAt) ? record.createdAt : 0
    record.updatedAt = Number.isFinite(record.updatedAt) ? record.updatedAt : record.createdAt
    if (typeof record.createdBy !== 'string') record.createdBy = null
    if (typeof record.updatedBy !== 'string') record.updatedBy = null
    return record
  }

  /**
   * 从 `todo.jsonl`（真相源）重建内存态；jsonl 为空才回落到快照。
   * 坏行**不静默丢弃**：计入 diagnostics 并 warn。
   */
  function hydrate() {
    todos.clear()
    events.length = 0
    lastRev.clear()
    seenIds.clear()
    disposed = false

    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) {
      warn(`[cs-bots/todo] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }

    if (rows.length === 0) {
      const snap = readJson(snapPath, null)
      const list = Array.isArray(snap?.todos) ? snap.todos : null
      if (list) {
        for (const raw of list) {
          const record = normalizeStoredRecord(raw)
          if (!record) continue
          todos.set(record.id, record)
          lastRev.set(record.id, record.rev)
          seenIds.add(record.id)
        }
        if (Array.isArray(snap?.seenIds)) {
          for (const id of snap.seenIds) if (typeof id === 'string' && id) seenIds.add(id)
        }
        diagnostics.hydratedFrom = 'snapshot'
        info(`[cs-bots/todo] 回放完成：无事件流 → 由快照恢复 ${todos.size} 条待办`)
        return
      }
      diagnostics.hydratedFrom = 'empty'
      info('[cs-bots/todo] 回放完成：空库（无事件流、无快照）')
      return
    }

    // 事件流是真相源：只接受 rev 递增的事件（同 rev 重放幂等，容忍重复投递）
    let skipped = 0
    for (const ev of rows) {
      const id = typeof ev?.todoId === 'string' ? ev.todoId : ev?.after?.id
      if (typeof id !== 'string' || id === '') {
        skipped += 1
        continue
      }
      // 即便事件因非递增被跳过，也记下这个 id，防止随机 id 复用造成历史串号
      seenIds.add(id)
      const rev = Number.isFinite(ev?.rev) ? ev.rev : undefined
      const current = lastRev.get(id) ?? 0
      if (rev !== undefined && rev <= current) {
        skipped += 1
        continue
      }
      if (ev.after && ev.after.id === id) {
        const record = normalizeStoredRecord(ev.after)
        if (!record) {
          skipped += 1
          continue
        }
        todos.set(id, record)
        lastRev.set(id, rev ?? record.rev)
      } else if (ev.action === 'remove') {
        todos.delete(id)
        lastRev.set(id, rev ?? current + 1)
      } else {
        skipped += 1
        continue
      }
      events.push(clone(ev))
    }
    if (skipped > 0) {
      warn(`[cs-bots/todo] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }
    diagnostics.hydratedFrom = 'jsonl'
    info(`[cs-bots/todo] 回放完成：${rows.length} 条事件 → ${todos.size} 条待办`)
  }

  // ── 内部查询工具 ──────────────────────────────────────────────────────────

  /** 取记录或抛错。 */
  function mustGet(id, where) {
    const current = todos.get(id)
    if (!current) {
      throw new TodoError(
        `todo.${where}：条目不存在 id=${id}`,
        'TODO_NOT_FOUND',
        { id, where },
      )
    }
    return current
  }

  /**
   * 生成随机 id：`td-<8 hex>`。
   *
   * 为什么不像 board 那样用自增序号：待办是多端/多 Bot 高频写入的数据，
   * 自增序号要求"读全局最大值再写"，一旦两个实例并发就会撞号；
   * 随机 8 hex（4 字节）碰撞概率可忽略，且撞上时这里会重试 8 次后明确抛错。
   */
  function nextId() {
    for (let i = 0; i < 8; i += 1) {
      const candidate = `td-${randomBytes(4).toString('hex')}`
      if (!seenIds.has(candidate)) return candidate
    }
    throw new TodoError(
      'todo.create：连续 8 次生成随机 id 均与既有条目碰撞（状态库异常？）——拒绝写入以保证 id 唯一',
      'TODO_ID_COLLISION',
    )
  }

  /** 是否已结束（done / cancelled）。 */
  const isFinished = (t) => t.status === 'done' || t.status === 'cancelled'
  /** 是否"需要关注"的未完成状态。 */
  const isActive = (t) => ACTIVE_STATUSES.includes(t.status)
  /** 逾期：未完成且 due 早于今天（字符串比较即可，YYYY-MM-DD 字典序=时间序）。 */
  const isOverdue = (t, today) => isActive(t) && t.due !== null && t.due < today
  /** 今日到期。 */
  const isDueToday = (t, today) => isActive(t) && t.due === today
  /** 过往每日待办（date < 今天）。 */
  const isPastDaily = (t, today) => t.track === 'daily' && t.date !== null && t.date < today
  /**
   * 过往每日待办的"过期遗留"：未结束，且没有 due 或 due 已过。
   * 没有 due 的过往每日待办，其截止日就是所属那一天 → 必然过期。
   */
  const isPastExpired = (t, today) => isPastDaily(t, today) && !isFinished(t)
    && (t.due === null || t.due < today)

  // ── API：校验后写入 ────────────────────────────────────────────────────────

  /**
   * 新建待办。
   *
   * @param {{ track: string, cwd?: string, date?: string, content: string,
   *           quadrant?: string, important?: boolean, urgent?: boolean,
   *           due?: string|null, cat?: string|null, status?: string,
   *           by: string, now?: number }} input
   * @returns {object} Todo
   */
  function createTodo(input = {}) {
    assertAlive('createTodo')
    const byId = requireActor(input, 'create')
    const at = normalizeNow(input?.now, 'create')

    // 先做完所有校验再生成 id：校验失败绝不留下"幽灵 id"占用唯一性
    const binding = normalizeBinding(input, null, at, 'create')
    const content = normalizeContent(input?.content, 'create')
    const quadrantFields = normalizeQuadrantFields(input, null, 'create')
    const due = normalizeDue(input.due, null, 'create')
    const cat = normalizeCat(input.cat, null, 'create')
    // status 缺省 pending；但一旦给了就必须是合法值（给 ''/'all' 是调用方 bug，
    // 不能悄悄当成缺省 —— 那会让「拼错的写入」看起来成功了）
    const status = (input?.status === undefined || input?.status === null)
      ? 'pending'
      : normalizeStatus(input.status, 'create')

    const id = nextId()
    /** @type {Record<string, unknown>} */
    const record = {
      id,
      rev: 1,
      track: binding.track,
      cwd: binding.cwd,
      date: binding.date,
      content,
      quadrant: quadrantFields.quadrant,
      important: quadrantFields.important,
      urgent: quadrantFields.urgent,
      due,
      cat,
      status,
      // 创建即已完成时也要盖 doneAt，否则"完成时间"缺失会让统计口径分叉
      doneAt: status === 'done' ? at : null,
      createdAt: at,
      createdBy: byId,
      updatedAt: at,
      updatedBy: byId,
    }
    return commit(id, 'create', byId, at, null, record)
  }

  /**
   * 更新待办（字段补丁 + CAS）。
   *
   * @param {{ id: string, expectedRev: number, track?: string, cwd?: string, date?: string,
   *           content?: string, quadrant?: string, important?: boolean, urgent?: boolean,
   *           due?: string|null, cat?: string|null, status?: string,
   *           by: string, now?: number }} input
   * @returns {object} 更新后的 Todo
   */
  function updateTodo(input = {}) {
    assertAlive('updateTodo')
    const id = requireId(input?.id, 'update')
    const current = mustGet(id, 'update')
    const byId = requireActor(input, 'update')
    const at = normalizeNow(input?.now, 'update')
    // CAS 必须在任何字段归一/变更之前：conflict 时连"部分校验通过"的假象都不该出现
    assertExpectedRev(current, input?.expectedRev, 'update')

    const touched = PATCH_FIELDS.filter((field) => input?.[field] !== undefined)
    if (touched.length === 0) {
      throw new TodoError(
        `todo.update：没有任何可更新字段（可更新：${PATCH_FIELDS.join(' / ')}）——拒绝产生一条无意义的 rev 递增`,
        'TODO_EMPTY_UPDATE',
        { id, where: 'update' },
      )
    }

    const binding = normalizeBinding(input, current, at, 'update')
    const quadrantFields = normalizeQuadrantFields(input, current, 'update')

    /** @type {Record<string, unknown>} */
    const next = clone(current)
    next.track = binding.track
    next.cwd = binding.cwd
    next.date = binding.date
    if (input?.content !== undefined) next.content = normalizeContent(input.content, 'update')
    next.quadrant = quadrantFields.quadrant
    next.important = quadrantFields.important
    next.urgent = quadrantFields.urgent
    next.due = normalizeDue(input?.due, current, 'update')
    next.cat = normalizeCat(input?.cat, current, 'update')

    if (input?.status !== undefined && input?.status !== null) {
      const status = normalizeStatus(input.status, 'update')
      if (status !== current.status) {
        next.status = status
        // 进入 done 时盖章；离开 done（含 done→cancelled）清空，不留过期时间戳
        next.doneAt = status === 'done' ? at : null
      }
    }

    next.rev = current.rev + 1
    next.updatedAt = at
    next.updatedBy = byId
    return commit(id, 'update', byId, at, current, next)
  }

  /**
   * 删除待办（硬删，事件流里保留 before 快照可审计）。
   *
   * @param {{ id: string, expectedRev: number, by: string }} input
   * @returns {{ id: string, rev: number, removed: true }}
   */
  function removeTodo(input = {}) {
    assertAlive('removeTodo')
    const id = requireId(input?.id, 'remove')
    const current = mustGet(id, 'remove')
    const byId = requireActor(input, 'remove')
    const at = normalizeNow(input?.now, 'remove')
    assertExpectedRev(current, input?.expectedRev, 'remove')
    commit(id, 'remove', byId, at, current, null)
    return { id, rev: current.rev + 1, removed: true }
  }

  /**
   * 取单条（不存在返回 null，不抛 —— "查不到"是正常结果，不是错误）。
   * @param {string} id
   * @returns {object|null}
   */
  function getTodo(id) {
    assertAlive('getTodo')
    if (typeof id !== 'string' || id.trim() === '') return null
    const current = todos.get(id.trim())
    return current ? clone(current) : null
  }

  /**
   * 列出待办（支持智能视图）。
   *
   * 视图规则（**严格实现，勿简化**）：
   *   1. 缺省 = 智能视图：只列需要关注的未完成项
   *      （逾期 / 今日到期 / 本项目未完成 / life|work 的重要紧急 q1q2 / 今日每日待办），
   *      排序「逾期 → 今日到期 → 本项目 → q1 → q2 → q3 → q4」，最多 8 条。
   *   2. `status:'done'` 只看已完成；`all:true` 关掉智能过滤与 8 条上限（看全部状态）。
   *   3. 过往每日待办（date < 今天）默认隐藏；`past:true` 才纳入，
   *      且其中「未完成且过期」的遗留还要 `expired:true` 才出现（否则返回 hint 提醒）。
   *   4. project 轨按 cwd 隔离：带 cwd 只返回该目录的；不带 cwd 时 project 整体不出现
   *      （跨项目零泄露），显式 `track:'project'` 却不说 cwd → 抛错。
   *
   * @param {{ track?: string, cwd?: string, date?: string, status?: string,
   *           all?: boolean, past?: boolean, expired?: boolean, query?: string,
   *           limit?: number, now?: number }} [options]
   * @returns {{ items: object[], total: number, truncated: boolean, defaultView: boolean,
   *             today: string, hint: string|null }}
   */
  function listTodos(options = {}) {
    assertAlive('listTodos')
    const now = normalizeNow(options?.now, 'listTodos')
    const today = localDate(now)

    const track = given(options?.track) ? normalizeTrack(options.track, 'list') : undefined
    // `status:'all'` 是"我只想显式查询、不要智能视图"的开关（语义上不过滤状态）；
    // 因此必须单独记住"调用方到底给没给 status"，否则它会退化成缺省智能视图。
    const statusGiven = given(options?.status)
    const status = statusGiven && options.status !== 'all'
      ? normalizeStatus(options.status, 'list')
      : undefined
    const cwd = given(options?.cwd) ? normalizeCwd(options.cwd, 'list') : undefined
    const date = given(options?.date) ? parseDateString(options.date, 'date', 'list') : undefined
    const query = typeof options?.query === 'string' && options.query.trim() !== ''
      ? options.query.trim().toLowerCase()
      : undefined
    const all = options?.all === true
    const past = options?.past === true
    const expired = options?.expired === true

    let limit
    if (options?.limit !== undefined && options?.limit !== null) {
      if (!Number.isInteger(options.limit) || options.limit <= 0) {
        throw new TodoError(
          `todo.list：limit 必须是正整数（收到 ${JSON.stringify(options.limit)}）`,
          'TODO_BAD_FIELD',
          { field: 'limit', where: 'list' },
        )
      }
      limit = options.limit
    }

    // 显式 track:'project' 却不给 cwd：无法确定哪个项目，属于调用错误，不猜
    if (track === 'project' && cwd === undefined) {
      throw new TodoError(
        'todo.list：track=project 时必须给 cwd（项目待办按工作目录隔离，'
        + '不指定工作目录就无法判断该看哪个项目 —— 拒绝跨项目汇总泄露）',
        'TODO_CWD_REQUIRED',
        { field: 'cwd', where: 'list' },
      )
    }

    // 智能视图 = 没给任何"收窄意图"的参数；cwd 只是上下文（项目优先级），不算收窄
    const defaultView = !all && !past && track === undefined && !statusGiven
      && date === undefined && query === undefined

    /** 1) 范围过滤：轨绑定 + cwd 隔离 + 日期/历史窗口。 */
    const inScope = (t) => {
      if (track !== undefined && t.track !== track) return false
      if (t.track === 'project') {
        // 没有 cwd 的查询看不到项目待办（跨项目零泄露）
        if (cwd === undefined) return false
        if (t.cwd !== cwd) return false
      }
      if (t.track === 'daily') {
        if (date !== undefined) return t.date === date
        if (isPastDaily(t, today)) {
          // 过往每日待办：默认不看历史；past:true 才纳入，过期遗留还要 expired:true
          if (!past) return false
          if (!expired && isPastExpired(t, today)) return false
        }
        return true
      }
      // life / work 没有 date 字段；一旦按 date 查询，它们不匹配
      return date === undefined
    }

    /** 2) 状态 / 关键词过滤。 */
    const matches = (t) => {
      if (status !== undefined && t.status !== status) return false
      if (query !== undefined && !t.content.toLowerCase().includes(query)) return false
      return true
    }

    /** 3) 智能视图的"需要关注"过滤（只对缺省视图生效）。 */
    const needsAttention = (t) => {
      if (!isActive(t)) return false
      if (isOverdue(t, today) || isDueToday(t, today)) return true
      if (t.track === 'project') return true // cwd 已在 inScope 里匹配过
      if ((t.track === 'life' || t.track === 'work')
        && (t.quadrant === 'q1' || t.quadrant === 'q2')) return true
      if (t.track === 'daily') return true // 今天（或未来）的每日待办
      return false
    }

    let selected = []
    for (const t of todos.values()) {
      if (!inScope(t) || !matches(t)) continue
      if (defaultView && !needsAttention(t)) continue
      selected.push(t)
    }

    /** 4) 排序：逾期 → 今日到期 → 本项目 → q1 → q2 → q3 → q4 → 无象限 → 过往（垫底）。 */
    const rank = (t) => {
      if (isPastDaily(t, today)) return 9
      if (isOverdue(t, today)) return 0
      if (isDueToday(t, today)) return 1
      if (t.track === 'project') return 2
      if (t.quadrant === 'q1') return 3
      if (t.quadrant === 'q2') return 4
      if (t.quadrant === 'q3') return 5
      if (t.quadrant === 'q4') return 6
      return 7
    }
    selected.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      const pa = isPastDaily(a, today)
      const pb = isPastDaily(b, today)
      if (pa && pb) {
        // 历史：新的一天在前，同一天内新添加的在前
        if (a.date !== b.date) return a.date < b.date ? 1 : -1
        if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      }
      // due：有截止的在前、早的在前；无截止的垫底（'' 会让"没有截止"排最前，是反的）
      if (a.due !== b.due) {
        if (a.due === null) return 1
        if (b.due === null) return -1
        return a.due < b.due ? -1 : 1
      }
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    const total = selected.length
    // 8 条上限只约束"智能视图"；显式查询（track/status/past/all）默认全给，除非调用方自己传 limit
    let cap = defaultView ? SMART_VIEW_LIMIT : Infinity
    if (limit !== undefined) cap = Math.min(cap, limit)
    const items = selected.slice(0, cap).map((t) => clone(t))

    // 真实踩坑点：只带 past 不带 expired 会以为"昨天没待办"，这里显式点出来
    const hint = past && !expired
      ? '提示：过往每日待办中「未完成且已过期」的遗留默认隐藏；要查遗留任务请再调一次 list 并加 expired=true'
      : null

    return {
      items,
      total,
      truncated: total > items.length,
      defaultView,
      today,
      hint,
    }
  }

  // ── 统计 / 审计 / 生命周期 ─────────────────────────────────────────────────

  /**
   * 统计（给 /status 与 UI 概览用）。
   * @returns {{ total: number, active: number, done: number, overdue: number, dueToday: number,
   *             byTrack: object, byStatus: object, byQuadrant: object, events: number }}
   */
  function stats() {
    assertAlive('stats')
    const today = localDate(Date.now())
    const byTrack = { life: 0, work: 0, project: 0, daily: 0 }
    const byStatus = { pending: 0, doing: 0, done: 0, blocked: 0, cancelled: 0 }
    const byQuadrant = { q1: 0, q2: 0, q3: 0, q4: 0 }
    let active = 0
    let done = 0
    let overdue = 0
    let dueToday = 0
    for (const t of todos.values()) {
      byTrack[t.track] = (byTrack[t.track] ?? 0) + 1
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
      byQuadrant[t.quadrant] = (byQuadrant[t.quadrant] ?? 0) + 1
      if (t.status === 'done') done += 1
      if (isFinished(t)) continue
      active += 1
      if (isOverdue(t, today)) overdue += 1
      else if (isDueToday(t, today)) dueToday += 1
    }
    return {
      total: todos.size,
      active,
      done,
      overdue,
      dueToday,
      byTrack,
      byStatus,
      byQuadrant,
      events: events.length,
    }
  }

  /**
   * 审计流查询。
   * @param {string} [id] 省略则返回全部事件
   * @returns {object[]}
   */
  function history(id) {
    assertAlive('history')
    const rows = typeof id === 'string' && id !== ''
      ? events.filter((e) => e.todoId === id)
      : events
    return clone(rows)
  }

  /**
   * 从 `todo.jsonl` 重建内存态（重启回放一致性）。
   * @returns {{ from: string, todos: number, events: number, bad: number }}
   */
  function replay() {
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      todos: todos.size,
      events: events.length,
      bad: diagnostics.badLines,
    }
  }

  /**
   * 销毁实例（释放内存、拒绝后续调用）。
   * 为什么不写盘/不删文件：事件流是长期资产，dispose 只是「这个实例下班了」。
   * @returns {{ disposed: boolean, todos: number, events: number }}
   */
  function dispose() {
    const out = { disposed: true, todos: todos.size, events: events.length }
    disposed = true
    todos.clear()
    events.length = 0
    lastRev.clear()
    return out
  }

  /** 首次构造即回放，保证 `listTodos()` 在重启后马上可用。 */
  hydrate()

  const service = {
    name: cfg.name ?? 'todo',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    // 契约函数名（签名固定）
    createTodo,
    updateTodo,
    removeTodo,
    getTodo,
    listTodos,
    stats,
    replay,
    history,
    dispose,
    // 短别名：api/tools 层按 board 的 create/get/list 风格调用也能直接走
    create: createTodo,
    update: updateTodo,
    remove: removeTodo,
    get: getTodo,
    list: listTodos,
    diagnostics: () => clone(diagnostics),
  }
  return service
}

export default createTodo
