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
 * ── 房间配置与超级管理员（DESIGN-v2 特性 ①，2026-11-04）──
 *   `purpose`    用途/话题，缺省 `''`（**不是 undefined**：回放后形状必须与内存态逐字段一致）。
 *   `roles`      `{ sessionId: 'admin'|'member'|'observer' }`，缺省按成员全 `'member'`，
 *                admin 模式的 `adminId` 记 `'admin'`。**roles 只描述、不参与权限判定**
 *                （权限仍只看 `adminId` —— 避免「改个角色就隐式夺权」）。
 *   `settings`   `{ allowBotAutoPost, maxBotsPerRound, relayEnabled }`，缺省见 `DEFAULT_SETTINGS`；
 *                未知键**抛错**（拒绝写入会被静默忽略的配置）。
 *   `archivedAt` 归档时间（软删）。**归档房缺省不出现在 `list()`**，
 *                `list({includeArchived:true})` 才含；`get()` 仍可读（否则归档后无法恢复）。
 *   `withBody`   `listMessages({withBody:true})` 把长正文全文内联进每条 `body`，
 *                避免页面为每条消息再发一次 `/rooms/body` 请求。
 *
 *   **超级管理员 = `USER`（'user'）**：所有新老操作一律放行（DESIGN 权限行）。
 *   非 USER 仍按原规则：
 *     - `update`：admin 模式看 `adminId`、everyone 模式看成员资格（既有行为，未改）；
 *     - `archive/unarchiveRoom`：同上，另加**创建者恒可**——`members` 允许不显式包含创建者
 *       （见上文「成员语义」），不给创建者留门会导致「房间归档后再没人能恢复」；
 *     - `removeRoom`：仅 owner（=`createdBy`）或 USER（硬删不可恢复，权限必须收紧）；
 *     - `setMemberRole/kickMember`：「管理员级」操作 —— USER / 创建者 / admin 模式的管理员；
 *       everyone 模式下的**普通成员一律拒绝**（DESIGN 原文「成员角色（super admin 专用）」）。
 *
 *   CAS 沿用本模块既有的**可选 CAS**（见上文「CAS 取舍」）：新函数签名里 DESIGN 没列
 *   `expectedRev` 的（`setMemberRole`/`kickMember`）也接受它 —— 传了就严格比对，不传不拦。
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

// ── store.appendAudit 软导入（P1-D §4）───────────────────────────────────────
// 软用：拿不到就只 warn 一次 + 计数，绝不阻断主流程，也绝不自己另造审计格式。
// 为什么用动态 `await import` 而不是具名静态 import：store.js 正被另一工程师并行改，
// 静态具名 import 在对方重构掉该导出时会变成**加载期**失败（整个服务起不来）；
// 动态判定只是「审计少一条」，主流程不受影响。顶层 await 一次性判定 ⇒ commit 内同步。
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
/**
 * 人类身份全集 —— 与 `teams.js` 的 `HUMAN_IDS` 对齐（`ui` / `user` / `person`）。
 *
 * **绝不唤醒人**：人是「看页面的人」，不是会话；`kernel.followup` 对着这些 id 必然失败。
 * 实测证据（2026-11-11）：`wakes.jsonl` 里 `room-msg:m-1:ui → failed` ——
 * 缺省广播把 Boss 自己也算成唤醒目标，每次必失败一条。
 */
const HUMAN_IDS = Object.freeze(['ui', 'user', 'person'])

/**
 * **规范用户 id**（2026-11-12 t-40 需求⑤）。
 *
 * Boss：「以后要统一一下名称……人=用户=boss=user=我」。
 * 历史数据里同一个人有三种写法（`ui` 来自页面层、`user` 来自 API 层、`person` 来自早期约定），
 * 于是「这是谁」在每一处都要判三遍，迟早漏一处。
 *
 * 采用**读兼容 + 写统一**，而不是一刀切改写历史：
 *   - 读：`ui`/`person` 一律视为 `user`（`HUMAN_IDS` 仍然认它们，老数据不会失效）；
 *   - 写：新写入一律用 `user`。
 * 这样不破坏历史事件流（append-only，改历史等于伪造），又能让新数据只有一个写法。
 */
const CANONICAL_USER = 'user'

/** 是否为人类身份（`ui`/`user`/`person` 都认 —— 读侧兼容）。 */
function isHumanId(id) {
  return typeof id === 'string' && HUMAN_IDS.includes(id)
}

/** 把任意人类写法归一成规范 id `user`；非人类身份原样返回。 */
function normalizeHumanId(id) {
  return isHumanId(id) ? CANONICAL_USER : id
}
/** 房间事件类型集合（审计流可枚举）。 */
const EVENTS = [
  'room_created',
  'members_joined',
  'members_left',
  'admin_transferred',
  'room_renamed',
  'notice_changed',
  'mode_changed',
  'purpose_changed',
  'settings_changed',
  'room_archived',
  'room_unarchived',
  'room_removed',
  'member_role_changed',
  'member_kicked',
  'relay',
  'relay_result',
]
/** `purpose` 上限：与公告同口径（2000）—— 用途/话题是「一段短说明」，不是正文（正文走旁路）。 */
const MAX_PURPOSE = 2000
/** 合法成员角色（DESIGN-v2 ①）。 */
const MEMBER_ROLES = ['admin', 'member', 'observer']
/**
 * 房间级开关缺省值（DESIGN-v2 ①）。
 * **必须是建房间、update 合并、回放补全三处共用的唯一口径** ——
 * 各写一份常量就会出现「新建房间缺省 true、回放后变成 false」这类分叉。
 */
const DEFAULT_SETTINGS = Object.freeze({
  allowBotAutoPost: true,
  maxBotsPerRound: 3,
  relayEnabled: true,
  // ── 定向唤醒（2026-11-11「唤醒风暴」止血）────────────────────────────────
  // 缺省 **true**：房间消息**只在被 @ 时**才唤醒成员。
  //
  // 为什么缺省要改成「安静」：实测 `wakes.jsonl` 里一条消息产生 3 次唤醒尝试、
  // 3 次全失败（`room-msg:m-1:ui` + 两个 bot 全 failed）—— 缺省广播「除自己外全部成员」
  // 既吵又必然失败（`ui` 根本没有会话可唤醒）。改缺省 = 把最吵、最容易失败的路径关掉；
  // 需要广播的房间显式 `mentionOnly:false` 打开。
  mentionOnly: true,
})
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

