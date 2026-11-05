/**
 * cs-bots 复杂度路由 hint 注入 —— **唯一的宿主触点在 `../kernel.js`（`onLlmStream`）**。
 *
 * 契约：`design/17-并发感知路由层-接口契约-v1.md` §3（hint 形状）+ §6（注入点）。
 *
 * ── 为什么必须走旁路注册表（不要试图改 options）────────────────────────────────
 * 宿主 `dsh-agent-loop` 在 dispatch 前把请求对象 `Object.freeze(...)` 后交给 adapter，
 * 再经 `ctx.waterfall(this, 'llm/stream', options, ...)` 瀑布（证据：
 * `dsh-llm/lib/index.js:2397`，签名 `'llm/stream'(this, options: GenerateOptions,
 * next: () => AsyncIterable<StreamChunk>)`，官方插件用法见
 * `dsh-session-checkpoint-policy/lib/index.js:61`）。
 * ⇒ `options` **只读**。任何「给请求加个 metadata 字段」的做法在运行时都会失败，
 *   所以 hint 只能写进跨插件的旁路注册表：
 *     `globalThis[Symbol.for('cs-myfree.routing.hints.v1')] = { version, api }`
 *   由 cs-myfree 读取（`options.sessionId` → hint）。
 *
 * ── 三条硬纪律 ──────────────────────────────────────────────────────────────
 *   1. **fail-open**：`llm/stream` 的 handler **永远** `return next()`。本模块任何
 *      异常（注册表缺失、cs-myfree 内部抛错、hint 形状校验失败）都只记统计，
 *      绝不让一条对话请求失败 —— 路由优化不值得拿可用性换。
 *   2. **只碰自己那一格**：仅当 `options.provider === 'cs-myfree'` 时写 hint。
 *      官方 deepseek 渠道、其它 adapter 一律不写（写了也没人读，纯污染）。
 *   3. **迟到也能装**：注册表在**每次请求时**动态解析（而不是安装时缓存），
 *      因此 cs-myfree 比 cs-bots 晚装载也能生效；缺失时静默跳过。
 *
 * 本文件**不 import 任何宿主包**（`test/ci-zero-dep.sh` 检查 1 机械强制）。
 */

import {
  billingTierFor,
  classifyComplexity,
  normalizeRole,
  normalizeTier,
} from './complexity.js'

/** 跨插件唯一入口（与 cs-myfree 的 `adapter/routing-hints.js` 必须逐字一致）。 */
export const HINTS_SYMBOL = Symbol.for('cs-myfree.routing.hints.v1')
/** 本模块写入的 hint 版本（契约 §3 冻结为 1）。 */
export const HINTS_VERSION = 1
/** 请求级 hint 的来源标识（可审计：谁写的）。 */
export const SOURCE_LLM_STREAM = 'cs-bots/llm-stream'
/** 任务板 claim/wake 时写 hint 的来源标识。 */
export const SOURCE_TASK_BOARD = 'cs-bots/task-board'
/**
 * hint 有效期（ms）—— 与 cs-myfree 注册表默认 `ttlMs` 对齐（契约 §3：30 分钟）。
 * 用于 `mergeHint` 判定「任务授权是否还能延续」，避免一条旧的 paid_allowed 永久生效。
 */
export const HINT_TTL_MS = 30 * 60 * 1000

/** cs-myfree 的 provider 路由名（只有它读 hint）。 */
const MYFREE_PROVIDER = 'cs-myfree'
/** token 粗估：字符数 / 4（英文代码约 3.5–4 字符/token，中文约 1.5–2；取 4 保守）。 */
const CHARS_PER_TOKEN = 4

// ── 请求信号提取（纯函数）───────────────────────────────────────────────────

