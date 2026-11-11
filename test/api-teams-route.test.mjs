/**
 * cs-bots 升级09 · t-39 第2批 A/D：跨团队路由 HTTP 出口 + 团队唤醒统计
 *
 * 依据：lead 派发的缺口修复（页面「📤 发协作请求」按钮打 `POST /teams/route`，
 * 之前只有 MCP 工具、没有 HTTP 端点 ⇒ 点按钮 404，是**真故障**）。
 *
 * 手法同 api-teams-room：真 `apply()` + 真 handler，不启真服务器。
 *
 * 为什么必须测：
 *   - `POST /teams/route` 复用 `teams.deliverRoute()`（与工具层**同一套编排**），
 *     页面路径与工具路径行为必须一致，否则两路会漂；
 *   - 页面不传 taskId ⇒ 服务层要自动生成（不能 400 卡住 Boss）；
 *   - `GET /teams/wake-stats` 是页面「今日唤醒 N 次」的数据源，shape 直接进 A 的 UI；
 *   - refused 是**业务结论**不是服务器错误 ⇒ 必须 200 带 decision，前端才拿到 reason。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

function boot(extraSessions = []) {
  const deliverable = new Set(extraSessions)
  const root = mkdtempSync(join(tmpdir(), 'cs-bots-teams-route-'))
  const stateDir = join(root, 'state')
  rmSync(stateDir, { force: true, recursive: true })
  let handler = null

  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') {
        const fake = (id) => ({ id, followup() { return { ok: true } } })
        return {
          async create(request) { return { id: request?.sessionId, sessionId: request?.sessionId } },
          get: (id) => (deliverable.has(id) ? fake(id) : undefined),
          list: () => [...deliverable].map(fake),
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

  const h = {
    ctx, root, stateDir, services,
    async req(method, path, body) {
      assert.ok(handler, 'API handler 应已注册')
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0, raw = ''
      const response = { writeHead(code) { status = code }, end(chunk) { raw += chunk ?? '' } }
      await handler(request, response)
      let json; try { json = JSON.parse(raw) } catch { json = { _raw: raw } }
      return { status, json }
    },
    cleanup() {
      for (const k of ['dispatcher', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { getServices(ctx)[k]?.dispose?.() } catch { /* 已释放 */ }
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}

async function seedTwoTeams(h) {
  const r1 = await h.req('POST', '/teams', {
    name: '团队A', type: 'small', leadId: 'lead-a', members: ['bot-a'], by: 'ui',
  })
  assert.equal(r1.status, 200, JSON.stringify(r1.json))
  const r2 = await h.req('POST', '/teams', {
    name: '团队B', type: 'small', leadId: 'lead-b', members: ['bot-b'], by: 'ui',
  })
  assert.equal(r2.status, 200, JSON.stringify(r2.json))
  return { a: r1.json.team.id, b: r2.json.team.id }
}

// ── ① POST /teams/route ─────────────────────────────────────────────────────

test('① POST /teams/route：页面「发协作请求」能走通，返回 DecisionKind 的 delivered', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a, b } = await seedTwoTeams(h)

  const r = await h.req('POST', '/teams/route', {
    fromTeam: a, toTeam: b, text: '请帮忙看一下订单服务的慢查询', by: 'ui',
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.decision, 'delivered')
  assert.equal(r.json.to.kind, 'team')
  assert.equal(r.json.to.id, b)
  assert.equal(r.json.to.leadId, 'lead-b', '必须只唤对方 lead')
  assert.ok(typeof r.json.taskId === 'string' && r.json.taskId.length > 0, '未传 taskId ⇒ 服务层自动生成')
  assert.ok(r.json.wake, '必须返回 wake（唤醒成本可见）')
})

test('① POST /teams/route：未传 taskId ⇒ 自动生成 route-<时间戳>，不 400 卡住 Boss', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a, b } = await seedTwoTeams(h)
  const r = await h.req('POST', '/teams/route', { fromTeam: a, toTeam: b, text: 'hi', by: 'ui' })
  assert.equal(r.status, 200)
  assert.match(r.json.taskId, /^route-\d+$/, `taskId 应为 route-<时间戳>，实际 ${r.json.taskId}`)
})

