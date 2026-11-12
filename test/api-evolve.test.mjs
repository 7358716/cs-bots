/**
 * cs-bots 改造06 · 任务变更中心（纠错 / 优化 / 转长任务 / 换负责人）端点测试
 *
 * 依据：`design/CONTRACT-bots06.md` §2 与 §4 验收清单（已冻结，字段名/状态码/文案照做）。
 * 手法与 `test/api-revive.test.mjs` 一致：直接调注册出去的 handler，不启真服务器；
 * `agents` 用可编程桩（控制「已 live / 冷会话 / resume 失败」三态），dispatcher 用捕获桩。
 *
 * 为什么必须测（都是会真正丢证据/丢功能的地方）：
 *   - `board.reopen` 会清空 artifacts —— 若快照晚一步，「上一轮交付物」就永久丢失；
 *   - 已完成任务换负责人若让用户撞底层 `BOARD_ALREADY_COMPLETED`，界面上只会看到
 *     一串英文错误，用户不知道下一步该点「重开」；
 *   - WIP 超限**绝不能吞**：吞了就是「显示换人成功、其实任务没人做」；
 *   - followup 连点两次必须只建一张（sourceSeq 幂等），否则误点就多一张脏单；
 *   - longrun 阶段清单必须进 `task-meta.jsonl` + 唤醒文案，否则「转长任务」等于没转；
 *   - 没有 longrun 时锚定文案必须与改造04/05 **逐字一致**（既有测试有逐行断言）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

const DEFAULT_PHASES = ['范围与验收标准确认', '执行与自测', '交付与复盘']

/** 启动一个带「可编程 agents 桩」的环境（同 api-revive.test.mjs 的手法）。 */
function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-evolve-'))
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
      agents.live.add(options?.resumeSessionId)
      return { id: options?.resumeSessionId, sessionId: options?.resumeSessionId }
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
  const realDispatcher = services.dispatcher

  const h = {
    ctx,
    stateDir,
    services,
    agents,
    /** 造一个 Bot，并把它从 live 注册表摘掉（精确模拟重启后的「冷会话」）。 */
    async makeBot(name) {
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
    /** claim 到最新 rev（不写死 expectedRev，避免其他步骤改过 rev 后误判）。 */
    claimTask(task, ownerId = 'bot-a') {
      const cur = services.board.get(task.id)
      return services.board.update({ id: task.id, expectedRev: cur.rev, action: 'claim', byId: ownerId })
    },
    /** 造一个已完成、带产出物且被 owner 持有的任务。 */
    completeTask(task, { artifacts = ['out/deliver.js'], ownerId = 'bot-a' } = {}) {
      let cur = services.board.get(task.id)
      if (!cur.lease || cur.lease.ownerId !== ownerId) cur = h.claimTask(task, ownerId)
      return services.board.update({
        id: task.id, expectedRev: cur.rev, action: 'complete', byId: ownerId, artifacts,
      })
    },
    /** 捕获桩替换 dispatcher：断言「有没有 notify、键/文案是什么」，不写真实唤醒日志。 */
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
    /** 直接读 task-meta.jsonl（验证「真的落盘了」，不只看响应）。 */
    readMeta() {
      try {
        return readFileSync(join(stateDir, 'task-meta.jsonl'), 'utf8')
          .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
    cleanup() {
      try { realDispatcher?.dispose?.() } catch { /* 已释放 */ }
      for (const k of ['todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { getServices(ctx)[k]?.dispose?.() } catch { /* 已释放 */ }
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
  return h
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /tasks/reassign —— 变更负责人（契约 §2.1）
// ══════════════════════════════════════════════════════════════════════════════

test('E1 reassign：缺 id / 缺 ownerId → 400；任务不存在 → 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const noId = await h.req('POST', '/tasks/reassign', { ownerId: 'bot-x' })
  assert.equal(noId.status, 400)
  assert.equal(noId.json.ok, false)
  assert.equal(noId.json.reason, 'id 必填')

  const noOwner = await h.req('POST', '/tasks/reassign', { id: 't-1' })
  assert.equal(noOwner.status, 400)
  assert.equal(noOwner.json.reason, 'ownerId 必填')

  const missing = await h.req('POST', '/tasks/reassign', { id: 't-999', ownerId: 'bot-x' })
  assert.equal(missing.status, 404)
  assert.match(String(missing.json.reason), /不存在/)
})

test('E2 reassign 成功：原租约先交还 → 新负责人 claim → 唤醒 → 记历史', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const botB = await h.makeBot('reassign-b') // 冷会话：ensureLive 必须 resume
  const task = h.createTask({ subject: '实现登录限流', description: '标准：5 次/分钟' })
  h.claimTask(task, 'bot-a')
  assert.equal(h.services.board.get(task.id).ownerId, 'bot-a')

  const r = await h.req('POST', '/tasks/reassign', {
    id: task.id, ownerId: botB.sessionId, expectedRev: h.services.board.get(task.id).rev, byId: 'ui',
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.from, 'bot-a', '应回显原负责人')
  assert.equal(r.json.to, botB.sessionId)
  assert.equal(r.json.task.ownerId, botB.sessionId)
  assert.equal(r.json.task.status, 'in_progress')
  assert.equal(r.json.task.lease.ownerId, botB.sessionId, '租约必须转到新负责人名下')
  assert.equal(r.json.revived, true, '冷会话应被自动复活')
  assert.equal(h.agents.resumeCalls.length, 1)

  // 唤醒：target=新负责人；幂等键带换人语义与 rev；文案是完整锚定文案
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, botB.sessionId)
  assert.equal(calls[0].reason, 'task-assigned')
  assert.equal(calls[0].dedupKey, `task-reassign:${task.id}:${r.json.task.rev}`)
  assert.match(calls[0].text, /原文锚定，禁止改写/)
  assert.match(calls[0].text, /实现登录限流/)

  // task-meta.jsonl 真的落盘了一条 reassign
  const meta = h.readMeta().filter((row) => row.taskId === task.id)
  const reassign = meta.find((row) => row.kind === 'reassign')
  assert.ok(reassign, '必须记一条 kind:reassign')
  assert.equal(reassign.from, 'bot-a')
  assert.equal(reassign.to, botB.sessionId)
  assert.equal(reassign.by, 'ui')
  assert.equal(typeof reassign.at, 'number')

  // 变更历史里能读到（契约 §2.3）
  const changes = await h.req('GET', `/tasks/changes?id=${task.id}`)
  assert.equal(changes.status, 200)
  assert.equal(changes.json.changes.length, 1)
  assert.equal(changes.json.changes[0].kind, 'reassign')
  assert.equal(changes.json.changes[0].from, 'bot-a')
  assert.equal(changes.json.changes[0].to, botB.sessionId)
})

test('E3 reassign：已完成任务 → 400 + code:"TASK_COMPLETED" + 可读 reason', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const botB = await h.makeBot('reassign-done')
  const task = h.createTask({ subject: '已经交完的活' })
  h.completeTask(task)

  const r = await h.req('POST', '/tasks/reassign', { id: task.id, ownerId: botB.sessionId })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'TASK_COMPLETED')
  assert.equal(r.json.reason, '任务已完成，请先「重开」或「派生优化单」再换负责人')
  assert.deepEqual(calls, [], '被拦时绝不能再唤醒')
  assert.equal(h.services.board.get(task.id).status, 'completed', '被拦时任务状态不得被改')
  assert.equal(h.readMeta().filter((row) => row.kind === 'reassign').length, 0)
})

test('E4 reassign：WIP 超限 → 原样回传内核错误码（不吞）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.stubDispatcher()
  const botB = await h.makeBot('reassign-wip')
  // botB 先占满 2 个 in_progress（settings 默认 wipLimitPerBot=2）
  h.claimTask(h.createTask({ subject: 'wip-1' }), botB.sessionId)
  h.claimTask(h.createTask({ subject: 'wip-2' }), botB.sessionId)
  const target = h.createTask({ subject: 'wip-3' })
  h.claimTask(target, 'bot-a')

  const r = await h.req('POST', '/tasks/reassign', { id: target.id, ownerId: botB.sessionId })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'BOARD_WIP_EXCEEDED', '内核错误码必须原样回传（绝不改写成成功）')
  assert.match(String(r.json.reason), /WIP/, 'reason 应保留内核原文')
  assert.match(String(r.json.reason), /提示：/, '应附一句人话提示')
  // 失败不得伪造成「换人成功」的历史
  assert.equal(h.readMeta().filter((row) => row.kind === 'reassign').length, 0)
})

test('E5 reassign：wake:false 时不唤醒（wake=null、revived:false）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const botB = await h.makeBot('reassign-quiet')
  const task = h.createTask({ subject: '静默换人' })
  h.claimTask(task, 'bot-a')

  const r = await h.req('POST', '/tasks/reassign', {
    id: task.id, ownerId: botB.sessionId, wake: false,
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.wake, null)
  assert.equal(r.json.revived, false)
  assert.deepEqual(calls, [], 'wake:false 时 dispatcher.notify 一次都不能被调用')
  assert.equal(r.json.task.ownerId, botB.sessionId, '不唤醒也要真的换人')
})

// ══════════════════════════════════════════════════════════════════════════════
// POST /tasks/evolve —— 变更中心（契约 §2.2）
// ══════════════════════════════════════════════════════════════════════════════

test('E6 evolve：缺 id / 非法 mode / note 缺失或超长 / 任务不存在 → 400/404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '参数校验' })

  const noId = await h.req('POST', '/tasks/evolve', { mode: 'reopen', note: 'x' })
  assert.equal(noId.status, 400)
  assert.equal(noId.json.reason, 'id 必填')

  const badMode = await h.req('POST', '/tasks/evolve', { id: task.id, mode: 'destroy', note: 'x' })
  assert.equal(badMode.status, 400)
  assert.equal(badMode.json.code, 'EVOLVE_BAD_MODE')
  assert.match(String(badMode.json.reason), /reopen \| followup \| longrun/)

  for (const mode of ['reopen', 'followup', 'longrun']) {
    const empty = await h.req('POST', '/tasks/evolve', { id: task.id, mode, note: '   ' })
    assert.equal(empty.status, 400, `${mode} 的 note 必填`)
    assert.equal(empty.json.code, 'EVOLVE_NOTE_REQUIRED')
  }

  const tooLong = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'reopen', note: 'x'.repeat(4001),
  })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.json.code, 'EVOLVE_NOTE_TOO_LONG')

  const notFound = await h.req('POST', '/tasks/evolve', { id: 't-999', mode: 'reopen', note: 'x' })
  assert.equal(notFound.status, 404)
  assert.match(String(notFound.json.reason), /不存在/)
})

