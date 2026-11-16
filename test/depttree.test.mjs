/**
 * 部门树（部门 ↔ 团队 ↔ 房间）测试 —— 左侧栏分层 UI 的数据底座。
 *
 * 需求出处（Boss 2026-11-15）：
 *   「按部门管理…把部门作为一个群聊映射到左侧栏，我希望我可以在群聊里安排工作」
 *
 * 这两个坑都是实测出来的，测试钉住它们：
 *   ① teams.create 的 leadId 必填 —— 部门刚建没 Bot 时会 400
 *   ② leadId 不能同时出现在 memberIds —— 否则「自引用」被拒
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRoster } from '../src/roster.js'
import { createTeams } from '../src/teams.js'
import { createRoom } from '../src/room.js'
import { buildDeptTree, ensureDeptRoom, ensureDeptTeam, deptRoomName, DEPT_ROOM_SUFFIX } from '../src/depttree.js'

let counter = 0

function setup(t) {
  const base = mkdtempSync(join(tmpdir(), `cs-bots-dept-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* */ } })
  const root = join(base, 'cs-bots')
  const depts = [{ id: 'dev', name: '开发部' }, { id: 'qa', name: '测试部' }]
  for (const d of depts) mkdirSync(join(root, d.id), { recursive: true })

  let seq = 0
  const agents = {
    live: new Set(),
    async create(r) { const id = r?.sessionId ?? `bot-x${++seq}`; agents.live.add(id); return { id, sessionId: id } },
    get: (i) => (agents.live.has(i) ? { id: i, sessionId: i } : undefined),
    list: () => [...agents.live].map((i) => ({ id: i, sessionId: i })),
  }
  const ctx = { logger: { info() {}, warn() {} }, get: (k) => (k === 'agents' ? agents : undefined), on() {}, effect() {} }

  const roster = createRoster(ctx, { stateDir: join(base, 'roster'), botsRoot: root, departments: depts })
  const teams = createTeams(ctx, { stateDir: join(base, 'teams') })
  const room = createRoom(ctx, { stateDir: join(base, 'rooms') })
  return { base, root, depts, services: { roster, teams, room, settings: { departments: depts, botWorkspaceRoot: root } } }
}

test('deptRoomName：统一的部门群聊命名', () => {
  assert.equal(deptRoomName('开发部'), '开发部 · 部门群聊')
  assert.ok(DEPT_ROOM_SUFFIX.includes('部门群聊'))
})

test('ensureDeptTeam：部门没 Bot 时也能建团队（leadId 用 Boss 兜底）', async (t) => {
  const { services, depts } = setup(t)
  const r = await ensureDeptTeam(services, depts[0], 'ui')
  assert.ok(r.team, `建团队失败：${r.reason}`)
  assert.equal(r.created, true)
  assert.equal(r.team.leadId, 'ui', '没有 Bot 时由 Boss 兜底当负责人')
})

test('★ ensureDeptTeam：**不自动拿第一个 Bot 当主管**（Boss：需要人工设置）', async (t) => {
  // 2026-11-16 Boss：「不能设置拿部门里第一个 Bot，需要人工设置」
  // 旧实现取 inDept[0] —— 用户永远不知道"主管"是谁、也没机会改。
  const { services, depts } = setup(t)
  await services.roster.create({ name: '开发执行岗', department: 'dev', byId: 'ui' })
  const r = await ensureDeptTeam(services, depts[0], 'ui')
  assert.ok(r.team, `建团队失败：${r.reason}`)
  assert.equal(r.team.leadId, 'ui', '没人工设主管时用 Boss 占位（绝不自动挑 Bot）')
})

test('★ ensureDeptTeam：人工设了 leadBotName ⇒ 用它当主管', async (t) => {
  const { services, depts } = setup(t)
  const bot = await services.roster.create({ name: '开发执行岗', department: 'dev', byId: 'ui' })
  // 人工指定主管
  const deptWithLead = { ...depts[0], leadBotName: '开发执行岗' }
  const r = await ensureDeptTeam(services, deptWithLead, 'ui')
  assert.ok(r.team, `建团队失败：${r.reason}`)
  assert.equal(r.team.leadId, bot.sessionId, '主管应是人工指定的那个 Bot')
  assert.ok(
    !(r.team.members ?? []).includes(r.team.leadId),
    'leadId 不能同时出现在 memberIds（会形成自引用）',
  )
})

