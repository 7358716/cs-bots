/**
 * cs-bots 宿主半身 —— 多智能体协作平台。
 *
 * 设计纪律（由 test/ci-zero-dep.sh 机械强制）：
 *   - **零第三方依赖**：不 import 任何非 `@deepseek-ai/*` 的包；`dependencies` 为空。
 *   - **kernel.js 单点**：与 DSH 宿主的耦合只允许出现在 `src/kernel.js`；
 *     本文件及后续业务文件一律从 kernel.js 取宿主能力。
 *   - **缺服务只记日志、绝不阻塞启动**：所有服务惰性获取 + 降级。
 *
 * 当前阶段：P1（解封 maxMembers + K1 闸门）+ P2（任务板闭环 + 唤醒桥）。
 */

import { createBoard } from './board.js'
import { createDispatcher } from './dispatcher.js'

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

/** 惰性取服务：兼容「新 API 有 get」与「老/测试上下文直接挂属性」两种形态。 */
function service(ctx, key) {
  return ctx?.get?.(key) ?? ctx?.[key]
}

export function apply(ctx, config = {}) {
  const log = (...args) => ctx.logger?.info?.(...args)
  const warn = (...args) => ctx.logger?.warn?.(...args)

  log('[cs-bots] 装配中')

  // ── L2 域服务：一律惰性装配、各自降级，**任一失败都不阻塞启动** ──────────────
  // ⚠️ 两个域的构造签名不同（board 是 `(ctx, config)`，dispatcher 也是 `(ctx, config)`）；
  //    日志一律用**字符串拼接**而非 `%s` 占位（避免形态差异导致格式串未插值）。
  const services = {}
  try {
    services.board = createBoard(ctx, { stateDir: config.stateDir })
    log(`[cs-bots] BoardService 就绪（stateDir=${services.board.paths?.stateDir ?? '?'}）`)
  } catch (error) {
    warn(`[cs-bots] BoardService 装配失败 → 降级（无任务板）：${error?.message ?? error}`)
    services.board = undefined
  }

  try {
    services.dispatcher = createDispatcher(ctx, { stateDir: config.stateDir })
    if (services.dispatcher.durable === false) {
      warn(`[cs-bots] Dispatcher 状态目录不可写 → 唤醒记录不持久：${services.dispatcher.probeError ?? ''}`)
    }
    log(`[cs-bots] Dispatcher 就绪（durable=${services.dispatcher.durable}）`)
  } catch (error) {
    warn(`[cs-bots] Dispatcher 装配失败 → 降级（不自动唤醒）：${error?.message ?? error}`)
    services.dispatcher = undefined
  }

  installBlockingToolGate(ctx, { warn })

  // ── 生命周期收尾：停止定时器，避免进程退出被挂起的 timer 拖住 ────────────────
  // 用官方 ctx.effect（若可用）保证插件卸载时被调用；不可用则退化为不注册。
  const dispose = () => {
    try {
      services.dispatcher?.dispose?.()
    } catch (error) {
      warn('[cs-bots] dispatcher dispose 失败：%s', error?.message ?? error)
    }
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'cs-bots:dispose')
    } catch {
      /* 注册失败不阻塞 */
    }
  }

  // 暴露给同 fiber 的其他模块/测试（非官方契约，仅供本插件内部与测试使用）。
  ctx.csBots = services

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
function installBlockingToolGate(ctx, { warn }) {
  const tools = service(ctx, 'tools')
  if (!tools || typeof tools.guard !== 'function') {
    warn('[cs-bots] tools 服务不可用 → K1 闸门未装（降级，不阻塞启动）')
    return undefined
  }
  try {
    return tools.guard((exec) => {
      if (exec?.name !== BLOCKING_QUESTION_TOOL) return undefined
      if (!isBotSession(exec?.agent)) return undefined
      return `Bot 会话不能使用 ${BLOCKING_QUESTION_TOOL}（会堵住整条多智能体投递链）。请在回复里直接提问。`
    })
  } catch (error) {
    warn('[cs-bots] 装 K1 闸门失败：%s', error?.message ?? error)
    return undefined
  }
}

/**
 * 判定一个 agent 是否属于本平台的 Bot。
 *
 * P1 阶段尚无 RosterService ⇒ **保守返回 false**（不禁用任何会话的工具），
 * 以免误伤人类会话与官方 teammate。RosterService（P5）落地后改为查注册表。
 *
 * @param {unknown} agent
 * @returns {boolean}
 */
function isBotSession(agent) {
  // TODO(P5): 接入 RosterService 后按 sessionId 查表。
  void agent
  return false
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
    warn?.('[cs-bots] 移除 Bot 的 %s 失败：%s', BLOCKING_QUESTION_TOOL, error?.message ?? error)
  }
}
