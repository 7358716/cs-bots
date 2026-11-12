/**
 * TeamsService 测试 —— 大/小团队统一层。
 *
 * 重点：big 团队必须带 leadId、lead 不能与 members 自引用、跳步/重复成员拒绝。
 * 运行：`node --test test/teams.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createTeams, { TeamError, TEAM_TYPES, TEAM_ROLES } from '../src/teams.js'

let counter = 0
function setup(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), `cs-bots-teams-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const svc = createTeams({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

function readEvents(dir) {
  const f = join(dir, 'teams.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('create big 团队必须带 leadId', (t) => {
  const { svc } = setup(t)
  assert.throws(
    () => svc.create({ name: 'X', type: 'big', by: 'user' }),
    (e) => e instanceof TeamError && e.code === 'TEAM_BAD_FIELD',
  )
})

test('create small 团队 leadId 可选', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: '临时小组', type: 'small', by: 'bot' })
  assert.equal(team.type, 'small')
  assert.equal(team.leadId, null)
})

test('create 非法 type 抛 TEAM_BAD_TYPE', (t) => {
  const { svc } = setup(t)
  assert.throws(
    () => svc.create({ name: 'X', type: 'weird', leadId: 'lead-1', by: 'user' }),
    (e) => e.code === 'TEAM_BAD_TYPE',
  )
})

test('lead 不能同时在 memberIds（自引用拒绝）', (t) => {
  const { svc } = setup(t)
  assert.throws(
    () => svc.create({ name: 'X', type: 'big', leadId: 'lead-1', memberIds: ['lead-1'], by: 'user' }),
    (e) => e.code === 'TEAM_BAD_FIELD',
  )
})

test('addMember / removeMember / list', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: 'T', type: 'big', leadId: 'lead-1', by: 'user' })
  const t2 = svc.addMember({ id: team.id, expectedRev: team.rev, memberId: 'bot-a', by: 'lead-1' })
  assert.deepEqual(t2.members, ['bot-a'])
  const t3 = svc.addMember({ id: team.id, expectedRev: t2.rev, memberId: 'bot-b', by: 'lead-1' })
  assert.equal(t3.members.length, 2)
  const t4 = svc.removeMember({ id: team.id, expectedRev: t3.rev, memberId: 'bot-a', by: 'lead-1' })
  assert.deepEqual(t4.members, ['bot-b'])
  assert.equal(svc.list({ status: 'open' }).length, 1)
})

test('重复 addMember 拒绝', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: 'T', type: 'big', leadId: 'lead-1', memberIds: ['bot-a'], by: 'user' })
  assert.throws(
    () => svc.addMember({ id: team.id, expectedRev: team.rev, memberId: 'bot-a', by: 'lead-1' }),
    (e) => e.code === 'TEAM_DUPLICATE_MEMBER',
  )
})

test('setRole 换 lead（原 lead 降级为 member）', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: 'T', type: 'big', leadId: 'lead-1', memberIds: ['bot-a'], by: 'user' })
  const t2 = svc.setRole({ id: team.id, expectedRev: team.rev, memberId: 'bot-a', role: 'lead', by: 'user' })
  assert.equal(t2.leadId, 'bot-a')
  assert.ok(t2.members.includes('lead-1'))
})

test('note 追加留痕（append-only 语义）', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: 'T', type: 'big', leadId: 'lead-1', by: 'user' })
  const t2 = svc.note({ id: team.id, expectedRev: team.rev, note: '第一次变更', by: 'user' })
  assert.equal(t2.notes.length, 1)
  assert.equal(t2.notes[0].text, '第一次变更')
  const t3 = svc.note({ id: team.id, expectedRev: t2.rev, note: '第二次变更', by: 'user' })
  assert.equal(t3.notes.length, 2)
})

test('note 超长拒绝', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: 'T', type: 'big', leadId: 'lead-1', by: 'user' })
  assert.throws(
    () => svc.note({ id: team.id, expectedRev: team.rev, note: 'x'.repeat(5000), by: 'user' }),
    (e) => e.code === 'TEAM_BAD_FIELD',
  )
})

test('close 后不可 addMember', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: 'T', type: 'big', leadId: 'lead-1', by: 'user' })
  const t2 = svc.close({ id: team.id, expectedRev: team.rev, by: 'user' })
  assert.equal(t2.status, 'closed')
  assert.ok(t2.closedAt)
  assert.throws(
    () => svc.addMember({ id: team.id, expectedRev: t2.rev, memberId: 'bot-z', by: 'user' }),
    (e) => e.code === 'TEAM_CLOSED',
  )
})

test('setRole 非法 role 抛 TEAM_BAD_ROLE', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: 'T', type: 'big', leadId: 'lead-1', by: 'user' })
  assert.throws(
    () => svc.setRole({ id: team.id, expectedRev: team.rev, memberId: 'bot-a', role: 'dictator', by: 'user' }),
    (e) => e.code === 'TEAM_BAD_ROLE',
  )
})

test('replay 从 jsonl 重建', (t) => {
  const { dir, svc } = setup(t)
  svc.create({ name: 'T', type: 'big', leadId: 'lead-1', by: 'user' })
  const fresh = createTeams({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(fresh.stats().total, 1)
  assert.equal(fresh.replay().from, 'jsonl')
})

test('坏行不静默', (t) => {
  const { dir } = setup(t)
  appendFileSync(join(dir, 'teams.jsonl'), 'broken\n')
  const rep = createTeams({ logger: { info() {}, warn() {} } }, { stateDir: dir }).replay()
  assert.equal(rep.bad, 1)
})

test('dispose 后抛 TEAM_DISPOSED', (t) => {
  const { svc } = setup(t)
  svc.dispose()
  assert.throws(() => svc.list(), (e) => e.code === 'TEAM_DISPOSED')
})

test('stats 按 type/status 聚合', (t) => {
  const { svc } = setup(t)
  svc.create({ name: 'big1', type: 'big', leadId: 'l1', by: 'user' })
  svc.create({ name: 'small1', type: 'small', by: 'bot' })
  const st = svc.stats()
  assert.equal(st.byType.big, 1)
  assert.equal(st.byType.small, 1)
  assert.equal(st.byStatus.open, 2)
})

test('TEAM_TYPES / TEAM_ROLES 冻结', () => {
  assert.deepEqual([...TEAM_TYPES], ['big', 'small'])
  assert.deepEqual([...TEAM_ROLES], ['lead', 'member'])
})

// ── 团队管理员权限边界（2026-11-09「管理员权限边界从页面控制」）──────────────
// 背景：`src/teams.js` 在 8e613e1 就引入了 adminPolicy，但**零测试覆盖**。
// 权限是安全边界，没测试等于没实现 —— 这里把 10 条行为锁成不变量。

test('adminPolicy：缺省为 open（升级不改变既有行为）', async (_t) => {
  const { svc } = setup(_t)
  const s = svc
  const t = s.create({ name: 'T', type: 'big', by: 'ui', leadId: 'bot-lead', memberIds: ['bot-a'] })
  assert.equal(t.adminPolicy, 'open', '缺省必须是 open，否则所有既有调用方都会被拒')
})

test('adminPolicy：非法值直接拒绝，绝不静默降级', async (_t) => {
  const { svc } = setup(_t)
  const s = svc
  assert.throws(
    () => s.create({ name: 'T', type: 'big', by: 'ui', leadId: 'x', adminPolicy: 'bogus' }),
    (e) => e.code === 'TEAM_BAD_POLICY',
  )
})

test('adminPolicy=lead-only：非负责人调 removeMember 被拒（TEAM_FORBIDDEN）', async (_t) => {
  const { svc } = setup(_t)
  const s = svc
  const t = s.create({ name: 'T', type: 'big', by: 'ui', leadId: 'bot-lead', memberIds: ['bot-a', 'bot-b'], adminPolicy: 'lead-only' })
  assert.throws(
    () => s.removeMember({ id: t.id, memberId: 'bot-b', expectedRev: t.rev, by: 'bot-a' }),
    (e) => e.code === 'TEAM_FORBIDDEN',
  )
})

test('adminPolicy=lead-only：负责人自己可以管理', async (_t) => {
  const { svc } = setup(_t)
  const s = svc
  const t = s.create({ name: 'T', type: 'big', by: 'ui', leadId: 'bot-lead', memberIds: ['bot-a', 'bot-b'], adminPolicy: 'lead-only' })
  const out = s.removeMember({ id: t.id, memberId: 'bot-b', expectedRev: t.rev, by: 'bot-lead' })
  assert.ok(!out.members.includes('bot-b'))
})

test('adminPolicy：人（ui）永远是超级管理员，不受任何策略限制', async (_t) => {
  const { svc } = setup(_t)
  const s = svc
  const t = s.create({ name: 'T', type: 'big', by: 'ui', leadId: 'bot-lead', memberIds: ['bot-a'], adminPolicy: 'lead-only' })
  const out = s.addMember({ id: t.id, memberId: 'bot-c', expectedRev: t.rev, by: 'ui' })
  assert.ok(out.members.includes('bot-c'), '人必须能操作 lead-only 团队')
})

test('adminPolicy=any-member：成员可管理，非成员被拒', async (_t) => {
  const { svc } = setup(_t)
  const s = svc
  const t = s.create({ name: 'T', type: 'big', by: 'ui', leadId: 'bot-lead', memberIds: ['bot-a'], adminPolicy: 'any-member' })
  const afterAdd = s.addMember({ id: t.id, memberId: 'bot-d', expectedRev: t.rev, by: 'bot-a' })
  assert.ok(afterAdd.members.includes('bot-d'), '成员应能加成员')
  assert.throws(
    () => s.addMember({ id: t.id, memberId: 'bot-e', expectedRev: afterAdd.rev, by: 'bot-outsider' }),
    (e) => e.code === 'TEAM_FORBIDDEN',
  )
})

test('不变量：负责人永不可被移出（与 adminPolicy 无关，人是超级管理员也不行）', async (_t) => {
  const { svc } = setup(_t)
  const s = svc
  for (const policy of ['open', 'lead-only', 'any-member']) {
    const t = s.create({ name: `T-${policy}`, type: 'big', by: 'ui', leadId: 'bot-lead', memberIds: ['bot-a'], adminPolicy: policy })
    assert.throws(
      () => s.removeMember({ id: t.id, memberId: 'bot-lead', expectedRev: t.rev, by: 'ui' }),
      (e) => e.code === 'TEAM_LEAD_IMMUTABLE',
      `策略 ${policy} 下负责人竟可被移除`,
    )
  }
})

test('setPolicy：改策略本身留痕，且策略立即生效', async (_t) => {
  const { svc: _svc, dir: _t_dir } = setup(_t)
  const s = _svc
  const t = s.create({ name: 'T', type: 'big', by: 'ui', leadId: 'bot-lead', memberIds: ['bot-a', 'bot-b'], adminPolicy: 'open' })
  const out = s.setPolicy({ id: t.id, expectedRev: t.rev, adminPolicy: 'lead-only', by: 'ui' })
  assert.equal(out.adminPolicy, 'lead-only')
  // 改完立刻生效：非负责人不能再操作
  assert.throws(
    () => s.removeMember({ id: t.id, memberId: 'bot-b', expectedRev: out.rev, by: 'bot-a' }),
    (e) => e.code === 'TEAM_FORBIDDEN',
  )
  // 且事件流里有 setPolicy 事件（留痕是审计底线）
  assert.ok(readEvents(_t_dir).some((e) => e.action === 'setPolicy'), '策略变更必须留痕')
})

// ══ 2026-11-11 需求3：kind = human | agent（服务层强制推导，防伪造）══════════

test('kind：Boss（ui/user/person）建的团队 ⇒ human', (t) => {
  const { svc } = setup(t)
  for (const bossId of ['ui', 'user', 'person']) {
    const team = svc.create({ name: `by-${bossId}`, type: 'small', by: bossId })
    assert.equal(team.kind, 'human', `by=${bossId} 推导为 human`)
  }
})

test('kind：Bot（会话 id）建的团队 ⇒ agent', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: 'bot-team', type: 'small', by: 'bot-6b654c19' })
  assert.equal(team.kind, 'agent', '非 HUMAN_IDS ⇒ agent')
})

test('kind：显式传与推导矛盾的 kind ⇒ 抛 TEAM_KIND_MISMATCH（不许伪造）', (t) => {
  const { svc } = setup(t)
  // Bot 谎称自己是人建的团队
  assert.throws(
    () => svc.create({ name: 'fake-human', type: 'small', by: 'bot-x', kind: 'human' }),
    (e) => e instanceof TeamError && e.code === 'TEAM_KIND_MISMATCH',
  )
  // Boss 谎称是 Bot 建的
  assert.throws(
    () => svc.create({ name: 'fake-agent', type: 'small', by: 'ui', kind: 'agent' }),
    (e) => e instanceof TeamError && e.code === 'TEAM_KIND_MISMATCH',
  )
  // 显式传与服务层推导一致的 kind ⇒ 放行（不误伤）
  const ok = svc.create({ name: 'consistent-agent', type: 'small', by: 'bot-y', kind: 'agent' })
  assert.equal(ok.kind, 'agent')
  const okHuman = svc.create({ name: 'consistent-human', type: 'small', by: 'ui', kind: 'human' })
  assert.equal(okHuman.kind, 'human')
})

test('kind：落进事件流，回放后仍在（不是只有内存里有）', (t) => {
  const { svc, dir } = setup(t)
  const team = svc.create({ name: 'persisted-kind', type: 'small', by: 'ui' })
  assert.equal(team.kind, 'human')
  const ev = readEvents(dir).find((e) => e.id === team.id)
  assert.equal(ev.after.kind, 'human', '事件流里的 after 必须带 kind')

  const revived = createTeams({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(revived.get(team.id).kind, 'human', '回放后 kind 仍在')
})

test('kind：与 type(big/small) 并存互不影响', (t) => {
  const { svc } = setup(t)
  const big = svc.create({ name: 'B', type: 'big', by: 'ui', leadId: 'bot-lead', memberIds: ['bot-a'] })
  assert.equal(big.type, 'big')
  assert.equal(big.kind, 'human', 'Boss 建的大团队：kind=human + type=big')
  const small = svc.create({ name: 'S', type: 'small', by: 'bot-z' })
  assert.equal(small.type, 'small')
  assert.equal(small.kind, 'agent')
})

// ══ t-39 A/B：跨团队路由 + 环路防护（服务层 resolveRoute/recordRoute/listRoutes）══

/** 建两个各带 leadId 的大团队，返回 t1/t2。 */
function twoTeams(svc) {
  const t1 = svc.create({ name: 'A', type: 'big', by: 'ui', leadId: 'lead-A', memberIds: ['bot-a'] })
  const t2 = svc.create({ name: 'B', type: 'big', by: 'ui', leadId: 'lead-B', memberIds: ['bot-b'] })
  return { t1, t2 }
}

