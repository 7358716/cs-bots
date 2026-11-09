/**
 * cs-bots HTTP API 测试 —— 覆盖 L3 页面层依赖的全部端点。
 *
 * 为什么必须测：页面拿不到数据 = 平台对用户不可见。
 * 这里直接调用注册出去的 handler（用假 req/res），不启真服务器 —— 跑得快且确定。
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

/** 造宿主替身并抓取注册的 API handler。 */
function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-api-'))
  const registered = []
  let handler = null

  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'tools') {
        return { register: (d) => (registered.push(d), () => {}), guard: () => () => {}, schemas: () => [] }
      }
      if (key === 'webServer') {
        return {
          register: ({ kind, path, handler: h }) => {
            assert.equal(kind, 'prefix')
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

  return {
    ctx,
    stateDir,
    registered,
    /** 暴露底层 handler（给需要自定义 headers/socket 的安全测试用）。 */
    handler: () => handler,
    /** 调用 API（method + path + 可选 JSON body）。 */
    async req(method, path, body) {
      assert.ok(handler, 'API handler 应已注册')
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0
      let raw = ''
      const response = {
        writeHead(code) {
          status = code
        },
        end(chunk) {
          raw += chunk ?? ''
        },
      }
      await handler(request, response)
      let json
      try {
        json = JSON.parse(raw)
      } catch {
        json = { _raw: raw }
      }
      return { status, json }
    },
    cleanup() {
      getServices(ctx).dispatcher?.dispose?.()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

// ── 读端点 ───────────────────────────────────────────────────────────────────

test('GET /status 返回五个域服务状态', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/status')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    for (const key of ['roster', 'board', 'dispatcher', 'room', 'memory']) {
      assert.ok(key in json.services, `status 应含 ${key}`)
      assert.equal(json.services[key].available, true, `${key} 应就绪`)
    }
    // 兼容性报告也要暴露（rc1/rc5 差异时用户可自助诊断）
    assert.ok(json.compat, '/status 应带 compat 报告')
    assert.ok(json.compat.available, 'compat 应含 available 矩阵')
  } finally {
    h.cleanup()
  }
})

test('GET /tasks、/roster、/rooms、/memory、/wakes 均 200 且为空数组', async () => {
  const h = boot()
  try {
    for (const [path, key] of [
      ['/tasks', 'tasks'],
      ['/roster', 'bots'],
      ['/rooms', 'rooms'],
      ['/memory', 'entries'],
      ['/wakes', 'wakes'],
    ]) {
      const { status, json } = await h.req('GET', path)
      assert.equal(status, 200, `${path} 应 200`)
      assert.deepEqual(json[key], [], `${path} 初始应为空`)
    }
  } finally {
    h.cleanup()
  }
})

// ── 任务：创建 / 详情穿透 / 指派 / 终止 ──────────────────────────────────────

test('POST /tasks 建任务；GET /tasks/detail 穿透出 task + history', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/tasks', { subject: 'API 任务' })
    assert.equal(created.status, 200)
    const id = created.json.task.id

    const detail = await h.req('GET', `/tasks/detail?id=${id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.task.subject, 'API 任务')
    assert.ok(Array.isArray(detail.json.history), 'detail 应带 history')
    assert.ok(detail.json.history.length >= 1, 'history 应至少含 create 事件')
  } finally {
    h.cleanup()
  }
})

test('GET /tasks/detail 未知 id → 404 + 可读原因', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/tasks/detail?id=nope')
    assert.equal(status, 404)
    assert.equal(json.ok, false)
    assert.match(json.reason, /不存在/)
  } finally {
    h.cleanup()
  }
})

test('POST /tasks/assign 指派给指定 owner（含唤醒尝试）', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/tasks', { subject: '待指派' })
    const task = created.json.task

    const assigned = await h.req('POST', '/tasks/assign', {
      id: task.id,
      expectedRev: task.rev,
      ownerId: 'session-bot-1',
    })
    assert.equal(assigned.status, 200)
    assert.equal(assigned.json.task.ownerId, 'session-bot-1', '负责人应被设为指派目标')
    assert.equal(assigned.json.task.status, 'in_progress')
    // 唤醒结果必须回显（无 agents 时会 failed，但要可见）
    assert.ok('wake' in assigned.json, '应回显唤醒结果')
  } finally {
    h.cleanup()
  }
})

test('POST /tasks/abort 终止任务（置 blocked + 留原因）', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/tasks', { subject: '要终止的' })
    const task = created.json.task
    const aborted = await h.req('POST', '/tasks/abort', {
      id: task.id,
      expectedRev: task.rev,
      reason: '需求取消',
    })
    assert.equal(aborted.status, 200)
    assert.equal(aborted.json.task.status, 'blocked')
    assert.equal(aborted.json.task.blockedReason, '需求取消')
  } finally {
    h.cleanup()
  }
})

test('POST /tasks/abort 用过期 rev → 400 + 可读原因（CAS 生效）', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/tasks', { subject: 'CAS' })
    const task = created.json.task
    await h.req('POST', '/tasks/update', { id: task.id, expectedRev: task.rev, action: 'claim' })
    const stale = await h.req('POST', '/tasks/abort', { id: task.id, expectedRev: task.rev, reason: 'x' })
    assert.equal(stale.status, 400)
    assert.equal(stale.json.ok, false)
    assert.match(String(stale.json.reason), /rev|冲突|CAS/i)
  } finally {
    h.cleanup()
  }
})

test('POST /tasks/assign 缺 ownerId → 400', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('POST', '/tasks/assign', { id: 't-1' })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
  } finally {
    h.cleanup()
  }
})

// ── 房间 ─────────────────────────────────────────────────────────────────────

test('房间：建 → 发言 → 读 → 加入/移出成员', async () => {
  const h = boot()
  try {
    // 注意：room.post 要求发送者是成员；UI 的发帖者是 'ui'，所以建房间时把他放进去
    const created = await h.req('POST', '/rooms', { name: '测试房', members: ['s-1', 'ui'] })
    assert.equal(created.status, 200)
    const roomId = created.json.room.id

    const posted = await h.req('POST', '/rooms/post', { roomId, text: '你好' })
    assert.equal(posted.status, 200)
    assert.equal(posted.json.message.text, '你好')

    const msgs = await h.req('GET', `/rooms/messages?roomId=${roomId}`)
    assert.equal(msgs.status, 200)
    assert.ok(msgs.json.messages.some((m) => m.text === '你好'))

    const joined = await h.req('POST', '/rooms/join', { roomId, sessionId: 's-2' })
    assert.equal(joined.status, 200)
    const left = await h.req('POST', '/rooms/leave', { roomId, sessionId: 's-2' })
    assert.equal(left.status, 200)
  } finally {
    h.cleanup()
  }
})

test('GET /rooms/messages 缺 roomId → 400', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/rooms/messages')
    assert.equal(status, 400)
    assert.match(String(json.reason), /roomId/)
  } finally {
    h.cleanup()
  }
})

// ── 记忆 ─────────────────────────────────────────────────────────────────────

test('记忆：写入 → 检索 → 归档 → 恢复', async () => {
  const h = boot()
  try {
    const added = await h.req('POST', '/memory', { layer: 'L2', content: 'API 记忆条目' })
    assert.equal(added.status, 200)
    const entry = added.json.entry

    const found = await h.req('GET', '/memory?query=API')
    assert.equal(found.status, 200)
    assert.ok(found.json.entries.length >= 1)

    const archived = await h.req('POST', '/memory/archive', {
      layer: 'L2',
      id: entry.id,
      reason: '测试归档',
    })
    assert.equal(archived.status, 200)

    const restored = await h.req('POST', '/memory/restore', { layer: 'L2', id: entry.id })
    assert.equal(restored.status, 200)
  } finally {
    h.cleanup()
  }
})

test('记忆：L0 人格层写入被拒（400 + 可读原因）', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('POST', '/memory', { layer: 'L0', content: 'x' })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
  } finally {
    h.cleanup()
  }
})

// ── 设置 ─────────────────────────────────────────────────────────────────────

test('GET /settings 返回可调参数与当前值', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/settings')
    assert.equal(status, 200)
    assert.ok(json.specs && Object.keys(json.specs).length >= 5, '应返回参数规格')
    assert.ok('defaultLeaseMs' in json.values, '应有 defaultLeaseMs 当前值')
    assert.ok(json.values.k1Enabled === true, 'K1 默认应开启')
  } finally {
    h.cleanup()
  }
})

test('POST /settings 保存合法值 → 生效；越界值 → 400', async () => {
  const h = boot()
  try {
    const ok = await h.req('POST', '/settings', { throttleMs: 7000 })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.values.throttleMs, 7000)
    assert.match(String(ok.json.note), /重启|生效/)

    const bad = await h.req('POST', '/settings', { throttleMs: 999999999 })
    assert.equal(bad.status, 400)
    assert.match(String(bad.json.reason), /越界/)
  } finally {
    h.cleanup()
  }
})

// ── 未知端点 ─────────────────────────────────────────────────────────────────

test('未知端点 → 404 且列出请求路径', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/nope')
    assert.equal(status, 404)
    assert.match(String(json.reason), /nope/)
  } finally {
    h.cleanup()
  }
})

// ── 唤醒 ─────────────────────────────────────────────────────────────────────

test('POST /wakes/notify 手动唤醒：去重键生效', async () => {
  const h = boot()
  try {
    const first = await h.req('POST', '/wakes/notify', {
      target: 's-x',
      reason: 'timer',
      dedupKey: 'k-manual',
    })
    assert.equal(first.status, 200)
    const second = await h.req('POST', '/wakes/notify', {
      target: 's-x',
      reason: 'timer',
      dedupKey: 'k-manual',
    })
    assert.equal(second.status, 200)
    assert.equal(second.json.result.result, 'skipped', '同键第二次应被去重')
  } finally {
    h.cleanup()
  }
})

// ── 2026-11-04 测试回归 ──────────────────────────────────────────────────
// 🔴 设置"陈旧缓存"：POST /settings 写盘成功，但 GET /settings 之前返回启动时的
//   内存副本（services.settings），导致"保存后立刻 GET 看不到新值"的假象。
//   修复：GET 返回 saved（磁盘真相源）+ effective（内存生效值）；POST 返回两者。
test('2026-11-04：POST /settings 后 GET 能读到磁盘上的新值（不陈旧）', async () => {
  const h = boot()
  try {
    const post = await h.req('POST', '/settings', { throttleMs: 7777 })
    assert.equal(post.status, 200)
    assert.equal(post.json.saved.throttleMs, 7777, 'POST 应回 saved=磁盘值')
    assert.equal(post.json.persisted, true, '应明确 persisted=true')

    const get = await h.req('GET', '/settings')
    assert.equal(get.status, 200)
    assert.equal(get.json.saved.throttleMs, 7777, 'GET 的 saved 必须来自磁盘（不陈旧）')
    assert.ok('effective' in get.json, '应同时给出 effective（内存生效值）')
  } finally {
    h.cleanup()
  }
})

test('2026-11-04：磁盘值与内存生效值不同时给出重启提示', async () => {
  const h = boot()
  try {
    await h.req('POST', '/settings', { throttleMs: 8888 })
    const get = await h.req('GET', '/settings')
    assert.ok(get.json.note, '磁盘/内存不同时应提示需重启')
    assert.match(String(get.json.note), /重启/)
  } finally {
    h.cleanup()
  }
})

// ── 2026-11-04 测试回归 ─────────────────────────────────────────────────────
// 🔴 P0：cs-bots 的 HTTP API 此前**完全没有鉴权**——公网 curl 直接 200，
//   任何人可建任务/改记忆/写房间/改注册表，并借高层绕过受保护区写闸门。
//   修复方式：所有请求先过 src/fence.js 的 judgeHttp。

test('2026-11-04 P0：经代理的请求在无宿主校验能力时必须 403', async () => {
  const { judge } = await import('../src/fence.js')
  const proxied = { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4', host: 'example.com' } }
  const verdict = judge(proxied, {})
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
})

test('2026-11-04 P0：宿主会话有效才放行，无效 401，抛错 fail-closed', async () => {
  const { judge } = await import('../src/fence.js')
  const req = { method: 'GET', headers: { 'x-forwarded-for': '1.2.3.4', host: 'example.com' } }

  assert.equal(judge(req, { getConnection: () => ({ requestRejection: () => 0 }) }).ok, true)
  assert.equal(judge(req, { getConnection: () => ({ requestRejection: () => 401 }) }).status, 401)
  assert.equal(judge(req, { getConnection: () => ({ requestRejection: () => 1 }) }).status, 403)
  assert.equal(
    judge(req, { getConnection: () => ({ requestRejection: () => { throw new Error('boom') } }) }).status,
    403,
    '校验抛错必须 fail-closed，不能当放行',
  )
})

test('2026-11-04 P0：跨源 Origin 必须被拒（防 CSRF）', async () => {
  const { judge } = await import('../src/fence.js')
  const crossOrigin = {
    method: 'POST',
    headers: { origin: 'http://evil.example', host: '150.158.175.241' },
  }
  const verdict = judge(crossOrigin, { getConnection: () => ({ requestRejection: () => 0 }) })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-origin')
})

test('2026-11-04 P0：API handler 对无会话的代理请求返回 403（端到端）', async () => {
  const h = boot()
  try {
    // 构造"经 nginx 转发的公网请求"：有 x-forwarded-for，且宿主无 connection 服务
    const payload = [Buffer.from(JSON.stringify({ subject: 'unauth-probe' }), 'utf8')]
    const request = Object.assign(Readable.from(payload), {
      method: 'POST',
      url: `${API_BASE}/tasks`,
      headers: { 'x-forwarded-for': '1.2.3.4', host: '150.158.175.241' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    let status = 0
    let raw = ''
    const response = {
      writeHead: (code) => { status = code },
      end: (chunk) => { raw += chunk ?? '' },
      setHeader: () => {},
    }
    await h.handler()(request, response)
    assert.equal(status, 403, `公网未认证请求必须 403，实际 ${status}`)
    assert.equal(JSON.parse(raw).ok, false)
  } finally {
    h.cleanup()
  }
})

// ── 改造07：穿透面板（下层 AI 基础设施）─────────────────────────────────────

test('改造07 穿透：GET /deepdive/blocks 返回 6 个下层区块', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/deepdive/blocks')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.ok(Array.isArray(json.blocks), 'blocks 应是数组')
    const ids = json.blocks.map((b) => b.id)
    for (const want of ['registry', 'wake', 'store', 'routing', 'verify', 'suggest']) {
      assert.ok(ids.includes(want), `应含区块 ${want}，实际 ${ids.join(',')}`)
    }
  } finally {
    h.cleanup()
  }
})

test('改造07 穿透：每个区块带 label / description / stats', async () => {
  const h = boot()
  try {
    const { json } = await h.req('GET', '/deepdive/blocks')
    for (const b of json.blocks) {
      assert.ok(typeof b.label === 'string' && b.label.length > 0, `区块 ${b.id} 应有 label`)
      assert.ok(typeof b.description === 'string', `区块 ${b.id} 应有 description`)
      assert.ok(b.stats && typeof b.stats === 'object', `区块 ${b.id} 应有 stats`)
    }
  } finally {
    h.cleanup()
  }
})

test('改造07 穿透：GET /deepdive/block/registry 返回 Bot 列表', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/deepdive/block/registry')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.block, 'registry')
    assert.ok(Array.isArray(json.data.bots), 'registry 区块应返回 bots 数组')
  } finally {
    h.cleanup()
  }
})

test('改造07 穿透：GET /deepdive/block/store 返回状态目录文件列表', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/deepdive/block/store')
    assert.equal(status, 200)
    assert.ok(Array.isArray(json.data.files), 'store 区块应返回 files 数组')
    assert.equal(typeof json.data.stateDir, 'string')
  } finally {
    h.cleanup()
  }
})

test('改造07 穿透：GET /deepdive/block/wake 返回唤醒统计与最近记录', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/deepdive/block/wake')
    assert.equal(status, 200)
    assert.ok(json.data.stats && typeof json.data.stats === 'object')
    assert.ok(Array.isArray(json.data.recent))
  } finally {
    h.cleanup()
  }
})

test('改造07 穿透：未知区块返回 404 且带可读原因', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('GET', '/deepdive/block/nope')
    assert.equal(status, 404)
    assert.equal(json.ok, false)
    assert.match(json.reason, /未知区块/)
  } finally {
    h.cleanup()
  }
})

test('改造07 穿透：POST /deepdive/op 不支持的操作返回 400', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('POST', '/deepdive/op', { block: 'nope', op: 'nope' })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
  } finally {
    h.cleanup()
  }
})

test('改造07 穿透：POST /deepdive/op store/replay 执行成功', async () => {
  const h = boot()
  try {
    const { status, json } = await h.req('POST', '/deepdive/op', { block: 'store', op: 'replay' })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.match(json.text, /replay/)
  } finally {
    h.cleanup()
  }
})

// ── 改造07：任务订阅（借鉴 Super-agent Subscription 扇出）────────────────────

test('改造07 订阅：POST /subscriptions 订阅后 GET 可查到', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/subscriptions', { taskId: 't-1', roomId: 'room-a' })
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    assert.equal(created.json.sub.state, 'active')

    const listed = await h.req('GET', '/subscriptions?taskId=t-1')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.subs.length, 1)
    assert.equal(listed.json.subs[0].taskId, 't-1')
  } finally {
    h.cleanup()
  }
})

test('改造07 订阅：缺 taskId/roomId 返回 400（绝不静默）', async () => {
  const h = boot()
  try {
    const a = await h.req('POST', '/subscriptions', { roomId: 'r' })
    assert.equal(a.status, 400)
    const b = await h.req('POST', '/subscriptions', { taskId: 't' })
    assert.equal(b.status, 400)
  } finally {
    h.cleanup()
  }
})

test('改造07 订阅：POST /subscriptions/unsubscribe 取消订阅', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/subscriptions', { taskId: 't-2', roomId: 'room-b' })
    const id = created.json.sub.id
    const out = await h.req('POST', '/subscriptions/unsubscribe', { id })
    assert.equal(out.status, 200)
    assert.equal(out.json.sub.state, 'dropped')

    const listed = await h.req('GET', '/subscriptions?state=active')
    assert.equal(listed.json.subs.length, 0)
  } finally {
    h.cleanup()
  }
})

test('改造07 订阅：/status 里能看到 subscription 服务', async () => {
  const h = boot()
  try {
    const { json } = await h.req('GET', '/status')
    assert.ok('subscription' in json.services, 'status 应含 subscription')
    assert.equal(json.services.subscription.available, true)
  } finally {
    h.cleanup()
  }
})

// ── 改造07：工单阶段机（任务列表带 stageInfo）────────────────────────────────

test('改造07 阶段：GET /tasks 每条任务带 stageInfo，且返回 stageSummary', async () => {
  const h = boot()
  try {
    await h.req('POST', '/tasks', { subject: 'T1', byId: 'ui' })
    const { status, json } = await h.req('GET', '/tasks')
    assert.equal(status, 200)
    assert.equal(json.tasks.length, 1)
    const t = json.tasks[0]
    assert.ok(t.stageInfo, '任务应带 stageInfo')
    for (const k of ['stage', 'label', 'group', 'needsPerson', 'reason']) {
      assert.ok(k in t.stageInfo, `stageInfo 应含 ${k}`)
    }
    // 新建未认领 → 排队中
    assert.equal(t.stageInfo.stage, 'working/queued')
    assert.ok(json.stageSummary, '应返回 stageSummary')
    assert.equal(json.stageSummary.total, 1)
  } finally {
    h.cleanup()
  }
})

test('改造07 阶段：GET /tasks/detail 带 stageInfo', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/tasks', { subject: 'T2', byId: 'ui' })
    const id = created.json.task.id
    const { status, json } = await h.req('GET', `/tasks/detail?id=${id}`)
    assert.equal(status, 200)
    assert.ok(json.stageInfo, 'detail 应带 stageInfo')
    assert.equal(json.stageInfo.stage, 'working/queued')
  } finally {
    h.cleanup()
  }
})

test('改造07 阶段：GET /tasks/summary 带 stageInfo', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/tasks', { subject: 'T3', byId: 'ui' })
    const id = created.json.task.id
    const { status, json } = await h.req('GET', `/tasks/summary?id=${id}`)
    assert.equal(status, 200)
    assert.ok(json.stageInfo, 'summary 应带 stageInfo')
    assert.equal(json.stageInfo.needsPerson, false)
  } finally {
    h.cleanup()
  }
})

// ── 改造08：HTTP 侧授权留痕（mandateBasis / mandateSender）────────────────────
// 与工具侧 `bot_task_create` 用**同一套参数名**，否则同一概念两种形状。

test('2026-11-09：POST /tasks 接受 mandateBasis/mandateSender 并落到 mandate', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const created = await h.req('POST', '/tasks', {
    subject: '带授权的任务',
    mandateBasis: 'explicit',
    mandateSender: 'boss',
  })
  assert.equal(created.status, 200)
  const task = created.json.task
  assert.equal(task.mandate.basis, 'explicit')
  assert.equal(task.mandate.sender, 'boss')
  assert.equal(task.mandateBasis, undefined, '扁平参数不能被当成任务字段存下来')
})

test('2026-11-09：POST /tasks 不给授权参数时 mandate 只记 sender（不编造 basis）', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const created = await h.req('POST', '/tasks', { subject: '普通任务' })
  const task = created.json.task
  assert.equal(task.mandate.basis, undefined, '没有依据就不能编造依据')
  assert.equal(typeof task.mandate.sender, 'string')
  assert.equal(task.mandateSender, undefined)
})

test('2026-11-09：POST /tasks 传非法 mandateBasis → 400 且带可读原因', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const res = await h.req('POST', '/tasks', { subject: 'x', mandateBasis: '我猜的' })
  assert.equal(res.status, 400)
  assert.match(JSON.stringify(res.json), /mandate\.basis/, '报错要指出是哪个字段')
})

test('2026-11-09：锚定文案在**有依据**时带授权行（执行者必须知道谁批的）', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const created = await h.req('POST', '/tasks', {
    subject: '任务', description: '目标原文',
    mandateBasis: 'explicit', mandateSender: 'boss',
  })
  const id = created.json.task.id

  const brief = await h.req('GET', `/tasks/brief?id=${id}`)
  assert.equal(brief.status, 200)
  assert.match(brief.json.text, /授权（谁批准的、凭什么/, '有依据才渲染授权块')
  assert.match(brief.json.text, /人明确点名要做/, 'explicit 的含义要写清楚')
  assert.match(brief.json.text, /下达者：boss/, '下达者要写明')
  assert.match(brief.json.text, /超出此授权范围的新需求要重新要授权/, '不能让执行者以为可以随便干')
})

test('2026-11-09：🔴 没有依据就不渲染授权块（不编造授权）', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const created = await h.req('POST', '/tasks', { subject: 'UI 随手建的任务' })
  const id = created.json.task.id
  const brief = await h.req('GET', `/tasks/brief?id=${id}`)
  assert.doesNotMatch(brief.json.text, /授权（谁批准的/, 'UI 建任务记的是「谁建的」，不是「谁授权的」')
})

test('2026-11-09：inferred 依据要标明「推断，动手前先确认」', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const created = await h.req('POST', '/tasks', {
    subject: '推断任务', mandateBasis: 'inferred', mandateSender: 'rule-engine',
  })
  const id = created.json.task.id
  const brief = await h.req('GET', `/tasks/brief?id=${id}`)
  assert.match(brief.json.text, /按规则推断/)
  assert.match(brief.json.text, /动手前先确认/)
})

// ── 改造09：房间发消息 → 订阅扇出，必须经过 Gate ─────────────────────────────
// 生产路径上的关键纪律：**不相关消息不占执行者的上下文窗口**。

test('2026-11-09：房间消息经 Gate 准入后扇出（未点名 → inferred，记上下文不唤醒）', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const room = await h.req('POST', '/rooms', { name: '闸门房' })
  const roomId = room.json.room.id
  const task = await h.req('POST', '/tasks', { subject: '订阅任务' })
  const taskId = task.json.task.id

  const sub = await h.req('POST', '/subscriptions', { taskId, roomId })
  assert.equal(sub.status, 200, JSON.stringify(sub.json))
  assert.equal(sub.json.sub.acceptMode, 'observe', '缺省最保守的一档')

  // 发一条没点名（且不带 to）的消息 → 候选：记上下文、不唤醒
  const posted = await h.req('POST', '/rooms/post', { roomId, text: '闲聊一句', from: 'ui' })
  assert.equal(posted.status, 200, JSON.stringify(posted.json))
  const detail = posted.json.fanout?.details?.[0]
  assert.ok(detail, '应有扇出明细')
  assert.equal(detail.admission, 'inferred')
  assert.equal(detail.admitted, true)
  assert.equal(detail.woke, false, '候选不打扰人')
})

test('2026-11-09：🔴 带 to 定向点名 → explicit（定向发言是最强的点名证据）', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const room = await h.req('POST', '/rooms', { name: '定向房' })
  const roomId = room.json.room.id
  const task = await h.req('POST', '/tasks', { subject: '被点名任务' })
  const taskId = task.json.task.id
  await h.req('POST', '/subscriptions', { taskId, roomId })

  const posted = await h.req('POST', '/rooms/post', {
    roomId, text: '这活归你', from: 'ui', to: taskId,
  })
  assert.equal(posted.status, 200, JSON.stringify(posted.json))
  const detail = posted.json.fanout?.details?.[0]
  assert.equal(detail.admission, 'explicit', 'gate 认 room.post 的 to 字段')
  assert.equal(detail.admitted, true)
})

test('2026-11-09：🔴 acceptMode=off 时房间里未点名的消息连上下文都不记', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const room = await h.req('POST', '/rooms', { name: '关闸房' })
  const roomId = room.json.room.id
  const task = await h.req('POST', '/tasks', { subject: '静默任务' })
  const taskId = task.json.task.id

  await h.req('POST', '/subscriptions', { taskId, roomId, acceptMode: 'off' })
  const posted = await h.req('POST', '/rooms/post', { roomId, text: '闲聊', from: 'ui' })
  const detail = posted.json.fanout?.details?.[0]
  assert.equal(detail.admission, 'ignore')
  assert.equal(detail.admitted, false, 'off 下连上下文都不记')
})

test('2026-11-09：🔴 off 模式下点名仍然准入（三档模式都要放行 explicit）', async (t) => {
  const h = boot()
  t.after(() => rmSync(h.stateDir, { recursive: true, force: true }))

  const room = await h.req('POST', '/rooms', { name: '关闸但不聋' })
  const roomId = room.json.room.id
  const task = await h.req('POST', '/tasks', { subject: '点名任务' })
  const taskId = task.json.task.id

  await h.req('POST', '/subscriptions', { taskId, roomId, acceptMode: 'off' })
  const posted = await h.req('POST', '/rooms/post', {
    roomId, text: '点名了', from: 'ui', to: taskId,
  })
  const detail = posted.json.fanout?.details?.[0]
  assert.equal(detail.admission, 'explicit', '官方：三档模式下 explicit 都准入')
  assert.equal(detail.admitted, true)
})