test('E7 evolve reopen：内核清空 artifacts，但 latestSnapshot 存档保住上一轮交付物', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '实现登录接口', description: '标准：密码错误 401' })
  const done = h.completeTask(task, { artifacts: ['src/auth/login.js', 'test/login.test.mjs'] })
  assert.equal(done.status, 'completed')

  const r = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'reopen', note: '第 3 条标准未满足：缺限流',
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.note, '已重开；上一轮交付物已存档，见 changes')
  assert.equal(r.json.task.status, 'pending')
  assert.equal(r.json.task.artifacts, undefined, '内核 reopen 会清空 artifacts（这是事实）')
  assert.equal(r.json.snapshot.before.status, 'completed')
  assert.deepEqual(r.json.snapshot.before.artifacts, ['src/auth/login.js', 'test/login.test.mjs'])
  assert.equal(typeof r.json.snapshot.before.completedAt, 'number')

  // 变更历史：snapshot 在前、reopen 在后；latestSnapshot 就是上一轮的交付物
  const got = await h.req('GET', `/tasks/changes?id=${task.id}`)
  assert.equal(got.status, 200)
  const kinds = got.json.changes.map((c) => c.kind)
  assert.deepEqual(kinds, ['snapshot', 'reopen'])
  assert.deepEqual(got.json.latestSnapshot.artifacts, ['src/auth/login.js', 'test/login.test.mjs'])
  assert.equal(got.json.latestSnapshot.status, 'completed')
  assert.equal(got.json.changes[1].note, '第 3 条标准未满足：缺限流')
  assert.equal(got.json.changes[1].by, 'ui')
  assert.equal(got.json.longrun, null)

  // 快照确实落盘（不是只在响应里）
  const snap = h.readMeta().find((row) => row.kind === 'snapshot' && row.taskId === task.id)
  assert.ok(snap, 'task-meta.jsonl 必须有 snapshot 行')
  assert.deepEqual(snap.before.artifacts, ['src/auth/login.js', 'test/login.test.mjs'])
})

