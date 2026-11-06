/**
 * cs-bots 改造04 · 任务目标锚 / 补充说明 / 直发消息 端点测试
 *
 * 依据：`design/CONTRACT-bots04.md` §2（已冻结）与 §4 验收清单。
 * 手法与 `test/api-artifacts.test.mjs` 一致：直接调注册出去的 handler，不启真服务器。
 *
 * 为什么必须测：
 *   - `GET /tasks/brief` 的 `text` 是给 Bot 的**全量目标原文**，格式错一个字就是
 *     「目标漂移」的入口，必须逐行断言结构；
 *   - `POST /tasks/note` 是 append-only 语义，覆盖写会直接毁掉补充历史；
 *   - `wake:false` 必须**绝不**调用 dispatcher（否则用户勾了「只保存」却被唤醒）；
 *   - `POST /bots/message` 的 400/404 决定页面能否给出可读错误，而不是静默失败。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-anchor-'))
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
    createTask(input = {}) {
      return services.board.create({ byId: 'user', ...input })
    },
    /** 把任务 claim 给某个 owner（ownerId 存在时 note 才应唤醒）。 */
    claimTask(task, ownerId = 'bot-a') {
      return services.board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: ownerId })
    },
    /**
     * 用捕获桩替换 dispatcher：既避免真实唤醒日志噪声，又能断言
     * 「到底有没有调 notify、唤醒文案与 dedupKey 是什么」。
     * @returns {object[]} 捕获到的 notify 请求
     */
    stubDispatcher(result = { ok: true, result: 'sent' }) {
      const calls = []
      services.dispatcher = {
        notify(request) {
          calls.push(request)
          return { ...result }
        },
      }
      return calls
    },
    async createBot(name, cwd) {
      const r = await h.req('POST', '/roster', { name, cwd })
      assert.equal(r.status, 200, `建 Bot 失败：${JSON.stringify(r.json)}`)
      return r.json.bot
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

/** 造一个已完成、带产出物且被 owner 持有的任务。 */
function completeTask(h, subject, { desc, writeScopes, blockedBy, priority } = {}) {
  const t = h.createTask({ subject, description: desc, writeScopes, blockedBy, priority })
  h.claimTask(t, 'bot-a')
  const claimed = h.services.board.get(t.id)
  return h.services.board.update({
    id: t.id, expectedRev: claimed.rev, action: 'complete', byId: 'bot-a', artifacts: ['src/auth/login.js'],
  })
}

// ── GET /tasks/brief ────────────────────────────────────────────────────────

test('brief：缺 id → 400，任务不存在 → 404（均可读中文）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const missing = await h.req('GET', '/tasks/brief')
  assert.equal(missing.status, 400)
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.reason, 'id 必填')

  const notFound = await h.req('GET', '/tasks/brief?id=t-999')
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.ok, false)
  assert.equal(notFound.json.reason, '任务 t-999 不存在')
})

