/**
 * cs-bots 升级09 · §5 任务诊断（B 侧）
 *
 * 依据：`docs/CONTRACT-升级09-Boss 体验.md` §5.1–§5.4。
 * 手法同 api-revive：真 `apply()` + 真 handler。
 *
 * 为什么必须测（真实翻车点）：
 *   - `diagnoseTask` 若猜 bot 名/预设，页面「执行者状态」就会显示假情报；
 *   - 模型路由判定必须复用 `assertDeliverable`（不是自己瞎猜），否则与真实投递不一致；
 *   - wakes 列表必须是真实日志，不能编造；
 *   - verdict/advice 必须与 blocker 一一映射，否则 Boss 点了建议按钮也没用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-diagnose-'))
  let handler = null

  // agents 桩：live 集合决定 get 是否返回会话；modelRoute 决定要不要挂 model.current
  // （assertDeliverable 只认「真的带 model.current() 的 agent」，所以要测模型分支必须显式挂）。
  const agents = {
    live: new Set(),
    modelRoute: undefined,
    async create(request) {
      const id = request?.sessionId
      agents.live.add(id)
      return { id, sessionId: id }
    },
    get(id) {
      if (!agents.live.has(id)) return undefined
      const agent = { id, sessionId: id }
      // 没设 modelRoute ⇒ 不挂访问器 ⇒ assertDeliverable 一律放行（与线上一致）
      if (agents.modelRoute !== undefined) {
        agent.model = { current: () => agents.modelRoute }
      }
      return agent
    },
    list: () => [...agents.live].map((id) => ({ id, sessionId: id })),
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

  const h = {
    ctx, stateDir, services,
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
    createTask(input = {}) { return services.board.create({ byId: 'user', ...input }) },
    cleanup() {
      for (const k of ['dispatcher', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { getServices(ctx)[k]?.dispose?.() } catch { /* 已释放 */ }
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
  return h
}

// ── §5 任务诊断 ────────────────────────────────────────────────────────────

test('§5 GET /tasks/diagnose：非长任务也能诊断（isLongrun 不在 diagnose 返回里，那是 /tasks/phases 的字段）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '普通任务' })

  const r = await h.req('GET', `/tasks/diagnose?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const j = r.json
  assert.equal(j.ok, true)
  assert.equal(j.taskId, task.id)
  // diagnose 返回的是 {ok,taskId,ownerId,bot,live,deliverable,wakes,verdict,advice}
  // 不含 isLongrun/phases（那是 §2 的 /tasks/phases 端点）
  assert.equal(typeof j.verdict, 'string', 'verdict 必须存在')
  assert.ok(['ok', 'blocked'].includes(j.verdict), `verdict 必须是 ok/blocked，实际 ${j.verdict}`)
  assert.ok(typeof j.advice === 'string' && j.advice.length > 0, 'advice 必须是一句人话')
  assert.ok(Array.isArray(j.wakes), 'wakes 必须数组')
  assert.ok(j.bot && typeof j.bot.name === 'string', 'bot 对象必须有 name')
})

test('§5 GET /tasks/diagnose：会话不在线 ⇒ verdict=blocked，advice 提到「复活」', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  // 建一个 Bot，然后**把它从 live 里摘掉**（模拟 dsh-web 重启后冷会话）。
  // ⚠️ roster.create 会走 kernel.createSession → agents.create，
  //    我们的桩会把新会话加进 live；不显式摘掉的话它其实是「在线」的，
  //    这条用例就白跑了（实际第一次跑就是这么假绿→真红的）。
  const bot = await h.services.roster.create({ name: 'cold-bot', cwd: '/tmp/cold-bot', permission: 'workspace-write', byId: 'ui' })
  h.ctx.get('agents').live.delete(bot.sessionId)
  const task = h.createTask({ subject: '冷任务', assignee: bot.sessionId })

  const r = await h.req('GET', `/tasks/diagnose?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const j = r.json
  assert.equal(j.verdict, 'blocked', '会话不在线 ⇒ blocked')
  assert.ok(/复活|重启|不在线/.test(j.advice), `advice 应提到复活/重启，实际：${j.advice}`)
  // bot 字段必须真实
  assert.equal(j.bot.name, 'cold-bot', 'bot.name 必须来自 roster')
  assert.equal(j.bot.hasSession, false, 'hasSession 必须 false（不在 agents.get）')
})

