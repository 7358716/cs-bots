/**
 * cs-bots /compat —— 宿主兼容性探测（**防止插件把 DSH 启动搞崩**）。
 *
 * 为什么必须有这一段（来自真实教训）：
 *   宿主插件在 `apply()` 里抛错 → **DSH 启动失败** → 用户必须「禁用插件才能打开」。
 *   我们已在 rc.2 上踩到两个同类 bug（ctx 禁止任意属性赋值 / 未 inject 就取服务）。
 *   rc1 与 rc5 的 API 面与 rc.2 **不完全相同**，所以必须在**运行时探测**，
 *   而不是假定宿主有某个能力。
 *
 * 三条纪律：
 *   1. **探测本身绝不抛**：任何一次探测失败都只是把该能力记为 "missing"。
 *   2. **报告可见**：探测结果写日志，并暴露给 /status（用户能自助诊断）。
 *   3. **不阻断**：缺能力 → 对应功能降级，**不影响其它功能，更不影响 DSH 启动**。
 */

/**
 * 尝试求值，失败返回 undefined（**绝不抛**）。
 * @template T
 * @param {() => T} fn
 * @returns {T | undefined}
 */
function safe(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * 探测宿主能力矩阵。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ warn?: Function }} [deps]
 * @returns {{
 *   dshVersion: string | undefined,
 *   node: string,
 *   available: Record<string, boolean>,
 *   missing: string[],
 *   notes: string[],
 * }}
 */
export function probeHost(ctx, { warn } = {}) {
  const available = {}
  const notes = []

  /** 判一项能力：谓词通过即 true。 */
  const check = (name, predicate) => {
    const ok = safe(() => predicate() === true) === true
    available[name] = ok
    return ok
  }

  // ── 上下文基础能力 ──────────────────────────────────────────────────────────
  check('ctx.reflect.get', () => typeof ctx?.reflect?.get === 'function')
  check('ctx.get', () => typeof ctx?.get === 'function')
  check('ctx.on', () => typeof ctx?.on === 'function')
  check('ctx.effect', () => typeof ctx?.effect === 'function')

  // `ctx.reflect.get` 是「不声明 inject 也能读服务」的唯一通路；
  // 缺它时只能退到 ctx.get / ctx[key]，而这两条在真实 ctx 上会抛。
  if (!available['ctx.reflect.get']) {
    notes.push('缺 ctx.reflect.get → 服务读取可能全部失败（插件会降级为"空壳但能启动"）')
  }

  // ── 服务：tools ────────────────────────────────────────────────────────────
  const tools = safe(() => ctx?.reflect?.get?.('tools', false)) ?? safe(() => ctx?.tools)
  check('service.tools', () => tools !== undefined)
  check('tools.register', () => typeof tools?.register === 'function')
  check('tools.guard', () => typeof tools?.guard === 'function')
  check('tools.restrict', () => typeof tools?.restrict === 'function')
  check('tools.schemas', () => typeof tools?.schemas === 'function')

  // ── 服务：webServer（页面数据面）────────────────────────────────────────────
  const webServer = safe(() => ctx?.reflect?.get?.('webServer', false))
  check('service.webServer', () => webServer !== undefined)
  check('webServer.register', () => typeof webServer?.register === 'function')

  // ── 服务：agents（Bot 独立目录的唯一路径）──────────────────────────────────
  const agents = safe(() => ctx?.reflect?.get?.('agents', false))
  check('service.agents', () => agents !== undefined)
  check('agents.create', () => typeof agents?.create === 'function')
  check('agents.get', () => typeof agents?.get === 'function')
  check('agents.list', () => typeof agents?.list === 'function')
  check('agents.resume', () => typeof agents?.resume === 'function')

  // ── 可选增强（缺了只影响官方 Team 相关，不影响本平台自有能力）─────────────
  check('service.agentTeams', () => safe(() => ctx?.reflect?.get?.('agentTeams', false)) !== undefined)

  // ── 版本信息（拿不到就留空，不猜）──────────────────────────────────────────
  const dshVersion =
    safe(() => process.env.DSH_VERSION) ??
    safe(() => ctx?.reflect?.get?.('profileContext', false)?.dshVersion) ??
    undefined

  const node = safe(() => process.version) ?? 'unknown'

  const missing = Object.entries(available)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)

  // 只对「影响核心功能」的缺失发 warn（可选增强不吵）
  const critical = ['tools.register', 'webServer.register', 'agents.create']
  const criticalMissing = missing.filter((m) => critical.includes(m))
  if (criticalMissing.length && typeof warn === 'function') {
    warn(
      `[cs-bots] 宿主缺少关键能力：${criticalMissing.join(', ')} → 相关功能将降级（插件仍会正常启动）`,
    )
  }

  return {
    dshVersion: typeof dshVersion === 'string' ? dshVersion : undefined,
    node,
    available,
    missing,
    notes,
  }
}

/**
 * 把探测结果整理成一行可读摘要（写日志/显示在 UI 用）。
 * @param {ReturnType<typeof probeHost>} report
 * @returns {string}
 */
export function formatReport(report) {
  const ok = Object.entries(report.available).filter(([, v]) => v).length
  const total = Object.keys(report.available).length
  const parts = [`能力 ${ok}/${total}`, `node=${report.node}`]
  if (report.dshVersion) parts.push(`dsh=${report.dshVersion}`)
  if (report.missing.length) parts.push(`缺: ${report.missing.join(', ')}`)
  return parts.join(' · ')
}
