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
import { service, stateDir as kernelStateDir, onLlmStream, sessionMeta, readSessionWatermark as kernelWatermark, capabilities } from './kernel.js'
import { installLlmStreamHint } from './routing/hints.js'
import { installApi } from './api.js'
import { createDeliveryWatch, DEFAULT_GRACE_MS, DEFAULT_TICK_MS } from './delivery-watch.js'
import { createLibrary } from './library.js'
import { createDiscipline } from './discipline.js'
import { createTodo } from './todo.js'
import { createScratch } from './scratch.js'
import { createPrompts } from './prompts.js'
import { createSuggest } from './suggest.js'
import { createReviewer } from './reviewer.js'
import { createMetrics } from './metrics.js'
import { createVerify } from './verify.js'
import { createCycle } from './cycle.js'
import { createTeams } from './teams.js'
import { createSubscription } from './subscription.js'
import { createDirBrowser } from './dirbrowse.js'
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
    // ⚠️ 2026-11-05（P0）：createBoard 必须拿到 settings —— wipLimitPerBot（WIP 上限）
    //   与 requireTriageForReady（Ready 闸门）都从 config.settings 读。只传 stateDir 会让
    //   平台设置对任务板静默失效（永远退回代码内默认值），且用户改了设置看不到任何变化。
    services.board = createBoard(ctx, {
      stateDir: config.stateDir,
      leaseMs: settings.defaultLeaseMs,
      settings,
      // 指标旁路（bots04 欠账2）：传**取值函数**而不是实例 ——
      // metrics 在 L276 才装配，此刻还是 undefined。传函数可规避装配顺序耦合。
      metrics: () => services.metrics,
    })
    log(`[cs-bots] BoardService 就绪（stateDir=${services.board.paths?.stateDir ?? '?'}）`)

    // ── 宿主能力自检（t-40 · 插件安装场景）──────────────────────────────
    // 别人把 cs-bots 当插件装上去时，宿主不一定装配了全部能力。
    // 缺 session-persistence ⇒ 任务对话/去对话静默失效；缺 agentTeams ⇒ 原生团队绑定不可用。
    // 这类降级**必须在启动时就喊出来**，否则用户只会看到"功能没反应"而查不到原因。
    try {
      const cap = capabilities(ctx)
      if (cap.missing?.length) {
        warn(`[cs-bots] 宿主能力缺失：${cap.missing.join(', ')} —— 相关功能会降级，详见 GET /status 的 host 字段`)
        if (!cap.sessionPersistence) {
          warn('[cs-bots] 缺少 sessionPersistence ⇒ 任务对话/会话读取不可用。'
            + '安装并启用 @deepseek-ai/dsh-session-persistence-jsonl 即可恢复。')
        }
      } else {
        log('[cs-bots] 宿主能力齐备（agents/agentTeams/webServer/sandboxPolicy/sessionPersistence）')
      }
    } catch (error) {
      warn(`[cs-bots] 宿主能力自检失败（不影响装配）：${error?.message ?? error}`)
    }
    // ⚠️ 修复（2026-11-04 测试，P1-4）：expireLeases 之前无任何调用者，
    //   owner 崩溃/失联后任务永久停在 in_progress（连"重启时回收"都不做）。
    //   现在启动时先回收一次过期租约（失败不阻塞装配）。
    try {
      const recycled = services.board.expireLeases()
      if (recycled.length > 0) log(`[cs-bots] 启动回收过期租约：${recycled.join(', ')}`)
    } catch (error) {
      warn(`[cs-bots] 启动回收过期租约失败（不影响装配）：${error?.message ?? error}`)
    }
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
    services.memory = createMemory(ctx, {
      stateDir: config.stateDir,
      entryMax: settings.memoryEntryMax,
      splitOnOverflow: settings.memorySplitOnOverflow,
      progressiveDisclosure: settings.keyProgressiveDisclosure,
      fullInjectThreshold: settings.keyFullInjectThreshold,
      fullInjectCharLimit: settings.keyFullInjectCharLimit,
      entryDatePrefix: settings.entryDatePrefix,
      perTurnWrites: settings.perTurnWrites,
    })
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
  // ── 目录浏览（自建，弥补原生选择器在 Linux/沙箱里不可用）────────────────
  try {
    services.dirbrowse = createDirBrowser({
      stateDir: config.stateDir ?? kernelStateDir(),
      dshHome: process.env.DSH_HOME,
    })
    log('[cs-bots] dirbrowse 就绪')
  } catch (error) {
    warn(`[cs-bots] dirbrowse 装配失败（目录浏览不可用）：${error?.message ?? error}`)
  }

  // ── 技能库 / 工作流库（全局可复用资产，Bot 与任务可关联）──────────────
  try {
    services.library = createLibrary(ctx, {
      stateDir: config.stateDir ?? kernelStateDir(),
      skillMaxBytes: settings.skillMaxBytes,
      skillReviewEnabled: settings.skillReviewEnabled,
    })
    log('[cs-bots] library 就绪')
  } catch (error) {
    warn(`[cs-bots] library 装配失败（技能库/工作流库不可用）：${error?.message ?? error}`)
  }

  // ── 分级纪律体系（全局/工作区/房间/Bot 四级，注入到各层级上下文）──────────
  try {
    services.discipline = createDiscipline(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log(`[cs-bots] discipline 就绪（${services.discipline.stats().total} 条纪律）`)
  } catch (error) {
    warn(`[cs-bots] discipline 装配失败（分级纪律不可用）：${error?.message ?? error}`)
  }

  // ── 四轨待办（生活/工作/项目/每日 + 四象限 + 逾期）─────────────────────────
  try {
    services.todo = createTodo(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log(`[cs-bots] todo 就绪（${services.todo.stats?.().total ?? 0} 条待办）`)
  } catch (error) {
    warn(`[cs-bots] todo 装配失败（待办不可用）：${error?.message ?? error}`)
  }

  // ── 便签（单文件随手记，原子写）────────────────────────────────────────────
  try {
    services.scratch = createScratch(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log('[cs-bots] scratch 就绪')
  } catch (error) {
    warn(`[cs-bots] scratch 装配失败（便签不可用）：${error?.message ?? error}`)
  }

  // ── 提示词库 + 注入轨 ──────────────────────────────────────────────────────
  try {
    services.prompts = createPrompts(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log(`[cs-bots] prompts 就绪（${services.prompts.stats?.().total ?? 0} 条提示词）`)
  } catch (error) {
    warn(`[cs-bots] prompts 装配失败（提示词库不可用）：${error?.message ?? error}`)
  }

  // ── 建议确认队列（模型只能提议，人点采纳才落库）───────────────────────────
  try {
    services.suggest = createSuggest(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log('[cs-bots] suggest 就绪')
  } catch (error) {
    warn(`[cs-bots] suggest 装配失败（建议队列不可用）：${error?.message ?? error}`)
  }

  // ── 自审调度（每 N 回合提醒模型做一次记忆自检）─────────────────────────────
  try {
    services.reviewer = createReviewer(ctx, {
      stateDir: config.stateDir ?? kernelStateDir(),
      memory: services.memory,
      suggest: services.suggest,
      interval: settings.reviewInterval,
      enabled: settings.reviewEnabled,
      mode: settings.reviewMode,
      writeGuard: settings.perTurnWriteGuard,
      writeGuardThreshold: settings.writeGuardThreshold,
    })
    log(`[cs-bots] reviewer 就绪（每 ${services.reviewer.status?.().interval ?? '?'} 回合）`)
  } catch (error) {
    warn(`[cs-bots] reviewer 装配失败（自审调度不可用）：${error?.message ?? error}`)
  }

  // ── 测量（PDCA 的 Check 数据面）────────────────────────────────────────────
  try {
    services.metrics = createMetrics(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log('[cs-bots] metrics 就绪（PDCA 测量面）')
  } catch (error) {
    warn(`[cs-bots] metrics 装配失败（测量不可用）：${error?.message ?? error}`)
  }

  // ── 验收证据（PDCA 的 Check 证据自动化）─────────────────────────────────────
  try {
    services.verify = createVerify(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log('[cs-bots] verify 就绪（验收证据自动化）')
  } catch (error) {
    warn(`[cs-bots] verify 装配失败（验收证据不可用）：${error?.message ?? error}`)
  }

  // ── 复盘与标准化（PDCA 的 Act）──────────────────────────────────────────────
  // suggest 缺失也能装配（review() 会降级为「只记复盘内容」）。
  try {
    services.cycle = createCycle(ctx, {
      stateDir: config.stateDir ?? kernelStateDir(),
      suggest: services.suggest,
    })
    log('[cs-bots] cycle 就绪（复盘与标准化）')
  } catch (error) {
    warn(`[cs-bots] cycle 装配失败（复盘不可用）：${error?.message ?? error}`)
  }

  // ── 大/小团队（Lead 聚合管理）───────────────────────────────────────────────
  try {
    services.teams = createTeams(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log(`[cs-bots] teams 就绪（${services.teams.stats().total} 个团队）`)
  } catch (error) {
    warn(`[cs-bots] teams 装配失败（团队不可用）：${error?.message ?? error}`)
  }

  // ── 任务订阅（改造07 · 借鉴 Super-agent Subscription 扇出）──────────────────
  // 让房间讨论的后续消息自动到达相关任务，不需要再 @ Bot。
  try {
    services.subscription = createSubscription(ctx, { stateDir: config.stateDir ?? kernelStateDir() })
    log(`[cs-bots] subscription 就绪（${services.subscription.stats().active} 条活订阅）`)
  } catch (error) {
    warn(`[cs-bots] subscription 装配失败（房间→任务扇出不可用）：${error?.message ?? error}`)
  }

  // ── 投递回执看护（2026-11-09 · 补 superagent 的 inputsRead 那一层）─────────────
  // 「投递成功」不等于「真的在跑」：现场出现过 wake 记 sent、会话 turns/steps 全 0、
  // 任务卡在「进行中」且页面无异常。看护在投递后盯事件水位，超时没涨就把
  // 「已投递但执行者未开始动作」写进 task.delivery.error，让它以 person/delivery 显形。
  try {
    const graceMs = Number(process?.env?.CS_BOTS_DELIVERY_GRACE_MS) || DEFAULT_GRACE_MS
    services.deliveryWatch = createDeliveryWatch(ctx, {
      logger: { info: log, warn },
      watermark: (sessionId) => kernelWatermark(ctx, sessionId),
      markFailure: async (taskId, reason) => {
        const board = services.board
        if (!board) return false
        const current = board.get(taskId)
        if (!current || current.status === 'deleted' || current.status === 'completed') return false
        try {
          // ⚠️ **合并写入**（2026-11-09）：`board.set` 对 `delivery` 是整体替换，
          // 直接写 `{ error, at, by }` 会抹掉这个字段上已有的其它键
          // （比如 api.js 记下的 `clearedAt`/`clearedBy`）。先读再展开。
          const prev = (current.delivery && typeof current.delivery === 'object') ? current.delivery : {}
          await board.update({
            id: taskId,
            expectedRev: current.rev,
            action: 'set',
            byId: 'cs-bots.watchdog',
            delivery: { ...prev, error: reason, at: Date.now(), by: 'cs-bots.watchdog' },
          })
          return true
        } catch {
          return false
        }
      },
      options: {
        graceMs,
        tickMs: Number(process?.env?.CS_BOTS_DELIVERY_TICK_MS) || DEFAULT_TICK_MS,
      },
    })
    log(`[cs-bots] 投递回执看护就绪（宽限 ${Math.round(graceMs / 1000)}s）`)
  } catch (error) {
    warn(`[cs-bots] 投递回执看护装配失败（投递仍可用，只是不追踪回执）：${error?.message ?? error}`)
    services.deliveryWatch = undefined
  }

  // ── 页面数据面：HTTP API（页面层靠它拿数据；没有它 UI 是空壳）──────────────
  services.apiDispose = installApi(ctx, { warn })

  const toolNames = installTools(ctx, { warn })
  if (toolNames.length === 0) {
    warn('[cs-bots] 未注册任何工具（tools 服务不可用？）→ 模型将看不到平台能力')
  } else {
    log(`[cs-bots] 已注册 ${toolNames.length} 个工具：${toolNames.join(', ')}`)
  }

  // ── 复杂度路由：llm/stream 拦截 → cs-myfree 旁路 hint 注册表 ────────────────
  // 契约 §6。三条纪律都落在这里：
  //   ① 钩子**总是尝试注册**（cs-myfree 后装载也能立刻生效）；
  //   ② 没装 cs-myfree 只是 `installed:false`，不进日志噪音、更不影响对话；
  //   ③ 任何异常都只 warn —— 路由优化不值得拿可用性换。
  try {
    const routing = installLlmStreamHint(ctx, { onLlmStream }, {
      warn,
      // 每次请求按会话动态解析角色（闭包读 services.roster，不缓存结果）：
      //   注册表里的 Bot 会话 ⇒ subagent（free_only）；其余 ⇒ main（paid_allowed）；
      //   roster 不可用/查询抛错 ⇒ unknown（fail-closed，仍 free_only）。
      roleOf: (sessionId) => roleOfSession(services.roster, sessionId, sessionMeta(ctx, sessionId)),
    })
    services.routing = routing
    if (routing.installed) {
      log('[cs-bots] 复杂度路由 hint 注入已就绪（llm/stream → cs-myfree 注册表）')
    } else if (routing.reason === 'cs-myfree-registry-missing') {
      // 正常情形：本插件可能先于 cs-myfree 装载。注册表在**每次请求时**重新解析，
      // 所以 cs-myfree 后装载也能立刻生效 —— 这里只记 info，不当降级故障报。
      log('[cs-bots] 未发现 cs-myfree 路由注册表（稍后装载亦可生效）→ 暂不注入 hint，cs-myfree 默认 free_only')
    } else {
      warn(
        `[cs-bots] 复杂度路由 hint 未就绪（${routing.reason}）→ 降级：不注入 hint，`
        + 'cs-myfree 按默认 free_only 走（fail-closed，不影响对话）',
      )
    }
  } catch (error) {
    services.routing = { installed: false, reason: 'assembly-failed' }
    warn(`[cs-bots] 复杂度路由装配失败（降级，不影响对话）：${error?.message ?? error}`)
  }

  // ── PDCA-1：回合钩子（让自审计数真正被推进）─────────────────────────────────
  installTurnHook(ctx, {
    warn,
    reviewer: services.reviewer,
    metrics: services.metrics,
    suggest: services.suggest,
  })

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
 * 按会话判定复杂度路由角色（契约 §6 + P3-fix/P3-fix2）。
 *
 * 判定顺序（**先严后宽**，任何一步拿不到证据都停在 `'unknown'` ⇒ free_only）：
 *   a. `roster.hasSession(sessionId)` 命中（含退役 Bot）⇒ `'subagent'`；
 *   b. 宿主 session 谱系显示是子代理（`origin === 'subagent'` 或 `parentSession` 非空
 *      或 `delegationDepth > 0`）⇒ `'subagent'`
 *      —— **这一条堵的是官方 `spawn_teammate` 子会话的付费泄漏**（它们不在 roster 里）；
 *   c. 两条查询都拿不到信息（roster 不可用/抛错，或 `sessionMeta` 为 null：无 sessions
 *      服务、无此会话、查询抛错）⇒ `'unknown'`（fail-closed，保持 free_only）；
 *   d. 能确认是顶层会话（roster 明确「不是 Bot」且宿主给得出 header 但无谱系字段）
 *      ⇒ `'main'`（人类主对话 ⇒ 平台层注入 paid_allowed）。
 *
 * 为什么 c 这么严：宁可让主对话少拿一次付费授权，也不能让某个子智能体白拿 ——
 * 两者的代价不对称（前者只是慢/弱，后者是持续花错钱）。
 *
 * @param {{ hasSession?: Function, list?: Function, listRetired?: Function } | undefined} roster
 * @param {string} sessionId
 * @param {{ origin?: string, parentSession?: string, delegationDepth?: number,
 *           agentPreset?: string } | null} [meta] `kernel.sessionMeta()` 的结果
 * @returns {'main'|'subagent'|'unknown'}
 */
export function roleOfSession(roster, sessionId, meta) {
  if (typeof sessionId !== 'string' || sessionId === '') return 'unknown'

  // ── a. 注册表：这是本平台的 Bot ⇒ 子智能体 ──
  const fromRoster = rosterHasSession(roster, sessionId)
  if (fromRoster === true) return 'subagent'
  // roster 不可用 ⇒ 无法确认身份 ⇒ 停在这里（即使下面有谱系也不升级为主对话）
  if (fromRoster === null) return 'unknown'

  // ── b. 宿主谱系：官方子代理 / 任意带父会话的会话 ⇒ 子智能体 ──
  if (meta === null || meta === undefined) return 'unknown'
  if (typeof meta !== 'object') return 'unknown'
  const isSubagent = meta.origin === 'subagent'
    || (typeof meta.parentSession === 'string' && meta.parentSession !== '')
    || (typeof meta.delegationDepth === 'number' && Number.isFinite(meta.delegationDepth) && meta.delegationDepth > 0)
  if (isSubagent) return 'subagent'

  // ── d. 确认是顶层会话 ⇒ 主对话 ──
  return 'main'
}

/**
 * 查 roster 判定某会话是否 Bot。
 * @returns {true|false|null} `null` = 查询不可用（无 roster / 无查询能力 / 抛错）
 */
function rosterHasSession(roster, sessionId) {
  if (!roster) return null
  try {
    if (typeof roster.hasSession === 'function') return roster.hasSession(sessionId) === true
    // 老版本 roster（无 hasSession）：退化为扫一遍名录，不因此把 Bot 误判成主对话
    const list = typeof roster.list === 'function' ? roster.list() : undefined
    if (!Array.isArray(list)) return null
    const retired = typeof roster.listRetired === 'function' ? roster.listRetired() : []
    const rows = [...list, ...(Array.isArray(retired) ? retired : [])]
    return rows.some((b) => b?.sessionId === sessionId)
  } catch {
    return null
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

/**
 * PDCA-1：回合钩子 —— 让 reviewer 的「每 N 回合自审」真正被触发。
 *
 * 为什么必须自己接：宿主把回合边界写成 session 事件（`turn/start` / `turn/end`），
 * 但**没有**任何机制会自动调用本平台的 reviewer。此前 reviewer 只暴露
 * HTTP 端点（`/review/note-turn`），客户端从不调用 ⇒ 计数恒为 0 ⇒ 自审永不到期。
 * 这等于把 PDCA 的 Check 引擎写死了。
 *
 * 本钩子的三条纪律（与 dispatcher 的 fail-open 同源）：
 *   ① **绝不抛**：钩子内部任何异常只 warn，绝不影响回合本身；
 *   ② **多路兜底**：优先按 session 事件判断回合边界；拿不到就退化为「每次
 *      `agent/turn-stopping` 也算一回合」（后者是宿主在回合收尾时发的）；
 *   ③ **每会话每回合最多记一次**：防事件重投导致计数虚高。
 */
function installTurnHook(ctx, { warn, reviewer, metrics, suggest }) {
  if (typeof ctx.on !== 'function') {
    warn('[cs-bots] ctx.on 不可用 → PDCA 回合钩子未装（自审计数将不自动推进）')
    return
  }
  if (!reviewer) {
    warn('[cs-bots] 无 ReviewerService → PDCA 回合钩子未装')
    return
  }

  /** sessionId → 最近一次计数的标记（防重复计数） */
  const lastCounted = new Map()

  /** 从钩子 payload 里取会话 id（多路兜底：可能是字符串或 Session/agent 对象）。 */
  function sessionIdOf(subject) {
    if (typeof subject === 'string' && subject.trim() !== '') return subject
    if (subject && typeof subject === 'object') {
      const id = subject.id ?? subject.sessionId ?? subject.session?.id
      if (typeof id === 'string' && id.trim() !== '') return id
    }
    return null
  }

  /** 到期时提一条「自审提醒」记忆建议（L2 全局，无需 scopeId ⇒ 任何场景都合法）。 */
  function proposeSelfReview(sessionId, out) {
    try {
      suggest?.suggest?.({
        kind: 'memory',
        layer: 'L2',
        payload: {
          content: `【自审提醒】本会话已累计 ${out.turnsSinceLastReview} 回合未自审（阈值 ${out.interval}）。下一次回复前请先自检：目标是否漂移？有无未兑现的承诺？有无过期/阻塞的待办或任务？必要时用 bot_memory_search 检索近期上下文。`,
          tags: ['self-review', 'pdca'],
        },
        reason: `reviewer：会话 ${sessionId} 已 ${out.turnsSinceLastReview} 回合未自审（阈值 ${out.interval}）`,
        source: 'reviewer',
        by: sessionId,
        confidence: 0.8,
      })
    } catch (e) {
      warn(`[cs-bots] PDCA 自审建议提议失败（session=${sessionId}）：${e?.message ?? e}`)
    }
  }

  try {
    // ── 主通道：session 事件（宿主在回合开始/结束时写入 turn/start / turn/end）──
    ctx.on('session/event', (subject, event) => {
      try {
        if (!event || typeof event.type !== 'string') return
        if (event.type !== 'turn/end' && event.type !== 'turn/start') return
        const sessionId = sessionIdOf(subject)
        if (!sessionId) return

        // 用回合序号做幂等：同 session 同一 turn 序号只计一次
        const turn = Number.isFinite(event.data?.turn) ? event.data.turn : null
        const key = turn !== null ? `${sessionId}:t${turn}` : null
        if (key && lastCounted.get(sessionId) === key) return
        if (key) lastCounted.set(sessionId, key)

        const out = reviewer.noteTurn({ sessionId })
        if (out.due) proposeSelfReview(sessionId, out)
        try { metrics?.record?.({ kind: 'turn_end', sessionId, by: sessionId }) } catch { /* 测量失败不影响回合 */ }
      } catch (error) {
        warn(`[cs-bots] PDCA 回合钩子处理失败：${error?.message ?? error}`)
      }
    })

    // ── 兜底通道：agent 回合收尾（session 事件拿不到时仍有一次计数机会）──
    // ⚠️ 只在主通道没记过该会话时才计（用 lastCounted 防双计）。
    ctx.on('agent/turn-stopping', (payload) => {
      try {
        const sessionId = sessionIdOf(payload?.session ?? payload?.agent ?? payload)
        if (!sessionId || lastCounted.has(sessionId)) return
        lastCounted.set(sessionId, 'fallback')
        const out = reviewer.noteTurn({ sessionId })
        if (out.due) proposeSelfReview(sessionId, out)
        try { metrics?.record?.({ kind: 'turn_end', sessionId, by: sessionId }) } catch { /* */ }
      } catch (error) {
        warn(`[cs-bots] PDCA 回合兜底钩子处理失败：${error?.message ?? error}`)
      }
    })
  } catch (error) {
    warn(`[cs-bots] 注册 PDCA 回合钩子失败：${error?.message ?? error}`)
  }
}