/**
 * 从消息里收集「被 @ 的成员 id」（与 `admission.isAddressed` 的 `@id` 解析同口径）。
 *
 * 两条来源（取并集）：
 *   1. `message.mentions` —— 结构化数组，若有则优先
 *   2. `message.text` 里的 `@id` —— 兜底解析（必须是 word-boundary 后的 `@`，避免误伤 `@bot-2` 当 `@bot`）
 *
 * 仅保留 **room.members 里实际存在的** id（非成员被 @ 了也不算唤醒目标）。
 *
 * ⚠️ 注意：`message.from` 即使被 @ 了也不进唤醒名单（自己不唤醒自己）。
 * `HUMAN_IDS`（人类身份）也在 `wakeable()` 里统一过滤，这里不再二次过滤。
 * @param {object} message
 * @param {string[]} members
 * @returns {string[]} 被 @ 的可唤醒成员 id（去重、保序）
 */
function collectMentions(message, members) {
  if (!message || typeof message !== 'object') return []
  const memberSet = new Set(members)
  const out = []
  const seen = new Set()

  // ① 结构化 mentions 数组
  if (Array.isArray(message.mentions)) {
    for (const m of message.mentions) {
      if (typeof m === 'string' && memberSet.has(m) && !seen.has(m)) {
        seen.add(m)
        out.push(m)
      }
    }
  }

  // ② 文本里的 @id（与 admission.js 同口径：`@id` 后必须跟非标识符字符或结尾）
  const text = typeof message.text === 'string' ? message.text : ''
  if (text) {
    for (const m of members) {
      if (seen.has(m)) continue
      const idx = text.indexOf(`@${m}`)
      if (idx >= 0) {
        const after = text.slice(idx + 1 + m.length)
        if (after === '' || !/[A-Za-z0-9_-]/.test(after[0])) {
          seen.add(m)
          out.push(m)
        }
      }
    }
  }
  return out
}

/**
 * 计算「一条房间消息该唤醒谁」—— **唤醒风暴的唯一真相源**。
 *
 * 为什么抽成独立函数（2026-11-12 t-40-B 修复）：
 * 房间有**两条**唤醒路径，过去各写一份目标计算，于是必然漂移：
 *   - `room.relay()`（`POST /rooms/relay`）实现了四档规则；
 *   - `POST /rooms/post`（Bot 用 `bot_room_post`、Boss 用 UI **都走这条**）却是
 *     裸的 `members.filter((m) => m !== skipSelf)` —— 不看 `mentionOnly`、
 *     不排除人类 id。实测 6 个房间全设了 `mentionOnly:true`，**一次都没生效**；
 *     8 成员房间 ⇒ 一条消息 8 次模型调用，其中打给人类 id 的必然失败。
 *
 * 所以这里只留**一份**规则，两个调用点都用它。改规则只改这里。
 *
 * 四档，**顺序即优先级**（与 relay 原注释一致）：
 *   ① 显式 targets → 原样采信（剔除人类，并 warn：那是调用方的错）
 *   ② mentionOnly=true 且 @ 了某人 → 只打给被 @ 的成员（不含发送者/人类）
 *   ③ mentionOnly=true 但没 @ → **空**（只落消息不唤醒，合法结果，不是错误）
 *   ④ mentionOnly=false（显式关掉定向）→ 除发送者外的全部成员，**仍排除人类**
 *
 * @param {{ members?: string[], settings?: object, from?: string }} room 房间快照
 * @param {{ from?: string, text?: string, mentions?: string[] }} message 消息
 * @param {{ targets?: unknown, warn?: (m: string) => void }} [options]
 *        显式目标（仅 relay 用）；`warn` 注入调用方所在作用域的日志器
 *        （工厂内部有 `warn`，模块顶层没有 —— 这里显式注入，不靠隐式作用域）
 * @returns {{ targets: string[], source: 'explicit'|'mention'|'mention-only-no-target'|'broadcast' }}
 */
function computeWakeTargets(room, message, options = {}) {
  const members = Array.isArray(room?.members) ? room.members : []
  const settings = room?.settings ?? DEFAULT_SETTINGS
  const mentionOnly = settings.mentionOnly !== false
  // 发送者自己永远不唤醒（发消息的人不需要被自己的消息叫醒）
  const sender = message?.from ?? room?.from
  /** 唤醒排除表：人类一律不算唤醒目标（人没有会话，唤醒必然 agent-not-live）。 */
  const wakeable = (id) => id !== sender && !isHumanId(id)

  if (options?.targets !== undefined && options?.targets !== null) {
    let list = stringList(options.targets, 'targets', 'relay')
    const humans = list.filter((t) => isHumanId(t))
    if (humans.length > 0) {
      const say = typeof options.warn === 'function' ? options.warn : () => {}
      say(`[cs-bots/room] 显式 targets 含人类身份 ${humans.join(',')} —— 已剔除（人不可被唤醒）`)
      list = list.filter((t) => !isHumanId(t))
    }
    return { targets: list, source: 'explicit' }
  }

  if (mentionOnly) {
    const mentioned = collectMentions(message, members)
    const targets = mentioned.filter(wakeable)
    return targets.length > 0
      ? { targets, source: 'mention' }
      : { targets: [], source: 'mention-only-no-target' }
  }

  // ④ 显式关掉定向才广播 —— 即便如此也不唤醒人类、不唤醒发送者自己
  return { targets: members.filter(wakeable), source: 'broadcast' }
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

/**
 * `purpose` 校验（DESIGN-v2 ①，≤2000）。
 *
 * 与 `optionalString` 的区别：**空串是合法值**（表示「清空用途」），
 * 所以不能把 `''` 归成「未提供」；但纯空白仍归一成 `''`（避免不可见的伪内容）。
 */
function normalizePurpose(value, where = 'createRoom') {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new RoomError(
      `room.${where}：purpose 必须是字符串，收到 ${JSON.stringify(value)}`,
      'ROOM_BAD_FIELD',
      { field: 'purpose', where },
    )
  }
  if (value.length > MAX_PURPOSE) {
    throw new RoomError(
      `room.${where}：purpose 超长（${value.length} > ${MAX_PURPOSE} 字符上限）——用途/话题只写一段短说明`,
      'ROOM_PURPOSE_TOO_LONG',
      { length: value.length, max: MAX_PURPOSE },
    )
  }
  return value.trim()
}

