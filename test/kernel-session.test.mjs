/**
 * 会话创建的两个根因回归（2026-11-09 现场）。
 *
 * ## 现场 1｜「agent has no provider/model」
 *   用户在页面建任务并指派给 `bot-6b654c19…`，那一轮立刻失败：
 *     agent "bot-…" has no provider/model: set AgentOptions.provider and
 *     AgentOptions.model or record a model selection
 *   根因：`kernel.createSession` 走 `agents.create` 窄接口，而**记录模型选择
 *   是官方 web side（session-controller）的动作**；我们绕开它就没人记录 ⇒
 *   agent-loop 每步 `model.current()` 都是 undefined。
 *   修法：创建时带上 `agentOptions`，取值优先调用方，其次宿主全局默认。
 *
 * ## 现场 2｜「左侧栏未分组」
 *   官方把会话归组进 Workspace；`attachSession` 要求会话 cwd === workspace.path。
 *   我们建会话时正好有 cwd，却没建/挂 workspace ⇒ 会话永远落在「未分组」。
 *
 * 这两条都是**默认值缺失**类缺陷：功能没坏，是没人给它接线。
 * 用测试钉住「接线必须在」，否则下一次重构又会悄悄退回去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { attachToWorkspace, createSession } from '../src/kernel.js'

/** 假 ctx：只提供本测试需要的两个服务，其余缺失（验证降级路径）。 */
function fakeCtx({ defaultSelection, registry } = {}) {
  const calls = []
  const ctx = {
    reflect: { get: (key) => (key === 'agents' ? agents : key === 'agentDefaultModel' ? defaultModel : key === 'workspaceRegistry' ? registry : undefined) },
  }
  const agents = {
    calls,
    async create(options) { calls.push(options); return { agent: { id: options.sessionId } } },
  }
  const defaultModel = defaultSelection === undefined
    ? undefined
    : { currentSelection: () => defaultSelection }
  return { ctx, calls }
}

test('K1 创建会话：未显式给模型时，带上宿主默认模型（修 no provider/model）', async () => {
  const { ctx, calls } = fakeCtx({ defaultSelection: { provider: 'huoshan', model: 'deepseek-v4.1-flash' } })
  await createSession(ctx, { sessionId: 'bot-x', cwd: '/tmp/x' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].agentOptions, { provider: 'huoshan', model: 'deepseek-v4.1-flash' })
  assert.equal(calls[0].meta.cwd, '/tmp/x')
})

test('K2 创建会话：调用方显式给模型时优先（不被默认覆盖）', async () => {
  const { ctx, calls } = fakeCtx({ defaultSelection: { provider: 'p2', model: 'm2' } })
  await createSession(ctx, { sessionId: 'bot-y', cwd: '/tmp/y', agentOptions: { provider: 'p1', model: 'm1' } })
  assert.deepEqual(calls[0].agentOptions, { provider: 'p1', model: 'm1' })
})

test('K3 创建会话：没有任何默认模型时不传 agentOptions（不传错东西，交由调用方报错）', async () => {
  const { ctx, calls } = fakeCtx({})
  await createSession(ctx, { sessionId: 'bot-z', cwd: '/tmp/z' })
  assert.equal(calls[0].agentOptions, undefined)
})

test('K4 创建会话：有 cwd 时自动建/挂工作区（修左侧栏未分组）', async () => {
  const attached = []
  const registry = {
    async resolveByPath() { return undefined },
    async create(path) { return { workspace: { path, attachSession: async (id) => { attached.push([path, id]) } } } },
  }
  const { ctx } = fakeCtx({ defaultSelection: { provider: 'p', model: 'm' }, registry })
  await createSession(ctx, { sessionId: 'bot-w', cwd: '/tmp/w' })
  assert.deepEqual(attached, [['/tmp/w', 'bot-w']])
})

test('K5 工作区已存在时直接复用，不重复建', async () => {
  const created = []
  const attached = []
  const registry = {
    async resolveByPath(path) { return { path, attachSession: async (id) => { attached.push([path, id]) } } },
    async create(path) { created.push(path); return undefined },
  }
  const { ctx } = fakeCtx({ defaultSelection: { provider: 'p', model: 'm' }, registry })
  await createSession(ctx, { sessionId: 'bot-r', cwd: '/tmp/r' })
  assert.deepEqual(created, [], '已存在就不该再建')
  assert.deepEqual(attached, [['/tmp/r', 'bot-r']])
})

test('K6 宿主没有 workspaceRegistry（老版本）时：会话照常创建，静默降级', async () => {
  const { ctx, calls } = fakeCtx({ defaultSelection: { provider: 'p', model: 'm' } })
  const handle = await createSession(ctx, { sessionId: 'bot-old', cwd: '/tmp/old' })
  assert.equal(calls.length, 1, '缺 workspace 能力不得阻断建会话')
  assert.equal(handle.agent.id, 'bot-old')
})

test('K7 attachToWorkspace：registry 缺失直接返回 false，不抛错', async () => {
  const { ctx } = fakeCtx({})
  assert.equal(await attachToWorkspace(ctx, '/tmp/none', 'bot-n'), false)
})

test('K8 attachToWorkspace：attach 抛错由调用方吞掉（工作区只是锦上添花）', async () => {
  const registry = {
    async resolveByPath() { return undefined },
    async create(path) {
      return { workspace: { path, attachSession: async () => { throw new Error('cwd 不匹配') } } }
    },
  }
  const { ctx } = fakeCtx({ defaultSelection: { provider: 'p', model: 'm' }, registry })
  // createSession 内部 try/catch ⇒ 仍然 resolve
  const handle = await createSession(ctx, { sessionId: 'bot-e', cwd: '/tmp/e' })
  assert.equal(handle.agent.id, 'bot-e')
  // 直接调则如实抛（调用方自己决定要不要吞）
  await assert.rejects(() => attachToWorkspace(ctx, '/tmp/e', 'bot-e2'), /cwd 不匹配/)
})
