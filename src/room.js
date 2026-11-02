/**
 * cs-bots RoomService —— 房间与群聊（**确定性写通路**）。
 *
 * 设计依据：`multiagent/10-初步架构设计方案-v1.md` §3.2（RoomService）。
 *
 * ── 为什么必须自建（硬事实，不是重复造轮子）────────────────────────────────
 *   官方**没有** peer 消息流。一手原文（`dsh-experimental-client-ui-agent-team/README.zh.md:88`）：
 *     "没有 mailbox timeline"
 *   ⇒ 平台之间的「消息可见性」这件事，宿主管线上**结构上不存在**，只能自建。
 *   ⇒ 而且写通路**必须是确定性的**：像 `cs-bot-bea` 那样「把指令投给模型、让模型自己去调工具」
 *     是非确定性的（模型可以理解错、可以不调、可以改写）——§3.2 硬约束 1 明确要求
 *     **走域服务直调，不经 HTTP、不经模型**。本文件的 `post()` 就是那条通路。
 *
 * ── 相对 §3.2 草案的**必要增量**（不改既有字段语义，纯增量）──
 *   `rev`           —— 草案未列。加它是为了支持**可选 CAS**（见下「CAS 取舍」）。
 *   `createdAt` / `createdBy` —— 审计用（谁在何时建的房间），`list()` 直接可展示。
 *   `replyTo`（消息）—— 草案 `post` 签名列了该参数却没规定落点，本模块落在消息顶层。
 *   `fingerprint`   —— 长正文的「长度 + 哈希前缀」，`readBody()` 用它做**读回校验**。
 *
 * ── CAS 取舍（**刻意与 board.js / roster.js 不同**，理由在此）──
 *   board/roster 的每次变更都强制 `expectedRev`；§3.2 给 `join` / `leave` /
 *   `post` 的签名里**没有**版本字段。硬塞一个必填 CAS 会破坏已冻结的接口。
 *   故本模块取**可选 CAS**：传了 `expectedRev` 就严格比对（不匹配抛
 *   `ROOM_REV_CONFLICT`），不传则不拦。写通路本身是确定性的（单实例直调 + append-only），
 *   房间状态的并发面远小于任务板，这个取舍是有意的，不是遗漏。
 *
 * ── 四条不变量（全模块机械保证）──
 *   1. **事件流是真相源**：房间状态变更先 append `events.jsonl`（失败即抛错，
 *      内存原封不动），再更新内存，最后原子写 `rooms/index.json`（快照失败只降级
 *      warn —— 事件流已落盘，`replay()` 能完整重建）。
 *   2. **消息日志 append-only 且永不截断**（§3.2 硬约束 3）：`log.jsonl` 一条一行，
 *      **没有任何环形上限**。对照 ds-bot 的 `ROOM_LOG_MAX = 60`（`groups.js:31`）——
 *      环形截断正是「真相源分裂」的温床，本模块从结构上不给它留位置。
 *   3. **seq 单调且连续无洞**：由消息日志推导（`store.nextSeq` + 内存自维护），
 *      断点续传与回放都靠它。发现空洞**不静默**：计入 `stats().seqGaps` 并 warn。
 *   4. **长正文落旁路文件**（K2）：`text` 超过 `BODY_THRESHOLD` 时正文写
 *      `rooms/<roomId>/bodies/<msgId>.txt`，`log.jsonl` 里只留
 *      **头 + 指纹 + bodyRef**。这样日志可无限追加而不撞规模上限，
 *      **且不需要任何截断**（K2 的原话是「规模必须前置预算，不靠事后截断」）。
 *
 * ── 三条来自 DS-BOT 实测的纪律（`12-硬约束清单.md` §7.2）是怎么落地的 ──
 *   **K1（禁用阻塞式提问）**：投递一律 `kernel.followup`，**不用 `steer`** ——
 *       `followup` 是「新开一个回合」，适合「有新活要干」；`steer` 会插进正在跑的回合，
 *       对有长任务的 Bot 语义不清。此处的选择与 `dispatcher.js:370` 一致。
 *   **K2（长正文前置旁路）**：见不变量 4。**这条是本模块相对 ds-bot 的核心改进**。
 *   **K4（投递必须有背压）**：`relayLimit`（默认 3×成员数）+ 每次转发**先落意图事件再投递**
 *       —— 「记录了但没投出去」可以重试，「投出去了但没记录」会导致限额被绕过。
 *
 * ── 成员语义（**易踩，特意写清**）──
 *   `room.members` **就是**房间成员全集，**创建者不会自动入房**。
 *   为什么不做「自动把 creator 加进去」：那会让 `members` 与入参不一致，
 *   连带 `relayLimit = 3 × 成员数` 也不再等于调用方的算术 —— 这是隐蔽的语义漂移。
 *   ⇒ 例外只有一处：**`members` 缺省未传**时，缺省为 `[byId]`（创建者自成一房）。
 *      显式传了 `members` 就**原样采信**，不增不减。
 *   ⇒ 要让创建者能发言，请把 `byId` 放进 `members`，或走 `mode:'admin'`（见下）。
 *
 * ── `mode` 的语义（草案只给了枚举没给规则，此处定死并写清）──
 *   `'everyone'`（缺省）：**成员都可以发言**。
 *   `'admin'`：**只有 `adminId` 能发言**（公告型房间）。成员仍可 join/leave/收转发。
 *   `'user'` 是特殊发送者 id：**永远可发言**（人类从平台 API 面发言的入口）。
 *   `mode:'admin'` 且 `adminId` 缺省 → 取 `byId`（创建者即管理员）。
 *   管理员退房 → 管理权**移交给最早加入的剩余成员**（写 `admin_transferred` 事件，可见）；
 *   房间空了则清空 `adminId`。⇒ 不留「管理员已走、房间被锁死」这种隐形死局。
 *
 * 依赖面：node 内置（`node:crypto` / `node:fs` / `node:path`）+ `./store.js` + `./kernel.js`。
 * **不 import 任何 `@deepseek-ai/*`**（`test/ci-zero-dep.sh` 检查 1 机械强制）。
 *
 * `kernel.js` 用**静态 import**：它自身对宿主包是惰性 `createRequire`（`kernel.js:17-25`），
 * 裸检出（无 node_modules）下照样能加载 —— 与 `src/roster.js:56` 的既有做法一致。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  appendJsonl,
  ensureDir,
  IdempotencySet,
  nextSeq,
  readJson,
  readJsonl,
  statePath,
  writeJsonAtomic,
} from './store.js'
import * as kernel from './kernel.js'

// ── 常量 ────────────────────────────────────────────────────────────────────

/** `notice` 上限（§3.2）。 */
const MAX_NOTICE = 2000
/** 长正文阈值：**超过**它才落旁路文件（§3.2 硬约束 4 / K2）。 */
const BODY_THRESHOLD = 2000
/** 落旁路时 `log.jsonl` 里保留的**头**长度（「只存头」的落地口径）。 */
const BODY_HEAD_CHARS = 200
/** 合法房间模式（§3.2）。 */
const MODES = ['admin', 'everyone']
/** 缺省模式：人人可发言（最不意外）。 */
const DEFAULT_MODE = 'everyone'
/** 合法消息类型（§3.2）。 */
const KINDS = ['normal', 'pass', 'notice', 'late', 'steer']
/** 缺省消息类型。 */
const DEFAULT_KIND = 'normal'
/** `relayLimit` = `RELAY_MULTIPLIER × 成员数`（§3.2）。 */
const RELAY_MULTIPLIER = 3
/** `relayLimit` 下限：空房（0 成员）时若取 0，则**任何**转发都非法 —— 那是死配置，故给地板。 */
const RELAY_FLOOR = 3
/** 人类发送者 id（§3.2：`from` 为 sessionId 或 `'user'`）。 */
const USER = 'user'
/** 房间事件类型集合（审计流可枚举）。 */
const EVENTS = [
  'room_created',
  'members_joined',
  'members_left',
  'admin_transferred',
  'relay',
  'relay_result',
]
/** `bodyRef` 的合法形态（防路径穿越：只允许 `bodies/<安全文件名>.txt`）。 */
const BODY_REF_RE = /^bodies\/[A-Za-z0-9._-]+\.txt$/

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 房间域结构化错误。所有失败都走它，**绝不静默**。 */
export class RoomError extends Error {
  /**
   * @param {string} message 人类可读、含定位信息（房间 id / 消息 id / 字段名）
   * @param {string} [code]
   * @param {object} [details]
   */
  constructor(message, code = 'ROOM_ERROR', details) {
    super(message)
    this.name = 'RoomError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

// ── 小工具（风格对齐 board.js / roster.js）──────────────────────────────────

/**
 * 深拷贝 + **JSON 归一**（去掉值为 undefined 的键）。
 * 必须走 JSON 而不是 structuredClone：否则内存态会比磁盘态多出 `{adminId: undefined}`
 * 这类键，导致 `replay()` 重建后的 `get()` 与原值不等（`board.js:94-102` 同类踩坑）。
 */
function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/** 非空字符串字段校验。 */
function requireString(value, field, where) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RoomError(
      `room.${where}：字段 ${field} 缺失或类型错误（要求非空字符串，收到 ${JSON.stringify(value)}）`,
      'ROOM_MISSING_FIELD',
      { field, where },
    )
  }
  return value
}