/** `settings` 单个开关校验（按键分派；未知键抛错 —— 拒绝写入「怎么写都不会生效」的配置）。 */
function normalizeSettingValue(key, value, where) {
  if (key === 'allowBotAutoPost' || key === 'relayEnabled' || key === 'mentionOnly') {
    if (typeof value !== 'boolean') {
      throw new RoomError(
        `room.${where}：settings.${key} 必须是布尔值，收到 ${JSON.stringify(value)}`,
        'ROOM_BAD_SETTING',
        { field: `settings.${key}`, where },
      )
    }
    return value
  }
  if (key === 'maxBotsPerRound') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new RoomError(
        `room.${where}：settings.maxBotsPerRound 必须是非负整数，收到 ${JSON.stringify(value)}`,
        'ROOM_BAD_SETTING',
        { field: 'settings.maxBotsPerRound', where },
      )
    }
    return value
  }
  throw new RoomError(
    `room.${where}：未知设置项 ${JSON.stringify(key)}（支持 ${Object.keys(DEFAULT_SETTINGS).join(' / ')}）`
    + ' —— 拒绝写入会被静默忽略的配置',
    'ROOM_BAD_SETTING',
    { field: `settings.${key}`, where },
  )
}

/**
 * `settings` 入参校验（**增量**：只校验调用方显式给出的键）。
 * @returns {object|undefined} 校验后的增量；`undefined` 表示未提供
 */
function normalizeSettingsPatch(value, where = 'createRoom') {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RoomError(
      `room.${where}：settings 必须是对象，收到 ${JSON.stringify(value)}`,
      'ROOM_BAD_FIELD',
      { field: 'settings', where },
    )
  }
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    out[key] = normalizeSettingValue(key, raw, where)
  }
  return out
}

/**
 * 回放用的 `settings` **宽松补全**：缺省键补齐、非法值忽略。
 *
 * 为什么回放不能像入参那样抛错：磁盘上的老数据/手改快照是**既成事实**，
 * 回放期抛错会让整个房间甚至整个服务起不来（一个坏字段炸掉全部房间）。
 * 非法值不被静默采信（回落到缺省），并在 `diagnostics` 层面可由 `get()` 侧看出差异。
 * @returns {{ allowBotAutoPost: boolean, maxBotsPerRound: number, relayEnabled: boolean }}
 */
function settingsFromState(value) {
  const out = { ...DEFAULT_SETTINGS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = value[key]
    if (key === 'maxBotsPerRound') {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[key] = v
    } else if (typeof v === 'boolean') {
      out[key] = v
    }
  }
  return out
}

/**
 * 成员的初始角色表（建房间用）。
 * admin 模式的 `adminId` 记 `'admin'`；其余成员 `'member'`。
 * **注意**：`adminId` 允许不是成员（既有 `createRoom` 行为），此时它不出现在 roles 里。
 */
function initialRoles(members, adminId) {
  const roles = {}
  for (const m of members) roles[m] = m === adminId ? 'admin' : 'member'
  return roles
}

