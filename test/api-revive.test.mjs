/**
 * cs-bots 改造05 · 唤醒前自动复活会话（修「派活报 agent-not-live」）
 *
 * 依据：`design/CONTRACT-bots05.md` §2 与 §4 验收清单。
 * 手法与 api-anchor/api-artifacts 一致：直接调注册出去的 handler，不启真服务器。
 *
 * 为什么必须测（都是线上真实踩过的坑）：
 *   - 11:38 重启 dsh-web 后，宿主不认识旧会话 → 派活/发言/补充全部 `agent-not-live`，
 *     用户在界面上看到的是「派活报错」。`ensureLive` 是唯一的解药，错一处就白改；
 *   - 「已经 live」时**绝不能**再 resume：那会给正在跑的 Agent 多余副作用；
 *   - resume 失败也**绝不能**抛错，必须把 reason 交回上层显示，否则用户只看到 500；
 *   - `/tasks/wake` 若沿用 assign 的 dedupKey（含 rev），重试会命中去重返回 skipped，
 *     人点「重试」看起来像没反应 —— 所以 force 必须换键。
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

/**
 * 启动一个带「可编程 agents 桩」的环境。
 *
 * `agents` 的行为由 `harness.agents` 控制：
 *   - `harness.agents.live`     Set，放进去的 sessionId 视为已经 live
 *   - `harness.agents.resumeCalls` 记录每次 resume 的入参
 *   - `harness.agents.resumeError` 设了就让 resume 抛错（测失败路径）
 */
function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-revive-'))
  let handler = null

  const agents = {
    live: new Set(),
    resumeCalls: [],
    resumeError: null,
    async create(request) {
      const id = request?.sessionId
      if (id) agents.live.add(id)
      return { id, sessionId: id }
    },
    get: (id) => (agents.live.has(id) ? { id, sessionId: id } : undefined),
    list: () => [...agents.live].map((id) => ({ id, sessionId: id })),
    async resume(options) {
      agents.resumeCalls.push(options)
      if (agents.resumeError) throw agents.resumeError
      const id = options?.resumeSessionId
      agents.live.add(id)
      return { id, sessionId: id }
    },
  }

  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') return agents
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
    ctx,
    stateDir,
    services,
    agents,
    /**
     * 造一个 Bot，并**把它从 live 注册表里摘掉** —— 精确模拟真实场景：
     * 注册表在磁盘上有记录，但 dsh-web 重启后宿主不认识这个会话。
     * （roster.create 会经 agents.create 建会话，那会让它天生 live，
     *  不摘掉就测不到「冷会话」这一关键路径。）
     */
    async makeBot(name = 'rev-bot') {
      const bot = await services.roster.create({
        name, cwd: `/tmp/${name}`, permission: 'workspace-write', byId: 'ui',
      })
      agents.live.delete(bot.sessionId)
      return bot
    },
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
    createTask(input = {}) {
      return services.board.create({ byId: 'user', ...input })
    },
    claimTask(task, ownerId) {
      return services.board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: ownerId })
    },
    /** 捕获桩替换 dispatcher：断言「有没有 notify、键是什么」，不写真实唤醒日志。 */
    stubDispatcher(result = { ok: true, result: 'sent' }) {
      const calls = []
      services.dispatcher = {
        notify: (request) => {
          calls.push(request)
          return { ...result }
        },
        flush: () => 0,
        stats: () => ({ total: calls.length, sent: calls.length, skipped: 0, failed: 0, pending: 0 }),
        list: () => [],
        dispose: () => {},
      }
      return calls
    },
    cleanup() {
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

// ── ensureLive 的三态（通过 /bots/revive 观察）────────────────────────────────

test('R1 已 live 的会话：不调用 resume（不得产生多余副作用）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.agents.live.add('bot-already')

  const r = await h.req('POST', '/bots/revive', { sessionId: 'bot-already' })
  assert.equal(r.status, 200)
  assert.equal(r.json.live, true)
  assert.equal(r.json.revived, false, '本来就在线，不应报告「复活了」')
  assert.equal(h.agents.resumeCalls.length, 0, '已 live 时绝不能调 resume')
})