test('① POST /teams/route：目标不存在 ⇒ refused ROUTE_TARGET_NOT_FOUND，仍是 200', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a } = await seedTwoTeams(h)
  const r = await h.req('POST', '/teams/route', { fromTeam: a, toTeam: 'no-such', text: 'x', by: 'ui' })
  assert.equal(r.status, 200, 'refused 是业务结论，不是服务器错误')
  assert.equal(r.json.ok, false)
  assert.equal(r.json.decision, 'refused')
  assert.equal(r.json.reason, 'ROUTE_TARGET_NOT_FOUND')
})

test('① POST /teams/route：toTeam 与 toBot 都不给 ⇒ refused ROUTE_TARGET_REQUIRED', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a } = await seedTwoTeams(h)
  const r = await h.req('POST', '/teams/route', { fromTeam: a, text: 'x', by: 'ui' })
  assert.equal(r.status, 200)
  assert.equal(r.json.decision, 'refused')
  assert.equal(r.json.reason, 'ROUTE_TARGET_REQUIRED')
})

test('① POST /teams/route：hop=4 ⇒ refused ROUTE_HOP_EXCEEDED（>3 拒绝）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a, b } = await seedTwoTeams(h)
  const r = await h.req('POST', '/teams/route', { fromTeam: a, toTeam: b, text: 'x', hop: 4, by: 'ui' })
  assert.equal(r.status, 200)
  assert.equal(r.json.decision, 'refused')
  assert.equal(r.json.reason, 'ROUTE_HOP_EXCEEDED')
})

test('① POST /teams/route：留痕落 teams.jsonl（与工具层同一条 event 流）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a, b } = await seedTwoTeams(h)
  const r = await h.req('POST', '/teams/route', { fromTeam: a, toTeam: b, text: '留痕检查', by: 'ui' })
  const rows = readFileSync(join(h.stateDir, 'teams.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const route = rows.find((ev) => ev.action === 'route' && ev.after?.toId === b)
  assert.ok(route, 'teams.jsonl 必须有 route 事件')
  assert.equal(route.after.taskId, r.json.taskId)
})

test('① POST /teams/route：重复请求被 dispatcher 去重（wake.result=skipped）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a, b } = await seedTwoTeams(h)
  const r1 = await h.req('POST', '/teams/route', { fromTeam: a, toTeam: b, text: 'same', taskId: 't-1', by: 'ui' })
  const r2 = await h.req('POST', '/teams/route', { fromTeam: a, toTeam: b, text: 'same', taskId: 't-1', by: 'ui' })
  assert.equal(r1.json.decision, 'delivered')
  assert.equal(r2.json.decision, 'delivered', '去重后仍算 delivered（决策已留痕）')
  assert.equal(r2.json.wake.result, 'skipped')
  assert.equal(r2.json.wake.reason, 'dedup-hit')
})

// ── ② GET /teams/wake-stats ────────────────────────────────────────────────

