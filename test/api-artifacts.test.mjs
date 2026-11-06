/**
 * cs-bots 改造03 · 只读端点测试（成果聚合 / 数据浏览 / 任务依赖图）
 *
 * 依据：`design/CONTRACT-bots03.md` §1–§3。
 * 手法与 api-v3.test.mjs 一致：直接调注册出去的 handler，不启真服务器。
 *
 * 为什么必须测这几个端点：
 *   - `/artifacts` 是「成果」页签唯一数据源，错一个字段页面就是空白；
 *   - `/data/*` 是**文件系统读取**，必须证明目录穿越被拒（安全红线）；
 *   - `/tasks/graph` 决定「任务流程进度」画得对不对，闭包算错会误导排期。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-art-'))
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
  return {
    ctx, stateDir, services,
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
    cleanup() {
      const s = getServices(ctx)
      for (const k of ['dispatcher', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { s[k]?.dispose?.() } catch {}
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

/** 建一个带 artifacts 的已完成任务（走域服务，保证与生产同路径）。 */
function completeTask(board, subject, artifacts, opts = {}) {
  const t = board.create({ subject, byId: opts.byId ?? 'bot-a', description: opts.desc })
  board.update({ id: t.id, expectedRev: 1, action: 'claim', byId: opts.byId ?? 'bot-a' })
  const claimed = board.get(t.id)
  board.update({
    id: t.id, expectedRev: claimed.rev, action: 'complete',
    byId: opts.byId ?? 'bot-a', artifacts,
  })
  return board.get(t.id)
}

// ── /artifacts ──────────────────────────────────────────────────────────────

test('成果：空库返回空数组 + 统计为 0', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r = await h.req('GET', '/artifacts')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.artifacts, [])
  assert.deepEqual(r.json.stats, { tasks: 0, items: 0 })
})

test('成果：只返回带 artifacts 的任务，且 items 归一成字符串数组', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const board = h.services.board
  board.create({ subject: '没有产出物的任务', byId: 'bot-a' })
  completeTask(board, '实现登录接口', ['src/api.js', { file: 'test/login.test.mjs', sha: 'abc' }])

  const r = await h.req('GET', '/artifacts')
  assert.equal(r.status, 200)
  assert.equal(r.json.artifacts.length, 1)
  const a = r.json.artifacts[0]
  assert.equal(a.subject, '实现登录接口')
  assert.equal(a.status, 'completed')
  assert.equal(a.ownerId, 'bot-a')
  assert.equal(a.items.length, 2)
  assert.equal(a.items[0], 'src/api.js')
  // 对象元素用单行 JSON 表示（可被页面直接显示）
  assert.ok(a.items[1].includes('test/login.test.mjs'))
  assert.equal(r.json.stats.tasks, 1)
  assert.equal(r.json.stats.items, 2)
})

test('成果：关键词 q 过滤（匹配产出物路径，大小写不敏感）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const board = h.services.board
  completeTask(board, '任务甲', ['SRC/Login.js'])
  completeTask(board, '任务乙', ['docs/readme.md'])

  const hit = await h.req('GET', '/artifacts?q=login')
  assert.equal(hit.status, 200)
  assert.equal(hit.json.artifacts.length, 1)
  assert.equal(hit.json.artifacts[0].subject, '任务甲')

  const miss = await h.req('GET', '/artifacts?q=zzz-not-exist')
  assert.equal(miss.json.artifacts.length, 0)
})

test('成果：ownerId 过滤', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const board = h.services.board
  completeTask(board, 'A 的活', ['a.txt'], { byId: 'bot-a' })
  completeTask(board, 'B 的活', ['b.txt'], { byId: 'bot-b' })

  const r = await h.req('GET', '/artifacts?ownerId=bot-a')
  assert.equal(r.json.artifacts.length, 1)
  assert.equal(r.json.artifacts[0].ownerId, 'bot-a')
})

test('成果：status 过滤 + limit 上限被夹到 1000', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const board = h.services.board
  completeTask(board, '已完成的', ['x.txt'])

  const completed = await h.req('GET', '/artifacts?status=completed')
  assert.equal(completed.json.artifacts.length, 1)

  const pending = await h.req('GET', '/artifacts?status=pending')
  assert.equal(pending.json.artifacts.length, 0)

  // limit=99999 不能把服务器拖死：实现夹到 1000，这里只断言不报错且结构正确
  const big = await h.req('GET', '/artifacts?limit=99999')
  assert.equal(big.status, 200)
  assert.ok(Array.isArray(big.json.artifacts))
})

// ── /data/files & /data/rows ────────────────────────────────────────────────

test('数据：/data/files 列出 stateDir 直属 jsonl/json 并给行数', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  // 造两个文件（apply 已建了 board.jsonl 等，追加自己的）
  writeFileSync(join(h.stateDir, 'demo.jsonl'), '{"a":1}\n{"a":2}\n')
  writeFileSync(join(h.stateDir, 'demo.snap.json'), '{"version":1}\n')
  // 不该被列出：扩展名不符 / 子目录
  writeFileSync(join(h.stateDir, 'notes.txt'), 'x')
  mkdirSync(join(h.stateDir, 'rooms'), { recursive: true })

  const r = await h.req('GET', '/data/files')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.stateDir, h.stateDir)
  const names = r.json.files.map((f) => f.name)
  assert.ok(names.includes('demo.jsonl'), '应该列出 demo.jsonl')
  assert.ok(names.includes('demo.snap.json'), '应该列出 demo.snap.json')
  assert.ok(!names.includes('notes.txt'), '非 jsonl/json 不应列出')
  assert.ok(!names.includes('rooms'), '子目录不应列出（只扫直属文件）')

  const demo = r.json.files.find((f) => f.name === 'demo.jsonl')
  assert.equal(demo.kind, 'jsonl')
  assert.equal(demo.lines, 2)
  assert.ok(demo.bytes > 0)
  assert.ok(typeof demo.mtime === 'number')
})