test('R2 未 live 的会话：会 resume 并报告 revived:true', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const r = await h.req('POST', '/bots/revive', { sessionId: 'bot-cold' })
  assert.equal(r.status, 200)
  assert.equal(r.json.live, true)
  assert.equal(r.json.revived, true)
  assert.equal(h.agents.resumeCalls.length, 1)
  assert.equal(h.agents.resumeCalls[0].resumeSessionId, 'bot-cold')
})

test('R3 resume 抛错：不抛 500，返回 live:false + 可读 reason', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.agents.resumeError = new Error('session file corrupted')

  const r = await h.req('POST', '/bots/revive', { sessionId: 'bot-broken' })
  assert.equal(r.status, 200, '复活失败是业务事实，不是服务器错误')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.live, false)
  assert.equal(r.json.revived, false)
  assert.match(String(r.json.reason), /resume-failed/)
  assert.match(String(r.json.reason), /session file corrupted/)
})

test('R4 缺 sessionId：missing-session 而不是崩', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r = await h.req('POST', '/bots/revive', {})
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
})

test('R5 botId 找不到 → 404；找到则按其 sessionId 复活', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bot = await h.makeBot('rev-a')

  const miss = await h.req('POST', '/bots/revive', { botId: 'bot-nope' })
  assert.equal(miss.status, 404)

  const hit = await h.req('POST', '/bots/revive', { botId: bot.id })
  assert.equal(hit.status, 200)
  assert.equal(hit.json.sessionId, bot.sessionId)
  assert.equal(hit.json.revived, true)
})

// ── 四处投递点自动复活 ─────────────────────────────────────────────────────

test('R6 /tasks/assign：目标未 live → 先 resume 再 notify，响应带 revived:true', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const bot = await h.makeBot('rev-assign')
  const task = h.createTask({ subject: '派活自动复活' })

  const r = await h.req('POST', '/tasks/assign', {
    id: task.id, ownerId: bot.sessionId, expectedRev: 1,
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.revived, true, '响应应报告本次自动复活了会话')
  assert.equal(h.agents.resumeCalls.length, 1, '投递前必须 resume 一次')
  assert.equal(calls.length, 1, '复活后仍要真的投递')
  assert.equal(calls[0].target, bot.sessionId)
})

test('R7 /tasks/assign：resume 失败仍投递，但回传 reviveReason（不静默）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.agents.resumeError = new Error('boom')
  const calls = h.stubDispatcher({ ok: false, result: 'failed', reason: 'agent-not-live' })
  const bot = await h.makeBot('rev-fail')
  const task = h.createTask({ subject: '复活失败仍尝试投递' })

  const r = await h.req('POST', '/tasks/assign', {
    id: task.id, ownerId: bot.sessionId, expectedRev: 1,
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.revived, false)
  assert.match(String(r.json.reviveReason), /resume-failed/)
  assert.equal(calls.length, 1, '复活失败不能吞掉投递尝试')
  assert.equal(r.json.wake.result, 'failed')
})

test('R8 /tasks/assign：本来就在线时行为不变（revived:false，resume 零调用）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const bot = await h.makeBot('rev-warm')
  h.agents.live.add(bot.sessionId)
  const task = h.createTask({ subject: '在线时不多余复活' })

  const r = await h.req('POST', '/tasks/assign', {
    id: task.id, ownerId: bot.sessionId, expectedRev: 1,
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.revived, false)
  assert.equal(h.agents.resumeCalls.length, 0)
  assert.equal(calls.length, 1)
})

test('R9 /tasks/note：投递前自动复活（补充说明也走同一条通路）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const bot = await h.makeBot('rev-note')
  const task = h.createTask({ subject: '补充说明自动复活' })
  h.claimTask(task, bot.sessionId)

  const r = await h.req('POST', '/tasks/note', { id: task.id, text: '别忘了限流' })
  assert.equal(r.status, 200)
  assert.equal(r.json.revived, true)
  assert.equal(h.agents.resumeCalls.length, 1)
  assert.equal(calls.length, 1)
  // 唤醒文案必须是**全量锚定文案 + 这条补充**
  assert.match(calls[0].text, /原文锚定，禁止改写/)
  assert.match(calls[0].text, /别忘了限流/)
})

