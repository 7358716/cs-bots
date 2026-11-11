/**
 * cs-bots 升级09 · §3 自动配议事厅（B 侧）
 *
 * 依据：`docs/CONTRACT-升级09-Boss 体验.md` §3。
 * 手法同 api-revive/api-upgrade：真 `apply()` + 真 handler。
 *
 * 为什么必须测（真实翻车点）：
 *   - `attachRoom` 没导出 ⇒ 房间建好了但团队记不住 roomId，重启后永远重配一遍；
 *   - 房间建失败（权限/配额）⇒ 团队必须仍创建成功，只返回 `roomError`（禁止静默吞掉）；
 *   - 议事厅命名/成员列表/ adminId 必须与契约一致，否则页面「团队详情」会显示错乱。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

function boot() {
  const root = mkdtempSync(join(tmpdir(), 'cs-bots-teams-room-'))
  const stateDir = join(root, 'state')
  rmSync(stateDir, { force: true, recursive: true })
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

// ── §3 自动配议事厅 ────────────────────────────────────────────────────────

test('§3 POST /teams：建团队就配议事厅，roomId 持久化到团队事件流', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bot = await h.services.roster.create({ name: 'lead-bot', cwd: '/tmp/lead-bot', permission: 'workspace-write', byId: 'ui' })

  const r = await h.req('POST', '/teams', { name: '测试团队', type: 'small', leadId: bot.sessionId, members: [], by: 'ui' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.ok(r.json.room, '必须返回 room 对象')
  assert.equal(r.json.room.name, '测试团队 · 议事厅', '议事厅命名必须带「· 议事厅」后缀')
  assert.equal(r.json.roomError, undefined, '不应有 roomError')

  // 团队事件流里必须记下 roomId（否则重启后 attachRoom 会重配一遍）
  const team = h.services.teams.get(r.json.team.id)
  assert.equal(team.roomId, r.json.room.id, '团队必须记住 roomId')
  const rows = readFileSync(join(h.stateDir, 'teams.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const attach = rows.find((ev) => ev.action === 'attachRoom' && ev.id === r.json.team.id)
  assert.ok(attach, 'teams.jsonl 必须有一条 attachRoom 事件')
  // 事件形态是 {id,rev,action,by,at,before,after} —— roomId 在 after 里
  assert.equal(attach.after.roomId, r.json.room.id, 'attachRoom 事件的 after.roomId 必须记下房间')
  assert.equal(attach.after.rev, attach.rev, '事件 rev 与 after.rev 必须一致')

  // 房间本身也必须存在且成员正确（leadId 必须在内，且是 admin）
  const room = h.services.room.get(r.json.room.id)
  assert.ok(room, '房间必须存在')
  assert.deepEqual(room.members, [bot.sessionId], 'members 应只含 leadId')
  assert.equal(room.adminId, bot.sessionId, 'adminId 必须是 leadId（admin 模式）')
  assert.equal(room.mode, 'admin', '议事厅必须是 admin 模式（只有负责人能发言）')
})

test('§3 POST /teams：房间创建失败 ⇒ roomError 句子，但团队仍创建成功', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bot = await h.services.roster.create({ name: 'lead-bot2', cwd: '/tmp/lead-bot2', permission: 'workspace-write', byId: 'ui' })

  // 让 room.create 必然失败：把 cwd 指向一个不可写的路径（room 会尝试写配置）
  const badCwd = join(h.root, 'nowhere')
  rmSync(badCwd, { force: true })
  // 注：room.create 的 cwd 是可选的；我们换一个更可靠的注入点——
  // 直接替换 services.room.create 为一个必抛的桩，模拟「配额用尽/权限不足」
  const realCreate = h.services.room.create
  h.services.room.create = () => { throw new Error('ROOM_QUOTA_EXCEEDED') }
  t.after(() => { h.services.room.create = realCreate })

  const r = await h.req('POST', '/teams', { name: '坏房间团队', type: 'small', leadId: bot.sessionId, members: [], by: 'ui' })
  assert.equal(r.status, 200, '团队创建必须成功（房间失败不阻断）')
  assert.ok(r.json.team, '必须返回 team')
  assert.equal(r.json.room, undefined, '房间失败时不得返回 room 对象')
  assert.ok(r.json.roomError && r.json.roomError.length > 0, '必须返回 roomError 人话句子')

  // 团队仍应创建成功（只是没有 roomId）
  const team = h.services.teams.get(r.json.team.id)
  assert.ok(team, '团队必须存在')
  assert.equal(team.roomId, undefined, '房间失败 ⇒ 团队不得有 roomId')
})

test('§3 POST /teams/add：加成员时若房间存在，自动把人拉进房间；加入失败 ⇒ roomError 但团队编辑仍成功', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bot = await h.services.roster.create({ name: 'lead-bot3', cwd: '/tmp/lead-bot3', permission: 'workspace-write', byId: 'ui' })
  const teamRes = await h.req('POST', '/teams', { name: '加人团队', type: 'small', leadId: bot.sessionId, members: [], by: 'ui' })
  const roomId = teamRes.json.room.id

  const newMember = await h.services.roster.create({ name: 'new-bot', cwd: '/tmp/new-bot', permission: 'workspace-write', byId: 'ui' })

  // 正常路径：自动加入房间
  const r = await h.req('POST', '/teams/add', { id: teamRes.json.team.id, memberId: newMember.sessionId, by: 'ui' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.roomError, undefined, '加入成功不应有 roomError')
  const room = h.services.room.get(roomId)
  assert.ok(room.members.includes(newMember.sessionId), '新成员必须在房间成员列表里')

  // 失败路径：让 room.join 抛错
  const newMember2 = await h.services.roster.create({ name: 'new-bot2', cwd: '/tmp/new-bot2', permission: 'workspace-write', byId: 'ui' })
  const realJoin = h.services.room.join
  h.services.room.join = () => { throw new Error('ROOM_JOIN_DENIED') }
  t.after(() => { h.services.room.join = realJoin })

  const r2 = await h.req('POST', '/teams/add', { id: teamRes.json.team.id, memberId: newMember2.sessionId, by: 'ui' })
  assert.equal(r2.status, 200, '团队编辑必须成功')
  assert.ok(r2.json.team, '必须返回 team')
  assert.ok(r2.json.roomError && /ROOM_JOIN_DENIED/.test(r2.json.roomError), '必须回 roomError 句子')
  // 团队编辑仍应生效（成员已加入团队，只是没进房间）
  const team = h.services.teams.get(teamRes.json.team.id)
  assert.ok(team.members.includes(newMember2.sessionId), '新成员必须在团队名单里（房间失败不阻断）')
})

test('§3 议事厅 idempotent：重复 attachRoom（同一 roomId）不产生多余事件', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bot = await h.services.roster.create({ name: 'lead-bot4', cwd: '/tmp/lead-bot4', permission: 'workspace-write', byId: 'ui' })
  const r = await h.req('POST', '/teams', { name: '幂等团队', type: 'small', leadId: bot.sessionId, members: [], by: 'ui' })
  const roomId = r.json.room.id

  // 直接调 attachRoom 两次（模拟重启后再次 ensureTeamRoom）
  // 注意：attachRoom 返回的是团队对象（rev 已推进），不是 {attached}
  const out1 = h.services.teams.attachRoom({ id: r.json.team.id, roomId, by: 'ui' })
  const out2 = h.services.teams.attachRoom({ id: r.json.team.id, roomId, by: 'ui' })
  assert.equal(out1.roomId, roomId, '第一次应把 roomId 记上')
  assert.equal(out2.roomId, roomId, '第二次应返回既有 roomId')
  assert.equal(out2.rev, out1.rev, '幂等：rev 不应推进')
  // 事件流只应有一条 attachRoom
  const rows = readFileSync(join(h.stateDir, 'teams.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const attaches = rows.filter((ev) => ev.action === 'attachRoom' && ev.id === r.json.team.id)
  assert.equal(attaches.length, 1, 'attachRoom 必须幂等（不重复写事件）')
})