test('§5 GET /tasks/diagnose：会话在线但无模型路由 ⇒ verdict=blocked，advice 提到「模型」', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bot = await h.services.roster.create({ name: 'no-model-bot', cwd: '/tmp/no-model-bot', permission: 'workspace-write', byId: 'ui' })
  const task = h.createTask({ subject: '无模型任务', assignee: bot.sessionId })

  // 关键：会话必须**在线**，且 agent 真的暴露 model.current() 但返回空路由。
  // 若会话不在线，assertDeliverable 会放行（{ok:true}，理由「先复活再判定」），
  // 那样这条用例就根本没测到「无模型路由」这个分支 —— 必须显式构造成在线。
  //
  // ⚠️ 这里踩过一个坑：一开始写 `{provider:'', model:''}`，断言一直假红（ok 恒 true）。
  //    `assertDeliverable` 判的是 `typeof selection.provider === 'string'`，
  //    **空字符串也是 string** ⇒ 那是「有路由但名字为空」，不是「无路由」。
  //    真实的「没有 provider/model」是**字段不存在**，所以这里给 `{}`。
  const agents = h.ctx.get('agents')
  agents.live.add(bot.sessionId)
  agents.modelRoute = {}
  t.after(() => { agents.modelRoute = undefined })

  const r = await h.req('GET', `/tasks/diagnose?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const j = r.json
  assert.equal(j.bot.hasSession, true, '前提：会话必须在线（否则测不到模型分支）')
  assert.equal(j.deliverable.ok, false, 'deliverable.ok 必须 false')
  assert.equal(j.verdict, 'blocked', '无模型路由 ⇒ blocked')
  assert.ok(/模型/.test(j.advice), `advice 应提到模型，实际：${j.advice}`)
})

test('§5 GET /tasks/diagnose：wakes 列表来自真实日志（最多 10 条）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bot = await h.services.roster.create({ name: 'wake-bot', cwd: '/tmp/wake-bot', permission: 'workspace-write', byId: 'ui' })
  const task = h.createTask({ subject: '有唤醒日志的任务', assignee: bot.sessionId })

  // 伪造 wakes 日志（直接写 wakes.jsonl）
  // ⚠️ `readTaskWakes` 用 `wakeBelongsToTask` 过滤：只认 text 含「任务 <id>：」
  //    或 dedupKey 含 `:<id>:` 的行。不按这个形态写，读回来永远是空数组 ——
  //    那样这条用例就成了「空跑通过」，什么都没验到。
  const wakesFile = join(h.stateDir, 'wakes.jsonl')
  const base = Date.now()
  const lines = Array.from({ length: 15 }, (_, i) =>
    JSON.stringify({
      dedupKey: `task-wake:${task.id}:${i + 1}`,
      target: bot.sessionId,
      sentAt: base + i * 1000,          // diagnose 的 at 取自 sentAt/updatedAt/scheduledAt
      result: i % 2 ? 'sent' : 'skipped',
      reason: i % 3 ? 'ok' : 'agent-not-live',
    }),
  ).join('\n')
  // dispatcher 启动时只探了一次可写性，文件本身还没建 ⇒ 这里直接建出来。
  writeFileSync(wakesFile, lines + '\n', 'utf8')

  const r = await h.req('GET', `/tasks/diagnose?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const j = r.json
  assert.ok(Array.isArray(j.wakes), 'wakes 必须数组')
  assert.equal(j.wakes.length, 10, '写 15 条、最多回 10 条（取最近 10 条）')
  // 元素形态：{at, result, reason}
  for (const w of j.wakes) {
    assert.equal(typeof w.at, 'number', 'wakes.at 必须是从 sentAt 映射来的数字')
    assert.ok(w.at > 0, 'wakes.at 不得是 0（说明没映射到时间字段）')
    assert.equal(typeof w.result, 'string', 'wakes.result 必须是字符串')
  }
  // 取的是最后 10 条 ⇒ 第 i=5..14 条，sentAt 严格递增
  const ats = j.wakes.map((w) => w.at)
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b), 'wakes 应按时间升序（最近 10 条）')
  assert.equal(ats.at(-1), base + 14 * 1000, '最后一条应是日志里最新的一条')
})

test('§5 GET /tasks/diagnose：400/404 路径 —— 缺 id / 任务不存在', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r1 = await h.req('GET', '/tasks/diagnose')
  assert.equal(r1.status, 400, '缺 id 必须 400')
  assert.equal(r1.json.ok, false)
  assert.ok(/id/.test(r1.json.reason), '理由应提到 id')

  const r2 = await h.req('GET', '/tasks/diagnose?id=t-999999')
  assert.equal(r2.status, 404, '任务不存在必须 404')
  assert.equal(r2.json.ok, false)
  assert.ok(/不存在|not found/i.test(r2.json.reason), '理由应提到不存在')
})