/**
 * 部门 ↔ 团队 ↔ 房间 的关联层（2026-11-15 Boss 左侧栏分层 UI 的数据底座）。
 *
 * ## 需求出处
 *   Boss：「我希望按部门管理，左侧栏 ui 页面 Csbots 一个页面，里面按部门以及 bot 等
 *          不同层级分成不同的工作区，**把部门作为一个群聊映射到左侧栏**，
 *          我希望我可以在群聊里安排工作，这也是我设计的初衷」
 *
 * ## 为什么单独一个模块
 *   `settings.departments` 只是一串 `{id, name}`，它不知道「部门对应的团队是谁、
 *   群聊房间是哪个」。而 UI 要画三层树（部门 → Bot → 会话）+ 部门群聊，
 *   需要的正是这层映射。
 *
 *   **不新建任何存储概念**：部门 → 团队（`teams.jsonl`）→ 房间（`room.js`），
 *   这条链在 teams/room 里已经跑通（`attachRoom` + `ensureRoomForTeam`）。
 *   本模块只做「按部门找到/建出这些东西」的编排。
 *
 * ## 幂等性（关键）
 *   每次读取都可能触发「没有就建」，所以必须严格幂等：
 *   - 团队按 `name = 部门名` 查重（同名的 big 团队只应有一个）
 *   - 房间按 `team.roomId` 复用；团队没有 roomId 才建
 *   - 任何一步失败都不抛给调用方（列表渲染不能因为一个部门没建好就整棵树崩）
 *
 * 依赖面：node 内置。不直接依赖 teams/room 的实现，全部通过 services 注入。
 */

import { join } from 'node:path'
import { isInsideDir } from './botdirs.js'

/** 部门群聊房间名的统一后缀（便于识别与查找）。 */
export const DEPT_ROOM_SUFFIX = ' · 部门群聊'

/**
 * 部门群聊房间的标准名。
 * @param {string} deptName
 * @returns {string}
 */
export function deptRoomName(deptName) {
  return `${String(deptName ?? '').trim()}${DEPT_ROOM_SUFFIX}`
}

/**
 * 找出某个部门对应的团队；没有就建一个（type=big, kind=human）。
 *
 * ## 为什么用 name 查而不是存 deptId
 *   `teams.jsonl` 现有记录没有 `departmentId` 字段，加字段要迁移存量。
 *   而「部门名 = 团队名」是自然的一一对应（部门名本身在 settings 里唯一），
 *   用名字查重既不需要迁移，也方便人在页面上认出来。
 *
 * @param {object} services
 * @param {{ id: string, name: string }} dept
 * @param {string} by
 * @returns {Promise<{ team?: object, created?: boolean, reason?: string }>}
 */
export async function ensureDeptTeam(services, dept, by = 'ui') {
  const teams = services?.teams
  if (!teams || typeof teams.create !== 'function') {
    return { reason: 'teams 服务不可用' }
  }
  const name = String(dept?.name ?? '').trim()
  if (!name) return { reason: '部门名为空' }

  try {
    const list = typeof teams.list === 'function' ? (teams.list({ type: 'big' }) ?? []) : []
    const hit = list.find((t) => t && t.name === name && t.status !== 'closed')
    if (hit) return { team: hit, created: false }
  } catch { /* 查失败就当作没有，往下建 */ }

  try {
    const bots = services?.roster?.list?.() ?? []
    const root = String(services?.settings?.botWorkspaceRoot ?? '').replace(/[\\/]+$/, '')
    const inDept = root
      ? bots.filter((b) => typeof b?.cwd === 'string' && isInsideDir(join(root, dept.id), b.cwd))
      : []

    // ── 主管：**只能人工指定**（2026-11-16 Boss：「不能设置拿部门里第一个 Bot」）──
    //
    //   配置项：`settings.departments[].leadBotName`（存名字不存 sessionId ——
    //   重建 Bot 会换 sessionId，名字稳定）。
    //
    //   找不到就**留空**，绝不自动挑一个。理由：
    //     自动挑第一个是「看起来能跑」的假象 —— 第一个 Bot 可能是不相关的岗，
    //     用户永远不知道"主管"到底是谁、也没机会改。
    //
    //   留空时用 Boss（`ui`）占位，因为：
    //     ⚠️ `teams.create` 要求 leadId **必填**（实测报「leadId 必须是非空字符串」）。
    //     ⚠️ leadId **不能**同时出现在 memberIds 里（「会形成自引用」）。
    const wantedLead = typeof dept?.leadBotName === 'string' ? dept.leadBotName.trim() : ''
    const leadBot = wantedLead ? inDept.find((b) => b.name === wantedLead) : undefined
    const leadId = leadBot ? (leadBot.sessionId ?? leadBot.id) : null
    const lead = leadId ?? 'ui'
    const memberIds = inDept
      .map((b) => b.sessionId ?? b.id)
      .filter((x) => typeof x === 'string' && x !== '' && x !== lead)

    const team = teams.create({
      name,
      type: 'big',
      kind: 'human',
      leadId: lead,
      memberIds,
      purpose: `部门「${name}」的组织单元；部门群聊挂在它的 roomId 上`,
      adminPolicy: 'lead-only',
      by,
    })
    return { team, created: true }
  } catch (error) {
    return { reason: `建团队失败：${error?.message ?? error}` }
  }
}

