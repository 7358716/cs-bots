/**
 * cs-bots TeamsService —— 大团队（Lead 聚合管理）与小团队（智能体自建）统一层。
 *
 * 为什么需要它：宿主的 Team 模型是「一个 root lead 会话 + 若干成员会话」，
 * **不支持嵌套团队、没有管理者角色**（lead 即管理者，且成员必须是宿主 spawn 出的子代理）。
 * 因此「把几个 Lead Bot 聚合成一个可管理的大团队」原生不成立 —— 本模块在 cs-bots 的
 * roster 之上自建这一层。
 *
 * 两类团队（对应 Team Topologies 的两种组织形态）：
 *   - **大团队（big）**：人建的、跨多个 lead bot 的稳定协作结构。人管成员、派任务、看全局。
 *   - **小团队（small）**：智能体自建的、临时的。人可查看/解散，一般不主动派任务。
 *
 * 不变量：事件流真相源 / 只追加 / 绝不静默失败 / CAS。
 * 依赖面：node 内置 + `./store.js` + `./kernel.js`。零第三方依赖。
 */

import { appendJsonl, readJsonl, statePath, writeJsonAtomic } from './store.js'

let kernel = null
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

/** 团队类型。 */
export const TEAM_TYPES = Object.freeze(['big', 'small'])

/** 团队成员角色。 */
export const TEAM_ROLES = Object.freeze(['lead', 'member'])

/**
 * 团队管理权限边界（2026-11-09 需求：「管理员权限边界从页面控制」）。
 *
 * 团队只有 lead / member 两种角色，**lead 即管理员**；在此之前「谁能管理团队」这个概念
 * 根本不存在 —— 任何人只要知道 id 就能调 `removeMember` 把人踢掉。本字段把这条边界
 * 变成团队级、可审计、可从页面切换的设置：
 *
 *   - `'lead-only'`  ：只有负责人（leadId）或「人」能改团队（addMember/removeMember/setRole/close/note）
 *   - `'any-member'` ：任何成员都能改，但**踢负责人永远禁止**（不变量，与策略无关）
 *   - `'open'`       ：不做校验（= 历史行为，留作逃生阀）
 */
export const TEAM_ADMIN_POLICIES = Object.freeze(['lead-only', 'any-member', 'open'])

/**
 * 缺省策略 = `'open'`。
 *
 * 为什么不是 `'lead-only'`：这个字段是**新加**的，而 teams.jsonl 里已经躺着历史团队、
 * `src/tools.js` 的 `bot_teams_add` 也在用（by = 执行者会话 id）。把缺省改成 lead-only
 * 等于给所有既有调用面**静默降权**，且既有测试会被迫改写以迁就新默认 —— 那说明改的是
 * 契约而不是加能力。缺省 `'open'` 保证「升级不改变任何既有行为」，再由**页面**把新建
 * 团队显式设成 `'lead-only'`（TeamsTab 的创建表单默认值），安全的默认值落在真正需要
 * 它的地方（人建的团队），不需要它的地方保持原样。这么做的代价是：服务层直调（工具/
 * 脚本）默认不设防 —— 所以 `close`/`removeMember` 的关键不变量（负责人不可移除）做在
 * 策略之外，任何策略下都生效。
 */
export const DEFAULT_TEAM_ADMIN_POLICY = 'open'

/**
 * 视为「人」的身份：人永远是超级管理员，不受任何策略限制。
 * 与 `src/api.js` 的 OWNER（`'user'`）和页面层发来的 `'ui'` 对齐，另收 `'person'`。
 */
const HUMAN_IDS = Object.freeze(['ui', 'user', 'person'])

/** 合法动作（含 setPolicy：策略变更本身也是要留痕的事件）。 */
const ACTIONS = Object.freeze(['create', 'addMember', 'removeMember', 'setRole', 'close', 'note', 'setPolicy', 'attachRoom', 'route'])

/** 跨团队路由的最大 hop 数（>3 拒绝）。 */
const ROUTE_MAX_HOP = 3

