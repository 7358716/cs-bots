/**
 * POST /roster/rebuild —— 重建 Bot 会话（2026-11-14 方案B）。
 *
 * 为什么这个端点必须是 HTTP 而不能是脚本：
 *   `roster.create` → `kernel.createSession` → `service(ctx,'agents')`。
 *   `agents` 是宿主注入的服务，独立 Node 进程拿不到 ⇒ 只能在运行实例内跑。
 *   2026-11-14 实测：脚本里 12 个 Bot 全部退役后重建失败（agents 不可用），
 *   靠备份 restoreState 才恢复。这个测试锁住「在实例内能建成」这件事。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { API_BASE } from '../src/api.js'

function boot(settings = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-rebuild-'))
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
    botWorkspaceRoot: join(stateDir, 'cs-bots'),
    // 2026-11-16 取消内置部门后，测试要自己声明部门
    departments: [{ id: 'dev', name: '开发部' }, { id: 'qa', name: '测试部' }],
    ...settings,
  }))
  const box = { handler: null }
  const agents = {
    live: new Set(),
    async create(request) {
      const id = request?.sessionId
      if (id) agents.live.add(id)
      return { id, sessionId: id }
    },
    get: (id) => (agents.live.has(id) ? { id, sessionId: id } : undefined),
    list: () => [...agents.live].map((id) => ({ id, sessionId: id })),
    async resume(o) { agents.live.add(o?.resumeSessionId); return { id: o?.resumeSessionId } },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => {
      if (k === 'agents') return agents
      if (k === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      if (k === 'webServer') return { register: ({ handler }) => { box.handler = handler; return () => {} } }
      return undefined
    },
    on: () => {}, effect: () => {},
  }
  apply(ctx, { stateDir })
  return {
    stateDir, agents,
    async req(method, path, body) {
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0
      let raw = ''
      assert.ok(box.handler, 'API handler 应已注册')
      await box.handler(request, { writeHead(c) { status = c }, end(c) { raw += c ?? '' } })
      let json
      try { json = JSON.parse(raw) } catch { json = { _raw: raw } }
      return { status, json }
    },
    cleanup() { try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* */ } },
  }
}

test('rebuild：不带 confirm ⇒ 400 拒绝（不可逆操作要显式确认）', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/roster/rebuild', {})
    assert.equal(r.status, 400)
    assert.equal(r.json.reason, 'ROSTER_REBUILD_NEEDS_CONFIRM')
  } finally { h.cleanup() }
})