/** 可选字符串字段校验（空串视为未提供）。 */
function optionalString(value, field, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new RoomError(
      `room.${where}：字段 ${field} 类型错误（要求字符串，收到 ${JSON.stringify(value)}）`,
      'ROOM_BAD_FIELD',
      { field, where },
    )
  }
  const v = value.trim()
  return v === '' ? undefined : v
}

/** 可选数字字段校验（整数）。 */
function optionalInteger(value, field, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RoomError(
      `room.${where}：字段 ${field} 类型错误（要求非负整数，收到 ${JSON.stringify(value)}）`,
      'ROOM_BAD_FIELD',
      { field, where },
    )
  }
  return value
}

/** 字符串数组归一（去空、去重、保序）。 */
function stringList(value, field, where) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new RoomError(
      `room.${where}：字段 ${field} 类型错误（要求字符串数组，收到 ${JSON.stringify(value)}）`,
      'ROOM_BAD_FIELD',
      { field, where },
    )
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new RoomError(
        `room.${where}：字段 ${field} 的元素必须是非空字符串，收到 ${JSON.stringify(item)}`,
        'ROOM_BAD_FIELD',
        { field, where },
      )
    }
    const v = item.trim()
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** 时间参数归一：缺省 now；支持 ms 数字与 Date。 */
function normalizeNow(value, where) {
  if (value === undefined || value === null) return Date.now()
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new RoomError(
    `room.${where}：now 必须是毫秒时间戳或 Date，收到 ${JSON.stringify(value)}`,
    'ROOM_BAD_NOW',
    { where },
  )
}

/** 名字归一键（与 `roster.js` 的 `nameKey` 同口径：trim + NFKC + 小写 ⇒ 大小写不敏感）。 */
function nameKey(name) {
  return String(name ?? '').trim().normalize('NFKC').toLowerCase()
}

/** 房间模式校验。 */
function normalizeMode(value, where = 'createRoom') {
  if (value === undefined || value === null) return DEFAULT_MODE
  if (!MODES.includes(value)) {
    throw new RoomError(
      `room.${where}：mode 必须是 ${MODES.join(' | ')}，收到 ${JSON.stringify(value)}`,
      'ROOM_BAD_MODE',
      { mode: value },
    )
  }
  return value
}

/** 消息类型校验。 */
function normalizeKind(value, where = 'post') {
  if (value === undefined || value === null) return DEFAULT_KIND
  if (!KINDS.includes(value)) {
    throw new RoomError(
      `room.${where}：kind 必须是 ${KINDS.join(' | ')}，收到 ${JSON.stringify(value)}`,
      'ROOM_BAD_KIND',
      { kind: value },
    )
  }
  return value
}

/** `notice` 校验（≤2000，§3.2）。 */
function normalizeNotice(value, where = 'createRoom') {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new RoomError(
      `room.${where}：notice 必须是字符串，收到 ${JSON.stringify(value)}`,
      'ROOM_BAD_FIELD',
      { field: 'notice' },
    )
  }
  if (value.length > MAX_NOTICE) {
    throw new RoomError(
      `room.${where}：notice 超长（${value.length} > ${MAX_NOTICE} 字符上限）——请把长正文落旁路文件，公告只存摘要`,
      'ROOM_NOTICE_TOO_LONG',
      { length: value.length, max: MAX_NOTICE },
    )
  }
  return value
}

/** `meta` 校验：必须是普通对象（否则原样落盘会污染日志结构）。 */
function normalizeMeta(value, where = 'post') {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RoomError(
      `room.${where}：meta 必须是对象，收到 ${JSON.stringify(value)}`,
      'ROOM_BAD_FIELD',
      { field: 'meta' },
    )
  }
  return clone(value)
}

/** `relayLimit` 口径（§3.2：默认 3×成员数；空房取地板，见常量注释）。 */
function relayLimitForMembers(members) {
  const n = Array.isArray(members) ? members.length : 0
  return Math.max(RELAY_FLOOR, RELAY_MULTIPLIER * n)
}

/**
 * 长正文指纹：**长度 + 哈希前缀**（§3.2 硬约束 4）。
 * 它有两个用处：① `readBody()` 读回时校验完整性；② 日志里可自证「这条消息的正文有多长」。
 */
function fingerprint(text) {
  return {
    length: text.length,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12),
  }
}

/**
 * 原子写**纯文本**文件：`<file>.tmp-<pid>-<rand>` → rename（K3：状态/快照类走 rename）。
 * 为什么不用 `store.writeJsonAtomic`：那是 JSON 序列化，会把正文包成带引号的 JSON 串，
 * 旁路文件的口径是**原文**（`bodies/<msgId>.txt` 即原文本身）。
 * @returns {boolean} 是否成功
 */