/** 结构化错误。 */
export class TeamError extends Error {
  constructor(message, code = 'TEAM_ERROR', details) {
    super(message)
    this.name = 'TeamError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeNow(now, where) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TeamError(`teams.${where}：now 必须是有限数字，收到 ${JSON.stringify(now)}`, 'TEAM_BAD_FIELD', { where, field: 'now' })
  }
  return now
}

function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TeamError(`teams.${where}：${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`, 'TEAM_BAD_FIELD', { where, field })
  }
  return value.trim()
}

function stringList(value, field, where) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new TeamError(`teams.${where}：${field} 必须是数组，收到 ${JSON.stringify(value)}`, 'TEAM_BAD_FIELD', { where, field })
  }
  return value.map((v) => requireString(v, `${field}[]`, where))
}

/** 校验并归一化管理策略（undefined/null → 缺省策略；非法值直接拒绝，绝不静默降级）。 */
function normalizePolicy(value, where) {
  if (value === undefined || value === null) return DEFAULT_TEAM_ADMIN_POLICY
  if (typeof value !== 'string' || !TEAM_ADMIN_POLICIES.includes(value)) {
    throw new TeamError(
      `teams.${where}：adminPolicy=${JSON.stringify(value)} 非法（合法：${TEAM_ADMIN_POLICIES.join(' | ')}）`,
      'TEAM_BAD_POLICY', { where, field: 'adminPolicy', adminPolicy: value },
    )
  }
  return value
}

/** 该身份是否是「人」（人 = 超级管理员，不受任何策略约束）。 */
function isHuman(by) {
  return HUMAN_IDS.includes(by)
}

function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') return config.stateDir.trim()
  if (kernel && typeof kernel.stateDir === 'function') return kernel.stateDir()
  const reason = kernelError?.message ?? 'kernel.stateDir 不存在'
  throw new TeamError(`teams.createTeams：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`, 'TEAM_NO_STATE_DIR')
}

function splitArgs(ctx, config) {
  const cfgGiven = config && typeof config === 'object' && Object.keys(config).length > 0
  if (cfgGiven) return { context: ctx ?? {}, config }
  if (ctx && typeof ctx === 'object' && typeof ctx.stateDir === 'string') return { context: {}, config: ctx }
  return { context: ctx ?? {}, config: config ?? {} }
}

/**
 * 创建团队服务。
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx]
 * @param {{ stateDir?: string, name?: string }} [config]
 * @returns {object} teams service
 */