test('★ ensureDeptTeam：leadBotName 指向不存在的 Bot ⇒ 回退 Boss，不报错', async (t) => {
  const { services, depts } = setup(t)
  await services.roster.create({ name: '开发执行岗', department: 'dev', byId: 'ui' })
  const deptWithBadLead = { ...depts[0], leadBotName: '不存在的岗' }
  const r = await ensureDeptTeam(services, deptWithBadLead, 'ui')
  assert.ok(r.team, `不该因为主管名不存在就建不出团队：${r.reason}`)
  assert.equal(r.team.leadId, 'ui', '找不到就回退 Boss')
})

test('ensureDeptTeam：幂等 —— 重复调用复用同一团队', async (t) => {
  const { services, depts } = setup(t)
  const a = await ensureDeptTeam(services, depts[0], 'ui')
  const b = await ensureDeptTeam(services, depts[0], 'ui')
  assert.equal(b.created, false)
  assert.equal(a.team.id, b.team.id)
})

test('ensureDeptRoom：建出 everyone 模式的部门群聊，并挂到团队上', async (t) => {
  const { services, depts } = setup(t)
  const r = await ensureDeptRoom(services, depts[0], 'ui')
  assert.ok(r.room, `建群聊失败：${r.reason}`)
  assert.equal(r.room.mode, 'everyone', '必须全员可发言（admin 模式只有群主能说，执行者汇报不进来）')
  assert.equal(r.room.name, '开发部 · 部门群聊')
  const team = r.team
  assert.equal(team.roomId, r.room.id, '房间必须挂到团队上')
})

test('ensureDeptRoom：Boss 能在部门群聊里发言（「在群聊里安排工作」的前提）', async (t) => {
  const { services, depts } = setup(t)
  const r = await ensureDeptRoom(services, depts[0], 'ui')
  const msg = services.room.post({ roomId: r.room.id, from: 'ui', text: '登录接口谁来接？' })
  assert.ok(msg.id, 'Boss 必须能发消息')
})

test('ensureDeptRoom：幂等 —— 第二次不新建房间', async (t) => {
  const { services, depts } = setup(t)
  const a = await ensureDeptRoom(services, depts[0], 'ui')
  const b = await ensureDeptRoom(services, depts[0], 'ui')
  assert.equal(b.created, false, '不能重复建群聊')
  assert.equal(a.room.id, b.room.id)
})

test('buildDeptTree：按部门归类 Bot（cwd 前缀匹配）', async (t) => {
  const { services, depts } = setup(t)
  await services.roster.create({ name: '开发执行岗', department: 'dev', byId: 'ui' })
  await services.roster.create({ name: '开发诊断岗', department: 'dev', byId: 'ui' })
  await services.roster.create({ name: '测试员', department: 'qa', byId: 'ui' })

  const tree = buildDeptTree(services)
  const dev = tree.departments.find((d) => d.id === 'dev')
  const qa = tree.departments.find((d) => d.id === 'qa')
  assert.equal(dev.bots.length, 2, '开发部应有 2 个 Bot')
  assert.equal(qa.bots.length, 1, '测试部应有 1 个 Bot')
  assert.equal(tree.total.bots, 3)
})

test('buildDeptTree：只读 —— 不该自己建团队或房间', async (t) => {
  const { services, depts } = setup(t)
  const before = services.teams.list({ type: 'big' }).length
  buildDeptTree(services)
  const after = services.teams.list({ type: 'big' }).length
  assert.equal(after, before, '读接口不该有写副作用')
  assert.equal(services.room.list({}).length, 0, '不该凭空建房')
  // 但要把「还没建」如实告警出来
  const tree = buildDeptTree(services)
  assert.ok(tree.warnings.length > 0, '缺团队/房间必须如实告警，不静默')
})

test('buildDeptTree：建完之后 warnings 清空，且 roomId 可查', async (t) => {
  const { services, depts } = setup(t)
  for (const d of depts) await ensureDeptRoom(services, d, 'ui')
  const tree = buildDeptTree(services)
  assert.equal(tree.warnings.length, 0, `不该再有警告：${JSON.stringify(tree.warnings)}`)
  assert.ok(tree.departments.every((d) => d.roomId), '每个部门都应有群聊 roomId')
})

// ── HTTP 层：部门树与群聊（2026-11-15 左侧栏分层 UI）────────────────────

test('buildDeptTree：部门群聊建好后，树的 roomId 可查且 warnings 减少', async (t) => {
  const { services, depts } = setup(t)
  const before = buildDeptTree(services).warnings.length
  await ensureDeptRoom(services, depts[0], 'ui')
  const after = buildDeptTree(services)
  assert.ok(after.warnings.length < before, '建好一个部门后警告应变少')
  assert.ok(after.departments.find((d) => d.id === 'dev')?.roomId, 'dev 的 roomId 应可查')
})

