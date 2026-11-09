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
