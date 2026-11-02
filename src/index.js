/**
 * cs-bots 宿主半身 —— 多智能体协作平台。
 *
 * 设计纪律（由 test/ci-zero-dep.sh 机械强制）：
 *   - **零第三方依赖**：不 import 任何非 `@deepseek-ai/*` 的包；`dependencies` 为空。
 *   - **kernel.js 单点**：与 DSH 宿主的耦合只允许出现在 `src/kernel.js`；
 *     本文件及后续业务文件一律从 kernel.js 取宿主能力。
 *   - **缺服务只记日志、绝不阻塞启动**：所有服务惰性获取 + 降级。
 *
 * 当前阶段：P0–P5 全域服务 + 模型面工具。
 */

import { createBoard } from './board.js'
import { createDispatcher } from './dispatcher.js'
import { createRoster } from './roster.js'
import { createRoom } from './room.js'
import { createMemory } from './memory.js'
import { installTools } from './tools.js'
import { setServices } from './registry.js'
import { service, stateDir as kernelStateDir } from './kernel.js'
import { installApi } from './api.js'
import { loadSettings } from './settings.js'
import { probeHost, formatReport } from './compat.js'

export const name = 'cs-bots'

/**
 * Bot 会话中必须从工具表移除的工具（K1）。
 *
 * 一手依据（ds-bot 已踩过此坑，`ds-bot/src/host/tools.js:708-713` 注释原文）：
 *   "dsh's own question tool holds the turn open until the user answers, and every
 *    message from another Bot or a group round queues behind it."
 *   ⇒ 在多智能体结构里，**同步等用户的提问工具会堵住整条投递链**，是结构性反模式。
 */
const BLOCKING_QUESTION_TOOL = 'ask_user_question'

/**
 * 插件入口 —— **绝不抛错**。
 *
 * 为什么必须这样（真实教训）：宿主在 `apply()` 抛错时**整个 DSH 起不来**，
 * 用户只能「禁用插件才能打开」。所以这里做最后一道兜底：
 * 任何漏网的异常都只记日志，**不向外抛**。
 * 代价是"静默降级"，但绝不让一个插件拖垮整个宿主。
 *
 * @param {object} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  let log = () => {}
  let warn = () => {}
  try {
    log = (...args) => ctx?.logger?.info?.(...args)
    warn = (...args) => ctx?.logger?.warn?.(...args)
  } catch {
    /* 连 logger 都取不到 → 用空实现 */
  }

  try {
    applyInner(ctx, config, { log, warn })
  } catch (error) {
    // 最后一道防线：不让插件把宿主启动搞崩
    try {
      warn(`[cs-bots] 装配异常已被兜底（插件降级，DSH 可正常启动）：${error?.message ?? error}`)
      warn(`[cs-bots] 若需完整功能，请把这段错误发回开发者：${String(error?.stack ?? '').split('\n').slice(0, 6).join(' | ')}`)
    } catch {
      /* 日志也失败 → 完全静默，但宿主安全 */
    }
  }
}

