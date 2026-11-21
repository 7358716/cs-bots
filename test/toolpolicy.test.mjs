/**
 * 工具策略（模式 + 工具规则）回归 —— 2026-11-21 Boss：
 * 「Bot 设置可以初始定义使用标准模式或者创造模式或其他，也可以定义工具（工具的使用规则等等）」
 *
 * 钉住三件事：
 *   1. 三档模式的合法性 + 非法值必须可读报错（不静默回落）；
 *   2. 只读模式**落成 permission=read-only**（硬拦截，不只是文字约定）；
 *   3. 策略条款真的写进 AGENTS.md，且改档案不会把这段冲掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeToolPolicy, permissionForPolicy, policyLines, BOT_MODES } from '../src/toolpolicy.js'
import { createRoster } from '../src/roster.js'

const makeCtx = () => ({
  logger: { info() {}, warn() {} },
  get: (k) => k === 'agents' ? {
    async create(req) { return { id: req.sessionId, sessionId: req.sessionId } },
    get: () => undefined,
    list: () => [],
  } : undefined,
})

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'csb-policy-'))
  const stateDir = join(root, 'state'); mkdirSync(stateDir, { recursive: true })
  const botsRoot = join(root, 'bots'); mkdirSync(botsRoot, { recursive: true })
  const roster = createRoster(makeCtx(), { stateDir, botsRoot, departments: [{ id: 'qa', name: 'QA' }] })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, stateDir, botsRoot, roster }
}

test('模式：std/creative/readonly 合法；其它值必须可读拒绝', () => {
  for (const m of BOT_MODES) {
    const r = normalizeToolPolicy({ mode: m })
    assert.equal(r.ok, true, m)
    assert.equal(r.value.mode, m)
  }
  const bad = normalizeToolPolicy({ mode: 'god' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'BOT_POLICY_BAD_MODE')
  // 不传 => standard
  assert.deepEqual(normalizeToolPolicy(undefined).value, { mode: 'standard', rules: [] })
})

test('工具规则：未知工具 / 重复工具 / allow 非布尔 / 说明超长 全部可读拒绝', () => {
  assert.equal(normalizeToolPolicy({ rules: [{ tool: 'nope', allow: false }] }).code, 'BOT_POLICY_BAD_TOOL')
  assert.equal(normalizeToolPolicy({ rules: [{ tool: 'bash', allow: false }, { tool: 'bash', allow: true }] }).code, 'BOT_POLICY_DUP_TOOL')
  assert.equal(normalizeToolPolicy({ rules: [{ tool: 'bash', allow: 'no' }] }).code, 'BOT_POLICY_BAD_ALLOW')
  assert.equal(normalizeToolPolicy({ rules: [{ tool: 'bash', allow: false, note: 'x'.repeat(201) }] }).code, 'BOT_POLICY_NOTE_TOO_LONG')
})

test('只读模式落成 permission=read-only（硬约束）；标准/创造不覆盖权限', () => {
  assert.equal(permissionForPolicy({ mode: 'readonly' }), 'read-only')
  assert.equal(permissionForPolicy({ mode: 'standard' }), undefined)
  assert.equal(permissionForPolicy({ mode: 'creative' }), undefined)
})

test('策略条款：标准模式无规则时不产生噪音；有规则时禁止项优先合并', () => {
  assert.deepEqual(policyLines({ mode: 'standard', rules: [] }), [])
  const lines = policyLines({
    mode: 'creative',
    rules: [{ tool: 'bash', allow: false, note: '禁止执行命令' }, { tool: 'subagent', allow: true, note: '只在并行调研时用' }],
  })
  assert.ok(lines.some((l) => l.includes('创造模式')))
  assert.ok(lines.some((l) => l.includes('禁止使用以下工具') && l.includes('bash')))
  assert.ok(lines.some((l) => l.includes('subagent')))
})

test('建 Bot 带策略：permission 被压成 read-only，且 AGENTS.md 有「工具使用规则」段', async (t) => {
  const { roster, botsRoot } = setup(t)
  const bot = await roster.create({
    name: '审计岗', department: 'qa', byId: 'lead',
    profile: { identity: '只读审计' },
    toolPolicy: { mode: 'readonly', rules: [{ tool: 'bash', allow: false, note: '不改任何环境' }] },
  })
  assert.equal(bot.permission, 'read-only', '只读模式必须硬压权限')
  assert.equal(bot.toolPolicy.mode, 'readonly')
  const agents = readFileSync(join(bot.cwd, 'AGENTS.md'), 'utf8')
  assert.match(agents, /工具使用规则/)
  assert.match(agents, /禁止使用以下工具/)
})

test('setToolPolicy：改档案不会冲掉工具规则段；只读→创造后权限恢复由调用方决定', async (t) => {
  const { roster } = setup(t)
  const bot = await roster.create({ name: '开发岗', department: 'qa', byId: 'lead', profile: { identity: '开发' } })
  const afterPolicy = roster.setToolPolicy({
    id: bot.id, expectedRev: bot.rev, byId: 'lead',
    toolPolicy: { mode: 'creative', rules: [{ tool: 'web', allow: false, note: '不联网' }] },
  })
  assert.equal(afterPolicy.toolPolicy.mode, 'creative')
  let agents = readFileSync(join(bot.cwd, 'AGENTS.md'), 'utf8')
  assert.match(agents, /创造模式/)

  const afterProfile = roster.setProfile({ id: bot.id, expectedRev: afterPolicy.rev, byId: 'lead', profile: { experience: '做过发布' } })
  agents = readFileSync(join(bot.cwd, 'AGENTS.md'), 'utf8')
  assert.match(agents, /工具使用规则/, '改档案后工具规则段必须还在')
  assert.match(agents, /创造模式/)
  assert.ok(afterProfile.rev > afterPolicy.rev)
})
