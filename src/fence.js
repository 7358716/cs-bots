/**
 * cs-bots /api 鉴权围栏 —— **公网暴露的 API 必须有门**。
 *
 * 为什么需要这个文件（2026-11-04 实测）：
 *   修复前 cs-bots 的 HTTP 面**完全没有鉴权**——
 *   `curl -X POST http://<公网IP>/cs-bots/api/tasks -d '{"subject":"x"}'` 返回 200，
 *   任何知道地址的人都能建任务、改记忆、写房间、改 Bot 注册表。
 *   对比：cs-guard 有完整围栏、cs-myfree 有校验，唯独 cs-bots 裸奔。
 *   这不仅是"数据被改"，更会把「受保护区写闸门」这类下游防护**从更高层绕过去**
 *   （比如直接往 roster/memory 事件流里塞条目），所以必须在 API 层堵死。
 *
 * 判定顺序（与 cs-guard/web/guard.js 同款思路，但**本文件独立实现**——
 * cs-bots 的铁律是"运行时不依赖其他插件"，不能 import cs-guard）：
 *   ① Origin 与 Host 不同源 → 403（防 CSRF）
 *   ② 宿主 connection 服务可用 → 交给它做**真实**会话校验（签名/cookie 有效性）
 *   ③ 宿主校验能力缺失 → 拒绝一切**经代理**的请求（fail-closed），
 *      非代理请求放行（本机直连 / 测试替身；服务只监听 127.0.0.1，外部进不来）
 *
 * 为什么第 ③ 条不是一律拒绝：本仓的 `test/api.test.mjs` 用假 req/res 直接调 handler，
 * 没有 socket 也没有 connection 服务。一律拒绝会让整个测试套件失效，
 * 逼着人关掉围栏——那才是真正的安全隐患。区分"经代理"与"非经代理"是准确的边界。
 */

/** 判定 loopback 地址。 */
function isLoopbackAddr(addr) {
  if (typeof addr !== 'string' || addr === '') return false
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.') || addr === '::ffff:127.0.0.1'
}

/** 请求是否经过反向代理（nginx 等会加这些头）。 */
export function isProxiedRequest(request) {
  const headers = request?.headers || {}
  return Boolean(
    headers['x-forwarded-for'] || headers['x-forwarded-proto']
    || headers['x-forwarded-host'] || headers['x-real-ip'],
  )
}

/** 安全取宿主的 connection 服务（拿不到就返回 null，不抛）。 */
export function safeGetConnection(getConnection) {
  try {
    const conn = typeof getConnection === 'function' ? getConnection() : getConnection
    return conn && typeof conn.requestRejection === 'function' ? conn : null
  } catch {
    return null
  }
}

/** 委托宿主做真实会话校验。 */
export function verifySession(request, conn) {
  try {
    const rejection = conn.requestRejection(request)
    // 宿主契约：undefined/null/0 表示放行；401 未认证；其余为 403 禁止
    if (rejection === undefined || rejection === null || rejection === 0) return { ok: true }
    const status = rejection === 401 ? 401 : 403
    return {
      ok: false,
      status,
      reason: status === 401 ? 'invalid-or-missing-session' : 'untrusted-authority-or-forbidden',
    }
  } catch {
    return { ok: false, status: 403, reason: 'auth-check-failed' }
  }
}

/**
 * 判定一个 API 请求是否放行。
 *
 * @param {any} request  Node IncomingMessage（或测试替身）
 * @param {{ getConnection?: (() => any) | any }} [opts]
 * @returns {{ ok: boolean, status?: number, reason?: string }}
 */
export function judge(request, { getConnection } = {}) {
  const headers = request?.headers || {}

  // ① 同源校验（防 CSRF）：带了 Origin 就必须与 Host 一致
  const origin = headers.origin
  const hostHeader = headers.host
  if (typeof origin === 'string' && origin !== '') {
    let originHost = null
    try { originHost = new URL(origin).host } catch { originHost = null }
    if (originHost === null || originHost !== hostHeader) {
      return { ok: false, status: 403, reason: 'cross-origin' }
    }
  }

  // ② 宿主校验能力可用 → 真实校验，**不论是否经代理**
  const conn = safeGetConnection(getConnection)
  if (conn) return verifySession(request, conn)

  // ③ 宿主校验能力缺失：经代理的请求一律拒绝（公网路径 fail-closed）
  if (isProxiedRequest(request)) {
    return { ok: false, status: 403, reason: 'auth-unavailable-for-proxied' }
  }

  // 非代理：本机直连（服务只绑 127.0.0.1）或测试替身 → 放行
  return { ok: true }
}

/**
 * 造一个带缓存的判定器（避免每个请求都去 reflect 一次 ctx）。
 *
 * @param {{ ctx: any, warn?: Function }} input
 * @returns {{ judgeHttp: (request: any) => {ok:boolean,status?:number,reason?:string},
 *            mode: () => 'host-session'|'proxy-denied' }}
 */
export function createFence({ ctx, warn } = {}) {
  let warnedNoConnection = false

  const getConnection = () => {
    try {
      if (typeof ctx?.get === 'function') {
        const viaGet = ctx.get('connection', false)
        if (viaGet) return viaGet
      }
      return ctx?.connection ?? null
    } catch {
      return null
    }
  }

  // 启动时探一次：把"围栏处在哪种模式"明确写进日志，
  // 免得以后有人以为有门、其实门是虚掩的（这次 P0 就是这么漏的）。
  const probe = safeGetConnection(getConnection)
  if (!probe) {
    warnedNoConnection = true
    warn?.(
      '[cs-bots/fence] 未拿到宿主 connection 服务 → API 围栏降级为「拒绝一切经代理请求」模式。'
      + '本机直连（127.0.0.1）与测试替身仍可访问；公网路径一律 403。'
      + '若你是在公网使用本插件，这说明会话校验失效，请检查 DSH 版本/装配。',
    )
  }

  return {
    judgeHttp(request) {
      return judge(request, { getConnection })
    },
    mode() {
      return safeGetConnection(getConnection) ? 'host-session' : 'proxy-denied'
    },
  }
}
