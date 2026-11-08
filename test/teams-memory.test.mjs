/**
 * cs-bots 改造06 §2.1 · 团队 L2 记忆端点测试（GET /teams/memory + POST /teams/memory）
 *
 * 手法与 `test/api-anchor.test.mjs` 一致：直接调注册出去的 handler（boot() 假 ctx + req()）。
 *
 * 为什么必须测：
 *   - 团队记忆是 **append-only** 语义：覆盖写会毁掉历史，必须断言「连写两条是两条」；
 *   - 写权限只认队长/管理员：普通成员写入必须 403（否则团队记忆被任意 Bot 篡改）；
 *   - 读侧必须按 `at` 升序且只取本团队 tag，不能串到别的团队/别的层。
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
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-team-mem-'))
  let handler = null
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') {
        return {
          async create(request) { return { id: request?.sessionId, sessionId: request?.sessionId } },
          get: () => undefined,
          list: () => [],
        }
      }
      if (key === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      if (key === 'webServer') {
        return {
          register: ({ path, handler: h }) => {
            assert.equal(path, API_BASE)
            handler = h
            return () => {}
          },
        }
      }
      return undefined
    },
    on: () => {},
    effect: () => {},
  }
  apply(ctx, { stateDir })
  const services = getServices(ctx)
  const realDispatcher = services.dispatcher
  const h = {
    ctx,
    stateDir,
    services,
    async req(method, path, body) {
      assert.ok(handler, 'API handler 应已注册')
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0
      let raw = ''
      const response = {
        writeHead(code) { status = code },
        end(chunk) { raw += chunk ?? '' },
      }
      await handler(request, response)
      let json
      try { json = JSON.parse(raw) } catch { json = { _raw: raw } }
      return { status, json }
    },
    /** 建一个 big 团队（big 必须带 leadId）；返回的 team.id 即团队 id。 */
    createTeam({ leadId = 'lead-1', name = '测试团队' } = {}) {
      return services.teams.create({ name, type: 'big', leadId, by: 'user' })
    },
    cleanup() {
      try { realDispatcher?.dispose?.() } catch { /* 已释放 */ }
      for (const k of ['dispatcher', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { getServices(ctx)[k]?.dispose?.() } catch { /* 已释放 */ }
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
  return h
}

test('GET /teams/memory：缺 id → 400；团队不存在 → 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const missing = await h.req('GET', '/teams/memory')
  assert.equal(missing.status, 400)
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.reason, 'id 必填')

  const notFound = await h.req('GET', '/teams/memory?id=team-999')
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.ok, false)
  assert.equal(notFound.json.reason, '团队 team-999 不存在')
})

test('GET /teams/memory：空团队 200，memories=[] / text=空串 / note 固定', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const team = h.createTeam({ id: 'team-a', leadId: 'lead-1' })

  const r = await h.req('GET', `/teams/memory?id=${team.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.teamId, team.id)
  assert.deepEqual(r.json.memories, [])
  assert.equal(r.json.text, '')
  assert.equal(r.json.note, '团队记忆属 L2 团队层，全队可见；任务进度另记在 L4 任务笔记')
})

test('POST /teams/memory：队长写 200；连写两条是两条（append-only）；读侧按 at 升序', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const team = h.createTeam({ id: 'team-b', leadId: 'lead-1' })

  const first = await h.req('POST', '/teams/memory', { id: team.id, text: '第一条团队记忆', by: 'lead-1' })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(first.json.ok, true)
  assert.equal(first.json.memory.content, '第一条团队记忆')
  assert.equal(first.json.memory.by, 'lead-1')
  assert.equal(typeof first.json.memory.id, 'string')
  assert.equal(typeof first.json.memory.at, 'number')
  assert.equal(first.json.note, '已写入团队记忆（L2，全队可见）')

  const second = await h.req('POST', '/teams/memory', { id: team.id, text: '第二条团队记忆', by: 'lead-1' })
  assert.equal(second.status, 200, JSON.stringify(second.json))

  const got = await h.req('GET', `/teams/memory?id=${team.id}`)
  assert.equal(got.status, 200)
  assert.equal(got.json.memories.length, 2, '连写两条必须是两条（append-only）')
  assert.equal(got.json.memories[0].content, '第一条团队记忆')
  assert.equal(got.json.memories[1].content, '第二条团队记忆')
  // 升序：第一条 at ≤ 第二条 at
  assert.ok(got.json.memories[0].at <= got.json.memories[1].at)
  for (const m of got.json.memories) {
    assert.equal(m.layer, 'L2')
    assert.ok(Array.isArray(m.tags))
    assert.ok(m.tags.includes(`team:${team.id}`))
  }
  // text 拼接格式
  assert.match(got.json.text, /- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 第一条团队记忆（lead-1）/)
  assert.match(got.json.text, /- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 第二条团队记忆（lead-1）/)
})

test('POST /teams/memory：管理员 user 可写 200；普通成员写 403', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const team = h.createTeam({ id: 'team-c', leadId: 'lead-9' })

  const asAdmin = await h.req('POST', '/teams/memory', { id: team.id, text: '管理员写的', by: 'user' })
  assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.json))

  const asMember = await h.req('POST', '/teams/memory', { id: team.id, text: '成员想写', by: 'worker-1' })
  assert.equal(asMember.status, 403)
  assert.equal(asMember.json.ok, false)
  assert.equal(asMember.json.reason, '只有队长或管理员能写团队记忆')

  // 403 的内容不应落盘
  const got = await h.req('GET', `/teams/memory?id=${team.id}`)
  assert.equal(got.json.memories.length, 1)
  assert.equal(got.json.memories[0].content, '管理员写的')
})

test('POST /teams/memory：缺 id / 空文本 / 超长 → 400；团队不存在 → 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const team = h.createTeam({ id: 'team-d', leadId: 'lead-1' })

  const noId = await h.req('POST', '/teams/memory', { text: 'x', by: 'user' })
  assert.equal(noId.status, 400)
  assert.equal(noId.json.reason, 'id 必填')

  const empty = await h.req('POST', '/teams/memory', { id: team.id, text: '   ', by: 'user' })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.reason, '团队记忆不能为空')

  const tooLong = await h.req('POST', '/teams/memory', { id: team.id, text: 'x'.repeat(4001), by: 'user' })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.json.reason, '团队记忆过长（最多 4000 字）')

  const notFound = await h.req('POST', '/teams/memory', { id: 'team-zz', text: 'x', by: 'user' })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.reason, '团队 team-zz 不存在')
})

test('GET /teams/memory：只取本团队 tag，不串到其他团队', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const teamA = h.createTeam({ id: 'team-A', leadId: 'lead-a' })
  const teamB = h.createTeam({ id: 'team-B', leadId: 'lead-b' })

  await h.req('POST', '/teams/memory', { id: teamA.id, text: 'A 的记忆', by: 'lead-a' })
  await h.req('POST', '/teams/memory', { id: teamB.id, text: 'B 的记忆', by: 'lead-b' })

  const gotA = await h.req('GET', `/teams/memory?id=${teamA.id}`)
  assert.equal(gotA.json.memories.length, 1)
  assert.equal(gotA.json.memories[0].content, 'A 的记忆')

  const gotB = await h.req('GET', `/teams/memory?id=${teamB.id}`)
  assert.equal(gotB.json.memories.length, 1)
  assert.equal(gotB.json.memories[0].content, 'B 的记忆')
})
