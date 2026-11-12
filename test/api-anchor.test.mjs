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
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
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
  // 2026-11-12 t-40 需求③：锚文本新增「成果」段（每轮都要有 md 产出物），
  // 所以不再以「补充说明」结尾；改为断言它在补充说明之前、且内容到位。
  assert.ok(text.includes('\n成果（t-40 需求③）：'), '必须包含成果要求段')
  assert.ok(
    text.indexOf('成果（t-40 需求③）') < text.indexOf('补充说明（按时间，全部有效，不得忽略）：'),
    '成果段必须在补充说明之前',
  )
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

// ── GET /tasks/source（契约 §2.5；2026-11-07 补）──────────────────────────────
//
// 这一组测试守护的是「任务 → 回消息出处」这条闭环：
//   · 来源标记的三类前缀必须逐字判定，**不猜测**（unparsed 要如实上报）；
//   · 房间侧信息全部来自 room 服务：房间在不在、那条消息在不在，必须如实给出
//     （数据要如实返回，是否可跳由前端决定）；
//   · 端点**只读**：不写任何文件（§2.1/§2.3 同口径）。

/** 建一个房间 + 发若干条消息（走真实 HTTP 端点，与页面同路径）。 */
async function makeRoom(h, name, messages = ['第一条消息']) {
  const created = await h.req('POST', '/rooms', { name, members: ['user'], byId: 'user' })
  assert.equal(created.status, 200, `建房间失败：${JSON.stringify(created.json)}`)
  const roomId = created.json.room.id
  let seq = 0
  for (const text of messages) {
    const posted = await h.req('POST', '/rooms/post', { roomId, text, from: 'user' })
    assert.equal(posted.status, 200, `房间发言失败：${JSON.stringify(posted.json)}`)
    seq = posted.json.message.seq
  }
  return { roomId, seq, room: created.json.room }
}

/**
 * 造一个带 `sourceSeq` 的任务（幂等键即来源标记）。
 * 若 `seq` 与已有任务重复，board 会按 sourceSeq 幂等返回同一张 —— 这里不关心，
 * 只要拿到一条带指定 sourceSeq 的任务即可。
 */
function taskWithSource(h, sourceSeq, over = {}) {
  return h.createTask({ subject: `来源测试 ${sourceSeq}`, sourceSeq, ...over })
}

test('source：缺 id → 400（id 必填）；任务不存在 → 404（逐字对齐 §2.1/§2.3）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const missing = await h.req('GET', '/tasks/source')
  assert.equal(missing.status, 400)
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.reason, 'id 必填')

  const notFound = await h.req('GET', '/tasks/source?id=t-99')
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.ok, false)
  assert.equal(notFound.json.reason, '任务 t-99 不存在')
})