/**
 * 确保某个部门有一个「部门群聊」房间，并把它挂到团队上。
 *
 * 房间模式用 `everyone` —— **不能是 admin**：
 * Boss 要「在群聊里安排工作」，说话的人是 Boss 和各 Bot，不是某一个人的一言堂。
 * （这个坑 2026-11-12 在长任务议事厅上踩过：admin 模式只有群主能发言，
 *   结果执行者一条都汇报不进去。）
 *
 * @param {object} services
 * @param {{ id: string, name: string }} dept
 * @param {string} by
 * @returns {Promise<{ room?: object, created?: boolean, reason?: string }>}
 */
export async function ensureDeptRoom(services, dept, by = 'ui') {
  const rooms = services?.room
  if (!rooms || typeof rooms.create !== 'function') {
    return { reason: 'room 服务不可用' }
  }
  const name = deptRoomName(dept?.name)
  if (!name.trim()) return { reason: '部门名为空' }

  const got = await ensureDeptTeam(services, dept, by)
  if (!got.team) return { reason: got.reason ?? '没有可用的团队' }
  const team = got.team

  // ① 团队已有 roomId 且房间真的在 ⇒ 复用
  if (team.roomId) {
    try {
      const existing = rooms.get?.(team.roomId)
      if (existing) return { room: existing, created: false, team }
    } catch { /* 房间查不到就往下重建 */ }
  }

  // ② 按名字找已有的（防止团队 roomId 丢了但房间还在）
  try {
    const list = rooms.list?.({}) ?? []
    const hit = list.find((r) => r && r.name === name)
    if (hit) {
      attachTeamRoom(services, team, hit.id, by)
      return { room: rooms.get?.(hit.id) ?? hit, created: false, team }
    }
  } catch { /* 查失败就往下建 */ }

  // ③ 真建一个
  try {
    const bots = services?.roster?.list?.() ?? []
    const root = String(services?.settings?.botWorkspaceRoot ?? '').replace(/\/+$/, '')
    const inDept = root
      ? bots.filter((b) => typeof b?.cwd === 'string' && isInsideDir(join(root, dept.id), b.cwd))
      : []
    const members = [
      by,
      ...inDept.map((b) => b.sessionId ?? b.id),
      ...(Array.isArray(team.members) ? team.members : []),
      ...(team.leadId ? [team.leadId] : []),
    ].filter((v) => typeof v === 'string' && v !== '')

    const room = rooms.create({
      name,
      members: [...new Set(members)],
      // everyone：全员可发言（见上方注释）
      mode: 'everyone',
      purpose: `部门「${dept.name}」的群聊：Boss 在这里安排工作，成员在这里对齐`,
      // ★ deptId 标记「这是部门群聊」（2026-11-16）
      //   唤醒时据此走「主管优先」规则：有主管只唤醒主管，没有则唤醒全部。
      //   没有这个标记的普通房间仍按原 mentionOnly 规则走，互不影响。
      settings: { deptId: dept.id },
      byId: by,
    })
    attachTeamRoom(services, team, room.id, by)
    // ⚠️ 返回**刷新后**的团队：`team` 是建团队那一刻的快照，那时还没有 roomId。
    //    直接把旧快照交出去会让调用方读到 `team.roomId === undefined`（实测踩过），
    //    以为「房间没挂上」。
    let fresh = team
    try { fresh = services?.teams?.get?.(team.id) ?? team } catch { /* 拿不到就用旧快照 */ }
    return { room, created: true, team: fresh }
  } catch (error) {
    return { reason: `建群聊失败：${error?.message ?? error}`, team }
  }
}

