/**
 * cs-bots /api —— 宿主 HTTP 面（**给 L3 页面层用的数据接口**）。
 *
 * 为什么需要它：L2 域服务是宿主对象，浏览器里的客户端拿不到；
 * 页面必须有一条**稳定的读/写接口**。本文件就是那条接口。
 *
 * 设计纪律：
 *   - **零第三方依赖**：只用 node 内置 + kernel.registerRoute。
 *   - **不碰宿主内部实现**：所有业务都转调域服务（board/roster/room/memory/dispatcher）。
 *   - **缺服务降级**：域服务缺失时返回 503 + 可读原因（不是 500 崩）。
 *   - **写操作必须回显成败**：让页面能显示"为什么失败"，不静默。
 *   - **前缀路由**：`/cs-bots/api`（与包名一致，避免和其他插件撞路径）。
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, sep as pathSep } from 'node:path'
import { registerRoute, listPresets, defaultPreset, getAgent, resumeSession, readSessionMessages, attachToWorkspace, readSessionWatermark, sessionMeta } from './kernel.js'
import { createLibrary } from './library.js'
import { createDirBrowser } from './dirbrowse.js'
import { getServices } from './registry.js'
import { createFence } from './fence.js'
import { appendJsonl, readJsonl, statePath, backupState, migrate, readSchemaVersion, writeSchemaVersion } from './store.js'
import { deriveStage, attachStages, stageSummary } from './stage.js'
import { CMD_WHITELIST } from './verify.js'
import { execFile } from 'node:child_process'

/** 请求体上限（防大包打爆内存）。 */
const MAX_BODY = 2 * 1024 * 1024

/** API 前缀。 */
export const API_BASE = '/cs-bots/api'

/**
 * 模块级告警出口。
 *
 * `ensureLive()` 是模块级函数，拿不到 `installApi(ctx, { warn })` 里的 warn，
 * 但 preset 装配（`resumeSession` 内部）的降级告警必须能说出来 —— 所以在这里
 * 挂一个可变出口，由 `installApi` 在装配时注入（缺省静默，绝不抛）。
 */
let moduleWarn = () => {}

/**
 * 页面操作者身份。
 * 域服务用 `'user'` 表示「人类所有者 = 超级管理员」（见 room.js 的 USER 常量）。
 * 之前 API 传的是 `'ui'`，导致房间设置页一改就 `ROOM_NOT_MEMBER` —— 人类反而没权限。
 */
const OWNER = 'user'

/** 纪律层级与分类（前端下拉直接用，避免两边写死不一致）。 */
const DISCIPLINE_SCOPES = ['global', 'workspace', 'room', 'bot']
const DISCIPLINE_KINDS = ['rule', 'requirement', 'principle', 'style']

/** PDCA 复盘阶段（前端展示用；与 cycle.js 的 CYCLE_PHASES 逐字一致）。 */
const CYCLE_PHASES = ['planned', 'doing', 'checking', 'acting', 'done']
/** 需求4：周期类型——human=人跟长任务，agent=智能体事后归纳。 */
const CYCLE_KINDS = ['human', 'agent']

/** 团队类型与角色（前端展示用；与 teams.js 的 TEAM_TYPES/TEAM_ROLES 逐字一致）。 */
const TEAM_TYPES = ['big', 'small']
const TEAM_ROLES = ['lead', 'member']
/** 团队管理策略（与 teams.js 的 TEAM_ADMIN_POLICIES 逐字一致；页面下拉直接用）。 */
const TEAM_ADMIN_POLICIES = ['lead-only', 'any-member', 'open']

/**
 * 团队域错误 → HTTP 状态码。
 * 只有「无权管理团队」升级成 403（语义正确，且与 /teams/memory 的 403 口径一致）；
 * 其余 TEAM_* 保持历史口径 400；非团队错误原样抛出（503/500 不受影响）。
 */
function markTeamError(error) {
  if (error && typeof error.code === 'string' && error.code.startsWith('TEAM_')) {
    error.status = error.code === 'TEAM_FORBIDDEN' ? 403 : 400
  }
  throw error
}

/** 读请求体（JSON）。 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大（>2MB）')
    chunks.push(chunk)
  }
  if (!chunks.length) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : undefined
}

/** 回 JSON（不缓存）。 */
function sendJson(response, code, body) {
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body ?? null))
}

/** 从查询串取字符串参数。 */
function qp(url, name) {
  const v = url.searchParams.get(name)
  return v === null ? undefined : v
}

/** 从查询串取数字参数。 */
function qn(url, name) {
  const v = url.searchParams.get(name)
  if (v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 统一包装：域服务缺失 → 503；业务异常 → 400 带可读原因；其它 → 500。
 * @param {object} services
 * @param {string} key
 * @param {(svc: object) => Promise<object>|object} fn
 */
async function withService(services, key, fn) {
  const svc = services[key]
  if (!svc) {
    const error = new Error(`${key} 服务未装配（检查状态目录是否可写、宿主版本是否匹配）`)
    error.status = 503
    error.code = `${String(key).toUpperCase()}_UNAVAILABLE`
    throw error
  }
  return fn(svc)
}

/** 数据浏览：合法文件名/子目录（防目录穿越）。 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/** 判断是否是安全的单段路径（无 `..`、无分隔符）。 */
function safeSegment(value) {
  if (typeof value !== 'string' || value === '') return false
  if (value === '.' || value === '..') return false
  if (value.includes('..')) return false
  return SAFE_SEGMENT.test(value)
}

/** 把 artifacts 归一成字符串数组（对象用单行 JSON）。 */
function normalizeArtifactItems(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (item === null || item === undefined) continue
    if (typeof item === 'string') {
      const t = item.trim()
      if (t) out.push(t)
    } else if (typeof item === 'object') {
      try {
        out.push(JSON.stringify(item))
      } catch {
        out.push(String(item))
      }
    } else {
      out.push(String(item))
    }
  }
  return out
}

/** 任务状态集合（与 board.js STATUSES 同口径，删除态不参与）。 */
const GRAPH_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'deleted']


/**
 * 把 Bot 档案里的「预制记忆」同步进记忆服务（带 botId）。
 * 建 Bot 与改档案两处都要调用 —— 否则会出现"AGENTS.md 有、记忆库里没有"的不一致。
 * @param {object} services
 * @param {{ id: string, profile?: object }} bot
 * @param {string} by
 * @returns {{ added: number, failed: object[] } | undefined}
 */
function seedBotMemory(services, bot, by) {
  const seed = Array.isArray(bot?.profile?.memory) ? bot.profile.memory : []
  if (!services.memory || seed.length === 0) return undefined
  const added = []
  const failed = []
  for (const content of seed) {
    try {
      const entry = services.memory.add({
        layer: 'L2',
        content: String(content).slice(0, 600),
        by,
        source: 'explicit',
        botId: bot.id,
      })
      const id = Array.isArray(entry) ? entry[0]?.id : entry?.id
      if (id) added.push(id)
    } catch (error) {
      failed.push({ content: String(content).slice(0, 40), reason: error?.message ?? String(error) })
    }
  }
  return { added: added.length, failed }
}

/**
 * 把一条建议**真正写进目标域**（建议确认制的"采纳"落地）。
 *
 * 为什么放在 api 层而不是 suggest.js：`suggest.js` 刻意不 import memory/library/discipline，
 * 避免循环依赖与越界写入。真正的写库动作由调用方以回调注入 —— 就是这里。
 *
 * 任一步抛错都会向上抛：`suggest.accept` 收到异常后会把该条**保持 pending**
 * 并记 `lastError`，绝不静默标记成"已采纳"。
 *
 * @param {object} services
 * @param {{ kind: string, layer?: string, payload?: object }} suggestion
 * @param {string} by
 */
function applySuggestion(services, suggestion, by) {
  const kind = suggestion?.kind
  const payload = suggestion?.payload ?? {}

  // ⚠️ 必须是**同步**函数：suggest.accept 的 apply 回调若返回 Promise，
  //   它会在真正落库前就把状态标成 accepted（假采纳）。而这里要写的三个域服务
  //   （memory / library / discipline）全部是同步内存写 + 同步落盘，所以可以同步完成。
  const need = (key) => {
    const svc = services?.[key]
    if (!svc) {
      const error = new Error(`${key} 服务未装配，无法落地这条建议`)
      error.code = `${String(key).toUpperCase()}_UNAVAILABLE`
      throw error
    }
    return svc
  }

  if (kind === 'memory') {
    const entry = need('memory').add({
      layer: suggestion.layer ?? payload.layer ?? 'L4',
      content: payload.content,
      tags: payload.tags,
      by,
      cwd: payload.cwd,
    })
    return { kind, id: Array.isArray(entry) ? entry[0]?.id : entry?.id }
  }
  if (kind === 'skill') {
    const skill = need('library').createSkill({
      name: payload.name,
      description: payload.description,
      body: payload.body,
      tags: payload.tags,
      by,
    })
    return { kind, id: skill?.id }
  }
  if (kind === 'discipline') {
    const item = need('discipline').createDiscipline({
      scope: payload.scope,
      scopeId: payload.scopeId,
      kind: payload.disciplineKind ?? payload.kind ?? 'rule',
      title: payload.title,
      content: payload.content,
      priority: payload.priority,
      by,
    })
    return { kind, id: item?.id }
  }
  throw new Error(`applySuggestion：未知建议类型 ${JSON.stringify(kind)}（拒绝静默忽略）`)
}

// ══════════════════════════════════════════════════════════════════════════════
// bots改造04：任务目标锚（objective anchor）与直发消息
//
// 设计依据：`design/CONTRACT-bots04.md` §2（**已冻结**，字段名/文案格式/状态码逐字照做）。
// 为什么需要：长任务几十轮后容易「目标漂移」。每次唤醒 Bot 都带**全量目标原文**，
// 补充说明只追加（task-notes.jsonl，append-only）、永不覆盖目标，从机制上防漂移。
// ══════════════════════════════════════════════════════════════════════════════

/** 目标锚文案的固定标题（契约 §2.1 原文，逐字不可改）。 */
const ANCHOR_TITLE = '【任务目标 · 原文锚定，禁止改写】'
/** 补充说明落盘文件（新建；append-only，一行一条）。 */
const TASK_NOTES_FILE = 'task-notes.jsonl'
/** 补充说明 / 直发消息正文长度上限（契约 §2.2 / §2.4：trim 后 1–4000）。 */
const ANCHOR_TEXT_MAX = 4000

/** 取状态目录（board 优先，roster 兜底；都没有返回 undefined）。 */
function anchorStateDir(services) {
  return services?.board?.paths?.stateDir ?? services?.roster?.paths?.stateDir
}

/** 补充说明文件路径（状态目录缺失时 undefined）。 */
function taskNotesPath(services) {
  const dir = anchorStateDir(services)
  return dir ? statePath(dir, TASK_NOTES_FILE) : undefined
}

/**
 * 把时间戳格式化成人类可读的本地时间（`YYYY-MM-DD HH:mm:ss`）。
 * 契约只写 `<时间>` 占位符，未冻结具体格式；这里选无 locale 依赖的固定格式，
 * 保证跨环境稳定、可被测试断言。
 */
function formatAnchorTime(at) {
  const n = Number(at)
  if (!Number.isFinite(n)) return '未知时间'
  const d = new Date(n)
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 逗号拼接；空数组返回契约规定的占位文案。 */
function joinAnchorList(list, emptyText) {
  const items = Array.isArray(list) ? list.filter((x) => x !== null && x !== undefined && String(x).trim() !== '').map(String) : []
  return items.length ? items.join(',') : emptyText
}

/**
 * 从任务快照里抽出「目标锚」（契约 §2.1 的 `anchor` 结构）。
 * 字段恒定出现（前端直接渲染，不判 undefined）；unknown 值给安全默认。
 * @param {object} task
 */
function buildTaskAnchor(task) {
  return {
    subject: task?.subject ?? '',
    description: task?.description ?? '',
    writeScopes: Array.isArray(task?.writeScopes) ? [...task.writeScopes] : [],
    blockedBy: Array.isArray(task?.blockedBy) ? [...task.blockedBy] : [],
    priority: task?.priority ?? 0,
    status: task?.status,
    ownerId: task?.ownerId ?? null,
    progress: task?.progress ?? 0,
    artifacts: normalizeArtifactItems(task?.artifacts),
    createdAt: task?.createdAt,
    // 授权留痕（改造08）：随锚定文本一起下发给执行者
    mandate: task?.mandate ?? null,
  }
}

/** 读某任务的全部补充说明（按 `at` 升序；坏行由 readJsonl 计入 bad，不静默崩）。 */
function readTaskNotes(services, taskId) {
  const file = taskNotesPath(services)
  if (!file) return []
  const { rows } = readJsonl(file)
  return rows
    .filter((row) => row && row.taskId === taskId)
    .map((row) => ({ id: row.id, text: row.text, by: row.by ?? 'ui', at: row.at }))
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
}

/** 生成下一个补充说明编号 `n-<seq>`（append-only 文件内全局递增，绝不复用）。 */
function nextTaskNoteId(rows) {
  let max = 0
  for (const row of rows) {
    const m = /^n-(\d+)$/.exec(String(row?.id ?? ''))
    if (!m) continue
    const n = Number(m[1])
    if (Number.isFinite(n) && n > max) max = n
  }
  // 契约允许「已读行数+1」；同时取两者最大值，防止删行/坏行导致编号重复。
  return `n-${Math.max(max + 1, rows.length + 1)}`
}

// ══════════════════════════════════════════════════════════════════════════════
// bots改造06：任务变更中心（重开纠错 / 派生优化单 / 转长任务 / 换负责人）
//
// 设计依据：`design/CONTRACT-bots06.md` §2（**已冻结**）。
// 根因：`board.reopen` 会**清空** `artifacts` / `acceptance` / `completedAt`
// （内核行为，board.js 冻结不能改），所以变更**前**必须先把「当时的样子」快照进
// `task-meta.jsonl`（append-only）—— 这是「纠错不丢证据」的唯一保障，同时充当
// 变更历史与长任务标记。
// ══════════════════════════════════════════════════════════════════════════════

/** 任务变更元数据文件（新建；append-only，一行一条）。 */
const TASK_META_FILE = 'task-meta.jsonl'
/** 变更说明长度上限（契约 §2.2：trim 后 1–4000）。 */
const EVOLVE_NOTE_MAX = ANCHOR_TEXT_MAX
/** evolve 支持的三种变更模式（契约 §2.2）。 */
const EVOLVE_MODES = ['reopen', 'followup', 'longrun']
/** 长任务阶段数上限 / 单项长度上限（契约 §2.2 longrun）。 */
const LONGRUN_PHASES_MAX = 12
const LONGRUN_PHASE_MAX = 200
/** 长任务未给 phases 时的默认三阶段（契约 §2.2 longrun）。 */
const LONGRUN_DEFAULT_PHASES = ['范围与验收标准确认', '执行与自测', '交付与复盘']

/** task-meta.jsonl 路径（状态目录缺失时 undefined）。 */
function taskMetaPath(services) {
  const dir = anchorStateDir(services)
  return dir ? statePath(dir, TASK_META_FILE) : undefined
}

/**
 * 读某任务的全部变更记录（按 `at` 升序；同一毫秒按落盘顺序稳定排序）。
 * 坏行由 readJsonl 计入 bad，不静默崩。
 * @param {object} services
 * @param {string} taskId
 * @returns {object[]}
 */
function readTaskMeta(services, taskId) {
  const file = taskMetaPath(services)
  if (!file) return []
  const { rows } = readJsonl(file)
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row && typeof row === 'object' && row.taskId === taskId)
    .sort((a, b) => (Number(a.row.at) || 0) - (Number(b.row.at) || 0) || a.index - b.index)
    .map(({ row }) => row)
}

/**
 * 追加一条变更记录。
 * 落盘失败**必须抛 503**：静默丢历史 = 丢证据，是本平台最忌讳的失败方式。
 * @param {object} services
 * @param {object} record
 */
function appendTaskMeta(services, record) {
  const file = taskMetaPath(services)
  if (!file) {
    const error = new Error('状态目录不可用（task-meta.jsonl 无法落盘）')
    error.status = 503
    throw error
  }
  if (!appendJsonl(file, record)) {
    const error = new Error(`变更记录落盘失败（${file}）`)
    error.status = 503
    throw error
  }
  return record
}

/** 取某任务最近一条 `kind:'longrun'` 记录（没有则 undefined）。 */
function readLongrunMeta(services, taskId) {
  const rows = readTaskMeta(services, taskId).filter(
    (row) => row.kind === 'longrun' && Array.isArray(row.phases),
  )
  return rows.length ? rows[rows.length - 1] : undefined
}

/** 把 longrun 记录 / phases 数组归一成非空阶段清单。 */
function longrunPhaseList(longrun) {
  const list = Array.isArray(longrun)
    ? longrun
    : (Array.isArray(longrun?.phases) ? longrun.phases : [])
  return list
    .filter((phase) => typeof phase === 'string' && phase.trim() !== '')
    .map((phase) => phase.trim())
}

/**
 * 归一化长任务阶段清单（**创建与 evolve 共用的单一真相**）。
 *
 * 为什么抽出来：创建时长任务和「事后转长任务」是同一份数据结构，
 * 校验规则（上限 12 项 / 单项 200 字 / 不许空白）必须只有一处 ——
 * 两处各写一遍，早晚会漂移成「创建的能过、转的不能过」这种鬼故事。
 *
 * @param {unknown} raw phases 数组（undefined/null/[] ⇒ 默认三阶段）
 * @param {string} code 报错时用的错误码（区分调用方）
 * @returns {string[]}
 */
function normalizePhases(raw, code = 'EVOLVE_BAD_PHASES') {
  const failPhases = (message) => {
    const error = new Error(message)
    error.status = 400
    error.code = code
    return error
  }
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return [...LONGRUN_DEFAULT_PHASES]
  }
  if (!Array.isArray(raw)) throw failPhases('phases 必须是字符串数组')
  if (raw.length > LONGRUN_PHASES_MAX) {
    throw failPhases(`phases 最多 ${LONGRUN_PHASES_MAX} 项（收到 ${raw.length} 项）`)
  }
  return raw.map((phase, index) => {
    if (typeof phase !== 'string') throw failPhases(`phases[${index}] 必须是字符串（收到 ${JSON.stringify(phase)}）`)
    const text = phase.trim()
    if (!text) throw failPhases(`phases[${index}] 不能为空`)
    if (text.length > LONGRUN_PHASE_MAX) {
      throw failPhases(`phases[${index}] 过长（最多 ${LONGRUN_PHASE_MAX} 字，收到 ${text.length} 字）`)
    }
    return text
  })
}

// ══════════════════════════════════════════════════════════════════════════
// 升级09 · 阶段产出物（契约 §2.2 / §2.3 / §4.2）
//
// 一句话：长任务的阶段清单存在 `kind:'longrun'` 行里，执行者每交一个阶段的
// 产出物就追加一条 `kind:'phase'` 行。清单与产物**分开存**是刻意的——
// Boss 改阶段清单（§4.2）不该动已经交出来的证据。
// ══════════════════════════════════════════════════════════════════════════

/** 阶段状态（写入端合法值；读取端另有 `pending` = 「未开始」，见 buildPhaseView）。 */
const PHASE_STATES = ['doing', 'done', 'blocked']
/** 单阶段产出物条数上限 / 单项长度上限（契约 §2.3）。 */
const PHASE_ARTIFACTS_MAX = 50
const PHASE_ARTIFACT_MAX = 2000
/** 阶段说明长度上限（契约未写死，取与产出物同档的保守值）。 */
const PHASE_NOTE_MAX = 2000

/**
 * 构造一个带 HTTP 状态码的错误（HTTP 与工具面共用同一份，**不写两套判定**）。
 * @param {string} message @param {number} status @param {string} code
 */
function phaseError(message, status, code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/**
 * 归一化单阶段的产出物清单（契约 §2.3）。
 *
 * 规则：去空、去重、最多 50 项、每项 ≤ 2000 字。
 * **超限选择报错而不是静默截断**：产出物是证据，悄悄丢掉一条比拒绝写入更糟。
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizePhaseArtifacts(list) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) {
    throw phaseError('artifacts 必须是字符串数组（也可以不传）', 400, 'PHASE_BAD_ARTIFACTS')
  }
  const items = normalizeArtifactItems(list)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (items.length > PHASE_ARTIFACTS_MAX) {
    throw phaseError(
      `artifacts 最多 ${PHASE_ARTIFACTS_MAX} 项（收到 ${items.length} 项）——请合并或分批汇报`,
      400,
      'PHASE_BAD_ARTIFACTS',
    )
  }
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (Array.from(item).length > PHASE_ARTIFACT_MAX) {
      throw phaseError(
        `artifacts 单项最多 ${PHASE_ARTIFACT_MAX} 字（收到 ${Array.from(item).length} 字）——请放路径/链接，不要塞整篇内容`,
        400,
        'PHASE_BAD_ARTIFACTS',
      )
    }
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 读某任务的阶段产出物行（按 `at` 升序；同 index 后写的胜出）。 */
function readPhaseRows(services, taskId) {
  const rows = readTaskMeta(services, taskId).filter(
    (row) => row.kind === 'phase'
      && Number.isInteger(row.index)
      && row.index >= 0,
  )
  const byIndex = new Map()
  for (const row of rows) byIndex.set(row.index, row) // 顺序已按 at 升序 ⇒ 后写覆盖前写
  return byIndex
}

/**
 * 拼出契约 §2.2 的完整视图（HTTP 读端点与写端点的回填共用同一份）。
 *
 * @param {object} services
 * @param {object} task board 任务快照
 * @returns {{ taskId: string, phases: object[], currentIndex: number,
 *             totalArtifacts: number, isLongrun: boolean, note: string }}
 */
function buildPhaseView(services, task) {
  const longrun = readLongrunMeta(services, task.id)
  const titles = longrunPhaseList(longrun)
  const isLongrun = Boolean(longrun)
  if (!isLongrun) {
    return {
      taskId: task.id,
      phases: [],
      currentIndex: 0,
      totalArtifacts: 0,
      isLongrun: false,
      note: '这不是长任务，没有分阶段产物；总产出物见下方',
    }
  }
  const byIndex = readPhaseRows(services, task.id)
  // 只剩「清单里还存在的下标」：Boss 把清单改短后，越界的旧产物行**保留但不展示**
  // （契约 §4.2 —— 不删证据，只是不再显示）。
  const phases = titles.map((title, index) => {
    const row = byIndex.get(index)
    return {
      index,
      title,
      // 没汇报过的阶段给 `pending`（UI 徽标「未开始」）—— 不伪造成 doing/done
      state: PHASE_STATES.includes(row?.state) ? row.state : 'pending',
      artifacts: Array.isArray(row?.artifacts) ? [...row.artifacts] : [],
      note: typeof row?.note === 'string' ? row.note : '',
      by: typeof row?.by === 'string' ? row.by : null,
      at: Number.isFinite(Number(row?.at)) ? Number(row.at) : null,
    }
  })
  const firstUnfinished = phases.findIndex((phase) => phase.state !== 'done')
  const totalArtifacts = phases.reduce((sum, phase) => sum + phase.artifacts.length, 0)
  const doneCount = phases.filter((phase) => phase.state === 'done').length
  return {
    taskId: task.id,
    phases,
    currentIndex: firstUnfinished === -1 ? phases.length : firstUnfinished,
    totalArtifacts,
    isLongrun: true,
    note: `长任务共 ${phases.length} 个阶段，已完成 ${doneCount} 个；共 ${totalArtifacts} 个阶段产出物`,
  }
}

/**
 * 写一条阶段产出物（契约 §2.3）。
 *
 * **单一实现**：HTTP `POST /tasks/phase` 与工具 `bot_task_phase`（C 的 tools.js）
 * 都走这里 —— 两处各写一遍，早晚漂移成「页面能写、Bot 写不进」这种鬼故事。
 *
 * @param {object} services 域服务集合（需 board）
 * @param {string} taskId
 * @param {{ index: number, state?: string, artifacts?: string[], note?: string,
 *           by?: string, expectedRev?: number }} patch
 * @returns {{ ok: true, taskId: string, phase: object, phases: object[],
 *             currentIndex: number, totalArtifacts: number, isLongrun: boolean }}
 */
function writePhaseRow(services, taskId, patch = {}) {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw phaseError('id 必填（任务 id，如 t-36）', 400, 'PHASE_MISSING_ID')
  }
  const id = taskId.trim()
  const board = services?.board
  if (!board || typeof board.get !== 'function') {
    throw phaseError('board 服务未装配（无法校验任务与阶段清单）', 503, 'BOARD_UNAVAILABLE')
  }
  const task = board.get(id)
  if (!task) throw phaseError(`任务 ${id} 不存在`, 404, 'PHASE_TASK_NOT_FOUND')

  const longrun = readLongrunMeta(services, id)
  const titles = longrunPhaseList(longrun)
  if (!longrun || titles.length === 0) {
    throw phaseError(
      `任务 ${id} 不是长任务（没有阶段清单）——请先在「转长任务」里定阶段，或用「编辑阶段清单」设置`,
      400,
      'PHASE_NOT_LONGRUN',
    )
  }

  // ── CAS（可选）：给了 expectedRev 就必须对得上，不匹配绝不静默覆盖 ──
  if (patch.expectedRev !== undefined && patch.expectedRev !== null) {
    if (!Number.isInteger(patch.expectedRev)) {
      throw phaseError(`expectedRev 必须是整数（当前 rev=${task.rev}）`, 400, 'PHASE_BAD_FIELD')
    }
    if (patch.expectedRev !== task.rev) {
      throw phaseError(
        `CAS 冲突：任务 ${id} 期望 rev=${patch.expectedRev}，实际 rev=${task.rev} —— 拒绝静默覆盖，请刷新后重试`,
        409,
        'PHASE_REV_CONFLICT',
      )
    }
  }

  const index = patch.index
  if (!Number.isInteger(index)) {
    throw phaseError(`index 必须是整数（当前合法范围 0..${titles.length - 1}）`, 400, 'PHASE_BAD_INDEX')
  }
  if (index < 0 || index > titles.length - 1) {
    throw phaseError(
      `index=${index} 越界：合法范围是 0..${titles.length - 1}`
        + `（当前阶段清单共 ${titles.length} 个阶段：${titles.map((t, i) => `${i}=${t}`).join('；')}）`,
      400,
      'PHASE_BAD_INDEX',
    )
  }

  const state = patch.state === undefined || patch.state === null ? 'done' : patch.state
  if (!PHASE_STATES.includes(state)) {
    throw phaseError(
      `state=${JSON.stringify(patch.state)} 非法（合法：${PHASE_STATES.join(' | ')}）`,
      400,
      'PHASE_BAD_STATE',
    )
  }

  const artifacts = normalizePhaseArtifacts(patch.artifacts)
  let note = ''
  if (patch.note !== undefined && patch.note !== null) {
    if (typeof patch.note !== 'string') {
      throw phaseError('note 必须是字符串（也可以不传）', 400, 'PHASE_BAD_NOTE')
    }
    note = patch.note.trim()
    if (Array.from(note).length > PHASE_NOTE_MAX) {
      throw phaseError(`note 最多 ${PHASE_NOTE_MAX} 字（收到 ${Array.from(note).length} 字）`, 400, 'PHASE_BAD_NOTE')
    }
  }
  const by = typeof patch.by === 'string' && patch.by.trim() ? patch.by.trim() : 'ui'
  const at = Date.now()

  // 落盘失败 ⇒ appendTaskMeta 抛 503（**绝不静默丢证据**）
  appendTaskMeta(services, { kind: 'phase', taskId: id, index, state, artifacts, note, by, at })

  const view = buildPhaseView(services, task)
  return { ok: true, taskId: id, phase: view.phases[index], phases: view.phases,
    currentIndex: view.currentIndex, totalArtifacts: view.totalArtifacts, isLongrun: view.isLongrun }
}