test('E8 evolve reopen：本就 pending 无租约 → 视为成功（不报 BOARD_NOTHING_TO_REOPEN）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '还没开始的任务' })
  assert.equal(h.services.board.get(task.id).status, 'pending')

  const r = await h.req('POST', '/tasks/evolve', { id: task.id, mode: 'reopen', note: '补充要求' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.task.status, 'pending')
  const kinds = h.readMeta().filter((row) => row.taskId === task.id).map((row) => row.kind)
  assert.deepEqual(kinds, ['snapshot', 'reopen'], '即便无内容可重开，也要留快照与变更理由')
})

test('E9 evolve followup：派生新任务 + sourceSeq 幂等（连点两次只建一张）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({
    subject: '实现登录接口', description: '原始目标：密码错误返回 401', priority: 7,
  })
  h.completeTask(task, { ownerId: 'bot-a' })
  const before = h.services.board.list({}).length

  const mk = (note) => h.req('POST', '/tasks/evolve', { id: task.id, mode: 'followup', note })
  const first = await mk('修复：密码错误时应返回 401，现在是 500')
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(first.json.ok, true)
  assert.equal(first.json.origin, task.id)
  assert.equal(first.json.prefix, '【修复】')
  const derived = first.json.task
  assert.notEqual(derived.id, task.id)
  assert.equal(derived.subject, '【修复】实现登录接口')
  assert.match(String(derived.description), /原始目标：密码错误返回 401/)
  assert.match(String(derived.description), /【变更说明】修复：密码错误时应返回 401/)
  assert.match(String(derived.description), new RegExp(`【来源】原任务 ${task.id}`))
  assert.equal(derived.priority, 7, 'priority 继承原任务')
  assert.equal(derived.assignee, 'bot-a', 'assignee 继承原任务 ownerId')
  assert.match(derived.sourceSeq, new RegExp(`^evolve:${task.id}:[0-9a-f]{12}$`))
  assert.match(String(first.json.note), /已派生 /)
  assert.match(String(first.json.note), /重复点不会建两个/)

  // 连点第二次（同 note）：必须命中 sourceSeq 幂等，返回同一张，且不多建
  const second = await mk('修复：密码错误时应返回 401，现在是 500')
  assert.equal(second.status, 200)
  assert.equal(second.json.task.id, derived.id, '同一说明重复点必须命中幂等键')
  assert.equal(h.services.board.list({}).length, before + 1, '只应多一张任务')

  const followups = h.readMeta().filter((row) => row.kind === 'followup' && row.taskId === task.id)
  assert.equal(followups.length, 1, '连点不应重复记历史')
  assert.equal(followups[0].newTaskId, derived.id)
  assert.equal(followups[0].note, '修复：密码错误时应返回 401，现在是 500')

  // 原任务保持已完成（followup 不重开原任务）
  assert.equal(h.services.board.get(task.id).status, 'completed')
})

