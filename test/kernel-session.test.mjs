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

import { attachToWorkspace, createSession, resumeSession, buildMessage } from '../src/kernel.js'

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

test('K9 复活会话：存量会话没有模型选择时，带上默认模型（否则下次唤醒照样炸）', async () => {
  const calls = []
  const ctx = {
    reflect: {
      get: (key) => {
        if (key === 'agents') return { resume: async (o) => { calls.push(o); return { agent: { id: o.resumeSessionId } } } }
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'huoshan', model: 'm' }) }
        return undefined
      },
    },
  }
  await resumeSession(ctx, { resumeSessionId: 'bot-old' })
  assert.deepEqual(calls[0].agentOptions, { provider: 'huoshan', model: 'm' })
})

test('K10 复活会话：调用方显式给模型时优先', async () => {
  const calls = []
  const ctx = {
    reflect: {
      get: (key) => {
        if (key === 'agents') return { resume: async (o) => { calls.push(o); return { agent: { id: 'x' } } } }
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p2', model: 'm2' }) }
        return undefined
      },
    },
  }
  await resumeSession(ctx, { resumeSessionId: 'bot-x', agentOptions: { provider: 'p1', model: 'm1' } })
  assert.deepEqual(calls[0].agentOptions, { provider: 'p1', model: 'm1' })
})

// ── 2026-11-09 现场：`format v4 message requires a producer-owned source kind` ──
// 我们把 UserMessage.source 写成 { kind:'plugin', name:'cs-bots' }。
// 'plugin' 是 v3 的「包装写法」，v4 新消息**明确拒收**（迁移层只允许在回放时改写）。
// 后果：每次唤醒投递都被宿主在准入处拒收，而 followup() 已返回 ok ⇒ 任务静默卡住。

test('M1 投递消息的 source.kind 不得是废弃的 plugin 包装', async () => {
  const msg = buildMessage('唤醒文案')
  assert.ok(msg.source, '必须带 source（否则会话日志无法追溯来源）')
  assert.notEqual(msg.source.kind, 'plugin', 'v4 拒收 kind:plugin —— 这正是现场报错的直接原因')
  assert.equal(typeof msg.source.kind, 'string')
  assert.ok(msg.source.kind.length > 0)
})

test('M2 source.kind 与 v3→v4 迁移层的映射逐字对齐（plugin:<name>）', async () => {
  const msg = buildMessage('x')
  // 迁移层 producerKind()：非已发布同名生产者 → `plugin:${plugin}`
  assert.equal(msg.source.kind, 'plugin:cs-bots', '新建消息形状要与历史回放后的形状一致')
})

// ── 2026-11-09 现场（最高优先级）：Bot 没有任何工具 ────────────────────────────
// 用户的 Bot 自述「本会话只挂了 cs-bots 管理工具，没有文件读写/命令执行能力」，
// 用户强调「无法调用工具会失去很多功能」，要求**认真复核**。
//
// 根因（源码级证据链）：
//   1. `AgentOptions`（dsh-agent/lib/types/runtime-types.d.ts:27-36）无 tools/preset 字段
//   2. preset 挂载只发生在 `setup` 回调里 —— 官方唯一装配入口是
//      `dsh-api-session-controller/lib/index.js:264-278` 的 `composeAgent()`：
//      `{ setup: async (agentCtx) => { installModelSelection(agentCtx); await presets.mount(agentCtx, resolvedId) } }`
//   3. `dsh-agent-loop/lib/index.js:1574-1576` 在 initializeAgent 里真正调用 setup
//   4. `dsh-agent-preset-registry/lib/index.js:702-711` 的 mount() 才挂工具面
//   5. cs-bots 的 `agents.create({...})` **从不传 setup** ⇒ preset 从未挂载
//      ⇒ Bot 只有 cs-bots 自己注册的 `bot_*` 工具
//
// 这组用例钉住「setup 必须在，且必须真的调用 presets.mount」。

/** 假 preset registry：记录 resolve/mount 调用，可注入失败。 */
function fakePresets({ defaultId = 'standard', known = ['standard', 'dev-steward'], broken = [], mountThrows } = {}) {
  const mounts = []
  const resolves = []
  return {
    ...(defaultId === undefined ? {} : { defaultId }),
    mounts,
    resolves,
    async list() { return known.map((id) => ({ id })) },
    async resolve(id) {
      resolves.push(id)
      const wanted = id ?? defaultId
      if (!known.includes(wanted)) {
        const err = new Error(`Unknown agent preset: ${wanted}`)
        err.code = 'agent-preset/not-found'
        throw err
      }
      if (broken.includes(wanted)) return { id: wanted, broken: 'load failed' }
      return { id: wanted }
    },
    async mount(agentCtx, id) {
      mounts.push(id)
      if (mountThrows) throw mountThrows
      return { id }
    },
  }
}

/** 带 agentPresets 服务的假 ctx（agents.create 记录 options，便于断言 setup）。 */
function ctxWithPresets(presets) {
  const calls = []
  const ctx = {
    reflect: {
      get: (key) => {
        if (key === 'agents') return { create: async (o) => { calls.push(o); return { agent: { id: o.sessionId } } } }
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (key === 'agentPresets') return presets
        return undefined
      },
    },
  }
  return { ctx, calls }
}


/** 假 AgentCtx：宿主 installModelSelection 要求 `agentCtx.on('agent/pre-step', ...)`。 */
function fakeAgentCtx() {
  const listeners = []
  return {
    on: (evt, fn) => { listeners.push([evt, fn]); return () => {} },
    off: () => {},
    listeners,
  }
}

