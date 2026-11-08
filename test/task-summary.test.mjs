/**
 * cs-bots 改造06 §2.3 · 任务结论摘要端点测试（GET /tasks/summary?id=）
 *
 * 手法与 `test/api-anchor.test.mjs` 一致：直接调注册出去的 handler（boot() 假 ctx + req()）。
 *
 * 为什么必须测：
 *   - `currentProgress.lastNote` 与 `nextStep` 都从**最近一条 L4 笔记**提炼：
 *     笔记写错（或没写）时页面会显示「无结论」，必须逐字段断言；
 *   - `nextStep` 的关键词提取（下一步/todo/计划/接下来/待）决定了队长能否
 *     一眼看到「接下来干什么」，关键词漏一个就是静默丢失；
 *   - `stepConclusions` 必须按任务锚定过滤 wakes.jsonl，不能把别的任务的唤醒算进来。
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
import { appendJsonl } from '../src/store.js'

function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-task-summary-'))
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
    claimTask(task, ownerId = 'bot-a') {
      return services.board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: ownerId })
    },
    addL4Note(taskId, content, by = 'worker-1') {
      return services.memory.add({ layer: 'L4', content, by, taskId })
    },
    /** 直接往 wakes.jsonl 落一条唤醒记录（模拟 dispatcher 的审计流）。 */
    appendWake(row) {
      return appendJsonl(join(stateDir, 'wakes.jsonl'), row)
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

test('GET /tasks/summary：缺 id → 400；任务不存在 → 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const missing = await h.req('GET', '/tasks/summary')
  assert.equal(missing.status, 400)
  assert.equal(missing.json.reason, 'id 必填')

  const notFound = await h.req('GET', '/tasks/summary?id=t-999')
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.reason, '任务 t-999 不存在')
})

test('GET /tasks/summary：无 L4 笔记时 lastNote=null、nextStep=null、stepConclusions 空', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '无笔记任务' })

  const r = await h.req('GET', `/tasks/summary?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.taskId, task.id)
  assert.equal(r.json.currentProgress.status, 'pending')
  assert.equal(r.json.currentProgress.progress, 0)
  assert.equal(r.json.currentProgress.progressText, '0% · 待办')
  assert.equal(r.json.currentProgress.lastNote, null)
  assert.equal(r.json.nextStep, null)
  assert.deepEqual(r.json.stepConclusions, [])
  assert.equal(r.json.note, '结论由唤醒记录与 L4 任务笔记提炼；队长可通过任务笔记补充下一步方向')
})

test('GET /tasks/summary：有「下一步：xxx」笔记时 nextStep 提取正确', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '带下一步任务' })
  h.addL4Note(task.id, '已完成 A 模块\n下一步：写 B 模块的接口测试\n收尾：更新文档')

  const r = await h.req('GET', `/tasks/summary?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.currentProgress.lastNote, '已完成 A 模块\n下一步：写 B 模块的接口测试\n收尾：更新文档')
  assert.equal(r.json.nextStep, '下一步：写 B 模块的接口测试')
  assert.equal(r.json.stepConclusions.length, 0)
})

test('GET /tasks/summary：nextStep 关键词表（todo/计划/接下来/待）逐一命中', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const cases = [
    ['TODO 补单测', 'TODO 补单测'],
    ['计划：先跑回归', '计划：先跑回归'],
    ['接下来要处理合并冲突', '接下来要处理合并冲突'],
    ['待确认：接口是否冻结', '待确认：接口是否冻结'],
  ]
  for (const [note, expected] of cases) {
    const task = h.createTask({ subject: `关键词 ${note}` })
    h.addL4Note(task.id, note)
    const r = await h.req('GET', `/tasks/summary?id=${task.id}`)
    assert.equal(r.status, 200)
    assert.equal(r.json.nextStep, expected, `关键词提取失败：${note}`)
  }
})

test('GET /tasks/summary：stepConclusions 按任务锚定过滤 wakes.jsonl', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '有唤醒任务' })
  const other = h.createTask({ subject: '别的任务' })

  // 落两条本任务的唤醒（text 含任务锚定文案 + dedupKey 含 taskId），一条别任务的
  h.appendWake({
    id: 'w1', target: 'bot-a', reason: 'task-assigned',
    dedupKey: `task-assigned:${task.id}:1`, text: `新任务 ${task.id}：做 A\n细节`, result: 'sent',
    scheduledAt: 1000, sentAt: 1001, updatedAt: 1001, seq: 1,
  })
  h.appendWake({
    id: 'w2', target: 'bot-a', reason: 'task-assigned',
    dedupKey: `task-note:${task.id}:n-1`, text: '补充说明：别忘了限流', result: 'skipped',
    scheduledAt: 2000, updatedAt: 2000, seq: 2,
  })
  h.appendWake({
    id: 'w3', target: 'bot-b', reason: 'task-assigned',
    dedupKey: `task-assigned:${other.id}:1`, text: `新任务 ${other.id}：做 B`, result: 'sent',
    scheduledAt: 3000, sentAt: 3001, updatedAt: 3001, seq: 3,
  })

  const r = await h.req('GET', `/tasks/summary?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.stepConclusions.length, 2, '只应保留本任务的唤醒记录')
  assert.equal(r.json.stepConclusions[0].result, 'sent')
  assert.equal(r.json.stepConclusions[0].at, 1001)
  assert.equal(r.json.stepConclusions[0].excerpt, `新任务 ${task.id}：做 A`)
  assert.equal(r.json.stepConclusions[1].result, 'skipped')
  assert.equal(r.json.stepConclusions[1].excerpt, '补充说明：别忘了限流')
})

test('GET /tasks/summary：状态中文映射 + progressText', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '状态映射' })
  await h.claimTask(task, 'bot-a')

  const r = await h.req('GET', `/tasks/summary?id=${task.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.currentProgress.status, 'in_progress')
  assert.equal(r.json.currentProgress.progressText, '0% · 进行中')
})

test('GET /tasks/summary：excerpt 截 200 字', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '长唤醒' })
  const long = '长'.repeat(300)
  h.appendWake({
    id: 'w-long', target: 'bot-a', reason: 'task-assigned',
    dedupKey: `task-assigned:${task.id}:1`, text: `新任务 ${task.id}：${long}`, result: 'sent',
    scheduledAt: 1000, sentAt: 1001, updatedAt: 1001, seq: 1,
  })

  const r = await h.req('GET', `/tasks/summary?id=${task.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.stepConclusions[0].excerpt.length, 200)
})
