/**
 * 端到端：宿主 `llm/stream` 瀑布 → cs-bots 拦截器 → cs-myfree 旁路注册表，
 * 以及「任务板标注 → claim/wake 写 hint」的工具链。
 *
 * 为什么单独一个文件：前面两个文件测的是**单元**（纯函数 + handler 直调），
 * 这里测的是**装配后的真实链路** —— 用与 `test/tools.test.mjs` 同口径的宿主替身
 * 跑 `apply()`，再从 `ctx.on` 捕获的监听器里驱动一次请求。它能抓到「模块各自绿、
 * 装到一起却不通」这类问题（本仓库之前踩过同类坑）。
 *
 * 运行：`node --test test/routing-e2e.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { HINTS_SYMBOL, HINTS_VERSION } from '../src/routing/hints.js'

/** 装一个假的 cs-myfree 注册表（与真实现同形）。 */
function installRegistry(t) {
  const writes = []
  const api = {
    setRequestHint: (sessionId, hint) => writes.push({ sessionId, hint }),
    getRequestHint: (sessionId) => writes.filter((w) => w.sessionId === sessionId).at(-1)?.hint ?? null,
    clearRequestHint: () => {},
  }
  const previous = globalThis[HINTS_SYMBOL]
  globalThis[HINTS_SYMBOL] = { version: HINTS_VERSION, api }
  t?.after?.(() => {
    if (previous === undefined) delete globalThis[HINTS_SYMBOL]
    else globalThis[HINTS_SYMBOL] = previous
  })
  return { writes, api }
}

/**
 * 造带 tools 服务的宿主替身，跑真实 `apply()`，并保留 `on` 注册的监听器。
 */
