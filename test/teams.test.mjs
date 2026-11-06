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