test('source：kind 判定顺序 —— room / todo / evolve / none / unparsed（契约 §2.5 表格）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  // 房间 id 恒为 `room-<uuid8>`（src/room.js:1032），**内部不含冒号**
  // → `sourceSeq.split(':')` 的三段切分是安全的（契约 §2.5 的口径说明）
  const room = await makeRoom(h, '来源判定房', ['把登录接口拆成三个子任务'])
  assert.match(room.roomId, /^room-[0-9a-f]{8}$/, '房间 id 必须是 room-<uuid8>')
  assert.ok(!room.roomId.includes(':'), '房间 id 内部不得含冒号（否则三段切分会错）')

  const roomTask = taskWithSource(h, `room:${room.roomId}:${room.seq}`)
  const todoTask = taskWithSource(h, 'todo:t-12')
  const evolveTask = taskWithSource(h, `evolve:${todoTask.id}:abc123def456`)
  const noneTask = h.createTask({ subject: '人建的任务' })
  const unparsedTask = taskWithSource(h, 'weird-marker-9')

  const rRoom = await h.req('GET', `/tasks/source?id=${roomTask.id}`)
  assert.equal(rRoom.status, 200, JSON.stringify(rRoom.json))
  assert.equal(rRoom.json.kind, 'room')
  assert.equal(rRoom.json.sourceSeq, `room:${room.roomId}:${room.seq}`)
  assert.equal(rRoom.json.source, roomTask.source, 'source 原样透出（不做二次推断）')
  assert.equal(rRoom.json.reason, null)
  assert.equal(rRoom.json.room.roomId, room.roomId)
  assert.equal(rRoom.json.room.name, '来源判定房')
  assert.equal(rRoom.json.room.seq, room.seq)
  assert.equal(rRoom.json.room.messageId, `m-${room.seq}`)
  assert.equal(rRoom.json.room.exists, true)
  assert.equal(rRoom.json.room.messageExists, true)
  assert.equal(rRoom.json.room.preview, '把登录接口拆成三个子任务')
  assert.equal(typeof rRoom.json.room.at, 'number')
  assert.deepEqual(rRoom.json.jump, { roomId: room.roomId, seq: room.seq })
  assert.equal(rRoom.json.hint, `来源：房间消息 ${room.roomId} #${room.seq}`)

  const rTodo = await h.req('GET', `/tasks/source?id=${todoTask.id}`)
  assert.equal(rTodo.status, 200)
  assert.equal(rTodo.json.kind, 'todo')
  assert.equal(rTodo.json.sourceSeq, 'todo:t-12')
  assert.equal(rTodo.json.room, null)
  assert.equal(rTodo.json.jump, null)
  assert.equal(rTodo.json.reason, null)

  const rEvolve = await h.req('GET', `/tasks/source?id=${evolveTask.id}`)
  assert.equal(rEvolve.status, 200)
  assert.equal(rEvolve.json.kind, 'evolve')
  assert.equal(rEvolve.json.sourceSeq, `evolve:${todoTask.id}:abc123def456`)
  assert.equal(rEvolve.json.room, null)
  assert.equal(rEvolve.json.jump, null)
  assert.equal(rEvolve.json.reason, null)

  const rNone = await h.req('GET', `/tasks/source?id=${noneTask.id}`)
  assert.equal(rNone.status, 200)
  assert.equal(rNone.json.kind, 'none')
  assert.equal(rNone.json.room, null)
  assert.equal(rNone.json.jump, null)
  assert.equal(rNone.json.sourceSeq, null, '没有 sourceSeq 时 sourceSeq 为 null（不是 undefined）')
  assert.equal(rNone.json.reason, null)

  const rBad = await h.req('GET', `/tasks/source?id=${unparsedTask.id}`)
  assert.equal(rBad.status, 200)
  assert.equal(rBad.json.kind, 'unparsed')
  assert.equal(rBad.json.sourceSeq, 'weird-marker-9')
  assert.equal(rBad.json.room, null)
  assert.equal(rBad.json.jump, null)
  assert.equal(
    rBad.json.reason,
    '无法解析来源标记 "weird-marker-9"（不是 room:/todo:/evolve: 前缀）',
    'unparsed 的 reason 必须写明原始标记（契约 §2.5 原文）',
  )
})

test('source：room 判定必须真的看格式 —— 残缺/畸形标记一律 unparsed（绝不猜测）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const room = await makeRoom(h, '畸形标记房', ['x'])

  const bad = [
    `room:${room.roomId}`,              // 缺 seq 段
    `room:${room.roomId}:`,             // seq 段为空
    `room::${room.seq}`,                // roomId 段为空
    `room:${room.roomId}:0`,            // seq 非正
    `room:${room.roomId}:-3`,           // seq 为负
    `room:${room.roomId}:1.5`,          // seq 非整数
    `room:${room.roomId}:1e2`,          // seq 是科学计数法（不是十进制整数字面量）
    `room:${room.roomId}:${room.seq}:x`, // 段数不对
    `todo:`,                            // 空 id
    `evolve:${room.roomId}:`,           // 尾段为空
    `todo:t-1:extra`,                   // 段数不对
  ]
  for (const marker of bad) {
    const task = taskWithSource(h, marker)
    const r = await h.req('GET', `/tasks/source?id=${task.id}`)
    assert.equal(r.status, 200, `${marker} → HTTP ${r.status}`)
    assert.equal(r.json.kind, 'unparsed', `${marker} 必须判 unparsed（实际 ${r.json.kind}）`)
    assert.equal(r.json.room, null)
    assert.equal(r.json.jump, null)
    assert.equal(r.json.reason, `无法解析来源标记 "${marker}"（不是 room:/todo:/evolve: 前缀）`)
  }

  // 边界：`room:<roomId>:07` 仍是数值 7（十进制整数字面量），必须判 room
  const padded = taskWithSource(h, `room:${room.roomId}:07`)
  const rPadded = await h.req('GET', `/tasks/source?id=${padded.id}`)
  assert.equal(rPadded.json.kind, 'room')
  assert.equal(rPadded.json.room.seq, 7)
})

