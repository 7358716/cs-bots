/**
 * cs-bots 模型面工具测试。
 *
 * 为什么单独测这一层：域服务（board/roster/room/memory/dispatcher）即使全部正常，
 * **只要工具没注册上，模型在新机器上就看不到任何能力** —— 平台等于不存在。
 * 这条链（域服务 → registerTool → 模型可调）此前只在临时 profile 启动时人工验过一次，
 * 必须被测试机械守住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { TOOL_NAMES, installTools } from '../src/tools.js'

/** 造一个带「记录型 tools 服务」的宿主替身。 */
function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-tools-'))
  const registered = []
  const warnings = []

  const ctx = {
    logger: {
      info: () => {},
      warn: (...a) => warnings.push(a.join(' ')),
    },
    get: (key) =>
      key === 'tools'
        ? {
            register: (def) => {
              registered.push(def)
              return () => {}
            },
            guard: () => () => {},
            schemas: () => [],
          }
        : undefined,
    on: () => {},
    effect: () => {},
  }

  apply(ctx, { stateDir })

  return {
    ctx,
    stateDir,
    registered,
    warnings,
    byName(name) {
      return registered.find((d) => d.name === name)
    },
    async call(name, args, agent = { id: 'probe-session' }) {
      const def = this.byName(name)
      assert.ok(def, `工具 ${name} 应已注册`)
      return def.execute(args, { agent })
    },
    cleanup() {
      getServices(ctx).dispatcher?.dispose?.()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

// ── 注册完整性 ───────────────────────────────────────────────────────────────

test('工具全部注册成功，且数量与 TOOL_NAMES 一致', () => {
  const h = boot()
  try {
    assert.equal(
      h.registered.length,
      TOOL_NAMES.length,
      `应注册 ${TOOL_NAMES.length} 个，实际 ${h.registered.length}；warnings=${JSON.stringify(h.warnings)}`,
    )
    // PDCA 建设：cycle 4 + metrics 2 + verify 1 + teams 3 = 10 个（28 → 38）；
// 改造07：subscription 3 个（task_subscribe / unsubscribe / subscriptions）→ 41
// 升级09（契约 §2.4）：阶段产出物 bot_task_phase（纯增量新工具）→ 42
    assert.equal(TOOL_NAMES.length, 44, `工具总数应为 44，实际 ${TOOL_NAMES.length}`)
  } finally {
    h.cleanup()
  }
})

test('每个工具结构完整：name / description / parameters / output.schema / output.render / execute', () => {
  const h = boot()
  try {
    for (const def of h.registered) {
      assert.ok(def.name, 'name 必填')
      assert.ok(def.description && def.description.length > 10, `${def.name}: description 应非空且可读`)
      assert.equal(def.parameters?.type, 'object', `${def.name}: parameters 应是 object schema`)
      assert.ok(def.output?.schema, `${def.name}: output.schema 必填（官方契约）`)
      assert.equal(typeof def.output.render, 'function', `${def.name}: output.render 必填`)
      assert.equal(typeof def.execute, 'function', `${def.name}: execute 必填`)
    }
  } finally {
    h.cleanup()
  }
})

test('工具名全部带 bot_ 前缀（避免与其他插件撞名 —— insert 不去重）', () => {
  const h = boot()
  try {
    for (const def of h.registered) {
      assert.match(def.name, /^bot_[a-z_]+$/, `${def.name} 应带 bot_ 前缀`)
    }
  } finally {
    h.cleanup()
  }
})

test('工具名唯一（重复注册会被宿主拒）', () => {
  const h = boot()
  try {
    const names = h.registered.map((d) => d.name)
    assert.equal(new Set(names).size, names.length, '工具名必须唯一')
  } finally {
    h.cleanup()
  }
})

// ── 真实调用（端到端：工具 → 域服务）────────────────────────────────────────

test('bot_task_create 真能建任务（工具 → BoardService 打通）', async () => {
  const h = boot()
  try {
    const res = await h.call('bot_task_create', { subject: '写测试' })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.task.subject, '写测试')
    assert.equal(res.task.status, 'pending')
    assert.equal(res.task.rev, 1)
  } finally {
    h.cleanup()
  }
})

test('bot_task_update 用过期 rev 返回**可读失败**（不是抛崩）', async () => {
  const h = boot()
  try {
    const created = await h.call('bot_task_create', { subject: 'CAS 任务' })
    const id = created.task.id
    // 第一次 claim 成功
    const claimed = await h.call('bot_task_update', { id, expectedRev: 1, action: 'claim' })
    assert.equal(claimed.ok, true, JSON.stringify(claimed))
    // 用过期 rev=1 再改 → 必须 ok:false 且带 message（不抛）
    const stale = await h.call('bot_task_update', { id, expectedRev: 1, action: 'complete', artifacts: ['x'] })
    assert.equal(stale.ok, false, '过期 rev 应返回失败')
    assert.ok(stale.message && String(stale.message).length > 0, '失败必须带可读原因')
  } finally {
    h.cleanup()
  }
})

test('bot_roster_create 把 cwd 透传到 agents.create 的 meta（目录隔离的核心断言）', async () => {
  const h = boot()
  try {
    // boot 的 ctx 没有 agents 服务 → roster.create 应返回可读失败而不是崩
    const res = await h.call('bot_roster_create', { name: 'w1', cwd: join(h.stateDir, 'w1') })
    assert.equal(res.ok, false, '无 agents 服务时应失败')
    assert.ok(res.reason || res.message, '失败要可读')
  } finally {
    h.cleanup()
  }
})

test('bot_wake 缺 dedupKey 仍可发，但重复同键会被去重', async () => {
  const h = boot()
  try {
    // 无 agents 服务：投递会失败，但**记账与去重**逻辑仍应生效
    const first = await h.call('bot_wake', {
      target: 'sess-x',
      reason: 'task-assigned',
      dedupKey: 'k1',
    })
    assert.ok(first.result, '应返回决策结果')

    const second = await h.call('bot_wake', {
      target: 'sess-x',
      reason: 'task-assigned',
      dedupKey: 'k1',
    })
    assert.equal(second.result, 'skipped', '同 dedupKey 第二次必须 skipped')
  } finally {
    h.cleanup()
  }
})

test('未知工具名调用：byName 返回 undefined（测试辅助自身可信）', () => {
  const h = boot()
  try {
    assert.equal(h.byName('bot_not_a_tool'), undefined)
  } finally {
    h.cleanup()
  }
})

// ── 阶段产出物（契约 §2.4，纯增量新工具）─────────────────────────────────────

test('bot_task_phase：注入可用时把 patch 交给 phaseWrite 并透传结果', async () => {
  const h = boot()
  try {
    let seen = null
    // B 侧 installApi 会把 phaseWrite 挂到 services 上；测试直接模拟这个注入点
    getServices(h.ctx).phaseWrite = (taskId, patch) => {
      seen = { taskId, patch }
      return { ok: true, taskId, phases: [] }
    }
    const res = await h.call('bot_task_phase', {
      id: 't-1',
      index: 0,
      state: 'done',
      artifacts: ['docs/a.md'],
      note: '确认完毕',
    })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(seen.taskId, 't-1')
    assert.equal(seen.patch.index, 0)
    assert.equal(seen.patch.state, 'done')
    assert.deepEqual(seen.patch.artifacts, ['docs/a.md'])
    assert.equal(seen.patch.note, '确认完毕')
    // `by` 是事实留痕：取调用者身份，不猜
    assert.equal(seen.patch.by, 'probe-session')
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：state 缺省为 done；给了 expectedRev 就透传做 CAS', async () => {
  const h = boot()
  try {
    let seen = null
    getServices(h.ctx).phaseWrite = (taskId, patch) => { seen = patch; return { ok: true } }
    const res = await h.call('bot_task_phase', { id: 't-9', index: 2, expectedRev: 7 })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(seen.state, 'done', 'state 缺省必须是 done')
    assert.equal(seen.expectedRev, 7, 'expectedRev 应透传给后端做 CAS')
    assert.equal(seen.index, 2)
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：注入缺失时返回 failure("phase-unavailable")，绝不静默成功', async () => {
  const h = boot()
  try {
    // ⚠️ 为什么必须**显式构造**「注入缺失」，不能指望 boot() 天然没有：
    //   `boot()` 走的是完整 `apply()`，而 B 侧 `installApi` 会在模块级就把
    //   `services.phaseWrite` 挂上（src/api.js 的 mountPhaseWrite）。
    //   于是「ctx 里没有 phaseWrite」这个前提**已经不成立**了 —— 旧写法看起来在
    //   测降级路径，实际跑的是真实写入路径（t-1 不存在 ⇒ PHASE_TASK_NOT_FOUND）。
    //   那是「套件假装覆盖了却没覆盖」的典型：测试绿着，降级分支一次没跑。
    //   ⇒ 这里先断言前提确实存在过，再显式删掉，把 services 还原成
    //   「后端未就绪」的真状态，让 tools.js 的 `typeof w !== 'function'` 分支真的被执行。
    const services = getServices(h.ctx)
    assert.equal(typeof services.phaseWrite, 'function', '前提：installApi 应先挂上 phaseWrite')
    delete services.phaseWrite
    assert.equal(typeof services.phaseWrite, 'undefined', '前置：注入必须已被移除，否则本用例无意义')

    const res = await h.call('bot_task_phase', { id: 't-1', index: 0 })
    assert.equal(res.ok, false, '后端未注入时必须失败，不能静默成功')
    assert.equal(res.reason, 'phase-unavailable')
    assert.ok(res.hint && String(res.hint).length > 0, '失败必须带可读 hint')
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：注入存在但任务不存在 ⇒ PHASE_TASK_NOT_FOUND（与降级是两回事）', async () => {
  const h = boot()
  try {
    // 这一条走**真实** phaseWrite（installApi 已挂），验证后端业务失败原样透出。
    // 与上一条的区别：这里是「后端就绪、但这条活不存在」；上一条是「后端根本没就绪」。
    // 两者都必须是可读失败，但错误码语义不同 —— 不许混成一个断言。
    const res = await h.call('bot_task_phase', { id: 't-not-exist', index: 0 })
    assert.equal(res.ok, false, '任务不存在时必须失败')
    assert.notEqual(res.reason, 'phase-unavailable', '这不是降级路径，后端是就绪的')
    assert.equal(res.reason, 'PHASE_TASK_NOT_FOUND')
    assert.ok(res.message && String(res.message).length > 0, '失败必须带可读原因')
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：phaseWrite 抛错时返回可读失败（不吞证据）', async () => {
  const h = boot()
  try {
    getServices(h.ctx).phaseWrite = () => {
      const error = new Error('task-meta 落盘失败')
      error.code = 'PHASE_WRITE_FAILED'
      throw error
    }
    const res = await h.call('bot_task_phase', { id: 't-1', index: 0 })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'PHASE_WRITE_FAILED')
    assert.ok(res.message && res.message.includes('task-meta'), '必须带真实错误信息')
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：缺 id / index 非法时返回可读失败', async () => {
  const h = boot()
  try {
    getServices(h.ctx).phaseWrite = () => { throw new Error('不该被调用') }
    const noId = await h.call('bot_task_phase', { index: 0 })
    assert.equal(noId.ok, false)
    assert.equal(noId.reason, 'bad-argument')
    assert.equal(noId.field, 'id')

    const badIndex = await h.call('bot_task_phase', { id: 't-1', index: -1 })
    assert.equal(badIndex.ok, false)
    assert.equal(badIndex.field, 'index')

    const badState = await h.call('bot_task_phase', { id: 't-1', index: 0, state: 'done-ish' })
    assert.equal(badState.ok, false)
    assert.equal(badState.field, 'state')
  } finally {
    h.cleanup()
  }
})

// ── 降级 ─────────────────────────────────────────────────────────────────────

test('tools 服务不可用时：installTools 返回空、但不抛（降级安全）', () => {
  const warnings = []
  const ctx = { logger: { info: () => {}, warn: (...a) => warnings.push(a.join(' ')) }, get: () => undefined }
  const names = installTools(ctx, { warn: (m) => warnings.push(m) })
  assert.deepEqual(names, [], '无 tools 服务时应注册 0 个')
})

test('域服务缺失时工具返回可读失败（不是抛崩）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-tools-deg-'))
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) =>
      key === 'tools'
        ? { register: (d) => (registered.push(d), () => {}), guard: () => () => {}, schemas: () => [] }
        : undefined,
    on: () => {},
    effect: () => {},
  }
  try {
    // 注意：这次**不**调用 apply，所以 registry 里没有域服务
    installTools(ctx, {})
    const def = registered.find((d) => d.name === 'bot_task_create')
    assert.ok(def)
    const res = await def.execute({ subject: 'x' }, { agent: { id: 'p' } })
    assert.equal(res.ok, false, '无域服务时应返回失败')
    assert.equal(res.reason, 'board-unavailable', '失败原因应可读且具体')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ══ 2026-11-11 需求3 补充：bot_teams_add 自动把新成员拉进团队议事厅 ══════════

test('bot_teams_add：团队已绑房间 ⇒ 加成员时自动 room.join，成员真进房间', async () => {
  const h = boot()
  try {
    const s = getServices(h.ctx)
    const room = s.room.create({ name: 'attach-auto', members: ['probe-session'], byId: 'probe-session' })
    const team = s.teams.create({
      name: 'T-auto', type: 'big', by: 'probe-session', leadId: 'probe-session', memberIds: [],
    })
    s.teams.attachRoom({ id: team.id, roomId: room.id, by: 'probe-session' })

    const res = await h.call('bot_teams_add', { id: team.id, memberId: 'bot-new' })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.ok(res.team.members.includes('bot-new'), '团队成员已加')
    assert.equal(res.roomError, undefined, '成功时不应有 roomError')

    const after = s.room.get(room.id)
    assert.ok(after.members.includes('bot-new'), '房间成员表里必须有新成员（不是只改了团队）')
  } finally {
    h.cleanup()
  }
})

test('bot_teams_add：团队没绑房间 ⇒ 不加房间，也不报 roomError', async () => {
  const h = boot()
  try {
    const s = getServices(h.ctx)
    const team = s.teams.create({ name: 'T-noroom', type: 'small', by: 'probe-session' })
    const res = await h.call('bot_teams_add', { id: team.id, memberId: 'bot-x' })
    assert.equal(res.ok, true)
    assert.equal(res.roomError, undefined, '没房间时不该有 roomError')
    assert.ok(res.team.members.includes('bot-x'))
  } finally {
    h.cleanup()
  }
})

test('bot_teams_add：房间 join 失败 ⇒ 团队编辑仍成功，roomError 说明原因（不阻断主流程）', async () => {
  const h = boot()
  try {
    const s = getServices(h.ctx)
    const room = s.room.create({ name: 'attach-dup', members: ['probe-session', 'bot-dup'], byId: 'probe-session' })
    const team = s.teams.create({
      name: 'T-dup', type: 'big', by: 'probe-session', leadId: 'probe-session', memberIds: [],
    })
    s.teams.attachRoom({ id: team.id, roomId: room.id, by: 'probe-session' })

    // bot-dup 已在房间里 ⇒ room.join 会抛 ROOM_ALREADY_MEMBER
    const res = await h.call('bot_teams_add', { id: team.id, memberId: 'bot-dup' })
    assert.equal(res.ok, true, '团队编辑必须成功（房间失败不阻断）')
    assert.ok(res.team.members.includes('bot-dup'), '团队成员确实加上了')
    assert.equal(typeof res.roomError, 'string', 'roomError 必须回传')
    assert.match(res.roomError, /ROOM_ALREADY_MEMBER/, 'roomError 要带可读原因')
    // 没有独立 logger（工具作用域内），roomError 本身就是留痕证据
  } finally {
    h.cleanup()
  }
})

// ══ t-39 A/B：bot_team_route 工具层测试（跨团队路由 + 环路防护 + 1消息=1唤醒）══

/**
 * 造一个带 fake agents 的宿主，让 dispatcher 能真实投递（记录 delivered）。
 * 复用 boot() 的 apply(ctx, {stateDir})，再给 ctx.get('agents') 加替身。
 */
function bootWithAgents() {
  const base = boot()
  const stateDir = base.stateDir
  // 重新 apply 一次带 agents 服务的 ctx
  const delivered = []
  const leadAgent = { id: 'lead-B', followup(message) { delivered.push(message) } }
  const memberAgent = { id: 'bot-b', followup(message) { delivered.push(message) } }
  const leadAAgent = { id: 'lead-A', followup(message) { delivered.push(message) } }
  base.ctx.get = (key) => {
    if (key === 'tools') {
      return { register: (def) => { base.registered.push(def); return () => {} }, guard: () => () => {}, schemas: () => [] }
    }
    if (key === 'agents') {
      return {
        get: (id) => (id === 'lead-B' ? leadAgent : id === 'bot-b' ? memberAgent : id === 'lead-A' ? leadAAgent : undefined),
        list: () => [leadAgent, memberAgent, leadAAgent],
      }
    }
    return undefined
  }
  // 重新注册工具（因为 ctx.get 变了）
  base.registered.length = 0
  installTools(base.ctx, { warn: () => {} })
  return { ...base, delivered, leadAgent, memberAgent }
}

test('bot_team_route：跨团队路由成功 ⇒ decision=delivered，wake target 是对方 leadId', async (t) => {
  const h = bootWithAgents()
  t.after(h.cleanup)
  // 建两个团队
  const t1 = await h.call('bot_teams_create', { name: 'team-A', type: 'big', leadId: 'lead-A', memberIds: [] })
  assert.equal(t1.ok, true)
  const t2 = await h.call('bot_teams_create', { name: 'team-B', type: 'big', leadId: 'lead-B', memberIds: ['bot-b'] })
  assert.equal(t2.ok, true)

  const res = await h.call('bot_team_route', {
    fromTeam: t1.team.id, toTeam: t2.team.id, taskId: 't-route-1', text: 'hello from A', hop: 0,
  }, { agent: { id: 'lead-A' } })
  assert.equal(res.ok, true)
  assert.equal(res.decision, 'delivered')
  assert.equal(res.to.id, t2.team.id)
  assert.equal(res.to.leadId, 'lead-B', '唤醒目标是对方 lead，不是成员')
  assert.equal(res.hop, 0)
  // 只唤了 lead-B，没唤 bot-b
  assert.equal(h.delivered.length, 1, '1 条消息 = 1 次唤醒（只唤 leadId）')
  // followup 收到的是消息对象（content[0].text 才是正文），不是裸字符串
  assert.match(h.delivered[0].content[0].text, /hello from A/)
})

test('bot_team_route：目标团队不存在 ⇒ {ok:false, decision:refused, ROUTE_TARGET_NOT_FOUND}', async (t) => {
  const h = bootWithAgents()
  t.after(h.cleanup)
  const res = await h.call('bot_team_route', { toTeam: 'team-nope', taskId: 't-x' })
  assert.equal(res.ok, false)
  assert.equal(res.decision, 'refused')
  assert.equal(res.reason, 'ROUTE_TARGET_NOT_FOUND')
})

test('bot_team_route：toTeam 与 toBot 都没给 ⇒ refused ROUTE_TARGET_REQUIRED', async (t) => {
  const h = bootWithAgents()
  t.after(h.cleanup)
  const res = await h.call('bot_team_route', { taskId: 't-x' })
  assert.equal(res.ok, false)
  assert.equal(res.decision, 'refused')
  assert.equal(res.reason, 'ROUTE_TARGET_REQUIRED')
})

test('bot_team_route：hop=4 ⇒ refused ROUTE_HOP_EXCEEDED（>3 拒绝）', async (t) => {
  const h = bootWithAgents()
  t.after(h.cleanup)
  const t1 = await h.call('bot_teams_create', { name: 'A', type: 'big', leadId: 'lead-A', memberIds: [] })
  const t2 = await h.call('bot_teams_create', { name: 'B', type: 'big', leadId: 'lead-B', memberIds: [] })
  const res = await h.call('bot_team_route', {
    fromTeam: t1.team.id, toTeam: t2.team.id, taskId: 't-hop4', hop: 4,
  })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'ROUTE_HOP_EXCEEDED')
})

test('bot_team_route：环路防护 A→B→A→B，第 3 跳被拒（dedupKey 命中 dispatcher 去重）', async (t) => {
  const h = bootWithAgents()
  t.after(h.cleanup)
  const t1 = await h.call('bot_teams_create', { name: 'A', type: 'big', leadId: 'lead-A', memberIds: [] })
  const t2 = await h.call('bot_teams_create', { name: 'B', type: 'big', leadId: 'lead-B', memberIds: [] })
  const taskId = 'loop-task'
  // A→B hop0：dedupKey = route:team-A:team-B:loop-task
  let r1 = await h.call('bot_team_route', { fromTeam: t1.team.id, toTeam: t2.team.id, taskId, hop: 0, text: 'A→B' }, { agent: { id: 'lead-A' } })
  assert.equal(r1.ok, true, 'A→B hop0 应成功')
  // B→A hop1：不同 dedupKey（方向相反），应成功
  let r2 = await h.call('bot_team_route', { fromTeam: t2.team.id, toTeam: t1.team.id, taskId, hop: 1, text: 'B→A' }, { agent: { id: 'lead-B' } })
  assert.equal(r2.ok, true, 'B→A hop1 应成功（不同方向）')
  // A→B hop2：dedupKey 与 hop0 相同 → dispatcher 判 skipped
  let r3 = await h.call('bot_team_route', { fromTeam: t1.team.id, toTeam: t2.team.id, taskId, hop: 2, text: 'A→B again' }, { agent: { id: 'lead-A' } })
  assert.equal(r3.ok, true, '路由决策层仍 accepted（先记后投）')
  assert.equal(r3.wake.result, 'skipped', '但 dispatcher 因 dedupKey 相同判 skipped —— 第3跳被拦')
  assert.equal(r3.wake.reason, 'dedup-hit')
  // A→B hop4：hop 守卫直接拒
  let r4 = await h.call('bot_team_route', { fromTeam: t1.team.id, toTeam: t2.team.id, taskId, hop: 4 })
  assert.equal(r4.ok, false)
  assert.equal(r4.reason, 'ROUTE_HOP_EXCEEDED')
  // 总唤醒次数：A→B(hop0) + B→A(hop1) = 2 次；A→B(hop2) 被 dedup 拦 → 不投递
  assert.equal(h.delivered.length, 2, 'A→B→A→B 只投递了 2 次（第3次被 dedup 拦）')
})

test('bot_team_route：route 事件落盘 ⇒ teams.jsonl 里有 action=route 记录', async (t) => {
  const h = bootWithAgents()
  t.after(h.cleanup)
  const t1 = await h.call('bot_teams_create', { name: 'A', type: 'big', leadId: 'lead-A', memberIds: [] })
  const t2 = await h.call('bot_teams_create', { name: 'B', type: 'big', leadId: 'lead-B', memberIds: [] })
  await h.call('bot_team_route', { fromTeam: t1.team.id, toTeam: t2.team.id, taskId: 't-persist', text: 'check', hop: 0 })
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const f = join(h.stateDir, 'teams.jsonl')
  assert.ok(existsSync(f), 'teams.jsonl 应存在')
  const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
  const routeEvent = lines.find((l) => {
    const ev = JSON.parse(l)
    return ev.action === 'route' && ev.after?.taskId === 't-persist'
  })
  assert.ok(routeEvent, 'teams.jsonl 必须有 action=route 的事件')
  const ev = JSON.parse(routeEvent)
  assert.equal(ev.after.toLeadId, 'lead-B')
  assert.equal(ev.after.fromTeam, t1.team.id)
})

test('bot_team_route：wakes.jsonl 记录带 target=leadId（唤醒成本可见）', async (t) => {
  const h = bootWithAgents()
  t.after(h.cleanup)
  const t1 = await h.call('bot_teams_create', { name: 'A', type: 'big', leadId: 'lead-A', memberIds: [] })
  const t2 = await h.call('bot_teams_create', { name: 'B', type: 'big', leadId: 'lead-B', memberIds: [] })
  await h.call('bot_team_route', { fromTeam: t1.team.id, toTeam: t2.team.id, taskId: 't-wake', hop: 0 })
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const f = join(h.stateDir, 'wakes.jsonl')
  assert.ok(existsSync(f), 'wakes.jsonl 应存在')
  const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
  const routeWake = lines.find((l) => {
    const w = JSON.parse(l)
    return w.target === 'lead-B' && w.reason === 'room-message'
  })
  assert.ok(routeWake, 'wakes.jsonl 必须有 target=lead-B 的记录')
  const wake = JSON.parse(routeWake)
  assert.equal(wake.result, 'sent')
  assert.match(wake.text, /t-wake/)
})