test('route：正常路由到 toTeam ⇒ accepted，目标解析到对方 leadId（不是全部成员）', (t) => {
  const { svc } = setup(t)
  const { t1, t2 } = twoTeams(svc)
  const r = svc.resolveRoute({ fromTeam: t1.id, toTeam: t2.id, taskId: 't-1', text: 'hi', by: 'lead-A' })
  assert.equal(r.ok, true)
  assert.equal(r.decision, 'accepted')
  assert.equal(r.to.kind, 'team')
  assert.equal(r.to.id, t2.id)
  assert.equal(r.to.leadId, 'lead-B', '只唤 leadId，不唤成员 bot-b')
  assert.equal(r.hop, 0)
})

test('route：toBot 解析到该 Bot 所属团队的 lead', (t) => {
  const { svc } = setup(t)
  const { t2 } = twoTeams(svc)
  const r = svc.resolveRoute({ toBot: 'bot-b', taskId: 't-2', by: 'lead-A' })
  assert.equal(r.ok, true)
  assert.equal(r.to.kind, 'bot')
  assert.equal(r.to.id, t2.id)
  assert.equal(r.to.leadId, 'lead-B', '目标仍是团队 lead，不是 bot-b 本人')
})

test('route：toTeam 与 toBot 都缺 ⇒ refused ROUTE_TARGET_REQUIRED（可读，不抛）', (t) => {
  const { svc } = setup(t)
  const r = svc.resolveRoute({ taskId: 't-3', by: 'lead-A' })
  assert.equal(r.ok, false)
  assert.equal(r.decision, 'refused')
  assert.equal(r.reason, 'ROUTE_TARGET_REQUIRED')
})