function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-routing-e2e-'))
  const registered = []
  const listeners = {}
  const warnings = []
  /** sessionId → header 覆盖表（null = 宿主里查不到该会话）。 */
  const headers = {}
  const ctx = {
    logger: { info: () => {}, warn: (...a) => warnings.push(a.join(' ')) },
    get: (key) => {
      if (key === 'tools') {
        return {
          register: (def) => (registered.push(def), () => {}),
          guard: () => () => {},
          schemas: () => [],
        }
      }
      // sessions 替身：kernel.sessionMeta 读 header（谱系）。
      // 默认给「无谱系字段」的 header ⇒ 可确认是顶层会话（主对话）。
      // 用例可通过 headers 表覆盖某个 sessionId 的 header（模拟 spawn_teammate 子会话）。
      if (key === 'sessions') {
        return {
          get: (id) => {
            if (headers[id] === null) return undefined
            return { header: headers[id] ?? { version: 4, id, createdAt: 1_700_000_000_000 } }
          },
        }
      }
      // agents 替身：roster.create → kernel.createSession → agents.create（唯一依赖）
      if (key === 'agents') {
        return {
          async create(request) {
            return { id: request.sessionId, sessionId: request.sessionId }
          },
          get: () => undefined,
          list: () => [],
        }
      }
      return undefined
    },
    on: (name, fn) => { listeners[name] = fn },
    effect: () => {},
  }
  apply(ctx, { stateDir })
  return {
    ctx,
    stateDir,
    registered,
    listeners,
    warnings,
    services: getServices(ctx),
    headers,
    async call(name, args, agent = { id: 'probe-session' }) {
      const def = registered.find((d) => d.name === name)
      assert.ok(def, `工具 ${name} 应已注册`)
      return def.execute(args, { agent })
    },
    cleanup() {
      getServices(ctx).dispatcher?.dispose?.()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

/** 驱动一次 llm/stream 瀑布（等价宿主 `ctx.waterfall(..., () => adapterStream)`）。 */
function driveStream(handler, options) {
  const calls = { next: 0 }
  const result = handler(options, () => { calls.next += 1; return 'STREAM' })
  return { result, calls }
}

// ── 1. 装配链路 ──────────────────────────────────────────────────────────────

test('apply() 会注册 llm/stream 监听器（装配成功后 hooks 里能看到）', () => {
  const h = boot()
  try {
    assert.equal(typeof h.listeners['llm/stream'], 'function', 'apply 必须挂上 llm/stream 拦截')
    assert.equal(h.services.routing?.hooked, true)
  } finally {
    h.cleanup()
  }
})

test('★ 端到端：cs-myfree 请求 → 写 hint；deepseek 请求 → 一个字节都不写', (t) => {
  const { writes } = installRegistry(t)
  const h = boot()
  try {
    const handler = h.listeners['llm/stream']
    assert.equal(typeof handler, 'function')

    const myfree = driveStream(handler, {
      provider: 'cs-myfree',
      model: 'gpt-x',
      sessionId: 'sess-e2e-1',
      messages: [{ role: 'user', content: '整理一下这次重构的风险' }],
    })
    assert.equal(myfree.result, 'STREAM', '必须把 next() 的返回值原样交回宿主')
    assert.equal(myfree.calls.next, 1)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].sessionId, 'sess-e2e-1')
    assert.deepEqual(Object.keys(writes[0].hint).sort(), [
      'agent_role', 'at', 'billing_tier', 'complexity_tier', 'requires_paid', 'source',
    ])
    assert.equal(writes[0].hint.source, 'cs-bots/llm-stream')

    const official = driveStream(handler, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      sessionId: 'sess-e2e-2',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(official.result, 'STREAM')
    assert.equal(official.calls.next, 1)
    assert.equal(writes.length, 1, '官方渠道不得写入 hint')
  } finally {
    h.cleanup()
  }
})

test('端到端：没有 cs-myfree 注册表时 apply() 不报错，请求照样 next()', (t) => {
  const previous = globalThis[HINTS_SYMBOL]
  delete globalThis[HINTS_SYMBOL]
  t?.after?.(() => { if (previous !== undefined) globalThis[HINTS_SYMBOL] = previous })

  const h = boot()
  try {
    assert.equal(h.services.routing?.installed, false)
    assert.equal(h.services.routing?.reason, 'cs-myfree-registry-missing')
    const drive = driveStream(h.listeners['llm/stream'], {
      provider: 'cs-myfree',
      sessionId: 'sess-e2e-3',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(drive.calls.next, 1, '缺 cs-myfree 时对话请求不受影响')
    assert.equal(drive.result, 'STREAM')
  } finally {
    h.cleanup()
  }
})

// ── 2. 任务板标注 → claim/wake 写 hint ────────────────────────────────────────

test('★ 任务标注链路：create(requires_paid:true) → claim ⇒ owner 会话拿到 paid_allowed', async (t) => {
  const { writes } = installRegistry(t)
  const h = boot()
  try {
    const created = await h.call('bot_task_create', {
      subject: '架构级改造',
      expectedComplexity: 'T3',
      requiresPaid: true,
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(created.task.expectedComplexity, 'T3')
    assert.equal(created.task.requiresPaid, true)

    const claimed = await h.call(
      'bot_task_update',
      { id: created.task.id, expectedRev: 1, action: 'claim' },
      { id: 'sess-bot-owner' },
    )
    assert.equal(claimed.ok, true, JSON.stringify(claimed))
    assert.equal(claimed.hint?.ok, true, 'claim 时应用任务字段写 hint')
    assert.equal(claimed.hint.hint.billing_tier, 'paid_allowed')
    assert.equal(claimed.hint.hint.complexity_tier, 'T3')
    assert.equal(claimed.hint.hint.agent_role, 'subagent')
    assert.equal(writes.at(-1).sessionId, 'sess-bot-owner')
  } finally {
    h.cleanup()
  }
})

test('子智能体默认 free_only：不标 requiresPaid 的子任务 claim ⇒ hint 里 billing_tier=free_only', async (t) => {
  const { writes } = installRegistry(t)
  const h = boot()
  try {
    const created = await h.call('bot_task_create', {
      subject: '常规改动',
      expectedComplexity: 'T1',
    })
    const claimed = await h.call(
      'bot_task_update',
      { id: created.task.id, expectedRev: 1, action: 'claim' },
      { id: 'sess-sub' },
    )
    assert.equal(claimed.hint.hint.billing_tier, 'free_only')
    assert.equal(claimed.hint.hint.complexity_tier, 'T1')
    assert.equal(writes.at(-1).sessionId, 'sess-sub')
  } finally {
    h.cleanup()
  }
})

test('wake 链路：bot_wake 带 taskId ⇒ 用任务标注给目标会话写 hint；不带任务 ⇒ 不写', async (t) => {
  const { writes } = installRegistry(t)
  const h = boot()
  try {
    const created = await h.call('bot_task_create', {
      subject: '要付费的子任务',
      expectedComplexity: 'T2',
      requiresPaid: true,
    })

    const woken = await h.call('bot_wake', {
      target: 'sess-target',
      reason: 'task-assigned',
      dedupKey: `task-assigned:${created.task.id}`,
      taskId: created.task.id,
    })
    assert.ok(woken.result, '唤醒决策仍要返回（hint 只是附加信息）')
    assert.equal(woken.hint?.ok, true)
    assert.equal(woken.hint.hint.billing_tier, 'paid_allowed')
    assert.equal(writes.at(-1).sessionId, 'sess-target')

    const before = writes.length
    const plain = await h.call('bot_wake', {
      target: 'sess-target-2',
      reason: 'room-message',
      dedupKey: 'room-msg-1',
    })
    assert.ok(plain.result)
    assert.equal(plain.hint, undefined, '没有关联任务就不写 hint')
    assert.equal(writes.length, before)
  } finally {
    h.cleanup()
  }
})

test('wake 链路：dedupKey 形如 task-assigned:t-1 时能反推任务（平台内部正是这么编键）', async (t) => {
  const { writes } = installRegistry(t)
  const h = boot()
  try {
    const created = await h.call('bot_task_create', { subject: 'S', expectedComplexity: 'T0' })
    const woken = await h.call('bot_wake', {
      target: 'sess-dedup',
      reason: 'task-assigned',
      dedupKey: `task-assigned:${created.task.id}`,
    })
    assert.equal(woken.hint?.ok, true)
    assert.equal(woken.hint.hint.complexity_tier, 'T0')
    assert.equal(writes.at(-1).sessionId, 'sess-dedup')
  } finally {
    h.cleanup()
  }
})

test('工具面：非法 expectedComplexity 经工具层也返回可读失败（不是抛崩、不是静默接受）', async () => {
  const h = boot()
  try {
    const res = await h.call('bot_task_create', { subject: 'x', expectedComplexity: 'T9' })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'BOARD_BAD_COMPLEXITY')
    assert.ok(String(res.message).includes('T0'))
  } finally {
    h.cleanup()
  }
})


// ── 3. ★ P3-fix：按会话角色给授权（主对话 paid / 子智能体 free）─────────────────

test('★ 主对话（未登记在 roster）⇒ paid_allowed；roster 里的 Bot 会话 ⇒ free_only', async (t) => {
  const { api } = installRegistry(t)
  const h = boot()
  try {
    // 造一个**真实** roster Bot（host 替身返回的 sessionId = 请求的 id）
    const bot = await h.services.roster.create({
      name: 'sub-route',
      cwd: join(h.stateDir, 'ws-sub-route'),
      byId: 'lead',
    })
    assert.equal(typeof bot.sessionId, 'string')

    const handler = h.listeners['llm/stream']
    const official = driveStream(handler, {
      provider: 'cs-myfree',
      sessionId: 'sess-human-main', // 未登记 ⇒ 主对话
      messages: [{ role: 'user', content: '帮我把这件事拆成任务' }],
    })
    assert.equal(official.calls.next, 1)
    const mainHint = api.getRequestHint('sess-human-main')
    assert.equal(mainHint.billing_tier, 'paid_allowed', '主对话由平台层注入 paid_allowed')
    assert.equal(mainHint.agent_role, 'main')

    const sub = driveStream(handler, {
      provider: 'cs-myfree',
      sessionId: bot.sessionId, // roster 里的 Bot ⇒ 子智能体
      messages: [{ role: 'user', content: '实现这个子任务' }],
    })
    assert.equal(sub.calls.next, 1)
    const subHint = api.getRequestHint(bot.sessionId)
    assert.equal(subHint.billing_tier, 'free_only', '子智能体默认 free_only')
    assert.equal(subHint.agent_role, 'subagent')
  } finally {
    h.cleanup()
  }
})

test('★ 全链回归：子任务 claim(requiresPaid) 后连续 3 次真实请求，hint 始终 paid_allowed', async (t) => {
  const { api, writes } = installRegistry(t)
  const h = boot()
  try {
    const bot = await h.services.roster.create({
      name: 'sub-paid',
      cwd: join(h.stateDir, 'ws-sub-paid'),
      byId: 'lead',
    })

    const created = await h.call('bot_task_create', {
      subject: '需要付费的架构级子任务',
      expectedComplexity: 'T3',
      requiresPaid: true,
    })
    assert.equal(created.ok, true, JSON.stringify(created))

    const claimed = await h.call(
      'bot_task_update',
      { id: created.task.id, expectedRev: 1, action: 'claim' },
      { id: bot.sessionId },
    )
    assert.equal(claimed.ok, true, JSON.stringify(claimed))
    assert.equal(claimed.hint.hint.billing_tier, 'paid_allowed')
    assert.equal(api.getRequestHint(bot.sessionId).billing_tier, 'paid_allowed')

    const handler = h.listeners['llm/stream']
    for (let i = 1; i <= 3; i += 1) {
      // 每次请求前：hint 必须还是（claim 写的）paid_allowed
      assert.equal(
        api.getRequestHint(bot.sessionId).billing_tier,
        'paid_allowed',
        `第 ${i} 次请求前 hint 必须是 paid_allowed`,
      )
      const drive = driveStream(handler, {
        provider: 'cs-myfree',
        sessionId: bot.sessionId,
        messages: [{ role: 'user', content: `第 ${i} 步：继续实现` }],
      })
      assert.equal(drive.calls.next, 1)
      // 请求后：不得被子智能体的默认 free_only 覆盖
      const after = api.getRequestHint(bot.sessionId)
      assert.equal(after.billing_tier, 'paid_allowed', `第 ${i} 次请求后被覆盖成 ${after.billing_tier}`)
      assert.equal(after.requires_paid, true)
    }
    assert.equal(h.services.routing.stats.carriedTaskAuth, 3)
    assert.ok(writes.length >= 4, 'claim 1 次 + 3 次请求都要写入')
  } finally {
    h.cleanup()
  }
})


// ── 4. ★ P3-fix2：宿主谱系（堵住 spawn_teammate 子会话的付费泄漏）────────────────

test('★ 泄漏回归：非 roster、但宿主谱系是子代理 ⇒ free_only；顶层会话 ⇒ paid_allowed', async (t) => {
  const { api } = installRegistry(t)
  const h = boot()
  try {
    // 官方 spawn_teammate 的子会话：不在 cs-bots roster 里，但 header 带谱系
    h.headers['sess-teammate'] = {
      version: 4,
      id: 'sess-teammate',
      createdAt: 1_700_000_000_000,
      origin: 'subagent',
      parentSession: 'sess-main',
      delegationDepth: 1,
    }
    h.headers['sess-deep'] = { version: 4, id: 'sess-deep', createdAt: 1, delegationDepth: 2 }
    h.headers['sess-top'] = { version: 4, id: 'sess-top', createdAt: 1 } // 无谱系 ⇒ 顶层

    const handler = h.listeners['llm/stream']
    for (const sid of ['sess-teammate', 'sess-deep']) {
      const drive = driveStream(handler, {
        provider: 'cs-myfree',
        sessionId: sid,
        messages: [{ role: 'user', content: '执行子任务' }],
      })
      assert.equal(drive.calls.next, 1)
      const hint = api.getRequestHint(sid)
      assert.equal(hint.billing_tier, 'free_only', `${sid} 不得拿到 paid_allowed（授权泄漏）`)
      assert.equal(hint.agent_role, 'subagent')
    }

    const top = driveStream(handler, {
      provider: 'cs-myfree',
      sessionId: 'sess-top',
      messages: [{ role: 'user', content: '我是人类开的主对话' }],
    })
    assert.equal(top.calls.next, 1)
    assert.equal(api.getRequestHint('sess-top').billing_tier, 'paid_allowed')
    assert.equal(api.getRequestHint('sess-top').agent_role, 'main')
  } finally {
    h.cleanup()
  }
})

test('★ 宿主查不到会话（sessions.get 返回 undefined）⇒ unknown ⇒ free_only（fail-closed）', async (t) => {
  const { api } = installRegistry(t)
  const h = boot()
  try {
    h.headers['sess-ghost'] = null // 宿主里没有这个会话
    const handler = h.listeners['llm/stream']
    const drive = driveStream(handler, {
      provider: 'cs-myfree',
      sessionId: 'sess-ghost',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(drive.calls.next, 1)
    const hint = api.getRequestHint('sess-ghost')
    assert.equal(hint.billing_tier, 'free_only')
    assert.equal(hint.agent_role, 'unknown')
  } finally {
    h.cleanup()
  }
})
