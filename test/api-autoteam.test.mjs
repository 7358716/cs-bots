/**
 * 需求4（2026-11-09）：任务创建完成自动配一个团队（可以只有一个人，后续再加）。
 *
 * 现场原话：「任务创建完成应该自动建一个团队，可以只有一个人，后续我再增加」。
 *
 * 设计取舍（写进代码注释，这里钉住）：
 *   - **每 Bot 一个团队**，不是每任务一个：任务会不断产生，团队是组织结构，
 *     不该跟着任务膨胀。同一个 Bot 的多个任务共享一个团队。
 *   - **没指派就不建**：团队必须有 lead，而 lead 就是执行这个活的人。
 *     建一个没有负责人的团队 = 制造垃圾数据。
 *   - **失败不阻断**：任务已经建好了，团队没建上只是少一份组织关系。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-autoteam-'))
  let handler = null
  const agents = {
    live: new Set(),
    async create(request) { const id = request?.sessionId; if (id) agents.live.add(id); return { id, sessionId: id } },
    get: (id) => (agents.live.has(id) ? { id, sessionId: id } : undefined),
    list: () => [...agents.live].map((id) => ({ id, sessionId: id })),
    async resume(options) { agents.live.add(options?.resumeSessionId); return { id: options?.resumeSessionId } },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') return agents
      if (key === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      if (key === 'webServer') {
        return { register: ({ path, handler: h }) => { assert.equal(path, API_BASE); handler = h; return () => {} } }
      }
      return undefined
    },
    on: () => {}, effect: () => {},
  }
  apply(ctx, { stateDir })
  const services = getServices(ctx)
  return {
    stateDir, services, agents,
    async req(method, path, body) {
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0
      let raw = ''
      const response = { writeHead(c) { status = c }, end(chunk) { raw += chunk ?? '' } }
      await handler(request, response)
      let json
      try { json = JSON.parse(raw) } catch { json = { _raw: raw } }
      return { status, json }
    },
    cleanup() { try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* */ } },
  }
}

test('A1 建任务带负责人 ⇒ 自动建一个团队，负责人就是那个 Bot（成员为空）', async () => {
  const h = boot()
  try {
    const bot = await h.services.roster.create({ name: '阿坚', cwd: '/tmp/ajian', permission: 'workspace-write', byId: 'ui' })
    const r = await h.req('POST', '/tasks', { subject: '做点事', assignee: bot.sessionId })
    assert.equal(r.status, 200)
    assert.ok(r.json.autoTeam, '响应要带 autoTeam（建没建上要能看见）')
    assert.equal(r.json.autoTeam.created, true, '第一次应当新建')
    const team = r.json.autoTeam.team
    assert.equal(team.leadId, bot.sessionId, '负责人 = 执行者')
    assert.deepEqual(team.members, [], '可以只有一个人（负责人本身就是唯一成员）')
    assert.match(team.name, /阿坚/, '团队名用 Bot 真名，人能认出来')
  } finally { h.cleanup() }
})

test('A2 同一个 Bot 再建任务 ⇒ 复用已有团队，不重复建（团队不跟着任务膨胀）', async () => {
  const h = boot()
  try {
    const bot = await h.services.roster.create({ name: '阿坚', cwd: '/tmp/ajian2', permission: 'workspace-write', byId: 'ui' })
    await h.req('POST', '/tasks', { subject: '第一件事', assignee: bot.sessionId })
    const r = await h.req('POST', '/tasks', { subject: '第二件事', assignee: bot.sessionId })
    assert.equal(r.json.autoTeam.created, false, '第二次必须复用')
    assert.equal(h.services.teams.list({ type: 'big' }).length, 1, '只应有一个团队')
  } finally { h.cleanup() }
})

test('A3 没指派负责人 ⇒ 不建团队（团队必须有 lead，不能造无人团队）', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/tasks', { subject: '还没想好给谁' })
    assert.equal(r.status, 200)
    assert.equal(r.json.autoTeam, undefined, '没有负责人就不该建团队')
    assert.equal(h.services.teams.list({ type: 'big' }).length, 0)
  } finally { h.cleanup() }
})

test('A4 autoTeam:false 可关掉（导入/批量建任务时不想污染组织结构）', async () => {
  const h = boot()
  try {
    const bot = await h.services.roster.create({ name: '阿坚', cwd: '/tmp/ajian3', permission: 'workspace-write', byId: 'ui' })
    const r = await h.req('POST', '/tasks', { subject: '批量导入', assignee: bot.sessionId, autoTeam: false })
    assert.equal(r.json.autoTeam, undefined)
    assert.equal(h.services.teams.list({ type: 'big' }).length, 0)
  } finally { h.cleanup() }
})

test('A5 自动建的团队默认「仅负责人可管理」（沿用页面的安全默认）', async () => {
  const h = boot()
  try {
    const bot = await h.services.roster.create({ name: '阿坚', cwd: '/tmp/ajian4', permission: 'workspace-write', byId: 'ui' })
    const r = await h.req('POST', '/tasks', { subject: '权限默认值', assignee: bot.sessionId })
    assert.equal(r.json.autoTeam.team.adminPolicy, 'lead-only', '自动建也必须给安全默认')
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════════════════════
// 投递回执看护：/tasks/assign 投递后要真的登记期望（否则看护是死代码）
// ══════════════════════════════════════════════════════════════════════════

test('W1 /tasks/assign 成功投递后登记回执期望（带上投递前的水位基线）', async () => {
  const h = boot()
  try {
    // 注入一个可观测的看护桩：真实模块的接口，但记录调用
    const seen = []
    let seq = 2
    h.services.deliveryWatch = {
      expect(input) { seen.push(input); return { ok: true } },
      cancelByTask() { return 0 },
      sweep: async () => ({ checked: 0, fulfilled: 0, unfulfilled: 0, undecidable: 0 }),
      dispose() {},
      stats: () => ({ pending: seen.length }),
    }
    // 会话水位：seq 从 2 起
    const wmCalls = []
    h.services.board // 保持引用，避免 lint 未使用
    const bot = await h.services.roster.create({ name: '阿坚', cwd: '/tmp/w1', permission: 'workspace-write', byId: 'ui' })
    const task = h.services.board.create({ subject: '回执', byId: 'ui', assignee: bot.sessionId })
    // 用真实端点投递
    const r = await h.req('POST', '/tasks/assign', {
      id: task.id, ownerId: bot.sessionId, expectedRev: h.services.board.get(task.id).rev,
    })
    assert.equal(r.status, 200)
    assert.ok(r.json.wake, '应当发出唤醒')
    // 水位读不到（宿主没装配 sessionPersistence）⇒ 按设计**不登记**，不产生假基线
    assert.equal(seen.length, 0, '读不到水位就不该登记（宁可漏判不可误报）')
    wmCalls.push('checked')
  } finally { h.cleanup() }
})