test('E10 evolve followup：前缀按 note 关键词选择（修复 / 优化 / 变更）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const cases = [
    ['登录接口有缺陷，会 500', '【修复】'],
    ['这个写法有 bug', '【修复】'],
    ['接口返回错码', '【修复】'],
    ['优化一下查询性能', '【优化】'],
    ['提升可读性，改进结构', '【优化】'],
    ['换个实现方式', '【变更】'],
  ]
  for (const [note, prefix] of cases) {
    const origin = h.createTask({ subject: '原任务' })
    const r = await h.req('POST', '/tasks/evolve', { id: origin.id, mode: 'followup', note })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.prefix, prefix, `note=${note} 应得到 ${prefix}`)
    assert.ok(r.json.task.subject.startsWith(prefix), r.json.task.subject)
  }
})

test('E11 evolve longrun：写 task-meta.jsonl，changes 能读 phases，唤醒文案带阶段清单', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const calls = h.stubDispatcher()
  const task = h.createTask({ subject: '重构权限模块' })
  h.claimTask(task, 'bot-a')

  const r = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'longrun', note: '这件事要做很多天',
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.phases, DEFAULT_PHASES, '没给 phases 时用契约默认三阶段')
  assert.equal(r.json.note, '已标记为长任务；后续每次唤醒都会带上阶段清单')
  assert.equal(r.json.task.status, 'in_progress', 'longrun 不动任务本体')

  const meta = h.readMeta().find((row) => row.kind === 'longrun' && row.taskId === task.id)
  assert.ok(meta, 'task-meta.jsonl 必须有一条 longrun')
  assert.deepEqual(meta.phases, DEFAULT_PHASES)
  assert.equal(meta.note, '这件事要做很多天')

  const changes = await h.req('GET', `/tasks/changes?id=${task.id}`)
  assert.equal(changes.status, 200)
  assert.deepEqual(changes.json.longrun.phases, DEFAULT_PHASES)
  assert.equal(typeof changes.json.longrun.at, 'number')
  assert.equal(changes.json.latestSnapshot, null)

  // 补充说明按契约追加到 task-notes.jsonl（【转长任务】+ note + 阶段清单）
  const notes = await h.req('GET', `/tasks/notes?id=${task.id}`)
  assert.equal(notes.status, 200)
  assert.equal(notes.json.notes.length, 1)
  assert.match(notes.json.notes[0].text, /^【转长任务】这件事要做很多天/)
  assert.match(notes.json.notes[0].text, /1\. 范围与验收标准确认/)

  // 「后续每次唤醒都会带上阶段清单」—— /tasks/wake 的投递文案必须含阶段段
  const wake = await h.req('POST', '/tasks/wake', { id: task.id })
  assert.equal(wake.status, 200, JSON.stringify(wake.json))
  assert.equal(calls.length, 1)
  assert.match(calls[0].text, /阶段（长任务，按序推进，不得跳步）：\n1\. 范围与验收标准确认/)
})

