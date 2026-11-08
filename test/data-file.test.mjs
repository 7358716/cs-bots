/**
 * cs-bots 改造06 §2.2 · 交付物文件只读预览端点测试（GET /data/file?path=）
 *
 * 手法与 `test/api-anchor.test.mjs` 一致：直接调注册出去的 handler（boot() 假 ctx + req()）。
 *
 * 为什么必须测：
 *   - 路径穿越（`..`）与「绝对路径逃逸出状态目录」是文件预览端点的**主要攻击面**，
 *     必须机械守住 —— 放行一次就等于任意文件读；
 *   - 二进制必须 415（前端拿到半个 utf8 文本会渲染成乱码，静默失败）；
 *   - >100KB 必须截断且**如实标注** truncated，否则前端以为看到了全文。
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
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-data-file-'))
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

test('GET /data/file：缺 path → 400', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r = await h.req('GET', '/data/file')
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'path 必填')
})

test('GET /data/file：路径穿越 `..` → 400 非法路径', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r = await h.req('GET', `/data/file?path=${encodeURIComponent('..')}`)
  assert.equal(r.status, 400)
  assert.equal(r.json.reason, '非法路径')

  const r2 = await h.req('GET', `/data/file?path=${encodeURIComponent('a/../b.json')}`)
  assert.equal(r2.status, 400)
  assert.equal(r2.json.reason, '非法路径')

  const r3 = await h.req('GET', `/data/file?path=${encodeURIComponent('../../etc/passwd')}`)
  assert.equal(r3.status, 400)
  assert.equal(r3.json.reason, '非法路径')
})

test('GET /data/file：stateDir 外的绝对路径 → 403 越权访问', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const outside = mkdtempSync(join(tmpdir(), 'cs-bots-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'secret.txt'), 'top secret', 'utf8')

  const r = await h.req('GET', `/data/file?path=${encodeURIComponent(join(outside, 'secret.txt'))}`)
  assert.equal(r.status, 403)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, '越权访问（路径超出状态目录）')
  assert.ok(!JSON.stringify(r.json).includes('top secret'), '不得泄露目录外文件内容')
})

test('GET /data/file：不存在 / 目录 → 404 文件不存在', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const missing = await h.req('GET', '/data/file?path=nope.json')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.reason, '文件不存在')

  writeFileSync(join(h.stateDir, 'plain.txt'), 'hello', 'utf8')
  const asDir = await h.req('GET', '/data/file?path=plain.txt/x')
  assert.equal(asDir.status, 404, '段合法但文件不存在 → 404')
  assert.equal(asDir.json.reason, '文件不存在')
})

test('GET /data/file：文本文件 200，字段齐全（含 mime 扩展名映射）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const body = JSON.stringify({ a: 1 })
  writeFileSync(join(h.stateDir, 'task-notes.jsonl'), `${body}\n`, 'utf8')

  const r = await h.req('GET', '/data/file?path=task-notes.jsonl')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.path, 'task-notes.jsonl')
  assert.equal(r.json.content, `${body}\n`)
  assert.equal(r.json.bytes, Buffer.byteLength(`${body}\n`, 'utf8'))
  assert.equal(r.json.truncated, false)
  assert.equal(r.json.mime, 'application/x-ndjson; charset=utf-8')
})

test('GET /data/file：二进制 → 415 不支持的文件类型', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  writeFileSync(join(h.stateDir, 'blob.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]), 'buffer')

  const r = await h.req('GET', '/data/file?path=blob.dat')
  assert.equal(r.status, 415)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, '不支持的文件类型（仅预览文本）')
})

test('GET /data/file：>100KB 截断，truncated:true 且字段齐全', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const big = 'x'.repeat(200 * 1024)
  writeFileSync(join(h.stateDir, 'big.txt'), big, 'utf8')

  const r = await h.req('GET', '/data/file?path=big.txt')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.truncated, true)
  assert.equal(r.json.bytes, Buffer.byteLength(big, 'utf8'))
  assert.equal(r.json.totalBytes, Buffer.byteLength(big, 'utf8'))
  assert.ok(r.json.shownBytes > 0)
  assert.ok(r.json.shownBytes <= 100 * 1024, `shownBytes 应 ≤ 100KB，实际 ${r.json.shownBytes}`)
  assert.equal(r.json.content.length, r.json.shownBytes)
})

test('GET /data/file：100KB 边界内的文本不截断', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const small = 'y'.repeat(100 * 1024)
  writeFileSync(join(h.stateDir, 'small.txt'), small, 'utf8')

  const r = await h.req('GET', '/data/file?path=small.txt')
  assert.equal(r.status, 200)
  assert.equal(r.json.truncated, false)
  assert.equal(r.json.content.length, 100 * 1024)
})

test('GET /data/file：只读 —— 读取不得产生任何缓存/预览文件', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  writeFileSync(join(h.stateDir, 'only.txt'), 'readonly', 'utf8')

  const r = await h.req('GET', '/data/file?path=only.txt')
  assert.equal(r.status, 200)

  const { readdirSync } = await import('node:fs')
  const names = readdirSync(h.stateDir).filter((n) => /preview|cache|tmp|copy/i.test(n))
  assert.deepEqual(names, [], `读取不得产生缓存/预览文件：${names.join(', ')}`)
})
