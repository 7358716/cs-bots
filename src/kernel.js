/**
 * cs-bots kernel —— **全项目唯一允许 import `@deepseek-ai/*` 的文件**。
 *
 * 由 `test/ci-zero-dep.sh` 检查 1 机械强制：其余任何 `.js` 出现真实
 * `@deepseek-ai/` 的 import/require 即判失败。
 *
 * 为什么单点隔离：DSH 与官方插件包**同版本号发布**（本机 `0.2.1-rc.2`），
 * 宿主改版时只需改本文件；且「零依赖」这条纪律可被 CI 检验，而不是靠自觉。
 *
 * 本文件只暴露**窄接口**，不泄漏宿主类型；每个函数都对缺失服务降级：
 * 缺服务 → 返回降级值（`undefined` / `false`）或抛结构化错误，**绝不阻塞插件装配**。
 *
 * 接口版本：v1（2026-11-01 冻结）。改动本文件即为一次接口变更，需同步更新
 * `docs/kernel-interface.md` 与调用方。
 */

// ── 唯一的宿主 import 面 ────────────────────────────────────────────────────
//
// ⚠️ 刻意**不用静态 import**，改惰性 + 多锚点解析。原因（2026-11-01 实测踩到）：
//   官方包只存在于 **dsh 安装目录**（本机 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/`），
//   而它的**兄弟包**（本插件在 profile 的 `node_modules` 里）**解析不到** `@deepseek-ai/dsh-llm`
//   —— profile 的 `node_modules/@deepseek-ai/` 只有 `cosmokit` 与 `schemastery`。
//   静态 import 会让「宿主包位置一变，插件直接加载失败」，与「绝不阻塞启动」纪律冲突。
//
// 惰性的另一收益：**不构造消息的调用路径完全不依赖宿主包** —— 单元测试因此可离线跑。
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const HOST_LLM = '@deepseek-ai/dsh-llm'

/** @type {Function | null} */
let _createUserMessage = null
/** @type {Error | null} */
let _loadError = null

/**
 * 探测 dsh 安装锚点（按可靠性排序）。
 * 环境变量 `CS_BOTS_DSH_ROOT` 可显式指定（测试与非常规安装用）。
 * @returns {string[]}
 */
function dshAnchors() {
  const anchors = []
  if (process.env.CS_BOTS_DSH_ROOT) anchors.push(process.env.CS_BOTS_DSH_ROOT)
  // 1) 本文件自身位置：装进 dsh 内时通常已经可解析
  anchors.push(import.meta.url)
  // 2) 常见全局安装布局（本机实测命中第 3 条）
  anchors.push('/usr/lib/node_modules/@deepseek-ai/dsh/package.json')
  anchors.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')
  // 3) 从 dsh 可执行文件反推（PATH 上的 dsh 多半在 <root>/bin/ 或 <root>/resources/...）
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    anchors.push(`${dir}/../package.json`)
    anchors.push(`${dir}/../node_modules/@deepseek-ai/dsh/package.json`)
    anchors.push(`${dir}/../lib/node_modules/@deepseek-ai/dsh/package.json`)
  }
  // 4) 本机 dsh 默认 home 的邻居（供容器/云机兜底）
  const home = process.env.HOME
  if (home) anchors.push(`${home}/.dsh/../node_modules/@deepseek-ai/dsh/package.json`)
  return anchors.filter((a) => typeof a === 'string' && a.length > 0)
}

/**
 * 惰性加载宿主的 `createUserMessage`。
 * @returns {Function}
 * @throws {Error} 所有锚点都失败时（**带排查提示**，不静默）
 */