test('数据：/data/rows 分页 + 坏 JSON 行不崩', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const lines = []
  for (let i = 1; i <= 5; i += 1) lines.push(JSON.stringify({ i }))
  lines.push('{ this is not json')
  writeFileSync(join(h.stateDir, 'rows.jsonl'), lines.join('\n') + '\n')

  const p1 = await h.req('GET', '/data/rows?name=rows.jsonl&limit=3&offset=0')
  assert.equal(p1.status, 200)
  assert.equal(p1.json.total, 6)
  assert.equal(p1.json.rows.length, 3)
  assert.equal(p1.json.rows[0]._line, 1)
  assert.ok(p1.json.rows[0]._raw.includes('"i":1'))

  const p2 = await h.req('GET', '/data/rows?name=rows.jsonl&limit=3&offset=3')
  assert.equal(p2.json.rows.length, 3)
  assert.equal(p2.json.rows[0]._line, 4)
  // 第 6 行是坏 JSON：仍返回原文，但标记 _parseError
  const bad = p2.json.rows[2]
  assert.equal(bad._parseError, true)
  assert.ok(bad._raw.includes('not json'))
})

test('数据：非法 name / dir 一律 400（拒绝目录穿越）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  for (const bad of [
    '?name=../../etc/passwd',
    '?name=..%2F..%2Fetc%2Fpasswd',
    '?name=.',
    '?name=',
    '?name=foo.txt',
  ]) {
    const r = await h.req('GET', `/data/rows${bad}`)
    assert.equal(r.status, 400, `路径 ${bad} 应被拒绝`)
    assert.equal(r.json.ok, false)
  }

  const files = await h.req('GET', '/data/files?dir=..')
  assert.equal(files.status, 400)

  const files2 = await h.req('GET', '/data/files?dir=rooms')
  // rooms 是合法单段目录：允许（即便不存在也只返回空列表，不 500）
  assert.equal(files2.status, 200)
  assert.ok(Array.isArray(files2.json.files))
})

test('数据：不存在的文件返回 404 而不是 500', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r = await h.req('GET', '/data/rows?name=no-such.jsonl')
  assert.equal(r.status, 404)
  assert.equal(r.json.ok, false)
})

// ── /tasks/graph ────────────────────────────────────────────────────────────

test('依赖图：无 id 返回全量节点与边', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const board = h.services.board
  const a = board.create({ subject: 'A', byId: 'lead', now: 1000 })
  const b = board.create({ subject: 'B', byId: 'lead', blockedBy: [a.id], now: 1001 })
  board.create({ subject: 'C', byId: 'lead', blockedBy: [b.id], now: 1002 })

  const r = await h.req('GET', '/tasks/graph')
  assert.equal(r.status, 200)
  assert.equal(r.json.nodes.length, 3)
  assert.equal(r.json.edges.length, 2)
  const edge = r.json.edges.find((e) => e.from === b.id)
  assert.equal(edge.to, a.id)
  assert.equal(edge.kind, 'blockedBy')
  // 节点字段齐（前端画图直接用）
  const node = r.json.nodes.find((n) => n.id === a.id)
  for (const k of ['id', 'subject', 'status', 'progress', 'priority']) {
    assert.ok(k in node, `节点缺字段 ${k}`)
  }
})

test('依赖图：带 id 返回传递闭包（上游 + 下游）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const board = h.services.board
  const a = board.create({ subject: 'A', byId: 'lead', now: 1000 })
  const b = board.create({ subject: 'B', byId: 'lead', blockedBy: [a.id], now: 1001 })
  const c = board.create({ subject: 'C', byId: 'lead', blockedBy: [b.id], now: 1002 })
  // 无关任务：不应出现在闭包里
  const z = board.create({ subject: 'Z', byId: 'lead', now: 1003 })

  const mid = await h.req('GET', `/tasks/graph?id=${b.id}`)
  assert.equal(mid.status, 200)
  const ids = mid.json.nodes.map((n) => n.id).sort()
  assert.deepEqual(ids, [a.id, b.id, c.id].sort())
  assert.ok(!ids.includes(z.id), '无关任务不应进闭包')

  // 边只在闭包内
  assert.equal(mid.json.edges.length, 2)
})

test('依赖图：不存在的 id 返回 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r = await h.req('GET', '/tasks/graph?id=t-999')
  assert.equal(r.status, 404)
  assert.equal(r.json.ok, false)
})

test('依赖图：删除的任务不进全量图', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const board = h.services.board
  const a = board.create({ subject: 'A', byId: 'lead', now: 1000 })
  const b = board.create({ subject: 'B', byId: 'lead', now: 1001 })
  board.update({ id: b.id, expectedRev: 1, action: 'delete', byId: 'lead', now: 1002 })

  const r = await h.req('GET', '/tasks/graph')
  const ids = r.json.nodes.map((n) => n.id)
  assert.ok(ids.includes(a.id))
  assert.ok(!ids.includes(b.id), '已删除任务不应出现在图中')
})