test('R10 /bots/message：投递前自动复活', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const bot = await h.makeBot('rev-msg')

  const r = await h.req('POST', '/bots/message', { botId: bot.id, text: '你好' })
  assert.equal(r.status, 200)
  assert.equal(r.json.revived, true)
  assert.equal(h.agents.resumeCalls.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, bot.sessionId)
})

// ── /bots/revive 批量 ──────────────────────────────────────────────────────

test('R11 /bots/revive {all:true}：串行复活全部未退役 Bot，返回三清单', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const a = await h.makeBot('batch-a')
  const b = await h.makeBot('batch-b')
  h.agents.live.add(a.sessionId) // a 本来就活

  const r = await h.req('POST', '/bots/revive', { all: true })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(r.json.total >= 2, `应覆盖至少两个 Bot，实际 ${r.json.total}`)
  assert.ok(r.json.revived.includes(b.sessionId), 'b 应被复活')
  assert.ok(!r.json.revived.includes(a.sessionId), 'a 本来在线，不应记入 revived')
  assert.ok(r.json.live.includes(a.sessionId))
  assert.ok(Array.isArray(r.json.failed))
  // 只对未 live 的那一个调用 resume
  assert.equal(h.agents.resumeCalls.filter((c) => c.resumeSessionId === a.sessionId).length, 0)
})

test('R12 /bots/revive {all:true}：部分失败不影响其它，失败原因进 failed 清单', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bot = await h.makeBot('batch-bad')
  h.agents.resumeError = new Error('disk gone')

  const r = await h.req('POST', '/bots/revive', { all: true })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true, '整体仍算处理成功')
  assert.ok(r.json.failed.some((f) => f.sessionId === bot.sessionId && /resume-failed/.test(String(f.reason))),
    '失败必须进 failed 清单并带原因')
})

// ── /tasks/wake 手动重试 ────────────────────────────────────────────────────

test('R13 /tasks/wake：无负责人 → 400；任务不存在 → 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.stubDispatcher()
  const task = h.createTask({ subject: '没负责人' })

  const noOwner = await h.req('POST', '/tasks/wake', { id: task.id })
  assert.equal(noOwner.status, 400)
  assert.match(String(noOwner.json.reason), /负责人/)

  const missing = await h.req('POST', '/tasks/wake', { id: 't-99999' })
  assert.equal(missing.status, 404)
})

test('R14 /tasks/wake：force（缺省 true）换新 dedupKey，重试不会被去重吞掉', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const bot = await h.makeBot('rev-wake')
  const task = h.createTask({ subject: '重试唤醒' })
  h.claimTask(task, bot.sessionId)

  const r = await h.req('POST', '/tasks/wake', { id: task.id })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.live, true)
  assert.equal(r.json.revived, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].dedupKey, /^task-wake:/)
  assert.notEqual(calls[0].dedupKey, `task-wake:${task.id}:${task.rev}`, 'force 必须换键，否则 skipped')
  // 唤醒文案仍是全量锚定（重试也不能退化成「快来干活」）
  assert.match(calls[0].text, /原文锚定，禁止改写/)
})

test('R15 /tasks/wake：force:false 时用 rev 键（幂等重试）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const bot = await h.makeBot('rev-wake2')
  const task = h.createTask({ subject: '幂等重试' })
  const claimed = h.claimTask(task, bot.sessionId)

  const r = await h.req('POST', '/tasks/wake', { id: task.id, force: false })
  assert.equal(r.status, 200)
  assert.equal(calls[0].dedupKey, `task-wake:${task.id}:${claimed.rev}`)
})

test('R16 /tasks/wake：复活失败仍投递，并回传 reviveReason', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.agents.resumeError = new Error('nope')
  const calls = h.stubDispatcher({ ok: false, result: 'failed', reason: 'agent-not-live' })
  const bot = await h.makeBot('rev-wake3')
  const task = h.createTask({ subject: '重试也救不活' })
  h.claimTask(task, bot.sessionId)

  const r = await h.req('POST', '/tasks/wake', { id: task.id })
  assert.equal(r.status, 200)
  assert.equal(r.json.live, false)
  assert.match(String(r.json.reviveReason), /resume-failed/)
  assert.equal(calls.length, 1)
  assert.equal(r.json.wake.result, 'failed')
})