/** 单条消息的文本长度（兼容 string content / parts 数组 / 裸 text 字段）。 */
function messageChars(message) {
  if (!message || typeof message !== 'object') return 0
  let total = 0
  const { content, text } = message
  if (typeof content === 'string') total += content.length
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue
      if (typeof part === 'string') total += part.length
      else if (typeof part.text === 'string') total += part.text.length
      else if (typeof part.content === 'string') total += part.content.length
    }
  }
  if (typeof text === 'string') total += text.length
  return total
}

/** 粗估上下文 token 数（字符 / 4，向上取整）。 */
export function estimateContextTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  let chars = 0
  for (const m of messages) chars += messageChars(m)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** 请求是否带工具（工具声明 / 工具历史 / 历史里的工具调用与结果都算）。 */
export function detectToolUse(options = {}) {
  const { tools, toolHistory, messages } = options ?? {}
  if (Array.isArray(tools) && tools.length > 0) return true
  if (Array.isArray(toolHistory) && toolHistory.length > 0) return true
  if (toolHistory && typeof toolHistory === 'object' && !Array.isArray(toolHistory)) {
    if (Object.keys(toolHistory).length > 0) return true
  }
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      if (m.role === 'tool') return true
      const calls = m.toolCalls ?? m.tool_calls
      if (Array.isArray(calls) && calls.length > 0) return true
    }
  }
  return false
}

/**
 * 从宿主请求对象提取分类器需要的信号。
 *
 * ⚠️ 只读：`options` 在宿主里是冻结对象，这里**绝不写回**。
 *
 * @param {object} options 宿主 `llm/stream` 的 GenerateOptions（可含 provider/model/sessionId/messages/tools/signal）
 * @param {{ role?: string, requiresPaid?: boolean, explicitComplexity?: string,
 *           contextTokens?: number } } [extra] 平台侧已知信息（角色 / 任务标注 / 已测 token）
 * @returns {{ contextTokens: number, historyDepth: number, hasToolCalls: boolean,
 *             agentRole: string, explicitComplexity: string|null }}
 */
export function signalsFromRequest(options = {}, extra = {}) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const measured = typeof extra?.contextTokens === 'number' && Number.isFinite(extra.contextTokens)
    ? extra.contextTokens
    : undefined
  return {
    contextTokens: measured ?? estimateContextTokens(messages),
    historyDepth: messages.length,
    hasToolCalls: detectToolUse(options),
    agentRole: normalizeRole(extra?.role),
    explicitComplexity: normalizeTier(extra?.explicitComplexity),
  }
}

// ── hint 构造（纯函数，离线可测）──────────────────────────────────────────────

/**
 * 造一个契约 §3 形状的 hint（**恰好六个键**，不多不少）。
 *
 * @param {{ billing_tier: 'free_only'|'paid_allowed', complexity_tier: string|null,
 *           agent_role: 'main'|'subagent'|'unknown', requires_paid: boolean,
 *           source: string, at: number }} parts
 * @returns {object}
 */
function buildHint(parts) {
  return {
    billing_tier: parts.billing_tier,
    complexity_tier: parts.complexity_tier ?? null,
    agent_role: parts.agent_role,
    requires_paid: parts.requires_paid === true,
    source: String(parts.source),
    at: parts.at,
  }
}

/**
 * 判定一条既有 hint 是否为「任务级付费授权态」（`mergeHint` 用）。
 *
 * 两个来源都算：`SOURCE_TASK_BOARD`（claim/wake 首次授权）与 `SOURCE_LLM_STREAM`
 * （本 handler 合并后的续期形态）—— 只认前者会让授权在第二条请求就衰减（真 bug）。
 * 以 `requires_paid === true` 作为授权态的自描述标记（hint 形状 v1 冻结，不能加 `granted_at`）。
 *
 * @param {unknown} hint
 * @returns {boolean}
 */
function isTaskGrant(hint) {
  if (!hint || typeof hint !== 'object') return false
  if (hint.billing_tier !== 'paid_allowed') return false
  if (hint.requires_paid !== true) return false
  return hint.source === SOURCE_TASK_BOARD || hint.source === SOURCE_LLM_STREAM
}