function applyInner(ctx, config, { log, warn }) {
  log('[cs-bots] 装配中')

  // ── 宿主兼容性探测（**先探测再装配**；探测本身不抛）──────────────────────
  let compat
  try {
    compat = probeHost(ctx, { warn })
    log(`[cs-bots] 宿主兼容性：${formatReport(compat)}`)
    if (compat.notes?.length) for (const n of compat.notes) warn(`[cs-bots] ${n}`)
  } catch (error) {
    warn(`[cs-bots] 兼容性探测失败（继续装配）：${error?.message ?? error}`)
    compat = { dshVersion: undefined, node: 'unknown', available: {}, missing: [], notes: [] }
  }

  // ── L2 域服务：一律惰性装配、各自降级，**任一失败都不阻塞启动** ──────────────
  // ⚠️ 两个域的构造签名不同（board 是 `(ctx, config)`，dispatcher 也是 `(ctx, config)`）；
  //    日志一律用**字符串拼接**而非 `%s` 占位（避免形态差异导致格式串未插值）。
  const services = {}
  services.compat = compat

  // ── 设置：**先读，再拿去装配各域**（改设置才真的改变行为）────────────────
  const settingsDir = config.stateDir ?? kernelStateDir()
  const loaded = loadSettings(settingsDir)
  const settings = loaded.values
  if (loaded.diagnostics.badKeys.length) {
    warn(`[cs-bots] 设置文件有 ${loaded.diagnostics.badKeys.length} 个无效项已忽略：${JSON.stringify(loaded.diagnostics.badKeys)}`)
  }
  services.settings = { ...settings }
  services.settingsDiagnostics = loaded.diagnostics
  log(`[cs-bots] 设置来源=${loaded.diagnostics.source}（${Object.keys(settings).length} 项）`)

  // RosterService 先装配：K1 闸门需要它判定「哪些会话是 Bot」。
  try {
    services.roster = createRoster(ctx, { stateDir: config.stateDir, leaseMs: settings.defaultLeaseMs })
    log(`[cs-bots] RosterService 就绪（stateDir=${services.roster.paths?.stateDir ?? '?'}，durable=${services.roster.durable}）`)
  } catch (error) {
    warn(`[cs-bots] RosterService 装配失败 → 降级（Bot 注册表不可用，K1 保守放行）：${error?.message ?? error}`)
    services.roster = undefined
  }

  try {
    services.board = createBoard(ctx, { stateDir: config.stateDir, leaseMs: settings.defaultLeaseMs })
    log(`[cs-bots] BoardService 就绪（stateDir=${services.board.paths?.stateDir ?? '?'}）`)
  } catch (error) {
    warn(`[cs-bots] BoardService 装配失败 → 降级（无任务板）：${error?.message ?? error}`)
    services.board = undefined
  }

  try {
    services.dispatcher = createDispatcher(ctx, { stateDir: config.stateDir, throttleMs: settings.throttleMs, maxPerTarget: settings.maxWakesPerTarget, queueTtlMs: settings.wakeTtlMs })
    if (services.dispatcher.durable === false) {
      warn(`[cs-bots] Dispatcher 状态目录不可写 → 唤醒记录不持久：${services.dispatcher.probeError ?? ''}`)
    }
    log(`[cs-bots] Dispatcher 就绪（durable=${services.dispatcher.durable}）`)
  } catch (error) {
    warn(`[cs-bots] Dispatcher 装配失败 → 降级（不自动唤醒）：${error?.message ?? error}`)
    services.dispatcher = undefined
  }

  try {
    services.room = createRoom(ctx, { stateDir: config.stateDir })
    log(`[cs-bots] RoomService 就绪（stateDir=${services.room.paths?.stateDir ?? '?'}）`)
  } catch (error) {
    warn(`[cs-bots] RoomService 装配失败 → 降级（无房间/群聊）：${error?.message ?? error}`)
    services.room = undefined
  }

  try {
    services.memory = createMemory(ctx, { stateDir: config.stateDir, entryMax: settings.memoryEntryMax, splitOnOverflow: settings.memorySplitOnOverflow })
    log(`[cs-bots] MemoryService 就绪（stateDir=${services.memory.paths?.stateDir ?? '?'}）`)
  } catch (error) {
    warn(`[cs-bots] MemoryService 装配失败 → 降级（无分层记忆）：${error?.message ?? error}`)
    services.memory = undefined
  }

  if (settings.k1Enabled) {
    installBlockingToolGate(ctx, { warn, roster: services.roster })
    installBotToolTrimmer(ctx, { warn, roster: services.roster })
  } else {
    warn('[cs-bots] K1 已按设置关闭 → Bot 会话可用 ask_user_question（有堵投递链风险）')
  }

  // ── 模型面：注册全部工具（**没有这一层，新机器上装完插件模型看不到任何能力**）─
  // 必须在域服务就绪之后注册：工具执行时从 `ctx.csBots` 取服务。
  // ⚠️ 不能 `ctx.csBots = services`：Cordis ctx 禁止任意属性（实测报
  //    `cannot set property "csBots" without provide`）→ 走 WeakMap 注册表。
  setServices(ctx, services)
  // ── 页面数据面：HTTP API（页面层靠它拿数据；没有它 UI 是空壳）──────────────
  services.apiDispose = installApi(ctx, { warn })

  const toolNames = installTools(ctx, { warn })
  if (toolNames.length === 0) {
    warn('[cs-bots] 未注册任何工具（tools 服务不可用？）→ 模型将看不到平台能力')
  } else {
    log(`[cs-bots] 已注册 ${toolNames.length} 个工具：${toolNames.join(', ')}`)
  }

  // ── 生命周期收尾：停止定时器，避免进程退出被挂起的 timer 拖住 ────────────────
  // 用官方 ctx.effect（若可用）保证插件卸载时被调用；不可用则退化为不注册。
  const dispose = () => {
    try {
      services.dispatcher?.dispose?.()
      try { services.apiDispose?.() } catch { /* 已卸载 */ }
    } catch (error) {
      warn(`[cs-bots] dispatcher dispose 失败：${error?.message ?? error}`)
    }
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'cs-bots:dispose')
    } catch {
      /* 注册失败不阻塞 */
    }
  }

  log('[cs-bots] 装配完成')
}