/** 变更**前**的任务快照（契约 §2.2 reopen 步骤 1）。 */
function buildTaskSnapshot(task) {
  return {
    kind: 'snapshot',
    taskId: task.id,
    at: Date.now(),
    before: {
      status: task.status,
      artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
      acceptance: task.acceptance === undefined ? null : task.acceptance,
      completedAt: task.completedAt ?? null,
      progress: task.progress ?? 0,
      ownerId: task.ownerId ?? null,
    },
  }
}

/** 追加一条补充说明（append-only；长任务说明与 /tasks/note 共用同一份文件与编号规则）。 */
function appendTaskNoteRow(services, taskId, text, by) {
  const file = taskNotesPath(services)
  if (!file) {
    const error = new Error('状态目录不可用（task-notes.jsonl 无法落盘）')
    error.status = 503
    throw error
  }
  const { rows } = readJsonl(file)
  const note = { id: nextTaskNoteId(rows), taskId, text, by, at: Date.now() }
  if (!appendJsonl(file, note)) {
    const error = new Error(`补充说明落盘失败（${file}）`)
    error.status = 503
    throw error
  }
  return note
}

/**
 * 按契约 §2.2 的 reopen 流程：**先快照** → 再调内核 reopen → 记一条 reopen。
 *
 * 已 pending 且无租约时内核抛 `BOARD_NOTHING_TO_REOPEN` —— 契约明确「视为成功」，
 * 不能把用户点「重开」当成报错（任务本来就是可做的）。
 */
async function reopenWithSnapshot(services, task, by, note) {
  const snapshot = appendTaskMeta(services, buildTaskSnapshot(task))
  let after = task
  try {
    after = await withService(services, 'board', (b) => b.update({
      id: task.id,
      expectedRev: task.rev,
      action: 'reopen',
      byId: by,
    }))
  } catch (error) {
    if (error?.code !== 'BOARD_NOTHING_TO_REOPEN') throw error
    after = (await withService(services, 'board', (b) => b.get(task.id))) ?? task
  }
  const change = appendTaskMeta(services, {
    kind: 'reopen', taskId: task.id, note, by, at: Date.now(),
  })
  return { task: after, snapshot, change }
}

/** 派生任务标题前缀（契约 §2.2 followup：修复 > 优化 > 变更，先命中先算）。 */
function evolvePrefixFor(note) {
  if (/错|缺陷|bug|修复/i.test(note)) return '【修复】'
  if (/优化|提升|改进/.test(note)) return '【优化】'
  return '【变更】'
}

/**
 * 生成契约 §2.1 的固定锚定文案（**前端只展示/复制，不得改写**）。
 *
 * 固定格式（逐行）：
 * ```
 * 【任务目标 · 原文锚定，禁止改写】
 * 任务 <id>：<subject>
 * 目标：<description 原文；为空则（未填写）>
 * 边界：只改 <writeScopes 逗号拼接；为空则（未限定）>
 * 前置：<blockedBy 逗号拼接；为空则（无）>
 * 进度：<progress>%
 * 已交付：<artifacts 逗号拼接；为空则（暂无）>
 * 补充说明（按时间，全部有效，不得忽略）：
 * - [<时间>] <text>
 * ```
 *
 * 改造06 追加（契约 bots06 §2.4，**只加不改**）：该任务在 `task-meta.jsonl` 里有
 * `kind:'longrun'` 记录时，在「补充说明」**之前**插入阶段清单：
 * ```
 * 阶段（长任务，按序推进，不得跳步）：
 * 1. <phase1>
 * 2. <phase2>
 * ```
 * 没有 longrun 记录时输出**逐字不变**（既有测试对文案有逐行断言）。
 *
 * @param {object} task
 * @param {{ at: number, text: string }[]} [notes]
 * @param {{ phases?: string[] } | string[]} [longrun] 该任务的 longrun 记录（或阶段数组）
 * @returns {string}
 */
/**
 * 把 `task.mandate` 翻译成人话（改造08 · 借鉴 superagent Mandate）。
 *
 * 三条纪律：
 *   1. **缺省不编造**：没有 mandate 就返回空数组，绝不说「用户已授权」；
 *   2. **依据要写清楚**：`explicit`（人明确点名）和 `inferred`（按规则推断）
 *      对人的意义完全不同，必须能分辨；
 *   3. **不承诺越权**：明说「超出范围要重新要授权」——
 *      mandate 是「此刻已被要求什么」，不是「随便干」。
 *
 * @param {object|undefined} mandate
 * @returns {string[]}
 */
function describeMandate(mandate) {
  if (!mandate || typeof mandate !== 'object') return []
  const lines = []
  const sender = typeof mandate.sender === 'string' && mandate.sender.trim() ? mandate.sender.trim() : ''
  const BASIS_TEXT = {
    explicit: '人明确点名要做（最强 —— 可以直接动手）',
    inferred: '按规则推断（**推断，动手前先确认**）',
    'task-board': '任务板派发（管理面正式派活）',
    room: '房间里的指令',
    cycle: '周期复盘产物',
  }
  const basis = typeof mandate.basis === 'string' ? mandate.basis : ''
  if (basis && BASIS_TEXT[basis]) {
    lines.push(`- 依据：${BASIS_TEXT[basis]}`)
  }
  if (sender) lines.push(`- 下达者：${sender}`)
  if (typeof mandate.policyVersion === 'string' && mandate.policyVersion) {
    lines.push(`- 规则版本：${mandate.policyVersion}`)
  }
  if (typeof mandate.scope === 'string' && mandate.scope) {
    lines.push(`- 范围：${mandate.scope}`)
  }
  return lines
}

function buildTaskAnchorText(task, notes = [], longrun = null) {
  const anchor = buildTaskAnchor(task)
  const desc = typeof anchor.description === 'string' ? anchor.description : ''
  const lines = [
    ANCHOR_TITLE,
    `任务 ${task?.id}：${anchor.subject}`,
    `目标：${desc.trim() ? desc : '（未填写）'}`,
    `边界：只改 ${joinAnchorList(anchor.writeScopes, '（未限定）')}`,
    `前置：${joinAnchorList(anchor.blockedBy, '（无）')}`,
    `进度：${anchor.progress}%`,
    `已交付：${joinAnchorList(anchor.artifacts, '（暂无）')}`,
  ]
  const phases = longrunPhaseList(longrun)
  if (phases.length > 0) {
    lines.push('阶段（长任务，按序推进，不得跳步）：')
    phases.forEach((phase, index) => lines.push(`${index + 1}. ${phase}`))
  }
  // ── 授权留痕（改造08 · 借鉴 superagent Mandate）────────────────────────
  // 执行者被唤醒时必须知道：**这活是谁批的、凭什么**。
  // 少了这一行，「我自己猜用户想要」和「用户明确要我干」看起来一模一样 ——
  // 而那正是失控与越权的分界线。
  //
  // ⚠️ 但**没有 basis 就不渲染**：UI 随手建的任务记的是 `{ sender: 'ui' }`，
  //    那是「谁建的」，不是「谁授权的」。把它渲染成「授权」等于编造授权 ——
  //    正是这套纪律要防的。只有记录了明确依据（explicit/inferred/task-board…）
  //    才说明这确实是一份授权。
  const mandate = anchor.mandate
  if (mandate && typeof mandate === 'object' && typeof mandate.basis === 'string' && mandate.basis) {
    lines.push('授权（谁批准的、凭什么 —— 超出此授权范围的新需求要重新要授权）：')
    lines.push(...describeMandate(mandate))
  }

  lines.push('补充说明（按时间，全部有效，不得忽略）：')
  for (const note of notes) {
    lines.push(`- [${formatAnchorTime(note?.at)}] ${note?.text ?? ''}`)
  }
  return lines.join('\n')
}

// ══════════════════════════════════════════════════════════════════════════════
// 来源跳转（契约 bots04 §2.5，2026-11-07 补）
//
// `sourceSeq` 是任务的**幂等键**，顺带承载「这个任务是从哪儿来的」。
// 契约冻结的三类前缀：
//   `room:<roomId>:<seq>` → 房间消息出处（可跳回房间定位那条消息）
//   `todo:<id>`           → 待办（room/jump 均为 null）
//   `evolve:<id>:<seq>`   → 变更派生（room/jump 均为 null）
// 判定顺序**按前缀逐字匹配**，不做模糊猜测：匹配不上就 `unparsed`，
// 把原始标记如实返回，由前端提示「来源已失效」。
// ══════════════════════════════════════════════════════════════════════════════

/** 来源消息正文预览的截断长度（契约 §2.5：首行截 80 字，与 §3.4 建任务时取标题同口径）。 */
const SOURCE_PREVIEW_MAX = 80

/**
 * 解析 `sourceSeq` 的前缀（契约 §2.5 的判定顺序）。
 *
 * 返回 `null` 表示「匹配不上任何已知前缀」（→ 后端判 `unparsed`）。
 * 注意 `room:<roomId>:<seq>` 的三段切分是安全的：房间 id 恒为 `room-<uuid8>`
 * （`src/room.js:1032`），**内部不含冒号**；测试里也固化这一点，防止将来
 * 改 id 规则时被静默误判。
 *
 * @param {string} sourceSeq
 * @returns {{ kind: 'room'|'todo'|'evolve', roomId?: string, seq?: number } | null}
 */
function parseSourceSeq(sourceSeq) {
  if (typeof sourceSeq !== 'string' || sourceSeq === '') return null
  const parts = sourceSeq.split(':')
  if (parts.length === 3 && parts[0] === 'room' && parts[1] !== '' && parts[2] !== '') {
    // 「seq 为正整数」的判定：字符串必须**全是数字**且数值 > 0。
    // 用 `^\d+$` 而不是 `Number.isInteger(Number(...))`：后者会把 `"7.0"`、
    // `"1e2"`、`"0x10"` 之类全收进来，语义含糊；前者只认十进制正整数字面量
    // （`"07"` 仍是数值 7，允许），把格式残缺的形态留给 `unparsed` 如实上报。
    if (/^\d+$/.test(parts[2]) && Number(parts[2]) > 0) {
      return { kind: 'room', roomId: parts[1], seq: Number(parts[2]) }
    }
    return null
  }
  if (parts.length === 2 && parts[0] === 'todo' && parts[1] !== '') {
    return { kind: 'todo' }
  }
  if (parts.length === 3 && parts[0] === 'evolve' && parts[1] !== '' && parts[2] !== '') {
    return { kind: 'evolve' }
  }
  return null
}

/** 来源消息正文 → 预览（首行截 80 字；与 §3.4 建任务时取标题的口径一致）。 */
function sourcePreview(message) {
  const body = typeof message?.body === 'string' ? message.body : message?.text ?? ''
  const firstLine = body.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
  return firstLine.slice(0, SOURCE_PREVIEW_MAX)
}

/**
 * 组装来源响应的公共部分（契约 §2.5 的字段形状）。
 *
 * 所有 kind 都带：`source` / `sourceSeq` / `kind` / `room` / `jump` / `reason` / `hint`。
 * `room`/`jump` 只在 `kind: 'room'` 时有值；`reason` 只在 `kind: 'unparsed'` 时有值
 * （契约原文：绝不猜测，reason 写明无法解析的来源标记）。
 *
 * @param {object} task 任务对象（只读）
 * @param {object} [parsed] `parseSourceSeq` 的命中结果
 */
function buildSourcePayload(task, parsed) {
  const sourceSeq = typeof task?.sourceSeq === 'string' ? task.sourceSeq : ''
  const base = {
    taskId: task?.id ?? null,
    source: task?.source ?? null,
    sourceSeq: sourceSeq === '' ? null : sourceSeq,
    room: null,
    jump: null,
    reason: null,
  }

  if (!sourceSeq) {
    return { ...base, kind: 'none', hint: '这个任务不是从房间消息创建的' }
  }

  if (!parsed) {
    return {
      ...base,
      kind: 'unparsed',
      reason: `无法解析来源标记 "${sourceSeq}"（不是 room:/todo:/evolve: 前缀）`,
      hint: '来源已失效，无法自动跳转',
    }
  }

  if (parsed.kind === 'room') {
    return {
      ...base,
      kind: 'room',
      room: {
        roomId: parsed.roomId,
        name: null,
        seq: parsed.seq,
        messageId: `m-${parsed.seq}`,
        exists: null,
        messageExists: null,
        at: null,
        preview: null,
      },
      jump: { roomId: parsed.roomId, seq: parsed.seq },
      hint: `来源：房间消息 ${parsed.roomId} #${parsed.seq}`,
    }
  }

  if (parsed.kind === 'todo') return { ...base, kind: 'todo', hint: '来源：待办' }
  return { ...base, kind: 'evolve', hint: '来源：任务变更派生' }
}

// ══════════════════════════════════════════════════════════════════════════════
// bots改造05：唤醒前自动复活会话（修「派活报 agent-not-live」）
//
// 设计依据：`design/CONTRACT-bots05.md` §2（**已冻结**）。
// 根因：dsh-web 重启后宿主不会自动把旧会话装载进 `agents` 注册表（懒加载），
// 而 dispatcher 投递走 `kernel.followup` → `getAgent`；拿不到 agent 就是
// `agent-not-live`。会话数据仍在磁盘上，`agents.resume({resumeSessionId})` 能救回来。
// ══════════════════════════════════════════════════════════════════════════════

/** `/bots/revive {all:true}` 单次最多处理的 Bot 数（契约 §2.2）。 */
const REVIVE_MAX = 50

/**
 * 确保某个会话在宿主 `agents` 注册表里是 live 的；不在就尝试 resume。
 *
 * **绝不抛错**：复活失败必须让上层拿到 `reason`，由上层决定「继续投递并在
 * wake 里如实报失败」还是「明确报错」。静默吞掉失败才是本平台最忌讳的。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean, live: boolean, revived: boolean, reason?: string }>}
 */
async function ensureLive(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, live: false, revived: false, reason: 'missing-session' }
  }
  const id = sessionId.trim()
  // 已经 live：**什么都不做**（不得多出任何副作用，保证既有行为完全一致）。
  if (getAgent(ctx, id)) return { ok: true, live: true, revived: false }
  try {
    await resumeSession(ctx, { resumeSessionId: id, warn: moduleWarn })
    return { ok: true, live: true, revived: true }
  } catch (error) {
    return { ok: false, live: false, revived: false, reason: `resume-failed:${error?.message ?? error}` }
  }
}

/**
 * 投递前取「会话水位」基线（用于投递后判定执行者到底动没动）。
 *
 * 读不到水位就返回 undefined —— 宁可不追踪，也不要拿假基线去误报。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<object|undefined>}
 */
async function takeWatermarkBaseline(ctx, sessionId) {
  try {
    const wm = await readSessionWatermark(ctx, sessionId)
    return wm?.ok ? wm : undefined
  } catch {
    return undefined
  }
}

/**
 * 投递成功后登记一条「等回执」期望（2026-11-09 · 补 superagent inputsRead 那一层）。
 *
 * 为什么必须在**投递前**取基线：等投递完再读，可能已经把这次投递算进基线里，
 * 于是「水位从来没涨过」也看不出差异 —— 那就等于没追踪。
 *
 * @param {object} services
 * @param {string} taskId
 * @param {string} sessionId
 * @param {object|undefined} baseline 投递前 takeWatermarkBaseline() 的结果
 * @param {object|undefined} wake dispatcher.notify 的返回
 */
