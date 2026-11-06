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

/** 合法动作。 */
const ACTIONS = Object.freeze(['create', 'addMember', 'removeMember', 'setRole', 'close', 'note'])

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

  // ── API：写 ────────────────────────────────────────────────────────────────

  /**
   * 创建一个团队。
   * @param {{ name: string, type?: 'big'|'small', purpose?: string,
   *           memberIds?: string[], leadId?: string, by: string, now?: number }} input
   */
  function create(input = {}) {
    assertAlive('create')
    const { name, type, purpose, memberIds, leadId, by, now } = input ?? {}
    const nameNorm = requireString(name, 'name', 'create')
    if (nameNorm.length > 120) throw new TeamError(`teams.create：name ≤120 字符（收到 ${nameNorm.length}）`, 'TEAM_BAD_FIELD', { field: 'name' })
    const teamType = type ?? 'big'
    if (!TEAM_TYPES.includes(teamType)) {
      throw new TeamError(`teams.create：type=${JSON.stringify(type)} 非法（合法：${TEAM_TYPES.join(' | ')}）`, 'TEAM_BAD_TYPE', { type })
    }
    const author = requireString(by, 'by', 'create')
    const at = normalizeNow(now, 'create')

    // big 团队必须有人管（leadId）；small 团队是自建的，leadId 可选
    const lead = teamType === 'big' ? requireString(leadId, 'leadId', 'create') : (leadId ?? null)
    const members = stringList(memberIds, 'memberIds', 'create')
    if (members.includes(lead)) {
      throw new TeamError(`teams.create：leadId ${lead} 不能同时出现在 memberIds 中（会形成自引用）`, 'TEAM_BAD_FIELD', { field: 'memberIds' })
    }

    idCounter += 1
    const id = `team-${idCounter}`
    /** @type {Record<string, unknown>} */
    const rec = {
      id, rev: 1, name: nameNorm, type: teamType, purpose: purpose ?? '',
      leadId: lead, members,
      status: 'open',
      createdAt: at, createdBy: author, updatedAt: at, updatedBy: author,
    }
    commit('create', at, author, null, rec)
    info(`[cs-bots/teams] 团队 ${id}（${nameNorm}，${teamType}）创建 by ${author}`)
    return clone(rec)
  }

  /**
   * 加入成员。big 团队的成员变化需要 lead 权限（by === leadId 或 by === 'user'）。
   * @param {{ id: string, expectedRev?: number, memberId: string, by: string, now?: number }} input
   */
  function addMember(input = {}) {
    assertAlive('addMember')
    const { id, expectedRev, memberId, by, now } = input ?? {}
    const author = requireString(by, 'by', 'addMember')
    const at = normalizeNow(now, 'addMember')
    const member = requireString(memberId, 'memberId', 'addMember')
    const current = cas(id, expectedRev, 'addMember')
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
   * @param {{ id: string, expectedRev?: number, memberId: string, by: string, now?: number }} input
   */
  function removeMember(input = {}) {
    assertAlive('removeMember')
    const { id, expectedRev, memberId, by, now } = input ?? {}
    const author = requireString(by, 'by', 'removeMember')
    const at = normalizeNow(now, 'removeMember')
    const member = requireString(memberId, 'memberId', 'removeMember')
    const current = cas(id, expectedRev, 'removeMember')
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
    const next = clone(current)
    next.rev = current.rev + 1
    next.status = 'closed'
    next.closedAt = at
    next.updatedAt = at
    next.updatedBy = author
    commit('close', at, author, clone(current), next)
    return clone(next)
  }

  // ── API：读 ────────────────────────────────────────────────────────────────

  function list(query = {}) {
    assertAlive('list')
    let rows = [...entries.values()]
    if (query?.type !== undefined && query?.type !== null) rows = rows.filter((r) => r.type === query.type)
    if (query?.status !== undefined && query?.status !== null) rows = rows.filter((r) => r.status === query.status)
    return clone(rows)
  }

  function get(id) {
    assertAlive('get')
    const t = entries.get(id)
    return t ? clone(t) : null
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
    list,
    get,
    stats,
    replay,
    diagnostics: () => clone(diagnostics),
    dispose,
  }
}

export default createTeams