export function createTeams(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'teams.jsonl')
  const snapPath = statePath(stateDir, 'teams.snap.json')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* */ } }

  const entries = new Map()
  const events = []
  let idCounter = 0
  let disposed = false

  const diagnostics = {
    stateDir, jsonlPath, snapPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: null, replayedEvents: 0, badLines: 0,
    snapshotWriteFailures: 0, lastReplayAt: undefined,
  }

  function assertAlive(where) {
    if (disposed) {
      throw new TeamError(`teams.${where}：实例已 dispose()，请重新 createTeams()（拒绝在已销毁实例上静默返回空数据）`, 'TEAM_DISPOSED', { where })
    }
  }

  function snapshot() { return { version: 1, savedAt: Date.now(), entries: [...entries.values()] } }

  function commit(action, at, by, before, after) {
    if (!appendJsonl(jsonlPath, { id: after.id, rev: after.rev, action, by, at, before, after })) {
      throw new TeamError(`teams.${action}：事件追加失败（${jsonlPath}）—— 拒绝「只改内存不落盘」`, 'TEAM_APPEND_FAILED', { action })
    }
    entries.set(after.id, clone(after))
    events.push({ id: after.id, rev: after.rev, action, by, at, before: before ? clone(before) : null, after: clone(after) })
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/teams] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可恢复`)
    }
  }

  function hydrate() {
    entries.clear(); events.length = 0; idCounter = 0
    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) warn(`[cs-bots/teams] ${jsonlPath} 有 ${bad} 行无法解析——已跳过，请核对`)
    if (rows.length === 0) { diagnostics.hydratedFrom = 'empty'; return }
    let skipped = 0
    for (const ev of rows) {
      // route 事件是**审计记录**，不是团队状态变更 —— 没有 id/rev，仍要进 events
      // 供 listRoutes 查询；只有团队状态变更事件才需要 id + rev 去重。
      if (ev?.action === 'route') {
        events.push(clone(ev))
        continue
      }
      if (!ev || typeof ev.id !== 'string' || !ev.after) { skipped += 1; continue }
      const current = entries.get(ev.id)
      if (current && Number.isFinite(ev.rev) && ev.rev <= current.rev) { skipped += 1; continue }
      entries.set(ev.id, clone(ev.after)); events.push(clone(ev))
      const m = /^team-(\d+)$/.exec(ev.id)
      if (m) idCounter = Math.max(idCounter, Number(m[1]))
    }
    if (skipped > 0) warn(`[cs-bots/teams] 回放跳过 ${skipped} 条非递增/残缺事件`)
    diagnostics.hydratedFrom = 'jsonl'
  }

  function requireTeam(id, where) {
    const t = entries.get(id)
    if (!t) throw new TeamError(`teams.${where}：团队 ${id} 不存在`, 'TEAM_NOT_FOUND', { where, id })
    return t
  }

  function cas(id, expectedRev, where) {
    const t = requireTeam(id, where)
    if (expectedRev !== undefined && expectedRev !== null) {
      if (!Number.isInteger(expectedRev)) {
        throw new TeamError(`teams.${where}：expectedRev 必须是整数（当前 rev=${t.rev}）`, 'TEAM_BAD_FIELD', { where, field: 'expectedRev' })
      }
      if (t.rev !== expectedRev) {
        throw new TeamError(`teams.${where} CAS 冲突：团队 ${id} 期望 rev=${expectedRev}，实际 rev=${t.rev} —— 拒绝静默覆盖`, 'TEAM_REV_CONFLICT', { where, id, expectedRev, rev: t.rev })
      }
    }
    return t
  }

  /** 读团队的实际生效策略（历史团队没有该字段 → 缺省策略；绝不用 undefined 参与判断）。 */
  function policyOf(team) {
    return team?.adminPolicy ?? DEFAULT_TEAM_ADMIN_POLICY
  }

  /**
   * 管理动作的权限闸（2026-11-09「管理员权限边界」）。
   *
   * 判定顺序（**人永远第一**）：人 → 放行；`open` → 放行；负责人 → 放行；
   * `any-member` 且调用者是成员 → 放行；其余一律 `TEAM_FORBIDDEN`。
   *
   * 为什么 `open` 要放行而不是「人 + 负责人」：它是给既有调用面留的逃生阀，
   * 语义必须是「和加这个字段之前一模一样」，否则升级即破坏（含 tools.js 的
   * `bot_teams_add`，它的 by 是执行者会话 id）。
   *
   * @param {object} team 团队记录
   * @param {string} by 调用者身份（'ui'|'user'|'person' = 人）
   * @param {string} where 动作名（用于错误信息）
   */
  function assertAdmin(team, by, where) {
    const adminPolicy = policyOf(team)
    if (adminPolicy === 'open') return adminPolicy
    if (isHuman(by)) return adminPolicy
    if (team.leadId && by === team.leadId) return adminPolicy
    if (adminPolicy === 'any-member' && (team.members ?? []).includes(by)) return adminPolicy
    throw new TeamError(
      `teams.${where}：${by} 无权管理团队 ${team.id}（当前策略 ${adminPolicy}：`
        + `${adminPolicy === 'lead-only' ? '仅负责人可管理' : '仅团队成员可管理'}；人不受限）`,
      'TEAM_FORBIDDEN',
      { where, id: team.id, by, adminPolicy, leadId: team.leadId },
    )
  }

  /**
   * 不变量：负责人（leadId）永不可被移出团队。
   *
   * **与 adminPolicy 无关**——哪怕策略是 `open`、哪怕调用者是人。
   * 依据：leadId 是团队的锚，移掉就得到一个没有负责人的团队（既无法定义管理边界，
   * 也无法回答「谁能管」）。要换负责人请走 `setRole(..., role:'lead')`，
   * 那条路径会把原负责人降级为成员，不会制造空洞。
   */
  function assertNotLead(team, memberId, where) {
    if (team.leadId && team.leadId === memberId) {
      throw new TeamError(
        `teams.${where}：${memberId} 是团队 ${team.id} 的负责人，不能被移出（换负责人请用 setRole）`,
        'TEAM_LEAD_IMMUTABLE', { where, id: team.id, leadId: team.leadId, memberId },
      )
    }
  }

  // ── API：写 ────────────────────────────────────────────────────────────────

  /**
   * 创建一个团队。
   * @param {{ name: string, type?: 'big'|'small', purpose?: string,
   *           memberIds?: string[], leadId?: string, adminPolicy?: 'lead-only'|'any-member'|'open',
   *           by: string, now?: number }} input
   */
  function create(input = {}) {
    assertAlive('create')
    const { name, type, purpose, memberIds, leadId, adminPolicy, by, now, kind } = input ?? {}
    const nameNorm = requireString(name, 'name', 'create')
    if (nameNorm.length > 120) throw new TeamError(`teams.create：name ≤120 字符（收到 ${nameNorm.length}）`, 'TEAM_BAD_FIELD', { field: 'name' })
    const teamType = type ?? 'big'
    if (!TEAM_TYPES.includes(teamType)) {
      throw new TeamError(`teams.create：type=${JSON.stringify(type)} 非法（合法：${TEAM_TYPES.join(' | ')}）`, 'TEAM_BAD_TYPE', { type })
    }
    const author = requireString(by, 'by', 'create')
    const at = normalizeNow(now, 'create')
    // 缺省 'open'：升级不改变既有行为（见 DEFAULT_TEAM_ADMIN_POLICY 注释）
    const policy = normalizePolicy(adminPolicy, 'create')

    // big 团队必须有人管（leadId）；small 团队是自建的，leadId 可选
    const lead = teamType === 'big' ? requireString(leadId, 'leadId', 'create') : (leadId ?? null)
    const members = stringList(memberIds, 'memberIds', 'create')
    if (members.includes(lead)) {
      throw new TeamError(`teams.create：leadId ${lead} 不能同时出现在 memberIds 中（会形成自引用）`, 'TEAM_BAD_FIELD', { field: 'memberIds' })
    }

    // ── kind：人类/智能体（服务层强制推导，防止伪造）─────────────────────────
    // 由执行者身份（author）硬推导：HUMAN_IDS ⇒ 'human'，其他 ⇒ 'agent'。
    // 显式传 kind 但与推导矛盾 ⇒ 抛 TEAM_KIND_MISMATCH（不许伪造 Boss 建的团队）。
    const derivedKind = HUMAN_IDS.includes(author) ? 'human' : 'agent'
    if (kind !== undefined && kind !== null && kind !== derivedKind) {
      throw new TeamError(
        `teams.create：kind=${JSON.stringify(kind)} 与执行者身份矛盾（执行者 ${author} ⇒ '${derivedKind}'）——不许伪造`,
        'TEAM_KIND_MISMATCH',
        { author, derivedKind, requested: kind },
      )
    }
    const teamKind = derivedKind

    idCounter += 1
    const id = `team-${idCounter}`
    /** @type {Record<string, unknown>} */
    const rec = {
      id, rev: 1, name: nameNorm, type: teamType, kind: teamKind, purpose: purpose ?? '',
      leadId: lead, members,
      adminPolicy: policy,
      status: 'open',
      createdAt: at, createdBy: author, updatedAt: at, updatedBy: author,
    }
    commit('create', at, author, null, rec)
    info(`[cs-bots/teams] 团队 ${id}（${nameNorm}，${teamType}，${teamKind}）创建 by ${author}`)
    return clone(rec)
  }

  /**
   * 加入成员。管理权限由团队的 `adminPolicy` 决定（缺省 = open，行为与历史一致）。
   * @param {{ id: string, expectedRev?: number, memberId: string, by: string, now?: number }} input
   */
  function addMember(input = {}) {
    assertAlive('addMember')
    const { id, expectedRev, memberId, by, now } = input ?? {}
    const author = requireString(by, 'by', 'addMember')
    const at = normalizeNow(now, 'addMember')
    const member = requireString(memberId, 'memberId', 'addMember')
    const current = cas(id, expectedRev, 'addMember')
    assertAdmin(current, author, 'addMember')
    if (current.status === 'closed') throw new TeamError(`teams.addMember：团队 ${id} 已关闭`, 'TEAM_CLOSED', { id })
    if (current.members.includes(member)) {
      throw new TeamError(`teams.addMember：成员 ${member} 已在团队 ${id} 中`, 'TEAM_DUPLICATE_MEMBER', { id, member })
    }
    const next = clone(current)
    next.rev = current.rev + 1
    next.members = [...current.members, member]
    next.updatedAt = at
    next.updatedBy = author
    commit('addMember', at, author, clone(current), next)
    return clone(next)
  }

  /**
   * 移除成员。
   * 两条独立的闸：权限闸（adminPolicy）+ 不变量闸（负责人永不可移除）。
   * @param {{ id: string, expectedRev?: number, memberId: string, by: string, now?: number }} input
   */
  function removeMember(input = {}) {
    assertAlive('removeMember')
    const { id, expectedRev, memberId, by, now } = input ?? {}
    const author = requireString(by, 'by', 'removeMember')
    const at = normalizeNow(now, 'removeMember')
    const member = requireString(memberId, 'memberId', 'removeMember')
    const current = cas(id, expectedRev, 'removeMember')
    assertAdmin(current, author, 'removeMember')
    assertNotLead(current, member, 'removeMember')
    const next = clone(current)
    next.rev = current.rev + 1
    next.members = current.members.filter((m) => m !== member)
    next.updatedAt = at
    next.updatedBy = author
    commit('removeMember', at, author, clone(current), next)
    return clone(next)
  }

  /**
   * 设成员角色（lead/member）。
   * @param {{ id: string, expectedRev?: number, memberId: string, role: string, by: string, now?: number }} input
   */
  function setRole(input = {}) {
    assertAlive('setRole')
    const { id, expectedRev, memberId, role, by, now } = input ?? {}
    const author = requireString(by, 'by', 'setRole')
    const at = normalizeNow(now, 'setRole')
    if (!TEAM_ROLES.includes(role)) {
      throw new TeamError(`teams.setRole：role=${JSON.stringify(role)} 非法（合法：${TEAM_ROLES.join(' | ')}）`, 'TEAM_BAD_ROLE', { role })
    }
    const member = requireString(memberId, 'memberId', 'setRole')
    const current = cas(id, expectedRev, 'setRole')
    assertAdmin(current, author, 'setRole')
    const next = clone(current)
    next.rev = current.rev + 1
    if (role === 'lead') {
      next.leadId = member
      // 原 lead 降级为 member
      if (current.leadId && current.leadId !== member && !next.members.includes(current.leadId)) {
        next.members = [...next.members, current.leadId]
      }
    } else {
      // member：确保它在 members 里
      if (!next.members.includes(member)) next.members = [...next.members, member]
    }
    next.updatedAt = at
    next.updatedBy = author
    commit('setRole', at, author, clone(current), next)
    return clone(next)
  }

  /**
   * 记一条团队备注（变更/决策留痕，append-only 语义：只追加一条 note 事件）。
   * @param {{ id: string, expectedRev?: number, note: string, by: string, now?: number }} input
   */
  function note(input = {}) {
    assertAlive('note')
    const { id, expectedRev, note, by, now } = input ?? {}
    const author = requireString(by, 'by', 'note')
    const at = normalizeNow(now, 'note')
    const text = requireString(note, 'note', 'note')
    if (text.length > 4000) throw new TeamError(`teams.note：note ≤4000 字符（收到 ${text.length}）`, 'TEAM_BAD_FIELD', { field: 'note' })
    const current = cas(id, expectedRev, 'note')
    assertAdmin(current, author, 'note')
    const next = clone(current)
    next.rev = current.rev + 1
    next.notes = [...(current.notes ?? []), { text, by: author, at }]
    next.updatedAt = at
    next.updatedBy = author
    commit('note', at, author, clone(current), next)
    return clone(next)
  }

  /**
   * 关闭团队。
   * @param {{ id: string, expectedRev?: number, by: string, now?: number }} input
   */
  function close(input = {}) {
    assertAlive('close')
    const { id, expectedRev, by, now } = input ?? {}
    const author = requireString(by, 'by', 'close')
    const at = normalizeNow(now, 'close')
    const current = cas(id, expectedRev, 'close')
    assertAdmin(current, author, 'close')
    const next = clone(current)
    next.rev = current.rev + 1
    next.status = 'closed'
    next.closedAt = at
    next.updatedAt = at
    next.updatedBy = author
    commit('close', at, author, clone(current), next)
    return clone(next)
  }

  /**
   * 改团队的「管理员权限边界」（CAS）。这是本次需求「从页面控制」的服务端落点。
   *
   * 权限：只有人或负责人能改策略（`assertAdmin`）。`open` 策略下任何人都能改 ——
   * 那正是逃生阀该有的样子；`lead-only`/`any-member` 下非负责人会被 `TEAM_FORBIDDEN`。
   * 注意：把策略从受限改成 `open` 用的也是这套判定（人/负责人可放行），不存在
   * 「用策略把自己解锁」的路径 —— 想放宽必须先有管理权。
   *
   * @param {{ id: string, expectedRev?: number, adminPolicy: string, by: string, now?: number }} input
   */
  function setPolicy(input = {}) {
    assertAlive('setPolicy')
    const { id, expectedRev, adminPolicy, by, now } = input ?? {}
    const author = requireString(by, 'by', 'setPolicy')
    const at = normalizeNow(now, 'setPolicy')
    const policy = normalizePolicy(adminPolicy, 'setPolicy')
    const current = cas(id, expectedRev, 'setPolicy')
    assertAdmin(current, author, 'setPolicy')
    if (policyOf(current) === policy) {
      // 幂等：同样的策略不产生新事件（避免事件流被无意义写入灌满）
      return clone(current)
    }
    const next = clone(current)
    next.rev = current.rev + 1
    next.adminPolicy = policy
    next.updatedAt = at
    next.updatedBy = author
    commit('setPolicy', at, author, clone(current), next)
    info(`[cs-bots/teams] 团队 ${id} 管理策略 ${policyOf(current)} → ${policy}（by ${author}）`)
    return clone(next)
  }

  // ── API：读 ────────────────────────────────────────────────────────────────

  /**
   * 给团队挂上一个房间（契约 §3：团队自动配议事厅）。
   *
   * 幂等：同一个 roomId 再调一次 ⇒ 直接返回现有团队（rev 不变）。
   * 房间已经存在、只是想补关联时**不重复写事件** —— 否则 `/teams` 反复保存
   * 会把事件流刷成一条重复行，rev 也跟着虚增，页面上的「谁改了团队」就失真了。
   * @param {{ id: string, expectedRev?: number, roomId: string, by: string, now?: number }} input
   */
  function attachRoom(input = {}) {
    assertAlive('attachRoom')
    const { id, expectedRev, roomId, by, now } = input ?? {}
    const author = requireString(by, 'by', 'attachRoom')
    const at = normalizeNow(now, 'attachRoom')
    const room = requireString(roomId, 'roomId', 'attachRoom')
    const current = cas(id, expectedRev, 'attachRoom')
    if (current.roomId === room) {
      return clone(current) // 幂等：已关联同一房间，不重复落事件
    }
    const next = clone(current)
    next.rev = current.rev + 1
    next.roomId = room
    next.updatedAt = at
    next.updatedBy = author
    commit('attachRoom', at, author, clone(current), next)
    info(`[cs-bots/teams] 团队 ${id} 关联房间 ${room}（by ${author}）`)
    return clone(next)
  }

  // ── A. 跨团队路由（t-39 第2批 · bot_team_route 的服务层本体）────────────────

  /**
   * 解析并校验一条跨团队路由目标 —— **只做决定，不做投递**。
   *
   * 为什么拆开：投递要 dispatcher（wakes.jsonl / dedup / 背压），而 dispatcher 挂在
   * `src/tools.js` 的组装层（`s.dispatcher`）。若把投递塞进 TeamsService，本服务就得
   * 反向依赖 dispatcher —— 两个域服务互指会让装配顺序变成硬约束。所以这里只回答
   * 「路由到谁」，投递由工具层完成，语义边界清晰。
   *
   * 失败一律**返回可读的 refused**，不抛裸错 —— 契约要求 `{ok:false, decision:'refused',
   * reason}` 而不是异常（异常在工具层会被包成 `tool-crashed`，理由就丢了）。
   *
   * @param {{ fromTeam?: string, toTeam?: string, toBot?: string,
   *           taskId: string, text?: string, hop?: number, by: string }} input
   * @returns {{ ok: true, decision: 'accepted', to: { kind: 'team'|'bot', id: string,
   *            leadId: string, name: string }, hop: number, dedupKey: string,
   *            fromTeam: string }
   *          | { ok: false, decision: 'refused', reason: string, to?: object, hop?: number }}
   */
  function resolveRoute(input = {}) {
    assertAlive('resolveRoute')
    const { fromTeam, toTeam, toBot, taskId, hop, by } = input ?? {}
    const author = requireString(by, 'by', 'resolveRoute')

    // ── 参数校验：全部**可读拒绝** ──
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      return { ok: false, decision: 'refused', reason: 'ROUTE_TASK_ID_REQUIRED' }
    }
    if (!toTeam && !toBot) {
      return { ok: false, decision: 'refused', reason: 'ROUTE_TARGET_REQUIRED' }
    }
    if (toTeam && toBot) {
      return { ok: false, decision: 'refused', reason: 'ROUTE_TARGET_AMBIGUOUS' }
    }

    // ── hop 计数：>3 拒绝（环路防护第一道闸）──
    const hopCount = Number.isFinite(Number(hop)) ? Math.max(0, Math.trunc(Number(hop))) : 0
    if (hopCount > ROUTE_MAX_HOP) {
      return { ok: false, decision: 'refused', reason: 'ROUTE_HOP_EXCEEDED', hop: hopCount }
    }

    // ── 解析目标团队 / 目标 lead ──
    let targetTeamId = null
    let targetLeadId = null
    let targetName = null

    if (toTeam) {
      const team = entries.get(toTeam)
      if (!team) return { ok: false, decision: 'refused', reason: 'ROUTE_TARGET_NOT_FOUND', hop: hopCount }
      targetTeamId = team.id
      targetLeadId = team.leadId ?? null
      targetName = team.name
    } else {
      // toBot：必须**属于**某个 cs-bots 团队（leadId 或成员），否则无法确定唤醒谁
      for (const t of entries.values()) {
        if (t.leadId === toBot || (Array.isArray(t.members) && t.members.includes(toBot))) {
          targetTeamId = t.id
          targetLeadId = t.leadId ?? null
          targetName = t.name
          break
        }
      }
      if (!targetTeamId) {
        return { ok: false, decision: 'refused', reason: 'ROUTE_TARGET_NOT_FOUND', hop: hopCount }
      }
    }

    // 目标团队必须有人可唤 —— 契约：**只唤 leadId**，不 wake 全部成员
    if (!targetLeadId) {
      return {
        ok: false,
        decision: 'refused',
        reason: 'ROUTE_NO_LEAD',
        to: { kind: toTeam ? 'team' : 'bot', id: targetTeamId, name: targetName },
        hop: hopCount,
      }
    }

    const fromKey = fromTeam ?? author

    // 去重键：交给 dispatcher 的 dedupKey 机制（不自己造一套）。
    // **不含 hop** —— 这样同一 (from→to, taskId) 的重复路由会命中 dispatcher 的
    // IdempotencySet 而被判 skipped，正是「A→B→A→B 第 3 跳被拒」的实现路径。
    const dedupKey = `route:${fromKey}:${targetTeamId}:${taskId}`

    return {
      ok: true,
      decision: 'accepted',
      to: { kind: toTeam ? 'team' : 'bot', id: targetTeamId, leadId: targetLeadId, name: targetName },
      hop: hopCount,
      dedupKey,
      fromTeam: fromKey,
    }
  }

  /**
   * 把已经做出的路由决定**落盘留痕**（intent-first：先记后投）。
   *
   * 顺序不可颠倒：`记了没投` 是可见可重试的；`投了没记` 则绕过限额/审计，
   * 让环路防护统计不到这一跳 —— 那正是要防的。
   * @param {{ to: object, fromTeam: string, taskId: string, text?: string, hop: number,
   *           by: string, now?: number, wake?: object }} input
   */
  function recordRoute(input = {}) {
    assertAlive('recordRoute')
    const { to, fromTeam, taskId, text, hop, by, now, wake } = input ?? {}
    const author = requireString(by, 'by', 'recordRoute')
    const at = normalizeNow(now, 'recordRoute')
    const rec = {
      toKind: to?.kind ?? 'team',
      toId: to?.id ?? null,
      toLeadId: to?.leadId ?? null,
      toName: to?.name ?? null,
      fromTeam: fromTeam ?? null,
      taskId,
      text: text ?? '',
      hop: Number(hop ?? 0),
      wake: wake ?? null,
      at,
    }
    if (!appendJsonl(jsonlPath, { action: 'route', at, by: author, before: null, after: rec })) {
      throw new TeamError(`teams.recordRoute：事件追加失败（${jsonlPath}）—— 拒绝「投了没记」`, 'TEAM_APPEND_FAILED', { action: 'route' })
    }
    events.push({ action: 'route', at, by: author, before: null, after: clone(rec) })
    info(`[cs-bots/teams] route ${rec.fromTeam} → ${rec.toId}（lead=${rec.toLeadId}, hop=${rec.hop}, task=${taskId}）by ${author}`)
    return clone(rec)
  }

  /**
   * 查 route 审计记录（按 toId / taskId / fromTeam 过滤）。
   * @param {{ toId?: string, fromTeam?: string, taskId?: string }} [query]
   */
  function listRoutes(query = {}) {
    assertAlive('listRoutes')
    let rows = events.filter((e) => e.action === 'route').map((e) => ({ ...e.after, by: e.by, at: e.at }))
    if (query?.toId !== undefined && query?.toId !== null) rows = rows.filter((r) => r.toId === query.toId)
    if (query?.fromTeam !== undefined && query?.fromTeam !== null) rows = rows.filter((r) => r.fromTeam === query.fromTeam)
    if (query?.taskId !== undefined && query?.taskId !== null) rows = rows.filter((r) => r.taskId === query.taskId)
    return clone(rows)
  }

  // ── API：读 ────────────────────────────────────────────────────────────────

  function list(query = {}) {
    assertAlive('list')
    let rows = [...entries.values()]
    if (query?.type !== undefined && query?.type !== null) rows = rows.filter((r) => r.type === query.type)
    if (query?.status !== undefined && query?.status !== null) rows = rows.filter((r) => r.status === query.status)
    // 老团队没有 adminPolicy 字段：补成缺省值，保证读侧永远拿得到（页面才不用写「可能是 undefined」）
    return clone(rows.map((r) => (r.adminPolicy ? r : { ...r, adminPolicy: DEFAULT_TEAM_ADMIN_POLICY })))
  }

  function get(id) {
    assertAlive('get')
    const t = entries.get(id)
    if (!t) return null
    return clone(t.adminPolicy ? t : { ...t, adminPolicy: DEFAULT_TEAM_ADMIN_POLICY })
  }

  function stats() {
    const byType = {}
    const byStatus = {}
    for (const r of entries.values()) {
      byType[r.type] = (byType[r.type] ?? 0) + 1
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    }
    return { total: entries.size, byType, byStatus, events: events.length, diagnostics: clone(diagnostics) }
  }

  function replay() { hydrate(); diagnostics.lastReplayAt = Date.now(); return { from: diagnostics.hydratedFrom, events: events.length, bad: diagnostics.badLines } }
  function dispose() { disposed = true }

  hydrate()

  return {
    name: cfg.name ?? 'teams',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    create,
    addMember,
    removeMember,
    setRole,
    note,
    close,
    setPolicy,
    // 契约 §3：把「议事厅」绑到团队上。api.js 的 ensureTeamRoom 会调它；
    // 不导出 ⇒ 房间建好了但团队记不住 roomId，重启后自动配厅就永远重配一遍。
    attachRoom,
    // 契约 t-39：跨团队路由（只决定 + 留痕，投递由工具层用 dispatcher 完成）
    resolveRoute,
    recordRoute,
    listRoutes,
    list,
    get,
    stats,
    replay,
    diagnostics: () => clone(diagnostics),
    dispose,
  }
}

export default createTeams