/** 把房间挂到团队上（失败只忽略 —— 房间已经能用，关联丢了下次再补）。 */
function attachTeamRoom(services, team, roomId, by) {
  try {
    if (typeof services?.teams?.attachRoom !== 'function') return
    services.teams.attachRoom({
      id: team.id,
      roomId,
      by,
      // 传校验函数：attachRoom 会确认房间真实存在（防绑到打不开的房间上）
      roomExists: (rid) => Boolean(services?.room?.get?.(rid)),
    })
  } catch { /* 忽略 */ }
}

/**
 * 生成整棵「部门树」的快照，供左侧栏渲染。
 *
 * ## 返回结构
 * ```js
 * {
 *   departments: [{
 *     id, name,
 *     teamId, roomId,            // 可能为 null（建失败时）
 *     bots: [{ id, name, sessionId, state, preset }],
 *     unread: 0,                 // 该部门群聊未读数（暂以 0 占位，后续接 room.seq）
 *   }],
 *   total: { departments, bots },
 *   warnings: ['...'],            // 建失败的部门如实列出，不静默
 * }
 * ```
 *
 * ## 为什么不在这里建东西
 *   读接口应该**只读**。建团队/建房走显式的 `ensureDeptRoom`，
 *   由「进入部门」这类用户动作触发，不在每次刷新列表时都去建。
 *   ⇒ 本函数只查现有状态，缺的就返回 null 并给出提示。
 *
 * @param {object} services
 * @returns {object}
 */