test('brief：返回 anchor/notes/text，锚定文案逐行符合契约 §2.1', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({
    subject: '实现登录接口',
    description: '标准：\n- 密码错误 401\n- 成功 200 + token',
    writeScopes: ['src/auth/'],
    priority: 8,
  })

  const r = await h.req('GET', `/tasks/brief?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.taskId, task.id)
  assert.equal(r.json.note, '目标锚来自任务创建时的原文；补充说明另存，不会覆盖目标')

  // anchor 字段齐全（前端直接渲染，不判 undefined）
  const a = r.json.anchor
  assert.equal(a.subject, '实现登录接口')
  assert.equal(a.description, '标准：\n- 密码错误 401\n- 成功 200 + token')
  assert.deepEqual(a.writeScopes, ['src/auth/'])
  assert.deepEqual(a.blockedBy, [])
  assert.equal(a.priority, 8)
  assert.equal(a.status, 'pending')
  assert.equal(a.ownerId, null)
  assert.equal(a.progress, 0)
  assert.deepEqual(a.artifacts, [])
  assert.equal(typeof a.createdAt, 'number')
  assert.deepEqual(r.json.notes, [])

  // text 固定结构（逐行）
  const text = r.json.text
  const lines = text.split('\n')
  assert.equal(lines[0], '【任务目标 · 原文锚定，禁止改写】')
  assert.equal(lines[1], `任务 ${task.id}：实现登录接口`)
  assert.ok(lines[2].startsWith('目标：标准：'), `目标行不符：${lines[2]}`)
  assert.ok(text.includes('目标：标准：\n- 密码错误 401\n- 成功 200 + token'))
  assert.ok(text.includes('\n边界：只改 src/auth/\n'))
  assert.ok(text.includes('\n前置：（无）\n'))
  assert.ok(text.includes('\n进度：0%\n'))
  assert.ok(text.includes('\n已交付：（暂无）\n'))
  assert.ok(text.endsWith('补充说明（按时间，全部有效，不得忽略）：'))
  // 没有补充说明时不应凭空生成 bullet
  assert.ok(!/\n- \[/.test(text), '空补充说明不应出现列表项')
})

test('brief：已完成任务带 owner/前置/产出物，补充说明按时间列出', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const dep = h.createTask({ subject: '准备数据库迁移' })
  h.claimTask(dep, 'bot-a')
  const depClaimed = h.services.board.get(dep.id)
  h.services.board.update({
    id: dep.id, expectedRev: depClaimed.rev, action: 'complete', byId: 'bot-a', artifacts: ['db/migrate.sql'],
  })

  const task = completeTask(h, '实现登录接口', {
    desc: '标准：\n- 密码错误 401',
    writeScopes: ['src/auth/'],
    blockedBy: [dep.id],
    priority: 9,
  })

  const noted = await h.req('POST', '/tasks/note', { id: task.id, text: '别忘了限流', wake: false })
  assert.equal(noted.status, 200, JSON.stringify(noted.json))

  const r = await h.req('GET', `/tasks/brief?id=${task.id}`)
  assert.equal(r.status, 200)
  const a = r.json.anchor
  assert.equal(a.status, 'completed')
  assert.equal(a.ownerId, 'bot-a')
  assert.equal(a.priority, 9)
  assert.deepEqual(a.blockedBy, [dep.id])
  assert.deepEqual(a.artifacts, ['src/auth/login.js'])

  assert.equal(r.json.notes.length, 1)
  assert.equal(r.json.notes[0].text, '别忘了限流')
  assert.equal(r.json.notes[0].by, 'ui')
  assert.equal(typeof r.json.notes[0].at, 'number')
  assert.equal(r.json.notes[0].taskId, undefined, 'brief.notes 按契约只暴露 id/text/by/at')

  const text = r.json.text
  assert.ok(text.includes(`\n前置：${dep.id}\n`), '前置应逗号拼接出 blockedBy')
  assert.ok(text.includes('\n已交付：src/auth/login.js\n'))
  assert.match(text, /补充说明（按时间，全部有效，不得忽略）：\n- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 别忘了限流$/)
})

// ── POST /tasks/note ────────────────────────────────────────────────────────

test('note：缺 id / 空文本 / 超长 → 400（超长文案逐字对齐契约）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '实现登录接口' })

  const noId = await h.req('POST', '/tasks/note', { text: '别忘了限流' })
  assert.equal(noId.status, 400)
  assert.equal(noId.json.reason, 'id 必填')

  const empty = await h.req('POST', '/tasks/note', { id: task.id, text: '   ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.ok, false)
  assert.ok(empty.json.reason.length > 0)

  const tooLong = await h.req('POST', '/tasks/note', { id: task.id, text: 'x'.repeat(4001) })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.json.ok, false)
  assert.equal(tooLong.json.reason, '补充说明过长（最多 4000 字）')

  const notFound = await h.req('POST', '/tasks/note', { id: 't-999', text: '你好' })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.reason, '任务 t-999 不存在')
})

test('note：追加语义 —— 两次产生两行，不覆盖；notes 按 at 升序', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '实现登录接口' })

  const empty = await h.req('GET', `/tasks/notes?id=${task.id}`)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.notes, [])

  const first = await h.req('POST', '/tasks/note', { id: task.id, text: '别忘了限流', wake: false })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(first.json.ok, true)
  assert.equal(first.json.note.id, 'n-1')
  assert.equal(first.json.note.taskId, task.id)
  assert.equal(first.json.note.text, '别忘了限流')
  assert.equal(first.json.note.by, 'ui')
  assert.equal(typeof first.json.note.at, 'number')
  assert.equal(first.json.wake, null, 'wake:false 时 wake 必须为 null')

  const second = await h.req('POST', '/tasks/note', {
    id: task.id, text: '再加一条：token 用 JWT', by: 'ui', wake: false,
  })
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.equal(second.json.note.id, 'n-2', '编号必须递增且不重复')
  assert.equal(second.json.wake, null)

  // 落盘 append-only：两行，第一条仍在
  const file = join(h.stateDir, 'task-notes.jsonl')
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 2, '两次补充必须是两行（append-only，不是覆盖）')
  assert.equal(rows[0].id, 'n-1')
  assert.equal(rows[0].text, '别忘了限流')
  assert.equal(rows[1].id, 'n-2')
  assert.equal(rows[1].text, '再加一条：token 用 JWT')

  const got = await h.req('GET', `/tasks/notes?id=${task.id}`)
  assert.equal(got.status, 200)
  assert.equal(got.json.taskId, task.id)
  assert.equal(got.json.notes.length, 2)
  assert.deepEqual(got.json.notes.map((n) => n.text), ['别忘了限流', '再加一条：token 用 JWT'])
  assert.ok(got.json.notes[0].at <= got.json.notes[1].at, 'notes 必须按 at 升序')
})

test('note：wake:false 时绝不调用 dispatcher', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '实现登录接口' })
  h.claimTask(task, 'bot-a') // 有 owner —— 若实现漏判 wake:false 就一定会调 notify
  const calls = h.stubDispatcher()

  const r = await h.req('POST', '/tasks/note', { id: task.id, text: '只保存，不唤醒', wake: false })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.wake, null)
  assert.deepEqual(calls, [], 'wake:false 时 dispatcher.notify 一次都不能被调用')
  assert.equal(r.json.note.text, '只保存，不唤醒')
})

test('note：无 owner 时不唤醒（wake=null），有 owner 时唤醒文案 = 完整锚定文案 + 补充说明', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  // 1) 无 owner：即使 wake 缺省 true 也不唤
  const orphan = h.createTask({ subject: '没人领的任务' })
  const idleCalls = h.stubDispatcher()
  const orphanNote = await h.req('POST', '/tasks/note', { id: orphan.id, text: '先记下' })
  assert.equal(orphanNote.status, 200)
  assert.equal(orphanNote.json.wake, null)
  assert.deepEqual(idleCalls, [], '任务无 owner 时不应唤醒')

  // 2) 有 owner：唤醒文案必须含**全量锚定文案**（含历史补充）+ 新增补充说明
  const task = completeTask(h, '实现登录接口', { desc: '标准：\n- 密码错误 401', writeScopes: ['src/auth/'] })
  await h.req('POST', '/tasks/note', { id: task.id, text: '旧的补充：注意限流', wake: false })

  const calls = h.stubDispatcher({ ok: true, result: 'sent' })
  const r = await h.req('POST', '/tasks/note', { id: task.id, text: '新的补充：token 用 JWT' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.wake, { ok: true, result: 'sent' }, 'notify 返回值必须原样透出')
  assert.equal(calls.length, 1)

  const wake = calls[0]
  assert.equal(wake.target, 'bot-a')
  assert.equal(wake.reason, 'task-assigned')
  assert.equal(wake.dedupKey, `task-note:${task.id}:${r.json.note.id}`)
  assert.ok(wake.text.startsWith('【任务目标 · 原文锚定，禁止改写】\n'), '唤醒文案必须整段前置锚定文案')
  assert.ok(wake.text.includes(`任务 ${task.id}：实现登录接口`))
  assert.ok(wake.text.includes('目标：标准：\n- 密码错误 401'))
  assert.ok(wake.text.includes('边界：只改 src/auth/'))
  assert.ok(wake.text.includes('旧的补充：注意限流'), '锚定文案必须包含历史补充说明（全量）')
  assert.ok(wake.text.endsWith('\n\n【新增补充说明】新的补充：token 用 JWT'), '补充说明必须单独成段附在最后')

  // 每次补充都是新 note id → dedupKey 不同，不会被前一条去重吞掉
  const calls2 = h.stubDispatcher()
  const r2 = await h.req('POST', '/tasks/note', { id: task.id, text: '第三条' })
  assert.equal(r2.status, 200)
  assert.equal(calls2.length, 1)
  assert.notEqual(calls2[0].dedupKey, wake.dedupKey)
})

// ── POST /bots/message ──────────────────────────────────────────────────────

test('bots/message：缺 id / 空文本 / 超长 → 400', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const noTarget = await h.req('POST', '/bots/message', { text: '你好' })
  assert.equal(noTarget.status, 400)
  assert.equal(noTarget.json.ok, false)
  assert.equal(noTarget.json.reason, 'botId 或 sessionId 必填')

  const noText = await h.req('POST', '/bots/message', { sessionId: 's-main' })
  assert.equal(noText.status, 400)
  assert.equal(noText.json.ok, false)
  assert.ok(noText.json.reason.length > 0)

  const specialMissing = await h.req('POST', '/bots/message', { botId: 'bot-x' }) // 只带 botId 而 text 为空
  assert.equal(specialMissing.status, 400, '缺 text 应先于 roster 查询被拒绝')

  const tooLong = await h.req('POST', '/bots/message', { sessionId: 's-main', text: 'y'.repeat(4001) })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.json.ok, false)
  assert.equal(tooLong.json.reason, '消息过长（最多 4000 字）')
})

test('bots/message：未知 botId → 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r = await h.req('POST', '/bots/message', { botId: 'bot-nope', text: '你好' })
  assert.equal(r.status, 404)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'Bot bot-nope 不存在')
})

test('bots/message：sessionId 未注册时仍允许投递，但 knownBot:false', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()

  const r = await h.req('POST', '/bots/message', { sessionId: 's-main-dialog', text: '在吗' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.sessionId, 's-main-dialog')
  assert.equal(r.json.knownBot, false)
  assert.deepEqual(r.json.wake, { ok: true, result: 'sent' })
  assert.equal(r.json.text, '在吗', '无 taskId 时不应前置锚定文案')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, 's-main-dialog')
  assert.equal(calls[0].reason, 'room-message')
  assert.match(calls[0].dedupKey, /^ui-msg:[0-9a-f]{16}$/, '缺省 dedupKey = ui-msg: + sha1 前 16 位')
})

test('bots/message：botId → sessionId + knownBot:true；带 taskId 前置锚定文案，dedupKey 幂等', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const botDir = join(h.stateDir, 'bot-cwd')
  mkdirSync(botDir, { recursive: true })
  const bot = await h.createBot('anchor-bot', botDir)

  const task = h.createTask({ subject: '实现登录接口', description: '标准：\n- 密码错误 401', writeScopes: ['src/auth/'] })
  await h.req('POST', '/tasks/note', { id: task.id, text: '别忘了限流', wake: false })

  const calls = h.stubDispatcher()
  const r = await h.req('POST', '/bots/message', {
    botId: bot.id, text: '先做登录接口', taskId: task.id,
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.sessionId, bot.sessionId, 'botId 必须解析成 sessionId')
  assert.equal(r.json.knownBot, true)
  assert.deepEqual(r.json.wake, { ok: true, result: 'sent' })

  // 实际投递文案 = 完整锚定文案 + 空行 + 用户消息
  assert.ok(r.json.text.startsWith('【任务目标 · 原文锚定，禁止改写】\n'))
  assert.ok(r.json.text.includes(`任务 ${task.id}：实现登录接口`))
  assert.ok(r.json.text.includes('别忘了限流'))
  assert.ok(r.json.text.endsWith('\n\n先做登录接口'))

  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, bot.sessionId)
  assert.equal(calls[0].reason, 'room-message')
  assert.equal(calls[0].text, r.json.text, 'notify 的 text 必须与实际投递文案一致（可审计）')

  // 幂等：同一 taskId+text 重复投递，缺省 dedupKey 相同（内容相同则键相同）
  const r2 = await h.req('POST', '/bots/message', { botId: bot.id, text: '先做登录接口', taskId: task.id })
  assert.equal(r2.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].dedupKey, calls[0].dedupKey, '同一 taskId+text 的缺省 dedupKey 必须稳定')

  // 显式 dedupKey 优先透传
  const r3 = await h.req('POST', '/bots/message', {
    botId: bot.id, text: '另一个消息', dedupKey: 'ui-custom-1',
  })
  assert.equal(r3.status, 200)
  assert.equal(calls[2].dedupKey, 'ui-custom-1')
})

test('bots/message：taskId 不存在 → 404（绝不静默发出未锚定的消息）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()

  const r = await h.req('POST', '/bots/message', { sessionId: 's-main', text: '你好', taskId: 't-999' })
  assert.equal(r.status, 404)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, '任务 t-999 不存在')
  assert.deepEqual(calls, [], '任务不存在时不应投递')
})
