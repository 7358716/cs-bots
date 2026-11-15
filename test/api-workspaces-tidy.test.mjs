/**
 * POST /workspaces/tidy —— 工作区整理（Boss：「工作区只有一个 CS-bots，可向下展开」）。
 *
 * ## 这个端点靠什么实现分层
 *   宿主 `owningParentFolder()` 会把「路径在某个已登记 Workspace 之下」的
 *   Workspace 自动嵌套进父分组 ⇒ 登记 <botsRoot> 一条，
 *   它下面的 <botsRoot>/<部门>/<Bot> 就自动折进去。
 *
 * ## 关键安全阀（测试重点）
 *   - 必须 confirm:true
 *   - **永不删 <botsRoot> 本身**
 *   - **永不删 <botsRoot> 下的子目录**（那是要展开的内容）
 *   - mode='stale' 只动旧 Bot 父目录；mode='all' 才全面清
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { API_BASE } from '../src/api.js'

const LEGACY = [
  '/home/ubuntu/output2026',
  '/home/ubuntu/output2026/butlers/dev',
  '/home/ubuntu/.dsh/watchdog',
  '/home/ubuntu/output/开发测试001',
  '/home/ubuntu/output/Bots升级',
  '/home/ubuntu/output/岗位管理员',
]

function boot({ workspaces = LEGACY, rootOverride } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cs-bots-tidy-'))
  const dshHome = join(base, '.dsh')
  const botsRoot = rootOverride ?? join(base, 'cs-bots')
  mkdirSync(join(dshHome, 'storages'), { recursive: true })
  mkdirSync(join(dshHome, 'cs-bots'), { recursive: true })
  mkdirSync(botsRoot, { recursive: true })
  for (const d of ['dev', 'qa', 'ops']) mkdirSync(join(botsRoot, d), { recursive: true })

  // 伪造宿主 workspace.json（listWorkspaceRecords 从这里读）
  const table = {}
  for (const p of workspaces) table[`ws-${p}`] = { path: p, title: p, sessionIds: [`s-${p}`], createdAt: 1 }
  writeFileSync(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: table }, global: { workspaceIds: Object.keys(table) },
  }))
  writeFileSync(join(dshHome, 'cs-bots', 'settings.json'), JSON.stringify({
    // ⚠️ 至少 2 个部门：只有 1 个时「并发峰值」必然是 1，串行测试会假绿
    botWorkspaceRoot: botsRoot,
    departments: [{ id: 'dev', name: '开发部' }, { id: 'qa', name: '测试部' }, { id: 'ops', name: '综合部' }],
  }))

  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  let agentSeq = 0
  const registered = new Set(workspaces)
  const deleted = []
  // 并发度探针：create 进入 +1、离开 -1，记录峰值。
  // 并发注册正是 0.10.2 「domain is inconsistent」的成因 ⇒ 峰值必须是 1。
  const conc = { inFlight: 0, max: 0 }
  const registry = {
    async resolveByPath(p) { return registered.has(p) ? { id: `ws-${p}`, path: p } : undefined },
    async create(p) {
      conc.inFlight += 1
      conc.max = Math.max(conc.max, conc.inFlight)
      try {
        await new Promise((r) => setTimeout(r, 1))   // 给并发留出交错窗口
        registered.add(p)
        return { workspace: { id: `ws-${p}`, path: p }, created: true }
      } finally { conc.inFlight -= 1 }
    },
  }
  const workspaceController = {
    async delete(req) { deleted.push(req.workspaceId); return { deleted: true } },
  }

  let handler = null
  const box = { get handler() { return handler } }
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (k) => {
      if (k === 'workspaceRegistry') return registry
      if (k === 'workspaceController') return workspaceController
      if (k === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      // roster.create 需要 agents（否则「agents.create 不可用」直接失败）
      if (k === 'agents') {
        return {
          live: new Set(),
          async create(r) {
            const id = r?.sessionId ?? `bot-t${(agentSeq += 1)}`
            return { id, sessionId: id }
          },
          get: () => undefined,
          list: () => [],
        }
      }
      if (k === 'webServer') return { register: ({ handler: hd }) => { handler = hd; return () => {} } }
      return undefined
    },
    on() {}, effect() {},
  }
  apply(ctx, { stateDir: join(dshHome, 'cs-bots') })

  return {
    botsRoot, deleted, registered, box, conc,
    async req(method, path, body) {
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0
      let raw = ''
      assert.ok(handler, 'API handler 应已注册')
      await handler(request, { writeHead(c) { status = c }, end(c) { raw += c ?? '' } })
      let json
      try { json = JSON.parse(raw) } catch { json = { _raw: raw } }
      return { status, json }
    },
    cleanup() {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
    },
  }
}

test('tidy：不带 confirm ⇒ 400 拒绝', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/workspaces/tidy', {})
    assert.equal(r.status, 400)
    assert.equal(r.json.reason, 'WORKSPACES_TIDY_NEEDS_CONFIRM')
    assert.deepEqual(h.deleted, [], '拒绝时不能动任何东西')
  } finally { h.cleanup() }
})

test('tidy：stale 模式只删旧 Bot 父目录，保核心项目目录', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'stale' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    // 旧 Bot 目录应被删
    assert.ok(h.deleted.includes('ws-/home/ubuntu/output/开发测试001'), '旧 Bot 目录应被移除')
    assert.ok(h.deleted.includes('ws-/home/ubuntu/output/Bots升级'))
    // 核心项目目录不该被删
    assert.ok(!h.deleted.includes('ws-/home/ubuntu/output2026'), '核心项目目录不该被 stale 模式删掉')
    assert.ok(!h.deleted.includes('ws-/home/ubuntu/output2026/butlers/dev'), '当前会话所在目录不该被删')
  } finally { h.cleanup() }
})

test('tidy：★ 永不删 <botsRoot> 本身', async () => {
  const h = boot()
  try {
    // 先让 root 已在列表里
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'all' })
    assert.equal(r.status, 200)
    assert.ok(!h.deleted.includes(`ws-${h.botsRoot}`), '主目录本身绝不能被删 —— 那是分层的锚点')
  } finally { h.cleanup() }
})

test('tidy：★ 永不删 <botsRoot> 下的子目录（那是要展开的内容）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cs-bots-tidy2-'))
  const sub = join(base, 'cs-bots', 'dev', '某岗')
  const h = boot({ workspaces: [...LEGACY, sub] })
  try {
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'all' })
    assert.equal(r.status, 200)
    const root = h.botsRoot
    for (const id of h.deleted) {
      assert.ok(!id.includes(`${root}/`), `子目录不该被删：${id}`)
    }
  } finally { h.cleanup(); try { rmSync(base, { recursive: true, force: true }) } catch { /* */ } }
})