/**
 * 合并「已存在的 hint」与「本次请求算出的 hint」—— **只升不降**（纯函数）。
 *
 * 这是 P3-fix 的核心（2026-11-04 缺陷）：`applyTaskHint` 在 claim/wake 时写入的
 * `paid_allowed` 是**任务级授权**，下一条 llm/stream 请求算出的 `free_only`（子智能体默认）
 * 不能把它踩掉；否则「requires_paid:true 的子任务获付费」永远失效。
 *
 * 规则（严格按此，不做别的推断）：
 *   1. `next.billing_tier === 'paid_allowed'` ⇒ 用 next（平台已判定本次就该付费）；
 *   2. 否则，若已存在一条**未过期**的「任务授权态」hint（`billing_tier === 'paid_allowed'`
 *      且 `requires_paid === true`，来源为 `SOURCE_TASK_BOARD` 或本模块）⇒ 保留 paid_allowed，
 *      但 `complexity_tier` / `at` / `source` 用 next 的（新鲜度），`requires_paid` 保持 true；
 *   3. 其余 ⇒ 用 next（即正常降回 free_only；任务授权过期/来源不可信时不做特殊处理）。
 *
 * ⚠️ 为什么授权态要认 `SOURCE_LLM_STREAM` 这一来源（P3-fix 第二轮，实测抓到）：
 *   合并结果由本 handler 写回，其 `source` 是 `'cs-bots/llm-stream'`。若只认
 *   `SOURCE_TASK_BOARD`，则**第二条请求**就会把授权判成「来源不成立」而降级
 *   —— 缺陷只是从「第一条」推迟到「第二条」，仍然失效。hint 形状 v1 冻结（六个键）
 *   不许多存一个 `granted_at`，故用 `requires_paid === true` 作为「授权态」的自描述标记。
 *   代价：只要该会话持续发请求，授权就持续有效；**静默 30 分钟（`HINT_TTL_MS`）后失效**
 *   （`at` 每次刷新 ⇒ 滚动 TTL，这是与 cs-myfree 注册表 TTL 对齐后的语义）。
 *
 * @param {object|null|undefined} existing 注册表里已有的 hint（可能为 null）
 * @param {object} next 本次请求算出的 hint
 * @param {{ now?: number, ttlMs?: number }} [opts]
 * @returns {object} 要写入的 hint（**恰好六个键**，与契约 §3 一致）
 */
export function mergeHint(existing, next, opts = {}) {
  if (!next || typeof next !== 'object') return next
  if (next.billing_tier === 'paid_allowed') return next
  if (!existing || typeof existing !== 'object') return next

  const isTaskAuth = isTaskGrant(existing)
  if (!isTaskAuth) return next

  const issuedAt = typeof existing.at === 'number' && Number.isFinite(existing.at) ? existing.at : null
  if (issuedAt === null) return next
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now)
    ? opts.now
    : (typeof next.at === 'number' && Number.isFinite(next.at) ? next.at : null)
  if (now === null) return next
  const ttl = typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
    ? opts.ttlMs
    : HINT_TTL_MS
  if (now - issuedAt >= ttl) return next

  return { ...next, billing_tier: 'paid_allowed', requires_paid: true }
}

/**
 * 由一次请求解析出应该写入的 hint（纯函数 —— 便于离线表驱动测试）。
 *
 * 返回 `null` 的全部情形（**都算正常**，不是错误）：
 *   - `options.provider !== 'cs-myfree'`：别的渠道不读 hint；
 *   - 没有 `sessionId`：注册表按 sessionId 建索引，无键可写。
 *
 * @param {object} options
 * @param {{ role?: string, requiresPaid?: boolean, explicitComplexity?: string,
 *           source?: string, now?: number, contextTokens?: number }} [deps]
 * @returns {object|null} hint
 */