// ── 部门管理：保护「有 Bot 的部门不许删」────────────────────────────────────

test('部门管理：删部门前必须检查该部门下是否还有 Bot（cwd 前缀判定）', async (t) => {
  const { services, depts, root } = setup(t)
  await services.roster.create({ name: '开发执行岗', department: 'dev', byId: 'ui' })

  const bots = services.roster.list()
  const inDev = bots.filter((b) => typeof b?.cwd === 'string' && b.cwd.startsWith(`${root}/dev/`))
  assert.equal(inDev.length, 1, 'dev 部门下应有 1 个 Bot')
  // 这正是 /departments/save 用来决定「能不能删」的判据
  assert.ok(inDev[0].cwd.includes('/dev/'))
})

test('部门管理：改名后部门名与团队名应保持一致（depttree 用名字查团队）', async (t) => {
  const { services, depts } = setup(t)
  const r = await ensureDeptTeam(services, depts[0], 'ui')
  assert.equal(r.team.name, depts[0].name, '团队名 = 部门名，这是 depttree 的查找约定')
})

// ── 部门群聊唤醒规则（2026-11-16 Boss）────────────────────────────────────
// 「我说话只唤醒部门主任（主管），没有主管的话唤醒全部，有主管的话由主管处理」

test('★ 部门群聊：有主管 ⇒ 只唤醒主管一个人', async (t) => {
  const { services, depts } = setup(t)
  await services.roster.create({ name: '开发执行岗', department: 'dev', byId: 'ui' })
  const room = await ensureDeptRoom(services, { ...depts[0], leadBotName: '开发执行岗' }, 'ui')
  assert.ok(room.room, room.reason)
  assert.equal(room.room.settings?.deptId, 'dev', '部门群聊要带 deptId 标记')
  // 主管必须是**群成员**才可能被唤醒（不在群里的 id 不算）
  const lead = room.room.members.find((m) => m.startsWith('bot-'))
  assert.ok(lead, '房间应有 Bot 成员')
  const decided = services.room.computeWakeTargets(
    { members: room.room.members, settings: room.room.settings },
    { from: 'ui', text: '大家好' },
    { deptLeadId: lead },
  )
  assert.deepEqual(decided.targets, [lead], '有主管只唤醒主管一个')
  assert.equal(decided.source, 'dept-lead')

  // 主管不在群成员里 ⇒ 视为没有主管，退回广播
  const noLead = services.room.computeWakeTargets(
    { members: room.room.members, settings: room.room.settings },
    { from: 'ui', text: '大家好' },
    { deptLeadId: 'bot-not-in-room' },
  )
  assert.equal(noLead.source, 'dept-broadcast', '主管不在群里时退回广播')
})

test('★ 部门群聊：没主管 ⇒ 唤醒全部可唤醒成员', async (t) => {
  const { services, depts } = setup(t)
  // 先建两个 Bot，否则房间里只有 ui（人类），没有可唤醒对象
  await services.roster.create({ name: '甲岗', department: 'dev', byId: 'ui' })
  await services.roster.create({ name: '乙岗', department: 'dev', byId: 'ui' })
  const room = await ensureDeptRoom(services, depts[0], 'ui')
  assert.ok(room.room, room.reason)
  const decided = services.room.computeWakeTargets(
    { members: room.room.members, settings: room.room.settings },
    { from: 'ui', text: '大家好' },
    { deptLeadId: null },
  )
  assert.equal(decided.source, 'dept-broadcast')
  assert.ok(decided.targets.length >= 1, '应唤醒全部 Bot')
  assert.ok(!decided.targets.includes('ui'), '不唤醒人类/发送者')
})

test('★ 部门群聊：显式 @ 优先于主管（@ 谁就唤醒谁）', async (t) => {
  const { services, depts } = setup(t)
  await services.roster.create({ name: '开发执行岗', department: 'dev', byId: 'ui' })
  const room = await ensureDeptRoom(services, { ...depts[0], leadBotName: '开发执行岗' }, 'ui')
  assert.ok(room.room, room.reason)
  const botMember = room.room.members.find((m) => m.startsWith('bot-'))
  assert.ok(botMember, '房间应有 Bot 成员')
  const decided = services.room.computeWakeTargets(
    { members: room.room.members, settings: room.room.settings },
    { from: 'ui', text: '你好', mentions: [botMember] },
    { deptLeadId: 'bot-lead-1' },
  )
  assert.equal(decided.source, 'mention', '@ 优先于主管')
  assert.deepEqual(decided.targets, [botMember])
})
