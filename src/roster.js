/**
 * cs-bots RosterService —— Bot 注册表 + **目录隔离**。
 *
 * 设计依据：`multiagent/10-初步架构设计方案-v1.md` §3.1（RosterService）。
 *
 * ── 为什么必须自建（不是重复造轮子，是官方给不了）──────────────────────────
 *   1. **官方 roster 是 flat immutable**（`12-硬约束清单.md` A3，官方 README:205 原文
 *      "Flat immutable roster — there is no nested Team, rename, deletion, or name reuse."）
 *      ⇒ 官方**没有改名、没有删除、名字永不复用**。`retire` / `renameMember` 实测 0 命中。
 *      ⇒ 本模块的 `rename` / `retire` 是官方**结构上做不到**的能力。
 *   2. **官方 `spawn_teammate` 无法指定工作目录**（A1/A2，`SpawnTeammateRequest` 无 `cwd`
 *      字段，teammate 强制继承父会话 cwd），而 **cwd 同时就是 fs 写入边界**。
 *      ⇒ 持久 Bot 必须走 **root agent**：`kernel.createSession(ctx,{sessionId,cwd})`
 *        （`kernel.js:249-287` 明确标注这是「唯一能指定 cwd 的路径」）。
 *      ⇒ 所以 `cwd` 在本模块是**必交付能力**，不是可选字段（`11-融合最终稿-v1.md` §0.2 第 1 条：
 *        "`RosterService.cwd` 从『字段』升格为『必交付能力』"）。
 *   3. `retired` 是**终态但释放名额**：名字可复用、cwd 可回收（§3.1 "关键" 段）。
 *
 * ── 相对 §3.1 草案的三处**必要增量**（不改既有字段语义，纯增量）──
 *   `rev`             —— 草案未列，但 `expectedRev` 的 CAS 要求 Bot 自身携带版本号
 *                        （与 Task.rev 同理）。没有它 CAS 无从比较。
 *   `createdBy` / `retiredReason` —— 审计用（谁是创建者/为何退役），便于 `list()` 直接展示。
 *   `claim` / `release` —— 草案只给了 `lease` 字段与 `heartbeat` / `expireLeases`，
 *                        但**没有获取租约的入口**（租约无从产生 ⇒ 心跳是死代码）。
 *                        故补上最小闭环，语义与 board.js 的 claim/release 对齐。
 *
 * ── 三条不变量（全模块机械保证，照 board.js 的做法）──
 *   1. **CAS 优先**：每次变更带 `expectedRev`，不匹配即抛错，绝不静默覆盖。
 *   2. **事件流是真相源**：先 append `roster.jsonl`（失败即抛错，内存原封不动），
 *      再更新内存，最后原子写 `roster.snap.json`（快照失败只降级 warn——事件流已落盘，
 *      `replay()` 能完整重建）。
 *   3. **绝不静默失败**：缺字段、同名、非法 cwd、会话创建失败、操作已退役 Bot，
 *      一律抛**结构化错误**（`RosterError` + 机读 `code`）。
 *
 * ── 名称唯一性与「名额释放」的关系（重要，勿简化）──
 *   唯一性只在**未退役**的 Bot 之间生效（`nameIndex` 不含 retired）。
 *   ⇒ `rename` 后旧名立刻可被新 Bot 复用；
 *   ⇒ `retire` 后同名的**新** Bot 可创建（这就是草案说的「名字释放」）。
 *   比较口径：`trim()` + NFKC 归一 + `toLowerCase()`（**大小写不敏感**，见 `nameKey()`）。
 *
 * 依赖面：node 内置（`node:crypto` / `node:path`）+ `./store.js` + `./kernel.js`。
 * **不 import 任何 `@deepseek-ai/*`**（`test/ci-zero-dep.sh` 检查 1 机械强制）。
 *
 * `kernel.js` 用**静态 import**：它自身对宿主包是惰性 `createRequire`（`kernel.js:17-25`），
 * 裸检出（无 node_modules）下照样能加载 —— 与 `src/dispatcher.js:74` 的既有做法一致
 * （`src/board.js` 头部的动态导入注释是 2026-11-01 早期的判断，disp 已证伪；本文件不复制它）。
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'

import {
  appendJsonl,
  ensureDir,
  readJson,
  readJsonl,
  statePath,
  writeJsonAtomic,
} from './store.js'
import * as kernel from './kernel.js'
import {
  normalizeProfile,
  writeAgentsFile,
  readAgentsFile,
  writeSkill,
  listSkills,
  importMemoryToProfile,
} from './botprofile.js'

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

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 唯一合法状态集合（★ `retired` 是终态但**释放名额**，见文件头）。 */
const STATES = ['idle', 'running', 'parked', 'failed', 'retired']
/** 未退役状态（唯一性/可操作性判定用）。 */
const LIVE_STATES = STATES.filter((s) => s !== 'retired')
/** 合法权限档位（§3.1）。 */
const PERMISSIONS = ['read-only', 'workspace-write', 'full']
/** 权限缺省：Bot 需要在自己 cwd 内干活，故缺省给写权限（cwd 即写入边界）。 */
const DEFAULT_PERMISSION = 'workspace-write'
/** `label` 上限（§3.1）。 */
const MAX_LABEL = 24
/** 租约缺省 TTL（ms），与 board 的 300s 对齐。 */
const DEFAULT_LEASE_MS = 300_000
/** 事件动作集合（审计流可枚举）。 */
const ACTIONS = [
  'create',
  'rename',
  'retire',
  'set_cwd',
  'claim',
  'release',
  'heartbeat',
  'lease_expired',
  // v2 档案增强：三种「改档案」的入口各自留痕，避免审计流里只能看到一条笼统的 profile_updated
  // （排查「这条记忆谁加进来的」「技能怎么关联上的」时，动作名是第一手证据）。
  'profile_updated',
  'profile_memory_added',
  'profile_skills_linked',
  // 改造07（借鉴 Super-agent 的 prepare command）：开工前准备命令的变更留痕
  'prepare_command_set',
]

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 注册表结构化错误。所有失败都走它，**绝不静默**。 */
export class RosterError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息（bot id / rev / 字段名）
   * @param {string} [code]
   * @param {object} [details]
   */
  constructor(message, code = 'ROSTER_ERROR', details) {
    super(message)
    this.name = 'RosterError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/**
 * 深拷贝 + **JSON 归一**（去掉值为 undefined 的键）。
 * 必须走 JSON 而不是 structuredClone：否则内存态会比磁盘态多出 `{lease: undefined}`
 * 这类键，导致 `replay()` 重建后的 `list()` 与原值不等（board.js:94-102 同类踩坑）。
 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 非空字符串字段校验（缺字段/类型错的**唯一**出口）。 */
function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RosterError(
      `roster.${where}：字段 ${field} 缺失或类型错误（要求非空字符串，收到 ${JSON.stringify(value)}）`,
      'ROSTER_MISSING_FIELD',
      { field, where },
    )
  }
  return value
}

/** 可选字符串字段校验（`null` 视为「显式清空」，由调用方处理）。 */
function optionalString(value, field, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new RosterError(
      `roster.${where}：字段 ${field} 类型错误（要求字符串，收到 ${JSON.stringify(value)}）`,
      'ROSTER_BAD_FIELD',
      { field, where },
    )
  }
  return value
}

/** 名称归一（**大小写不敏感**的唯一性口径）。 */
function nameKey(name) {
  return String(name).normalize('NFKC').trim().toLowerCase()
}