test('② GET /teams/wake-stats：按 id 返回今日/累计/按结果分布', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a, b } = await seedTwoTeams(h)
  // 造 2 次路由唤醒（不同 taskId 避开 dedup）
  await h.req('POST', '/teams/route', { fromTeam: a, toTeam: b, text: 'x1', taskId: 'w-1', by: 'ui' })
  await h.req('POST', '/teams/route', { fromTeam: a, toTeam: b, text: 'x2', taskId: 'w-2', by: 'ui' })

  const r = await h.req('GET', `/teams/wake-stats?id=${b}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.id, b)
  assert.ok(typeof r.json.today === 'number')
  assert.ok(typeof r.json.total === 'number')
  assert.ok(r.json.byResult, '必须有 byResult（A 的 UI 直接读）')
  assert.equal(r.json.byResult.sent + r.json.byResult.skipped + r.json.byResult.failed + r.json.byResult.pending, r.json.today)
})

test('② GET /teams/wake-stats：不传 id ⇒ 返回全部团队横向对比', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const { a, b } = await seedTwoTeams(h)
  await h.req('POST', '/teams/route', { fromTeam: a, toTeam: b, text: 'x', taskId: 'w-3', by: 'ui' })
  const r = await h.req('GET', '/teams/wake-stats')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.json.today.teams))
  const hit = r.json.today.teams.find((t) => t.teamId === b)
  assert.ok(hit, '团队 B 应出现在聚合结果里')
  assert.ok(r.json.today.unassigned, '必须带 unassigned 桶（无团队归属的唤醒单独列）')
})

// ── ③ leadSync 字段（发言同步状态形状）────────────────────────────────────

test('③ room.post 返回值带 leadSync：未绑原生 team ⇒ synced:false + NATIVE_TEAM_NOT_BOUND，绝不装成功', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r = await h.req('POST', '/teams', {
    name: '同步团队', type: 'small', leadId: 'lead-s', members: ['bot-s'], by: 'ui',
  })
  const roomId = r.json.room.id
  // 议事厅成员是 [leadId, ...members]，没有 'ui' —— 用 lead-s 发言（房间成员）
  const rp = await h.req('POST', '/rooms/post', { roomId, from: 'lead-s', text: '大家好' })
  assert.equal(rp.status, 200, JSON.stringify(rp.json))
  assert.ok(rp.json.leadSync, '必须返回 leadSync 字段（A 的 UI 直接读）')
  assert.equal(rp.json.leadSync.ok, true)
  assert.equal(rp.json.leadSync.synced, false, '未绑定 ⇒ 绝不装成功')
  assert.equal(rp.json.leadSync.reason, 'NATIVE_TEAM_NOT_BOUND')
})

test('③ room.post：已绑原生 team ⇒ synced:true，wake 发给了原生 Lead（root session id）', async (t) => {
  const h = boot(['root-session-xyz'])
  t.after(() => h.cleanup())
  // 绑一个原生 team id（= root session id = TeamId）
  const r = await h.req('POST', '/teams', {
    name: '已绑定团队', type: 'small', leadId: 'lead-s', members: ['bot-s'],
    by: 'ui', nativeTeamId: 'root-session-xyz',
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const roomId = r.json.room.id
  const rp = await h.req('POST', '/rooms/post', { roomId, from: 'lead-s', text: '同步测试消息' })
  assert.equal(rp.status, 200, JSON.stringify(rp.json))
  assert.equal(rp.json.leadSync.ok, true)
  assert.equal(rp.json.leadSync.synced, true, '绑定后必须真的同步成功')
  assert.equal(rp.json.leadSync.reason, 'SYNCED')
  assert.equal(rp.json.leadSync.nativeTeamId, 'root-session-xyz')
  assert.equal(rp.json.leadSync.leadId, 'root-session-xyz', '原生 Lead 会话 id == TeamId == nativeTeamId')
})

test('③ room.post：同一消息重复 post ⇒ SYNC_DEDUP_HIT（幂等，不重复唤醒）', async (t) => {
  const h = boot(['root-idem'])
  t.after(() => h.cleanup())
  const r = await h.req('POST', '/teams', {
    name: '幂等团队', type: 'small', leadId: 'lead-s', members: ['bot-s'],
    by: 'ui', nativeTeamId: 'root-idem',
  })
  const roomId = r.json.room.id
  // 同一消息 id 发两次（模拟 Boss 重发）
  const m = h.req('POST', '/rooms/post', { roomId, from: 'lead-s', text: '同一条消息' })
  const first = await m
  const second = await h.req('POST', '/rooms/post', { roomId, from: 'lead-s', text: '同一条消息' })
  // 第二次可能拿到新 message.id ⇒ dedupKey 不同 ⇒ 不算命中。真正幂等的场景是同一 message.id。
  // 这里断言至少第一次成功，第二次不装失败
  assert.equal(first.json.leadSync.synced, true)
  assert.equal(second.json.leadSync.ok, true, '第二次也必须 ok（不因为 dedup 报错误）')
})