function writeTextAtomic(file, text) {
  try {
    ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 目录可写性探测（构造期用，**不覆盖任何既有文件**）。 */
function probeWritable(dir) {
  try {
    if (!ensureDir(dir)) return false
    const probe = join(dir, `.write-probe-${process.pid}`)
    writeFileSync(probe, 'ok', 'utf8')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

/**
 * 解析状态目录：`config.stateDir` > `kernel.stateDir()` > 抛错。
 * **不做静默兜底**：两条路都不通时必须让调用方看见（与 `board.js:243-256` 同口径）。
 * @param {{ stateDir?: string }} config
 * @returns {string}
 */
function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') {
    return config.stateDir.trim()
  }
  if (typeof kernel?.stateDir === 'function') return kernel.stateDir()
  throw new RoomError(
    'room.createRoom：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir。'
    + '裸检出（无宿主包）下必须显式传 config.stateDir。',
    'ROOM_NO_STATE_DIR',
  )
}

/**
 * 创建一个房间服务实例。
 *
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx] 宿主上下文
 *        （用于日志 + **透传给 `kernel.followup`** 做投递；缺失即降级为 no-op 日志）
 * @param {{ stateDir?: string, idempotencyMax?: number, name?: string }} [config]
 * @returns {object} rooms
 */
export function createRoom(ctx, config = {}) {
  const stateDir = resolveStateDir(config)
  const roomsDir = statePath(stateDir, 'rooms')
  const indexPath = statePath(roomsDir, 'index.json')

  const info = (...args) => { try { ctx?.logger?.info?.(...args) } catch { /* 日志失败不影响业务 */ } }
  const warn = (...args) => { try { ctx?.logger?.warn?.(...args) } catch { /* 同上 */ } }

  /** @type {Map<string, object>} roomId → Room（创建序 = Map 插入序） */
  const rooms = new Map()
  /** @type {Map<string, object[]>} roomId → RoomMessage[]（按 seq 升序） */
  const messagesByRoom = new Map()
  /** @type {Map<string, object[]>} roomId → 房间事件流（审计流，按落盘顺序） */
  const eventsByRoom = new Map()
  /** @type {Map<string, string>} nameKey(name) → roomId（名字唯一性索引） */
  const nameIndex = new Map()
  /** @type {Map<string, string>} `<roomId>::<dedupKey>` → messageId（幂等取回） */
  const dedupIndex = new Map()
  /** @type {Map<string, number>} `<roomId>::<messageId>` → 已投递次数（relayLimit 记账，回放时从事件流重建） */
  const relayCounts = new Map()
  /** 幂等去重器（store 提供；`replay()` 时从消息日志重建） */
  const idem = new IdempotencySet(
    Number.isFinite(config.idempotencyMax) ? config.idempotencyMax : 10_000,
  )

  const durable = probeWritable(roomsDir)

  const diagnostics = {
    stateDir,
    roomsDir,
    indexPath,
    kernel: kernel ? 'loaded' : 'unavailable',
    hydratedFrom: /** @type {null|'events'|'snapshot'|'empty'} */ (null),
    replayedRooms: 0,
    replayedMessages: 0,
    replayedEvents: 0,
    badLines: 0,
    seqGaps: 0,
    orphanRoomDirs: 0,
    snapshotWriteFailures: 0,
    relayResultAppendFailures: 0,
    lastReplayAt: /** @type {number|undefined} */ (undefined),
  }

  // ── 路径 ──────────────────────────────────────────────────────────────────

  const roomDir = (roomId) => statePath(roomsDir, roomId)
  const eventsPath = (roomId) => statePath(roomDir(roomId), 'events.jsonl')
  const logPath = (roomId) => statePath(roomDir(roomId), 'log.jsonl')

  // ── 内存态小工具 ───────────────────────────────────────────────────────────

  const dedupKeyOf = (roomId, dedupKey) => `${roomId}::${dedupKey}`

  /** 取房间内存态（原始引用，**不要**外传）。 */
  const roomRef = (roomId) => rooms.get(roomId)

  /**
   * relayLimit 记账键。
   *
   * ⚠️ **必须带 roomId**：消息 id 形如 `m-<seq>`，是**房间内**编号 ——
   * 每个房间都有 `m-1`。若只按 messageId 记账，A 房间的转发次数会算到 B 房间头上，
   * 导致 B 房间被凭空判超限（K4 的限额被跨房间泄漏）。这是 review 时实测踩到的缺陷。
   */
  const relayKey = (roomId, messageId) => `${roomId}::${messageId}`

  /** 取房间（抛错版，写操作用）。 */
  function requireRoom(roomId, where) {
    const rid = requireString(roomId, 'roomId', where)
    const room = rooms.get(rid)
    if (!room) {
      throw new RoomError(
        `room.${where}：房间不存在 roomId=${rid}`,
        'ROOM_NOT_FOUND',
        { roomId: rid },
      )
    }
    return room
  }

  /** 取消息（找不到抛错，**不返回 undefined 让调用方踩空**）。 */
  function requireMessage(roomId, messageId, where) {
    const list = messagesByRoom.get(roomId) ?? []
    const found = list.find((m) => m.id === messageId)
    if (!found) {
      throw new RoomError(
        `room.${where}：消息不存在 messageId=${messageId}（房间 ${roomId} 共 ${list.length} 条消息）`,
        'ROOM_MESSAGE_NOT_FOUND',
        { roomId, messageId },
      )
    }
    return found
  }

  /** 可选 CAS 校验（见文件头「CAS 取舍」）。 */
  function assertRev(room, expectedRev, action) {
    if (expectedRev === undefined || expectedRev === null) return
    if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev)) {
      throw new RoomError(
        `room.${action}：expectedRev 必须是整数（CAS 需要显式期望版本，房间 ${room.id} 当前 rev=${room.rev}，`
        + `收到 ${JSON.stringify(expectedRev)}）`,
        'ROOM_MISSING_EXPECTED_REV',
        { roomId: room.id, rev: room.rev },
      )
    }
    if (room.rev !== expectedRev) {
      throw new RoomError(
        `room.${action} CAS 冲突：房间 ${room.id} 期望 rev=${expectedRev}，实际 rev=${room.rev} —— `
        + '拒绝静默覆盖，请重新 get() 后按最新 rev 重试',
        'ROOM_REV_CONFLICT',
        { roomId: room.id, expectedRev, rev: room.rev },
      )
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  /** 索引快照内容（落盘形态）。 */
  const indexSnapshot = () => ({
    version: 1,
    savedAt: Date.now(),
    rooms: [...rooms.values()],
  })

  /** 写索引快照（**原子**；失败只降级 warn —— 事件流已落盘，回放可完整重建）。 */
  function snapshotIndex() {
    if (!durable) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/room] 状态目录不可写（${roomsDir}）——索引快照未落盘`)
      return false
    }
    if (!writeJsonAtomic(indexPath, indexSnapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/room] 索引快照写入失败（${indexPath}）——事件流已落盘，replay() 可完整恢复`)
      return false
    }
    return true
  }

  /** 低层 append（房间事件；失败即抛错，**绝不「只改内存不落盘」**）。 */
  function appendRoomEvent(roomId, event) {
    const file = eventsPath(roomId)
    if (!appendJsonl(file, event)) {
      throw new RoomError(
        `room.${event.type}：事件追加失败（${file}）——拒绝「只改内存不落盘」`,
        'ROOM_APPEND_FAILED',
        { roomId, type: event.type },
      )
    }
    if (!eventsByRoom.has(roomId)) eventsByRoom.set(roomId, [])
    eventsByRoom.get(roomId).push(event)
    return true
  }

  /**
   * 提交一次**房间状态**变更：**先落事件，再改内存，最后写快照**。
   *
   * 顺序不可颠倒：append 失败时内存必须原封不动（否则内存与磁盘分叉，
   * 重启回放后状态凭空回退，属于最恶劣的静默失败）。
   *
   * @param {string} roomId
   * @param {string} type 见 `EVENTS`
   * @param {string|null} byId
   * @param {number} at
   * @param {object|null} before 变更前 Room（新建为 null）
   * @param {object} after 变更后 Room
   * @returns {object} 克隆后的 after
   */
  function commit(roomId, type, byId, at, before, after) {
    const event = {
      type,
      roomId,
      rev: Number.isFinite(after?.rev) ? after.rev : null,
      byId: byId ?? null,
      at,
      before: before ? clone(before) : null,
      after: clone(after),
    }
    appendRoomEvent(roomId, event)
    rooms.set(roomId, clone(after))
    // 名字索引随房间状态一起维护（改名不在本期 API 内，但保持单一维护点）
    if (after?.name) nameIndex.set(nameKey(after.name), roomId)
    snapshotIndex()
    return clone(after)
  }

  // ── 回放 ──────────────────────────────────────────────────────────────────

  /** 扫描磁盘上的房间目录（`room-*`）。 */
  function listRoomDirs() {
    try {
      if (!existsSync(roomsDir)) return []
      return readdirSync(roomsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('room-'))
        .map((d) => d.name)
        .sort()
    } catch {
      return []
    }
  }

  /**
   * 从磁盘重建内存态。
   *
   * 优先级：**房间事件流（真相源）> 索引快照（缓存）> 空**。
   * 消息一律从 `log.jsonl` 重建（消息的真相源只有它，索引里不存消息）。
   * 坏行 / 空洞**不静默丢弃**：计入 diagnostics 并 warn。
   */
  function hydrate() {
    rooms.clear()
    messagesByRoom.clear()
    eventsByRoom.clear()
    nameIndex.clear()
    dedupIndex.clear()
    relayCounts.clear()
    idem.keys.clear()
    diagnostics.replayedRooms = 0
    diagnostics.replayedMessages = 0
    diagnostics.replayedEvents = 0
    diagnostics.badLines = 0
    diagnostics.seqGaps = 0
    diagnostics.orphanRoomDirs = 0

    const snap = readJson(indexPath, null)
    const snapById = new Map()
    if (Array.isArray(snap?.rooms)) {
      for (const raw of snap.rooms) {
        if (raw && typeof raw.id === 'string') snapById.set(raw.id, raw)
      }
    }

    const ids = new Set([...snapById.keys(), ...listRoomDirs()])
    let fromEvents = 0
    let fromSnapshot = 0
    let orphan = 0

    for (const id of ids) {
      const { rows, bad } = readJsonl(eventsPath(id))
      diagnostics.badLines += bad
      if (bad > 0) {
        warn(`[cs-bots/room] ${eventsPath(id)} 有 ${bad} 行无法解析（撕裂写或文件损坏）——已跳过，请核对`)
      }

      let state = null
      for (const ev of rows) {
        if (!ev || typeof ev !== 'object') continue
        if (!eventsByRoom.has(id)) eventsByRoom.set(id, [])
        eventsByRoom.get(id).push(clone(ev))
        if (ev.type === 'relay') {
          // 转发意图事件：relayLimit 的记账基础（先落意图再投递，见 K4 落地说明）
          const n = Array.isArray(ev.targets) ? ev.targets.length : 0
          const key = relayKey(id, ev.messageId)
          relayCounts.set(key, (relayCounts.get(key) ?? 0) + n)
          continue
        }
        if (ev.after && typeof ev.after.id === 'string') state = clone(ev.after)
      }

      if (!state && snapById.has(id)) {
        // 事件流「整段缺失」（不是「回放后为空」）才回落快照 —— 与 board.js:378-400 同口径
        state = clone(snapById.get(id))
        fromSnapshot += 1
      }
      if (!state) {
        orphan += 1
        diagnostics.orphanRoomDirs += 1
        warn(`[cs-bots/room] 目录 ${roomDir(id)} 存在但没有任何可回放的房间事件 —— 已跳过，请核对`)
        continue
      }

      // 字段归一（老数据/手改过的快照也要能安全消费）
      if (!Array.isArray(state.members)) state.members = []
      state.members = [...new Set(state.members.filter((m) => typeof m === 'string' && m !== ''))]
      if (!MODES.includes(state.mode)) state.mode = DEFAULT_MODE
      if (!Number.isFinite(state.relayLimit)) state.relayLimit = relayLimitForMembers(state.members)
      if (!Number.isFinite(state.rev)) state.rev = 1
      rooms.set(id, state)
      if (state.name) nameIndex.set(nameKey(state.name), id)

      // ── 消息（真相源 = log.jsonl）────────────────────────────────────────
      const log = readJsonl(logPath(id))
      diagnostics.badLines += log.bad
      if (log.bad > 0) {
        warn(`[cs-bots/room] ${logPath(id)} 有 ${log.bad} 行无法解析 —— 已跳过，请核对`)
      }
      const msgs = []
      for (const row of log.rows) {
        if (!row || typeof row.id !== 'string') continue
        const m = clone(row)
        if (typeof m.roomId !== 'string') m.roomId = id
        if (!Number.isFinite(m.seq)) m.seq = 0
        if (!KINDS.includes(m.kind)) m.kind = DEFAULT_KIND
        if (typeof m.text !== 'string') m.text = ''
        msgs.push(m)
      }
      msgs.sort((a, b) => a.seq - b.seq)

      // seq 空洞检测（**绝不静默**：断点续传的调用方依赖这个连续性）
      for (let i = 0; i < msgs.length; i += 1) {
        if (msgs[i].seq !== i + 1) {
          diagnostics.seqGaps += 1
          warn(
            `[cs-bots/room] 房间 ${id} 的消息 seq 不连续：第 ${i + 1} 条位置的 seq=${msgs[i].seq}`
            + '（应为 1..N 连续）——已保留原值，未静默重排',
          )
          break
        }
      }

      // `room.seq` 的口径 = 日志里的最大 seq（Truth = 日志；索引快照里的 seq 允许滞后）
      const fileMaxSeq = nextSeq(logPath(id)) - 1
      const lastSeq = msgs.length ? msgs[msgs.length - 1].seq : 0
      if (fileMaxSeq !== lastSeq) {
        warn(
          `[cs-bots/room] 房间 ${id} 日志最大 seq=${fileMaxSeq} 与可解析消息最大 seq=${lastSeq} 不一致`
          + '（存在无法解析/残缺的行）——seq 取下限以确保不回退、不复用',
        )
      }
      state.seq = Math.max(fileMaxSeq, lastSeq, Number.isFinite(state.seq) ? state.seq : 0)

      messagesByRoom.set(id, msgs)
      diagnostics.replayedRooms += 1
      diagnostics.replayedMessages += msgs.length
      if (rows.length > 0) fromEvents += 1

      for (const m of msgs) {
        if (m.dedupKey) {
          const key = dedupKeyOf(id, m.dedupKey)
          dedupIndex.set(key, m.id)
          idem.check(key)
        }
      }
    }

    diagnostics.hydratedFrom = fromEvents > 0 ? 'events' : (fromSnapshot > 0 ? 'snapshot' : 'empty')
    if (orphan > 0) {
      warn(`[cs-bots/room] 回放时有 ${orphan} 个房间目录无可用事件（见上文逐条 warn），未被静默忽略`)
    }
    info(
      `[cs-bots/room] 回放完成：${diagnostics.replayedRooms} 个房间 / `
      + `${diagnostics.replayedMessages} 条消息 / from=${diagnostics.hydratedFrom}`,
    )
  }

  // ── API：房间生命周期 ──────────────────────────────────────────────────────

  /**
   * 建房间。名字**唯一**（trim + NFKC + 小写 归一，大小写不敏感）——重名抛错，不静默覆盖。
   *
   * @param {{ name: string, members?: string[], mode?: 'admin'|'everyone', adminId?: string,
   *           notice?: string, cwd?: string, byId: string, now?: number }} input
   * @returns {object} Room
   * @throws {RoomError} 缺字段 / 重名 / notice 超长 / 非法 mode
   */
  function createRoom_(input = {}) {
    const { name, members, mode, adminId, notice, cwd, byId, now } = input ?? {}
    const displayName = requireString(name, 'name', 'createRoom')
    const creator = requireString(byId, 'byId', 'createRoom')
    const key = nameKey(displayName)
    if (nameIndex.has(key)) {
      const existingId = nameIndex.get(key)
      throw new RoomError(
        `room.createRoom：房间名 ${JSON.stringify(displayName)} 已被占用（大小写/空白归一后冲突）`
        + ` → 现存房间 ${existingId}。房间名必须唯一，拒绝静默重名`,
        'ROOM_NAME_TAKEN',
        { name: displayName, existingId },
      )
    }

    // members **显式传入就原样采信**；缺省才用 [byId]（见文件头「成员语义」）
    const memberList = members === undefined || members === null
      ? [creator]
      : stringList(members, 'members', 'createRoom')
    const m = normalizeMode(mode, 'createRoom')
    const advisory = optionalString(adminId, 'adminId', 'createRoom')
    const noticeValue = normalizeNotice(notice, 'createRoom')
    const cwdValue = optionalString(cwd, 'cwd', 'createRoom')
    const at = normalizeNow(now, 'createRoom')

    const roomId = `room-${randomUUID().slice(0, 8)}`
    if (rooms.has(roomId)) {
      throw new RoomError(
        `room.createRoom：房间 id 冲突 ${roomId}（同一毫秒内重复生成的极小概率）——请重试`,
        'ROOM_ID_COLLISION',
        { roomId },
      )
    }
    if (!ensureDir(statePath(roomDir(roomId), 'bodies'))) {
      throw new RoomError(
        `room.createRoom：房间目录创建失败（${roomDir(roomId)}）——状态目录不可写时拒绝建一个「写不进去」的房间`,
        'ROOM_DIR_CREATE_FAILED',
        { roomId, roomsDir },
      )
    }

    /** @type {Record<string, unknown>} */
    const room = {
      id: roomId,
      name: displayName,
      mode: m,
      members: memberList,
      relayLimit: relayLimitForMembers(memberList),
      seq: 0,
      rev: 1,
      createdAt: at,
      createdBy: creator,
    }
    if (m === 'admin') room.adminId = advisory ?? creator
    else if (advisory) {
      throw new RoomError(
        `room.createRoom：mode=${JSON.stringify(m)} 的房间不接受 adminId=${JSON.stringify(advisory)}`
        + '（adminId 只在 mode:\'admin\' 下有语义）——拒绝写入会被忽略的配置',
        'ROOM_ADMIN_ID_NOT_APPLICABLE',
        { mode: m, adminId: advisory },
      )
    }
    if (noticeValue !== undefined) room.notice = noticeValue
    if (cwdValue !== undefined) room.cwd = cwdValue

    return commit(roomId, 'room_created', creator, at, null, room)
  }

  /** @param {string} roomId @returns {object | undefined} Room（不存在返回 undefined，与 board.get 同口径） */
  function get(roomId) {
    if (typeof roomId !== 'string' || roomId === '') return undefined
    const room = rooms.get(roomId)
    return room ? clone(room) : undefined
  }

  /**
   * 列出全部房间（**创建序**）。
   * @returns {object[]}
   */
  function list() {
    return [...rooms.values()].map(clone)
  }

  /**
   * 加入房间。重复加入**抛错**（不静默成功 —— 否则「谁真的加了」不可审计）。
   *
   * @param {{ roomId: string, sessionId: string, byId?: string, expectedRev?: number, now?: number }} input
   * @returns {object} 变更后的 Room
   * @throws {RoomError} 房间不存在 / 已是成员 / CAS 冲突
   */
  function join(input = {}) {
    const { roomId, sessionId, byId, expectedRev, now } = input ?? {}
    const room = requireRoom(roomId, 'join')
    const sid = requireString(sessionId, 'sessionId', 'join')
    const actor = optionalString(byId, 'byId', 'join') ?? sid
    assertRev(room, expectedRev, 'join')
    if (room.members.includes(sid)) {
      throw new RoomError(
        `room.join：${sid} 已经是房间 ${room.id} 的成员（重复加入被拒 —— 拒绝静默成功导致成员表不可审计）`,
        'ROOM_ALREADY_MEMBER',
        { roomId: room.id, sessionId: sid },
      )
    }

    const at = normalizeNow(now, 'join')
    const before = clone(room)
    const next = clone(room)
    next.members = [...room.members, sid]
    next.relayLimit = relayLimitForMembers(next.members)
    next.rev = room.rev + 1
    // admin 模式的空位补上（管理员退房后房间不该被锁死，见文件头）
    if (next.mode === 'admin' && !next.adminId) next.adminId = sid
    return commit(room.id, 'members_joined', actor, at, before, next)
  }

  /**
   * 离开房间。非成员**抛错**（不静默无操作）。
   *
   * 管理员退房 → 管理权移交给**最早加入的剩余成员**（写 `admin_transferred` 事件）；
   * 房间空则清空 `adminId`。⇒ 不留「管理员已走、房间锁死」的隐形死局。
   *
   * @param {{ roomId: string, sessionId: string, byId?: string, expectedRev?: number, now?: number }} input
   * @returns {object} 变更后的 Room
   * @throws {RoomError} 房间不存在 / 非成员 / CAS 冲突
   */
  function leave(input = {}) {
    const { roomId, sessionId, byId, expectedRev, now } = input ?? {}
    const room = requireRoom(roomId, 'leave')
    const sid = requireString(sessionId, 'sessionId', 'leave')
    const actor = optionalString(byId, 'byId', 'leave') ?? sid
    assertRev(room, expectedRev, 'leave')
    if (!room.members.includes(sid)) {
      throw new RoomError(
        `room.leave：${sid} 不是房间 ${room.id} 的成员（拒绝静默无操作）`,
        'ROOM_NOT_MEMBER',
        { roomId: room.id, sessionId: sid },
      )
    }

    const at = normalizeNow(now, 'leave')
    const before = clone(room)
    const next = clone(room)
    next.members = room.members.filter((m) => m !== sid)
    next.relayLimit = relayLimitForMembers(next.members)
    next.rev = room.rev + 1

    let type = 'members_left'
    if (room.adminId === sid) {
      if (next.members.length > 0) {
        next.adminId = next.members[0]
        type = 'admin_transferred'
        info(`[cs-bots/room] 房间 ${room.id} 管理权移交：${sid} → ${next.adminId}（最早加入的剩余成员）`)
      } else {
        delete next.adminId
      }
    }
    return commit(room.id, type, actor, at, before, next)
  }

  // ── API：消息 ──────────────────────────────────────────────────────────────

  /**
   * 发言权校验。
   *
   * 规则（见文件头「`mode` 的语义」）：`'user'` 永远可发言；其余必须是成员；
   * `mode:'admin'` 时只有 `adminId` 能发言。**任何一条不满足都抛错，不静默接受。**
   */
  function assertCanPost(room, sender) {
    if (sender === USER) return
    if (!room.members.includes(sender)) {
      throw new RoomError(
        `room.post：${sender} 不是房间 ${room.id} 的成员（房间共 ${room.members.length} 名成员）`
        + ' —— 非成员发言被拒，绝不静默接受',
        'ROOM_NOT_MEMBER',
        { roomId: room.id, sessionId: sender, members: room.members },
      )
    }
    if (room.mode === 'admin' && room.adminId && sender !== room.adminId) {
      throw new RoomError(
        `room.post：房间 ${room.id} 是 admin 模式（adminId=${room.adminId}），成员 ${sender} 无发言权`
        + '（成员仍可 join/leave/收转发）',
        'ROOM_POST_FORBIDDEN',
        { roomId: room.id, sessionId: sender, adminId: room.adminId, mode: room.mode },
      )
    }
  }

  /**
   * 发言（**确定性写通路**：域服务直调 → append 落盘，不经 HTTP、不经模型）。
   *
   * - **seq 单调且连续无洞**：由上一条消息的 seq + 1 得到（见不变量 3）。
   * - **长正文旁路**（K2）：`text.length > BODY_THRESHOLD` 时正文写
   *   `bodies/<msgId>.txt`，日志只留头 + 指纹 + `bodyRef`。
   * - **幂等**：`dedupKey` 命中即返回既有消息，**不产生第二条**、不消耗新 seq。
   *
   * @param {{ roomId: string, from: string, text: string, kind?: string, to?: string,
   *           dedupKey?: string, replyTo?: string, meta?: object, now?: number }} input
   * @returns {object} RoomMessage
   * @throws {RoomError} 房间不存在 / 非成员 / 缺字段 / 非法 kind / replyTo 悬空 / 落盘失败
   */
  function post(input = {}) {
    const { roomId, from, text, kind, to, dedupKey, replyTo, meta, now } = input ?? {}
    const room = requireRoom(roomId, 'post')
    const sender = requireString(from, 'from', 'post')
    const body = requireString(text, 'text', 'post')
    const k = normalizeKind(kind, 'post')
    const toId = optionalString(to, 'to', 'post')
    const dk = optionalString(dedupKey, 'dedupKey', 'post')
    const reply = optionalString(replyTo, 'replyTo', 'post')
    const metaObj = normalizeMeta(meta, 'post')

    assertCanPost(room, sender)

    if (reply !== undefined) {
      const exist = (messagesByRoom.get(room.id) ?? []).find((mm) => mm.id === reply)
      if (!exist) {
        throw new RoomError(
          `room.post：replyTo=${JSON.stringify(reply)} 在本房间不存在 —— 拒绝写入永远悬空的引用`
          + '（与 board.js 对 blockedBy 的处理同口径）',
          'ROOM_REPLY_TARGET_NOT_FOUND',
          { roomId: room.id, replyTo: reply },
        )
      }
    }

    // ── 幂等（**全部校验通过后**才判定，避免校验失败污染幂等键）──
    if (dk !== undefined) {
      const key = dedupKeyOf(room.id, dk)
      const existingId = dedupIndex.get(key)
      if (existingId) {
        const hit = (messagesByRoom.get(room.id) ?? []).find((mm) => mm.id === existingId)
        if (hit) {
          idem.check(key)
          info(`[cs-bots/room] post 幂等命中 dedupKey=${dk} → 复用 ${existingId}`)
          return clone(hit)
        }
        // 索引指向的消息不在内存里 → 内部状态不一致，**绝不猜测**，直接暴露
        throw new RoomError(
          `room.post：dedupKey=${dk} 已登记但找不到对应消息 ${existingId}（幂等索引不一致）——拒绝静默新建`,
          'ROOM_IDEMPOTENCY_INDEX_MISSING',
          { roomId: room.id, dedupKey: dk, messageId: existingId },
        )
      }
      if (idem.has(key)) {
        throw new RoomError(
          `room.post：dedupKey=${dk} 已在去重器登记但索引缺失（幂等索引不一致）——拒绝静默新建`,
          'ROOM_IDEMPOTENCY_INDEX_MISSING',
          { roomId: room.id, dedupKey: dk },
        )
      }
    }

    const at = normalizeNow(now, 'post')

    // seq：以**消息日志的末条**为准（内存与磁盘分叉时以日志为准，且可见）
    const msgs = messagesByRoom.get(room.id) ?? []
    const lastSeq = msgs.length ? msgs[msgs.length - 1].seq : 0
    if (Number.isFinite(room.seq) && room.seq !== lastSeq) {
      warn(
        `[cs-bots/room] 房间 ${room.id} 内存 seq=${room.seq} 与末条消息 seq=${lastSeq} 不一致`
        + '——以消息日志为准（seq 不复用）',
      )
      room.seq = lastSeq
    }
    const seq = Math.max(lastSeq, Number.isFinite(room.seq) ? room.seq : 0) + 1
    const messageId = `m-${seq}`

    /** @type {Record<string, unknown>} */
    const message = {
      id: messageId,
      roomId: room.id,
      seq,
      from: sender,
      kind: k,
      text: body,
      at,
    }
    if (toId !== undefined) message.to = toId
    if (reply !== undefined) message.replyTo = reply
    if (metaObj !== undefined) message.meta = metaObj
    if (dk !== undefined) message.dedupKey = dk

    // ── 长正文旁路（K2）：**先写正文，再写日志头** ──────────────────────────
    if (body.length > BODY_THRESHOLD) {
      const ref = `bodies/${messageId}.txt`
      const abs = statePath(roomDir(room.id), ref)
      if (!writeTextAtomic(abs, body)) {
        throw new RoomError(
          `room.post：长正文（${body.length} 字符）落旁路文件失败（${abs}）`
          + ' —— 拒绝「正文丢了却记一条日志」',
          'ROOM_BODY_WRITE_FAILED',
          { roomId: room.id, messageId, bytes: body.length, ref },
        )
      }
      message.bodyRef = ref
      message.fingerprint = fingerprint(body)
      // 日志里的 `text` 只留**头**（§3.2：log 只存头 + 指纹 + bodyRef）
      message.text = body.slice(0, BODY_HEAD_CHARS)
    }

    // ── 落盘（**先落盘，再改内存**：不变量 1）────────────────────────────────
    if (!appendJsonl(logPath(room.id), message)) {
      throw new RoomError(
        `room.post：消息日志追加失败（${logPath(room.id)}）——拒绝「只改内存不落盘」`,
        'ROOM_APPEND_FAILED',
        { roomId: room.id, messageId, seq },
      )
    }

    msgs.push(clone(message))
    messagesByRoom.set(room.id, msgs)
    room.seq = seq
    if (dk !== undefined) {
      const key = dedupKeyOf(room.id, dk)
      dedupIndex.set(key, messageId)
      idem.check(key)
    }
    // 消息不触发索引快照：`log.jsonl` 已是消息的真相源，`room.seq` 由日志在回放时重算
    return clone(message)
  }

  /**
   * 列出消息（**按 seq 升序**）。
   *
   * @param {{ roomId: string, limit?: number, sinceSeq?: number }} input
   *        - `sinceSeq`：只要 `seq > sinceSeq` 的（断点续传用）
   *        - `limit`：取**最新** N 条（不是最早 N 条）；缺省不限（**永不截断**）
   * @returns {object[]}
   * @throws {RoomError} 房间不存在 / 参数非法
   */
  function listMessages(input = {}) {
    const { roomId, limit, sinceSeq } = input ?? {}
    const room = requireRoom(roomId, 'listMessages')
    const since = optionalInteger(sinceSeq, 'sinceSeq', 'listMessages')
    const cap = optionalInteger(limit, 'limit', 'listMessages')

    let rows = messagesByRoom.get(room.id) ?? []
    if (since !== undefined) rows = rows.filter((m) => m.seq > since)
    if (cap !== undefined && cap > 0 && rows.length > cap) rows = rows.slice(-cap)
    return rows.map(clone)
  }

  /**
   * 读长正文**全文**（§3.2）。
   *
   * 无 `bodyRef` 的消息直接返回其 `text`；有 `bodyRef` 的从 `bodies/<msgId>.txt` 读，
   * 并**按指纹校验**完整性（读了残缺内容却不报错 = 静默数据损坏，不允许）。
   *
   * @param {{ roomId: string, messageId: string }} input
   * @returns {string} 全文
   * @throws {RoomError} 房间/消息不存在 / bodyRef 非法 / 正文缺失或损坏
   */
  function readBody(input = {}) {
    const { roomId, messageId } = input ?? {}
    const room = requireRoom(roomId, 'readBody')
    const mid = requireString(messageId, 'messageId', 'readBody')
    const message = requireMessage(room.id, mid, 'readBody')

    if (!message.bodyRef) return message.text
    if (!BODY_REF_RE.test(message.bodyRef)) {
      throw new RoomError(
        `room.readBody：消息 ${mid} 的 bodyRef 形态非法（${JSON.stringify(message.bodyRef)}）`
        + ' —— 拒绝按可疑路径读文件',
        'ROOM_BODY_REF_INVALID',
        { roomId: room.id, messageId: mid, bodyRef: message.bodyRef },
      )
    }

    const abs = statePath(roomDir(room.id), message.bodyRef)
    if (!existsSync(abs)) {
      throw new RoomError(
        `room.readBody：正文文件缺失（${abs}）——拒绝返回残缺内容，请核对旁路文件是否被清理`,
        'ROOM_BODY_MISSING',
        { roomId: room.id, messageId: mid, bodyRef: message.bodyRef },
      )
    }
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch (error) {
      throw new RoomError(
        `room.readBody：正文文件读取失败（${abs}）：${error?.message ?? error}`,
        'ROOM_BODY_MISSING',
        { roomId: room.id, messageId: mid, bodyRef: message.bodyRef },
      )
    }

    const fp = message.fingerprint
    if (fp && Number.isFinite(fp.length) && typeof fp.sha256 === 'string') {
      const actual = fingerprint(text)
      if (actual.length !== fp.length || actual.sha256 !== fp.sha256) {
        throw new RoomError(
          `room.readBody：消息 ${mid} 的正文与指纹不符（期望 length=${fp.length}/sha256=${fp.sha256}，`
          + `实读 length=${actual.length}/sha256=${actual.sha256}）——正文已损坏，拒绝返回可疑内容`,
          'ROOM_BODY_CORRUPT',
          { roomId: room.id, messageId: mid, expected: fp, actual },
        )
      }
    }
    return text
  }

  // ── API：转发（投递）────────────────────────────────────────────────────────

  /**
   * 把一条消息**投递**给指定成员（用 `kernel.followup`，K1：不用 `steer`）。
   *
   * 投递的是**正文全文**（长正文走 `readBody()`），不是日志里的「头」——
   * 这正是 K2 的价值：接收方拿到的是完整内容。
   *
   * 背压（K4）：一条消息累计被投递的次数不得超过 `room.relayLimit`（默认 3×成员数），
   * 超限**抛错**。**先落「转发意图」事件再投递**——「记录了但没投出去」可以重试，
   * 「投出去了但没记录」会让限额在重启后被绕过。
   *
   * @param {{ roomId: string, messageId: string, targets?: string[], byId?: string,
   *           now?: number }} input
   *        `targets` 缺省 = 房间全部成员（**不含发送者自己**）
   * @returns {{ ok: boolean, roomId: string, messageId: string, relayed: number,
   *             attempted: number, limit: number, remaining: number,
   *             reason?: string, deliveries: object[], audit: {written: boolean, reason?: string} }}
   *          `ok:false` + `reason` 表示**有投递失败**（逐条原因在 `deliveries[]` 里）——
   *          **绝不静默**。注意：投递失败**不抛错**（那是运行期事实，不是调用方契约违反）。
   * @throws {RoomError} 房间/消息不存在 / targets 为空 / 目标不是成员 / **超过 relayLimit**
   */
  function relay(input = {}) {
    const { roomId, messageId, targets, byId, now } = input ?? {}
    const room = requireRoom(roomId, 'relay')
    const mid = requireString(messageId, 'messageId', 'relay')
    const message = requireMessage(room.id, mid, 'relay')
    const actor = optionalString(byId, 'byId', 'relay')

    let targetList
    if (targets === undefined || targets === null) {
      targetList = room.members.filter((m) => m !== message.from)
      if (targetList.length === 0) {
        throw new RoomError(
          `room.relay：房间 ${room.id} 除发送者（${message.from}）外没有其他成员，且未显式指定 targets`
          + ' —— 拒绝空转发（静默无操作）',
          'ROOM_NO_TARGETS',
          { roomId: room.id, messageId: mid, from: message.from },
        )
      }
    } else {
      targetList = stringList(targets, 'targets', 'relay')
      if (targetList.length === 0) {
        throw new RoomError(
          `room.relay：targets 是空数组 —— 拒绝空转发（静默无操作），请显式给出目标或省略该字段走缺省`,
          'ROOM_NO_TARGETS',
          { roomId: room.id, messageId: mid },
        )
      }
    }

    for (const t of targetList) {
      if (!room.members.includes(t)) {
        throw new RoomError(
          `room.relay：目标 ${t} 不是房间 ${room.id} 的成员 —— 拒绝向非成员投递`,
          'ROOM_NOT_MEMBER',
          { roomId: room.id, messageId: mid, target: t, members: room.members },
        )
      }
    }

    // ── 背压：relayLimit（K4）──────────────────────────────────────────────
    const rkey = relayKey(room.id, mid)
    const attemptedBefore = relayCounts.get(rkey) ?? 0
    const limit = room.relayLimit
    if (attemptedBefore + targetList.length > limit) {
      throw new RoomError(
        `room.relay：消息 ${mid} 转发超限（已投 ${attemptedBefore} + 本次 ${targetList.length} > `
        + `relayLimit=${limit}=${RELAY_MULTIPLIER}×${room.members.length} 成员）——`
        + '这是防无限转发的硬闸，超出即拒绝',
        'ROOM_RELAY_LIMIT',
        {
          roomId: room.id,
          messageId: mid,
          attempted: attemptedBefore,
          adding: targetList.length,
          limit,
        },
      )
    }

    const at = normalizeNow(now, 'relay')

    // 先落意图（**投递前**）：这样「投出去了但没记录」不可能发生
    appendRoomEvent(room.id, {
      type: 'relay',
      roomId: room.id,
      rev: room.rev,
      byId: actor ?? null,
      at,
      messageId: mid,
      targets: [...targetList],
      attempted: attemptedBefore + targetList.length,
      limit,
    })
    relayCounts.set(rkey, attemptedBefore + targetList.length)

    // 投递：正文全文（K2）
    const fullText = readBody({ roomId: room.id, messageId: mid })
    const payload = relayText(room, message, fullText)
    const deliveries = []
    for (const target of targetList) {
      const attempt = kernel.followup(ctx, target, payload)
      if (attempt?.ok) deliveries.push({ target, ok: true })
      else deliveries.push({ target, ok: false, reason: attempt?.reason ?? 'relay-unknown-failure' })
      if (!attempt?.ok) {
        warn(`[cs-bots/room] 转发 ${mid} → ${target} 失败：${attempt?.reason ?? '未知原因'}（已记录，未静默）`)
      }
    }

    const relayed = deliveries.filter((d) => d.ok).length
    const failed = deliveries.filter((d) => !d.ok)

    // 结果事件（投递已发生，写失败只降级 + 在返回值里可见，**不假装成功**）
    let audit = { written: true }
    try {
      appendRoomEvent(room.id, {
        type: 'relay_result',
        roomId: room.id,
        rev: room.rev,
        byId: actor ?? null,
        at,
        messageId: mid,
        deliveries: clone(deliveries),
      })
    } catch (error) {
      audit = { written: false, reason: `relay-result-append-failed:${error?.message ?? error}` }
      diagnostics.relayResultAppendFailures += 1
      warn(`[cs-bots/room] 转发结果事件写入失败（投递已发生）：${audit.reason}`)
    }

    const result = {
      ok: failed.length === 0,
      roomId: room.id,
      messageId: mid,
      relayed,
      attempted: deliveries.length,
      limit,
      remaining: Math.max(0, limit - (relayCounts.get(rkey) ?? 0)),
      deliveries,
      audit,
    }
    if (failed.length > 0) {
      result.reason = failed
        .map((d) => `${d.target}:${d.reason}`)
        .join('; ')
    }
    return result
  }

  /** 转发载荷模板（**确定性**：同样的房间/消息恒产出同一段文本，便于断言与排障）。 */
  function relayText(room, message, fullText) {
    const to = message.to ? ` → ${message.to}` : ''
    const header = `[cs-bots 房间「${room.name}」 ${room.id}] 消息 ${message.id} (#${message.seq}) `
      + `← ${message.from}${to} [${message.kind}]`
    return `${header}\n${fullText}`
  }

  // ── API：审计与运维 ─────────────────────────────────────────────────────────

  /**
   * 房间事件流查询（审计）。
   * @param {{ roomId?: string }} [input] 省略 roomId 则返回**全部房间**的事件
   * @returns {object[]}
   */
  function history(input = {}) {
    const { roomId } = input ?? {}
    if (roomId === undefined || roomId === null) {
      const all = []
      for (const id of rooms.keys()) all.push(...(eventsByRoom.get(id) ?? []))
      all.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
      return clone(all)
    }
    const room = requireRoom(roomId, 'history')
    return clone(eventsByRoom.get(room.id) ?? [])
  }

  /**
   * 内存中已回放的房间事件总数**实测值**。
   *
   * ⚠️ 不能用 `diagnostics.replayedEvents` 充当它：该计数在 hydrate() 第 1 行就被清零、
   * 之后**不再被写入**，于是 `replay()` 返回的 `events` 恒为 0、
   * `stats().events` 在重启后归零 —— 那是「看着像 0 其实很多」的静默误报。
   * 故这里直接数内存（`eventsByRoom` 是唯一的真相源副本）。
   * @returns {number}
   */
  function eventsInMemory() {
    let n = 0
    for (const rows of eventsByRoom.values()) n += rows.length
    return n
  }

  /**
   * 从磁盘重建内存态（重启回放一致性）。
   * @returns {{ from: string, rooms: number, messages: number, events: number, bad: number, seqGaps: number }}
   */
  function replay() {
    hydrate()
    diagnostics.lastReplayAt = Date.now()
    return {
      from: diagnostics.hydratedFrom ?? 'empty',
      rooms: rooms.size,
      messages: diagnostics.replayedMessages,
      events: eventsInMemory(),
      bad: diagnostics.badLines,
      seqGaps: diagnostics.seqGaps,
    }
  }

  /** 单文件字节数（不存在记 0，**不抛错**——统计用途）。 */
  function fileBytes(file) {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  }

  /**
   * 运行口径统计（排障与验收用；数字**实测**，不估算）。
   * @returns {object}
   */
  function stats() {
    let messages = 0
    let bodies = 0
    let relays = 0
    let relayResults = 0
    let relayDeliveries = 0
    let logBytes = 0
    let bodyBytes = 0

    for (const [id, list] of messagesByRoom.entries()) {
      messages += list.length
      logBytes += fileBytes(logPath(id))
      for (const m of list) {
        if (m.bodyRef) {
          bodies += 1
          bodyBytes += fileBytes(statePath(roomDir(id), m.bodyRef))
        }
      }
    }
    for (const rows of eventsByRoom.values()) {
      for (const ev of rows) {
        if (ev?.type === 'relay') {
          relays += 1
          relayDeliveries += Array.isArray(ev.targets) ? ev.targets.length : 0
        } else if (ev?.type === 'relay_result') relayResults += 1
      }
    }

    let members = 0
    for (const room of rooms.values()) members += room.members.length

    return {
      rooms: rooms.size,
      messages,
      bodies,
      members,
      relays,
      relayResults,
      relayDeliveries,
      events: eventsInMemory(),
      dedupKeys: dedupIndex.size,
      badLines: diagnostics.badLines,
      seqGaps: diagnostics.seqGaps,
      orphanRoomDirs: diagnostics.orphanRoomDirs,
      snapshotWriteFailures: diagnostics.snapshotWriteFailures,
      relayResultAppendFailures: diagnostics.relayResultAppendFailures,
      logBytes,
      bodyBytes,
      durable,
      hydratedFrom: diagnostics.hydratedFrom ?? 'empty',
      lastReplayAt: diagnostics.lastReplayAt ?? null,
    }
  }

  // ── 收尾 ──────────────────────────────────────────────────────────────────

  /** 首次构造即回放，保证 `list()` / `listMessages()` 在重启后马上可用。 */
  hydrate()

  const service = {
    name: config.name ?? 'room',
    paths: Object.freeze({ stateDir, roomsDir, index: indexPath }),
    durable,
    /** §3.2 的工厂方法名（`createRoom_`）；`create` 是等价别名，便于阅读与调用。 */
    createRoom_,
    create: createRoom_,
    get,
    list,
    join,
    leave,
    post,
    relay,
    readBody,
    listMessages,
    replay,
    stats,
    history,
    diagnostics: () => clone(diagnostics),
  }
  return service
}

/** 对外暴露的关键口径（测试与调用方算 relayLimit/阈值时用，避免各处硬编码漂移）。 */
export const ROOM_LIMITS = Object.freeze({
  MAX_NOTICE,
  BODY_THRESHOLD,
  BODY_HEAD_CHARS,
  RELAY_MULTIPLIER,
  RELAY_FLOOR,
})

/** 用户（人类）发送者 id（`from` 允许的特殊值）。 */
export const ROOM_USER = USER

export default createRoom