/** 角色值校验（DESIGN-v2 ①）。 */
function normalizeMemberRole(value, where = 'setMemberRole') {
  if (!MEMBER_ROLES.includes(value)) {
    throw new RoomError(
      `room.${where}：role 必须是 ${MEMBER_ROLES.join(' | ')}，收到 ${JSON.stringify(value)}`,
      'ROOM_BAD_ROLE',
      { role: value, allowed: [...MEMBER_ROLES] },
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
    auditWriteFailures: 0,
    auditWarnedOnce: false,
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

  /**
   * 「管理类」操作权限（归档 / 恢复）：USER 超级管理员恒放行；
   * 非 USER 按原规则 —— admin 模式看 `adminId`，everyone 模式看成员资格；
   * **另加创建者**：`members` 语义允许创建者不在成员表里，不给创建者留门
   * 会导致「房间归档后再没人能恢复」（DESIGN 权限行的必要补丁，已写进文件头）。
   */
  function assertManage(room, actor, action) {
    if (actor === USER) return
    if (room.createdBy === actor) return
    if (room.mode === 'admin') {
      if (room.adminId === actor) return
      throw new RoomError(
        `room.${action}：房间 ${room.id} 是 admin 模式，只有管理员（${room.adminId ?? '未设置'}）`
        + `或创建者（${room.createdBy}）能执行该操作，调用者为 ${actor}`,
        'ROOM_FORBIDDEN',
        { roomId: room.id, adminId: room.adminId ?? null, createdBy: room.createdBy, actor },
      )
    }
    if (room.members.includes(actor)) return
    throw new RoomError(
      `room.${action}：${actor} 不是房间 ${room.id} 的成员（everyone 模式按成员资格判定）——无权操作`,
      'ROOM_NOT_MEMBER',
      { roomId: room.id, actor, members: room.members },
    )
  }

  /**
   * 「管理员级」操作权限（改成员角色 / 踢人）。
   * DESIGN 对这两项标注「super admin 专用」，故 everyone 模式下的**普通成员一律拒绝**；
   * 非 USER 的合法操作者只有：房间创建者、admin 模式的 `adminId`。
   */
  function assertAdminPrivilege(room, actor, action) {
    if (actor === USER) return
    if (room.createdBy === actor) return
    if (room.mode === 'admin' && room.adminId === actor) return
    throw new RoomError(
      `room.${action}：${actor} 无权执行管理员操作（需要超级管理员 ${JSON.stringify(USER)}、`
      + `房间创建者 ${room.createdBy}${room.mode === 'admin' ? ` 或管理员 ${room.adminId ?? '未设置'}` : ''}）`
      + ' —— 成员角色/踢人属管理员级操作，普通成员被拒',
      'ROOM_FORBIDDEN',
      { roomId: room.id, actor, createdBy: room.createdBy, adminId: room.adminId ?? null, mode: room.mode },
    )
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
    // 名字索引随房间状态一起维护（改名/归档都走这里 —— 保持单一维护点，避免索引漂移）
    if (after?.name) nameIndex.set(nameKey(after.name), roomId)
    snapshotIndex()
    // ── 审计接线（P1-D §4）────────────────────────────────────────────────
    // 软用 store.appendAudit：拿不到/写失败 → 只 warn 一次 + 计数，绝不阻断主流程。
    if (storeAuditMissing) {
      diagnostics.auditWriteFailures += 1
      if (!diagnostics.auditWarnedOnce) {
        diagnostics.auditWarnedOnce = true
        warn('[cs-bots/room] store.appendAudit 尚不可用 → 审计接线跳过；主流程不受影响')
      }
    } else {
      try {
        const digest = (r) => (r
          ? { id: r.id, name: r.name ?? null, rev: r.rev, mode: r.mode ?? null, members: Array.isArray(r.members) ? r.members.length : 0 }
          : null)
        const result = storeAppendAudit(stateDir, {
          ts: at, actor: byId, action: type, target: roomId, before: digest(before), after: digest(after),
        })
        const failed = result === false || Boolean(result && typeof result === 'object' && result.ok === false)
        if (failed) {
          diagnostics.auditWriteFailures += 1
          if (!diagnostics.auditWarnedOnce) {
            diagnostics.auditWarnedOnce = true
            warn('[cs-bots/room] store.appendAudit 返回失败——主流程不受影响')
          }
        }
      } catch (error) {
        diagnostics.auditWriteFailures += 1
        if (!diagnostics.auditWarnedOnce) {
          diagnostics.auditWarnedOnce = true
          warn(`[cs-bots/room] store.appendAudit 抛错：${error?.message ?? error}——主流程不受影响`)
        }
      }
    }
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

      // ── DESIGN-v2 ① 新字段归一（老数据/手改过的快照也要能安全消费）────────────
      // 目的：让「内存态形状 == 回放后形状」逐字段成立（既有 replay 测试就靠这条）。
      if (typeof state.purpose !== 'string') state.purpose = ''
      if (!state.roles || typeof state.roles !== 'object' || Array.isArray(state.roles)) {
        state.roles = {}
      } else {
        // 非法角色值不采信，回落到 'member'；键保留（键存在说明该 session 曾登记为成员角色，
        // 删键会静默丢掉「这里原本有个人」这一事实，回放期只纠正值、不删证据）
        for (const [sid, role] of Object.entries(state.roles)) {
          if (!MEMBER_ROLES.includes(role)) state.roles[sid] = 'member'
        }
      }
      state.settings = settingsFromState(state.settings)
      if (state.archivedAt !== null && !Number.isFinite(state.archivedAt)) state.archivedAt = null
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
    const { name, members, mode, adminId, notice, cwd, purpose, settings, byId, now } = input ?? {}
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
    const purposeValue = normalizePurpose(purpose, 'createRoom')
    const settingsPatch = normalizeSettingsPatch(settings, 'createRoom')
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
    // DESIGN-v2 ① 新字段：**建房间时就把缺省值写进模型**（而不是读到 undefined 时临时兜底）——
    // 这样事件流/快照里的形状与内存态一致，回放后逐字段相等才是可验证的。
    room.purpose = purposeValue ?? ''
    room.roles = initialRoles(room.members, room.adminId)
    room.settings = { ...DEFAULT_SETTINGS, ...(settingsPatch ?? {}) }
    room.archivedAt = null

    return commit(roomId, 'room_created', creator, at, null, room)
  }

  /** @param {string} roomId @returns {object | undefined} Room（不存在返回 undefined，与 board.get 同口径） */
  function get(roomId) {
    if (typeof roomId !== 'string' || roomId === '') return undefined
    const room = rooms.get(roomId)
    return room ? clone(room) : undefined
  }

  /**
   * 列出房间（**创建序**）。
   *
   * DESIGN-v2 ①：归档房（`archivedAt` 非 null）**缺省不出现**；
   * 需要看归档区时传 `{includeArchived:true}`。`get()` 不受影响（归档房仍可读、可恢复）。
   *
   * @param {{ includeArchived?: boolean }} [options]
   * @returns {object[]}
   * @throws {RoomError} includeArchived 类型非法
   */
  function list(options = {}) {
    const { includeArchived } = options ?? {}
    if (includeArchived !== undefined && typeof includeArchived !== 'boolean') {
      throw new RoomError(
        `room.list：includeArchived 必须是布尔值，收到 ${JSON.stringify(includeArchived)}`,
        'ROOM_BAD_FIELD',
        { field: 'includeArchived' },
      )
    }
    const rows = [...rooms.values()]
    const visible = includeArchived === true ? rows : rows.filter((r) => (r.archivedAt ?? null) === null)
    return visible.map(clone)
  }

  /**
   * 加入房间。重复加入**抛错**（不静默成功 —— 否则「谁真的加了」不可审计）。
   *
   * @param {{ roomId: string, sessionId: string, byId?: string, expectedRev?: number, now?: number }} input
   * @returns {object} 变更后的 Room
   * @throws {RoomError} 房间不存在 / 已是成员 / CAS 冲突
   */
  /**
   * 改房间设置（改名 / 公告 / 模式 / 管理员 / 用途 / 房间开关）。
   *
   * 为什么要这个：原来只能建房间、不能改，建错名字只能废弃重来。
   * 权限：`admin` 模式下仅管理员可改；`everyone` 模式下任一成员可改。
   *
   * DESIGN-v2 ① 扩展：新增 `purpose`（用途/话题，空串=清空）与 `settings`（**增量**合并）。
   * `settings` 的未知键/类型错误一律抛错 —— 拒绝「写了但永远不会生效」的配置。
   *
   * @param {{ roomId: string, name?: string, notice?: string, mode?: string, adminId?: string,
   *           purpose?: string, settings?: object,
   *           expectedRev?: number, byId: string, now?: number }} input
   * @returns {object} 变更后的 Room（有变化时多带 `changed` 字段；无变化时原样返回）
   * @throws {RoomError} 房间不存在 / 非成员 / 无权限 / 重名 / CAS 冲突 / 字段非法
   */
  function update(input = {}) {
    const { roomId, name, notice, mode, adminId, purpose, settings, expectedRev, byId, now } = input ?? {}
    const room = requireRoom(roomId, 'update')
    const actor = requireString(byId, 'byId', 'update')
    assertRev(room, expectedRev, 'update')
    if (room.mode === 'admin' && room.adminId && actor !== room.adminId && actor !== USER) {
      throw new RoomError(
        `room.update：房间 ${room.id} 是 admin 模式，只有管理员（${room.adminId}）能改设置，调用者为 ${actor}`,
        'ROOM_FORBIDDEN',
        { roomId: room.id, adminId: room.adminId, actor },
      )
    }
    // ⚠️ 修复（2026-11-04 测试，P1-5）：原实现只在 admin 模式校验管理员，
    //   mode='everyone' 时**完全不校验调用者是否成员** ⇒ 任意人可改房间名/公告
    //   （实测 `byId:'attacker-not-a-member'` 改名成功）。现在与 post() 口径一致：
    //   非 USER 的调用者必须是房间成员。
    if (actor !== USER && !room.members.includes(actor)) {
      throw new RoomError(
        `room.update：${actor} 不是房间 ${room.id} 的成员 —— 无权修改房间设置`,
        'ROOM_NOT_MEMBER',
        { roomId: room.id, actor, members: room.members },
      )
    }

    const at = normalizeNow(now, 'update')
    const before = clone(room)
    const next = clone(room)
    const changed = []

    if (name !== undefined && name !== null) {
      const displayName = requireString(name, 'name', 'update')
      const key = nameKey(displayName)
      if (key !== nameKey(room.name)) {
        if (nameIndex.has(key)) {
          const existingId = nameIndex.get(key)
          throw new RoomError(
            `room.update：房间名 ${JSON.stringify(displayName)} 已被占用（归一后冲突）→ 现存房间 ${existingId}`,
            'ROOM_NAME_TAKEN',
            { name: displayName, existingId },
          )
        }
        // 释放旧名索引
        if (nameIndex.get(nameKey(room.name)) === room.id) nameIndex.delete(nameKey(room.name))
        next.name = displayName
        changed.push('name')
      }
    }

    if (notice !== undefined) {
      next.notice = normalizeNotice(notice)
      changed.push('notice')
    }

    if (mode !== undefined && mode !== null) {
      const m = normalizeMode(mode, 'update')
      if (m !== room.mode) {
        next.mode = m
        // admin 模式但没有管理员 → 由操作者接管（不留「有模式无管理员」的死局）
        if (m === 'admin' && !next.adminId) {
          next.adminId = actor
          // 角色表跟着描述实际管理员（roles 不参与权限判定，只为人看）
          next.roles = { ...(next.roles ?? {}), [actor]: 'admin' }
        }
        if (m === 'everyone') delete next.adminId
        changed.push('mode')
      }
    }

    if (adminId !== undefined) {
      const target = optionalString(adminId, 'adminId', 'update')
      if (target === undefined || target === '') {
        delete next.adminId
        changed.push('adminId')
      } else {
        if (!next.members.includes(target)) {
          throw new RoomError(
            `room.update：管理员必须是房间成员，${target} 不在 ${room.id} 的成员表里`,
            'ROOM_NOT_MEMBER',
            { roomId: room.id, sessionId: target },
          )
        }
        next.adminId = target
        // 管理员变更同步到角色表（roles 只是描述，但描述与实际管理员不一致会误导 UI）
        next.roles = { ...(next.roles ?? {}), [target]: 'admin' }
        changed.push('adminId')
      }
    }

    if (purpose !== undefined) {
      // 空串是合法值（清空用途）→ 不能走「空串视为未提供」的 optionalString
      const value = normalizePurpose(purpose, 'update')
      if (value !== (room.purpose ?? '')) {
        next.purpose = value
        changed.push('purpose')
      }
    }

    if (settings !== undefined) {
      const patch = normalizeSettingsPatch(settings, 'update')
      const merged = { ...(room.settings ?? DEFAULT_SETTINGS), ...patch }
      if (Object.keys(patch).some((k) => merged[k] !== (room.settings ?? DEFAULT_SETTINGS)[k])) {
        next.settings = merged
        changed.push('settings')
      }
    }

    if (changed.length === 0) {
      // 没有任何变化 → 不写事件（避免污染审计流）
      return clone(room)
    }

    next.rev = room.rev + 1
    // 事件类型只作审计标签：多字段同时变更时按固定优先级取一个（before/after 里是完整快照）。
    // 顺序与改造前保持一致（name > notice > mode > adminId），新字段接在后面。
    const type = changed.includes('name')
      ? 'room_renamed'
      : changed.includes('notice')
        ? 'notice_changed'
        : changed.includes('mode')
          ? 'mode_changed'
          : changed.includes('adminId')
            ? 'admin_transferred'
            : changed.includes('purpose')
              ? 'purpose_changed'
              : 'settings_changed'
    const committed = commit(room.id, type, actor, at, before, next)
    return { ...committed, changed }
  }

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
    // 角色表只描述成员：退房后残留的角色条目会误导 UI（回放看老数据也一样）
    if (next.roles && Object.prototype.hasOwnProperty.call(next.roles, sid)) delete next.roles[sid]
    next.rev = room.rev + 1

    let type = 'members_left'
    if (room.adminId === sid) {
      if (next.members.length > 0) {
        next.adminId = next.members[0]
        // 角色表跟着实际管理员走（描述性字段，但「管理员」标签必须真）
        next.roles = { ...(next.roles ?? {}), [next.members[0]]: 'admin' }
        type = 'admin_transferred'
        info(`[cs-bots/room] 房间 ${room.id} 管理权移交：${sid} → ${next.adminId}（最早加入的剩余成员）`)
      } else {
        delete next.adminId
      }
    }
    return commit(room.id, type, actor, at, before, next)
  }

  // ── API：房间归档 / 硬删（DESIGN-v2 ①）──────────────────────────────────────

  /**
   * 归档房间（**软删**）：只打 `archivedAt` 时间戳，消息与事件**一条不删**。
   *
   * DESIGN：归档房缺省不出现在 `list()`；`get()` 仍可读（否则归档后无法恢复）。
   * 重复归档**抛错**（不静默成功 —— 否则归档时间会被悄悄改写，审计不可信）。
   *
   * @param {{ roomId: string, expectedRev?: number, byId: string, now?: number }} input
   * @returns {object} 变更后的 Room（archivedAt=now）
   * @throws {RoomError} 房间不存在 / 无权限 / 已归档 / CAS 冲突
   */
  function archiveRoom(input = {}) {
    const { roomId, expectedRev, byId, now } = input ?? {}
    const room = requireRoom(roomId, 'archiveRoom')
    const actor = requireString(byId, 'byId', 'archiveRoom')
    assertRev(room, expectedRev, 'archiveRoom')
    assertManage(room, actor, 'archiveRoom')
    if (room.archivedAt !== null && room.archivedAt !== undefined) {
      throw new RoomError(
        `room.archiveRoom：房间 ${room.id} 已归档（archivedAt=${room.archivedAt}）——拒绝静默重复归档`,
        'ROOM_ALREADY_ARCHIVED',
        { roomId: room.id, archivedAt: room.archivedAt },
      )
    }
    const at = normalizeNow(now, 'archiveRoom')
    const before = clone(room)
    const next = clone(room)
    next.archivedAt = at
    next.rev = room.rev + 1
    return commit(room.id, 'room_archived', actor, at, before, next)
  }

  /**
   * 恢复归档房间（`archivedAt=null`）。未归档的房间**抛错**（不静默无操作）。
   *
   * @param {{ roomId: string, expectedRev?: number, byId: string, now?: number }} input
   * @returns {object} 变更后的 Room（archivedAt=null）
   * @throws {RoomError} 房间不存在 / 无权限 / 未归档 / CAS 冲突
   */
  function unarchiveRoom(input = {}) {
    const { roomId, expectedRev, byId, now } = input ?? {}
    const room = requireRoom(roomId, 'unarchiveRoom')
    const actor = requireString(byId, 'byId', 'unarchiveRoom')
    assertRev(room, expectedRev, 'unarchiveRoom')
    assertManage(room, actor, 'unarchiveRoom')
    if (room.archivedAt === null || room.archivedAt === undefined) {
      throw new RoomError(
        `room.unarchiveRoom：房间 ${room.id} 未归档（archivedAt=null）——拒绝静默无操作`,
        'ROOM_NOT_ARCHIVED',
        { roomId: room.id },
      )
    }
    const at = normalizeNow(now, 'unarchiveRoom')
    const before = clone(room)
    const next = clone(room)
    next.archivedAt = null
    next.rev = room.rev + 1
    return commit(room.id, 'room_unarchived', actor, at, before, next)
  }

  /**
   * 硬删除房间（**不可恢复**）：删目录（事件流 + 消息日志 + 旁路正文）并从内存/索引摘除。
   *
   * 闸门（DESIGN）：「仅 owner 且 force，或无消息」：
   *   - 权限：`USER` 或房间创建者（owner）——硬删不可恢复，不放开给普通成员；
   *   - 有消息时必须显式 `force:true`（防误删整段讨论）。
   *
   * 顺序：**先落「删除意图」事件 → 再删目录 → 最后改内存**。
   * 若 `rmSync` 失败：抛 `ROOM_DELETE_FAILED`，内存与索引**保持原样**（房间还在，可重试）；
   * 那条 `room_removed` 事件没有 `after`，回放时不会把房间状态改掉（最多留一条痕迹）。
   *
   * @param {{ roomId: string, expectedRev?: number, byId: string, force?: boolean, now?: number }} input
   * @returns {{ removed: string, messages: number }}
   * @throws {RoomError} 房间不存在 / 无权限 / 有消息且未 force / 删除失败 / CAS 冲突
   */
  function removeRoom(input = {}) {
    const { roomId, expectedRev, byId, force, now } = input ?? {}
    const room = requireRoom(roomId, 'removeRoom')
    const actor = requireString(byId, 'byId', 'removeRoom')
    assertRev(room, expectedRev, 'removeRoom')
    if (force !== undefined && typeof force !== 'boolean') {
      throw new RoomError(
        `room.removeRoom：force 必须是布尔值，收到 ${JSON.stringify(force)}`,
        'ROOM_BAD_FIELD',
        { field: 'force' },
      )
    }
    const owned = actor === USER || room.createdBy === actor
    if (!owned) {
      throw new RoomError(
        `room.removeRoom：只有超级管理员 ${JSON.stringify(USER)} 或房间创建者（${room.createdBy}）`
        + `能硬删房间 ${room.id}，调用者为 ${actor} —— 硬删不可恢复，权限必须收紧`,
        'ROOM_FORBIDDEN',
        { roomId: room.id, actor, createdBy: room.createdBy },
      )
    }
    const messages = messagesByRoom.get(room.id) ?? []
    if (messages.length > 0 && force !== true) {
      throw new RoomError(
        `room.removeRoom：房间 ${room.id} 有 ${messages.length} 条消息，硬删必须显式 force:true`
        + '（消息日志 append-only 且无回收站，删了就没了）',
        'ROOM_NOT_EMPTY',
        { roomId: room.id, messages: messages.length },
      )
    }

    const at = normalizeNow(now, 'removeRoom')
    // 先落意图：删除失败时内存保持原样，但这次尝试在事件流里可见（不静默）
    appendRoomEvent(room.id, {
      type: 'room_removed',
      roomId: room.id,
      rev: room.rev,
      byId: actor,
      at,
      messages: messages.length,
      force: force === true,
    })

    try {
      rmSync(roomDir(room.id), { recursive: true, force: false })
    } catch (error) {
      throw new RoomError(
        `room.removeRoom：房间目录删除失败（${roomDir(room.id)}）：${error?.message ?? error}`
        + ' —— 内存与索引保持不变，请核对文件权限后重试',
        'ROOM_DELETE_FAILED',
        { roomId: room.id, dir: roomDir(room.id) },
      )
    }

    // 目录已删 → 内存/索引同步摘除（内存清理**不可能失败**，放在落盘之后）
    const messageCount = messages.length
    rooms.delete(room.id)
    messagesByRoom.delete(room.id)
    eventsByRoom.delete(room.id)
    if (room.name && nameIndex.get(nameKey(room.name)) === room.id) nameIndex.delete(nameKey(room.name))
    for (const key of [...dedupIndex.keys()]) {
      if (key.startsWith(`${room.id}::`)) dedupIndex.delete(key)
    }
    for (const key of [...relayCounts.keys()]) {
      if (key.startsWith(`${room.id}::`)) relayCounts.delete(key)
    }
    for (const key of [...idem.keys]) {
      if (key.startsWith(`${room.id}::`)) idem.keys.delete(key)
    }
    snapshotIndex()
    info(`[cs-bots/room] 房间 ${room.id} 已硬删（${messageCount} 条消息随之删除，审计事件在删除前落盘）`)
    return { removed: room.id, messages: messageCount }
  }

  // ── API：成员角色 / 踢人（DESIGN-v2 ①）──────────────────────────────────────

  /**
   * 设置成员角色（`'admin'|'member'|'observer'`）。
   *
   * **roles 只描述、不参与权限判定**（权限仍只看 `adminId`）——见文件头说明。
   * 目标必须是房间成员；`USER` 不可被改角色；无变化不写事件（与 `update` 同口径）。
   *
   * @param {{ roomId: string, sessionId: string, role: string, byId: string,
   *           expectedRev?: number, now?: number }} input
   * @returns {object} 变更后的 Room
   * @throws {RoomError} 房间/成员不存在 / 无权限 / 非法角色 / 改 USER 角色 / CAS 冲突
   */
  function setMemberRole(input = {}) {
    const { roomId, sessionId, role, expectedRev, byId, now } = input ?? {}
    const room = requireRoom(roomId, 'setMemberRole')
    const actor = requireString(byId, 'byId', 'setMemberRole')
    const sid = requireString(sessionId, 'sessionId', 'setMemberRole')
    // DESIGN 的签名没列 expectedRev，但传了就严格比（可选 CAS，与全模块同口径）
    assertRev(room, expectedRev, 'setMemberRole')
    assertAdminPrivilege(room, actor, 'setMemberRole')
    if (sid === USER) {
      throw new RoomError(
        `room.setMemberRole：不能修改超级管理员（${JSON.stringify(USER)}）的角色 —— 人类入口不可被降权`,
        'ROOM_CANNOT_MODIFY_USER',
        { roomId: room.id, sessionId: sid },
      )
    }
    if (!room.members.includes(sid)) {
      throw new RoomError(
        `room.setMemberRole：${sid} 不是房间 ${room.id} 的成员 —— 角色只能挂在成员身上`,
        'ROOM_NOT_MEMBER',
        { roomId: room.id, sessionId: sid, members: room.members },
      )
    }
    const r = normalizeMemberRole(role, 'setMemberRole')
    if ((room.roles?.[sid] ?? 'member') === r) return clone(room)

    const at = normalizeNow(now, 'setMemberRole')
    const before = clone(room)
    const next = clone(room)
    next.roles = { ...(room.roles ?? {}), [sid]: r }
    next.rev = room.rev + 1
    return commit(room.id, 'member_role_changed', actor, at, before, next)
  }

  /**
   * 踢出成员（**管理员级操作**，DESIGN「super admin 专用」）。
   *
   * 不能踢 `USER`（人类入口）；目标必须是成员。被踢者若是 admin 模式的管理员，
   * 管理权按「最早加入的剩余成员」移交（与 `leave()` 同款，不留锁死房间）。
   *
   * @param {{ roomId: string, sessionId: string, byId: string,
   *           expectedRev?: number, now?: number }} input
   * @returns {object} 变更后的 Room
   * @throws {RoomError} 房间/成员不存在 / 无权限 / 踢 USER / CAS 冲突
   */
  function kickMember(input = {}) {
    const { roomId, sessionId, expectedRev, byId, now } = input ?? {}
    const room = requireRoom(roomId, 'kickMember')
    const actor = requireString(byId, 'byId', 'kickMember')
    const sid = requireString(sessionId, 'sessionId', 'kickMember')
    assertRev(room, expectedRev, 'kickMember')
    assertAdminPrivilege(room, actor, 'kickMember')
    if (sid === USER) {
      throw new RoomError(
        `room.kickMember：不能踢出超级管理员（${JSON.stringify(USER)}）—— 人类入口不可被移除`,
        'ROOM_CANNOT_KICK_USER',
        { roomId: room.id, sessionId: sid },
      )
    }
    if (!room.members.includes(sid)) {
      throw new RoomError(
        `room.kickMember：${sid} 不是房间 ${room.id} 的成员（拒绝静默无操作）`,
        'ROOM_NOT_MEMBER',
        { roomId: room.id, sessionId: sid, members: room.members },
      )
    }

    const at = normalizeNow(now, 'kickMember')
    const before = clone(room)
    const next = clone(room)
    next.members = room.members.filter((m) => m !== sid)
    next.relayLimit = relayLimitForMembers(next.members)
    if (next.roles && Object.prototype.hasOwnProperty.call(next.roles, sid)) delete next.roles[sid]
    next.rev = room.rev + 1
    if (room.adminId === sid) {
      if (next.members.length > 0) {
        next.adminId = next.members[0]
        next.roles = { ...(next.roles ?? {}), [next.members[0]]: 'admin' }
        info(`[cs-bots/room] 房间 ${room.id} 管理员被踢（${sid}）→ 管理权移交 ${next.adminId}`)
      } else {
        delete next.adminId
      }
    }
    return commit(room.id, 'member_kicked', actor, at, before, next)
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
   * @param {{ roomId: string, limit?: number, sinceSeq?: number, withBody?: boolean }} input
   *        - `sinceSeq`：只要 `seq > sinceSeq` 的（断点续传用）
   *        - `limit`：取**最新** N 条（不是最早 N 条）；缺省不限（**永不截断**）
   *        - `withBody`（DESIGN-v2 ①）：true 时每条内联 `body` = 正文**全文**
   *          （长正文从 `bodies/<msgId>.txt` 读回，页面不用再逐条发 `/rooms/body`）
   * @returns {object[]}
   * @throws {RoomError} 房间不存在 / 参数非法
   */
  function listMessages(input = {}) {
    const { roomId, limit, sinceSeq, withBody } = input ?? {}
    const room = requireRoom(roomId, 'listMessages')
    const since = optionalInteger(sinceSeq, 'sinceSeq', 'listMessages')
    const cap = optionalInteger(limit, 'limit', 'listMessages')
    if (withBody !== undefined && typeof withBody !== 'boolean') {
      throw new RoomError(
        `room.listMessages：withBody 必须是布尔值，收到 ${JSON.stringify(withBody)}`,
        'ROOM_BAD_FIELD',
        { field: 'withBody' },
      )
    }

    let rows = messagesByRoom.get(room.id) ?? []
    if (since !== undefined) rows = rows.filter((m) => m.seq > since)
    if (cap !== undefined && cap > 0 && rows.length > cap) rows = rows.slice(-cap)
    const out = rows.map(clone)
    if (withBody !== true) return out

    // 单条正文读失败（旁路文件被清理/损坏）**不能让整页 500**，但也绝不静默：
    //   `body` 回落到日志里的头（与不带 withBody 时一致）+ 显式 `bodyError`，
    //   调用方据此决定「提示用户」还是「重试」——「看着像全文其实只有头」才是不可接受的。
    return out.map((message) => {
      try {
        message.body = readBody({ roomId: room.id, messageId: message.id })
      } catch (error) {
        message.body = message.text
        message.bodyError = {
          code: error?.code ?? 'ROOM_BODY_UNREADABLE',
          message: error?.message ?? String(error),
        }
        warn(`[cs-bots/room] listMessages(withBody) 正文读回失败 ${room.id}/${message.id}：${message.bodyError.code}`)
      }
      return message
    })
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

    // ══ 目标计算（2026-11-11「唤醒风暴」止血）═══════════════════════════════
    // 四档，**顺序即优先级**：
    //   ① 显式给了 targets  → 原样采信（调用方说了算；仍强制排除人类 id）
    //   ② mentionOnly=true 且消息 @ 了某人 → 只打给被 @ 的成员（不含发送者/人类）
    //   ③ mentionOnly=true 但没 @      → **只落消息，不唤醒任何人**（relayed:0）
    //   ④ mentionOnly=false（显式关掉定向）→ 回退「除自己外全部成员」，但仍排除人类
    //
    // 为什么③不抛错：「只记录不打扰」是合法结果（Boss 只是同步信息，不需要谁被叫醒）。
    // 抛错会把「安静」变成「失败」，页面反而要处理异常 —— 那是更差的设计。
    const settings = room.settings ?? DEFAULT_SETTINGS
    const mentionOnly = settings.mentionOnly !== false
    /** 唤醒排除表：人类一律不算唤醒目标（见 HUMAN_IDS 注释的实测证据）。 */
    const wakeable = (id) => id !== message.from && !isHumanId(id)
    let targetList
    let targetSource
    let noTargetReason

    // 规则统一在 computeWakeTargets（t-40-B）：与 `POST /rooms/post` 共用同一份，
    // 避免两条唤醒路径各写一套而再度漂移。
    const decided = computeWakeTargets(room, message, { targets, warn })
    targetList = decided.targets
    targetSource = decided.source
    if (targetSource === 'mention-only-no-target') noTargetReason = 'mention-only-no-target'
    // 显式 targets 给了空数组 ⇒ 调用方契约违反，抛错（computeWakeTargets 只管剔除人类）
    if (targetSource === 'explicit' && Array.isArray(targets) && targets.length === 0) {
      throw new RoomError(
        `room.relay：targets 是空数组 —— 拒绝空转发（静默无操作），请显式给出目标或省略该字段走缺省`,
        'ROOM_NO_TARGETS',
        { roomId: room.id, messageId: mid },
      )
    }
    // 广播档但「除发送者外全是人类」⇒ 这是**配置错误**（没有 bot 可广播），抛错比静默诚实。
    // 注意：mention 档的空结果不算错（③「只记录不打扰」是合法结果），二者不能混。
    if (targetSource === 'broadcast' && targetList.length === 0) {
      throw new RoomError(
        `room.relay：房间 ${room.id} 除发送者（${message.from}）外没有其他可唤醒成员，且未显式指定 targets`
        + ' —— 拒绝空转发（静默无操作）',
        'ROOM_NO_TARGETS',
        { roomId: room.id, messageId: mid, from: message.from },
      )
    }

    // ── ③「没 @ 到谁」：合法空转发 —— 记事件、返回 relayed:0，**不抛错** ──────
    // 必须在后台账之前分流：否则每次安静发言都吃掉一次 relayLimit 配额。
    if (targetList.length === 0) {
      const at0 = normalizeNow(now, 'relay')
      appendRoomEvent(room.id, {
        type: 'relay',
        roomId: room.id,
        rev: room.rev,
        byId: actor ?? null,
        at: at0,
        messageId: mid,
        targets: [],
        attempted: 0,
        limit: room.relayLimit,
        targetSource,
        reason: noTargetReason ?? 'no-wakeable-target',
      })
      let audit0 = { written: true }
      try {
        appendRoomEvent(room.id, {
          type: 'relay_result',
          roomId: room.id,
          rev: room.rev,
          byId: actor ?? null,
          at: at0,
          messageId: mid,
          deliveries: [],
        })
      } catch (error) {
        audit0 = { written: false, reason: `relay-result-append-failed:${error?.message ?? error}` }
        diagnostics.relayResultAppendFailures += 1
        warn(`[cs-bots/room] 转发结果事件写入失败（投递已发生）：${audit0.reason}`)
      }
      return {
        ok: true,
        roomId: room.id,
        messageId: mid,
        relayed: 0,
        attempted: 0,
        limit: room.relayLimit,
        remaining: Math.max(0, room.relayLimit - (relayCounts.get(relayKey(room.id, mid)) ?? 0)),
        deliveries: [],
        audit: audit0,
        targetSource,
        reason: noTargetReason ?? 'no-wakeable-target',
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
      targetSource,
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
    let archived = 0
    for (const room of rooms.values()) {
      members += room.members.length
      if (room.archivedAt !== null && room.archivedAt !== undefined) archived += 1
    }

    return {
      // ⚠️ 修复（2026-11-04 测试，P2-2）：UI 概览读 `stats.total`，此处之前没有 ⇒ 恒显示 `—`
      total: rooms.size,
      rooms: rooms.size,
      archived,
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
    update,
    join,
    leave,
    post,
    relay,
    /**
     * 计算「这条消息该唤醒谁」（t-40-B）。
     * 暴露给 `POST /rooms/post` 复用，保证两条唤醒路径共用同一份规则；
     * 纯函数、不落盘、不唤醒，调用方自己决定要不要投递。
     * 绑定本实例的 `warn`，这样 HTTP 路径的告警与 relay 走同一个 logger。
     */
    computeWakeTargets: (room, message, options = {}) =>
      computeWakeTargets(room, message, { ...options, warn }),
    readBody,
    listMessages,
    // DESIGN-v2 ①：房间配置 / 归档 / 硬删 / 成员角色（签名见 DESIGN 契约，勿改名）
    archiveRoom,
    unarchiveRoom,
    removeRoom,
    setMemberRole,
    kickMember,
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
  MAX_PURPOSE,
  BODY_THRESHOLD,
  BODY_HEAD_CHARS,
  RELAY_MULTIPLIER,
  RELAY_FLOOR,
})

/** 合法成员角色（DESIGN-v2 ①；UI 下拉框直接用，避免前后端各写一份）。 */
export const ROOM_MEMBER_ROLES = Object.freeze([...MEMBER_ROLES])

/** 房间级开关缺省值（DESIGN-v2 ①；UI/API 侧做表单缺省用）。 */
export const ROOM_DEFAULT_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS })

/** 用户（人类）发送者 id（`from` 允许的特殊值）。 */
export const ROOM_USER = USER
export const ROOM_CANONICAL_USER = CANONICAL_USER

export default createRoom