test('P1 创建会话：必须传 setup（缺它就是「Bot 没有任何工具」的根因）', async () => {
  const presets = fakePresets()
  const { ctx, calls } = ctxWithPresets(presets)
  await createSession(ctx, { sessionId: 'bot-p1', cwd: '/tmp/p1', agentPreset: 'dev-steward' })
  assert.equal(typeof calls[0].setup, 'function', 'setup 缺失 ⇒ preset 永远不会挂载 ⇒ Bot 没有 read/exec')
})

test('P2 调用 setup 后，presets.mount 被调用且用的是 resolve 后的 id', async () => {
  const presets = fakePresets()
  const { ctx, calls } = ctxWithPresets(presets)
  await createSession(ctx, { sessionId: 'bot-p2', cwd: '/tmp/p2', agentPreset: 'dev-steward' })
  await calls[0].setup(fakeAgentCtx())
  assert.deepEqual(presets.mounts, ['dev-steward'], 'mount 必须被调用，否则工具面挂不上')
})

test('P3 未显式给 preset 时，用宿主默认 preset 并回填 meta.agentPreset（与挂载的同一个）', async () => {
  const presets = fakePresets({ defaultId: 'standard' })
  const { ctx, calls } = ctxWithPresets(presets)
  await createSession(ctx, { sessionId: 'bot-p3', cwd: '/tmp/p3' })
  assert.equal(calls[0].meta.agentPreset, 'standard', '落盘的 preset 必须与会话真正挂载的 preset 一致')
  await calls[0].setup(fakeAgentCtx())
  assert.deepEqual(presets.mounts, ['standard'])
})

test('P4 未知 preset：降级到默认，不阻断建会话，且 warn 出声', async () => {
  const presets = fakePresets({ defaultId: 'standard', known: ['standard'] })
  const { ctx, calls } = ctxWithPresets(presets)
  const warns = []
  await createSession(ctx, { sessionId: 'bot-p4', cwd: '/tmp/p4', agentPreset: 'no-such-preset', warn: (m) => warns.push(m) })
  assert.equal(calls.length, 1, 'preset 未知不得阻断建会话')
  assert.equal(calls[0].meta.agentPreset, 'standard', '应回落到默认 preset')
  assert.ok(warns.some((w) => w.includes('no-such-preset')), `必须告警：${JSON.stringify(warns)}`)
})

test('P5 mount 抛错：会话仍然建起来（绝不阻塞启动），但 fail 要 warn 出来', async () => {
  const presets = fakePresets({ mountThrows: new Error('bind failed: requires a scope') })
  const { ctx, calls } = ctxWithPresets(presets)
  const warns = []
  await createSession(ctx, { sessionId: 'bot-p5', cwd: '/tmp/p5', warn: (m) => warns.push(m) })
  await assert.doesNotReject(() => calls[0].setup({ get: () => undefined }))
  assert.ok(warns.some((w) => w.includes('mount')), `mount 失败必须告警：${JSON.stringify(warns)}`)
})

test('P6 宿主没有 agentPresets 服务：会话照常创建，不抛、warn 说明工具面缺失', async () => {
  const { ctx, calls } = fakeCtx({ defaultSelection: { provider: 'p', model: 'm' } })
  const warns = []
  await createSession(ctx, { sessionId: 'bot-p6', cwd: '/tmp/p6', warn: (m) => warns.push(m) })
  assert.equal(calls.length, 1, '缺 agentPresets 不得阻断建会话')
  assert.ok(warns.some((w) => w.includes('agentPresets')), `必须告警：${JSON.stringify(warns)}`)
})

test('P7 复活会话：同样必须传 setup（官方 resume 也传 reuseSetup(composition)）', async () => {
  const mounts = []
  const calls = []
  const ctx = {
    reflect: {
      get: (key) => {
        if (key === 'agents') return { resume: async (o) => { calls.push(o); return { agent: { id: o.resumeSessionId } } } }
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (key === 'agentPresets') {
          return {
            defaultId: 'standard',
            async resolve(id) { return { id: id ?? 'standard' } },
            async mount(_ctx, id) { mounts.push(id); return { id } },
          }
        }
        return undefined
      },
    },
  }
  await resumeSession(ctx, { resumeSessionId: 'bot-p7' })
  assert.equal(typeof calls[0].setup, 'function', 'resume 不传 setup ⇒ 复活出来的 Bot 照样没有工具')
  await calls[0].setup(fakeAgentCtx())
  assert.deepEqual(mounts, ['standard'])
})

test('P8 存量会话（无 preset 记录）经 resume 复活：仍按默认 preset 挂上工具面', async () => {
  const mounts = []
  let seen
  const ctx = {
    reflect: {
      get: (key) => {
        if (key === 'agents') return { resume: async (o) => { seen = o; return { agent: { id: o.resumeSessionId } } } }
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (key === 'agentPresets') {
          return {
            defaultId: 'standard',
            async resolve(id) { return { id: id ?? 'standard' } },
            async mount(_c, id) { mounts.push(id); return { id } },
          }
        }
        return undefined
      },
    },
  }
  await resumeSession(ctx, { resumeSessionId: 'bot-6b654c19-stock' })
  await seen.setup(fakeAgentCtx())
  assert.deepEqual(mounts, ['standard'], '存量 Bot 一复活就该长出工具面，不该再「只有 bot_* 工具」')
})