test('source：来源消息真实存在 → messageExists true；被清理 → false 且不静默', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const room = await makeRoom(h, '消息存在性房', ['第一条', '第二条，来源应该是它'])
  const task = taskWithSource(h, `room:${room.roomId}:${room.seq}`)

  const r = await h.req('GET', `/tasks/source?id=${task.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.room.messageExists, true)
  assert.equal(r.json.room.preview, '第二条，来源应该是它')
  assert.deepEqual(r.json.jump, { roomId: room.roomId, seq: room.seq })

  // 消息已不在（seq 不在日志里）：messageExists=false，且**不静默**
  // —— room 仍是真实存在的房间，所以 exists 仍为 true（两者必须区分）
  const ghostTask = taskWithSource(h, `room:${room.roomId}:99999`)
  const rGhost = await h.req('GET', `/tasks/source?id=${ghostTask.id}`)
  assert.equal(rGhost.status, 200)
  assert.equal(rGhost.json.kind, 'room')
  assert.equal(rGhost.json.room.exists, true)
  assert.equal(rGhost.json.room.messageExists, false)
  assert.equal(rGhost.json.room.preview, null, '取不到消息就没有预览（不编）')
  assert.equal(rGhost.json.room.at, null)
  // 数据如实给出：jump 照常返回（是否可跳由前端决定）
  assert.deepEqual(rGhost.json.jump, { roomId: room.roomId, seq: 99999 })
})

test('source：preview = 正文首行截 80 字（含长正文走旁路文件的口径）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const longFirstLine = '第一行标题'.repeat(40) // 200 字 > 80
  const body = `${longFirstLine}\n第二行细节（预览只取首行）`
  const room = await makeRoom(h, '预览房', [body])
  const task = taskWithSource(h, `room:${room.roomId}:${room.seq}`)

  const r = await h.req('GET', `/tasks/source?id=${task.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.room.messageExists, true)
  assert.equal(r.json.room.preview.length, 80, '首行截 80 字')
  assert.ok(r.json.room.preview.startsWith('第一行标题'))
  assert.ok(!r.json.room.preview.includes('\n'), '预览不含换行（只取首行）')
  assert.ok(!r.json.room.preview.includes('第二行'), '预览不取第二行')
})