function armDeliveryWatch(services, taskId, sessionId, baseline, wake) {
  const watch = services.deliveryWatch
  if (!watch || !baseline || !baseline.ok) return undefined
  // 只有真的「发出去了」才等回执：failed/pending 各有各的显形方式，不该混进来。
  if (!wake || wake.result !== 'sent') return undefined
  try {
    const out = watch.expect({
      taskId,
      sessionId,
      baselineSeq: baseline.seq,
      baselineUserMessages: baseline.userMessages,
      wakeId: wake.wakeId,
    })
    return out?.ok ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * 执行者状态（「任务在跑吗、为什么没动」）。
 *
 * ## 三条事实分开说，别混成一句「进行中」
 *   1. `live`：会话现在在不在宿主里活着（不在线 ⇒ 压根没法跑）
 *   2. `lastWake`：最近一次唤醒的结果（sent 只是「交出去了」，不代表对方读了）
 *   3. `deliveryError`：有没有投递失败留痕（这是**一等状态**，会一直显示到被解决）
 *
 * @param {object} ctx
 * @param {object} services
 * @param {object} task
 * @returns {{ sessionId: string|null, live: boolean, lastWake: object|null, deliveryError: string|null }}
 */
function buildExecutorStatus(ctx, services, task) {
  const sessionId = task?.ownerId ?? task?.assignee ?? null
  if (!sessionId) return { sessionId: null, live: false, lastWake: null, deliveryError: null }
  let live = false
  try { live = Boolean(getAgent(ctx, sessionId)) } catch { live = false }

  let lastWake = null
  try {
    const rows = readTaskWakes(services, task.id)
    if (rows.length) {
      const w = rows[rows.length - 1]
      lastWake = {
        at: w.at ?? null,
        result: w.result ?? null,
        detail: w.detail ?? null,
        reason: w.reason ?? null,
      }
    }
  } catch { lastWake = null }

  const deliveryError = typeof task?.delivery?.error === 'string' && task.delivery.error
    ? task.delivery.error
    : null
  return { sessionId, live, lastWake, deliveryError }
}

/**
 * 确保「执行某个任务的 Bot」有一个团队（需求4，2026-11-09）。
 *
 * 用户原话：「任务创建完成应该自动建一个团队，可以只有一个人，后续我再增加」。
 *
 * ## 为什么是「每 Bot 一个团队」而不是「每任务一个团队」
 *   任务会不断产生，团队是组织结构、不该跟着任务膨胀。一个 Bot 一个团队 =
 *   它的固定协作单元，人后续往里加人即可；同一个 Bot 的多个任务共享这个团队。
 *
 * ## 幂等
 *   已经有以该 Bot 为负责人的团队 → 直接返回那个（不重复建）。
 *
 * ## 失败不阻断
 *   建团队失败**不影响任务本身**（任务已经建好了）。只回一个 `autoTeam.reason`，
 *   让用户知道「团队没建上，但不影响干活」。
 *
 * @param {object} services
 * @param {string} botSessionId 执行者会话 id
 * @param {string} by 谁触发的（用于留痕）
 * @returns {Promise<{ team?: object, created?: boolean, reason?: string } | undefined>}
 */
// ════════════════════════════════════════════════════════════════════════════
// 升级接续（契约 §8.2）：预检 / 迁移
// ════════════════════════════════════════════════════════════════════════════

/** 升级 09 落地的 schema 版本（0 = 升级前，2 = 本版）。 */
const UPGRADE_SCHEMA_TO = 2
/**
 * 「Boss 本人」的身份集合。
 * `user` 是 api.js 的 OWNER，`ui` 是页面层，`person` 是 board 里的人口径 ——
 * 三者在旧数据里都代表「Boss 亲手做的」，判定必须一起认，否则迁移会漏。
 */
const BOSS_IDS = new Set(['ui', 'user', 'person'])
/** 契约 §8.2 强制的回填备注原文（一个字都不能改，验收要 grep）。 */
const UPGRADE_PHASE_NOTE = '升级迁移：按总产出物回填'

/** 某身份是不是 Boss。 */
function isBossId(id) {
  return typeof id === 'string' && BOSS_IDS.has(id)
}

/**
 * 读迁移要用到的全部原始事实（**只读**，绝不写盘）。
 *
 * ## 为什么单独抽出来
 *   `preflight`（只读体检）与 `migrate`（真写）必须基于**同一份判定**，
 *   否则「预检说会补 3 条、迁移后补了 5 条」这种前后不一致会直接毁掉 Boss 的信任。
 */
function collectUpgradeFacts(services) {
  const dir = anchorStateDir(services) ?? null
  const facts = {
    stateDir: dir,
    boardFile: dir ? statePath(dir, 'board.jsonl') : null,
    metaFile: dir ? statePath(dir, TASK_META_FILE) : null,
    notesFile: dir ? statePath(dir, TASK_NOTES_FILE) : null,
    wakesFile: dir ? statePath(dir, 'wakes.jsonl') : null,
    boardEvents: [],
    boardBad: 0,
    metaRows: [],
    metaBad: 0,
    notes: 0,
    wakes: 0,
    tasks: [],
    tasksSource: 'memory',
  }
  if (!dir) return facts

  // 事件流（真相源）。坏行**不静默**：交给 store.migrate 去拒绝不完整数据。
  if (facts.boardFile && existsSync(facts.boardFile)) {
    const parsed = readJsonl(facts.boardFile)
    facts.boardEvents = parsed.rows
    facts.boardBad = parsed.bad ?? 0
  }
  if (facts.metaFile && existsSync(facts.metaFile)) {
    const parsed = readJsonl(facts.metaFile)
    facts.metaRows = parsed.rows
    facts.metaBad = parsed.bad ?? 0
  }
  if (facts.notesFile && existsSync(facts.notesFile)) {
    facts.notes = readJsonl(facts.notesFile).rows.length
  }
  if (facts.wakesFile && existsSync(facts.wakesFile)) {
    facts.wakes = readJsonl(facts.wakesFile).rows.length
  }

  // 任务态：优先用内存（已 hydrate 的最新态）；事件流存在但内存为空 ⇒ 退回落盘推演。
  try {
    const live = services?.board?.list?.({}) ?? []
    if (Array.isArray(live) && live.length > 0) facts.tasks = live
  } catch { /* 落到下面的推演 */ }
  if (facts.tasks.length === 0 && facts.boardEvents.length > 0) {
    facts.tasksSource = 'jsonl'
    const byId = new Map()
    for (const ev of facts.boardEvents) {
      if (ev && typeof ev.taskId === 'string' && ev.after && typeof ev.after.id === 'string') {
        byId.set(ev.taskId, ev.after)
      }
    }
    facts.tasks = [...byId.values()]
  }
  return facts
}

/** 某任务是否「Boss 碰过」—— 契约 §8.2：`createdBy` / `mandate.sender` / 历史 `byId`。 */
function bossTouchedOf(facts, services, task) {
  if (isBossId(task?.createdBy)) return true
  if (isBossId(task?.mandate?.sender)) return true
  // 历史（内存里有 history 就查内存，否则查事件流）
  if (typeof services?.board?.history === 'function') {
    try {
      const rows = services.board.history(task.id)
      if (Array.isArray(rows) && rows.some((e) => isBossId(e?.byId))) return true
    } catch { /* 落到事件流 */ }
  }
  return facts.boardEvents.some((e) => e?.taskId === task.id && isBossId(e?.byId))
}

/** 任务详情里「旧数据没有」的字段（契约 §8.1 的兼容读清单）。 */
const LEGACY_CANDIDATES = Object.freeze([
  'bossTouched', 'progress', 'labels', 'writeScopes', 'triaged', 'blockedBy', 'progressBy',
])

/** 汇总「哪些旧字段缺、缺多少条」—— 这是 preflight 里 Boss 最需要看的那一段。 */
function legacyFieldReport(tasks) {
  const out = []
  for (const field of LEGACY_CANDIDATES) {
    let missing = 0
    for (const task of tasks) if (task?.[field] === undefined) missing += 1
    if (missing > 0) out.push({ field, missing, total: tasks.length })
  }
  return out
}

/**
 * 升级预检（契约 §8.2 `GET /upgrade/preflight`）—— **只读，一个字节都不写**。
 *
 * 回答 Boss 三个问题：现在有多少数据？升级会动什么？有什么风险？
 */
function upgradePreflight(services) {
  const facts = collectUpgradeFacts(services)
  const tasks = facts.tasks

  let needBoss = 0
  for (const task of tasks) {
    if (task?.bossTouched !== true && bossTouchedOf(facts, services, task)) needBoss += 1
  }

  // 「已完成的长任务但没有阶段行」= 契约 §8.2 第 2 条要回填的那批
  const longrunTasks = tasks.filter((t) => t && readLongrunMeta(services, t.id))
  const phaseRowsByTask = new Map()
  for (const row of facts.metaRows) {
    if (row?.kind !== 'phase' || typeof row.taskId !== 'string') continue
    phaseRowsByTask.set(row.taskId, (phaseRowsByTask.get(row.taskId) ?? 0) + 1)
  }
  const needPhase = longrunTasks.filter(
    (t) => t.status === 'completed' && (phaseRowsByTask.get(t.id) ?? 0) === 0,
  ).length

  const willDo = []
  if (needBoss > 0) willDo.push(`为 ${needBoss} 个任务补 bossTouched`)
  if (needPhase > 0) willDo.push(`为 ${needPhase} 个已完成长任务按总产出物回填阶段产物`)
  if (tasks.length > 0) willDo.push(`把 board 事件流 schema 版本记到 ${UPGRADE_SCHEMA_TO}（现有任务 rev/id/字段原样保留）`)
  if (willDo.length === 0) willDo.push('无需迁移：数据已是新版形态')

  // 风险：只说真的会挡路的那几条，不凑数
  const risks = []
  if (facts.boardBad > 0) {
    risks.push(`board.jsonl 有 ${facts.boardBad} 行无法解析（撕裂写/损坏）——迁移会拒绝在不完整数据上动手，请先修文件`)
  }
  if (facts.metaBad > 0) {
    risks.push(`task-meta.jsonl 有 ${facts.metaBad} 行无法解析——阶段产物回填可能漏读，建议先备份核对`)
  }
  if (!facts.stateDir) risks.push('状态目录不可用：既不能预检也不能迁移')
  if (facts.tasksSource === 'jsonl') risks.push('内存里没有任务（板尚未 hydrate）——本报告由事件流推演，迁移前建议先重启一次让板加载完整')
  if (risks.length === 0) risks.push('无阻塞风险（迁移前仍会自动整目录备份）')

  return {
    ok: true,
    stateDir: facts.stateDir,
    schemaVersion: facts.stateDir ? readSchemaVersion(facts.stateDir, 'board') : 0,
    targetVersion: UPGRADE_SCHEMA_TO,
    counts: {
      tasks: tasks.length,
      longrun: longrunTasks.length,
      phaseRows: facts.metaRows.filter((r) => r?.kind === 'phase').length,
      notes: facts.notes,
      wakes: facts.wakes,
      boardEvents: facts.boardEvents.length,
      bossTouched: tasks.filter((t) => t?.bossTouched === true).length,
    },
    legacy: legacyFieldReport(tasks),
    willDo,
    risks,
    backupHint: facts.stateDir
      ? `迁移前会自动整目录备份到 ${facts.stateDir}.bak-<时间>-upgrade09；要手动回滚就 restoreState(stateDir, 备份路径, { confirm: true })`
      : '状态目录不可用，无法备份',
  }
}

/**
 * 升级迁移（契约 §8.2 `POST /upgrade/migrate`）—— 幂等、先备份、**保留 rev/id/字段**。
 *
 * ## 为什么不能「重写整个 board 文件」
 *   `board.jsonl` 是 CAS 幂等键与 rev 语义的真相源。若整体覆盖重写，
 *   稍有字段遗漏就会让任务的 `rev` 与前端拿到的对不上 —— Boss 需求 9
 *   「任务原样存活」当场破功。所以这里**逐条合并**：只往事件里补缺失字段，
 *   `rev` / `id` / 其余字段**一个字不动**，然后用 `store.migrate` 原子写回。
 *
 * ## 幂等
 *   schema 版本已是目标值 ⇒ `store.migrate` 返回 `migrated:false`，不重写文件；
 *   阶段回填按「该任务是否已有 phase 行」判定，第二次跑必然是 0 条。
 *
 * ## 失败
 *   先 `backupState()`。任何一步失败都返回明确理由 + 备份路径，
 *   让 Boss 能一键回滚，而不是卡在「写了一半」的状态。
 *
 * @returns {Promise<object>}
 */
async function upgradeMigrate(services, by) {
  const facts = collectUpgradeFacts(services)
  if (!facts.stateDir) {
    const error = new Error('状态目录不可用：无法备份，拒绝迁移')
    error.status = 500
    error.code = 'UPGRADE_NO_STATE_DIR'
    throw error
  }

  // ① 先备份（契约硬要求）。备份失败 ⇒ 一个字节都不动。
  //
  // ⚠️ label 带上次幂等迁移的计数：`store.backupState` 的目标路径只精确到**秒**
  //（`<dir>.bak-YYYYMMDD-HHmmss-<label>`），同一秒内跑两次迁移会**覆盖同一份备份** ——
  //   第二次就把「升级前的原始状态」盖成「升级后的状态」，回滚点当场消失。
  //   所以这里按「本次真正要动的任务数 + 当前毫秒」做标签，保证两次备份路径必不相同。
  const backupTag = `upgrade09-${facts.tasks.length}-${Date.now()}`
  const backup = backupState(facts.stateDir, backupTag)
  if (!backup?.ok) {
    const error = new Error(`迁移中止：备份失败（${backup?.reason ?? '未知原因'}）——未写入任何改动`)
    error.status = 500
    error.code = 'UPGRADE_BACKUP_FAILED'
    throw error
  }

  const report = {
    ok: true,
    backupPath: backup.path,
    bossTouched: { updated: 0, skipped: 0 },
    phases: { backfilled: 0, tasks: [] },
    schema: null,
    replayed: null,
  }

    // ② bossTouched 回填：逐条合并进**每个任务的最后一条事件**的 `after`，
  //    rev/id/其它字段原样保留（这是「不破坏 rev 语义」的关键）。
  const needBoss = new Map()
  for (const task of facts.tasks) {
    if (!task || typeof task.id !== 'string') continue
    if (task.bossTouched === true) { report.bossTouched.skipped += 1; continue }
    const touched = bossTouchedOf(facts, services, task)
    if (touched) needBoss.set(task.id, true)
    else needBoss.set(task.id, false)
  }

  // 只对「确实要补 true」的任务动手；判 false 的不写（少改动 = 少风险）
  const targets = new Set([...needBoss.entries()].filter(([, v]) => v === true).map(([k]) => k))

  if (facts.boardEvents.length === 0) {
    // 快照-only 的状态目录（没有 board.jsonl）：**不建空 jsonl**。
    // `store.migrate` 会写出一个空的真相源文件，虽然 hydrate 仍会回落到快照，
    // 但「空 jsonl + 有快照」是后续所有操作的雷区（任何一次 jsonl 写入都会以
    // 「空板」为基线）。这里直接记 schema 版本，并把这件事报给 Boss。
    const ver = facts.stateDir ? writeSchemaVersion(facts.stateDir, 'board', UPGRADE_SCHEMA_TO) : false
    report.schema = { ok: true, migrated: false, version: ver ? UPGRADE_SCHEMA_TO : readSchemaVersion(facts.stateDir, 'board'), skipped: '无 board.jsonl（快照-only），仅记录 schema 版本' }
    if (targets.size > 0) report.bossTouched.pending = targets.size
  } else {
    // 把「每个任务的最后一条事件」的行号先算出来（只认字段齐全的事件）
    const lastIndex = new Map()
    facts.boardEvents.forEach((ev, index) => {
      if (ev && typeof ev.taskId === 'string' && ev.after && typeof ev.after.id === 'string') {
        lastIndex.set(ev.taskId, index)
      }
    })
    const currentVersion = readSchemaVersion(facts.stateDir, 'board')

    if (targets.size > 0) {
      // ⚠️ 为什么这里可能**不能**直接走 store.migrate：它是版本门控的 ——
      //   当前版本已等于 to 时它直接 `migrated:false` 且**完全不调 migrateFn**。
      //   首次迁移跑完后 schema 已是 v2，此时若**又新增**了 Boss 建的任务
      //   （新任务没有 bossTouched），再跑迁移就会被版本门挡掉 ⇒ 永远补不上。
      //   所以：版本还没到 v2 时走 store.migrate（复用它的原子写 + 坏行保护）；
      //   版本已到 v2 但仍有要补的任务 ⇒ 必须绕过门控自己写，否则静默漏补。
      const merge = (rows) => {
        for (let i = 0; i < rows.length; i += 1) {
          const ev = rows[i]
          if (!ev || !targets.has(ev.taskId)) continue
          if (lastIndex.get(ev.taskId) !== i) continue
          if (!ev.after || typeof ev.after !== 'object') continue
          if (ev.after.bossTouched === true) continue
          // ⚠️ 只加一个字段；rev / id / 其余字段**一律不动**
          ev.after.bossTouched = true
          report.bossTouched.updated += 1
        }
        return rows
      }

      if (currentVersion === UPGRADE_SCHEMA_TO) {
        // ⚠️ 绕门控前必须自查坏行（等价于 store.migrate 内部那道抛错保护）。
        //    原因：`facts.boardEvents` 来自 `readJsonl()`，它**会跳过解析不了的坏行**
        //    只把条数记进 `facts.boardBad`。下面是把整份事件流在内存里改完再整体重写，
        //    一旦文件里真有坏行，坏行会被**永久抹掉** —— 而这条分支恰恰是最常走的
        //    （schema 已 v2 之后每次迁移都走它）。宁可拒绝，也不静默丢证据。
        if (facts.boardBad > 0) {
          const error = new Error(
            `迁移中止：board.jsonl 有 ${facts.boardBad} 行无法解析——`
            + '拒绝在不完整数据上重写（否则坏行会被永久抹掉）。'
            + `请先修文件，或从备份 ${backup.path} 恢复。未写入任何改动。`,
          )
          error.status = 500
          error.code = 'UPGRADE_BAD_ROWS'
          throw error
        }
        // 绕门控：按 store.migrate 的同一套原子写形态（tmp → rename）改回去
        const jsonlPath = statePath(facts.stateDir, 'board.jsonl')
        const nextRows = merge(facts.boardEvents.slice())
        const tmp = `${jsonlPath}.tmp-upgrade09`
        writeFileSync(tmp, nextRows.map((r) => JSON.stringify(r)).join('\n') + (nextRows.length ? '\n' : ''), 'utf8')
        renameSync(tmp, jsonlPath)
        report.schema = { ok: true, migrated: true, version: UPGRADE_SCHEMA_TO, bypassedVersionGate: true }
        report.bossTouched.bypassedGate = true
      } else {
        report.schema = migrate(facts.stateDir, {
          name: 'board',
          to: UPGRADE_SCHEMA_TO,
          migrateFn: merge,
        })
      }
    } else {
      // 没有要补的任务，但仍要把 schema 版本记上（幂等：已是最新则不改文件）
      report.schema = migrate(facts.stateDir, {
        name: 'board', to: UPGRADE_SCHEMA_TO, migrateFn: (rows) => rows,
      })
    }
  }

  // ③ 已完成长任务 + 没有任何 phase 行 ⇒ 按 task.artifacts 回填一条末阶段产物
  const phaseRowsByTask = new Map()
  for (const row of facts.metaRows) {
    if (row?.kind !== 'phase' || typeof row.taskId !== 'string') continue
    phaseRowsByTask.set(row.taskId, (phaseRowsByTask.get(row.taskId) ?? 0) + 1)
  }
  for (const task of facts.tasks) {
    if (!task || task.status !== 'completed') continue
    if ((phaseRowsByTask.get(task.id) ?? 0) > 0) continue   // 契约：已有 phase 行不动
    const longrun = readLongrunMeta(services, task.id)
    const titles = longrunPhaseList(longrun)
    if (titles.length === 0) continue
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts.filter(
      (a) => typeof a === 'string' && a.trim() !== '',
    ) : []
    const record = {
      kind: 'phase',
      taskId: task.id,
      index: titles.length - 1,
      state: 'done',
      artifacts,
      note: UPGRADE_PHASE_NOTE,
      by: by,
      at: Date.now(),
    }
    if (!appendJsonl(facts.metaFile, record)) {
      const error = new Error(
        `迁移中止：阶段产物回填落盘失败（${facts.metaFile}）——`
        + `已备份在 ${backup.path}，可用 restoreState 回滚`,
      )
      error.status = 500
      error.code = 'UPGRADE_PHASE_APPEND_FAILED'
      throw error
    }
    report.phases.backfilled += 1
    report.phases.tasks.push(task.id)
  }

  // ④ 内存态跟磁盘对齐：迁移改了事件流，板必须重放，否则后续快照会用旧内存覆盖认知
  try {
    if (typeof services?.board?.replay === 'function') report.replayed = services.board.replay()
  } catch (error) {
    report.replayError = `迁移已落盘，但内存重放失败：${error?.message ?? error}——建议重启以加载完整状态`
  }

  return report
}

/**
 * 给团队自动配一个「议事厅」（契约 §3）。
 *
 * ## 为什么
 *   建了团队却没人知道去哪儿说话 —— 团队页只是名单，真正的协作发生在房间。
 *   所以建团队时顺手把房间建好、把人拉全、把关联记到团队上。
 *
 * ## 失败不阻断
 *   房间服务未装配、房间重名、房间目录不可写……都只回 `roomError` 一句人话。
 *   **团队已经建成了**，因为「房间没配上」就回滚团队，等于用次要功能否掉主要功能。
 *
 * ## mode 必须是 admin
 *   `room.js` 只在 `mode:'admin'` 下接受 `adminId`（`everyone` 里传会直接
 *   `ROOM_ADMIN_ID_NOT_APPLICABLE`）。契约要求 `adminId = leadId`，
 *   所以这里固定用 admin 模式 —— 议事厅由负责人主持，语义也对。
 *
 * @param {object} services
 * @param {object} team teams.create 的返回值（含 id / name / leadId / members）
 * @param {string} by
 * @returns {{ room?: object, roomError?: string, attached?: boolean }}
 */
async function ensureTeamRoom(services, team, by) {
  if (!team || typeof team.id !== 'string') return {}
  const roomSvc = services?.room
  if (!roomSvc || typeof roomSvc.create !== 'function') {
    return { roomError: '房间服务未装配（services.room 缺失）——团队已建好，可稍后在房间页手动建' }
  }

  // 幂等：团队已有关联房间 ⇒ 不重复建（重复调 /teams 保存不该刷出一串议事厅）
  if (typeof team.roomId === 'string' && team.roomId) {
    try {
      const existing = await roomSvc.get(team.roomId)
      if (existing) return { room: { id: existing.id, name: existing.name }, attached: false }
    } catch { /* 房间没了就往下重建 */ }
  }

  const lead = team.leadId
  const roomName = `${team.name} · 议事厅`
  // 负责人必须在成员里（admin 模式下 he 是唯一能发言的人；不在成员表里就等于没人能说话）
  const members = [...new Set([...(lead ? [lead] : []), ...(Array.isArray(team.members) ? team.members : [])])]

  try {
    const room = await roomSvc.create({
      name: roomName,
      members,
      mode: 'admin',
      ...(lead ? { adminId: lead } : {}),
      purpose: `团队「${team.name}」的自动议事厅：负责人主持，成员在此对齐`,
      byId: by,
    })
    // 关联落库（失败只告警：房间已经能用，关联丢了顶多下次再建一间）
    let attachError
    if (services.teams && typeof services.teams.attachRoom === 'function') {
      try {
        await services.teams.attachRoom({ id: team.id, roomId: room.id, by })
      } catch (error) {
        attachError = `议事厅已建好（${room.id}）但未能记到团队上：${error?.message ?? error}`
      }
    }
    return {
      room: { id: room.id, name: room.name },
      attached: !attachError,
      ...(attachError ? { roomError: attachError } : {}),
    }
  } catch (error) {
    return {
      roomError: `自动建议事厅失败：${error?.message ?? error}`
        + '——团队已建好，去「房间」页手动建一个并在团队页关联即可',
    }
  }
}

/**
 * 发消息/唤醒时的「自动激活」（契约 §7.2）。
 *
 * ## 现场
 *   Boss 给一个停在 pending 的任务发补充说明，说明存下来了、也唤醒了执行者，
 *   但任务状态还是 pending —— 因为**没人接活**，执行者收到消息也没活可干；
 *   已经 in_progress 的任务则因为租约到期被系统收回，Boss 一发消息就发现
 *   「怎么又变回待领了」。两件事的共同点是：**人发了消息，机器没有跟着动**。
 *
 * ## 做法
 *   - `in_progress` + 有负责人 ⇒ 自动续租（心跳）。失败**不回滚**刚存的补充说明
 *     （说明是人的话，不能因为续租失败就丢掉），只把原因回给页面。
 *   - `pending` + 有负责人 ⇒ 自动接活（claim），成功后由调用方继续唤醒。
 *   - `blocked` ⇒ **不自动解除**（解除阻塞是人的判断，不是机器的），
 *     只回一句「需要先解除阻塞」。
 *
 * 租约本身保留（不引入新状态），只是页面不再把它当回事。
 *
 * @param {object} services
 * @param {object} task board 任务快照
 * @param {string} by 操作者
 * @returns {Promise<{ claimed?: object, heartbeat?: object, reason?: string }>}
 */
async function autoActivate(services, task, by) {
  const out = {}
  if (!task || typeof task.id !== 'string') return out
  const board = services?.board
  if (!board || typeof board.update !== 'function') {
    return { reason: 'board 服务未装配，无法自动激活' }
  }
  const ownerId = task.ownerId ?? task.assignee ?? null
  if (!ownerId) {
    return { reason: '任务还没有负责人，先指派给一个 Bot 才能自动激活' }
  }

  // blocked：**绝不自动解除** —— 解除阻塞是人的判断
  if (task.status === 'blocked') {
    return { reason: '任务处于阻塞状态，需要先解除阻塞：点「解除阻塞」，再发消息' }
  }
  if (task.status === 'completed' || task.status === 'deleted') {
    return { reason: `任务已${task.status === 'completed' ? '完成' : '删除'}，无需激活` }
  }

  // ① 已在进行中：续租（心跳）。失败不改变任何已落盘的事实。
  if (task.status === 'in_progress' && task.lease) {
    try {
      await board.update({ id: task.id, expectedRev: task.rev, action: 'heartbeat', byId: ownerId })
      return { heartbeat: { ownerId, ok: true } }
    } catch (error) {
      return {
        heartbeat: { ownerId, ok: false },
        reason: `续租失败：${error?.message ?? error}`
          + '（补充说明已保存，任务状态未改）',
      }
    }
  }

  // ② 待领 / 在进行中但租约已丢：替他接活
  if (task.status === 'pending' || task.status === 'in_progress') {
    try {
      await board.update({ id: task.id, expectedRev: task.rev, action: 'claim', byId: ownerId })
      return { claimed: { ownerId, ok: true } }
    } catch (error) {
      return { reason: `自动接活失败：${error?.message ?? error}` }
    }
  }

  return out
}

/**
 * 任务诊断（契约 §5）：把「为什么这个任务没产出」翻译成一句人话 + 一个下一步按钮。
 *
 * ## 现场
 *   Boss 报：「调研专家《调研专家测试001》已多次指派，subagent 持续失败，无产出。」
 *   查 `wakes.jsonl` 全是 `result:'failed' / detail:'agent-not-live'` ——
 *   也就是**执行者会话根本不在**，于是唤醒全部失败、任务永远停在 pending、
 *   页面上什么都看不见（静默失败）。
 *
 * ## 做法
 *   不猜。逐项读真实服务：roster（Bot 是谁）、getAgent（会话在不在）、
 *   `agent.model.current()`（有没有模型路由）、dispatcher.list（唤醒有没有失败）。
 *   每一项的失败都映射成中文理由 + 下一步。输出 `verdict`：
 *   `ok` = 可以干活；`blocked` = 有明确的卡点（点建议里的按钮就能解）。
 *
 * @param {object} ctx @param {object} services @param {object} task
 */
async function diagnoseTask(ctx, services, task) {
  const taskId = task?.id ?? task?.taskId ?? '(未知)'
  const ownerId = task?.ownerId ?? task?.assignee ?? null

  // ── 1) 执行者是谁（roster）──────────────────────────────────────────
  let botName = ownerId ? String(ownerId).slice(-8) : ''
  let rosterPreset
  try {
    const bots = services?.roster?.list?.() ?? []
    const hit = bots.find((b) => b?.sessionId === ownerId)
    if (hit?.name) botName = hit.name
    if (hit?.preset) rosterPreset = String(hit.preset)
  } catch { /* roster 不在就继续，名字退化成 id 缩写 */ }

  // ── 2) 会话在不在（getAgent 是真查，不判 roster.state 这种缓存）──────
  let live = false
  try { live = Boolean(getAgent(ctx, ownerId)) } catch { live = false }

  // ── 3) 模型路由（assertDeliverable 同一套判定 —— 不写两遍）─────────
  const deliverable = live ? assertDeliverable(ctx, ownerId) : { ok: true, reason: '（会话不在线，先恢复会话再判定模型路由）' }

  // ── 4) preset 是否真的能解析（老数据可能存了个已删的 preset id）─────
  let presetResolved = true
  try {
    const session = sessionMeta(ctx, ownerId)
    const wanted = rosterPreset ?? (typeof session?.agentPreset === 'string' ? session.agentPreset : undefined)
    if (wanted) {
      const known = await listPresets(ctx)
      presetResolved = Array.isArray(known) && known.some((p) => p && (p.id === wanted || p.name === wanted))
    }
  } catch { presetResolved = rosterPreset !== undefined }
  const hasModelRoute = Boolean(deliverable?.ok)

  // ── 5) 唤醒记录（真实落盘的 wakes.jsonl）───────────────────────────
  const wakes = readTaskWakes(services, taskId)
    .slice(-10)
    .map((row) => {
      const at = row?.updatedAt ?? row?.sentAt ?? row?.scheduledAt ?? null
      return {
        at: Number.isFinite(Number(at)) ? Number(at) : null,
        result: row?.result ?? 'unknown',
        reason: row?.detail ?? row?.reason ?? null,
      }
    })

  // ── 6) verdict + advice（两句：一句说清，一句说下一步点哪）─────────
  const blockers = []
  if (!live) blockers.push('agent-not-live')
  if (deliverable && deliverable.ok === false) blockers.push('undeliverable')
  if (!presetResolved) blockers.push('preset-unresolved')
  if (wakes.some((w) => w.result === 'failed')) blockers.push('wake-failed')

  const verdict = blockers.length ? 'blocked' : 'ok'
  let advice
  if (!live) {
    advice = `执行者「${botName}」的会话当前不在线，唤醒消息投不出去 —— 点「重新派活」重新拉起会话；若连续失败，去「Bot 注册表」看它是否已退役或被回收。`
  } else if (deliverable && deliverable.ok === false) {
    advice = `「${botName}」没有模型路由，唤醒后第一轮必败 —— 去「Bot 档案」给它选一个模型，保存后再点「重新派活」。`
  } else if (!presetResolved) {
    advice = `「${botName}」用的预制体（preset）已不存在 —— 去「Bot 档案」换一个预制体，否则模型不会加载。`
  } else if (wakes.some((w) => w.result === 'failed')) {
    advice = `最近有唤醒失败记录 —— 先点「重新派活」重发，再点「刷新」确认状态；若仍然失败，看下面「唤醒记录」里的 reason 逐条排查。`
  } else {
    advice = `执行者「${botName}」已在线且模型路由正常 —— 直接点「唤醒」重发任务即可。`
  }

  return {
    ok: true,
    taskId,
    ownerId,
    bot: {
      name: botName,
      hasSession: live,
      preset: rosterPreset ?? null,
      presetResolved,
      hasModelRoute,
    },
    live: { ok: live, reason: live ? '会话在线' : '会话不在线（agent-not-live）' },
    deliverable,
    wakes,
    verdict,
    advice,
  }
}

async function ensureTeamForBot(services, botSessionId, by) {
  const teams = services.teams
  if (!teams || typeof teams.create !== 'function' || typeof botSessionId !== 'string' || !botSessionId) {
    return undefined
  }
  try {
    const existing = teams.list({ type: 'big' }).find((t) => t.leadId === botSessionId && t.status === 'open')
    if (existing) return { team: existing, created: false }

    // 团队名用 Bot 的真名（roster 里查），查不到就用会话 id 缩写
    let botName = ''
    try {
      const bots = services.roster?.list?.() ?? []
      const hit = bots.find((b) => b.sessionId === botSessionId)
      if (hit?.name) botName = hit.name
    } catch { /* roster 不在就算了 */ }
    const name = `${botName || `Bot ${String(botSessionId).slice(-8)}`} 的团队`

    const team = teams.create({
      name,
      type: 'big',
      leadId: botSessionId,
      // 「可以只有一个人」：成员列表先空着，负责人就是唯一成员，人后续再加
      memberIds: [],
      purpose: '由任务派活自动创建；后续可在「团队」页加人或调整权限',
      // 人建的团队默认「仅负责人可管理」，自动建的沿用同一安全默认
      adminPolicy: 'lead-only',
      by,
    })
    return { team, created: true }
  } catch (error) {
    return { reason: `自动建团队失败：${error?.message ?? error}` }
  }
}

/** 
 * 投递能力预检（2026-11-09 修复「任务指派后卡在排队中、失败无声」）。
 *
 * ## 现场问题
 *   任务建好并指派给 `bot-6b654c19…`，`wakes.jsonl` 记录 `result=sent`（我们把消息
 *   交出去了），但 Bot 那一轮立刻失败：
 *     `agent "bot-…" has no provider/model: set AgentOptions.provider and
 *      AgentOptions.model or record a model selection`
 *   失败发生在**宿主内部**，信封（wake）早已记为成功 ⇒ 任务停在 pending、
 *   阶段判定没有 `delivery` 依据 ⇒ 页面显示「排队中」，人看不到任何错误。
 *   **这是最坏的一类失败：静默失败。**
 *
 * ## 处置
 *   唤醒**之前**先确认「这个会话真的能跑起来」——即它是否已有模型路由。
 *   没有就**不发唤醒**，而是把原因写进 `task.delivery.error`：
 *     - 阶段判定（`src/stage.js`）读到 delivery.error ⇒ 派 `person/delivery`
 *     - 页面显示「输入投递失败：…」，人立刻知道要做什么（去给 Bot 补 model）
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {{ ok: boolean, reason?: string }}
 */
function assertDeliverable(ctx, sessionId) {
  const agent = getAgent(ctx, sessionId)
  // 会话不 live 不算硬失败 —— ensureLive() 会先复活它，复活失败时才报错。
  if (!agent) return { ok: true }
  try {
    // 只有「真的带 model 访问器」的 agent 才能判定；测试替身/老宿主没有访问器时
    // **一律放行** —— 预检的职责是拦住已知必败的投递，不是给所有投递加一道门。
    if (typeof agent.model?.current !== 'function') return { ok: true }
    const selection = agent.model.current()
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { ok: true }
    }
    return {
      ok: false,
      reason: `会话 ${sessionId} 没有模型路由（provider/model 均为空）——`
        + '请在「Bot 档案」给这个 Bot 选一个模型，或把它的会话模型补上再派活',
    }
  } catch (error) {
    return { ok: false, reason: `读取会话模型失败：${error?.message ?? error}` }
  }
}

/**
 * 把投递失败落到任务上（`task.delivery.error`），让阶段机看得见。
 * 失败**不吞**：写不进去时返回 false，调用方仍会把 reason 回给用户。
 *
 * @param {object} services
 * @param {string} taskId
 * @param {string} reason
 * @param {string} by
 * @returns {Promise<boolean>}
 */
async function markDeliveryFailure(services, taskId, reason, by) {
  try {
    const board = services.board
    if (!board) return false
    const current = board.get(taskId)
    if (!current) return false
    // ⚠️ **合并写入**，不是整体覆盖（2026-11-09）。
    // `board.set` 对 `delivery` 是 `next[k] = fields[k]` —— 整体替换。
    // 直接写 `{ error, at, by }` 会冲掉这个字段上已有的其它键（将来若加
    // attempt/最后一次成功时间等，会被静默抹掉）。先读再展开才是安全写法。
    const prev = (current.delivery && typeof current.delivery === 'object') ? current.delivery : {}
    await board.update({
      id: taskId,
      expectedRev: current.rev,
      action: 'set',
      byId: by,
      delivery: { ...prev, error: String(reason), at: Date.now(), by },
    })
    return true
  } catch {
    return false
  }
}

/**
 * 清掉投递失败留痕（**重试成功后必须清**，2026-11-09 修复）。
 *
 * ## 为什么必须有它（现场缺陷）
 * `stage.js:hasDeliveryFailure()` 的判定是「`task.delivery.error` 存在且非空」，
 * 而全项目**只有写入、没有人清除**（`grep delivery:` 只有两处 set）。
 * 后果：一次投递失败之后，即使人点「重试唤醒」投递成功、Bot 正常把活干完，
 * 任务也**永远**停在 `person/delivery`「输入投递失败：…」——
 * 阶段机被一条过期事实永久劫持，人看到的是假红字。
 *
 * 清除口径（故意保守）：
 *   - 只在**这一次投递确实成功**（`sent` 或 `skipped` 幂等命中）时清
 *   - `pending`（已排队未送达）不清 —— 还没真投出去，失败留痕仍是事实
 *   - `failed` 当然不清
 *
 * @param {object} services
 * @param {string} taskId
 * @param {{ result?: string }} [wake]
 * @returns {Promise<boolean>} 是否真的清了
 */
async function clearDeliveryFailure(services, taskId, wake) {
  const result = wake?.result
  if (result !== 'sent' && result !== 'skipped') return false
  try {
    const board = services.board
    if (!board) return false
    const current = board.get(taskId)
    if (!current) return false
    const prev = current.delivery
    if (!prev || typeof prev !== 'object') return false
    if (typeof prev.error !== 'string' || prev.error === '') return false
    await board.update({
      id: taskId,
      expectedRev: current.rev,
      action: 'set',
      byId: 'cs-bots',
      delivery: { ...prev, error: undefined, clearedAt: Date.now(), clearedBy: wake?.target ?? 'cs-bots' },
    })
    return true
  } catch {
    return false
  }
}

/**
 * 执行 Bot 的开工准备命令（改造07 · 借鉴 Super-agent 的 prepare command）。
 *
 * 安全边界（与 verify 的 kind:'command' 同口径）：
 *   - 第一段必须在 CMD_WHITELIST 内（拒绝任意二进制执行）
 *   - 用 execFile 传参数组，**绝不经过 shell** → 无注入面
 *   - 有硬超时（默认 10 分钟，与 Super-agent 的 prepare 一致）
 *   - cwd 固定为 Bot 的工作目录（Bot 的写入边界）
 *
 * @param {{ prepareCommand?: string, cwd?: string }} bot
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>}
 */
async function runPrepareCommand(bot, opts = {}) {
  const raw = typeof bot?.prepareCommand === 'string' ? bot.prepareCommand.trim() : ''
  if (!raw) return { ok: true, skipped: true }
  const cwd = typeof bot?.cwd === 'string' && bot.cwd ? bot.cwd : undefined
  if (!cwd) return { ok: false, command: raw, error: 'bot-cwd-missing' }

  // 只按空白切分，不做 shell 展开（不做引号/管道/重定向——那都是注入面）。
  const argv = raw.split(/\s+/).filter(Boolean)
  if (argv.length === 0) return { ok: true, skipped: true }
  if (!CMD_WHITELIST.includes(argv[0])) {
    return {
      ok: false,
      command: raw,
      cwd,
      error: `prepare-command-not-allowed:${argv[0]}`,
      stderr: `允许的命令：${CMD_WHITELIST.join(' | ')}`,
    }
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10 * 60 * 1000
  return new Promise((resolvePromise) => {
    let done = false
    const finish = (out) => {
      if (done) return
      done = true
      resolvePromise({ command: raw, cwd, ...out })
    }
    try {
      execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const so = String(stdout ?? '')
        const se = String(stderr ?? '')
        if (error) {
          const timedOut = error.killed === true || error.signal === 'SIGTERM'
          finish({
            ok: false,
            exitCode: typeof error.code === 'number' ? error.code : -1,
            stdout: so,
            stderr: se,
            error: timedOut ? 'timeout' : String(error?.message ?? error),
          })
          return
        }
        finish({ ok: true, exitCode: 0, stdout: so, stderr: se })
      })
    } catch (error) {
      finish({ ok: false, error: String(error?.message ?? error) })
    }
  })
}