test('tidy：all 模式清掉核心目录（会话不丢，只是未分组）', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'all' })
    assert.equal(r.status, 200)
    assert.ok(h.deleted.includes('ws-/home/ubuntu/output2026'), 'all 模式应连核心目录一起清')
  } finally { h.cleanup() }
})

test('tidy：会先把 <botsRoot> 登记上（分层的前提）', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'stale' })
    assert.equal(r.status, 200)
    assert.equal(r.json.rootRegistered?.ok, true, '主目录必须登记成功')
    assert.ok(h.registered.has(h.botsRoot), '登记后 registry 里应能看到主目录')
  } finally { h.cleanup() }
})

test('tidy：结果逐条返回，含被删路径与会话数（可核查）', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'stale' })
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.json.results) && r.json.results.length > 0, '要逐条列出')
    assert.ok(r.json.results.every((x) => typeof x.path === 'string' && typeof x.sessions === 'number'))
    assert.equal(typeof r.json.removed, 'number')
  } finally { h.cleanup() }
})

// ── 三级分层：cs-bots → 部门 → Bot（2026-11-15 Boss：「下级可以向下展开」）──
//
// 原理：宿主按**最近的已登记祖先**嵌套（owningParentFolder）。
// 只登记根 ⇒ Bot 目录父级是根，只有两级；把部门也登记上 ⇒ 才有三级。
// 关键安全点：**必须串行注册**，绝不 Promise.all（0.10.2 事故是并发注册导致重复）。

test('tidy：会串行登记「部门」和「Bot」目录，形成三级分层', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'stale' })
    assert.equal(r.status, 200)
    assert.ok(r.json.hierarchy, '应返回分层登记结果')
    assert.ok(h.registered.has(`${h.botsRoot}/dev`), '部门目录应被登记（否则只有两级）')
  } finally { h.cleanup() }
})

test('tidy：hierarchy:false 可关闭分级登记（只要主目录一层）', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'stale', hierarchy: false })
    assert.equal(r.status, 200)
    assert.equal(r.json.hierarchy.depts, 0, '关闭时不该登记部门')
    assert.ok(!h.registered.has(`${h.botsRoot}/dev`))
  } finally { h.cleanup() }
})

test('tidy：★ 分级登记严格串行（并发峰值必须是 1，否则会重演 domain inconsistent）', async () => {
  const h = boot()
  try {
    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'stale' })
    assert.equal(r.status, 200)
    assert.equal(h.conc.max, 1,
      `create 并发峰值应为 1，实际 ${h.conc.max} —— 并发注册会把同一路径注册两次，`
      + '正是 2026-11-15 workspace domain is inconsistent 的成因')
    assert.equal((r.json.hierarchy?.failed ?? []).length, 0)
  } finally { h.cleanup() }
})

test('tidy：★ Bot cwd 落在「部门字典外」的目录，也要给它建文件夹', async () => {
  // 实测踩过：3 个 Bot 在 misc/ 下，而 settings 只有 dev/qa/ops
  // ⇒ misc 没被登记 ⇒ 那 3 个 Bot 直接挂在根下，跟部门文件夹混在一层。
  const h = boot()
  try {
    // 造一个 cwd 在 misc/ 下的 Bot（misc 不在 settings.departments 里）
    const miscDir = join(h.botsRoot, 'misc', '临时岗')
    mkdirSync(miscDir, { recursive: true })
    await h.req('POST', '/roster', { name: '临时岗', cwd: miscDir, byId: 'ui' })

    const r = await h.req('POST', '/workspaces/tidy', { confirm: true, mode: 'stale' })
    assert.equal(r.status, 200)
    assert.ok(
      h.registered.has(join(h.botsRoot, 'misc')),
      '字典外但 Bot 实际所在的 misc/ 也必须登记成文件夹，否则它会挂在根下',
    )
  } finally { h.cleanup() }
})