/** 时间参数归一：缺省 now；支持 ms 数字与 Date。 */
function normalizeNow(value, where) {
  if (value === undefined || value === null) return Date.now()
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new RosterError(
    `roster.${where}：now 必须是毫秒时间戳或 Date，收到 ${JSON.stringify(value)}`,
    'ROSTER_BAD_NOW',
    { where },
  )
}

/** 可选整数（租约 TTL 等）。 */
function optionalNumber(value, field, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RosterError(
      `roster.${where}：字段 ${field} 类型错误（要求有限数字，收到 ${JSON.stringify(value)}）`,
      'ROSTER_BAD_FIELD',
      { field, where },
    )
  }
  return value
}

/** 权限档位校验。 */
function normalizePermission(value, where) {
  if (value === undefined || value === null) return DEFAULT_PERMISSION
  if (!PERMISSIONS.includes(value)) {
    throw new RosterError(
      `roster.${where}：非法 permission=${JSON.stringify(value)}（合法值：${PERMISSIONS.join(' | ')}）`,
      'ROSTER_BAD_PERMISSION',
      { permission: value, allowed: PERMISSIONS },
    )
  }
  return value
}

/** `label` 校验（≤24）。 */
function normalizeLabel(value, where) {
  const raw = optionalString(value, 'label', where)
  if (raw === undefined) return undefined
  if (raw.length > MAX_LABEL) {
    throw new RosterError(
      `roster.${where}：label 超长（${raw.length} > ${MAX_LABEL} 字符上限）`,
      'ROSTER_LABEL_TOO_LONG',
      { length: raw.length, max: MAX_LABEL },
    )
  }
  return raw
}

/** 状态筛选值校验。 */
function normalizeStateFilter(value) {
  if (value === undefined || value === null) return undefined
  if (!STATES.includes(value)) {
    throw new RosterError(
      `roster.list：非法 state=${JSON.stringify(value)}（合法值：${STATES.join(' | ')}）`,
      'ROSTER_BAD_STATE',
      { state: value, allowed: STATES },
    )
  }
  return value
}

/**
 * 平台状态目录根：`$DSH_HOME`（与 `kernel.stateDir()` 同一口径，`kernel.js:365-368`）。
 * **每次调用时求值**（测试会改 env；构造时缓存会让「同一实例两种结果」不可解释）。
 * @returns {string}
 */