export function resolveHint(options, deps = {}) {
  if (!options || typeof options !== 'object') return null
  if (options.provider !== MYFREE_PROVIDER) return null
  const sessionId = options.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null

  const role = normalizeRole(deps?.role)
  const requiresPaid = deps?.requiresPaid === true
  const explicitComplexity = normalizeTier(deps?.explicitComplexity)
  const signals = signalsFromRequest(options, { role, explicitComplexity, contextTokens: deps?.contextTokens })
  const classified = classifyComplexity(signals)
  const at = typeof deps?.now === 'number' && Number.isFinite(deps.now) ? deps.now : Date.now()

  return buildHint({
    billing_tier: billingTierFor({ tier: classified.tier, role, requiresPaid }),
    complexity_tier: classified.tier,
    agent_role: role,
    requires_paid: requiresPaid,
    source: deps?.source ?? SOURCE_LLM_STREAM,
    at,
  })
}

// ── 注册表发现 ──────────────────────────────────────────────────────────────

/**
 * 读 cs-myfree 的旁路注册表。
 *
 * **未安装 ⇒ 返回 null ⇒ 调用方静默跳过**（这是契约要求的降级路径，不是错误）。
 * 逐个字段防御式取值：`api.setRequestHint` 不是函数就当作未安装，
 * 免得 cs-myfree 改版后 cs-bots 直接把请求搞挂。
 *
 * @param {object} [scope] 便于测试替换（默认 globalThis）
 * @returns {{ version: number|string|null, api: { setRequestHint: Function,
 *             getRequestHint?: Function, clearRequestHint?: Function } } | null}
 */
export function getGlobalHintsRegistry(scope = globalThis) {
  try {
    const entry = scope?.[HINTS_SYMBOL]
    if (!entry || typeof entry !== 'object') return null
    const api = entry.api
    if (!api || typeof api.setRequestHint !== 'function') return null
    return { version: entry.version ?? null, api }
  } catch {
    // Symbol 访问本身被代理陷阱拒绝时也不能炸
    return null
  }
}

// ── 注入安装 ────────────────────────────────────────────────────────────────

/**
 * 装 `llm/stream` 拦截：**每条请求前**把复杂度 hint 写进 cs-myfree 的旁路注册表。
 *
 * 返回语义（契约 §6 + Lead 的 DoD 口径）：
 *   - `hooked`    —— `llm/stream` 拦截是否已注册成功（kernel 窄接口是否可用）
 *   - `installed` —— `hooked && 当前能解析到 cs-myfree 注册表`
 *     ⇒ cs-myfree 未安装时是 `{ installed:false, reason:'cs-myfree-registry-missing' }`，
 *        **但 handler 仍然会被调用并 `return next()`**（请求照常进行，只是不写 hint）。
 *        「先装钩子、运行时再发现注册表」是刻意的：cs-myfree 后装载也能立刻生效。
 *   - `handler` / `stats` —— 便于离线测试与诊断（不对外暴露给模型）。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ onLlmStream?: Function }} kernel `../kernel.js` 的窄接口集合
 * @param {{ warn?: Function, role?: string, requiresPaid?: boolean,
 *           explicitComplexity?: string, source?: string, now?: Function,
 *           getRegistry?: Function,
 *           roleOf?: (sessionId: string) => 'main'|'subagent'|'unknown',
 *           hintTtlMs?: number }} [opts]
 *   `roleOf` —— **每次请求按 sessionId 动态解析角色**（P3-fix）：主对话 ⇒ `main`（⇒ paid_allowed），
 *               注册表里的 Bot 会话 ⇒ `subagent`（⇒ free_only）。抛错/缺省 ⇒ `unknown`（fail-closed）。
 *   `hintTtlMs` —— 任务级授权 hint 的延续上限（缺省 30 分钟，见 `HINT_TTL_MS`）。
 * @returns {{ installed: boolean, hooked: boolean, reason?: string,
 *             handler: Function, stats: object }}
 */