function loadCreateUserMessage() {
  if (_createUserMessage) return _createUserMessage
  if (_loadError) throw _loadError

  const tried = []
  for (const anchor of dshAnchors()) {
    try {
      // 文件锚点需先存在，createRequire 才不会因怪路径抛错
      if (anchor.startsWith('/') && !existsSync(anchor)) continue
      const req = createRequire(anchor)
      const mod = req(HOST_LLM)
      const fn = mod?.createUserMessage
      if (typeof fn === 'function') {
        _createUserMessage = fn
        return fn
      }
      tried.push(`${anchor}: 已解析但无 createUserMessage 导出`)
    } catch (error) {
      tried.push(`${anchor}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  _loadError = new Error(
    `cs-bots kernel: 无法解析宿主包 ${HOST_LLM}。\n` +
      `  已知锚点尝试：\n    ${tried.join('\n    ')}\n` +
      `  对策：设 CS_BOTS_DSH_ROOT=<dsh 安装目录>，或用 \`dsh --profile <p>\` 启动（宿主会暴露解析锚）。`,
  )
  throw _loadError
}

/**
 * 惰性取服务 —— **可选依赖**的正确姿势。
 *
 * 三条通路按优先级尝试（2026-11-02 实测，这是**真 bug 的修复**）：
 *   ① `ctx.reflect.get(key, false)` —— 官方注释原文：
 *      "Read a service from the store **without the inject requirement**."
 *      ⇒ 这是唯一**不声明 inject 也能读**的服务通道，正是「缺服务就降级」所需。
 *   ② `ctx.get(key)` —— 老/测试上下文形态；在真实 Cordis ctx 上会抛
 *      `cannot get property "X" without inject`（实测），故必须 try/catch。
 *   ③ `key in ctx` 探路 —— 更老宿主可能没有 ctx.reflect，靠 `in` 判存在再取。
 *   ④ `ctx[key]` —— 直接挂属性的测试替身；同样会抛，故 try/catch。
 *
 * ⚠️ 教训：不做 try/catch 会让插件在真实宿主里**加载失败**
 *    （`Error: cannot get property "webServer" without inject`），
 *    而单元测试用普通对象反而全绿 —— 典型的「测了但没测真」。
 *
 * @param {object} ctx
 * @param {string} key
 * @returns {unknown} 服务实例，或 undefined（缺失/不可读）
 */
export function service(ctx, key) {
  if (!ctx || typeof ctx !== 'object') return undefined
  // ① 不要求 inject 的反射读取（首选）
  try {
    const viaReflect = ctx.reflect?.get?.(key, false)
    if (viaReflect !== undefined) return viaReflect
  } catch {
    /* 反射层不可用 → 继续尝试其它通路 */
  }
  // ② ctx.get()
  try {
    const viaGet = ctx.get?.(key)
    if (viaGet !== undefined) return viaGet
  } catch {
    /* 真实 ctx 未声明 inject 时会抛 → 忽略 */
  }
  // ③ `in` 探路 + 直接属性：更老宿主（如 rc1）可能没有 ctx.reflect，
  //    用 `in` 先判存在再取值，可绕开代理 get 陷阱的抛错。
  try {
    if (key in ctx) return ctx[key]
  } catch {
    /* `in` 也被拒 → 继续 */
  }
  // ④ 直接属性（测试替身）
  try {
    return ctx[key]
  } catch {
    return undefined
  }
}

// ── 能力探测 ───────────────────────────────────────────────────────────────

/**
 * 探测宿主能力。**缺任一项都不抛错**，调用方按 `available` 决定降级行为。
 * @param {object} ctx
 * @returns {{
 *   agents: boolean, subagents: boolean, agentTeams: boolean,
 *   webServer: boolean, sandboxPolicy: boolean, sessionPersistence: boolean,
 *   missing: string[],
 * }}
 */
export function capabilities(ctx) {
  const keys = ['agents', 'subagents', 'agentTeams', 'webServer', 'sandboxPolicy', 'sessionPersistence']
  const missing = []
  const found = {}
  for (const key of keys) {
    const ok = Boolean(service(ctx, key))
    found[key] = ok
    if (!ok) missing.push(key)
  }
  return { ...found, missing }
}

// ── Agent 注册表（live agent 访问）────────────────────────────────────────────

/**
 * 取一个 live Agent 的句柄。
 *
 * 官方语义（`dsh-agent/lib/types/index.d.ts`）：`ctx.agents` 是 `AgentRegistry`，
 * 提供 `get(id)` / `list()`。Team 服务的所有方法都要 `caller: Agent`，
 * 所以平台服务层必须先拿到 live Agent —— 本函数就是那条通路。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {object | undefined} live Agent，或 undefined（服务缺失 / 会话不在）
 */
export function getAgent(ctx, sessionId) {
  const agents = service(ctx, 'agents')
  if (!agents || typeof agents.get !== 'function') return undefined
  try {
    return agents.get(sessionId) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 列出全部 live Agent。
 * @param {object} ctx
 * @returns {object[]} 空数组表示服务缺失或无 agent（**不区分**，调用方按需再探测）
 */
export function listAgents(ctx) {
  const agents = service(ctx, 'agents')
  if (!agents || typeof agents.list !== 'function') return []
  try {
    const list = agents.list()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

// ── 投递（唤醒）─────────────────────────────────────────────────────────────

/**
 * 消息来源标记 —— 官方 `UserMessage.source` 需要它。
 * 未经标识的消息在会话日志里无法追溯，故统一走这里。
 */
const SOURCE = { kind: 'plugin', name: 'cs-bots' }

/**
 * 构造一条可投递的用户消息。**不投递**，只构造（便于幂等键先记账再发送）。
 * 宿主包解析失败时抛错（调用方需知道失败原因，这里不降级）。
 * @param {string} text
 * @returns {object} 冻结的 UserMessage
 */
export function buildMessage(text) {
  const createUserMessage = loadCreateUserMessage()
  return createUserMessage({
    content: [{ type: 'text', text: String(text ?? '') }],
    source: SOURCE,
  })
}

/** 宿主包是否可解析（诊断用，**不抛错**）。 */
export function hostLlmAvailable() {
  try {
    loadCreateUserMessage()
    return true
  } catch {
    return false
  }
}

/**
 * 投递一条消息并唤醒目标会话（`followup` 语义：**新开一个回合**）。
 *
 * 官方语义原文（`dsh-agent/lib/types/runtime-types.d.ts:191-193`）：
 *   "Queue an ordinary follow-up turn and wake the driver. The item becomes the
 *    sole ordinary message of its own turn."
 * ⇒ 适合「有新活要干」的唤醒。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {string} text
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function followup(ctx, sessionId, text) {
  const agent = getAgent(ctx, sessionId)
  if (!agent) return { ok: false, reason: 'agent-not-live' }
  if (typeof agent.followup !== 'function') return { ok: false, reason: 'followup-unsupported' }
  try {
    agent.followup(buildMessage(text))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `followup-failed:${error?.message ?? error}` }
  }
}

/**
 * 把消息插入目标会话的**最近步骤边界**（`steer` 语义）。
 *
 * 官方语义原文（`:194-199`）："Submit steering for the nearest step. An idle driver
 * starts a turn; a running driver consumes it at its next step boundary."
 * ⇒ 适合「正在干活时插一句话」，不新开回合。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {string} text
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function steer(ctx, sessionId, text) {
  const agent = getAgent(ctx, sessionId)
  if (!agent) return { ok: false, reason: 'agent-not-live' }
  if (typeof agent.steer !== 'function') return { ok: false, reason: 'steer-unsupported' }
  try {
    agent.steer(buildMessage(text))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `steer-failed:${error?.message ?? error}` }
  }
}

// ── 会话创建（**唯一能指定 cwd 的路径**）──────────────────────────────────────

/**
 * 创建一个 root Agent 会话，**可指定工作目录**。
 *
 * ⚠️ 这是本平台「共用工作目录」问题的**唯一解法**，务必不要用官方
 * `spawnTeammate` 代替（已实测：`SpawnTeammateRequest` 无 `cwd` 字段，
 * 且 teammate 强制继承父 cwd —— 见 `11-融合最终稿-v1.md` §0.1）。
 *
 * 官方语义（`dsh-agent/lib/types/index.d.ts:48-90`）：`CreateAgentOptions.meta.cwd`
 * 是 "validated absolute `cwd`"，且 **"This is durable session data"**。
 *
 * @param {object} ctx
 * @param {{ sessionId: string, cwd?: string, parentAgent?: object, agentPreset?: string,
 *           agentOptions?: object, signal?: AbortSignal }} options
 * @returns {Promise<object>} AgentHandle
 * @throws {Error} 服务缺失或创建失败（**这一条不降级**：调用方需要知道失败原因）
 */
export async function createSession(ctx, options) {
  const agents = service(ctx, 'agents')
  if (!agents || typeof agents.create !== 'function') {
    throw new Error('cs-bots kernel: agents.create 不可用（宿主未提供 agents 服务）')
  }
  const { sessionId, cwd, parentAgent, agentPreset, agentOptions, signal } = options ?? {}
  if (!sessionId) throw new Error('cs-bots kernel: createSession 需要 sessionId')

  const meta = {}
  if (cwd) meta.cwd = cwd
  if (agentPreset) meta.agentPreset = agentPreset
  if (parentAgent) meta.parentSession = parentAgent.id

  // ── 模型选择（2026-11-09 修复「bot has no provider/model」）───────────────
  // 官方 agent-loop 在每一步 preStep 都会 `this.model.current()`，
  // 得到 undefined 就直接抛 `agent "X" has no provider/model`。
  // 官方 Web UI 建会话时由 session-controller 记录一次 model selection；
  // 我们走 agents.create 这条窄接口，**没有人替我们记录** ⇒ 必须自己带上。
  // 取值优先级：调用方显式给 > 宿主的全局默认（agentDefaultModel.currentSelection()）。
  const route = agentOptions ?? defaultModelSelection(ctx)

  const handle = await agents.create({
    sessionId,
    ...(parentAgent ? { parentAgent } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(route ? { agentOptions: route } : {}),
    ...(signal ? { signal } : {}),
  })

  // ── 挂进工作区（2026-11-09 修复「左侧栏未分组」）─────────────────────────
  // 官方把会话归组进 Workspace（`workspaceRegistry`），attachSession 的
  // 前置条件是「会话 header 的 cwd 与 workspace.path 完全相同」。
  // 我们建会话时正好指定了 cwd，所以这里补上「建/复用 workspace + attach」，
  // 否则会话永远落在「未分组」里（2026-11-09 现场：bot-6b654c19… 就是）。

  // 注意顺序：attach 必须在会话创建之后（attach 要读会话 header 的 cwd）。
  if (cwd) {
    try {
      await attachToWorkspace(ctx, cwd, pickSessionId(handle, sessionId))
    } catch {
      /* 工作区挂载是「锦上添花」：失败不影响会话可用（只是仍显示未分组） */
    }
  }
  return handle
}

/**
 * 宿主全局默认模型（`agentDefaultModel.currentSelection()`）。
 * 缺失/异常一律返回 undefined —— 不因拿不到默认模型就让建会话失败。
 * @param {object} ctx
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
function defaultModelSelection(ctx) {
  try {
    const svc = service(ctx, 'agentDefaultModel')
    if (!svc || typeof svc.currentSelection !== 'function') return undefined
    const sel = svc.currentSelection()
    if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') return undefined
    if (sel.provider === '' || sel.model === '') return undefined
    return {
      provider: sel.provider,
      model: sel.model,
      ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
    }
  } catch {
    return undefined
  }
}

/** 从 AgentHandle 里取 session id（宿主可能返回 { agent } / { sessionId } / 字符串）。 */
function pickSessionId(handle, fallback) {
  if (typeof handle === 'string' && handle) return handle
  const id = handle?.agent?.id ?? handle?.sessionId ?? handle?.id
  return typeof id === 'string' && id ? id : fallback
}

/**
 * 把会话挂到「路径 = 该会话 cwd」的工作区（不存在则先建）。
 *
 * 官方契约（`dsh-workspace/lib/index.js`）：
 *   - `workspaceRegistry.create(path)` 建（同路径已存在时会复用，返回 created=false）
 *   - `workspace.attachSession(sessionId)` 挂，前提是会话 cwd === workspace.path
 *   - 两个方法都可能不存在（老宿主）⇒ 全程 try/catch，静默降级
 *
 * @param {object} ctx
 * @param {string} cwd 已存在的绝对目录
 * @param {string} sessionId
 * @returns {Promise<boolean>} 是否挂上
 */
export async function attachToWorkspace(ctx, cwd, sessionId) {
  const registry = service(ctx, 'workspaceRegistry')
  if (!registry || typeof sessionId !== 'string' || !sessionId) return false
  let workspace
  try {
    if (typeof registry.resolveByPath === 'function') {
      workspace = await registry.resolveByPath(cwd)
    }
  } catch {
    workspace = undefined
  }
  if (!workspace) {
    if (typeof registry.create !== 'function') return false
    const out = await registry.create(cwd) // 官方可能返回 { workspace, created } 或直接返回 workspace
    workspace = out?.workspace ?? out
  }
  if (!workspace || typeof workspace.attachSession !== 'function') return false
  await workspace.attachSession(sessionId)
  return true
}

/**
 * 在既有持久会话上恢复 Agent（重启后复活会话用）。
 * @param {object} ctx
 * @param {{ resumeSessionId: string, signal?: AbortSignal }} options
 * @returns {Promise<object>} AgentHandle
 */
export async function resumeSession(ctx, options) {
  const agents = service(ctx, 'agents')
  if (!agents || typeof agents.resume !== 'function') {
    throw new Error('cs-bots kernel: agents.resume 不可用')
  }
  const { resumeSessionId, signal, agentOptions } = options ?? {}
  if (!resumeSessionId) throw new Error('cs-bots kernel: resumeSession 需要 resumeSessionId')
  // 2026-11-09 同源修复：**存量会话**从来没有记录过模型选择（当时走的是不带
  // agentOptions 的创建路径），复活后依然 `model.current() === undefined`，
  // 下一次唤醒照样炸 `has no provider/model`。所以复活也要给兜底路由：
  // 调用方显式给 > 会话自己已记录的 > 宿主全局默认（由宿主负责，我们只在
  // 前两者都没有时才传，避免把用户后来改过的会话级选择覆盖回默认值）。
  const route = agentOptions ?? defaultModelSelection(ctx)
  return agents.resume({
    resumeSessionId,
    ...(route ? { agentOptions: route } : {}),
    ...(signal ? { signal } : {}),
  })
}

// ── HTTP 路由注册 ───────────────────────────────────────────────────────────

/**
 * 在宿主 webServer 上注册一条前缀路由（平台 API 面）。
 * 缺 webServer 时返回 `undefined`（降级：平台无 HTTP 面，但服务照常工作）。
 *
 * @param {object} ctx
 * @param {string} path 必须以 `/` 开头
 * @param {(req: object, res: object) => void | Promise<void>} handler
 * @returns {(() => void) | undefined} disposer
 */
export function registerRoute(ctx, path, handler) {
  const webServer = service(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') return undefined
  return webServer.register({ kind: 'prefix', path, handler })
}

// ── 工具注册（模型面）────────────────────────────────────────────────────────

/**
 * 注册一条模型可见工具。
 *
 * 官方契约（`dsh-tools/lib/types/index.d.ts:115-146`）：
 *   `ToolDefinition = ToolSchema + { output: { schema, render }, execute(args, exec) }`
 *   —— `output` 是**强制**的，且 `execute` 只返回**规范无损 JSON 值**（渲染交给 `render`）。
 *
 * 缺 tools 服务时返回 `undefined`（降级：模型看不到该工具，但域服务照常工作）。
 *
 * @param {object} ctx
 * @param {{ name: string, description: string, parameters: object,
 *           outputSchema: object, render: Function, execute: Function }} spec
 * @returns {(() => void) | undefined} disposer
 */
export function registerTool(ctx, spec) {
  const tools = service(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') return undefined
  const { name, description, parameters, outputSchema, render, execute } = spec ?? {}
  if (!name || typeof execute !== 'function') {
    throw new Error('cs-bots kernel.registerTool: 需要 name 与 execute')
  }
  return tools.register({
    name,
    description: description ?? '',
    parameters: parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: outputSchema ?? { type: 'object' },
      render:
        typeof render === 'function'
          ? render
          : (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
    },
    execute,
  })
}

/**
 * 装一条全局工具执行闸门（K1 用）。缺 tools 服务时返回 `undefined`。
 * @param {object} ctx
 * @param {(exec: object) => string | undefined} guard 返回字符串=拒绝执行（作为理由）
 * @returns {(() => void) | undefined}
 */
export function guardTool(ctx, guard) {
  const tools = service(ctx, 'tools')
  if (!tools || typeof tools.guard !== 'function') return undefined
  return tools.guard(guard)
}

/**
 * 从某个 agent 的工具表中移除工具名（K1 双保险之二）。
 * @param {object} agent
 * @param {string[]} names
 * @returns {boolean} 是否施加成功
 */
export function restrictTools(agent, names) {
  const agentTools = agent?.ctx?.tools
  if (typeof agentTools?.restrict !== 'function') return false
  try {
    // restrict() 对「本 profile 不提供的工具名」会抛错 → 先与实际工具表求交集
    const served = typeof agentTools.schemas === 'function'
      ? new Set(agentTools.schemas(agent).map((schema) => schema?.name))
      : undefined
    const deny = served ? names.filter((n) => served.has(n)) : names
    if (deny.length === 0) return false
    agentTools.restrict({ deny })
    return true
  } catch {
    return false
  }
}

// ── LLM 请求拦截（复杂度路由唯一需要的宿主触点）──────────────────────────────

/**
 * 注册一条 `llm/stream` 瀑布拦截（**接口 v1，2026-11-04 新增**）。
 *
 * 官方语义一手依据：
 *   - 调用点：`dsh-llm/lib/index.js:2397`
 *     `this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(...))`
 *   - 签名：`'llm/stream'(this: LlmRuntime, options: GenerateOptions,
 *     next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`
 *   - 官方插件用法样板：`dsh-session-checkpoint-policy/lib/index.js:61`
 *     `ctx.on('llm/stream', (options, next) => { ... return next() })`
 *
 * ⚠️ `options` 是**冻结的**（`dsh-agent-loop/lib/index.js:1286` 处 `Object.freeze`）：
 *    处理函数只能读、不能写；想让下游知道点什么，必须走旁路通道
 *    （本平台用 `globalThis[Symbol.for('cs-myfree.routing.hints.v1')]`）。
 *
 * ⚠️ handler 必须**同步返回 `next()`**（那是 AsyncIterable，不是 Promise），
 *    所以本函数不做任何 await，也不包 async。
 *
 * 缺 `ctx.on`（测试替身/更老宿主）时返回 `false`，调用方按降级处理，**不抛**。
 *
 * @param {object} ctx
 * @param {(options: object, next: Function) => any} handler
 * @returns {boolean} 是否注册成功
 */
export function onLlmStream(ctx, handler) {
  if (!ctx || typeof ctx.on !== 'function') return false
  if (typeof handler !== 'function') return false
  try {
    ctx.on('llm/stream', handler)
    return true
  } catch {
    return false
  }
}

// ── 会话元数据（谱系）──────────────────────────────────────────────────────

/**
 * 读一个会话的**谱系元数据**（接口 v1，2026-11-04 新增）。
 *
 * 为什么需要（授权泄漏修复）：官方 `spawn_teammate` 生成的子会话**不在 cs-bots 的
 * roster 注册表里**，但宿主 session header 带谱系字段。没有这条信息，平台只能把
 * 「不是 Bot 的会话」当成主对话 ⇒ 官方子智能体反而拿到 `paid_allowed`（越权付费）。
 *
 * 一手依据（宿主源码，已核验）：
 *   - `dsh-session/lib/index.js:1340` `Session.header`（公开属性，deep-frozen）；
 *   - `dsh-session/lib/index.js:1823-1827` header 由 `meta` 组装，含
 *     `parentSession` / `origin`（子代理为 `'subagent'`）/ `delegationDepth` / `agentPreset`；
 *   - `dsh-session/lib/index.js:1980` `sessions.get(id)` ⇒ Session。
 *
 * 纪律：
 *   - **只取白名单四个字段**并转成纯数据（绝不把宿主对象/header 引用漏给业务层）；
 *   - 服务缺失、无此会话、任何抛错 ⇒ `null`（调用方据此 fail-closed，**本函数绝不抛**）；
 *   - 返回 `{}` 表示「会话存在但没有任何谱系字段」= 可确认是顶层会话（主对话）。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {{ origin?: string, parentSession?: string, delegationDepth?: number,
 *             agentPreset?: string } | null}
 */
export function sessionMeta(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const sessions = service(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return null
  let header
  try {
    header = sessions.get(sessionId)?.header
  } catch {
    return null
  }
  if (!header || typeof header !== 'object') return null

  /** @type {{ origin?: string, parentSession?: string, delegationDepth?: number, agentPreset?: string }} */
  const meta = {}
  try {
    if (typeof header.origin === 'string' && header.origin !== '') meta.origin = header.origin
    if (typeof header.parentSession === 'string' && header.parentSession !== '') {
      meta.parentSession = header.parentSession
    }
    if (typeof header.delegationDepth === 'number' && Number.isFinite(header.delegationDepth)) {
      meta.delegationDepth = header.delegationDepth
    }
    if (typeof header.agentPreset === 'string' && header.agentPreset !== '') {
      meta.agentPreset = header.agentPreset
    }
  } catch {
    // 代理陷阱/只读失败等 ⇒ 视为拿不到元数据（调用方 fail-closed）
    return null
  }
  return meta
}

// ── 状态目录 ────────────────────────────────────────────────────────────────

/**
 * 平台状态目录：`$DSH_HOME/cs-bots/`。
 * @returns {string}
 */
export function stateDir() {
  const home = process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`
  return `${home}/cs-bots`
}

/**
 * 列出可用 agent 预设（**缺服务返回空数组，不抛**）。
 *
 * 预设是什么：一组「模型 + 系统提示 + 技能 + 工具白名单」的声明式组合。
 * 同一个 DSH 里可以有 dev-steward / 普通助手 / 记忆整理 等多个预设。
 * Bot 建会话时把 preset 传进 `meta.agentPreset`，新会话就用那套人格与工具面。
 *
 * @param {object} ctx
 * @returns {Promise<Array<{id:string,name?:string,description?:string,order?:number,broken?:string}>>}
 */
export async function listPresets(ctx) {
  const registry = service(ctx, 'agentPresets')
  if (!registry || typeof registry.list !== 'function') return []
  try {
    const rows = await registry.list()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * 取默认预设 id（缺服务返回 undefined）。
 * @param {object} ctx
 * @returns {string | undefined}
 */
export function defaultPreset(ctx) {
  const registry = service(ctx, 'agentPresets')
  try {
    return typeof registry?.defaultId === 'string' ? registry.defaultId : undefined
  } catch {
    return undefined
  }
}

// ── 会话内容读取（需求2：任务详情里直接看对话，不必跳走）──────────────────────

/**
 * 读一个会话的历史事件，转成「人类可读的对话片段」。
 *
 * 为什么需要它（2026-11-08 用户反馈）：
 *   「任务栏页面指派 bot 后，无法追踪任务进度，无法看到产出物，
 *     没有跳转对话也没有对话内容查看」
 *   ⇒ 跳转会话（openSession）只能把人带到会话界面，**看不到这个任务相关的对话**；
 *     人想看「Bot 到底干了什么」，必须能在任务详情里直接读。
 *
 * 数据来源：官方 `ctx.sessionPersistence`（durable 事件日志，**真相源**）。
 * 为什么不用 live Agent 的内存：进程重启后 live 注册表是空的，但磁盘上的会话仍在——
 * 用持久化层读才能保证「重启后照样能看历史」。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {{ limit?: number, offset?: number }} [options]
 *   - `limit`：最多返回多少条**消息片段**（默认 40；取**末尾**的，因为人关心最近发生了什么）
 * @returns {Promise<{
 *   ok: boolean, sessionId?: string, messages?: object[], total?: number,
 *   reason?: string, available?: boolean,
 * }>}
 */
export async function readSessionMessages(ctx, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, reason: 'missing-session-id', available: true }
  }
  const persistence = service(ctx, 'sessionPersistence')
  if (!persistence || typeof persistence.open !== 'function') {
    return {
      ok: false,
      available: false,
      reason: 'sessionPersistence 不可用（宿主未装配持久化层）——无法读取会话历史',
    }
  }

  let handle
  try {
    // access: 'read' —— 只读打开，绝不抢所有权（会话可能正在被 live agent 使用）
    handle = await persistence.open(sessionId, 'read')
  } catch (error) {
    return {
      ok: false,
      available: true,
      reason: `打开会话失败：${error?.message ?? error}`,
    }
  }

  try {
    const result = await handle.read(0)
    const events = Array.isArray(result?.events) ? result.events : []
    const messages = eventsToMessages(events)
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 40
    // 取末尾 limit 条：人关心的是「最近在干什么」，不是开场白
    const tail = messages.length > limit ? messages.slice(-limit) : messages
    return {
      ok: true,
      sessionId,
      messages: tail,
      total: messages.length,
      truncated: messages.length > limit,
    }
  } catch (error) {
    return { ok: false, available: true, reason: `读取会话事件失败：${error?.message ?? error}` }
  } finally {
    try {
      await handle.close?.()
    } catch {
      /* 关闭失败不影响已读到的数据 */
    }
  }
}

/**
 * 把官方 SessionEvent 转成人类可读的消息片段。
 *
 * 只保留**有对话价值**的事件类型：用户消息、助手文本、工具调用（摘要）、工具结果（摘要）。
 * 其余事件（会话元数据、内存写入等）一律跳过——它们对「看 Bot 干了什么」没有帮助，
 * 塞进来只会让人淹没在噪声里。
 *
 * 每条输出统一形状：`{ role, kind, text, at?, toolName? }`
 *   - role: 'user' | 'assistant' | 'tool'
 *   - kind: 'text' | 'tool-call' | 'tool-result' | 'reasoning'
 *
 * @param {object[]} events
 * @returns {object[]}
 */
export function eventsToMessages(events) {
  const out = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    // 官方 SessionEvent 的形状是 `{ type, seq, time, data }` —— 内容在 `data` 里。
    // 早期实现只读 `ev.content`，结果对**任何真实会话**都产出空数组（需求2「看不到对话内容」
    // 的真因）。这里同时兼容两种形状，避免新旧数据各有盲区。
    const type = ev.type
    const at = typeof ev.time === 'number' ? ev.time : undefined
    const data = (ev.data && typeof ev.data === 'object') ? ev.data : {}

    const pushBlocks = (role, blocks) => {
      if (!Array.isArray(blocks)) return
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ role, kind: 'text', text: b.text, at })
        } else if (b.type === 'reasoning' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ role: 'assistant', kind: 'reasoning', text: b.text.slice(0, 2000), at })
        } else if (b.type === 'tool-call' || b.type === 'toolCall') {
          out.push({ role: 'assistant', kind: 'tool-call', toolName: String(b.name ?? b.toolName ?? '?'), text: summarizeInput(b.input ?? b.arguments), at })
        }
      }
    }

    // 用户消息（含 system/developer 注入的「用户侧」文本，人看任务上下文需要）
    if (type === 'user/message' || type === 'user-message') {
      pushBlocks('user', data.content ?? ev.content ?? data.message?.content ?? ev.message?.content)
      continue
    }

    // 助手消息：内容在 data.message.content
    if (type === 'assistant/message' || type === 'assistant-message') {
      const msg = data.message ?? ev.message ?? {}
      pushBlocks('assistant', msg.content ?? data.content ?? ev.content)
      continue
    }

    // 工具调用：data.name + data.arguments（顶层事件，不嵌在 assistant 消息里）
    if (type === 'tool/call' || type === 'tool-call' || type === 'toolCall') {
      const name = data.name ?? data.toolName ?? ev.name
      const summary = summarizeInput(data.arguments ?? data.input ?? ev.arguments)
      // 既没名字也没入参 ⇒ 对「看 Bot 干了什么」毫无信息量，跳过而不是画一个空壳
      if (!name && !summary) continue
      out.push({
        role: 'assistant',
        kind: 'tool-call',
        toolName: String(name ?? '?'),
        text: summary,
        at,
      })
      continue
    }

    // 工具结果：data.message.content
    if (type === 'tool/result' || type === 'tool-result' || type === 'toolResult') {
      const msg = data.message ?? ev.message ?? {}
      const text = blocksToText(msg.content ?? data.content ?? ev.content ?? ev.result)
      const name = msg.toolName ?? data.name ?? ev.toolName
      if (text) {
        out.push({
          role: 'tool',
          kind: 'tool-result',
          ...(typeof name === 'string' && name ? { toolName: name } : {}),
          text: text.length > 1500 ? `${text.slice(0, 1500)}\u2026` : text,
          at,
        })
      }
      continue
    }
  }
  return out
}

/** 工具入参压成一行摘要（对象转 JSON，超长截断）。 */
function summarizeInput(input) {
  if (input === undefined || input === null) return ''
  let summary = ''
  try {
    summary = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    summary = ''
  }
  return summary && summary.length > 500 ? `${summary.slice(0, 500)}\u2026` : summary
}

/** 把 content blocks 拍平成一段文本（只取 text 类型块）。 */
function blocksToText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (typeof b === 'string') parts.push(b)
    else if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}