function dshHomeRoot() {
  const home = process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`
  return resolve(home)
}

/**
 * cwd 校验（**本模块的核心价值之一：目录隔离**）。
 *
 * 三条硬要求，任一不满足即抛：
 *   1. 必填 + 必须是**绝对路径**（相对路径会随进程 cwd 漂移 ⇒ 写入边界不可预测）；
 *   2. **不得指向 `$DSH_HOME`**（那是宿主数据/凭据所在，Bot 写进去就是数据污染）；
 *   3. 归一化后不得**落在 `$DSH_HOME` 子树内**（同上，`~/.dsh/cs-bots/x` 一样能污染）。
 *
 * 另加一条**非阻塞**提示：cwd 是 `$DSH_HOME` 的**祖先**时 warn（该 cwd 下的 Bot 理论上能
 * 顺着子路径写进宿主状态目录）——不拒绝，因为那可能正是用户的正常家目录，拒绝属过度拦截。
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {string} 归一化绝对路径
 */
function assertBotCwd(value, where) {
  const raw = requireString(value, 'cwd', where)
  if (!isAbsolute(raw)) {
    throw new RosterError(
      `roster.${where}：cwd 必须是**绝对路径**（收到 ${JSON.stringify(raw)}）——`
      + '相对路径会随进程工作目录漂移，无法作为 Bot 的稳定写入边界',
      'ROSTER_BAD_CWD',
      { cwd: raw, where },
    )
  }
  const cwd = resolve(raw)
  const home = dshHomeRoot()
  if (cwd === home) {
    throw new RosterError(
      `roster.${where}：cwd 不得指向 $DSH_HOME（${home}）——那是宿主数据/凭据目录，Bot 写进去会污染宿主状态`,
      'ROSTER_CWD_IN_DSH_HOME',
      { cwd, dshHome: home, where },
    )
  }
  if (cwd.startsWith(home + sep)) {
    throw new RosterError(
      `roster.${where}：cwd（${cwd}）位于 $DSH_HOME（${home}）子树内——`
      + '宿主状态目录内的写入同样构成污染，请给 Bot 独立的工作目录',
      'ROSTER_CWD_IN_DSH_HOME',
      { cwd, dshHome: home, where },
    )
  }
  return cwd
}

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**：两条路都不通时必须让调用方看见。
 * @param {{ stateDir?: string }} config
 * @returns {string}
 */
function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') {
    return resolve(config.stateDir.trim())
  }
  if (typeof kernel?.stateDir === 'function') return resolve(kernel.stateDir())
  throw new RosterError(
    'roster.createRoster：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir。'
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'ROSTER_NO_STATE_DIR',
  )
}

/** 从 AgentHandle 取会话 id（宿主返回优先，绝不静默改写调用方给的 id）。 */
function pickSessionId(handle, requested) {
  if (typeof handle?.sessionId === 'string' && handle.sessionId !== '') return handle.sessionId
  if (typeof handle?.id === 'string' && handle.id !== '') return handle.id
  return requested
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 创建一个注册表实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function }, agents?: object, get?: Function }} [ctx]
 *        宿主上下文（透传给 `kernel.createSession`；缺 logger 即降级为 no-op 日志）
 * @param {{ stateDir?: string, leaseMs?: number, name?: string }} [config]
 * @returns {object} roster
 */
export function createRoster(ctx, config = {}) {
  const stateDir = resolveStateDir(config)
  const leaseMsDefault = Number.isFinite(config.leaseMs) && config.leaseMs > 0
    ? config.leaseMs
    : DEFAULT_LEASE_MS

  const jsonlPath = statePath(stateDir, 'roster.jsonl')
  const snapPath = statePath(stateDir, 'roster.snap.json')

  const info = (...args) => { try { ctx?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { ctx?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** 状态目录是否可写（不可写只降级 warn，不阻塞装配——与 dispatcher.durable 同语义）。 */
  const durable = ensureDir(stateDir)
  if (!durable) warn(`[cs-bots/roster] 状态目录不可写（${stateDir}）——注册表变更将无法落盘`)

  /** @type {Map<string, object>} bot id → Bot（创建序 = Map 插入序） */
  const bots = new Map()
  /** @type {Map<string, string>} nameKey → botId（**只含未退役 Bot**，退役即释放名字） */
  const nameIndex = new Map()
  /** @type {object[]} 全部 BotEvent（审计流，按落盘顺序） */
  const events = []

  const diagnostics = {
    stateDir,
    jsonlPath,
    snapPath,
    durable,
    kernelAvailable: typeof kernel?.createSession === 'function',
    hydratedFrom: /** @type {null|'jsonl'|'snapshot'|'empty'} */ (null),
    replayedEvents: 0,
    badLines: 0,
    skippedEvents: 0,
    snapshotWriteFailures: 0,
    auditWriteFailures: 0,
    auditWarnedOnce: false,
    lastReplayAt: /** @type {number|undefined} */ (undefined),
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 快照内容（落盘形态）。 */
  const snapshot = () => ({
    version: 1,
    savedAt: Date.now(),
    bots: [...bots.values()],
  })

  /**
   * 把某个 Bot 的**名字占用**同步进 `nameIndex`。
   *
   * ⚠️ 必须**先摘掉该 Bot 曾经占用的所有名字**再登记新名：`rename` 时旧名要**立刻**释放
   * （官方「名字永不复用」的反面，是本模块的核心增量之一）。漏了这一步的后果是
   * 「改名后旧名永久占用」，与 `retire` 释放名额的语义自相矛盾。
   *
   * @param {object} bot
   */
  function reindexName(bot) {
    for (const [k, holderId] of nameIndex) {
      if (holderId === bot.id) nameIndex.delete(k)
    }
    if (bot.state === 'retired') return
    nameIndex.set(nameKey(bot.name), bot.id)
  }

  /**
   * 提交一次变更：**先落事件，再改内存，最后写快照**。
   *
   * 顺序不可颠倒：append 失败时内存必须原封不动（否则内存与磁盘分叉，
   * 重启回放后状态凭空回退，属于最恶劣的静默失败）。
   *
   * @param {string} botId
   * @param {string} action
   * @param {string|null} byId
   * @param {number} at
   * @param {object|null} before 变更前 Bot（create 为 null）
   * @param {object} after 变更后 Bot
   * @returns {object} 克隆后的 after
   */
  function commit(botId, action, byId, at, before, after) {
    const event = {
      botId,
      rev: after.rev,
      action,
      byId: byId ?? null,
      at,
      before: before ? clone(before) : null,
      after: clone(after),
    }
    if (!appendJsonl(jsonlPath, event)) {
      throw new RosterError(
        `roster.${action}：事件追加失败（${jsonlPath}）——拒绝「只改内存不落盘」`,
        'ROSTER_APPEND_FAILED',
        { botId, action },
      )
    }
    bots.set(botId, clone(after))
    events.push(event)
    reindexName(after)
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/roster] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可完整恢复`)
    }
    // ── 审计接线（P1-D §4）────────────────────────────────────────────────
    // 软用 store.appendAudit：拿不到/写失败 → 只 warn 一次 + 计数，绝不阻断主流程。
    if (storeAuditMissing) {
      diagnostics.auditWriteFailures += 1
      if (!diagnostics.auditWarnedOnce) {
        diagnostics.auditWarnedOnce = true
        warn('[cs-bots/roster] store.appendAudit 尚不可用 → 审计接线跳过；主流程不受影响')
      }
    } else {
      try {
        const digest = (b) => (b
          ? { id: b.id, name: b.name ?? null, state: b.state ?? null, rev: b.rev }
          : null)
        const result = storeAppendAudit(stateDir, {
          ts: at, actor: byId, action, target: botId, before: digest(before), after: digest(after),
        })
        const failed = result === false || Boolean(result && typeof result === 'object' && result.ok === false)
        if (failed) {
          diagnostics.auditWriteFailures += 1
          if (!diagnostics.auditWarnedOnce) {
            diagnostics.auditWarnedOnce = true
            warn('[cs-bots/roster] store.appendAudit 返回失败——主流程不受影响')
          }
        }
      } catch (error) {
        diagnostics.auditWriteFailures += 1
        if (!diagnostics.auditWarnedOnce) {
          diagnostics.auditWarnedOnce = true
          warn(`[cs-bots/roster] store.appendAudit 抛错：${error?.message ?? error}——主流程不受影响`)
        }
      }
    }
    return clone(after)
  }

  // ── 回放 ──────────────────────────────────────────────────────────────────

  /**
   * 从 `roster.jsonl`（真相源）重建内存态；jsonl 为空才回落到 `roster.snap.json`。
   * 坏行/skipped 事件**不静默丢弃**：计入 diagnostics 并 warn。
   */
  function hydrate() {
    bots.clear()
    nameIndex.clear()
    events.length = 0

    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    diagnostics.skippedEvents = 0
    if (bad > 0) {
      warn(`[cs-bots/roster] ${jsonlPath} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
    }

    if (rows.length === 0) {
      const snap = readJson(snapPath, null)
      const snapBots = Array.isArray(snap?.bots) ? snap.bots : null
      if (snapBots) {
        for (const raw of snapBots) {
          if (!raw || typeof raw.id !== 'string') continue
          const b = clone(raw)
          if (typeof b.rev !== 'number') b.rev = 1
          bots.set(b.id, b)
          reindexName(b)
        }
        diagnostics.hydratedFrom = 'snapshot'
        info(`[cs-bots/roster] 回放完成：无事件流 → 由快照恢复 ${bots.size} 个 Bot`)
        return
      }
      diagnostics.hydratedFrom = 'empty'
      info('[cs-bots/roster] 回放完成：空注册表（无事件流、无快照）')
      return
    }

    // 事件流是真相源：只接受 rev 递增的事件（同 rev 重放幂等，容忍重复投递）
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.botId !== 'string' || !ev.after || typeof ev.after.id !== 'string') {
        skipped += 1
        continue
      }
      const before = bots.get(ev.botId)
      if (before && Number.isFinite(ev.rev) && ev.rev <= before.rev) {
        skipped += 1
        continue
      }
      bots.set(ev.botId, clone(ev.after))
      events.push(clone(ev))
    }
    diagnostics.skippedEvents = skipped
    if (skipped > 0) {
      warn(`[cs-bots/roster] 回放跳过 ${skipped} 条非递增/残缺事件（已保留在文件中，未被静默丢弃）`)
    }
    // 名字索引在整轮回放后统一重建（改名/退役的顺序敏感，逐条增量容易残留脏映射）
    for (const b of bots.values()) reindexName(b)
    diagnostics.hydratedFrom = 'jsonl'
    info(`[cs-bots/roster] 回放完成：${rows.length} 条事件 → ${bots.size} 个 Bot`)
  }

  // ── CAS 公共前置 ──────────────────────────────────────────────────────────

  /**
   * 取 Bot 并做 CAS 校验（rename/setCwd/claim/release/heartbeat 共用）。
   * @param {object} input
   * @param {string} action
   * @returns {object} 内存中的当前 Bot（**未克隆**，仅供构造 next 用）
   */
  function loadForCas(input, action) {
    const { id, expectedRev } = input ?? {}
    const botId = requireString(id, 'id', action)
    const current = bots.get(botId)
    if (!current) {
      throw new RosterError(`roster.${action}：Bot 不存在 id=${botId}`, 'ROSTER_NOT_FOUND', { id: botId })
    }
    if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev)) {
      throw new RosterError(
        `roster.${action}：expectedRev 必须是整数（CAS 需要显式期望版本，Bot ${botId} 当前 rev=${current.rev}，`
        + `收到 ${JSON.stringify(expectedRev)}）`,
        'ROSTER_MISSING_EXPECTED_REV',
        { id: botId, rev: current.rev },
      )
    }
    if (current.rev !== expectedRev) {
      throw new RosterError(
        `roster.${action} CAS 冲突：Bot ${botId} 期望 rev=${expectedRev}，实际 rev=${current.rev} ——`
        + '拒绝静默覆盖，请重新 get() 后按最新 rev 重试',
        'ROSTER_REV_CONFLICT',
        { id: botId, expectedRev, rev: current.rev },
      )
    }
    return current
  }

  /** 终态守卫：退役 Bot 不可再变更（除 `retire` 自身的重复调用判定）。 */
  function assertNotRetired(current, action, verb) {
    if (current.state === 'retired') {
      throw new RosterError(
        `roster.${action}：Bot ${current.id} 已退役（retiredAt=${current.retiredAt ?? '?'}）——`
        + `${verb}是终态后的非法操作；如需复用请新建同名 Bot（名额已释放）`,
        'ROSTER_RETIRED',
        { id: current.id, retiredAt: current.retiredAt },
      )
    }
  }

  /** 名字占用检查（**只对未退役 Bot 生效**）。 */
  function assertNameFree(name, selfId, action) {
    const key = nameKey(name)
    const holder = nameIndex.get(key)
    if (holder && holder !== selfId) {
      throw new RosterError(
        `roster.${action}：名字 ${JSON.stringify(String(name).trim())} 已被占用`
        + `（大小写不敏感归一后冲突）→ 现存 Bot ${holder}。注册表内名字必须唯一，拒绝静默重名`,
        'ROSTER_NAME_TAKEN',
        { name: String(name).trim(), key, holderId: holder, selfId: selfId ?? null },
      )
    }
  }

  // ── API：读 ────────────────────────────────────────────────────────────────

  /** @param {string} id @returns {object | undefined} */
  function get(id) {
    const b = bots.get(id)
    return b ? clone(b) : undefined
  }

  /**
   * 列出 Bot（**创建序**）。
   * 缺省不含 `retired`；显式传 `state:'retired'` 才看得到退役名录。
   * @param {{ state?: string }} [options]
   * @returns {object[]}
   */
  function list(options = {}) {
    const state = normalizeStateFilter(options?.state)
    const out = []
    for (const b of bots.values()) {
      if (state) {
        if (b.state === state) out.push(clone(b))
      } else if (b.state !== 'retired') {
        out.push(clone(b))
      }
    }
    return out
  }

  /** 退役名录（终态，留档用；名字/槽位已释放）。 @returns {object[]} */
  function listRetired() {
    return list({ state: 'retired' })
  }

  /**
   * 按**会话 id** 判定「这个会话是不是本平台注册的 Bot」（含已退役）。
   *
   * 为什么需要（2026-11-04，复杂度路由 P3-fix）：宿主 `llm/stream` 请求里**只有
   * `sessionId`**，而注册表的主键是 `botId`。路由要区分「主对话」（人类会话 ⇒ 平台层
   * 注入 paid_allowed）与「Bot 会话」（子智能体 ⇒ 默认 free_only），就必须有这条查询。
   *
   * 为什么按 `sessionId` **字段**匹配而不是 `bots.get(id)`：`create()` 里宿主可能把
   * 请求的 sessionId 改写成别的值（`pickSessionId` 已按「以宿主返回为准」处理并留档），
   * 拿 botId 当键查会在这种情形下漏判。
   *
   * 为什么包含退役 Bot：退役只释放名字与槽位，**会话本身还在宿主编排里把手上的活干完**，
   * 这段时间它仍是子智能体 —— 按主对话给付费授权属于越权。
   *
   * 纯读、**不抛**（非法入参返回 false）。
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  function hasSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    for (const b of bots.values()) {
      if (b?.sessionId === sessionId) return true
    }
    return false
  }

  /**
   * 注册表统计。
   * 口径说明：`total` = **含 retired 的全部 Bot**；`byState` 是全部状态的分布；
   * `retired` 单独给一份便于「还活着几个」直接取用（= `total - retired`）。
   * @returns {{ total: number, byState: Record<string, number>, retired: number }}
   */
  function stats() {
    /** @type {Record<string, number>} */
    const byState = {}
    for (const s of STATES) byState[s] = 0
    for (const b of bots.values()) {
      byState[b.state] = (byState[b.state] ?? 0) + 1
    }
    return { total: bots.size, byState, retired: byState.retired ?? 0 }
  }

  /**
   * 审计流查询。
   * @param {string} [botId] 省略则返回全部事件
   * @returns {object[]}
   */
  function history(botId) {
    return clone(botId ? events.filter((e) => e.botId === botId) : events)
  }

  // ── API：写 ────────────────────────────────────────────────────────────────

  /**
   * 创建一个 Bot：**先在独立 cwd 上建 root agent 会话，再落注册表**。
   *
   * 失败语义（**不能有半成品**）：
   *   - 全部字段校验在**动会话之前**完成 ⇒ 校验失败不产生任何会话；
   *   - `kernel.createSession` 抛错即向上抛（`ROSTER_SESSION_CREATE_FAILED`），
   *     且**不写事件、不动内存**（`id` 只在成功后占用）。
   *
   * 为什么必须传 `cwd`：官方 `spawn_teammate` 给不了独立目录（见文件头 §1），
   * `agents.create({meta:{cwd}})` 是唯一路径 —— 这一条会被 `test/roster.test.mjs`
   * 用「注入假 ctx 断言 `meta.cwd`」直接验证（§"测试要求"第 1 条）。
   *
   * @param {{ name: string, cwd: string, label?: string, model?: string, instructions?: string,
   *           permission?: string, byId: string, now?: number }} input
   * @returns {Promise<object>} Bot
   * @throws {RosterError} 缺字段 / 非法 cwd / 重名 / 会话创建失败 / 事件落盘失败
   */
  async function create(input = {}) {
    const { name, cwd, label, model, instructions, preset, permission, profile, prepareCommand, byId, now } = input ?? {}
    const by = requireString(byId, 'byId', 'create')
    const displayName = requireString(name, 'name', 'create')
    const dir = assertBotCwd(cwd, 'create')
    const roleLabel = normalizeLabel(label, 'create')
    const mdl = optionalString(model, 'model', 'create')
    const inst = optionalString(instructions, 'instructions', 'create')
    const perm = normalizePermission(permission, 'create')
    const at = normalizeNow(now, 'create')

    // ── 唯一性（校验通过后才动会话，避免「建了会话才发现重名」的资源泄漏）──
    assertNameFree(displayName, undefined, 'create')

    // ── 同 cwd 提示（非阻塞）：两个活 Bot 共用一个目录会撞 fs 写入边界 ──
    for (const other of bots.values()) {
      if (other.state !== 'retired' && other.cwd === dir) {
        warn(
          `[cs-bots/roster] 新 Bot「${displayName}」与 ${other.id}（「${other.name}」）共用 cwd=${dir}`
          + '——cwd 同时是 fs 写入边界，共用会导致互相覆盖，请确认这是有意为之',
        )
      }
    }

    // ── 会话创建：**唯一能指定 cwd 的路径**（kernel.js:249-287）──
    const id = `bot-${randomUUID()}`
    let handle
    try {
      handle = await kernel.createSession(ctx, {
        sessionId: id,
        cwd: dir,
        ...(preset !== undefined && preset !== null && preset !== '' ? { agentPreset: String(preset) } : {}),
      })
    } catch (error) {
      throw new RosterError(
        `roster.create：Bot「${displayName}」的会话创建失败（cwd=${dir}）→ ${error?.message ?? error}`
        + '——已中止注册（不产生半成品 Bot）',
        'ROSTER_SESSION_CREATE_FAILED',
        { name: displayName, cwd: dir, cause: String(error?.message ?? error) },
      )
    }
    const sessionId = pickSessionId(handle, id)
    if (sessionId !== id) {
      warn(
        `[cs-bots/roster] 宿主返回的会话 id（${sessionId}）与请求的（${id}）不同——以宿主返回为准并记入注册表`,
      )
    }

    /** @type {Record<string, unknown>} */
    const bot = {
      id,
      rev: 1,
      name: displayName,
      sessionId,
      cwd: dir,
      permission: perm,
      ...(preset !== undefined && preset !== null && preset !== '' ? { preset: String(preset) } : {}),
      state: 'idle',
      createdAt: at,
      createdBy: by,
    }
    if (roleLabel !== undefined) bot.label = roleLabel
    if (mdl !== undefined) bot.model = mdl
    if (inst !== undefined) bot.instructions = inst
    // 改造07：开工准备命令（借鉴 Super-agent 的 prepare command）
    if (prepareCommand !== undefined && prepareCommand !== null && prepareCommand !== '') {
      bot.prepareCommand = String(prepareCommand).trim()
      bot.prepareCommandSetAt = at
      bot.prepareCommandSetBy = by
    }
    // ── 档案（身份/经验/技能/预制记忆）→ 落到官方机制上 ──────────────────
    if (profile !== undefined) {
      try {
        bot.profile = normalizeProfile(profile)
        const written = writeAgentsFile(bot.cwd, { ...bot.profile, botName: bot.name, preset: bot.preset })
        bot.profilePath = written.path
        // 技能：每个名字建一个 SKILL.md 骨架（已存在则不覆盖正文）
        for (const skillName of bot.profile.skills ?? []) {
          try {
            writeSkill(bot.cwd, skillName, { body: `# ${skillName}\n\n（在此写技能说明）` })
          } catch (error) {
            warn(`[cs-bots/roster] 技能 ${skillName} 落盘失败（不影响注册）：${error?.message ?? error}`)
          }
        }
      } catch (error) {
        // 档案写失败不阻塞建 Bot（会话已建好），但要如实记在记录里
        bot.profile = normalizeProfile(profile)
        bot.profileError = String(error?.message ?? error)
        warn(`[cs-bots/roster] 档案落盘失败：${error?.message ?? error}`)
      }
    }

    // 事件落盘失败 → 会话已建但注册表没有它：**不静默**，错误里带上 sessionId 供人工清理
    try {
      return commit(id, 'create', by, at, null, bot)
    } catch (error) {
      error.message += `（注意：会话 ${sessionId} 已创建但未登记，请人工清理或重试 create）`
      throw error
    }
  }

  /**
   * 改名（**官方 roster 做不到的能力**，见文件头 §1.1）。
   *
   * 生效即释放旧名：旧名立刻可被新 Bot 复用（唯一性只算未退役 Bot）。
   *
   * @param {{ id: string, name: string, expectedRev: number, byId: string, now?: number }} input
   * @returns {object} Bot
   * @throws {RosterError} 同名占用 / 已退役 / CAS 冲突 / 缺字段
   */
  function rename(input = {}) {
    const { name, byId, now } = input ?? {}
    const current = loadForCas(input, 'rename')
    const by = requireString(byId, 'byId', 'rename')
    const displayName = requireString(name, 'name', 'rename')
    assertNotRetired(current, 'rename', '改名')

    const key = nameKey(displayName)
    assertNameFree(displayName, current.id, 'rename')
    if (nameKey(current.name) === key && current.name === displayName) {
      throw new RosterError(
        `roster.rename：Bot ${current.id} 的新名字与当前名字完全相同（${JSON.stringify(displayName)}）——无需变更`,
        'ROSTER_NOTHING_TO_RENAME',
        { id: current.id, name: displayName },
      )
    }

    const at = normalizeNow(now, 'rename')
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.name = displayName
    next.renamedAt = at
    next.renamedBy = by
    return commit(current.id, 'rename', by, at, before, next)
  }

  /**
   * 退役 → **终态，但释放名额**（名字可复用、cwd 可回收；§3.1 "关键" 段）。
   *
   * 语义边界（写清楚，避免误用）：
   *   - 退役**不删除**记录（append-only 审计流里留档，`listRetired()` 可查）；
   *   - 退役**不杀会话**（会话生命周期由宿主管理；本模块只管注册表视图）；
   *   - 退役**无 CAS**（签名 §"必须实现" 无 `expectedRev`），但**拒绝重复退役**——
   *     重复调用抛 `ROSTER_ALREADY_RETIRED`，不会写第二条事件。
   *   - 名字唯一性只算未退役 Bot ⇒ 退役**立刻**释放名字与槽位。
   *
   * @param {{ id: string, reason?: string, byId: string, now?: number }} input
   * @returns {object} Bot
   * @throws {RosterError} 不存在 / 已退役 / 缺 byId
   */
  function retire(input = {}) {
    const { id, reason, byId, now } = input ?? {}
    const botId = requireString(id, 'id', 'retire')
    const by = requireString(byId, 'byId', 'retire')
    const note = optionalString(reason, 'reason', 'retire')
    const current = bots.get(botId)
    if (!current) {
      throw new RosterError(`roster.retire：Bot 不存在 id=${botId}`, 'ROSTER_NOT_FOUND', { id: botId })
    }
    if (current.state === 'retired') {
      throw new RosterError(
        `roster.retire：Bot ${botId} 已于 ${current.retiredAt ?? '?'} 退役（终态不重复写）`,
        'ROSTER_ALREADY_RETIRED',
        { id: botId, retiredAt: current.retiredAt },
      )
    }

    const at = normalizeNow(now, 'retire')
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.state = 'retired'
    next.retiredAt = at
    next.retiredBy = by
    if (note !== undefined) next.retiredReason = note
    delete next.lease // 退役即清租约，不留悬空持有者
    const committed = commit(botId, 'retire', by, at, before, next)
    info(`[cs-bots/roster] Bot ${botId}（「${current.name}」）已退役 —— 名字与槽位释放，可复用`)
    return committed
  }

  /**
   * 换工作目录（**官方完全没有的语义**：teammate 强制继承父 cwd）。
   *
   * ⚠️ 诚实边界（必须知道，否则会误判）：本函数只改**注册表记录**。
   * 已建会话的 cwd 是宿主的 **durable session data**（`kernel.js:257-259` 原文
   * "This is durable session data"），**不会**随本变更迁移 —— 新 cwd 在
   * 「按本记录重建会话」时生效。故此处记 warn，不假装已经搬完家。
   *
   * @param {{ id: string, cwd: string, expectedRev: number, byId: string, now?: number }} input
   * @returns {object} Bot
   * @throws {RosterError} 非法 cwd / 已退役 / CAS 冲突
   */
  /**
   * 读一个 Bot 的档案（含从 AGENTS.md 读回的托管段）。
   * @param {string} id
   * @returns {{ bot: object, profilePath?: string, managedText?: string, hasOutside?: boolean, skills?: string[] }}
   */
  function getProfile(id) {
    const bid = requireString(id, 'id', 'getProfile')
    // ⚠️ 修复（2026-11-04 测试）：原为 `index.get(bid)` —— 本函数作用域内只有
    //   `bots` Map，没有 `index` ⇒ 每次调用必然 ReferenceError（HTTP 400
    //   `API_ERROR: index is not defined`），Bot 档案抽屉打开即报错。
    const bot = bots.get(bid)
    if (!bot) {
      throw new RosterError(`roster.getProfile：Bot ${bid} 不存在`, 'ROSTER_BOT_NOT_FOUND', { id: bid })
    }
    const out = { bot, profile: bot.profile ?? {} }
    try {
      const md = readAgentsFile(bot.cwd)
      out.profilePath = md.path
      out.managedText = md.managed
      out.hasOutside = Boolean(md.outside && md.outside.trim())
    } catch (error) {
      out.profileError = String(error?.message ?? error)
    }
    return out
  }

  /**
   * 退役 Bot 不可改档案 —— 三个改档案入口（setProfile / addProfileMemory / linkSkills）
   * 共用同一守卫：**同一语义只有一处判定**，否则日后加新入口时漏一个就会给退役 Bot 改档案。
   *
   * 错误码沿用 setProfile 既有的 `ROSTER_BOT_RETIRED`（不是 assertNotRetired 的
   * `ROSTER_RETIRED`）：API 层与 UI 已按前者识别「退役导致不可改档案」，改码会让提示退化成通用错误。
   *
   * @param {object} current
   * @param {string} action
   */
  function assertProfileEditable(current, action) {
    if (current.state === 'retired') {
      throw new RosterError(
        `roster.${action}：Bot ${current.id} 已退役（名字 ${current.name}）——退役 Bot 不可改档案`,
        'ROSTER_BOT_RETIRED',
        { id: current.id },
      )
    }
  }

  /**
   * 把档案写进 AGENTS.md（受管区块），并给**缺失的**技能补一个骨架 SKILL.md。
   *
   * 为什么抽成一个函数：setProfile / addProfileMemory / linkSkills 三条入口必须**同一套落盘口径**。
   * 复制三份的下场是「同一种档案，三个入口写出三种 AGENTS.md」——历史上已经吃过一次
   * （getProfile 引用了不存在的 index 变量，单点 bug 让整个抽屉打不开）。
   *
   * 为什么技能骨架只在文件缺失时补：已存在的 SKILL.md 里可能是用户/模型写好的正文，
   * 旧实现无条件覆盖成骨架，等于每次存档案就静默删掉一次技能内容（数据损失且无提示）。
   *
   * @param {object} current Bot 记录（只读 cwd / name / preset）
   * @param {object} profile 归一后的档案
   * @param {string} where 错误信息里的动作名
   * @param {{ strictSkills?: boolean }} [options] strictSkills=true → 技能落盘失败即抛错
   * @returns {{ path: string }} writeAgentsFile 的返回
   */
  function writeProfileFiles(current, profile, where, options = {}) {
    let written
    try {
      written = writeAgentsFile(current.cwd, {
        ...profile,
        botName: current.name,
        preset: current.preset,
      })
    } catch (error) {
      throw new RosterError(
        `roster.${where}：写 AGENTS.md 失败（cwd=${current.cwd}）→ ${error?.message ?? error}`,
        'ROSTER_PROFILE_WRITE_FAILED',
        { id: current.id, cwd: current.cwd, cause: String(error?.message ?? error) },
      )
    }

    let present = new Set()
    try {
      present = new Set(listSkills(current.cwd))
    } catch (error) {
      // 列技能失败不阻塞：下一步 writeSkill 会给出带 code 的真实失败原因
      warn(`[cs-bots/roster] 列技能失败（${current.cwd}）：${error?.message ?? error}`)
    }
    for (const skillName of profile.skills ?? []) {
      if (present.has(skillName)) continue
      try {
        writeSkill(current.cwd, skillName, { body: `# ${skillName}\n\n（在此写技能说明）` })
      } catch (error) {
        if (options.strictSkills) {
          // 技能名非法与写盘失败要给不同 code：前者是调用方参数错（改参数即可），后者是环境问题
          const badName = error?.code === 'PROFILE_BAD_SKILL_NAME'
          throw new RosterError(
            `roster.${where}：技能 ${JSON.stringify(skillName)} 落盘失败 → ${error?.message ?? error}`,
            badName ? 'ROSTER_BAD_SKILL_NAME' : 'ROSTER_SKILL_WRITE_FAILED',
            {
              id: current.id,
              cwd: current.cwd,
              skill: skillName,
              causeCode: error?.code,
              cause: String(error?.message ?? error),
            },
          )
        }
        // 非显式技能操作（setProfile 顺带补骨架）失败只降级 warn：
        // AGENTS.md 已写成功，档案本身有效，缺一个骨架文件不该让整次保存失败。
        warn(`[cs-bots/roster] 技能 ${skillName} 落盘失败（不影响档案）：${error?.message ?? error}`)
      }
    }
    return written
  }

  /**
   * 档案变更的统一收尾：rev+1 + 审计字段 + 提交事件。
   *
   * @param {object} current
   * @param {object} nextProfile
   * @param {string} by
   * @param {number} at
   * @param {{ path: string }} written
   * @param {string} action
   * @returns {object} 变更后的 Bot（克隆）
   */
  function commitProfileChange(current, nextProfile, by, at, written, action = 'profile_updated') {
    const before = clone(current)
    const next = clone(current)
    next.profile = nextProfile
    next.profilePath = written.path
    delete next.profileError // 落盘成功即清掉历史失败标记，否则记录会永远带着一条过期错误
    next.rev = current.rev + 1
    next.updatedAt = at
    next.updatedBy = by
    return commit(current.id, action, by, at, before, next)
  }

  /**
   * 改一个 Bot 的档案（身份/经验/技能/预制记忆 + v2 的 title/persona/boundaries/disciplineIds）
   * → 重写 AGENTS.md 托管段。
   *
   * **只动托管段**，用户在 AGENTS.md 段外写的内容原样保留。
   *
   * 语义是**浅合并**：`{ ...旧档案, ...归一后的新档案 }`。故传 `{ persona: '...' }`
   * 不会清掉 identity —— 想清空某个字段传空串（`''` 会被 takeText 接受）；
   * 想整份替换请先 `get()` 再传完整对象（UI 的档案抽屉就是这么做的）。
   *
   * @param {{ id: string, profile: object, byId?: string, expectedRev?: number, now?: number }} input
   */
  function setProfile(input = {}) {
    const { profile, byId, now } = input ?? {}
    const current = loadForCas(input, 'setProfile')
    const by = requireString(byId, 'byId', 'setProfile')
    assertProfileEditable(current, 'setProfile')
    const nextProfile = { ...(current.profile ?? {}), ...normalizeProfile(profile) }

    // 先落盘，成功再记事件（避免"记录说改了但文件没变"）
    const written = writeProfileFiles(current, nextProfile, 'setProfile')
    const at = normalizeNow(now, 'setProfile')
    return commitProfileChange(current, nextProfile, by, at, written)
  }

  /**
   * 往 Bot 的预制记忆里**追加**一批条目（v2，DESIGN-v2 特性 ③）。
   *
   * 与 setProfile 的分工：setProfile 是「整份档案覆盖」，本函数是「只加记忆、别的不动」——
   * 记忆是持续生长的（会话里捞到一条值得常驻的结论就顺手加进来），
   * 让调用方每次先 get 再整份回写，等于把并发 CAS 的窗口人为拉长，容易互相覆盖。
   *
   * 去重、空白、超限的规则全在 `botprofile.importMemoryToProfile`（纯函数，可单独测）。
   *
   * 无新增（全是重复/空白）时**不写事件、不 bump rev**：审计流里一条「什么都没改」的记录
   * 只会污染历史，而且调用方手里的 expectedRev 还能继续用，不必再 get() 一次。
   *
   * @param {{ id: string, entries: string[], dedup?: boolean, byId: string,
   *           expectedRev: number, now?: number }} input
   * @returns {{ bot: object, added: number, skipped: number }}
   * @throws {RosterError} 不存在 / CAS 冲突 / 已退役 / 落盘失败
   * @throws {ProfileError} 条目超长或总量超限（不静默截断）
   */
  function addProfileMemory(input = {}) {
    const { entries, dedup, byId, now } = input ?? {}
    const current = loadForCas(input, 'addProfileMemory')
    const by = requireString(byId, 'byId', 'addProfileMemory')
    assertProfileEditable(current, 'addProfileMemory')

    const profile = current.profile ?? {}
    const existing = Array.isArray(profile.memory) ? profile.memory : []
    const merged = importMemoryToProfile({ existing, entries, dedup: dedup !== false })

    if (merged.added === 0) {
      return { bot: clone(current), added: 0, skipped: merged.skipped }
    }

    const nextProfile = { ...profile, memory: merged.memory }
    const written = writeProfileFiles(current, nextProfile, 'addProfileMemory')
    const at = normalizeNow(now, 'addProfileMemory')
    const bot = commitProfileChange(current, nextProfile, by, at, written, 'profile_memory_added')
    return { bot, added: merged.added, skipped: merged.skipped }
  }

  /**
   * 把技能**关联**到 Bot：写进 `bot.profile.skills` 并落 `.agents/skills/<名>/SKILL.md`（v2）。
   *
   * 为什么是「并集」而不是「替换」：函数名是 link（关联），语义是**追加关联**；
   * 已关联的技能不会被这次调用摘掉。要整体替换技能清单请用 setProfile({ skills })。
   *
   * 为什么技能文件写失败要抛错（strictSkills）：技能能被官方 `skills.list({ cwd })` 发现
   * **全靠那个文件**；文件写不成却把名字记进 profile，等于给 Bot 一个「查无此技能」的悬空关联，
   * 比直接报错更坏（模型会一直找不到技能却不知道为什么）。
   *
   * 已关联且文件都在时：不写事件、不 bump rev（幂等，允许 UI 重复点「关联」）。
   *
   * @param {{ id: string, skills: string[], byId: string, expectedRev: number, now?: number }} input
   * @returns {object} 变更后的 Bot（无变更时返回当前记录）
   * @throws {RosterError} 不存在 / CAS 冲突 / 已退役 / 技能名非法 / 落盘失败
   */
  function linkSkills(input = {}) {
    const { skills, byId, now } = input ?? {}
    const current = loadForCas(input, 'linkSkills')
    const by = requireString(byId, 'byId', 'linkSkills')
    assertProfileEditable(current, 'linkSkills')

    if (!Array.isArray(skills) || skills.length === 0) {
      throw new RosterError(
        `roster.linkSkills：skills 必填且不能为空（收到 ${JSON.stringify(skills)}）——`
        + '空数组没有可关联对象，多半是调用方漏传参数',
        'ROSTER_BAD_FIELD',
        { field: 'skills', where: 'linkSkills' },
      )
    }
    // 复用档案校验口径（条数 / 单项长度），避免为「关联技能」另造一套规则后与 setProfile 分叉
    const incoming = normalizeProfile({ skills }).skills ?? []

    const profile = current.profile ?? {}
    const existing = Array.isArray(profile.skills) ? profile.skills : []
    const nextSkills = [...existing]
    let changed = false
    for (const name of incoming) {
      if (nextSkills.includes(name)) continue
      nextSkills.push(name)
      changed = true
    }

    // 先落盘（AGENTS.md + 技能文件），成功再记事件
    const nextProfile = { ...profile, skills: nextSkills }
    const written = writeProfileFiles(current, nextProfile, 'linkSkills', { strictSkills: true })
    if (!changed) {
      // 技能清单没变（可能只是补写了缺失的技能文件）→ 不改 rev，调用方 CAS 继续有效
      return clone(current)
    }
    const at = normalizeNow(now, 'linkSkills')
    return commitProfileChange(current, nextProfile, by, at, written, 'profile_skills_linked')
  }

  function setCwd(input = {}) {
    const { cwd, byId, now } = input ?? {}
    const current = loadForCas(input, 'setCwd')
    const by = requireString(byId, 'byId', 'setCwd')
    const dir = assertBotCwd(cwd, 'setCwd')
    assertNotRetired(current, 'setCwd', '换目录')

    if (current.cwd === dir) {
      throw new RosterError(
        `roster.setCwd：Bot ${current.id} 的 cwd 已是 ${dir}——无需变更`,
        'ROSTER_NOTHING_TO_SET_CWD',
        { id: current.id, cwd: dir },
      )
    }

    const at = normalizeNow(now, 'setCwd')
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.cwd = dir
    next.cwdChangedAt = at
    next.cwdChangedBy = by
    warn(
      `[cs-bots/roster] Bot ${current.id} 的注册表 cwd 由 ${current.cwd} 改为 ${dir}；`
      + `已建会话 ${current.sessionId} 的 cwd 是宿主 durable 数据，**不随之迁移**`,
    )
    return commit(current.id, 'setCwd', by, at, before, next)
  }

  /**
   * 设置/清除开工准备命令（改造07 · 借鉴 Super-agent 的 prepare command）。
   *
   * prepare command 在 Bot 首次 claim 任务时执行，用于 `git worktree`、拉代码等
   * 开工前准备。失败会阻塞 claim（任务保持 pending，由上层记录原因）。
   *
   * @param {{ id: string, prepareCommand?: string|null, byId: string, now?: number }} input
   * @returns {object} Bot
   * @throws {RosterError} 已退役 / CAS 冲突
   */
  function setPrepareCommand(input = {}) {
    const { prepareCommand, byId, now } = input ?? {}
    const current = loadForCas(input, 'setPrepareCommand')
    const by = requireString(byId, 'byId', 'setPrepareCommand')
    assertNotRetired(current, 'setPrepareCommand', '设置准备命令')

    const at = normalizeNow(now, 'setPrepareCommand')
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    if (prepareCommand === null || prepareCommand === undefined || prepareCommand === '') {
      delete next.prepareCommand
      delete next.prepareCommandSetAt
      delete next.prepareCommandSetBy
    } else {
      const cmd = String(prepareCommand).trim()
      next.prepareCommand = cmd
      next.prepareCommandSetAt = at
      next.prepareCommandSetBy = by
    }
    return commit(current.id, 'prepare_command_set', by, at, before, next)
  }

  /**
   * 取租约（§3.1 草案未列，见文件头「必要增量」第 3 条）。
   *
   * 租约的作用与 board 的 owner lease 同构：**封死「持有者在 interrupt/崩溃后永不释放」**——
   * 靠 `expireLeases()` 到期回收，而不是指望一方自觉。
   *
   * @param {{ id: string, owner: string, expectedRev: number, leaseMs?: number, now?: number }} input
   * @returns {object} Bot
   * @throws {RosterError} 活跃租约被他人持有 / 已退役 / CAS 冲突
   */
  function claim(input = {}) {
    const { owner, leaseMs, now } = input ?? {}
    const current = loadForCas(input, 'claim')
    const holder = requireString(owner, 'owner', 'claim')
    assertNotRetired(current, 'claim', '取租约')

    const ttl = optionalNumber(leaseMs, 'leaseMs', 'claim') ?? leaseMsDefault
    if (!(ttl > 0)) {
      throw new RosterError(
        `roster.claim：leaseMs 必须 > 0，收到 ${JSON.stringify(leaseMs)}`,
        'ROSTER_BAD_FIELD',
        { field: 'leaseMs' },
      )
    }
    const at = normalizeNow(now, 'claim')
    if (current.lease) {
      const exp = Number(current.lease.expiresAt)
      const live = Number.isFinite(exp) && exp > at
      if (live && current.lease.owner !== holder) {
        throw new RosterError(
          `roster.claim：Bot ${current.id} 的租约仍被 ${current.lease.owner} 持有`
          + `（至 ${new Date(exp).toISOString()}）——不允许抢占，调用者为 ${holder}`,
          'ROSTER_LEASE_HELD',
          { id: current.id, owner: current.lease.owner, expiresAt: exp },
        )
      }
      if (!live) {
        warn(
          `[cs-bots/roster] Bot ${current.id} 的租约已于 ${new Date(exp).toISOString()} 过期`
          + `（持有者 ${current.lease.owner}）→ 允许抢占`,
        )
      }
    }

    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.state = 'running'
    next.lease = { owner: holder, expiresAt: at + ttl, heartbeatAt: at }
    return commit(current.id, 'claim', holder, at, before, next)
  }

  /**
   * 主动放租约（回 `idle`）。
   * @param {{ id: string, owner: string, expectedRev: number, now?: number }} input
   * @returns {object} Bot
   */
  function release(input = {}) {
    const { owner, now } = input ?? {}
    const current = loadForCas(input, 'release')
    const holder = requireString(owner, 'owner', 'release')
    if (!current.lease) {
      throw new RosterError(
        `roster.release：Bot ${current.id} 当前没有租约（state=${current.state}），无可释放`,
        'ROSTER_NO_LEASE',
        { id: current.id },
      )
    }
    if (current.lease.owner !== holder) {
      throw new RosterError(
        `roster.release：只允许租约持有者释放（Bot ${current.id} 的租约属于 ${current.lease.owner}，调用者 ${holder}）`,
        'ROSTER_LEASE_NOT_OWNER',
        { id: current.id, owner: current.lease.owner },
      )
    }
    const at = normalizeNow(now, 'release')
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.state = 'idle'
    delete next.lease
    return commit(current.id, 'release', holder, at, before, next)
  }

  /**
   * 心跳续租。
   * @param {{ id: string, owner: string, expectedRev: number, leaseMs?: number, now?: number }} input
   * @returns {object} Bot
   * @throws {RosterError} 无租约 / 非持有者 / 租约已过期（**心跳不复活过期租约**）
   */
  function heartbeat(input = {}) {
    const { owner, leaseMs, now } = input ?? {}
    const current = loadForCas(input, 'heartbeat')
    const holder = requireString(owner, 'owner', 'heartbeat')
    if (!current.lease) {
      throw new RosterError(
        `roster.heartbeat：Bot ${current.id} 没有活跃租约（state=${current.state}）——请先 claim`,
        'ROSTER_NO_LEASE',
        { id: current.id, state: current.state },
      )
    }
    if (current.lease.owner !== holder) {
      throw new RosterError(
        `roster.heartbeat：只允许租约持有者续租（Bot ${current.id} 的租约属于 ${current.lease.owner}，调用者 ${holder}）`,
        'ROSTER_LEASE_NOT_OWNER',
        { id: current.id, owner: current.lease.owner },
      )
    }
    const at = normalizeNow(now, 'heartbeat')
    const exp = Number(current.lease.expiresAt)
    if (!Number.isFinite(exp) || exp <= at) {
      throw new RosterError(
        `roster.heartbeat：Bot ${current.id} 的租约已过期`
        + `（expiresAt=${Number.isFinite(exp) ? new Date(exp).toISOString() : exp}）`
        + '——心跳无法复活过期租约，请走 claim 或 expireLeases',
        'ROSTER_LEASE_EXPIRED',
        { id: current.id, expiresAt: exp },
      )
    }
    const ttl = optionalNumber(leaseMs, 'leaseMs', 'heartbeat') ?? leaseMsDefault
    if (!(ttl > 0)) {
      throw new RosterError(
        `roster.heartbeat：leaseMs 必须 > 0，收到 ${JSON.stringify(leaseMs)}`,
        'ROSTER_BAD_FIELD',
        { field: 'leaseMs' },
      )
    }
    const before = clone(current)
    const next = clone(current)
    next.rev = current.rev + 1
    next.lease = { owner: holder, expiresAt: at + ttl, heartbeatAt: at }
    return commit(current.id, 'heartbeat', holder, at, before, next)
  }

  /**
   * 过期租约回收：`lease.expiresAt <= now` → 清租约、回 `idle`。
   *
   * **这是封死「持有者崩溃后永不释放」硬伤的关键动作**（同 board.expireLeases 的立意）。
   * 已退役 Bot 天然无租约（retire 时已清），不参与回收。
   *
   * @param {{ now?: number }} [options]
   * @returns {string[]} 被回收的 bot id（创建序）
   */
  function expireLeases(options = {}) {
    const at = normalizeNow(options?.now, 'expireLeases')
    const recycled = []
    for (const current of [...bots.values()]) {
      if (!current.lease) continue
      const exp = Number(current.lease.expiresAt)
      if (!Number.isFinite(exp)) {
        warn(
          `[cs-bots/roster] Bot ${current.id} 的租约 expiresAt 非法`
          + `（${JSON.stringify(current.lease.expiresAt)}）——不静默放过，本次跳过回收`,
        )
        continue
      }
      if (exp > at) continue

      const before = clone(current)
      const next = clone(current)
      next.rev = current.rev + 1
      // running 是「被租约驱动」的状态，租约没了就回 idle；parked/failed 是显式状态，不覆盖
      if (next.state === 'running') next.state = 'idle'
      delete next.lease
      commit(current.id, 'lease_expired', current.lease.owner ?? null, at, before, next)
      recycled.push(current.id)
      info(
        `[cs-bots/roster] 租约回收：${current.id} 由 ${current.lease.owner} 于 ${new Date(exp).toISOString()} 过期`
        + ` → state=${next.state}`,
      )
    }
    return recycled
  }

  /**
   * 从 `roster.jsonl` 重建内存态（重启回放一致性）。
   * @returns {{ from: string, bots: number, events: number, bad: number, skipped: number }}
   */
  function replay() {
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      bots: bots.size,
      events: events.length,
      bad: diagnostics.badLines,
      skipped: diagnostics.skippedEvents,
    }
  }

  /** 首次构造即回放，保证 `list()` 在重启后马上可用。 */
  hydrate()

  return {
    name: config.name ?? 'roster',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    durable,
    create,
    get,
    list,
    listRetired,
    hasSession,
    rename,
    retire,
    setCwd,
    setPrepareCommand,
    getProfile,
    setProfile,
    // v2 档案增强（DESIGN-v2 特性 ③）：追加预制记忆 / 关联技能（都走 CAS）
    addProfileMemory,
    linkSkills,
    claim,
    release,
    heartbeat,
    expireLeases,
    replay,
    stats,
    history,
    diagnostics: () => clone(diagnostics),
    /** 状态/权限的合法值（供上层校验与文档复用，避免各处硬编码）。 */
    constants: Object.freeze({
      STATES: Object.freeze([...STATES]),
      LIVE_STATES: Object.freeze([...LIVE_STATES]),
      PERMISSIONS: Object.freeze([...PERMISSIONS]),
      ACTIONS: Object.freeze([...ACTIONS]),
      MAX_LABEL,
      DEFAULT_PERMISSION,
      DEFAULT_LEASE_MS: leaseMsDefault,
    }),
  }
}

export default createRoster