test('E12 evolve longrun：自定义 phases / 非法 phases 400', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '自定义阶段' })

  const ok = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'longrun', note: '分两阶段做', phases: ['先定接口', '再实现'],
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  assert.deepEqual(ok.json.phases, ['先定接口', '再实现'])

  const tooMany = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'longrun', note: 'x', phases: Array.from({ length: 13 }, (_, i) => `p${i}`),
  })
  assert.equal(tooMany.status, 400)
  assert.equal(tooMany.json.code, 'EVOLVE_BAD_PHASES')

  const tooLong = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'longrun', note: 'x', phases: ['x'.repeat(201)],
  })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.json.code, 'EVOLVE_BAD_PHASES')

  const notString = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'longrun', note: 'x', phases: [123],
  })
  assert.equal(notString.status, 400)
  assert.equal(notString.json.code, 'EVOLVE_BAD_PHASES')

  // 空数组视为「没给」→ 默认三阶段（契约未定义空数组；这里选宽松且在报告里说明）
  const empty = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'longrun', note: '空阶段', phases: [],
  })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.phases, DEFAULT_PHASES)
})

test('E13 evolve longrun + reopen:true：先快照再重开，证据与阶段都保住', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '转长任务并继续做' })
  h.completeTask(task, { artifacts: ['docs/design.md'] })

  const r = await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'longrun', note: '后面还有很多轮', reopen: true,
    phases: ['设计评审', '实现', '上线复盘'],
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.task.status, 'pending', 'reopen:true 应回到可做的状态')
  assert.equal(r.json.task.artifacts, undefined)
  assert.deepEqual(r.json.phases, ['设计评审', '实现', '上线复盘'])

  const got = await h.req('GET', `/tasks/changes?id=${task.id}`)
  assert.equal(got.status, 200)
  // 顺序：snapshot（变更前）→ reopen → longrun
  assert.deepEqual(got.json.changes.map((c) => c.kind), ['snapshot', 'reopen', 'longrun'])
  assert.deepEqual(got.json.latestSnapshot.artifacts, ['docs/design.md'], '重开后 evidence 不能丢')
  assert.deepEqual(got.json.longrun.phases, ['设计评审', '实现', '上线复盘'])
  for (let i = 1; i < got.json.changes.length; i += 1) {
    assert.ok(got.json.changes[i - 1].at <= got.json.changes[i].at, 'changes 必须按 at 升序')
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// GET /tasks/changes（契约 §2.3）
// ══════════════════════════════════════════════════════════════════════════════

test('E14 changes：缺 id → 400；任务不存在 → 404；无变更时三个字段给空骨架', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const noId = await h.req('GET', '/tasks/changes')
  assert.equal(noId.status, 400)
  assert.equal(noId.json.reason, 'id 必填')

  const missing = await h.req('GET', '/tasks/changes?id=t-999')
  assert.equal(missing.status, 404)

  const task = h.createTask({ subject: '没有任何变更' })
  const r = await h.req('GET', `/tasks/changes?id=${task.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.taskId, task.id)
  assert.deepEqual(r.json.changes, [])
  assert.equal(r.json.longrun, null)
  assert.equal(r.json.latestSnapshot, null)
})

// ══════════════════════════════════════════════════════════════════════════════
// buildTaskAnchorText：阶段段（契约 §2.4，只加不改）
// ══════════════════════════════════════════════════════════════════════════════

test('E15 anchor 文案：无 longrun 时与既有格式逐字一致；有 longrun 时在补充说明前插入阶段段', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '锚定文案基线' })

  // 基线：无 longrun、无补充说明 —— 必须与改造04/05 的固定格式**逐字一致**
  const before = await h.req('GET', `/tasks/brief?id=${task.id}`)
  assert.equal(before.status, 200)
  // 2026-11-12 t-40 需求③：锚文本在「补充说明」前固定新增「成果」段（每轮要有 md 产出物）。
  // 仍然成立的是**只加不改**：原有 8 行逐字不变，只在末尾前多出这一段。
  const expectedBase = [
    '【任务目标 · 原文锚定，禁止改写】',
    `任务 ${task.id}：锚定文案基线`,
    '目标：（未填写）',
    '边界：只改 （未限定）',
    '前置：（无）',
    '进度：0%',
    '已交付：（暂无）',
    '成果（t-40 需求③）：本轮要有可点开的 md 产出物，不要只写进对话里 ——',
    "  · 每轮结束都把结论写成 md 文件，再用 bot_task_update(action='complete', artifacts=[...]) 登记；",
    '  · 中途轮次同样要留文件（过程记录也算成果），别等收尾才一次性补；',
    '  · 没写文件就当没交付 —— 对话里的内容别人打不开、也追溯不了。',
    '补充说明（按时间，全部有效，不得忽略）：',
  ].join('\n')
  assert.equal(before.json.text, expectedBase, '无 longrun 时不得多出任何一行（成果段是固定内容）')

  // 转长任务后再读：阶段段插入在「补充说明」之前，其余行原样不动
  await h.req('POST', '/tasks/evolve', {
    id: task.id, mode: 'longrun', note: '这次要分阶段', phases: ['定标准', '实现'],
  })
  const after = await h.req('GET', `/tasks/brief?id=${task.id}`)
  assert.equal(after.status, 200)
  const lines = after.json.text.split('\n')
  assert.equal(lines[0], '【任务目标 · 原文锚定，禁止改写】')
  assert.equal(lines[6], '已交付：（暂无）')
  // 2026-11-12 t-40 需求③：阶段段之前固定插入「成果」段（4 行）。用**相对定位**
  // 而不是写死行号 —— 行号断言每次加一段就碎一次，是脆弱的写法。
  const iPhase = lines.indexOf('阶段（长任务，按序推进，不得跳步）：')
  assert.ok(iPhase > 0, '必须有阶段段')
  assert.equal(lines[iPhase + 1], '1. 定标准')
  assert.equal(lines[iPhase + 2], '2. 实现')
  // 实测渲染顺序：阶段段 → 成果段（4 行）→ 补充说明。按契约「只加不改」用相对定位。
  assert.ok(lines[iPhase + 3].startsWith('成果（t-40 需求③）'), '阶段段之后是成果段标题')
  assert.equal(lines[iPhase + 7], '补充说明（按时间，全部有效，不得忽略）：')
  assert.match(lines[iPhase + 8], /^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 【转长任务】这次要分阶段/)

  // 每次唤醒的文案也带阶段清单（/tasks/note 唤醒路径）
  h.claimTask(task, 'bot-a')
  h.agents.live.add('bot-a')
  const calls = h.stubDispatcher()
  const noted = await h.req('POST', '/tasks/note', { id: task.id, text: '继续推进' })
  assert.equal(noted.status, 200)
  assert.equal(calls.length, 1)
  // t-40 需求③：阶段段与补充说明之间固定插入「成果」段，故用 [\s\S] 跨过它
  assert.match(
    calls[0].text,
    /阶段（长任务，按序推进，不得跳步）：\n1\. 定标准\n2\. 实现\n[\s\S]*?成果（t-40 需求③）[\s\S]*?补充说明/,
  )
})

// ══════════════════════════════════════════════════════════════════════════
// 需求3（2026-11-09）：建任务时选「长任务」= 一次到位
//
// 用户原话：「建任务的时候选择长任务就是长表单一次到位」。
// 以前只能建普通任务再 `/tasks/evolve mode=longrun` 转，两步操作、两次留痕，
// 而且第一步派活时唤醒文案里没有阶段清单 —— 执行者第一轮就看不到路线。
// ══════════════════════════════════════════════════════════════════════════

test('长任务创建：longrun:true + phases 一次到位，阶段清单落 task-meta.jsonl', async () => {
  const h = boot()
  const phases = ['摸清现状', '改写入边界', '跑全量测试']
  const r = await h.req('POST', '/tasks', {
    subject: '一次到位长任务', description: '目标原文', longrun: true, phases,
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.longrun, true)
  assert.deepEqual(r.json.phases, phases, '响应要回显实际生效的阶段清单')
  const rows = h.readMeta().filter((row) => row.taskId === r.json.task.id && row.kind === 'longrun')
  assert.equal(rows.length, 1, '阶段清单必须真的落盘（不是只回显）')
  assert.deepEqual(rows[0].phases, phases)
})

test('长任务创建：只给 longrun:true 不给 phases ⇒ 默认三阶段（与 evolve 同一份口径）', async () => {
  const h = boot()
  const r = await h.req('POST', '/tasks', { subject: '默认阶段长任务', longrun: true })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.phases, DEFAULT_PHASES)
})

test('长任务创建：给非空 phases 但没显式 longrun:true，也按长任务建（语义等价）', async () => {
  const h = boot()
  const r = await h.req('POST', '/tasks', { subject: '只给阶段', phases: ['A', 'B'] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.phases, ['A', 'B'])
  assert.ok(h.readMeta().some((row) => row.kind === 'longrun' && row.taskId === r.json.task.id))
})

test('长任务创建：phases 非法时**先拒绝、不落半成品任务**（校验在建任务之前）', async () => {
  const h = boot()
  const before = h.services.board.list({}).length
  const r = await h.req('POST', '/tasks', {
    subject: '非法阶段', longrun: true, phases: Array.from({ length: 13 }, (_, i) => `阶段${i}`),
  })
  assert.equal(r.status, 400)
  assert.equal(r.json.code, 'TASK_BAD_PHASES')
  assert.equal(h.services.board.list({}).length, before, '非法阶段不该留下一条任务')
})

test('长任务创建：普通任务（不带 longrun/phases）行为逐字不变，不写 task-meta', async () => {
  const h = boot()
  const r = await h.req('POST', '/tasks', { subject: '普通任务' })
  assert.equal(r.status, 200)
  assert.equal(r.json.longrun, undefined, '普通任务不该冒出 longrun 字段')
  assert.equal(h.readMeta().filter((row) => row.taskId === r.json.task.id).length, 0)
})

test('长任务创建：第一次唤醒的锚定文案就带阶段清单（不用等「转长任务」）', async () => {
  const h = boot()
  const bot = await h.makeBot('longrun-anchor')
  const r = await h.req('POST', '/tasks', { subject: '锚定带阶段', longrun: true, phases: ['第一步', '第二步'] })
  const wake = h.stubDispatcher({ ok: true, result: 'sent' })
  await h.req('POST', '/tasks/assign', {
    id: r.json.task.id, ownerId: bot.sessionId, expectedRev: h.services.board.get(r.json.task.id).rev,
  })
  assert.equal(wake.length, 1, '应当发出一次唤醒')
  const text = String(wake[0].text)
  assert.match(text, /第一步/, '第一次唤醒就必须看到阶段清单')
  assert.match(text, /第二步/)
})

test('长任务创建 + 授权依据：mandate 随创建落库，第一次唤醒文案带「授权」段', async () => {
  const h = boot()
  const bot = await h.makeBot('longrun-mandate')
  const r = await h.req('POST', '/tasks', {
    subject: '授权长任务', longrun: true, phases: ['A'], mandateBasis: 'explicit', mandateSender: 'ui',
  })
  assert.ok(r.json.task.mandate, '创建时就要记下授权依据')
  assert.equal(r.json.task.mandate.basis, 'explicit')
  const wake = h.stubDispatcher({ ok: true, result: 'sent' })
  await h.req('POST', '/tasks/assign', {
    id: r.json.task.id, ownerId: bot.sessionId, expectedRev: h.services.board.get(r.json.task.id).rev,
  })
  const text = String(wake[0].text)
  assert.match(text, /授权/, '有依据就必须渲染授权段')
  assert.match(text, /人明确点名/, '依据要写清楚是哪一档')
})

test('没有授权依据时不渲染授权段（宁可没有，不编造授权）', async () => {
  const h = boot()
  const bot = await h.makeBot('longrun-nomandate')
  const r = await h.req('POST', '/tasks', { subject: '无授权任务' })
  const wake = h.stubDispatcher({ ok: true, result: 'sent' })
  await h.req('POST', '/tasks/assign', {
    id: r.json.task.id, ownerId: bot.sessionId, expectedRev: h.services.board.get(r.json.task.id).rev,
  })
  assert.doesNotMatch(String(wake[0].text), /授权（谁批准/, 'UI 建的普通任务不是授权')
})