/**
 * 把 `ensureLive` 结果压成响应新增字段：`revived:boolean` + 失败时 `reviveReason`。
 * 原本就 live 时只多一个 `revived:false`（契约允许的新增字段），不产生任何副作用。
 * @param {{ live?: boolean, revived?: boolean, reason?: string } | undefined} revive
 */
function reviveFields(revive) {
  const out = { revived: Boolean(revive?.revived) }
  if (revive && revive.live === false) out.reviveReason = revive.reason ?? 'revive-failed'
  return out
}

// ══════════════════════════════════════════════════════════════════════════════
// 改造06 §2：团队 L2 记忆 / 交付物文件预览 / 任务结论摘要 / CS-BOTS 工作区
//
// 设计依据：`design/CONTRACT-bots06.md`（字段名/文案/状态码逐字照做）。
// 这四块都是**纯新增**端点：不改任何既有路由的行为，只追加私有 helper + 分支。
// ══════════════════════════════════════════════════════════════════════════════

/** 团队记忆的标签（L2 层，一个团队一个 tag）。 */
function teamMemoryTag(teamId) {
  return `team:${teamId}`
}

/**
 * 读某团队的 L2 记忆（按 `at` 升序）。
 * 从 memory 服务读（`list({ layer:'L2' })` 后按 tags 精确匹配），不碰记忆文件。
 */
function readTeamMemories(services, teamId) {
  if (!services?.memory) return []
  const tag = teamMemoryTag(teamId)
  let rows
  try {
    rows = services.memory.list({ layer: 'L2', includeArchived: true })
  } catch {
    return []
  }
  return rows
    .filter((row) => Array.isArray(row?.tags) && row.tags.includes(tag))
    .map((row) => ({
      id: row.id,
      layer: 'L2',
      content: row.content,
      by: row.createdBy ?? row.by,
      at: row.createdAt ?? row.at,
      tags: Array.isArray(row.tags) ? [...row.tags] : [],
    }))
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
}

/** 团队记忆渲染文本：`- [时间] content（by）`；空列表 → 空串。 */
function buildTeamMemoryText(memories) {
  return (Array.isArray(memories) ? memories : [])
    .map((m) => `- [${formatAnchorTime(m.at)}] ${m.content}（${m.by ?? '?'}）`)
    .join('\n')
}

/** 简单扩展名 → MIME 映射（只覆盖预览场景常见的文本类型）。 */
const MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
}

/** 按扩展名取 MIME（未知 → `application/octet-stream`）。 */
function mimeFor(path) {
  const m = /\.[A-Za-z0-9]+$/.exec(String(path ?? ''))
  const ext = m ? m[0].toLowerCase() : ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * 粗判二进制：NUL 字节或过高的非文本比例即判为不可预览。
 * 只用内置能力，不引第三方依赖。
 */
function isBinaryBuffer(buf) {
  const n = buf?.length ?? 0
  if (n === 0) return false
  const sample = buf.subarray(0, Math.min(n, 8192))
  let suspicious = 0
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i]
    if (b === 0) return true
    // 控制字符（除常见的 \t \n \r）占比高 → 二进制
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious += 1
  }
  return suspicious / sample.length > 0.02
}

/** 按码点截断（不切断代理对，避免产生半个字符）。 */
function truncateCodepoints(text, max) {
  const s = String(text ?? '')
  const limit = Number.isFinite(max) && max >= 0 ? max : 200
  const arr = Array.from(s)
  return arr.length > limit ? arr.slice(0, limit).join('') : s
}

/** 任务状态 → 中文（与契约 §3 的 progressText 口径一致）。 */
const STATUS_TEXT = {
  pending: '待办',
  in_progress: '进行中',
  blocked: '阻塞',
  completed: '已完成',
}

/** 唤醒记录里是否属于该任务（按投递文案的任务锚定串或 dedupKey 中的 taskId 判定）。 */
function wakeBelongsToTask(row, taskId) {
  const anchor = `任务 ${taskId}：`
  const text = typeof row?.text === 'string' ? row.text : ''
  if (text.includes(anchor)) return true
  const key = typeof row?.dedupKey === 'string' ? row.dedupKey : ''
  return key.includes(`:${taskId}:`) || key.endsWith(`:${taskId}`)
}

/** 唤醒投递文本的首段（首行非空内容），截 200 字；无文本 → null。 */
function wakeExcerpt(text, max = 200) {
  const s = typeof text === 'string' ? text : ''
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (t) return truncateCodepoints(t, max)
  }
  return null
}

/**
 * 从最近一条 L4 笔记里提取「下一步」行。
 * 关键词：下一步 / todo / 计划 / 接下来 / 待（大小写不敏感）。
 * 无匹配 → null；命中行截 200 字。
 */
function extractNextStep(content, max = 200) {
  const s = typeof content === 'string' ? content : ''
  const lines = s.split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (/下一步|todo|计划|接下来|待/i.test(t)) return truncateCodepoints(t, max)
  }
  return null
}

/** 任务结论摘要的固定说明文案（契约逐字）。 */
const SUMMARY_NOTE = '结论由唤醒记录与 L4 任务笔记提炼；队长可通过任务笔记补充下一步方向'

/** 取某任务最近一条 L4 笔记（notesForTask 已是倒序）；无 → null。 */
function latestTaskNote(services, taskId) {
  const mem = services?.memory
  if (!mem || typeof mem.notesForTask !== 'function') return null
  try {
    const rows = mem.notesForTask({ taskId })
    return Array.isArray(rows) && rows.length ? rows[0] : null
  } catch {
    return null
  }
}

/**
 * 读某任务的唤醒记录。
 * 优先用 dispatcher 暴露的读取能力（`list()` 读盘，进程重启后仍可审计）；
 * 若该能力缺失或读盘失败，再退回直接读 `wakes.jsonl`（契约 §2.3 的兜底口径）。
 */
function readTaskWakes(services, taskId) {
  const dispatcher = services?.dispatcher
  if (dispatcher && typeof dispatcher.list === 'function') {
    try {
      const rows = dispatcher.list({})
      if (Array.isArray(rows)) return rows.filter((row) => wakeBelongsToTask(row, taskId))
    } catch {
      /* 落到下面的读盘兜底 */
    }
  }
  const dir = anchorStateDir(services)
  if (!dir) return []
  try {
    const { rows } = readJsonl(statePath(dir, 'wakes.jsonl'))
    return rows.filter((row) => wakeBelongsToTask(row, taskId))
  } catch {
    return []
  }
}

/** 唤醒记录 → 摘要行 `{ at, result, excerpt }`。 */
function toStepConclusion(row) {
  const at = row?.updatedAt ?? row?.sentAt ?? row?.scheduledAt ?? null
  return {
    at: Number.isFinite(Number(at)) ? Number(at) : null,
    result: row?.result ?? 'unknown',
    excerpt: wakeExcerpt(row?.text),
  }
}

/** 状态 → 中文（未知状态原样返回，不静默丢信息）。 */
function statusText(status) {
  return STATUS_TEXT[status] ?? String(status ?? '未知')
}


/**
 * 注册全部 API 路由。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ warn?: Function }} [deps]
 * @returns {(() => void) | undefined} disposer
 */