test('route：toTeam 与 toBot 同时给 ⇒ refused ROUTE_TARGET_AMBIGUOUS', (t) => {
  const { svc } = setup(t)
  const { t2 } = twoTeams(svc)
  const r = svc.resolveRoute({ toTeam: t2.id, toBot: 'bot-b', taskId: 't-4', by: 'lead-A' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ROUTE_TARGET_AMBIGUOUS')
})

test('route：taskId 缺失 ⇒ refused ROUTE_TASK_ID_REQUIRED', (t) => {
  const { svc } = setup(t)
  const { t2 } = twoTeams(svc)
  const r = svc.resolveRoute({ toTeam: t2.id, by: 'lead-A' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ROUTE_TASK_ID_REQUIRED')
})

test('route：目标团队不存在 ⇒ refused ROUTE_TARGET_NOT_FOUND（不是抛错）', (t) => {
  const { svc } = setup(t)
  const r = svc.resolveRoute({ toTeam: 'team-999', taskId: 't-5', by: 'lead-A' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ROUTE_TARGET_NOT_FOUND')
})

test('route：目标团队没有 leadId ⇒ refused ROUTE_NO_LEAD（不能路由到无人可唤的团队）', (t) => {
  const { svc } = setup(t)
  const orphan = svc.create({ name: 'no-lead', type: 'small', by: 'bot-x' })
  const r = svc.resolveRoute({ toTeam: orphan.id, taskId: 't-6', by: 'lead-A' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ROUTE_NO_LEAD')
})

test('route：hop=3 放行，hop=4 ⇒ refused ROUTE_HOP_EXCEEDED（>3 拒绝）', (t) => {
  const { svc } = setup(t)
  const { t1, t2 } = twoTeams(svc)
  const okAt3 = svc.resolveRoute({ fromTeam: t1.id, toTeam: t2.id, taskId: 'hop-3', hop: 3, by: 'lead-A' })
  assert.equal(okAt3.ok, true, 'hop=3 是边界，放行')
  const badAt4 = svc.resolveRoute({ fromTeam: t1.id, toTeam: t2.id, taskId: 'hop-4', hop: 4, by: 'lead-A' })
  assert.equal(badAt4.ok, false)
  assert.equal(badAt4.decision, 'refused')
  assert.equal(badAt4.reason, 'ROUTE_HOP_EXCEEDED')
})

test('route 去重键：同一 (from,to,taskId) 的 dedupKey 相同 ⇒ dispatcher 能判重（A→B→A→B 第3跳被拦）', (t) => {
  const { svc } = setup(t)
  const { t1, t2 } = twoTeams(svc)
  const taskId = 'loop-task'
  // A→B（hop0）与 A→B（hop2）必须是**同一个** dedupKey，否则 dispatcher 拦不住
  const h0 = svc.resolveRoute({ fromTeam: t1.id, toTeam: t2.id, taskId, hop: 0, by: 'lead-A' })
  const h2 = svc.resolveRoute({ fromTeam: t1.id, toTeam: t2.id, taskId, hop: 2, by: 'lead-A' })
  assert.equal(h0.ok, true)
  assert.equal(h2.ok, true)
  assert.equal(h0.dedupKey, h2.dedupKey, 'dedupKey 不含 hop ⇒ 同一路由链能判重')
  // 反向 B→A 是**不同**键（不是同一个方向，不该互相拦）
  const back = svc.resolveRoute({ fromTeam: t2.id, toTeam: t1.id, taskId, hop: 1, by: 'lead-B' })
  assert.notEqual(back.dedupKey, h0.dedupKey, '反向路由是不同的键')
})

test('recordRoute：先落 route 事件（intent-first），可在事件流里查回', (t) => {
  const { svc, dir } = setup(t)
  const { t1, t2 } = twoTeams(svc)
  const r = svc.resolveRoute({ fromTeam: t1.id, toTeam: t2.id, taskId: 't-7', text: 'payload', by: 'lead-A' })
  const rec = svc.recordRoute({
    to: r.to, fromTeam: r.fromTeam, taskId: 't-7', text: 'payload', hop: r.hop, by: 'lead-A',
    wake: { ok: true, result: 'sent' },
  })
  assert.equal(rec.toId, t2.id)
  assert.equal(rec.toLeadId, 'lead-B')
  assert.equal(rec.taskId, 't-7')
  assert.equal(rec.hop, 0)
  // 落盘可查
  const ev = readEvents(dir).find((e) => e.action === 'route')
  assert.ok(ev, 'teams.jsonl 里必须有 route 事件')
  assert.equal(ev.after.toLeadId, 'lead-B')
  assert.equal(ev.by, 'lead-A')
})

test('listRoutes：按 toId / fromTeam / taskId 过滤', (t) => {
  const { svc } = setup(t)
  const { t1, t2 } = twoTeams(svc)
  const r1 = svc.resolveRoute({ fromTeam: t1.id, toTeam: t2.id, taskId: 'task-x', by: 'lead-A' })
  svc.recordRoute({ to: r1.to, fromTeam: r1.fromTeam, taskId: 'task-x', hop: 0, by: 'lead-A' })
  const r2 = svc.resolveRoute({ fromTeam: t2.id, toTeam: t1.id, taskId: 'task-y', by: 'lead-B' })
  svc.recordRoute({ to: r2.to, fromTeam: r2.fromTeam, taskId: 'task-y', hop: 0, by: 'lead-B' })

  assert.equal(svc.listRoutes({}).length, 2)
  assert.equal(svc.listRoutes({ taskId: 'task-x' }).length, 1)
  assert.equal(svc.listRoutes({ fromTeam: t1.id }).length, 1)
  assert.equal(svc.listRoutes({ toId: t1.id }).length, 1)
})

test('recordRoute：route 事件重启后仍在（不只在内存）', (t) => {
  const { svc, dir } = setup(t)
  const { t1, t2 } = twoTeams(svc)
  const r = svc.resolveRoute({ fromTeam: t1.id, toTeam: t2.id, taskId: 'persist-route', by: 'lead-A' })
  svc.recordRoute({ to: r.to, fromTeam: r.fromTeam, taskId: 'persist-route', hop: 0, by: 'lead-A' })

  const revived = createTeams({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const rows = revived.listRoutes({ taskId: 'persist-route' })
  assert.equal(rows.length, 1, '回放后 route 记录仍在')
  assert.equal(rows[0].toLeadId, 'lead-B')
})

// ── t-46 缺陷#3：attachRoom 必须校验房间存在 ──────────────────────────────
// 现场事故：team-2.roomId 被设成旁路写盘建的 room-29e9c15c，
// 运行实例看不见它 ⇒ 团队绑了个打不开的房间 ⇒ 「结果回传群主」整条链路静默失效。

test('attachRoom：房间不存在 ⇒ TEAM_ROOM_NOT_FOUND（拒绝绑到打不开的房间）', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: '绑房测试', type: 'big', leadId: 'bot-x', by: 'ui' })
  assert.throws(
    () => svc.attachRoom({
      id: team.id, roomId: 'room-does-not-exist', by: 'ui', roomExists: () => false,
    }),
    (e) => e instanceof TeamError && e.code === 'TEAM_ROOM_NOT_FOUND',
    '不存在的房间必须拒绝，否则团队页显示「已绑定」但点进去打不开',
  )
})

test('attachRoom：房间存在 ⇒ 正常绑定', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: '绑房成功', type: 'big', leadId: 'bot-x', by: 'ui' })
  const got = svc.attachRoom({
    id: team.id, roomId: 'room-real', by: 'ui', roomExists: () => true,
  })
  assert.equal(got.roomId, 'room-real')
})

test('attachRoom：不传 roomExists ⇒ 保持旧行为（不破坏既有脚本）', (t) => {
  const { svc } = setup(t)
  const team = svc.create({ name: '不校验', type: 'big', leadId: 'bot-x', by: 'ui' })
  const got = svc.attachRoom({ id: team.id, roomId: 'room-any', by: 'ui' })
  assert.equal(got.roomId, 'room-any', '不传校验函数时跳过校验，向后兼容')
})