export function installLlmStreamHint(ctx, kernel, opts = {}) {
  const warn = typeof opts?.warn === 'function' ? opts.warn : () => {}
  const now = typeof opts?.now === 'function' ? opts.now : () => Date.now()
  const getRegistry = typeof opts?.getRegistry === 'function' ? opts.getRegistry : getGlobalHintsRegistry
  const source = opts?.source ?? SOURCE_LLM_STREAM

  /** 运行期统计（诊断用：为什么这条请求没拿到 hint）。 */
  const stats = {
    calls: 0,
    injected: 0,
    skippedProvider: 0,
    skippedNoSession: 0,
    skippedNoRegistry: 0,
    errors: 0,
    /** `opts.roleOf` 抛错的次数（每次都会降级为 unknown ⇒ free_only）。 */
    roleOfErrors: 0,
    /** 注册表不提供 `getRequestHint` 的次数（无法读旧 hint ⇒ 按无 existing 处理）。 */
    existingUnavailable: 0,
    /** 读旧 hint 抛错的次数（fail-open：照常写 next）。 */
    existingReadErrors: 0,
    /** 本次 next 只是 free_only、但因任务授权而保留 paid_allowed 的次数（P3-fix 的关键指标）。 */
    carriedTaskAuth: 0,
  }

  /**
   * 解析**这条请求**的角色（每次请求都重新算，不缓存 —— session 的角色可能变，
   * 缓存会让「Bot 会话先按 main 拿到付费」这种错误永久化）。
   *
   * `opts.roleOf` 未提供时退回安装时静态 `opts.role`（向后兼容）；
   * 抛错/返回垃圾值 ⇒ `'unknown'`（⇒ free_only，fail-closed）。
   */
  function resolveRequestRole(sessionId) {
    const roleOf = opts?.roleOf
    if (typeof roleOf !== 'function') return normalizeRole(opts?.role)
    try {
      return normalizeRole(roleOf(sessionId))
    } catch (error) {
      stats.roleOfErrors += 1
      try {
        warn(`[cs-bots] roleOf 解析失败（按 unknown ⇒ free_only 处理）：${error?.message ?? error}`)
      } catch {
        /* 静默 */
      }
      return 'unknown'
    }
  }

  /** 读注册表里已存在的 hint；无该方法/读失败一律返回 null（fail-open，不拦请求）。 */
  function readExistingHint(registry, sessionId) {
    const getter = registry?.api?.getRequestHint
    if (typeof getter !== 'function') {
      stats.existingUnavailable += 1
      return null
    }
    try {
      return getter(sessionId) ?? null
    } catch {
      stats.existingReadErrors += 1
      return null
    }
  }

  /**
   * 核心 handler —— **永远**返回 `next()`。
   * 刻意写成同步函数：`llm/stream` 的 `next()` 返回 `AsyncIterable<StreamChunk>`，
   * 包成 async 会把它变成 Promise<AsyncIterable>，与瀑布签名不符。
   */
  function handler(options, next) {
    stats.calls += 1
    try {
      if (options?.provider !== MYFREE_PROVIDER) {
        stats.skippedProvider += 1
      } else if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
        stats.skippedNoSession += 1
      } else {
        const registry = getRegistry()
        if (!registry) {
          stats.skippedNoRegistry += 1
        } else {
          const sessionId = options.sessionId
          const hint = resolveHint(options, {
            role: resolveRequestRole(sessionId),
            requiresPaid: opts?.requiresPaid,
            explicitComplexity: opts?.explicitComplexity,
            source,
            now: now(),
          })
          if (hint) {
            // ⚠️ P3-fix：写入前先与已有 hint 合并（**只升不降**），否则 claim 写的
            //   paid_allowed 会被下一条请求踩成 free_only，「requires_paid 子任务获付费」失效。
            const existing = readExistingHint(registry, sessionId)
            const effective = mergeHint(existing, hint, { now: hint.at, ttlMs: opts?.hintTtlMs })
            if (
              effective?.billing_tier === 'paid_allowed'
              && hint.billing_tier !== 'paid_allowed'
            ) {
              stats.carriedTaskAuth += 1
            }
            registry.api.setRequestHint(sessionId, effective)
            stats.injected += 1
          } else {
            stats.skippedProvider += 1
          }
        }
      }
    } catch (error) {
      stats.errors += 1
      // fail-open：写 hint 失败绝不影响请求
      try {
        warn(`[cs-bots] 写复杂度路由 hint 失败（已忽略，请求照常）：${error?.message ?? error}`)
      } catch {
        /* 连日志都失败 → 完全静默 */
      }
    }
    return typeof next === 'function' ? next() : undefined
  }

  let hooked = false
  try {
    hooked = typeof kernel?.onLlmStream === 'function' ? kernel.onLlmStream(ctx, handler) === true : false
  } catch (error) {
    hooked = false
    try {
      warn(`[cs-bots] 注册 llm/stream 拦截失败（降级：不注入 hint）：${error?.message ?? error}`)
    } catch {
      /* 静默 */
    }
  }

  if (!hooked) {
    return { installed: false, hooked: false, reason: 'llm-stream-hook-unavailable', handler, stats }
  }

  let registry = null
  try {
    registry = getRegistry()
  } catch {
    registry = null
  }
  if (!registry) {
    return { installed: false, hooked: true, reason: 'cs-myfree-registry-missing', handler, stats }
  }
  return { installed: true, hooked: true, registryVersion: registry.version, handler, stats }
}

