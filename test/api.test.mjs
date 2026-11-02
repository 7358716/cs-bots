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