/**
 * 装 K1 闸门（全局 guard，双保险之一）。
 *
 * 为什么不在这里直接 restrict：`tools.guard` 是**同步闸门**，任何时刻都拦得住；
 * 而 `restrict({deny})` 让工具**不出现在模型的工具表**里（省 token、模型不会误调），
 * 需要在 `agent/created` 时按 Bot 身份施加 —— 那要等 RosterService（P5）判定
 * 「哪些会话是 Bot」。当前阶段**保守判定**，不误伤人类会话与官方 teammate。
 */
function installBlockingToolGate(ctx, { warn, roster }) {
  const tools = service(ctx, 'tools')
  if (!tools || typeof tools.guard !== 'function') {
    warn('[cs-bots] tools 服务不可用 → K1 闸门未装（降级，不阻塞启动）')
    return undefined
  }
  try {
    return tools.guard((exec) => {
      if (exec?.name !== BLOCKING_QUESTION_TOOL) return undefined
      if (!isBotSession(exec?.agent, roster)) return undefined
      return `Bot 会话不能使用 ${BLOCKING_QUESTION_TOOL}（会堵住整条多智能体投递链）。请在回复里直接提问。`
    })
  } catch (error) {
    warn(`[cs-bots] 装 K1 闸门失败：${error?.message ?? error}`)
    return undefined
  }
}

/**
 * 判定一个 agent 是否属于本平台的 Bot。
 *
 * P5 起接入 RosterService：按 **sessionId** 查注册表（口径 = 「该会话已被注册为 Bot 且未退役」）。
 * 无 roster（降级）或查不到时**保守返回 false** —— 宁可漏拦，也不误伤人类会话与官方 teammate。
 *
 * @param {unknown} agent
 * @param {{ list?: Function } | undefined} roster
 * @returns {boolean}
 */
function isBotSession(agent, roster) {
  const sid = agent?.id ?? agent?.session?.id
  if (!sid || !roster || typeof roster.list !== 'function') return false
  try {
    return roster.list().some((bot) => bot?.sessionId === sid)
  } catch {
    return false
  }
}

/**
 * 把阻塞式提问工具从某个 Bot 会话的工具表中彻底移除（双保险之二）。
 * 由 `agent/created` 监听器在确认身份后调用。
 *
 * @param {{ ctx?: { tools?: { restrict?: Function, schemas?: Function } } }} agent
 */
export function hideBlockingToolsFromBot(agent, { warn } = {}) {
  if (!agent || typeof agent !== 'object') return
  const agentTools = agent.ctx?.tools
  if (typeof agentTools?.restrict !== 'function') return
  try {
    // restrict() 对「本 profile 不提供的工具名」会抛错 → 先与实际工具表求交集。
    const served = typeof agentTools.schemas === 'function'
      ? new Set(agentTools.schemas(agent).map((schema) => schema?.name))
      : undefined
    const deny = served
      ? [BLOCKING_QUESTION_TOOL].filter((n) => served.has(n))
      : [BLOCKING_QUESTION_TOOL]
    if (deny.length === 0) return
    agentTools.restrict({ deny })
  } catch (error) {
    warn?.(`[cs-bots] 移除 Bot 的 ${BLOCKING_QUESTION_TOOL} 失败：${error?.message ?? error}`)
  }
}

/**
 * 装 `agent/created` 监听器（K1 双保险之二）。
 *
 * 官方语义原文（`ds-bot/src/host/tools.js:736` 注释）：
 *   "Creation waits for this listener, so the Agent's first step already lacks the tool."
 * ⇒ 在**第一个 step 之前**就把工具摘掉，模型既看不到也调不到（省 token）。
 *
 * 缺 `ctx.on` 或 roster 时**只 warn 不抛**（降级安全）。
 */
function installBotToolTrimmer(ctx, { warn, roster }) {
  if (typeof ctx.on !== 'function') {
    warn('[cs-bots] ctx.on 不可用 → K1 工具摘除未装（仅靠 guard 兜底）')
    return
  }
  if (!roster) {
    warn('[cs-bots] 无 RosterService → K1 工具摘除未装（仅靠 guard 兜底）')
    return
  }
  try {
    ctx.on('agent/created', ({ agent }) => {
      try {
        if (!isBotSession(agent, roster)) return
        hideBlockingToolsFromBot(agent, { warn })
      } catch (error) {
        warn(`[cs-bots] agent/created 处理失败：${error?.message ?? error}`)
      }
    })
  } catch (error) {
    warn(`[cs-bots] 注册 agent/created 失败：${error?.message ?? error}`)
  }
}
