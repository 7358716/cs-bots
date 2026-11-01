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
 * 惰性取服务：兼容「新 API 有 get」与「老/测试上下文直接挂属性」两种形态。
 * @param {object} ctx
 * @param {string} key
 * @returns {unknown}
 */
function service(ctx, key) {
  return ctx?.get?.(key) ?? ctx?.[key]
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

  return agents.create({
    sessionId,
    ...(parentAgent ? { parentAgent } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(agentOptions ? { agentOptions } : {}),
    ...(signal ? { signal } : {}),
  })
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
  const { resumeSessionId, signal } = options ?? {}
  if (!resumeSessionId) throw new Error('cs-bots kernel: resumeSession 需要 resumeSessionId')
  return agents.resume({ resumeSessionId, ...(signal ? { signal } : {}) })
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

// ── 工具守卫与限制 ──────────────────────────────────────────────────────────

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

// ── 状态目录 ────────────────────────────────────────────────────────────────

/**
 * 平台状态目录：`$DSH_HOME/cs-bots/`。
 * @returns {string}
 */
export function stateDir() {
  const home = process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`
  return `${home}/cs-bots`
}
