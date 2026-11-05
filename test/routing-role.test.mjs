/**
 * 路由角色解析测试（P3-fix）：`roleOfSession`（平台层判主对话 / 子智能体）
 * + `roster.hasSession`（按会话 id 查注册表）。
 *
 * 这条链决定「谁拿到付费授权」，所以每条断言都盯**授权方向**：
 *   - 主对话 ⇒ `main` ⇒ paid_allowed；
 *   - roster 里的 Bot（含退役）⇒ `subagent` ⇒ free_only；
 *   - roster 不可用 / 查询抛错 ⇒ `unknown` ⇒ free_only（**fail-closed，绝不默认付费**）。
 *
 * 运行：`node --test test/routing-role.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { roleOfSession } from '../src/index.js'
import { sessionMeta } from '../src/kernel.js'
import { createRoster } from '../src/roster.js'
import {
  HINTS_SYMBOL,
  HINTS_VERSION,
  installLlmStreamHint,
} from '../src/routing/hints.js'

// ── 1. roleOfSession：替身 roster 的判定口径 ─────────────────────────────────

test('roleOfSession：roster.hasSession 命中 ⇒ subagent（无需谱系）；未命中且顶层 ⇒ main', () => {
  const roster = { hasSession: (sid) => sid === 'bot-sess-1' }
  assert.equal(roleOfSession(roster, 'bot-sess-1'), 'subagent')
  assert.equal(roleOfSession(roster, 'bot-sess-1', null), 'subagent', 'roster 命中优先，不看谱系')
  assert.equal(roleOfSession(roster, 'human-sess', {}), 'main', '能确认是顶层会话 ⇒ main')
})

test('roleOfSession：roster 缺失 / 无能力 ⇒ unknown（fail-closed，绝不默认 main）', () => {
  for (const roster of [undefined, null, {}, 'garbage', 42]) {
    assert.equal(roleOfSession(roster, 'sess-x'), 'unknown', `roster=${JSON.stringify(roster)}`)
  }
})

test('roleOfSession：查询抛错 ⇒ unknown（不把异常抛给请求链路）', () => {
  assert.equal(roleOfSession({ hasSession: () => { throw new Error('boom') } }, 's1'), 'unknown')
  assert.equal(
    roleOfSession({ list: () => { throw new Error('boom') } }, 's1'),
    'unknown',
    '退化路径（无 hasSession 时扫名录）抛错同样 unknown',
  )
})

test('roleOfSession：无 sessionId / 非法 sessionId ⇒ unknown', () => {
  const roster = { hasSession: () => true }
  for (const sid of ['', undefined, null, 42, {}]) {
    assert.equal(roleOfSession(roster, sid), 'unknown', `sessionId=${JSON.stringify(sid)}`)
  }
})

test('roleOfSession：老版本 roster（无 hasSession）退化为扫 list + listRetired', () => {
  const roster = {
    list: () => [{ sessionId: 'live-1' }, { sessionId: 'live-2' }],
    listRetired: () => [{ sessionId: 'retired-1' }],
  }
  assert.equal(roleOfSession(roster, 'live-2'), 'subagent')
  assert.equal(roleOfSession(roster, 'retired-1'), 'subagent', '退役 Bot 的会话仍算子智能体')
  assert.equal(roleOfSession(roster, 'human', {}), 'main')
  // list 不存在 / 非数组 ⇒ unknown
  assert.equal(roleOfSession({ listRetired: () => [] }, 'x'), 'unknown')
  assert.equal(roleOfSession({ list: () => 'nope' }, 'x'), 'unknown')
})

// ── 2. roster.hasSession：真实注册表 ────────────────────────────────────────

let counter = 0

/** 造真实 roster：假 `agents.create` 即可（kernel.createSession 的唯一依赖）。 */
function setupRoster(t, overrides = {}) {
  const base = process.env.ROSTER_TEST_TMPDIR || tmpdir()
  const root = mkdtempSync(join(base, `cs-bots-role-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const ctx = {
    logger: { info() {}, warn() {} },
    get(key) {
      if (key !== 'agents') return undefined
      return {
        async create(request) {
          const sessionId = overrides.renameSession === true
            ? `host-rewritten-${request.sessionId}`
            : request.sessionId
          return { id: sessionId, sessionId }
        },
        get: () => undefined,
      }
    },
  }
  const roster = createRoster(ctx, { stateDir: join(root, 'state') })
  const ws = join(root, 'ws')
  return { roster, ws, root }
}

test('roster.hasSession：建 Bot 后按会话 id 命中；未登记会话为 false；非法入参不抛', async (t) => {
  const { roster, ws } = setupRoster(t)
  assert.equal(typeof roster.hasSession, 'function', 'roster 必须导出 hasSession（路由依赖它）')

  const bot = await roster.create({ name: 'w1', cwd: join(ws, 'w1'), byId: 'lead' })
  assert.equal(roster.hasSession(bot.sessionId), true)
  assert.equal(roster.hasSession(bot.id), true, '默认情况下 botId === sessionId')
  assert.equal(roster.hasSession('human-session'), false)

  for (const bad of ['', undefined, null, 42, {}, []]) {
    assert.equal(roster.hasSession(bad), false, `非法入参 ${JSON.stringify(bad)} 应为 false（不抛）`)
  }
})

test('roster.hasSession：宿主改写 sessionId 时按**字段**匹配（不拿 botId 当键）', async (t) => {
  const { roster, ws } = setupRoster(t, { renameSession: true })
  const bot = await roster.create({ name: 'w2', cwd: join(ws, 'w2'), byId: 'lead' })
  assert.notEqual(bot.sessionId, bot.id, '前提：宿主返回了不同的 sessionId')
  assert.equal(roster.hasSession(bot.sessionId), true, '必须命中宿主实际使用的会话 id')
  assert.equal(roster.hasSession(bot.id), false, '拿 botId 去查会话不该命中')
})

test('roster.hasSession：退役 Bot 的会话仍算本平台会话（会话还在跑手上的活）', async (t) => {
  const { roster, ws } = setupRoster(t)
  const bot = await roster.create({ name: 'w3', cwd: join(ws, 'w3'), byId: 'lead' })
  const retired = roster.retire({ id: bot.id, byId: 'lead', reason: '本轮结束' })
  assert.equal(retired.state, 'retired')
  assert.equal(roster.hasSession(bot.sessionId), true, '退役只释放名字/槽位，不改变会话归属')
  // 默认 list() 不含退役，但 hasSession 必须仍能查到（否则退役会话会被判成主对话 → 越权付费）
  assert.equal(roster.list().some((b) => b.sessionId === bot.sessionId), false)
})

test('端到端方向校验：真实 roster 下 roleOfSession 给出正确的授权方向', async (t) => {
  const { roster, ws } = setupRoster(t)
  const bot = await roster.create({ name: 'w4', cwd: join(ws, 'w4'), byId: 'lead' })
  assert.equal(roleOfSession(roster, bot.sessionId), 'subagent')
  assert.equal(roleOfSession(roster, 'sess-human', {}), 'main')
  assert.equal(roleOfSession(undefined, bot.sessionId), 'unknown', 'roster 不可用 ⇒ 不猜 main')
})


// ── 3. 宿主谱系（P3-fix2）：堵住 spawn_teammate 子会话的付费泄漏 ────────────────

/** 造一个只提供 sessions 服务的假宿主 ctx（覆盖 header 表）。 */
function fakeSessionsCtx(headers, { throwOnGet = false } = {}) {
  return {
    get(key) {
      if (key !== 'sessions') return undefined
      return {
        get(id) {
          if (throwOnGet) throw new Error('session store exploded')
          if (!(id in headers)) return undefined
          return headers[id] === null ? undefined : { header: headers[id] }
        },
      }
    },
  }
}

const rosterOf = (sessions) => ({ hasSession: (sid) => sessions.includes(sid) })

test('kernel.sessionMeta：只取白名单四字段并转纯数据，绝不泄漏宿主 header 对象', () => {
  const ctx = fakeSessionsCtx({
    's-1': {
      version: 4,
      id: 's-1',
      createdAt: 1,
      cwd: '/x',
      origin: 'subagent',
      parentSession: 'sess-main',
      delegationDepth: 2,
      agentPreset: 'dev-steward',
      isSeeded: true,
      secret: 'should-not-leak',
    },
  })
  const meta = sessionMeta(ctx, 's-1')
  assert.deepEqual(meta, {
    origin: 'subagent',
    parentSession: 'sess-main',
    delegationDepth: 2,
    agentPreset: 'dev-steward',
  })
  assert.deepEqual(Object.keys(meta).sort(), ['agentPreset', 'delegationDepth', 'origin', 'parentSession'])
  assert.equal(JSON.parse(JSON.stringify(meta)).secret, undefined, '白名单之外的字段一律不出现')
})

test('kernel.sessionMeta：服务缺失 / 无此会话 / get 抛错 / 非法 sessionId ⇒ null（绝不抛）', () => {
  assert.equal(sessionMeta({ get: () => undefined }, 's-1'), null, '无 sessions 服务')
  assert.equal(sessionMeta(undefined, 's-1'), null, 'ctx 缺失')
  assert.equal(sessionMeta(fakeSessionsCtx({}), 'no-such'), null, '无此会话')
  assert.equal(sessionMeta(fakeSessionsCtx({ 's-1': {} }, { throwOnGet: true }), 's-1'), null, 'get 抛错')
  assert.equal(sessionMeta(fakeSessionsCtx({ 's-1': null }), 's-1'), null, 'get 返回 undefined')
  for (const bad of ['', undefined, null, 42, {}]) {
    assert.equal(sessionMeta(fakeSessionsCtx({}), bad), null, `非法 sessionId ${JSON.stringify(bad)}`)
  }
})

test('★ roleOfSession：header 带 origin=subagent + parentSession ⇒ subagent（不因不在 roster 而给 main）', () => {
  const ctx = fakeSessionsCtx({ 'sess-sub': { version: 4, origin: 'subagent', parentSession: 'sess-main' } })
  const meta = sessionMeta(ctx, 'sess-sub')
  assert.equal(roleOfSession(rosterOf([]), 'sess-sub', meta), 'subagent')
})

test('★ roleOfSession：header 只有 delegationDepth=2 ⇒ subagent', () => {
  const ctx = fakeSessionsCtx({ 'sess-deep': { version: 4, delegationDepth: 2 } })
  assert.equal(roleOfSession(rosterOf([]), 'sess-deep', sessionMeta(ctx, 'sess-deep')), 'subagent')
})

test('★ roleOfSession：header 无谱系字段（顶层会话）⇒ main；有 parentSession 但不在 roster ⇒ subagent', () => {
  const ctx = fakeSessionsCtx({
    'sess-top': { version: 4, id: 'sess-top', createdAt: 1 },
    'sess-child': { version: 4, parentSession: 'sess-top' },
  })
  assert.equal(roleOfSession(rosterOf([]), 'sess-top', sessionMeta(ctx, 'sess-top')), 'main')
  assert.equal(roleOfSession(rosterOf([]), 'sess-child', sessionMeta(ctx, 'sess-child')), 'subagent')
})

test('★ roleOfSession：sessions 服务缺失 + 非 roster ⇒ unknown（fail-closed，绝不当主对话）', () => {
  const meta = sessionMeta({ get: () => undefined }, 'sess-x') // 无 sessions 服务 ⇒ null
  assert.equal(meta, null)
  assert.equal(roleOfSession(rosterOf([]), 'sess-x', meta), 'unknown')
  assert.equal(roleOfSession(rosterOf([]), 'sess-x', undefined), 'unknown', 'meta 未传同样 unknown')
  assert.equal(roleOfSession(rosterOf([]), 'sess-x', 'garbage'), 'unknown', 'meta 怪值 ⇒ unknown')
})

test('★ sessionMeta 抛错：hint 链路不受影响（仍 next()，且 billing 保持 free_only）', (t) => {
  const { writes } = installFakeRegistry(t)
  const { kernel, captured } = fakeKernel()
  const throwingCtx = fakeSessionsCtx({ 'sess-boom': { version: 4 } }, { throwOnGet: true })
  const roster = rosterOf(['sess-bot'])
  const result = installLlmStreamHint({}, kernel, {
    roleOf: (sessionId) => roleOfSession(roster, sessionId, sessionMeta(throwingCtx, sessionId)),
  })
  assert.equal(typeof captured.handler, 'function')

  for (const sid of ['sess-boom', 'sess-unknown']) {
    const { request, next, calls } = makeRequest({ sessionId: sid })
    assert.equal(result.handler(request, next), 'STREAM', '元数据抛错绝不能让请求失败')
    assert.equal(calls.next, 1)
    assert.equal(writes.at(-1).hint.billing_tier, 'free_only', `${sid} 应为 free_only`)
  }
})


// ── 4. hint 链路的本地夹具（只本文件用；与 routing-hints.test.mjs 口径一致）────────

function installFakeRegistry(t) {
  const writes = []
  const previous = globalThis[HINTS_SYMBOL]
  globalThis[HINTS_SYMBOL] = {
    version: HINTS_VERSION,
    api: {
      setRequestHint: (sessionId, hint) => writes.push({ sessionId, hint }),
      getRequestHint: (sessionId) => writes.filter((w) => w.sessionId === sessionId).at(-1)?.hint ?? null,
      clearRequestHint: () => {},
    },
  }
  t?.after?.(() => {
    if (previous === undefined) delete globalThis[HINTS_SYMBOL]
    else globalThis[HINTS_SYMBOL] = previous
  })
  return { writes }
}

function fakeKernel() {
  const captured = {}
  return {
    captured,
    kernel: {
      onLlmStream(ctx, handler) {
        captured.handler = handler
        return true
      },
    },
  }
}

function makeRequest(over = {}) {
  const calls = { next: 0 }
  return {
    request: {
      provider: 'cs-myfree',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hi' }],
      ...over,
    },
    calls,
    next: () => { calls.next += 1; return 'STREAM' },
  }
}