export function installApi(ctx, { warn } = {}) {
  /** 模块级告警出口：ensureLive 这类模块级函数也要能把 preset 装配失败说出来。 */
  moduleWarn = warn ?? (() => {})
  // ⚠️ 修复（2026-11-04 测试，P0）：此前本 API **完全没有鉴权**——
  //   公网 `curl -X POST http://<IP>/cs-bots/api/tasks` 直接 200，
  //   任何人都能建任务/改记忆/写房间/改 Bot 注册表，并借此绕过下游的受保护区写闸门。
  //   现在所有请求先过 fence.judgeHttp：宿主不认证就一律 403。
  const fence = createFence({ ctx, warn })

  // ── 升级09 §2.3：把「写阶段产出物」挂到 services 上 ─────────────────────
  // `src/tools.js` 的 `bot_task_phase`（C 交付）读的是 `services.phaseWrite`；
  // HTTP `POST /tasks/phase` 与它调用**同一份** writePhaseRow，
  // 不写两套校验 —— 否则「页面能写、Bot 写不进」这种漂移必现。
  // 注入放在这里（而不是 index.js）是因为写入逻辑属于 API 层，
  // 且必须复用 api.js 内那份 appendTaskMeta 实现。
  const mountPhaseWrite = (services) => {
    if (!services || typeof services !== 'object') return
    services.phaseWrite = (taskId, patch) => writePhaseRow(services, taskId, patch)
  }
  mountPhaseWrite(getServices(ctx))

  const handler = async (request, response) => {
    const services = getServices(ctx)
    // 幂等重挂：services 若在 installApi 之后才注册，这里补上（写同一个 key）
    mountPhaseWrite(services)
    // 鉴权先于一切业务逻辑（连 URL 解析都不做，避免攻击面）
    const verdict = fence.judgeHttp(request)
    if (!verdict.ok) {
      sendJson(response, verdict.status ?? 403, { ok: false, reason: verdict.reason ?? 'unauthorized' })
      return
    }
    let url
    try {
      url = new URL(request.url || '/', 'http://localhost')
    } catch {
      sendJson(response, 400, { ok: false, reason: 'bad-url' })
      return
    }
    // 去掉前缀，得到相对路径
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) || '/' : url.pathname

    try {
      // ── 读：状态总览 ──────────────────────────────────────────────────────
      // ── 升级接续（契约 §8.2）：先看后动，动前先备份 ──────────────────────
      if (request.method === 'GET' && path === '/upgrade/preflight') {
        sendJson(response, 200, upgradePreflight(services))
        return
      }
      if (request.method === 'POST' && path === '/upgrade/migrate') {
        const body = (await readBody(request)) ?? {}
        const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : OWNER
        sendJson(response, 200, await upgradeMigrate(services, by))
        return
      }

      if (request.method === 'GET' && path === '/status') {
        const out = { ok: true, services: {}, compat: services.compat ?? null }
        // 状态面要覆盖**全部**域服务：新增模块若不上报，页面「系统体检」就会
        // 显示「一切正常」而实际某功能没装配 —— 那是本平台最忌讳的静默失败。
        const SERVICE_KEYS = [
          'roster', 'board', 'dispatcher', 'room', 'memory',
          'library', 'discipline', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer',
          'metrics', 'verify', 'cycle', 'teams', 'subscription',
          // 投递回执看护（2026-11-09）：不上报的话，它装配失败时
          // 「系统体检」会显示一切正常，而实际没有任何回执追踪 —— 静默失败。
          'deliveryWatch',
        ]
        for (const key of SERVICE_KEYS) {
          const svc = services[key]
          out.services[key] = svc
            ? {
                available: true,
                stats: typeof svc.stats === 'function' ? svc.stats() : undefined,
                stateDir: svc.paths?.stateDir,
                // 看护没有状态目录（期望表只在内存），补一句人话说明
                ...(key === 'deliveryWatch'
                  ? { note: '投递回执看护（只在内存；重启后旧期望失效是设计如此）' }
                  : {}),
              }
            : { available: false }
        }
        sendJson(response, 200, out)
        return
      }

      // ── 任务板 ────────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/tasks') {
        const status = qp(url, 'status')
        const onlyReady = qp(url, 'ready') === '1'
        const attention = qp(url, 'attention') === '1'
        const priority = qn(url, 'priority')
        const source = qp(url, 'source')
        const sort = qp(url, 'sort')
        const byId = qp(url, 'byId')
        const opts = { status: status ?? undefined, attention: attention || undefined, priority: priority ?? undefined, source: source ?? undefined, sort: sort ?? undefined, byId }
        const tasks = await withService(services, 'board', (b) =>
          onlyReady ? b.ready() : b.list(opts),
        )
        // 改造07（借鉴 Super-agent stage table）：每个任务附带执行阶段（纯派生，不落盘）。
        // 前端用 stageInfo.group 上色、needsPerson 判断「该我动手」。
        const enriched = attachStages(tasks)
        sendJson(response, 200, {
          ok: true,
          tasks: enriched,
          stageSummary: stageSummary(tasks),
        })
        return
      }

      if (request.method === 'POST' && path === '/tasks') {
        const body = (await readBody(request)) ?? {}
        // `mandateBasis`/`mandateSender` 是扁平参数（HTTP 与工具调用同形），
        // 落到 board 时组装成 `mandate` 对象 —— 校验在 board 侧统一做。
        // 与 `src/tools.js` 的 bot_task_create 保持**同一套参数名**，
        // 否则同一个概念会出现两种形状，调用方必须记两套规则。
        const { mandateBasis, mandateSender, longrun, phases, ...rest } = body
        const mandate = {}
        if (mandateBasis !== undefined && mandateBasis !== null) mandate.basis = mandateBasis
        if (mandateSender !== undefined && mandateSender !== null) mandate.sender = mandateSender

        // ── 长任务「一次到位」（2026-11-09 需求3）───────────────────────────
        // 用户原话：「建任务的时候选择长任务就是长表单一次到位」。
        // 此前 longrun 只能建完再转（`/tasks/evolve mode=longrun`），于是想直接
        // 建长任务的人必须先建一条普通任务、再转一次 —— 两步操作、两次留痕，
        // 而且第一步派活时唤醒文案里**没有阶段清单**，执行者第一轮就看不到。
        //
        // 判定：显式 `longrun:true` 或给了 `phases` 数组 ⇒ 按长任务建。
        // 校验放在**建任务之前**（非法 phases 不该留下一条半成品任务）。
        const wantsLongrun = longrun === true || (Array.isArray(phases) && phases.length > 0)
        const normalizedPhases = wantsLongrun ? normalizePhases(phases, 'TASK_BAD_PHASES') : undefined

        const task = await withService(services, 'board', (b) =>
          b.create({
            ...rest,
            byId: rest.byId ?? 'ui',
            ...(Object.keys(mandate).length > 0 ? { mandate } : {}),
          }),
        )

        // ── 需求4：任务建好自动配一个团队（可以只有一个人，后续再加）────────
        // 有负责人（assignee）才有意义：团队要有 lead，而 lead 就是执行这个活的人。
        // 没指派时**不建**（建一个没有负责人的团队等于制造垃圾数据）。
        // 失败不阻断：任务已经建好了，团队没建上只是少一份组织关系。
        let autoTeam
        if (rest.assignee && rest.autoTeam !== false) {
          autoTeam = await ensureTeamForBot(services, rest.assignee, rest.byId ?? 'ui')
        }

        // 阶段清单落在 task-meta.jsonl（与 evolve 同一份存储、同一形状）⇒
        // `buildTaskAnchorText` 自动带上，第一次唤醒就可见，不需要再转。
        if (wantsLongrun) {
          appendTaskMeta(services, {
            kind: 'longrun',
            taskId: task.id,
            phases: normalizedPhases,
            note: '创建时长任务',
            by: rest.byId ?? 'ui',
            at: Date.now(),
          })
          sendJson(response, 200, {
            ok: true, task, phases: normalizedPhases, longrun: true, autoTeam,
            note: '已按长任务创建；此后每次唤醒都会带上阶段清单',
          })
          return
        }

        sendJson(response, 200, { ok: true, task, autoTeam })
        return
      }

      if (request.method === 'POST' && path === '/tasks/update') {
        const body = (await readBody(request)) ?? {}
        const task = await withService(services, 'board', (b) =>
          b.update({ ...body, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      if (request.method === 'POST' && path === '/tasks/accept') {
        const body = (await readBody(request)) ?? {}
        const task = await withService(services, 'board', (b) =>
          b.accept({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      // ── agent 预设（建 Bot 时可选）─────────────────────────────────────────
      if (request.method === 'GET' && path === '/presets') {
        let presets = []
        let defaultId
        try {
          presets = await listPresets(ctx)
          defaultId = defaultPreset(ctx)
        } catch (error) {
          sendJson(response, 200, { ok: true, presets: [], defaultId: undefined, note: `预设服务不可用：${error?.message ?? error}` })
          return
        }
        sendJson(response, 200, {
          ok: true,
          presets: presets.map((p) => ({
            id: p.id,
            name: p.name ?? p.id,
            description: p.description,
            order: p.order,
            broken: p.broken,
          })),
          defaultId,
          note: presets.length ? undefined : '宿主未提供 agentPresets 服务（Bot 将使用默认预设）',
        })
        return
      }

      // ── Bot 注册表 ────────────────────────────────────────────────────────
      // ── 工作区补挂（2026-11-09：「主页面左侧栏还是看不到工作区和对话」）──────
      //
      // 新建的 Bot 会话现在会自动挂进「cwd 对应的工作区」（kernel.attachToWorkspace）。
      // 但**存量 Bot**（本次修复之前建的）从来没挂过，于是永远躺在「未分组」里。
      // 这个端点做一次性补挂：遍历 roster，把每个 Bot 的会话挂到它 cwd 的工作区。
      //
      // 为什么不在装配时自动跑：attachSession 会**写**宿主的工作区注册表，
      // 插件装配期做写操作是不可接受的副作用（用户没要求、失败还难查）。
      // 做成显式端点（页面「Bot 档案」有按钮，也可手动调）。
      if (request.method === 'POST' && path === '/roster/attach-workspaces') {
        const bots = await withService(services, 'roster', (r) => r.list({ includeRetired: false }))
        const results = []
        for (const bot of bots) {
          if (typeof bot.cwd !== 'string' || bot.cwd.trim() === '') {
            results.push({ name: bot.name, ok: false, reason: '没有工作目录' })
            continue
          }
          try {
            const attached = await attachToWorkspace(ctx, bot.cwd, bot.sessionId)
            results.push({
              name: bot.name,
              cwd: bot.cwd,
              sessionId: bot.sessionId,
              ok: attached,
              reason: attached ? null : '宿主未提供 workspaceRegistry（版本过旧）',
            })
          } catch (error) {
            results.push({ name: bot.name, ok: false, reason: `挂载失败：${error?.message ?? error}` })
          }
        }
        const okCount = results.filter((r) => r.ok).length
        sendJson(response, 200, {
          ok: true,
          total: results.length,
          attached: okCount,
          failed: results.length - okCount,
          results,
          note: okCount > 0
            ? `已把 ${okCount} 个 Bot 的会话挂进各自工作目录对应的工作区，刷新左侧栏即可看到`
            : '没有需要补挂的（或宿主版本过旧不支持工作区）',
        })
        return
      }

      if (request.method === 'GET' && path === '/roster') {
        const includeRetired = qp(url, 'includeRetired') === '1'
        const bots = await withService(services, 'roster', (r) => [
          ...r.list(),
          ...(includeRetired ? r.listRetired() : []),
        ])
        sendJson(response, 200, { ok: true, bots })
        return
      }

      if (request.method === 'POST' && path === '/roster') {
        const body = (await readBody(request)) ?? {}
        // cwd 兜底（契约 bots06 §2.4）：未提供/空白时用 settings.botWorkspaceRoot；
        // 两者都空则保持原行为 —— roster 自己抛 400。
        const bodyWithFallback = { ...body }
        if (typeof body.cwd !== 'string' || body.cwd.trim() === '') {
          const fallback = services.settings?.botWorkspaceRoot
          if (typeof fallback === 'string' && fallback.trim() !== '') bodyWithFallback.cwd = fallback.trim()
        }
        const bot = await withService(services, 'roster', (r) =>
          r.create({ ...bodyWithFallback, byId: body.byId ?? 'ui' }),
        )
        // 预制记忆同步（建 Bot 与改档案必须一致）
        const memory = seedBotMemory(services, bot, body.byId ?? 'ui')
        // 同目录共享检测：**允许**，但必须告知（两个 Bot 在同一目录会互相覆盖文件）
        let sharedWith = []
        try {
          const all = services.roster?.list?.() ?? []
          sharedWith = all
            .filter((b) => b.id !== bot.id && b.state !== 'retired' && String(b.cwd) === String(bot.cwd))
            .map((b) => ({ id: b.id, name: b.name }))
        } catch {
          /* 检测失败不影响创建 */
        }
        sendJson(response, 200, {
          ok: true,
          bot,
          ...(memory ? { memory } : {}),
          ...(sharedWith.length
            ? {
                warnings: [
                  `目录 ${bot.cwd} 已被 ${sharedWith.map((b) => b.name).join('、')} 使用 —— 两个 Bot 会互相覆盖文件`,
                ],
                sharedWith,
              }
            : {}),
        })
        return
      }

      // ── Bot 档案（身份 / 经验 / 技能 / 预制记忆）──────────────────────────
      if (request.method === 'GET' && path === '/roster/profile') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const detail = await withService(services, 'roster', (r) => r.getProfile(id))
        sendJson(response, 200, {
          ok: true,
          bot: detail.bot,
          profile: detail.profile ?? {},
          profilePath: detail.profilePath,
          managedText: detail.managedText,
          hasOutside: detail.hasOutside,
          profileError: detail.profileError,
        })
        return
      }

      if (request.method === 'POST' && path === '/roster/profile') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const bot = await withService(services, 'roster', (r) =>
          r.setProfile({ id: body.id, profile: body.profile ?? {}, byId: body.byId ?? 'ui', expectedRev: body.expectedRev }),
        )
        // 预制记忆同步（与建 Bot 共用同一段逻辑）
        const memory = seedBotMemory(services, bot, body.byId ?? 'ui')
        sendJson(response, 200, { ok: true, bot, ...(memory ? { memory } : {}) })
        return
      }

      if (request.method === 'POST' && path === '/roster/manage') {
        const body = (await readBody(request)) ?? {}
        const byId = body.byId ?? 'ui'
        const result = await withService(services, 'roster', (r) => {
          switch (body.action) {
            case 'rename':
              return r.rename({ id: body.id, name: body.name, expectedRev: body.expectedRev, byId })
            case 'retire':
              return r.retire({ id: body.id, reason: body.reason, byId })
            case 'setCwd':
              return r.setCwd({ id: body.id, cwd: body.cwd, expectedRev: body.expectedRev, byId })
            // 改造07（借鉴 Super-agent prepare command）：设置/清除开工准备命令
            case 'prepare':
              return r.setPrepareCommand({
                id: body.id,
                prepareCommand: body.prepareCommand,
                expectedRev: body.expectedRev,
                byId,
              })
            case 'claim':
              return r.claim({ id: body.id, owner: byId, expectedRev: body.expectedRev })
            case 'release':
              return r.release({ id: body.id, owner: byId, expectedRev: body.expectedRev })
            case 'heartbeat':
              return r.heartbeat({ id: body.id, owner: byId, expectedRev: body.expectedRev })
            default:
              throw new Error(`未知 action: ${body.action}`)
          }
        })
        sendJson(response, 200, { ok: true, bot: result })
        return
      }

      // ── 房间 ──────────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/rooms') {
        // includeArchived=1 时连归档房一起返回（超级管理员的"回收站"视图）
        const rooms = await withService(services, 'room', (r) =>
          r.list({ includeArchived: qp(url, 'includeArchived') === '1' }),
        )
        sendJson(response, 200, { ok: true, rooms })
        return
      }

      if (request.method === 'POST' && path === '/rooms') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.create({ ...body, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      if (request.method === 'GET' && path === '/rooms/messages') {
        const roomId = qp(url, 'roomId')
        if (!roomId) {
          sendJson(response, 400, { ok: false, reason: 'roomId 必填' })
          return
        }
        const messages = await withService(services, 'room', (r) =>
          r.listMessages({
            roomId,
            sinceSeq: qn(url, 'sinceSeq'),
            limit: qn(url, 'limit'),
            withBody: qp(url, 'withBody') === '1',
          }),
        )
        sendJson(response, 200, { ok: true, messages })
        return
      }

      if (request.method === 'POST' && path === '/rooms/post') {
        const body = (await readBody(request)) ?? {}
        const message = await withService(services, 'room', (r) =>
          r.post({ ...body, from: body.from ?? 'ui' }),
        )

        // ── 发言后自动唤醒房间内的 Bot ──
        //
        // 为什么需要这步：主管报"我在群聊里说话，Bot 没有反应"。
        // 根因是 /rooms/post 只落消息、不做任何投递，房间变成"死信箱"——
        // 消息写进去了，但没有任何机制告诉 Bot "有人在说话"。
        //
        // 唤醒策略（与 dispatcher 的 dedupKey 一致）：
        //   - 只唤醒**非本人**的成员（不唤醒发送者自己）；
        //   - 房间设置 `allowBotAutoPost` 为 false 时跳过（给用户关开关的权利）；
        //   - dedupKey 用消息 ID，天然幂等，同一消息不会重复唤醒；
        //   - dispatcher 缺失时降级为「只落消息不唤醒」，不抛错。
        const room = await withService(services, 'room', (r) => r.get(message.roomId))
        const senderSession = body.from ?? 'ui'
        const members = room?.members ?? []
        const skipSelf = (senderSession !== 'ui' && senderSession)
        const toWake = members.filter((m) => m !== skipSelf)
        const wakeByTarget = new Map()
        if (toWake.length > 0 && room?.settings?.allowBotAutoPost !== false) {
          for (const target of toWake) {
            const result = await withService(services, 'dispatcher', (d) => d.notify({
              target,
              reason: 'room-message',
              dedupKey: `room-msg:${message.id}:${target}`,
              text: `[房间「${room.name ?? message.roomId}」有新消息] ${message.text.slice(0, 200)}`,
            })).catch(() => {
              // dispatcher 降级：唤醒失败不影响消息已落盘的事实
              return undefined
            })
            wakeByTarget.set(target, result)
          }
        }

        // ── 补投（契约 bots05 §2.5）：首轮投递失败的成员，先复活会话再用新
        // dedupKey 重投一次（`room-msg-retry:<msgId>:<target>`）。
        //
        // 为什么只补投**首轮失败**的：首轮已成功（sent/pending）的成员若再投一次，
        // 用户会收到同一消息的两次唤醒 —— 那是噪音，不是修复。
        // 为什么只补投本平台注册的 Bot 会话：房间成员也可能是主对话/人类会话，
        // 盲目 resume 会把非 Bot 会话拉起来（副作用不可控）。
        const revives = []
        for (const target of toWake) {
          const first = wakeByTarget.get(target)
          const firstFailed = !first || first.ok === false
          if (!firstFailed) continue
          if (!services.roster?.hasSession?.(target)) continue
          const revive = await ensureLive(ctx, target)
          const entry = { target, live: revive.live, revived: revive.revived, retried: false }
          if (!revive.live) {
            entry.reason = revive.reason ?? 'revive-failed'
          } else {
            entry.wake = await withService(services, 'dispatcher', (d) => d.notify({
              target,
              reason: 'room-message',
              dedupKey: `room-msg-retry:${message.id}:${target}`,
              text: `[房间「${room.name ?? message.roomId}」有新消息] ${message.text.slice(0, 200)}`,
            })).catch((error) => ({ ok: false, result: 'failed', reason: String(error?.message ?? error) }))
            entry.retried = true
          }
          revives.push(entry)
        }

        // ── 改造07（借鉴 Super-agent Subscription 扇出）：
        // 订阅该房间的任务，自动收到这条消息作为上下文。
        // **只加上下文、不改任务状态、不授予开工权力**——谁有权开工仍由 claim 决定。
        let fanout
        if (services.subscription) {
          try {
            fanout = await services.subscription.fanout({
              roomId: message.roomId,
              message,
              wake: false, // 上下文到达不等于要打扰执行者
              by: body.from ?? 'ui',
            })
          } catch (error) {
            fanout = { error: `fanout-failed:${error?.message ?? error}` }
          }
        }

        // ── t-39 第2批 C：发言同步给 DSH 原生 team 的 Lead（Boss 体验 item 5）──
        //
        // Boss 在 cs-bots 议事厅说话时，原生 team 的 Lead 感知不到 —— 两套团队模型
        // 是分离的。这一步把消息也投递给绑定的原生 Lead（root session 路径，合法）。
        //
        // 诚实原则：同步失败**不报** ok:false（房间消息本身成功了），而是
        // `leadSync.synced:false` + `reason`，页面据此显示「同步失败：<原因>」。
        // 绝不装成功 —— 那比不显示更糟。
        let leadSync
        try {
          leadSync = await withService(services, 'teams', (t) =>
            t.syncToNativeLead({
              roomId: message.roomId,
              messageId: message.id,
              text: message.text,
              by: body.from ?? 'ui',
              dispatcher: services.dispatcher,
            }))
        } catch (error) {
          // 同步是附加动作：异常也必须变成可见的 synced:false，而不是 500
          leadSync = { ok: true, synced: false, reason: 'SYNC_ERROR', detail: String(error?.message ?? error) }
        }

        sendJson(response, 200, { ok: true, message, wakes: toWake.length, revives, fanout, leadSync })
        return
      }

      if (request.method === 'GET' && path === '/rooms/body') {
        const roomId = qp(url, 'roomId')
        const messageId = qp(url, 'messageId')
        if (!roomId || !messageId) {
          sendJson(response, 400, { ok: false, reason: 'roomId 与 messageId 必填' })
          return
        }
        const text = await withService(services, 'room', (r) => r.readBody({ roomId, messageId }))
        sendJson(response, 200, { ok: true, text })
        return
      }

      // ── 记忆 ──────────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/memory') {
        const layer = qp(url, 'layer')
        const query = qp(url, 'query')
        const botId = qp(url, 'botId')
        const entries = await withService(services, 'memory', (m) =>
          query ? m.search({
              query,
              layers: layer ? [layer] : undefined,
              limit: qn(url, 'limit'),
              botId,
              includeArchived: qp(url, 'includeArchived') === '1',
            })
                : m.list({
              layer,
              limit: qn(url, 'limit'),
              botId,
              cwd: qp(url, 'cwd'),
              includeArchived: qp(url, 'includeArchived') === '1',
              onlyArchived: qp(url, 'onlyArchived') === '1',
            }),
        )
        sendJson(response, 200, { ok: true, entries })
        return
      }

      if (request.method === 'POST' && path === '/memory') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.add({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      if (request.method === 'GET' && path === '/memory/stats') {
        const stats = await withService(services, 'memory', (m) => m.stats())
        sendJson(response, 200, { ok: true, stats })
        return
      }

      if (request.method === 'GET' && path === '/memory/context') {
        // cwd：按项目裁剪注入内容（不传＝全局口径，与改造前逐字一致）
        const text = await withService(services, 'memory', (m) => m.contextFor({
          branch: qp(url, 'branch'),
          cwd: qp(url, 'cwd'),
        }))
        sendJson(response, 200, { ok: true, text })
        return
      }

      // ── 成果聚合（只读）────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/artifacts') {
        const q = qp(url, 'q')
        const ownerId = qp(url, 'ownerId')
        const status = qp(url, 'status')
        const limit = qn(url, 'limit')
        const cap = limit !== undefined && limit > 0 ? Math.min(limit, 1000) : 200
        const kw = q ? String(q).toLowerCase() : ''
        const rows = await withService(services, 'board', (b) => b.list({ status: status ?? undefined }))
        const artifacts = []
        let itemCount = 0
        let danglingSkipped = 0
        for (const t of rows) {
          if (ownerId && t.ownerId !== ownerId) continue
          const items = normalizeArtifactItems(t.artifacts)
          if (items.length === 0) continue
          if (kw) {
            const hay = `${t.subject ?? ''} ${items.join(' ')}`.toLowerCase()
            if (!hay.includes(kw)) continue
          }
          itemCount += items.length
          artifacts.push({
            taskId: t.id,
            subject: t.subject,
            status: t.status,
            ownerId: t.ownerId,
            accepted: t.accepted === true,
            completedAt: t.completedAt ?? t.createdAt,
            items,
          })
        }
        artifacts.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
        const sliced = artifacts.slice(0, cap)
        sendJson(response, 200, {
          ok: true,
          artifacts: sliced,
          stats: { tasks: sliced.length, items: sliced.reduce((n, a) => n + a.items.length, 0) },
          note: `已扫描 ${rows.length} 个任务${danglingSkipped ? `，跳过 ${danglingSkipped} 个悬空引用` : ''}`,
        })
        return
      }

      // ── 数据浏览（只读，绝不提供写接口）────────────────────────────────────
      if (request.method === 'GET' && path === '/data/files') {
        const dirParam = qp(url, 'dir')
        const boardSvc = services.board
        const stateDir = boardSvc?.paths?.stateDir ?? services.roster?.paths?.stateDir
        if (!stateDir) {
          sendJson(response, 503, { ok: false, reason: '状态目录不可用（域服务均未装配）' })
          return
        }
        let root = stateDir
        if (dirParam !== undefined && dirParam !== '') {
          if (!safeSegment(dirParam)) {
            sendJson(response, 400, { ok: false, reason: '非法子目录名' })
            return
          }
          root = join(stateDir, dirParam)
        }
        const files = []
        let note
        try {
          for (const name of readdirSync(root)) {
            if (!/\.(jsonl|json)$/i.test(name)) continue
            if (!safeSegment(name)) continue
            let st
            try {
              st = statSync(join(root, name))
            } catch {
              continue
            }
            if (!st.isFile()) continue
            const kind = /\.jsonl$/i.test(name) ? 'jsonl' : 'json'
            let lines = 0
            let truncated = false
            if (kind === 'jsonl') {
              if (st.size > 8 * 1024 * 1024) {
                lines = null
                truncated = true
              } else {
                try {
                  const text = readFileSync(join(root, name), 'utf8')
                  lines = text === '' ? 0 : text.split('\n').filter((x) => x.trim() !== '').length
                } catch {
                  lines = null
                  truncated = true
                }
              }
            }
            const row = { name, bytes: st.size, lines, mtime: st.mtimeMs, kind }
            if (truncated) row.truncated = true
            files.push(row)
          }
          files.sort((a, b) => b.mtime - a.mtime)
          note = `共 ${files.length} 个文件（只读浏览；写请走域服务与 CAS）`
        } catch (error) {
          note = `目录不可读：${error?.message ?? error}`
        }
        sendJson(response, 200, { ok: true, stateDir: root, files, note })
        return
      }

      // ── 单文件只读预览（契约 bots06 §2.2）────────────────────────────────
      // 只允许在状态目录内读：先按段校验（防 `..` / 通配符），再 resolve 后
      // 断言仍在 stateDir 内（防符号链接与绝对路径逃逸）。**绝不写任何文件**。
      if (request.method === 'GET' && path === '/data/file') {
        const rel = qp(url, 'path')
        if (!rel) {
          sendJson(response, 400, { ok: false, reason: 'path 必填' })
          return
        }
        const raw = String(rel)
        // 含 `..` 一律拒绝（段级判定对绝对路径不适用，但仍先挡穿越）。
        if (raw.includes('..')) {
          sendJson(response, 400, { ok: false, reason: '非法路径' })
          return
        }
        // 相对路径：逐段必须都是安全片段（空段 = 绝对路径 / 重复斜杠，另作处理）。
        const isAbs = raw.startsWith('/')
        if (!isAbs) {
          const segs = raw.split('/')
          if (segs.some((s) => s === '' || s === '.' || s === '..' || !SAFE_SEGMENT.test(s))) {
            sendJson(response, 400, { ok: false, reason: '非法路径' })
            return
          }
        }
        const stateDir = services.board?.paths?.stateDir ?? services.roster?.paths?.stateDir
        if (!stateDir) {
          sendJson(response, 503, { ok: false, reason: '状态目录不可用（域服务均未装配）' })
          return
        }
        const root = resolve(stateDir)
        const abs = resolve(root, raw)
        // 必须在 stateDir 内（含 stateDir 本身，但那必然是目录 → 后面 404）。
        if (abs !== root && !abs.startsWith(root + pathSep)) {
          sendJson(response, 403, { ok: false, reason: '越权访问（路径超出状态目录）' })
          return
        }
        let st
        try {
          st = statSync(abs)
        } catch {
          sendJson(response, 404, { ok: false, reason: '文件不存在' })
          return
        }
        if (!st.isFile()) {
          sendJson(response, 404, { ok: false, reason: '文件不存在' })
          return
        }
        let buf
        try {
          buf = readFileSync(abs)
        } catch {
          sendJson(response, 404, { ok: false, reason: '文件不存在' })
          return
        }
        if (isBinaryBuffer(buf)) {
          sendJson(response, 415, { ok: false, reason: '不支持的文件类型（仅预览文本）' })
          return
        }
        const content = buf.toString('utf8')
        const bytes = buf.length
        const PREVIEW_MAX = 100 * 1024
        let shown = content
        let truncated = false
        if (bytes > PREVIEW_MAX) {
          truncated = true
          shown = buf.subarray(0, PREVIEW_MAX).toString('utf8')
        }
        sendJson(response, 200, {
          ok: true,
          path: raw,
          content: shown,
          bytes,
          truncated,
          ...(truncated
            ? { shownBytes: Buffer.byteLength(shown, 'utf8'), totalBytes: bytes }
            : {}),
          mime: mimeFor(raw),
        })
        return
      }

      if (request.method === 'GET' && path === '/data/rows') {
        const name = qp(url, 'name')
        if (!name) {
          sendJson(response, 400, { ok: false, reason: 'name 必填' })
          return
        }
        if (!safeSegment(name) || !/\.(jsonl|json)$/i.test(name)) {
          sendJson(response, 400, { ok: false, reason: '非法文件名' })
          return
        }
        const dirParam = qp(url, 'dir')
        if (dirParam !== undefined && dirParam !== '' && !safeSegment(dirParam)) {
          sendJson(response, 400, { ok: false, reason: '非法子目录名' })
          return
        }
        const boardSvc = services.board
        const stateDir = boardSvc?.paths?.stateDir ?? services.roster?.paths?.stateDir
        if (!stateDir) {
          sendJson(response, 503, { ok: false, reason: '状态目录不可用（域服务均未装配）' })
          return
        }
        const root = dirParam ? join(stateDir, dirParam) : stateDir
        const abs = join(root, name)
        const limitRaw = qn(url, 'limit')
        const limit = limitRaw !== undefined && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
        const offsetRaw = qn(url, 'offset')
        const offset = offsetRaw !== undefined && offsetRaw > 0 ? offsetRaw : 0
        let text
        try {
          text = readFileSync(abs, 'utf8')
        } catch (error) {
          sendJson(response, 404, { ok: false, reason: `读取失败：${error?.message ?? error}` })
          return
        }
        const all = text.split('\n').filter((line) => line.trim() !== '')
        const page = all.slice(offset, offset + limit)
        const rowsOut = page.map((raw, i) => {
          const row = { _line: offset + i + 1, _raw: raw.length > 4000 ? raw.slice(0, 4000) : raw }
          if (raw.length > 4000) row._truncated = true
          if (/\.jsonl$/i.test(name)) {
            try {
              JSON.parse(raw)
            } catch {
              row._parseError = true
            }
          }
          return row
        })
        sendJson(response, 200, {
          ok: true,
          name,
          total: all.length,
          offset,
          rows: rowsOut,
          note: `共 ${all.length} 行，显示 ${all.length ? offset + 1 : 0}-${Math.min(offset + limit, all.length)}`,
        })
        return
      }

      // ── 任务依赖图（只读）──────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/tasks/graph') {
        const id = qp(url, 'id')
        const all = await withService(services, 'board', (b) =>
          b.list({}).filter((t) => t.status !== 'deleted'))
        const byIdMap = new Map(all.map((t) => [t.id, t]))
        const dependents = new Map()
        let danglingEdges = 0
        for (const t of all) {
          for (const dep of t.blockedBy ?? []) {
            if (!byIdMap.has(dep)) {
              danglingEdges += 1
              continue
            }
            if (!dependents.has(dep)) dependents.set(dep, [])
            dependents.get(dep).push(t.id)
          }
        }
        let picked
        if (id) {
          if (!byIdMap.has(id)) {
            sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
            return
          }
          const keep = new Set()
          const up = [id]
          while (up.length) {
            const cur = up.pop()
            if (keep.has(cur)) continue
            keep.add(cur)
            const t = byIdMap.get(cur)
            if (!t) continue
            for (const dep of t.blockedBy ?? []) {
              if (byIdMap.has(dep) && !keep.has(dep)) up.push(dep)
            }
          }
          const down = [id]
          while (down.length) {
            const cur = down.pop()
            for (const child of dependents.get(cur) ?? []) {
              if (!keep.has(child)) {
                keep.add(child)
                down.push(child)
              }
            }
          }
          picked = all.filter((t) => keep.has(t.id))
        } else {
          picked = all
        }
        // 字段恒定出现（前端画图不判 undefined）：ownerId/priority 缺省给 null/0
        const nodes = picked.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          ownerId: t.ownerId ?? null,
          progress: t.progress ?? 0,
          priority: t.priority ?? 0,
        }))
        const pickedIds = new Set(nodes.map((n) => n.id))
        const edges = []
        for (const t of picked) {
          for (const dep of t.blockedBy ?? []) {
            if (!pickedIds.has(dep)) continue
            edges.push({ from: t.id, to: dep, kind: 'blockedBy' })
          }
        }
        sendJson(response, 200, {
          ok: true,
          nodes,
          edges,
          note: `节点 ${nodes.length} 个，边 ${edges.length} 条${danglingEdges ? `，忽略悬空依赖 ${danglingEdges} 条` : ''}`,
        })
        return
      }

      // ── 阶段产出物（契约 §2.2 / §2.3 / §4.2）────────────────────────────
      if (request.method === 'GET' && path === '/tasks/phases') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        sendJson(response, 200, { ok: true, ...buildPhaseView(services, task) })
        return
      }

      if (request.method === 'POST' && path === '/tasks/phase') {
        const body = (await readBody(request)) ?? {}
        const out = writePhaseRow(services, body.id, {
          index: Number.isInteger(body.index) ? body.index : Number(body.index),
          state: body.state,
          artifacts: body.artifacts,
          note: body.note,
          by: body.by ?? OWNER,
          ...(body.expectedRev === undefined ? {} : { expectedRev: body.expectedRev }),
        })
        sendJson(response, 200, out)
        return
      }

      if (request.method === 'POST' && path === '/tasks/phases') {
        const body = (await readBody(request)) ?? {}
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        if (body.expectedRev !== undefined && body.expectedRev !== null) {
          if (!Number.isInteger(body.expectedRev)) {
            sendJson(response, 400, { ok: false, reason: `expectedRev 必须是整数（当前 rev=${task.rev}）` })
            return
          }
          if (body.expectedRev !== task.rev) {
            sendJson(response, 409, {
              ok: false,
              reason: `CAS 冲突：任务 ${id} 期望 rev=${body.expectedRev}，实际 rev=${task.rev} —— 请刷新后重试`,
            })
            return
          }
        }
        const phases = normalizePhases(body.phases, 'TASK_BAD_PHASES')
        const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : OWNER
        let note = 'Boss 调整阶段清单'
        if (body.note !== undefined && body.note !== null) {
          if (typeof body.note !== 'string') {
            sendJson(response, 400, { ok: false, reason: 'note 必须是字符串（也可以不传）' })
            return
          }
          const text = body.note.trim()
          if (Array.from(text).length > LONGRUN_PHASE_MAX) {
            sendJson(response, 400, {
              ok: false,
              reason: `note 最多 ${LONGRUN_PHASE_MAX} 字（收到 ${Array.from(text).length} 字）`,
            })
            return
          }
          if (text) note = text
        }
        // 只追加一条 `kind:'longrun'` 行 —— `kind:'phase'` 行**一根都不动**（契约 §4.2）：
        // Boss 改的是计划，已交的证据不因此消失；清单变短时越界产物只是不再展示。
        appendTaskMeta(services, { kind: 'longrun', taskId: id, phases, note, by, at: Date.now() })
        const view = buildPhaseView(services, { ...task, id })
        sendJson(response, 200, {
          ok: true,
          taskId: id,
          phases: view.phases,
          currentIndex: view.currentIndex,
          totalArtifacts: view.totalArtifacts,
          isLongrun: view.isLongrun,
          note,
        })
        return
      }

      // ── 任务：详情穿透 / 指派 / 终止 / 编辑 ──────────────────────────────
      if (request.method === 'GET' && path === '/tasks/detail') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const detail = await withService(services, 'board', (b) => ({
          task: b.get(id),
          history: typeof b.history === 'function' ? b.history(id) : [],
        }))
        if (!detail.task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        sendJson(response, 200, {
          ok: true,
          // 改造07（借鉴 Super-agent stage table）：阶段机结果附在详情里
          stageInfo: deriveStage(detail.task),
          ...detail,
        })
        return
      }

      if (request.method === 'GET' && path === '/tasks/diagnose') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        sendJson(response, 200, await diagnoseTask(ctx, services, task))
        return
      }

      if (request.method === 'POST' && path === '/tasks/assign') {
        const body = (await readBody(request)) ?? {}
        if (!body.id || !body.ownerId) {
          sendJson(response, 400, { ok: false, reason: 'id 与 ownerId 必填' })
          return
        }
        // 指派 = 用 ownerId 作为 claim 的 byId（board 的 claim 把 by 记为 owner）
        // 改造07：claim 前先跑 Bot 的 prepare command（借鉴 Super-agent）。
        // 准备失败 → **不 claim**，任务保持原状（绝不产生「claim 了但没准备好」的半成品）。
        const bot = await withService(services, 'roster', (r) => r.get(body.ownerId))
        let prepare = { ok: true, skipped: true }
        if (bot && typeof bot.prepareCommand === 'string' && bot.prepareCommand.trim()) {
          prepare = await runPrepareCommand(bot)
          if (!prepare.ok) {
            const current = await withService(services, 'board', (b) => b.get(body.id))
            sendJson(response, 200, {
              ok: false,
              code: 'PREPARE_FAILED',
              task: current ?? undefined,
              prepare,
              reason: `开工准备失败（${prepare.error ?? '未知原因'}），任务未认领`
                + `。准备命令：${prepare.command ?? bot.prepareCommand}`,
            })
            return
          }
        }
        const task = await withService(services, 'board', (b) =>
          b.update({
            id: body.id,
            expectedRev: body.expectedRev,
            action: 'claim',
            byId: body.ownerId,
            ...(body.leaseMs ? { leaseMs: body.leaseMs } : {}),
          }),
        )
        // 指派后立刻定向唤醒（dedupKey 幂等：同任务同原因只唤一次）
        let wake
        let revive
        if (services.dispatcher && body.wake !== false) {
          // 契约 bots05 §2.3：投递前先确保会话 live（重启后宿主懒加载 → 否则必然
          // agent-not-live）。复活失败**不阻断**：仍照原样 notify，让 wake 如实报 reason。
          revive = await ensureLive(ctx, body.ownerId)
          // 2026-11-09：投递能力预检 —— 没有模型路由的会话**唤醒了也必然失败**，
          // 且失败发生在宿主内部、wake 仍记 sent ⇒ 任务静默卡在「排队中」。
          // 这里改成「先判、不投、把原因写到任务上」，让它以 person/delivery 显形。
          const deliverable = assertDeliverable(ctx, body.ownerId)
          if (!deliverable.ok) {
            const marked = await markDeliveryFailure(services, task.id, deliverable.reason, body.ownerId)
            wake = { result: 'failed', reason: `undeliverable:${deliverable.reason}`, target: body.ownerId }
            sendJson(response, 200, {
              ok: true, task, wake, prepare, marked, ...reviveFields(revive),
            })
            return
          }
          // 投递前取基线：投递后靠它判断「执行者到底动没动」
          const assignBaseline = await takeWatermarkBaseline(ctx, body.ownerId)
          wake = services.dispatcher.notify({
            target: body.ownerId,
            reason: 'task-assigned',
            dedupKey: `task-assigned:${task.id}:${task.rev}`,
            // 2026-11-09：改成**锚定文案**（与 /tasks/wake、补充说明同一套）。
            // 原来的 `新任务 t-x：标题\n描述` 有三处不如它：
            //   ① 长任务的阶段清单不在里面 —— 第一次派活执行者看不到路线（需求3 的核心）
            //   ② 没有写入边界 / 依赖 / 授权依据（mandate）—— 越界风险
            //   ③ 与后面每次唤醒的文案不同源，容易出现「第一轮和后面几轮看到的活不一样」
            text: buildTaskAnchorText(task, readTaskNotes(services, task.id), readLongrunMeta(services, task.id)),
          })
          // wake 层就失败了（agent-not-live / dispatcher 拒收）→ 同样落到任务上。
          if (wake && wake.result === 'failed') {
            await markDeliveryFailure(services, task.id, wake.reason ?? 'wake-failed', body.ownerId)
          } else if (wake) {
            // 2026-11-09：投递真的成功了 ⇒ 清掉上一次的失败留痕（否则任务会
            // 永远停在「输入投递失败」，阶段机被过期事实劫持，见
            // `clearDeliveryFailure` 的说明）。
            await clearDeliveryFailure(services, task.id, wake)
          }
          // 发出去了就等回执：过了宽限期会话水位还没涨 ⇒ 判「未开始动作」
          armDeliveryWatch(services, task.id, body.ownerId, assignBaseline, wake)
        }
        sendJson(response, 200, { ok: true, task, wake, prepare, ...reviveFields(revive) })
        return
      }

      if (request.method === 'POST' && path === '/tasks/expire-leases') {
        // ⚠️ 修复（2026-11-04 测试，P1-4）：expireLeases 之前无任何调用者，
        //   owner 崩溃/失联后任务永久停在 in_progress。现在通过 API 暴露回收能力。
        const body = (await readBody(request)) ?? {}
        const recycled = await withService(services, 'board', (b) =>
          b.expireLeases({ now: Number.isFinite(body.now) ? body.now : undefined }),
        )
        sendJson(response, 200, { ok: true, recycled, note: recycled.length ? `回收了 ${recycled.length} 个过期任务` : '没有过期租约需要回收' })
        return
      }

      if (request.method === 'POST' && path === '/tasks/abort') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        // 终止 = block + 原因（board 的 block 会置 blocked 并留 reason；可 reopen）
        const task = await withService(services, 'board', (b) =>
          b.update({
            id: body.id,
            expectedRev: body.expectedRev,
            action: 'block',
            note: body.reason ?? '用户终止',
            byId: body.byId ?? 'ui',
          }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      if (request.method === 'POST' && path === '/tasks/edit') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) =>
          b.update({ ...body, action: 'edit', byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      if (request.method === 'GET' && path === '/tasks/history') {
        const id = qp(url, 'id')
        const history = await withService(services, 'board', (b) =>
          typeof b.history === 'function' ? b.history(id) : [],
        )
        sendJson(response, 200, { ok: true, history })
        return
      }

      // ── 任务目标锚（契约 bots04 §2.1）：创建时冻结的目标原文 + 锚定文案 ──
      if (request.method === 'GET' && path === '/tasks/brief') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        const notes = readTaskNotes(services, task.id)
        sendJson(response, 200, {
          ok: true,
          taskId: task.id,
          anchor: buildTaskAnchor(task),
          notes,
          text: buildTaskAnchorText(task, notes, readLongrunMeta(services, task.id)),
          note: '目标锚来自任务创建时的原文；补充说明另存，不会覆盖目标',
        })
        return
      }

      // ── 补充说明（契约 bots04 §2.2）：append-only，永不覆盖目标 ──────────
      if (request.method === 'POST' && path === '/tasks/note') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          sendJson(response, 400, { ok: false, reason: '补充说明不能为空' })
          return
        }
        if (text.length > ANCHOR_TEXT_MAX) {
          sendJson(response, 400, { ok: false, reason: `补充说明过长（最多 ${ANCHOR_TEXT_MAX} 字）` })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(body.id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${body.id} 不存在` })
          return
        }
        // 唤醒前置检查放在落盘**之前**：dispatcher 缺失时直接 503，
        // 避免「说明已落盘但唤醒静默失败」的半成品状态。
        const shouldWake = body.wake !== false && Boolean(task.ownerId)
        const dispatcher = shouldWake
          ? await withService(services, 'dispatcher', (d) => d)
          : undefined

        const file = taskNotesPath(services)
        if (!file) {
          const error = new Error('状态目录不可用（task-notes.jsonl 无法落盘）')
          error.status = 503
          throw error
        }
        const { rows } = readJsonl(file)
        const note = {
          id: nextTaskNoteId(rows),
          taskId: task.id,
          text,
          by: typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ui',
          at: Date.now(),
        }
        if (!appendJsonl(file, note)) {
          const error = new Error(`补充说明落盘失败（${file}）`)
          error.status = 503
          throw error
        }

        let wake = null
        let revive
        // 契约 §7.2：人发了话，机器要跟着动（详见 autoActivate 注释）
        const activated = await autoActivate(services, task, note.by)
        if (shouldWake) {
          // 契约 bots05 §2.3：投递前先确保 owner 会话 live（失败不阻断，wake 会如实报错）。
          revive = await ensureLive(ctx, task.ownerId)
          // 唤醒文案 = 完整锚定文案（含刚追加的这条）+ 【新增补充说明】<text>
          // 这正是「长任务不失真」的落点：Bot 每次被唤醒都看到全量目标原文。
          const notes = readTaskNotes(services, task.id)
          services.deliveryWatch?.cancelByTask?.(task.id)
          const noteBaseline = await takeWatermarkBaseline(ctx, task.ownerId)
          wake = dispatcher.notify({
            target: task.ownerId,
            reason: 'task-assigned',
            dedupKey: `task-note:${task.id}:${note.id}`,
            text: `${buildTaskAnchorText(task, notes, readLongrunMeta(services, task.id))}\n\n【新增补充说明】${note.text}`,
          })
          armDeliveryWatch(services, task.id, task.ownerId, noteBaseline, wake)
        }
        sendJson(response, 200, { ok: true, note, wake, activated, ...reviveFields(revive) })
        return
      }

      // ── 补充说明历史（契约 bots04 §2.3）：只读，按 at 升序 ────────────────
      if (request.method === 'GET' && path === '/tasks/notes') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        sendJson(response, 200, { ok: true, taskId: task.id, notes: readTaskNotes(services, task.id) })
        return
      }

      // ── 任务结论摘要（契约 bots06 §2.3）：只读 ────────────────────────────
      if (request.method === 'GET' && path === '/tasks/summary') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        const note = latestTaskNote(services, task.id)
        const lastNoteContent = note ? String(note.content ?? '') : null
        const stepConclusions = readTaskWakes(services, task.id).map(toStepConclusion)
        sendJson(response, 200, {
          ok: true,
          taskId: task.id,
          currentProgress: {
            status: task.status,
            progress: task.progress ?? 0,
            progressText: `${task.progress ?? 0}% · ${statusText(task.status)}`,
            lastNote: lastNoteContent,
          },
          // 改造07（借鉴 Super-agent stage table）：阶段机结果
          stageInfo: deriveStage(task),
          stepConclusions,
          nextStep: lastNoteContent ? extractNextStep(lastNoteContent) : null,
          // ── 执行者状态（2026-11-09：「任务显示正在执行中，但我看不到过程」）────
          // 「投递成功」不等于「真的在跑」。这里把三件事一次说清：
          //   会话在不在线 / 最近一次唤醒的结果 / 有没有投递失败
          // 这样用户能区分「Bot 在干活」和「Bot 根本没动」。
          executor: buildExecutorStatus(ctx, services, task),
          note: SUMMARY_NOTE,
        })
        return
      }

      // ── 来源跳转（契约 bots04 §2.5）：任务 → 消息出处 ──────────────────
      //
      // 只读端点：**不写任何文件**（与 §2.1/§2.3 同口径）。
      // 房间侧信息全部来自 room 服务：
      //   - `get(roomId)` 拿名字、判断房间是否还在（已删 → exists:false）；
      //   - `listMessages({roomId, sinceSeq: seq-1, limit:1, withBody:true})`
      //     精确判断那条消息是否存在（seq 连续 → 取不到就是真的不存在）。
      // 房间已删时 `listMessages` 会抛 `ROOM_NOT_FOUND`：那是**房间不存在**
      // 的事实，不是「消息不存在」，两者必须区分开（契约要求不静默、不猜测）。
      if (request.method === 'GET' && path === '/tasks/source') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }

        const parsed = parseSourceSeq(task.sourceSeq)
        let payload = buildSourcePayload(task, parsed)

        if (parsed?.kind === 'room') {
          const room = await withService(services, 'room', (r) => r.get(parsed.roomId))
          const roomExists = room !== undefined && room !== null
          let messageExists = null
          let messageAt = null
          let preview = null

          if (roomExists) {
            // seq 连续：sinceSeq = seq-1 + limit 1 只会命中 seq 那一条
            const rows = await withService(services, 'room', (r) =>
              r.listMessages({ roomId: parsed.roomId, sinceSeq: parsed.seq - 1, limit: 1, withBody: true }),
            )
            const hit = Array.isArray(rows) ? rows.find((m) => Number(m?.seq) === parsed.seq) : undefined
            messageExists = hit !== undefined
            messageAt = hit?.at ?? null
            preview = hit ? sourcePreview(hit) : null
          }

          payload = {
            ...payload,
            room: {
              ...payload.room,
              name: room?.name ?? null,
              exists: roomExists,
              messageExists,
              at: messageAt,
              preview,
            },
            // 房间已删也如实返回 jump（数据不丢，是否可跳由前端决定 —— 契约 §2.5）
            jump: payload.jump,
          }
        }

        sendJson(response, 200, payload)
        return
      }

      // ── 手动重试唤醒（契约 bots05 §2.4）：专治「重试看起来没反应」 ──────
      //
      // 为什么需要单独端点：/tasks/assign 的 dedupKey 是 `task-assigned:<id>:<rev>`，
      // 重试时 rev 没变 ⇒ 命中去重 ⇒ skipped，人点「重试」看起来像没反应。
      if (request.method === 'POST' && path === '/tasks/wake') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(body.id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${body.id} 不存在` })
          return
        }
        if (!task.ownerId) {
          sendJson(response, 400, { ok: false, reason: '任务没有负责人，无法唤醒' })
          return
        }
        // dispatcher 缺失 → 503（先于复活副作用，避免「复活了却没地方投递」）。
        const dispatcher = await withService(services, 'dispatcher', (d) => d)
        const revive = await ensureLive(ctx, task.ownerId)
        // 契约 §7.2：唤醒前顺手把租约续上（进行中 ⇒ 心跳；待领 ⇒ 自动接活）。
        // ⚠️ 顺序很重要（回归 R15）：**先算 dedupKey，再 autoActivate**。
        // autoActivate 会 bump rev（心跳/认领都写事件），若先激活再算键，
        // `force:false` 的幂等键 `task-wake:<id>:<rev>` 就会跟着漂，
        // 契约 §8「同一任务同一 rev 的重试只唤醒一次」被破坏。
        const force = body.force !== false
        const dedupKey = typeof body.dedupKey === 'string' && body.dedupKey.trim()
          ? body.dedupKey.trim()
          : (force ? `task-wake:${task.id}:${Date.now()}` : `task-wake:${task.id}:${task.rev}`)
        const activated = await autoActivate(services, task, task.ownerId)
        // 2026-11-09：同一道投递能力预检（手动重试也不该往死会话里投）。
        const deliverable = assertDeliverable(ctx, task.ownerId)
        if (!deliverable.ok) {
          const marked = await markDeliveryFailure(services, task.id, deliverable.reason, task.ownerId)
          sendJson(response, 200, {
            ok: true,
            taskId: task.id,
            ownerId: task.ownerId,
            live: revive.live,
            revived: revive.revived,
            activated,
            marked,
            wake: { result: 'failed', reason: `undeliverable:${deliverable.reason}`, target: task.ownerId },
          })
          return
        }
        // 人点「重试」= 重新建立一次期望（旧的那条自然被覆盖）
        services.deliveryWatch?.cancelByTask?.(task.id)
        const wakeBaseline = await takeWatermarkBaseline(ctx, task.ownerId)
        const wake = dispatcher.notify({
          target: task.ownerId,
          reason: 'task-assigned',
          dedupKey,
          text: buildTaskAnchorText(task, readTaskNotes(services, task.id), readLongrunMeta(services, task.id)),
        })
        if (wake && wake.result === 'failed') {
          await markDeliveryFailure(services, task.id, wake.reason ?? 'wake-failed', task.ownerId)
        } else if (wake) {
          // 2026-11-09：手动重试成功 ⇒ 清掉上次的失败留痕（否则任务永久停在
          // 「输入投递失败」），见 `clearDeliveryFailure` 的说明。
          await clearDeliveryFailure(services, task.id, wake)
        }
        armDeliveryWatch(services, task.id, task.ownerId, wakeBaseline, wake)
        sendJson(response, 200, {
          ok: true,
          taskId: task.id,
          ownerId: task.ownerId,
          live: revive.live,
          revived: revive.revived,
          activated,
          ...(revive.live ? {} : { reviveReason: revive.reason ?? 'revive-failed' }),
          wake,
        })
        return
      }

      // ══════════════════════════════════════════════════════════════════════
      // 改造06 · 任务变更中心（契约 CONTRACT-bots06 §2）
      //
      // 用户原话：「完成的任务应该可以纠错或者优化或者更改或其他变更，变更成长任务」
      //           「任务可以变更负责人」。
      // 两条铁律：
      //   · 变更必须有理由（note 必填）；没有理由的变更不许进历史。
      //   · 证据不能丢（reopen 前先快照，见 reopenWithSnapshot）。
      // ══════════════════════════════════════════════════════════════════════

      // ── 换负责人（契约 §2.1）────────────────────────────────────────────
      if (request.method === 'POST' && path === '/tasks/reassign') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        if (!body.ownerId || typeof body.ownerId !== 'string' || !body.ownerId.trim()) {
          sendJson(response, 400, { ok: false, reason: 'ownerId 必填' })
          return
        }
        const ownerId = body.ownerId.trim()
        const by = typeof body.byId === 'string' && body.byId.trim() ? body.byId.trim() : 'ui'
        let task = await withService(services, 'board', (b) => b.get(body.id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${body.id} 不存在` })
          return
        }
        // ② 已完成任务先拦：不让用户撞 board.claim 的 BOARD_ALREADY_COMPLETED，
        //    而是给一条「接下来该点哪」的可操作提示。
        if (task.status === 'completed') {
          const error = new Error('任务已完成，请先「重开」或「派生优化单」再换负责人')
          error.status = 400
          error.code = 'TASK_COMPLETED'
          throw error
        }
        // 前端会带 expectedRev（CAS）：先于任何变更校验，避免覆盖别人的改动。
        if (body.expectedRev !== undefined && body.expectedRev !== null && task.rev !== body.expectedRev) {
          const error = new Error(
            `任务 ${task.id} 版本冲突：期望 rev=${body.expectedRev}，实际 rev=${task.rev} —— 请刷新后重试`,
          )
          error.status = 400
          error.code = 'BOARD_REV_CONFLICT'
          throw error
        }
        const from = task.ownerId ?? task.lease?.ownerId ?? null
        // dispatcher 缺失时**先** 503（此操作无副作用）：避免「任务已换人但唤不醒」
        // 或「租约已交还却换不了人」的半成品状态。
        const shouldWake = body.wake !== false
        const dispatcher = shouldWake
          ? await withService(services, 'dispatcher', (d) => d)
          : undefined
        // ③ 原租约仍有效且持有人不是新负责人 → 以**原持有者身份**交还
        //   （board.release 要求 byId === lease.ownerId，平台只是代为操作）。
        const lease = task.lease
        const leaseLive = Boolean(lease)
          && Number.isFinite(Number(lease.expiresAt))
          && Number(lease.expiresAt) > Date.now()
        if (leaseLive && lease.ownerId && lease.ownerId !== ownerId) {
          task = await withService(services, 'board', (b) => b.update({
            id: task.id,
            expectedRev: task.rev,
            action: 'release',
            byId: String(lease.ownerId),
          }))
        }
        // ④ 以新负责人身份领取（force:true 绕过 blockedBy 未完成）。
        let next
        try {
          next = await withService(services, 'board', (b) => b.update({
            id: task.id,
            expectedRev: task.rev,
            action: 'claim',
            byId: ownerId,
            force: true,
            ...(body.leaseMs !== undefined && body.leaseMs !== null ? { leaseMs: body.leaseMs } : {}),
          }))
        } catch (error) {
          // WIP 超限：**原样回传内核错误码**，只补一句人话，绝不吞成「success」。
          if (error?.code === 'BOARD_WIP_EXCEEDED' || error?.code === 'BOARD_WIP_LIMIT') {
            const wrapped = new Error(
              `${error.message}（提示：先让该 Bot 交付或释放已有任务，或在设置里调高 wipLimitPerBot 后再换负责人）`,
            )
            wrapped.status = 400
            wrapped.code = error.code
            throw wrapped
          }
          throw error
        }
        // ⑤ 唤醒：确保新负责人会话 live（失败不阻断，wake 会如实报错误原因）。
        let wake = null
        let revive
        if (shouldWake) {
          revive = await ensureLive(ctx, ownerId)
          wake = dispatcher.notify({
            target: ownerId,
            reason: 'task-assigned',
            dedupKey: `task-reassign:${next.id}:${next.rev}`,
            text: buildTaskAnchorText(
              next,
              readTaskNotes(services, next.id),
              readLongrunMeta(services, next.id),
            ),
          })
        }
        // ⑥ 变更历史（append-only；与快照/重开共用同一份 task-meta.jsonl）。
        appendTaskMeta(services, {
          kind: 'reassign', taskId: next.id, from, to: ownerId, by, at: Date.now(),
        })
        // ⑦ 回显：from/to 让前端能显示「已从 A 换到 B」。
        sendJson(response, 200, {
          ok: true,
          task: next,
          from,
          to: ownerId,
          wake,
          ...reviveFields(revive),
        })
        return
      }

      // ── 变更中心（契约 §2.2）：reopen | followup | longrun ──────────────
      if (request.method === 'POST' && path === '/tasks/evolve') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const mode = typeof body.mode === 'string' ? body.mode.trim() : ''
        if (!EVOLVE_MODES.includes(mode)) {
          const error = new Error(`mode 必须是 ${EVOLVE_MODES.join(' | ')}（收到 ${JSON.stringify(body.mode)}）`)
          error.status = 400
          error.code = 'EVOLVE_BAD_MODE'
          throw error
        }
        // note 三种模式都必填：没有理由的变更不许进历史。
        const note = typeof body.note === 'string' ? body.note.trim() : ''
        if (!note) {
          const error = new Error('变更说明不能为空（没有理由的变更不许进历史）')
          error.status = 400
          error.code = 'EVOLVE_NOTE_REQUIRED'
          throw error
        }
        if (note.length > EVOLVE_NOTE_MAX) {
          const error = new Error(`变更说明过长（最多 ${EVOLVE_NOTE_MAX} 字）`)
          error.status = 400
          error.code = 'EVOLVE_NOTE_TOO_LONG'
          throw error
        }
        const by = typeof body.byId === 'string' && body.byId.trim() ? body.byId.trim() : 'ui'
        const task = await withService(services, 'board', (b) => b.get(body.id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${body.id} 不存在` })
          return
        }

        // mode=reopen（纠错 / 继续做）：快照 → 内核 reopen → 记历史。
        if (mode === 'reopen') {
          const { task: reopened, snapshot } = await reopenWithSnapshot(services, task, by, note)
          sendJson(response, 200, {
            ok: true,
            task: reopened,
            snapshot,
            note: '已重开；上一轮交付物已存档，见 changes',
          })
          return
        }

        // mode=followup（优化 / 修复单）：原任务**保持已完成**，派生一张新任务。
        if (mode === 'followup') {
          const prefix = evolvePrefixFor(note)
          // 幂等键：note 的 sha1 前缀 —— 连点两次同一说明只建一个；
          // 不同说明是不同诉求，允许各建一张（不能用 task.rev，否则第二次派生
          // 会静默命中第一张，用户看不到自己新写的理由）。
          const seq = createHash('sha1').update(note).digest('hex').slice(0, 12)
          const sourceSeq = `evolve:${task.id}:${seq}`
          const originDesc = typeof task.description === 'string' ? task.description : ''
          const description = [
            originDesc.trim() ? originDesc : null,
            `【变更说明】${note}`,
            `【来源】原任务 ${task.id}：${task.subject}`,
          ].filter((part) => part !== null).join('\n\n')
          const createInput = {
            subject: `${prefix}${task.subject}`,
            description,
            byId: by,
            sourceSeq,
          }
          // priority 继承原任务；assignee 继承 assignee ?? ownerId（契约 §2.2）。
          if (task.priority !== undefined) createInput.priority = task.priority
          const assignee = task.assignee ?? task.ownerId
          if (assignee) createInput.assignee = assignee
          const created = await withService(services, 'board', (b) => b.create(createInput))
          // 幂等命中（连点）时不重复记历史：同一条 followup 只留一行。
          const already = readTaskMeta(services, task.id).some(
            (row) => row.kind === 'followup' && row.newTaskId === created.id,
          )
          if (!already) {
            appendTaskMeta(services, {
              kind: 'followup',
              taskId: task.id,
              newTaskId: created.id,
              note,
              by,
              at: Date.now(),
            })
          }
          sendJson(response, 200, {
            ok: true,
            task: created,
            origin: task.id,
            prefix,
            note: `已派生 ${created.id}（幂等键 ${sourceSeq}，重复点不会建两个）`,
          })
          return
        }

        // mode=longrun（转成长任务）：阶段清单进 task-meta，唤醒文案自动带上。
        const phases = normalizePhases(body.phases, 'EVOLVE_BAD_PHASES')
        // ① reopen:true 时按 reopen 流程重开（快照必须在内核清空 artifacts 之前落盘）。
        let current = task
        if (body.reopen === true) {
          current = (await reopenWithSnapshot(services, task, by, note)).task
        }
        // ② 记 longrun（契约 §2.2 longrun 步骤 2；不动任务本体）。
        appendTaskMeta(services, {
          kind: 'longrun', taskId: task.id, phases, note, by, at: Date.now(),
        })
        // ③ 记一条补充说明，内容 = 【转长任务】 + note + 阶段清单（步骤 4）。
        appendTaskNoteRow(
          services,
          task.id,
          `【转长任务】${note}\n阶段清单：\n${phases.map((phase, index) => `${index + 1}. ${phase}`).join('\n')}`,
          by,
        )
        sendJson(response, 200, {
          ok: true,
          task: current,
          phases,
          note: '已标记为长任务；后续每次唤醒都会带上阶段清单',
        })
        return
      }

      // ── 变更历史（契约 §2.3）：只读，按 at 升序 ─────────────────────────
      if (request.method === 'GET' && path === '/tasks/changes') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        const rows = readTaskMeta(services, task.id)
        // 契约 §2.3 的条目只暴露 kind/at/...（taskId 由外层给，逐条不重复）。
        const changes = rows.map(({ taskId, ...rest }) => rest)
        const longrunRows = rows.filter((row) => row.kind === 'longrun' && Array.isArray(row.phases))
        const lastLongrun = longrunRows.length ? longrunRows[longrunRows.length - 1] : null
        const snapshotRows = rows.filter((row) => row.kind === 'snapshot' && row.before)
        const lastSnapshot = snapshotRows.length ? snapshotRows[snapshotRows.length - 1] : null
        sendJson(response, 200, {
          ok: true,
          taskId: task.id,
          changes,
          longrun: lastLongrun ? { phases: [...lastLongrun.phases], at: lastLongrun.at } : null,
          latestSnapshot: lastSnapshot ? lastSnapshot.before : null,
        })
        return
      }

      // ── 直发消息（契约 bots04 §2.4）：从协作平台直接给某个 Bot 会话说话 ──
      if (request.method === 'POST' && path === '/bots/message') {
        const body = (await readBody(request)) ?? {}
        if (!body.botId && !body.sessionId) {
          sendJson(response, 400, { ok: false, reason: 'botId 或 sessionId 必填' })
          return
        }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          sendJson(response, 400, { ok: false, reason: '消息不能为空' })
          return
        }
        if (text.length > ANCHOR_TEXT_MAX) {
          sendJson(response, 400, { ok: false, reason: `消息过长（最多 ${ANCHOR_TEXT_MAX} 字）` })
          return
        }
        let sessionId
        if (body.botId) {
          const bot = await withService(services, 'roster', (r) => r.get(body.botId))
          if (!bot) {
            sendJson(response, 404, { ok: false, reason: `Bot ${body.botId} 不存在` })
            return
          }
          sessionId = bot.sessionId
        } else {
          sessionId = body.sessionId
        }
        // 未知 sessionId 仍允许（可能是主对话），但必须如实告知 knownBot:false。
        const knownBot = await withService(services, 'roster', (r) => r.hasSession(sessionId))

        let prefix = ''
        if (body.taskId) {
          const task = await withService(services, 'board', (b) => b.get(body.taskId))
          if (!task) {
            sendJson(response, 404, { ok: false, reason: `任务 ${body.taskId} 不存在` })
            return
          }
          prefix = `${buildTaskAnchorText(task, readTaskNotes(services, task.id), readLongrunMeta(services, task.id))}\n\n`
        }
        const deliveredText = prefix + text
        const hash = createHash('sha1')
          .update(`${body.taskId ?? ''}${text}`)
          .digest('hex')
          .slice(0, 16)
        const dedupKey = typeof body.dedupKey === 'string' && body.dedupKey.trim()
          ? body.dedupKey.trim()
          : `ui-msg:${hash}`
        const dispatcher = await withService(services, 'dispatcher', (d) => d)
        // 契约 bots05 §2.3：投递前先确保目标会话 live（失败不阻断，wake 会如实报错）。
        const revive = await ensureLive(ctx, sessionId)
        const wake = dispatcher.notify({
          target: sessionId,
          reason: 'room-message',
          dedupKey,
          text: deliveredText,
        })
        sendJson(response, 200, {
          ok: true,
          sessionId,
          knownBot,
          wake,
          text: deliveredText,
          ...reviveFields(revive),
        })
        return
      }

      // ── 手动复活 Bot 会话（契约 bots05 §2.2）：重启 dsh-web 后一键拉起来 ──
      if (request.method === 'POST' && path === '/bots/revive') {
        const body = (await readBody(request)) ?? {}
        // 批量：遍历未退役的 Bot，**串行** ensureLive（最多 REVIVE_MAX 个）。
        if (body.all === true) {
          const bots = await withService(services, 'roster', (r) => r.list())
          const targets = bots.filter((b) => b?.state !== 'retired').slice(0, REVIVE_MAX)
          const revived = []
          const live = []
          const failed = []
          for (const bot of targets) {
            const result = await ensureLive(ctx, bot.sessionId)
            if (result.live) live.push(bot.sessionId)
            if (result.revived) revived.push(bot.sessionId)
            if (!result.live) failed.push({ sessionId: bot.sessionId, reason: result.reason })
          }
          sendJson(response, 200, { ok: true, total: targets.length, revived, live, failed })
          return
        }
        // 单个：botId 解析出 sessionId（找不到 404），或直接给 sessionId。
        let sessionId
        if (body.botId) {
          const bot = await withService(services, 'roster', (r) => r.get(body.botId))
          if (!bot) {
            sendJson(response, 404, { ok: false, reason: `Bot ${body.botId} 不存在` })
            return
          }
          sessionId = bot.sessionId
        } else if (typeof body.sessionId === 'string' && body.sessionId.trim()) {
          sessionId = body.sessionId.trim()
        } else {
          sendJson(response, 400, { ok: false, reason: 'botId / sessionId / all 三选一必填' })
          return
        }
        const revive = await ensureLive(ctx, sessionId)
        // ok:true = 请求已处理；复活是否成功看 live（失败给 reason，不是 500）。
        sendJson(response, 200, {
          ok: true,
          sessionId,
          live: revive.live,
          revived: revive.revived,
          ...(revive.live ? {} : { reason: revive.reason ?? 'revive-failed' }),
        })
        return
      }

      // ── 房间：成员管理 / 转发 ─────────────────────────────────────────────
      if (request.method === 'POST' && path === '/rooms/update') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.update({ ...body, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      if (request.method === 'POST' && path === '/rooms/join') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.join({ roomId: body.roomId, sessionId: body.sessionId, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      if (request.method === 'POST' && path === '/rooms/leave') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.leave({ roomId: body.roomId, sessionId: body.sessionId, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      if (request.method === 'POST' && path === '/rooms/relay') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'room', (r) =>
          r.relay({ roomId: body.roomId, messageId: body.messageId, targets: body.targets }),
        )
        sendJson(response, 200, { ok: true, ...result })
        return
      }

      // ── 记忆：改 / 归档 / 恢复 ────────────────────────────────────────────
      if (request.method === 'POST' && path === '/memory/update') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.update({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      if (request.method === 'POST' && path === '/memory/remove') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.remove({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      if (request.method === 'POST' && path === '/memory/archive') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.archive({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      if (request.method === 'POST' && path === '/memory/restore') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.restore({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      // ── 目录浏览（宿主原生选择器不可用时的兜底，也是唯一能「新建/重命名」的路径）──
      if (request.method === 'GET' && path === '/fs/roots') {
        const r = await withService(services, 'dirbrowse', (d) => d.roots())
        sendJson(response, 200, { ok: true, ...r })
        return
      }
      if (request.method === 'GET' && path === '/fs/list') {
        const dir = qp(url, 'path')
        const showHidden = qp(url, 'showHidden') === '1'
        const listing = await withService(services, 'dirbrowse', (d) =>
          d.list({ ...(dir ? { path: dir } : {}), showHidden }),
        )
        sendJson(response, 200, { ok: true, ...listing })
        return
      }
      if (request.method === 'POST' && path === '/fs/mkdir') {
        const body = (await readBody(request)) ?? {}
        const created = await withService(services, 'dirbrowse', (d) => d.mkdir(body))
        sendJson(response, 200, { ok: true, ...created })
        return
      }
      if (request.method === 'POST' && path === '/fs/rename') {
        const body = (await readBody(request)) ?? {}
        const renamed = await withService(services, 'dirbrowse', (d) => d.rename(body))
        sendJson(response, 200, { ok: true, ...renamed })
        return
      }
      if (request.method === 'POST' && path === '/fs/validate') {
        const body = (await readBody(request)) ?? {}
        const verdict = await withService(services, 'dirbrowse', (d) => d.validateAsBotCwd({ path: body.path }))
        sendJson(response, 200, { ok: true, verdict })
        return
      }

      // ── 技能库 / 工作流库 ─────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/library/skills') {
        const rows = await withService(services, 'library', (l) => l.listSkills({ tag: qp(url, 'tag') }))
        sendJson(response, 200, { ok: true, skills: rows })
        return
      }
      if (request.method === 'POST' && path === '/library/skills') {
        const body = (await readBody(request)) ?? {}
        const skill = await withService(services, 'library', (l) => l.createSkill({ ...body, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/update') {
        const body = (await readBody(request)) ?? {}
        const skill = await withService(services, 'library', (l) => l.updateSkill({ ...body, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'library', (l) => l.removeSkill({ id: body.id, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'GET' && path === '/library/workflows') {
        const rows = await withService(services, 'library', (l) => l.listWorkflows({ tag: qp(url, 'tag') }))
        sendJson(response, 200, { ok: true, workflows: rows })
        return
      }
      if (request.method === 'POST' && path === '/library/workflows') {
        const body = (await readBody(request)) ?? {}
        const workflow = await withService(services, 'library', (l) => l.createWorkflow({ ...body, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, workflow })
        return
      }
      if (request.method === 'POST' && path === '/library/workflows/update') {
        const body = (await readBody(request)) ?? {}
        const workflow = await withService(services, 'library', (l) => l.updateWorkflow({ ...body, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, workflow })
        return
      }
      if (request.method === 'POST' && path === '/library/workflows/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'library', (l) => l.removeWorkflow({ id: body.id, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, result })
        return
      }

      // ── 设置 ──────────────────────────────────────────────────────────────
      // ⚠️ 修复（2026-11-04 测试）：
      //   ① GET 之前只返回 services.settings（启动时一次性加载的内存副本）⇒
      //      「保存后立刻 GET 却看不到新值」的假象（磁盘上其实已写对）。
      //      现改为：`saved` 永远来自磁盘（真相源），`effective` 才是运行时内存值。
      //   ② POST 之前只回 saved.values，调用方无法区分「写进去的」与「当前生效的」⇒
      //      现补 `effective` 与 `persisted` 两个字段，让 UI 能如实标注。
      if (request.method === 'GET' && path === '/settings') {
        const { SETTING_SPECS, loadSettings } = await import('./settings.js')
        const dir = services.board?.paths?.stateDir ?? services.roster?.paths?.stateDir
        const disk = dir ? loadSettings(dir) : { values: {}, diagnostics: { file: '', source: 'unknown', badKeys: [] } }
        sendJson(response, 200, {
          ok: true,
          values: disk.values,
          saved: disk.values,
          effective: services.settings ?? {},
          specs: SETTING_SPECS,
          diagnostics: disk.diagnostics,
          baseDir: dir,
          note: Object.keys(disk.values).length
            && JSON.stringify(disk.values) !== JSON.stringify(services.settings ?? {})
            ? '磁盘值与内存生效值不同：内核级参数需重启 DSH 才生效'
            : undefined,
        })
        return
      }

      if (request.method === 'POST' && path === '/settings') {
        const body = (await readBody(request)) ?? {}
        const { saveSettings } = await import('./settings.js')
        const dir = services.board?.paths?.stateDir ?? services.roster?.paths?.stateDir
        const saved = saveSettings(dir, body)
        if (!saved.ok) {
          sendJson(response, 400, { ok: false, reason: saved.reason })
          return
        }
        sendJson(response, 200, {
          ok: true,
          values: saved.values,
          saved: saved.values,
          effective: services.settings ?? {},
          persisted: true,
          note: '已写入 settings.json；内核级参数需重启 DSH 生效',
        })
        return
      }

      // ── 手动唤醒 ──────────────────────────────────────────────────────────
      if (request.method === 'POST' && path === '/wakes/notify') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'dispatcher', (d) => d.notify(body))
        sendJson(response, 200, { ok: true, result })
        return
      }

      // ── 唤醒审计 ──────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/wakes') {
        const wakes = await withService(services, 'dispatcher', (d) =>
          d.list({ target: qp(url, 'target'), limit: qn(url, 'limit') ?? 100 }),
        )
        sendJson(response, 200, { ok: true, wakes })
        return
      }


      // ══════════════════════════════════════════════════════════════════════
      // v2 新增端点（2026-11-04，五大功能）
      // ══════════════════════════════════════════════════════════════════════

      // ── 特性①：房间超级管理员 ────────────────────────────────────────────
      if (request.method === 'POST' && path === '/rooms/archive') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.archiveRoom({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }
      if (request.method === 'POST' && path === '/rooms/unarchive') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.unarchiveRoom({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }
      if (request.method === 'POST' && path === '/rooms/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'room', (r) =>
          r.removeRoom({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/rooms/member-role') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.setMemberRole({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }
      if (request.method === 'POST' && path === '/rooms/kick') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.kickMember({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      // ── 特性②：分级纪律体系 ──────────────────────────────────────────────
      if (request.method === 'GET' && path === '/disciplines') {
        const items = await withService(services, 'discipline', (d) => d.listDisciplines({
          scope: qp(url, 'scope'),
          scopeId: qp(url, 'scopeId'),
          kind: qp(url, 'kind'),
          query: qp(url, 'query'),
          enabled: qp(url, 'enabled') === undefined ? undefined : qp(url, 'enabled') === '1',
        }))
        sendJson(response, 200, { ok: true, items, scopes: DISCIPLINE_SCOPES, kinds: DISCIPLINE_KINDS })
        return
      }
      if (request.method === 'POST' && path === '/disciplines') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'discipline', (d) =>
          d.createDiscipline({ ...body, by: body.by ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, item })
        return
      }
      if (request.method === 'POST' && path === '/disciplines/update') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'discipline', (d) =>
          d.updateDiscipline({ ...body, by: body.by ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, item })
        return
      }
      if (request.method === 'POST' && path === '/disciplines/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'discipline', (d) =>
          d.removeDiscipline({ id: body.id, expectedRev: body.expectedRev, by: body.by ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/disciplines/import') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'discipline', (d) =>
          d.importDisciplines({ items: body.items ?? [], mode: body.mode, by: body.by ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, result })
        return
      }
      // 合并预览：给定 bot/cwd/room，看"这个对象实际会看到哪些纪律"
      if (request.method === 'GET' && path === '/disciplines/resolve') {
        const resolved = await withService(services, 'discipline', (d) => d.resolveDisciplines({
          botId: qp(url, 'botId'),
          cwd: qp(url, 'cwd'),
          roomId: qp(url, 'roomId'),
        }))
        sendJson(response, 200, { ok: true, ...resolved })
        return
      }
      if (request.method === 'GET' && path === '/disciplines/preview') {
        const resolved = await withService(services, 'discipline', (d) => d.renderDisciplinePrompt({
          botId: qp(url, 'botId'),
          cwd: qp(url, 'cwd'),
          roomId: qp(url, 'roomId'),
          tokenBudget: qn(url, 'tokenBudget'),
        }))
        sendJson(response, 200, { ok: true, ...resolved })
        return
      }

      // ── 特性③：Bot 档案增强（导入记忆 / 关联技能）────────────────────────
      if (request.method === 'POST' && path === '/roster/profile/memory') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const out = await withService(services, 'roster', (r) =>
          r.addProfileMemory({
            id: body.id,
            entries: body.entries ?? [],
            dedup: body.dedup !== false,
            byId: body.byId ?? OWNER,
            expectedRev: body.expectedRev,
          }),
        )
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/roster/skills/link') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const bot = await withService(services, 'roster', (r) =>
          r.linkSkills({
            id: body.id,
            skills: body.skills ?? [],
            byId: body.byId ?? OWNER,
            expectedRev: body.expectedRev,
          }),
        )
        sendJson(response, 200, { ok: true, bot })
        return
      }

      // ── 特性④：记忆档案完整增删改查 ──────────────────────────────────────
      if (request.method === 'GET' && path === '/memory/detail') {
        const id = qp(url, 'id')
        const layer = qp(url, 'layer')
        if (!id || !layer) {
          sendJson(response, 400, { ok: false, reason: 'id 与 layer 必填' })
          return
        }
        const entry = await withService(services, 'memory', (m) => m.get({ layer, id }))
        const history = await withService(services, 'memory', (m) => m.history(id))
        sendJson(response, 200, { ok: true, entry, history })
        return
      }
      if (request.method === 'POST' && path === '/memory/purge') {
        // 彻底删除（不可恢复）：与 /memory/remove（软删除，可恢复）区分开
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.purge({ layer: body.layer, id: body.id, expectedRev: body.expectedRev, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, purged: entry })
        return
      }
      if (request.method === 'POST' && path === '/memory/migrate-cwd') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'memory', (m) =>
          m.migrateCwd({ cwd: body.cwd, by: body.by ?? OWNER, now: body.now }))
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/memory/import') {
        const body = (await readBody(request)) ?? {}
        const rows = Array.isArray(body.entries) ? body.entries : []
        const added = []
        const failed = []
        for (const row of rows) {
          try {
            const entry = await withService(services, 'memory', (m) => m.add({
              layer: row.layer ?? body.layer ?? 'L4',
              content: row.content ?? row,
              by: body.by ?? OWNER,
              tags: row.tags,
              explicit: row.explicit,
            }))
            const id = Array.isArray(entry) ? entry[0]?.id : entry?.id
            if (id) added.push(id)
          } catch (error) {
            failed.push({ content: String(row?.content ?? row).slice(0, 60), reason: error?.message ?? String(error) })
          }
        }
        sendJson(response, 200, { ok: true, added: added.length, ids: added, failed })
        return
      }

      // ── 特性⑤：技能导入 / 导出 ───────────────────────────────────────────
      if (request.method === 'POST' && path === '/library/skills/parse') {
        const body = (await readBody(request)) ?? {}
        const parsed = await withService(services, 'library', (l) =>
          l.parseSkillMarkdown({ text: body.text ?? '', filename: body.filename }),
        )
        sendJson(response, 200, { ok: true, parsed })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/import') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'library', (l) =>
          l.importSkills({
            items: body.items ?? [],
            mode: body.mode ?? 'skip',
            by: body.by ?? OWNER,
          }),
        )
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/scan') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'library', (l) =>
          l.scanSkillsDir({ dir: body.dir }),
        )
        sendJson(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'GET' && path === '/library/skills/detail') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const skill = await withService(services, 'library', (l) => l.getSkill(id))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'GET' && path === '/library/skills/export') {
        const ids = qp(url, 'ids')
        const out = await withService(services, 'library', (l) =>
          l.exportSkills({ ids: ids ? ids.split(',').filter(Boolean) : undefined }),
        )
        sendJson(response, 200, { ok: true, ...out })
        return
      }

      // ── 特性⑥：四轨待办 ──────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/todos') {
        const out = await withService(services, 'todo', (t) => t.listTodos({
          track: qp(url, 'track'),
          cwd: qp(url, 'cwd'),
          date: qp(url, 'date'),
          status: qp(url, 'status'),
          query: qp(url, 'query'),
          all: qp(url, 'all') === '1',
          past: qp(url, 'past') === '1',
          expired: qp(url, 'expired') === '1',
          limit: qn(url, 'limit'),
        }))
        // listTodos 返回 {items,total,truncated,defaultView,today,hint}；
        // 原样展开（页面读 items）+ 保留 todos 别名（老调用方兼容）
        sendJson(response, 200, { ok: true, ...out, todos: out.items ?? [] })
        return
      }
      if (request.method === 'POST' && path === '/todos') {
        const body = (await readBody(request)) ?? {}
        const todo = await withService(services, 'todo', (t) => t.createTodo({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, todo })
        return
      }
      if (request.method === 'POST' && path === '/todos/update') {
        const body = (await readBody(request)) ?? {}
        const todo = await withService(services, 'todo', (t) => t.updateTodo({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, todo })
        return
      }
      if (request.method === 'POST' && path === '/todos/promote') {
        // 「待办 → 任务」升级：待办是个人备忘，任务是要交给别人/Bot 干的协作单元。
        // 两者是漏斗上下游，所以必须有一条**确定性**的升级通道（不是让用户手抄一遍）。
        // 幂等靠 board 的 sourceSeq=`todo:<id>`：连点两次也只会产生一个任务。
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'todo', async (t) => {
          const todo = t.getTodo(body.id)
          if (!todo) {
            const error = new Error(`待办不存在：${body.id}`)
            error.status = 404
            error.code = 'TODO_NOT_FOUND'
            throw error
          }
          if (body.expectedRev !== undefined && todo.rev !== body.expectedRev) {
            const error = new Error(`待办 CAS 冲突：期望 rev=${body.expectedRev}，实际 rev=${todo.rev}`)
            error.status = 409
            error.code = 'TODO_REV_CONFLICT'
            throw error
          }
          const task = await withService(services, 'board', (b) => b.create({
            subject: String(todo.content).split(String.fromCharCode(10))[0].slice(0, 120),
            description: todo.content,
            priority: body.priority,
            dueAt: todo.due ? Date.parse(`${todo.due}T00:00:00+08:00`) : undefined,
            byId: body.by ?? OWNER,
            sourceSeq: `todo:${todo.id}`,
          }))
          // 升级后把待办标成"进行中"，避免它又出现在「要关注」里被重复安排
          let next = todo
          if (todo.status === 'pending') {
            next = t.updateTodo({ id: todo.id, expectedRev: todo.rev, status: 'doing', by: body.by ?? OWNER })
          }
          return { task, todo: next }
        })
        sendJson(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'POST' && path === '/todos/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'todo', (t) =>
          t.removeTodo({ id: body.id, expectedRev: body.expectedRev, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, result })
        return
      }

      // ── 特性⑦：便签 ──────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/scratch') {
        const out = await withService(services, 'scratch', (s) => s.read({ scope: qp(url, 'scope') }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/scratch') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'scratch', (s) =>
          s.write({ scope: body.scope, text: body.text ?? '', by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'GET' && path === '/scratch/scopes') {
        const scopes = await withService(services, 'scratch', (s) => s.listScopes())
        sendJson(response, 200, { ok: true, scopes })
        return
      }

      // ── 特性⑧：提示词库 + 注入轨 ──────────────────────────────────────────
      if (request.method === 'GET' && path === '/prompts') {
        const items = await withService(services, 'prompts', (p) => p.listPrompts({
          category: qp(url, 'category'),
          tag: qp(url, 'tag'),
          query: qp(url, 'query'),
          enabled: qp(url, 'enabled') === undefined ? undefined : qp(url, 'enabled') === '1',
          limit: qn(url, 'limit'),
        }))
        const categories = await withService(services, 'prompts', (p) => p.listCategories())
        sendJson(response, 200, { ok: true, items, categories })
        return
      }
      if (request.method === 'POST' && path === '/prompts') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'prompts', (p) => p.createPrompt({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, item })
        return
      }
      if (request.method === 'POST' && path === '/prompts/update') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'prompts', (p) => p.updatePrompt({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, item })
        return
      }
      if (request.method === 'POST' && path === '/prompts/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'prompts', (p) =>
          p.removePrompt({ id: body.id, expectedRev: body.expectedRev, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/prompts/categories/add') {
        const body = (await readBody(request)) ?? {}
        const categories = await withService(services, 'prompts', (p) =>
          p.addCategory({ name: body.name, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, categories })
        return
      }
      if (request.method === 'POST' && path === '/prompts/categories/remove') {
        const body = (await readBody(request)) ?? {}
        const categories = await withService(services, 'prompts', (p) =>
          p.removeCategory({ name: body.name, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, categories })
        return
      }
      if (request.method === 'POST' && path === '/prompts/inject') {
        const body = (await readBody(request)) ?? {}
        const injection = await withService(services, 'prompts', (p) => p.inject({
          promptId: body.promptId,
          text: body.text,
          sessionId: body.sessionId,
          times: body.times,
          every: body.every,
          immediate: body.immediate,
          by: body.by ?? OWNER,
        }))
        sendJson(response, 200, { ok: true, injection })
        return
      }
      if (request.method === 'POST' && path === '/prompts/injection/stop') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'prompts', (p) => p.stopInjection({ id: body.id, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'GET' && path === '/prompts/injections') {
        const injections = await withService(services, 'prompts', (p) => p.listInjections({ sessionId: qp(url, 'sessionId') }))
        sendJson(response, 200, { ok: true, injections })
        return
      }

      // ── 特性⑨：建议确认队列 + 审查调度 ───────────────────────────────────
      if (request.method === 'GET' && path === '/suggestions') {
        const items = await withService(services, 'suggest', (s) => s.listSuggestions({
          kind: qp(url, 'kind'),
          status: qp(url, 'status') ?? 'pending',
          limit: qn(url, 'limit'),
        }))
        sendJson(response, 200, { ok: true, items })
        return
      }
      if (request.method === 'POST' && path === '/suggestions/propose') {
        const body = (await readBody(request)) ?? {}
        const suggestion = await withService(services, 'suggest', (sg) => sg.suggest({
          kind: body.kind,
          layer: body.layer,
          payload: body.payload,
          reason: body.reason,
          source: body.source ?? 'model',
          confidence: body.confidence,
          by: body.by ?? OWNER,
        }))
        sendJson(response, 200, { ok: true, suggestion })
        return
      }
      if (request.method === 'POST' && path === '/suggestions/accept') {
        const body = (await readBody(request)) ?? {}
        // apply 回调把建议真正写进目标域（memory / library / discipline）
        const applied = await withService(services, 'suggest', (s) => s.accept({
          id: body.id,
          by: body.by ?? OWNER,
          apply: (sg) => applySuggestion(services, sg, body.by ?? OWNER),
        }))
        sendJson(response, 200, { ok: true, suggestion: applied })
        return
      }
      if (request.method === 'POST' && path === '/suggestions/reject') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'suggest', (s) =>
          s.reject({ id: body.id, reason: body.reason, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, suggestion: item })
        return
      }
      if (request.method === 'GET' && path === '/review/status') {
        const status = await withService(services, 'reviewer', (r) => r.status({ sessionId: qp(url, 'sessionId') }))
        sendJson(response, 200, { ok: true, status })
        return
      }
      if (request.method === 'POST' && path === '/review/note-turn') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'reviewer', (r) => r.noteTurn({ sessionId: body.sessionId }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/review/mark-reviewed') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'reviewer', (r) =>
          r.markReviewed({ sessionId: body.sessionId, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      // ── 需求4：智能体定期归纳 —— 人点一下，把「该归纳了」变成一次真唤醒 ────────
      //
      // 为什么需要它：reviewer 只做被动计数（每回合 +1，到 interval 就 due），
      // 它不自己起定时器（宿主生命周期不可控）。所以「定期归纳」的闭环落点是：
      //   UI/接口看到 due → 人点「让它归纳」→ 唤醒该会话 → 会话自己用
      //   bot_cycle_start(kind=agent) + bot_cycle_review 一次性提交并自动闭环。
      // 归纳出来的建议仍然走 bot_suggestion_propose（确认制，人采纳才落库），
      // 不存在「智能体自己改自己的长期纪律」这条暗道。
      if (request.method === 'POST' && path === '/review/urge') {
        const body = (await readBody(request)) ?? {}
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId) {
          sendJson(response, 400, { ok: false, reason: 'sessionId 必填' })
          return
        }
        const st = await withService(services, 'reviewer', (r) => r.status({ sessionId }))
        if (st.known === false) {
          sendJson(response, 200, {
            ok: false,
            code: 'REVIEW_UNKNOWN_SESSION',
            reason: `会话 ${sessionId} 还没被计数过（未记录任何回合），没有可归纳的内容`,
          })
          return
        }
        if (st.due !== true && body.force !== true) {
          sendJson(response, 200, {
            ok: false,
            code: 'REVIEW_NOT_DUE',
            reason: `会话 ${sessionId} 才累计 ${st.turnsSinceLastReview} 回合（阈值 ${st.interval}），还没到该归纳的时候`,
            status: st,
          })
          return
        }
        const bots = services.roster?.list?.({ includeRetired: true }) ?? []
        const bot = bots.find((b) => b.sessionId === sessionId || b.id === sessionId)
        const text = '[cs-bots 归纳提醒] 你的会话已累计 ' + `${st.turnsSinceLastReview}` + ' 个回合没有归纳了。\n'
          + '请现在做一次「事后归纳」（这是你自己的 PDCA，不需要人来跟）：\n'
          + '  1. 用 bot_cycle_start 开一个 kind=agent 的周期，taskId 填你当前主任务的 id，objective 写这次归纳要解决什么；\n'
          + `  2. 用 bot_cycle_review 一次性提交（id + summary + lessons[] + standards[]），提交后周期自动闭环；\n`
          + '  3. standards 里只写**你确实想让它长期生效**的纪律/原则，它们会进建议队列等人采纳，不会自动落库。\n'
          + '做完之后调 POST /review/mark-reviewed 把计数清零。'
        const revive = await ensureLive(ctx, sessionId)
        let wake
        try {
          const dispatcher = await withService(services, 'dispatcher', (d) => d)
          wake = dispatcher.notify({
            target: sessionId,
            reason: 'timer',
            dedupKey: `review-urge:${sessionId}:${Date.now()}`,
            text,
          })
        } catch (error) {
          sendJson(response, 503, {
            ok: false,
            code: 'REVIEW_URGE_NO_DISPATCHER',
            reason: `没有可用的唤醒投递器：${error?.message ?? error}`,
          })
          return
        }
        sendJson(response, 200, {
          ok: true,
          sessionId,
          ...(bot ? { bot: { id: bot.id, name: bot.name, label: bot.label ?? null } } : {}),
          status: st,
          live: revive.live,
          revived: revive.revived,
          ...(revive.live ? {} : { reviveReason: revive.reason ?? 'revive-failed' }),
          wake,
        })
        return
      }

      if (request.method === 'POST' && path === '/review/interval') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'reviewer', (r) => r.setInterval({ interval: body.interval }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }

      // ── 特性⑩：技能管理器（来源/启用/自定义目录/浏览）────────────────────
      if (request.method === 'POST' && path === '/library/skills/enable') {
        const body = (await readBody(request)) ?? {}
        const skill = await withService(services, 'library', (l) => l.setSkillEnabled({
          id: body.id, enabled: body.enabled, by: body.by ?? OWNER, expectedRev: body.expectedRev,
        }))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/source') {
        const body = (await readBody(request)) ?? {}
        const skill = await withService(services, 'library', (l) => l.setSkillSource({
          id: body.id, source: body.source, by: body.by ?? OWNER, expectedRev: body.expectedRev,
        }))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'GET' && path === '/library/skills/dirs') {
        const dirs = await withService(services, 'library', (l) => l.listSkillDirs())
        sendJson(response, 200, { ok: true, dirs })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/dirs/add') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'library', (l) =>
          l.addSkillDir({ dir: body.dir, label: body.label, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/dirs/remove') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'library', (l) =>
          l.removeSkillDir({ dir: body.dir, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'GET' && path === '/library/skills/browse') {
        const out = await withService(services, 'library', (l) =>
          l.browseSkillDir({ dir: qp(url, 'dir'), sub: qp(url, 'sub') }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/scan-all') {
        const out = await withService(services, 'library', (l) => l.scanAllSkillDirs())
        sendJson(response, 200, { ok: true, ...out })
        return
      }

      // ── PDCA-2：验收证据（C 的机器闸门）────────────────────────────────────
      if (request.method === 'GET' && path === '/verify/history') {
        const items = await withService(services, 'verify', (v) => v.history(Number(qp(url, 'limit')) ?? 50))
        sendJson(response, 200, { ok: true, items })
        return
      }
      if (request.method === 'GET' && path === '/verify/stats') {
        const stats = await withService(services, 'verify', (v) => v.stats())
        sendJson(response, 200, { ok: true, stats })
        return
      }
      if (request.method === 'POST' && path === '/verify/check') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'verify', (v) => v.check({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/verify/evaluate') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'verify', (v) => v.evaluate(body.artifacts ?? []))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/verify/task') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'verify', (v) =>
          v.verifyTask({ id: body.id, artifacts: body.artifacts ?? [], writeScopes: body.writeScopes ?? [] }, { by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }

      // ── PDCA-3：测量（metrics）──────────────────────────────────────────────
      if (request.method === 'GET' && path === '/metrics') {
        const out = await withService(services, 'metrics', (m) => m.stats())
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'GET' && path === '/metrics/series') {
        const out = await withService(services, 'metrics', (m) => m.series({
          kind: qp(url, 'kind'), taskId: qp(url, 'taskId'),
          since: qp(url, 'since') === undefined ? undefined : Number(qp(url, 'since')),
          limit: qp(url, 'limit') === undefined ? undefined : Number(qp(url, 'limit')),
        }))
        sendJson(response, 200, { ok: true, items: out })
        return
      }
      if (request.method === 'GET' && path === '/metrics/aggregate') {
        const out = await withService(services, 'metrics', (m) => m.aggregate({
          kind: qp(url, 'kind'),
          since: qp(url, 'since') === undefined ? undefined : Number(qp(url, 'since')),
        }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/metrics/record') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'metrics', (m) => m.record({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, record: out })
        return
      }

      // ── PDCA-4：复盘与标准化（Act）──────────────────────────────────────────
      if (request.method === 'GET' && path === '/cycles') {
        const items = await withService(services, 'cycle', (c) => c.list({
          status: qp(url, 'status'), phase: qp(url, 'phase'), taskId: qp(url, 'taskId'),
          // 需求4：kind 过滤——人只看自己的长任务周期，AI 的归纳周期另开视图
          kind: qp(url, 'kind'),
        }))
        sendJson(response, 200, { ok: true, items, phases: CYCLE_PHASES, kinds: CYCLE_KINDS })
        return
      }
      if (request.method === 'POST' && path === '/cycles') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'cycle', (c) =>
          c.start({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, cycle: out })
        return
      }
      if (request.method === 'POST' && path === '/cycles/advance') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'cycle', (c) =>
          c.advance({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, cycle: out })
        return
      }
      if (request.method === 'POST' && path === '/cycles/check') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'cycle', (c) =>
          c.check({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, cycle: out })
        return
      }
      if (request.method === 'POST' && path === '/cycles/review') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'cycle', (c) =>
          c.review({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'GET' && path === '/cycles/stats') {
        const stats = await withService(services, 'cycle', (c) => c.stats())
        sendJson(response, 200, { ok: true, stats })
        return
      }

      // ── 大/小团队（Lead 聚合管理）──────────────────────────────────────────
      if (request.method === 'GET' && path === '/teams') {
        const items = await withService(services, 'teams', (t) => t.list({
          type: qp(url, 'type'), status: qp(url, 'status'),
        }))
        sendJson(response, 200, {
          ok: true, items,
          types: TEAM_TYPES, roles: TEAM_ROLES, policies: TEAM_ADMIN_POLICIES,
        })
        return
      }
      if (request.method === 'POST' && path === '/teams') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'teams', (t) =>
          t.create({ ...body, by: body.by ?? OWNER })).catch(markTeamError)
        // 契约 §3：建团队就配议事厅。失败不阻断团队创建，只回一句 roomError。
        const roomOut = await ensureTeamRoom(services, out, body.by ?? OWNER)
        sendJson(response, 200, {
          ok: true, team: out,
          ...(roomOut.room ? { room: roomOut.room } : {}),
          ...(roomOut.roomError ? { roomError: roomOut.roomError } : {}),
        })
        return
      }
      if (request.method === 'POST' && path === '/teams/add') {
        const body = (await readBody(request)) ?? {}
        const by = body.by ?? OWNER
        const out = await withService(services, 'teams', (t) =>
          t.addMember({ ...body, by })).catch(markTeamError)
        if (out?.ok === false) {
          sendJson(response, out.status ?? 400, out)
          return
        }
        // 契约 §3：新成员也要进议事厅（否则加了人、人却不在那个房间）
        let roomError
        if (typeof out?.roomId === 'string' && out.roomId && body.memberId) {
          try {
            await withService(services, 'room', (r) =>
              r.join({ roomId: out.roomId, sessionId: body.memberId, byId: by }))
          } catch (error) {
            roomError = `成员已加入团队，但未能拉进议事厅（${out.roomId}）：${error?.message ?? error}`
          }
        }
        sendJson(response, 200, { ok: true, team: out, ...(roomError ? { roomError } : {}) })
        return
      }
      if (request.method === 'POST' && path === '/teams/remove') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'teams', (t) =>
          t.removeMember({ ...body, by: body.by ?? OWNER })).catch(markTeamError)
        sendJson(response, 200, { ok: true, team: out })
        return
      }
      if (request.method === 'POST' && path === '/teams/role') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'teams', (t) =>
          t.setRole({ ...body, by: body.by ?? OWNER })).catch(markTeamError)
        sendJson(response, 200, { ok: true, team: out })
        return
      }
      if (request.method === 'POST' && path === '/teams/note') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'teams', (t) =>
          t.note({ ...body, by: body.by ?? OWNER })).catch(markTeamError)
        sendJson(response, 200, { ok: true, team: out })
        return
      }
      if (request.method === 'POST' && path === '/teams/close') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'teams', (t) =>
          t.close({ ...body, by: body.by ?? OWNER })).catch(markTeamError)
        sendJson(response, 200, { ok: true, team: out })
        return
      }
      // ── 跨团队路由（t-39 第2批 A · HTTP 出口）───────────────────────────
      //
      // 为什么必须有这一条：页面上的「📤 发协作请求」按钮（client.js）就是打这个
      // 路径的。只有 MCP 工具 `bot_team_route` 而没有 HTTP 出口 ⇒ Boss 点按钮 404。
      //
      // 复用 `teams.deliverRoute()` —— 与工具层**同一套序列编排**（决定 → 投递 →
      // 留痕）。绝不在这里重写一遍，否则两条路的行为会漂。
      if (request.method === 'POST' && path === '/teams/route') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'teams', (t) =>
          t.deliverRoute({
            ...body,
            by: body.by ?? OWNER,
            // dispatcher 从装配层取出后注入：TeamsService 不反向依赖 dispatcher
            dispatcher: services.dispatcher,
          })).catch(markTeamError)
        // refused 是**正常的业务结论**，不是服务器错误 ⇒ 200 带 decision:'refused'。
        // 用 4xx 会让前端把它当异常处理，丢掉 reason 的可读性（DecisionKind 语义）。
        sendJson(response, 200, out)
        return
      }

      // ── 团队唤醒成本统计（t-39 第2批 D · HTTP 出口）─────────────────────
      //
      // 页面团队卡片要显示「今日唤醒 N 次」。数据源是 dispatcher 的 wakes.jsonl
      // 按 teamId 聚合（`byTeam`）。不传 id ⇒ 返回全部团队的横向对比。
      //
      // `today` = 今日 0 点（本地时区）之后；`total` = 该团队历史累计。
      if (request.method === 'GET' && path === '/teams/wake-stats') {
        const id = qp(url, 'id')
        const dispatcher = services.dispatcher
        if (!dispatcher || typeof dispatcher.byTeam !== 'function') {
          sendJson(response, 503, { ok: false, reason: 'DISPATCHER_UNAVAILABLE' })
          return
        }
        const since = qn(url, 'since')
        const nowMs = Date.now()
        const midnight = since ?? new Date(nowMs).setHours(0, 0, 0, 0)
        const todayAgg = dispatcher.byTeam({ since: midnight })
        const allAgg = dispatcher.byTeam({})

        const pick = (agg) => {
          if (!id) {
            return {
              teams: agg.teams,
              unassigned: agg.unassigned,
              total: agg.total,
            }
          }
          const hit = agg.teams.find((t) => t.teamId === id)
          return hit ?? { teamId: id, count: 0, sent: 0, skipped: 0, failed: 0, pending: 0, targets: 0, targetsList: [] }
        }
        const today = pick(todayAgg)
        const all = pick(allAgg)
        if (id) {
          sendJson(response, 200, {
            ok: true,
            id,
            today: today.count ?? 0,
            total: all.count ?? 0,
            byResult: {
              sent: today.sent ?? 0, skipped: today.skipped ?? 0,
              failed: today.failed ?? 0, pending: today.pending ?? 0,
            },
            byResultAllTime: {
              sent: all.sent ?? 0, skipped: all.skipped ?? 0,
              failed: all.failed ?? 0, pending: all.pending ?? 0,
            },
            since: midnight,
          })
          return
        }
        sendJson(response, 200, { ok: true, since: midnight, today, all })
        return
      }

      // 管理策略（2026-11-09「管理员权限边界从页面控制」）：CAS 改团队的 adminPolicy。
      if (request.method === 'POST' && path === '/teams/policy') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        if (!TEAM_ADMIN_POLICIES.includes(body.adminPolicy)) {
          sendJson(response, 400, {
            ok: false,
            code: 'TEAM_BAD_POLICY',
            reason: `adminPolicy 非法（合法：${TEAM_ADMIN_POLICIES.join(' | ')}）`,
          })
          return
        }
        const out = await withService(services, 'teams', (t) =>
          t.setPolicy({
            id: body.id,
            expectedRev: body.expectedRev,
            adminPolicy: body.adminPolicy,
            by: body.by ?? OWNER,
          })).catch(markTeamError)
        sendJson(response, 200, { ok: true, team: out, adminPolicy: out.adminPolicy })
        return
      }

      // ── CS-BOTS 工作区（契约 bots06 §2.4）：只读 ───────────────────────────
      if (request.method === 'GET' && path === '/workspace') {
        const root = typeof services.settings?.botWorkspaceRoot === 'string'
          ? services.settings.botWorkspaceRoot
          : null
        let exists = false
        if (root) {
          try {
            exists = existsSync(root) && statSync(root).isDirectory()
          } catch {
            exists = false
          }
        }
        const dshHome = resolve(process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`)
        sendJson(response, 200, {
          ok: true,
          root,
          exists,
          dshHome,
          note: 'CS-BOTS 所有会话的默认工作区：shared/ 放交付物，scratch/ 放草稿，archive/ 放归档',
        })
        return
      }

      // ── 团队 L2 记忆（契约 bots06 §2.1）────────────────────────────────
      // 读：只从 memory 服务取 L2 + tag=team:<id>，按 at 升序；不写任何文件。
      if (request.method === 'GET' && path === '/teams/memory') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const team = await withService(services, 'teams', (t) => t.get(id))
        if (!team) {
          sendJson(response, 404, { ok: false, reason: `团队 ${id} 不存在` })
          return
        }
        const memories = readTeamMemories(services, id)
        sendJson(response, 200, {
          ok: true,
          teamId: id,
          memories,
          text: buildTeamMemoryText(memories),
          note: '团队记忆属 L2 团队层，全队可见；任务进度另记在 L4 任务笔记',
        })
        return
      }

      // 写：append-only；权限只认队长（leadId）或管理员（'user'）。
      if (request.method === 'POST' && path === '/teams/memory') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          sendJson(response, 400, { ok: false, reason: '团队记忆不能为空' })
          return
        }
        if (text.length > ANCHOR_TEXT_MAX) {
          sendJson(response, 400, { ok: false, reason: `团队记忆过长（最多 ${ANCHOR_TEXT_MAX} 字）` })
          return
        }
        const team = await withService(services, 'teams', (t) => t.get(body.id))
        if (!team) {
          sendJson(response, 404, { ok: false, reason: `团队 ${body.id} 不存在` })
          return
        }
        const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : ''
        if (by !== team.leadId && by !== OWNER) {
          sendJson(response, 403, { ok: false, reason: '只有队长或管理员能写团队记忆' })
          return
        }
        // 落盘走 memory 服务（L2 + tag=team:<id>）；memory 缺失时 503。
        const entry = await withService(services, 'memory', (m) =>
          m.add({ layer: 'L2', content: text, by, tags: [teamMemoryTag(body.id)] }))
        const saved = Array.isArray(entry) ? entry[0] : entry
        sendJson(response, 200, {
          ok: true,
          memory: {
            id: saved?.id,
            content: saved?.content ?? text,
            by: saved?.createdBy ?? by,
            at: saved?.createdAt ?? Date.now(),
          },
          note: '已写入团队记忆（L2，全队可见）',
        })
        return
      }

      // ── 需求2：任务对话内容查看（2026-11-08）──────────────────────────────
      // 用户反馈：「任务栏页面指派 bot 后，无法追踪任务进度，无法看到产出物，
      //            没有跳转对话也没有对话内容查看」
      // ⇒ 在任务详情里直接读执行者的会话历史，不必跳走。
      if (request.method === 'GET' && path === '/tasks/conversation') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) => b.get(id))
        if (!task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        // 找执行者会话：assignee → ownerId → 平台伪身份排除
        const candidates = [task.assignee, task.ownerId, task.anchor?.ownerId]
          .filter((v) => typeof v === 'string' && v && !['ui', 'user', 'anyone', 'system'].includes(v))
        if (candidates.length === 0) {
          sendJson(response, 200, {
            ok: false,
            reason: '这个任务还没有执行者（未派活），没有对话可看',
            code: 'NO_EXECUTOR',
          })
          return
        }
        // 把候选 sessionId 映射到 Bot 记录（拿真名）
        let bot
        try {
          const all = services.roster?.list?.({ includeRetired: true }) ?? []
          bot = all.find((b) => candidates.includes(b.sessionId) || candidates.includes(b.id))
        } catch { bot = undefined }
        const sessionId = bot?.sessionId ?? candidates[0]
        const limit = qn(url, 'limit')
        const out = await readSessionMessages(ctx, sessionId, { limit: limit ?? 40 })
        sendJson(response, 200, {
          ...(bot ? { bot: { id: bot.id, name: bot.name, label: bot.label ?? null } } : {}),
          sessionId,
          ...out,
        })
        return
      }

      // ── 改造07：任务订阅（借鉴 Super-agent Subscription 扇出）─────────────────
      // GET /subscriptions —— 列出订阅（按 taskId/roomId/state 过滤）
      if (request.method === 'GET' && path === '/subscriptions') {
        const subs = await withService(services, 'subscription', (s) => s.list({
          taskId: qp(url, 'taskId'),
          roomId: qp(url, 'roomId'),
          state: qp(url, 'state'),
        }))
        sendJson(response, 200, { ok: true, subs, stats: services.subscription?.stats?.() })
        return
      }

      // POST /subscriptions —— 订阅（任务接收房间后续消息）
      if (request.method === 'POST' && path === '/subscriptions') {
        const body = (await readBody(request)) ?? {}
        if (!body.taskId || !body.roomId) {
          sendJson(response, 400, { ok: false, reason: 'taskId 与 roomId 必填' })
          return
        }
        const sub = await withService(services, 'subscription', (s) =>
          s.subscribe({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, sub })
        return
      }

      // POST /subscriptions/unsubscribe —— 取消订阅
      if (request.method === 'POST' && path === '/subscriptions/unsubscribe') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const sub = await withService(services, 'subscription', (s) =>
          s.unsubscribe({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, sub })
        return
      }

      // ── 改造07：穿透面板（下层 AI 基础设施查看）─────────────────────────────
      // GET /deepdive/blocks —— 列出 7 个下层区块 + 概览统计
      if (request.method === 'GET' && path === '/deepdive/blocks') {
        const blocks = []
        // 注册表：Bot 数量 + 各状态计数
        await withService(services, 'roster', (r) => {
          const rows = typeof r.list === 'function' ? r.list({ includeRetired: true }) : []
          const byState = {}
          for (const row of rows) {
            const st = row?.state ?? row?.status ?? 'unknown'
            byState[st] = (byState[st] ?? 0) + 1
          }
          blocks.push({
            id: 'registry', label: '注册表', description: 'Bot 注册表 / 任务板 / 团队注册',
            stats: { bots: rows.length, states: byState },
          })
        })
        // 唤醒桥：Dispatcher 统计
        const dStats = services.dispatcher?.stats?.()
        if (dStats) {
          blocks.push({
            id: 'wake', label: '唤醒桥', description: 'Dispatcher 队列 / 去重 / 背压',
            stats: { total: dStats.total, sent: dStats.sent, skipped: dStats.skipped, failed: dStats.failed, pending: dStats.pending },
          })
        }
        // 存储：各 jsonl 健康
        const storeFiles = []
        for (const f of ['board.jsonl', 'roster.jsonl', 'wakes.jsonl', 'memory.jsonl', 'cycle.jsonl', 'todo.jsonl', 'rooms']) {
          try {
            const p = statePath(services.board?.paths?.stateDir ?? '', f)
            const st = existsSync(p) ? statSync(p) : null
            storeFiles.push({ name: f, exists: Boolean(st), size: st ? st.size : 0, mtime: st ? st.mtimeMs : null })
          } catch {}
        }
        blocks.push({
          id: 'store', label: '存储', description: 'jsonl 事件流 / 快照 / 原子写',
          stats: { files: storeFiles.filter((f) => f.exists).length, total: storeFiles.length },
        })
        // 路由：复杂度路由规则（静态展示）
        blocks.push({
          id: 'routing', label: '路由', description: '复杂度路由 T0-T3 / 免费付费策略',
          stats: { tiers: ['T0', 'T1', 'T2', 'T3'], default: 'free_only (fail-closed)' },
        })
        // 验证：验收统计
        const vStats = services.verify?.stats?.()
        blocks.push({
          id: 'verify', label: '验证', description: '验收证据 / 退出码 / 测试结果',
          stats: vStats ?? { note: 'verify 服务未装配' },
        })
        // 建议：建议队列
        const sugStats = services.suggest?.stats?.()
        blocks.push({
          id: 'suggest', label: '建议', description: '建议确认队列 / 纪律提议',
          stats: sugStats ?? { note: 'suggest 服务未装配' },
        })
        // 订阅：任务 ↔ 房间订阅关系（服务不可用时计数为 0，绝不抛）
        const subStats = services.subscription?.stats?.()
        blocks.push({
          id: 'subscription', label: '订阅', description: '任务订阅、房间扇出',
          stats: {
            total: subStats?.total ?? 0,
            active: subStats?.active ?? 0,
            dropped: subStats?.dropped ?? 0,
            fanouts: subStats?.fanouts ?? 0,
          },
        })
        sendJson(response, 200, { ok: true, blocks })
        return
      }

      // GET /deepdive/block/:id —— 某区块详情 + 可执行操作
      if (request.method === 'GET' && path.startsWith('/deepdive/block/')) {
        const id = decodeURIComponent(path.slice('/deepdive/block/'.length))
        const data = {}
        const operations = []
        try {
          if (id === 'registry') {
            const rows = await withService(services, 'roster', (r) => r.list({ includeRetired: true }))
            data.bots = rows
            operations.push({ id: 'revive', label: '重启全部 Bot 会话', body: {} })
          } else if (id === 'wake') {
            data.stats = services.dispatcher?.stats?.()
            data.recent = services.dispatcher?.list?.({ limit: 20 }) ?? []
            operations.push({ id: 'flush', label: '强制投递队列', body: {} })
          } else if (id === 'store') {
            const dir = services.board?.paths?.stateDir ?? ''
            const files = []
            try {
              for (const entry of readdirSync(dir)) {
                const p = join(dir, entry)
                const st = statSync(p)
                files.push({ name: entry, size: st.size, mtime: st.mtimeMs })
              }
            } catch {}
            data.files = files.slice(0, 50)
            data.stateDir = dir
            operations.push({ id: 'replay', label: '重建内存态（replay）', body: {} })
          } else if (id === 'routing') {
            data.tiers = ['T0', 'T1', 'T2', 'T3']
            data.description = 'T0 一句话问答 / T1 常规改动 / T2 跨文件或多步 / T3 架构级。缺省 = free_only（只走免费渠道，fail-closed）。'
          } else if (id === 'verify') {
            data.stats = services.verify?.stats?.()
            data.records = services.verify?.list?.({ limit: 20 }) ?? []
            operations.push({ id: 'recheck', label: '手动重跑验收', body: {} })
          } else if (id === 'suggest') {
            data.stats = services.suggest?.stats?.()
            data.pending = services.suggest?.list?.({ status: 'pending', limit: 20 }) ?? []
          } else if (id === 'subscription') {
            // 订阅：任务 ↔ 房间订阅关系。
            // ⚠️ 服务未装配时**不能抛** —— 穿透面板是「管理/查看」，不是硬依赖。
            if (!services.subscription) {
              sendJson(response, 200, {
                ok: true, block: id,
                available: false, reason: '订阅服务未装配', data: {}, operations: [],
              })
              return
            }
            data.stats = services.subscription.stats()
            data.subscriptions = services.subscription.list({}).slice(0, 100)
            operations.push({ id: 'unsubscribe', label: '取消某订阅', body: { id: '' } })
          } else {
            sendJson(response, 404, { ok: false, reason: `未知区块: ${id}` })
            return
          }
        } catch (error) {
          sendJson(response, 500, { ok: false, reason: `区块详情读取失败：${error?.message ?? error}` })
          return
        }
        sendJson(response, 200, { ok: true, block: id, data, operations })
        return
      }

      // POST /deepdive/op —— 区块操作（手动唤醒/flush/replay 等）
      if (request.method === 'POST' && path === '/deepdive/op') {
        const body = (await readBody(request)) ?? {}
        const { block, op } = body
        try {
          if (block === 'wake' && op === 'flush') {
            const result = services.dispatcher?.flush?.({ force: true })
            sendJson(response, 200, { ok: true, text: `已强制投递：sent=${result?.sent ?? 0}, failed=${result?.failed ?? 0}`, result })
          } else if (block === 'store' && op === 'replay') {
            const result = services.board?.replay?.()
            sendJson(response, 200, { ok: true, text: `replay 完成：${JSON.stringify(result ?? {})}`, result })
          } else if (block === 'registry' && op === 'revive') {
            sendJson(response, 200, { ok: true, text: 'Bot 会话重启需要内核支持，请通过页面操作' })
          } else if (block === 'verify' && op === 'recheck') {
            sendJson(response, 200, { ok: true, text: '验收重跑需要在任务详情中操作' })
          } else if (block === 'subscription' && op === 'unsubscribe') {
            const result = services.subscription?.unsubscribe(body.id)
            if (!result?.ok) {
              sendJson(response, 400, { ok: false, reason: result?.reason ?? '取消订阅失败' })
              return
            }
            sendJson(response, 200, { ok: true, text: `已取消订阅 ${body.id}`, result })
          } else {
            sendJson(response, 400, { ok: false, reason: `不支持的操作：${block}/${op}` })
          }
        } catch (error) {
          sendJson(response, 400, { ok: false, reason: `操作失败：${error?.message ?? error}` })
        }
        return
      }

      sendJson(response, 404, { ok: false, reason: `未知端点: ${request.method} ${path}` })
    } catch (error) {
      const status = Number.isFinite(error?.status) ? error.status : 400
      sendJson(response, status, {
        ok: false,
        code: error?.code ?? 'API_ERROR',
        reason: error?.message ?? String(error),
      })
    }
  }

  const dispose = registerRoute(ctx, API_BASE, handler)
  if (!dispose) {
    warn?.(`[cs-bots] webServer 不可用 → HTTP API 未注册（页面将无数据）`)
    return undefined
  }
  return dispose
}