// ── 任务板 → 会话 hint ──────────────────────────────────────────────────────

/**
 * 用**任务字段**给 owner 会话写 hint（claim / wake 时调用）。
 *
 * 契约 §6 末段：「子任务被 claim/wake 时，平台用该任务字段给 owner 会话写 hint
 * （`requiresPaid` ⇒ paid_allowed）」。所以：
 *   - `task.expectedComplexity`（T0–T3）→ `complexity_tier`
 *   - `task.requiresPaid === true` → `billing_tier = paid_allowed`，否则 `free_only`
 *   - owner 默认按 `subagent` 记账（窄执行者），可用 `opts.role` 覆盖（如主 Agent 自领）
 *
 * 无 cs-myfree 注册表 ⇒ `{ ok:false, reason:'cs-myfree-registry-missing' }`（静默跳过，
 * **不抛**：hint 只是优化，任务板照样要能干活）。`setRequestHint` 抛错也一并吞掉并回报原因。
 *
 * @param {object} task BoardService 的 Task
 * @param {string} sessionId 目标会话（claim 时的 owner / wake 时的 target）
 * @param {{ role?: string, source?: string, now?: number, getRegistry?: Function }} [opts]
 * @returns {{ ok: boolean, hint?: object, reason?: string }}
 */
export function applyTaskHint(task, sessionId, opts = {}) {
  try {
    if (!task || typeof task !== 'object') return { ok: false, reason: 'no-task' }
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, reason: 'no-session' }
    const getRegistry = typeof opts?.getRegistry === 'function' ? opts.getRegistry : getGlobalHintsRegistry
    const registry = getRegistry()
    if (!registry) return { ok: false, reason: 'cs-myfree-registry-missing' }

    const tier = normalizeTier(task.expectedComplexity)
    const requiresPaid = task.requiresPaid === true
    const role = normalizeRole(opts?.role ?? 'subagent')
    const at = typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
    const hint = buildHint({
      billing_tier: billingTierFor({ tier: tier ?? undefined, role, requiresPaid }),
      complexity_tier: tier,
      agent_role: role,
      requires_paid: requiresPaid,
      source: opts?.source ?? SOURCE_TASK_BOARD,
      at,
    })
    registry.api.setRequestHint(sessionId, hint)
    return { ok: true, hint }
  } catch (error) {
    return { ok: false, reason: `hint-write-failed:${error?.message ?? error}` }
  }
}

export default installLlmStreamHint