test('rebuild：指定 name ⇒ 只重建那一个，sessionId 变化且 cwd 在部门下', async () => {
  const h = boot()
  try {
    const c = await h.req('POST', '/roster', { name: '重建测试岗', department: 'dev', byId: 'ui' })
    assert.equal(c.status, 200, JSON.stringify(c.json))
    const oldSid = c.json.bot.sessionId

    const r = await h.req('POST', '/roster/rebuild', { confirm: true, name: '重建测试岗' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.rebuilt, 1, `应重建 1 个，实际：${JSON.stringify(r.json)}`)
    const row = r.json.results[0]
    assert.equal(row.status, 'ok')
    assert.notEqual(row.to, oldSid, '新会话 id 必须与旧的不同的（这就是重建的目的）')
    assert.ok(String(row.cwd).includes('/dev/'), `cwd 应在部门目录下，实际 ${row.cwd}`)
  } finally { h.cleanup() }
})

test('rebuild：keepSessions 里的会话一律不重建（防手滑退役自己）', async () => {
  const h = boot()
  try {
    const c = await h.req('POST', '/roster', { name: '不能动我', department: 'dev', byId: 'ui' })
    const sid = c.json.bot.sessionId
    const r = await h.req('POST', '/roster/rebuild', { confirm: true, keepSessions: [sid] })
    assert.equal(r.json.total, 0, '被排除的会话不该进入重建清单')
  } finally { h.cleanup() }
})

test('rebuild：档案在重建后完整保留（identity/persona/skills 都不丢）', async () => {
  const h = boot()
  try {
    const profile = {
      identity: '我是档案完整性测试岗',
      persona: '严谨',
      skills: ['demo-skill'],
    }
    const c = await h.req('POST', '/roster', {
      name: '档案岗', department: 'qa', byId: 'ui', profile,
    })
    assert.equal(c.status, 200, JSON.stringify(c.json))

    const r = await h.req('POST', '/roster/rebuild', { confirm: true, name: '档案岗' })
    assert.equal(r.json.rebuilt, 1)

    const list = await h.req('GET', '/roster')
    const bot = list.json.bots.find((b) => b.name === '档案岗')
    assert.equal(bot.profile.identity, '我是档案完整性测试岗', '重建后档案必须还在')
    assert.equal(bot.profile.persona, '严谨')
    assert.deepEqual(bot.profile.skills, ['demo-skill'])
  } finally { h.cleanup() }
})

test('rebuild：批量模式只动「住在主目录下且能对上部门」的 Bot', async () => {
  const h = boot()
  try {
    // 一个在部门下的（应被重建）
    await h.req('POST', '/roster', { name: '部门内岗', department: 'dev', byId: 'ui' })
    // 一个手工 cwd 的（不该被批量动）
    await h.req('POST', '/roster', { name: '手工目录岗', cwd: join(h.stateDir, 'manual'), byId: 'ui' })

    const r = await h.req('POST', '/roster/rebuild', { confirm: true })
    const names = r.json.results.map((x) => x.name)
    assert.ok(names.includes('部门内岗'), '部门内的应该被重建')
    assert.ok(!names.includes('手工目录岗'), '手工 cwd 的不该被批量重建')
  } finally { h.cleanup() }
})

test('rebuild：★ cwd 不在主目录下的 Bot，按原 cwd 重建（不能切成 "26" 这种垃圾部门）', async () => {
  // 实测踩过：插件发布管理员的 cwd 是 /home/ubuntu/output2026/butlers/dev/cs-bots
  // （刻意留在插件源码目录发布用）。旧实现按 root.length 切片 ⇒ 切出 "26"
  // ⇒ 「部门 "26" 不存在」⇒ 重建失败，而退役已执行 ⇒ 必须人工救。
  const h = boot()
  try {
    const outside = join(h.stateDir, 'outside-plugin-src')
    const c = await h.req('POST', '/roster', { name: '源码目录岗', cwd: outside, byId: 'ui' })
    assert.equal(c.status, 200, JSON.stringify(c.json))
    const oldSid = c.json.bot.sessionId
    assert.equal(c.json.bot.cwd, outside, '前提：cwd 确实不在主目录下')

    const r = await h.req('POST', '/roster/rebuild', { confirm: true, name: '源码目录岗' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.rebuilt, 1, `应重建成功，实际：${JSON.stringify(r.json.results)}`)
    const row = r.json.results[0]
    assert.equal(row.status, 'ok')
    assert.notEqual(row.to, oldSid, '应换新会话')
    assert.equal(row.cwd, outside, 'cwd 必须沿用原来的，不能被改到别处')
    assert.equal(row.department, null, '不在主目录下的不该有部门')
  } finally { h.cleanup() }
})

test('rebuild：在主目录下的 Bot 仍按 department 派生（不受上面修复影响）', async () => {
  const h = boot()
  try {
    const c = await h.req('POST', '/roster', { name: '部门内岗', department: 'dev', byId: 'ui' })
    const r = await h.req('POST', '/roster/rebuild', { confirm: true, name: '部门内岗' })
    assert.equal(r.json.rebuilt, 1)
    const row = r.json.results[0]
    assert.equal(row.department, 'dev')
    assert.ok(String(row.cwd).includes('/dev/'), `cwd 应在部门下，实际 ${row.cwd}`)
  } finally { h.cleanup() }
})