test('source：房间已删除 → room.exists false，jump 仍如实返回（数据不丢）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const room = await makeRoom(h, '待删房', ['会被一起删掉的消息'])
  const task = taskWithSource(h, `room:${room.roomId}:${room.seq}`)

  const removed = await h.req('POST', '/rooms/remove', { roomId: room.roomId, byId: 'user', force: true })
  assert.equal(removed.status, 200, `硬删房间失败：${JSON.stringify(removed.json)}`)

  const r = await h.req('GET', `/tasks/source?id=${task.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.kind, 'room')
  assert.equal(r.json.room.exists, false, '房间已删必须如实给出 exists:false')
  assert.equal(r.json.room.name, null, '房间不在就不该编一个名字')
  assert.equal(r.json.room.messageExists, null, '房间不存在时「消息在不在」无从谈起（不猜 false）')
  assert.equal(r.json.room.at, null)
  assert.equal(r.json.room.preview, null)
  assert.deepEqual(r.json.jump, { roomId: room.roomId, seq: room.seq }, 'jump 仍如实返回（前端据此判断能否跳）')
})

test('source：端点只读 —— 不新增任何文件（§2.1/§2.3 同口径）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const room = await makeRoom(h, '只读房', ['只读检查'])
  const task = taskWithSource(h, `room:${room.roomId}:${room.seq}`)

  const before = new Set(readdirSync(h.stateDir))
  await h.req('GET', `/tasks/source?id=${task.id}`)
  await h.req('GET', '/tasks/source?id=t-99')
  await h.req('GET', '/tasks/source')
  const after = new Set(readdirSync(h.stateDir))
  assert.deepEqual([...after].filter((x) => !before.has(x)), [], '只读端点不得新增状态文件')
})

test('source：鉴权走既有 createFence（不新增绕过；公网代理路径仍 403）', async (t) => {
  // 走真实 handler（而非 fence.judge 单测）：构造"经代理 + 宿主无 connection 服务"
  // 的请求，必须被既有围栏挡下 —— 新端点不能成为绕过鉴权的口子。
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-source-fence-'))
  let handler = null
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') {
        return {
          async create(request) { return { id: request?.sessionId, sessionId: request?.sessionId } },
          get: () => undefined, list: () => [],
        }
      }
      if (key === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      if (key === 'webServer') {
        return { register: ({ path, handler: fn }) => { assert.equal(path, API_BASE); handler = fn; return () => {} } }
      }
      return undefined
    },
    on: () => {}, effect: () => {},
  }
  apply(ctx, { stateDir })
  t.after(() => {
    try { getServices(ctx).dispatcher?.dispose?.() } catch {}
    rmSync(stateDir, { recursive: true, force: true })
  })

  const make = (url) => {
    const request = Object.assign(Readable.from([]), {
      method: 'GET', url,
      headers: { 'x-forwarded-for': '1.2.3.4', host: 'example.com' },
    })
    return new Promise((resolve) => {
      let status = 0
      let raw = ''
      const response = {
        writeHead(code) { status = code },
        end(chunk) { raw += chunk ?? ''; resolve({ status, json: JSON.parse(raw || '{}') }) },
      }
      handler(request, response)
    })
  }

  // 先建一个任务，才能验证「有 id 也被挡」
  const services = getServices(ctx)
  services.board.create({ subject: '围栏房任务', byId: 'user' })

  const denied = await make(`${API_BASE}/tasks/source?id=t-1`)
  assert.equal(denied.status, 403, '经代理的公网请求必须被既有围栏挡下')
  assert.equal(denied.json.ok, false)
})

// ══ 2026-11-12 t-40：任务栏要看到「用户说的话」+「执行者回复」═══════════════
//
// Boss：「任务栏中，应该把用户在对话中发送的信息和回复都展示出来」
// 原实现只读执行者会话，用户在任务里写的补充说明完全看不到 —— 任务栏永远缺一半。

test('t-40 对话：没有执行者会话时，用户的补充说明照样出现在时间线里', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '对话时间线' })

  // 用户在任务下发一条补充说明（这是「用户说过的话」的权威记录）
  const noted = await h.req('POST', '/tasks/note', { id: task.id, text: '先看登录接口，别动数据库', byId: 'user' })
  assert.equal(noted.status, 200, JSON.stringify(noted.json))

  const r = await h.req('GET', `/tasks/conversation?id=${task.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true, `不应因为"没有执行者会话"就整体失败：${JSON.stringify(r.json)}`)
  const texts = (r.json.messages ?? []).map((m) => m.text)
  assert.ok(
    texts.some((x) => String(x).includes('先看登录接口')),
    '★ 用户的补充说明必须出现在对话时间线里',
  )
  const noteMsg = (r.json.messages ?? []).find((m) => String(m.text).includes('先看登录接口'))
  assert.equal(noteMsg.source, 'note', '要标注来源，前端才能区分「任务里说的」')
  assert.equal(noteMsg.role, 'user', '人说的话角色必须是 user')
  assert.equal(r.json.counts.note, 1)
})

test('t-40 对话：既没派活也没补充说明 ⇒ 给可读空态（不是崩）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '空任务' })
  const r = await h.req('GET', `/tasks/conversation?id=${task.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.code, 'NO_CONVERSATION', '空态要有明确 code，前端据此显示引导')
})