export function buildDeptTree(services) {
  const depts = Array.isArray(services?.settings?.departments) ? services.settings.departments : []
  const root = String(services?.settings?.botWorkspaceRoot ?? '').replace(/\/+$/, '')
  const bots = services?.roster?.list?.() ?? []
  const teams = (() => {
    try { return services?.teams?.list?.({ type: 'big' }) ?? [] } catch { return [] }
  })()

  const warnings = []
  const departments = depts.map((d) => {
    // 该部门的 Bot：cwd 前缀为 `<root>/<deptId>/`
    const deptDir = root ? join(root, d.id) : ''
    const inDept = deptDir
      ? bots.filter((b) => typeof b?.cwd === 'string' && isInsideDir(deptDir, b.cwd))
      : []
      .map((b) => ({
        id: b.id,
        name: b.name,
        sessionId: b.sessionId,
        state: b.state,
        preset: b.preset ?? null,
        cwd: b.cwd,
      }))

    const team = teams.find((t) => t && t.name === d.name && t.status !== 'closed')
    if (!team) warnings.push(`部门「${d.name}」还没有对应团队（首次进入时会自动创建）`)
    const room = team?.roomId ? (() => {
      try { return services?.room?.get?.(team.roomId) } catch { return undefined }
    })() : undefined
    if (team && !room) warnings.push(`部门「${d.name}」的群聊还没建好（进入时会自动创建）`)

    return {
      id: d.id,
      name: d.name,
      teamId: team?.id ?? null,
      roomId: room?.id ?? null,
      // 未读数：房间 seq 与「用户读到哪」的差。当前没有读标记存储 ⇒ 先给 0，
      // 不编造数字（假红点比没有红点更糟）。
      unread: 0,
      bots: inDept,
    }
  })

  return {
    departments,
    total: {
      departments: departments.length,
      bots: departments.reduce((n, d) => n + d.bots.length, 0),
    },
    warnings,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 部门常驻会话（2026-11-16 方案A）
// ─────────────────────────────────────────────────────────────────────────────
//
// ## 为什么需要「常驻会话」
//
//   实测宿主 `dsh-workspace/lib/index.js:787`：
//   ```js
//   for (const group of groups) {            // groups 来自「按会话 header 的 cwd 分组」
//     if (id === void 0) {
//       const sessionIds = group.headers.map(...)
//       if (sessionIds.length === 0) continue;   // ← 空分组直接跳过，不重建
//     }
//   }
//   ```
//   **宿主每次启动都按「会话 header 的 cwd」重建 workspace 表，没有会话的分组不留。**
//   ⇒ 部门目录只登记不建会话，重启后就消失，左侧栏也就没有「部门」这一层。
//
// ## 做法
//
//   给每个部门建一个**专属会话**（cwd = 部门目录），并长期保留。
//   这样一个部门既是分组容器、又有常驻会话 ⇒ 重启后能被重建。
//   这个会话本身也是「部门群聊」的天然落点 —— Boss 可以直接在里面说话。
//
// ## 命名
//
//   统一用 `部门名 · 常驻`，避免和 Bot 名撞车（Bot 名在部门下一级，不会重名）。

/** 部门常驻会话的显示名后缀。 */
export const DEPT_SESSION_SUFFIX = ' · 常驻'

/**
 * 部门常驻会话的标准名。
 * @param {string} deptName
 * @returns {string}
 */
export function deptSessionName(deptName) {
  return `${String(deptName ?? '').trim()}${DEPT_SESSION_SUFFIX}`
}

/**
 * 确保某部门有一个常驻会话（幂等）。
 *
 * 判据：宿主的 workspace 表里，该部门目录的 `sessionIds` 非空。
 * 已有 ⇒ 直接复用；没有 ⇒ 建一个。
 *
 * @param {object} ctx
 * @param {object} services
 * @param {{id: string, name: string}} dept
 * @returns {Promise<{ok: boolean, sessionId?: string, created?: boolean, reason?: string}>}
 */
export async function ensureDeptSession(ctx, services, dept) {
  const root = String(services?.settings?.botWorkspaceRoot ?? '').replace(/\/+$/, '')
  if (!root) return { ok: false, reason: '主目录未设置' }
  const deptDir = join(root, dept?.id)
  if (!dept?.id) return { ok: false, reason: '部门 id 为空' }

  // ① 目录必须存在（宿主 create 要 realpath）
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(deptDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建部门目录失败：${error?.message ?? error}` }
  }

  // ② 已有会话就复用（问宿主，不自己猜）
  const { service } = await import('./kernel.js')
  let registry
  try { registry = service(ctx, 'workspaceRegistry') } catch { registry = undefined }
  if (registry && typeof registry.resolveByPath === 'function') {
    try {
      const ws = await registry.resolveByPath(deptDir)
      if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.length > 0) {
        // ⚠️ 宿主实体是只读投影，sessionIds 可能存在 record 里；
        //    用 `ws.sessionIds` 拿不到时退回下面「重建会话」路径。
        return { ok: true, sessionId: ws.sessionIds[0], created: false }
      }
    } catch { /* 查不到就往下建 */ }
  }

  // ③ 建一个常驻会话
  //
  // ⚠️ `createSession` 依赖宿主的 `agents` 服务，而**插件启动时它可能还没就绪**
  //    （2026-11-16 实测：「agents.create 不可用（宿主未提供 agents 服务）」）
  //    ⇒ 必须重试等待，不能一次失败就放弃。
  const { createSession, service: getService } = await import('./kernel.js')
  const { randomUUID } = await import('node:crypto')

  // ## 重试策略（2026-11-16 实测修正）
  //
  //   原先重试 20×500ms=10s，结果**全部超时**。根因是 Cordis 的作用域：
  //   `reflect._getImpl` 里 `const impl = this.store[key]; if (!impl) return`
  //   —— 服务没 provide 时永远 undefined，**等多久都不会变**。
  //
  //   ⇒ 只在**明确处于请求上下文**（服务已全装配）时才有意义。
  //     现在主调用点是 `GET /departments/tree`（请求时），那里一次就能成；
  //     启动时那段只做一次快速尝试（3×200ms），失败就交给请求时补。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const agents = (() => { try { return getService(ctx, 'agents') } catch { return undefined } })()
    if (agents && typeof agents.create === 'function') {
      try {
        const sessionId = `session-${randomUUID()}`
        await createSession(ctx, {
          sessionId,
          cwd: deptDir,
          agentOptions: { meta: { cwd: deptDir, title: deptSessionName(dept.name) } },
        })
        return { ok: true, sessionId, created: true }
      } catch (error) {
        return { ok: false, reason: `建部门常驻会话失败：${error?.message ?? error}` }
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 200) })
  }
  return {
    ok: false,
    skipped: true,
    reason: '当前上下文拿不到 agents 服务（启动阶段正常现象）；打开「部门」页时会自动补建',
  }
}
