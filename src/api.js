/**
 * cs-bots /api —— 宿主 HTTP 面（**给 L3 页面层用的数据接口**）。
 *
 * 为什么需要它：L2 域服务是宿主对象，浏览器里的客户端拿不到；
 * 页面必须有一条**稳定的读/写接口**。本文件就是那条接口。
 *
 * 设计纪律：
 *   - **零第三方依赖**：只用 node 内置 + kernel.registerRoute。
 *   - **不碰宿主内部实现**：所有业务都转调域服务（board/roster/room/memory/dispatcher）。
 *   - **缺服务降级**：域服务缺失时返回 503 + 可读原因（不是 500 崩）。
 *   - **写操作必须回显成败**：让页面能显示"为什么失败"，不静默。
 *   - **前缀路由**：`/cs-bots/api`（与包名一致，避免和其他插件撞路径）。
 */

import { registerRoute } from './kernel.js'
import { getServices } from './registry.js'

/** 请求体上限（防大包打爆内存）。 */
const MAX_BODY = 2 * 1024 * 1024

/** API 前缀。 */
export const API_BASE = '/cs-bots/api'

/** 读请求体（JSON）。 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大（>2MB）')
    chunks.push(chunk)
  }
  if (!chunks.length) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : undefined
}

/** 回 JSON（不缓存）。 */
function sendJson(response, code, body) {
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body ?? null))
}

/** 从查询串取字符串参数。 */
function qp(url, name) {
  const v = url.searchParams.get(name)
  return v === null ? undefined : v
}

/** 从查询串取数字参数。 */
function qn(url, name) {
  const v = url.searchParams.get(name)
  if (v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 统一包装：域服务缺失 → 503；业务异常 → 400 带可读原因；其它 → 500。
 * @param {object} services
 * @param {string} key
 * @param {(svc: object) => Promise<object>|object} fn
 */
async function withService(services, key, fn) {
  const svc = services[key]
  if (!svc) {
    const error = new Error(`${key} 服务未装配（检查状态目录是否可写、宿主版本是否匹配）`)
    error.status = 503
    error.code = `${String(key).toUpperCase()}_UNAVAILABLE`
    throw error
  }
  return fn(svc)
}

/**
 * 注册全部 API 路由。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ warn?: Function }} [deps]
 * @returns {(() => void) | undefined} disposer
 */
export function installApi(ctx, { warn } = {}) {
  const handler = async (request, response) => {
    const services = getServices(ctx)
    let url
    try {
      url = new URL(request.url || '/', 'http://localhost')
    } catch {
      sendJson(response, 400, { ok: false, reason: 'bad-url' })
      return
    }
    // 去掉前缀，得到相对路径
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) || '/' : url.pathname

    try {
      // ── 读：状态总览 ──────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/status') {
        const out = { ok: true, services: {} }
        for (const key of ['roster', 'board', 'dispatcher', 'room', 'memory']) {
          const svc = services[key]
          out.services[key] = svc
            ? {
                available: true,
                stats: typeof svc.stats === 'function' ? svc.stats() : undefined,
                stateDir: svc.paths?.stateDir,
              }
            : { available: false }
        }
        sendJson(response, 200, out)
        return
      }

      // ── 任务板 ────────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/tasks') {
        const status = qp(url, 'status')
        const onlyReady = qp(url, 'ready') === '1'
        const tasks = await withService(services, 'board', (b) =>
          onlyReady ? b.ready() : b.list(status ? { status } : {}),
        )
        sendJson(response, 200, { ok: true, tasks })
        return
      }

      if (request.method === 'POST' && path === '/tasks') {
        const body = (await readBody(request)) ?? {}
        const task = await withService(services, 'board', (b) =>
          b.create({ ...body, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      if (request.method === 'POST' && path === '/tasks/update') {
        const body = (await readBody(request)) ?? {}
        const task = await withService(services, 'board', (b) =>
          b.update({ ...body, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      if (request.method === 'POST' && path === '/tasks/accept') {
        const body = (await readBody(request)) ?? {}
        const task = await withService(services, 'board', (b) =>
          b.accept({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      // ── Bot 注册表 ────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/roster') {
        const includeRetired = qp(url, 'includeRetired') === '1'
        const bots = await withService(services, 'roster', (r) => [
          ...r.list(),
          ...(includeRetired ? r.listRetired() : []),
        ])
        sendJson(response, 200, { ok: true, bots })
        return
      }

      if (request.method === 'POST' && path === '/roster') {
        const body = (await readBody(request)) ?? {}
        const bot = await withService(services, 'roster', (r) =>
          r.create({ ...body, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, bot })
        return
      }

      if (request.method === 'POST' && path === '/roster/manage') {
        const body = (await readBody(request)) ?? {}
        const byId = body.byId ?? 'ui'
        const result = await withService(services, 'roster', (r) => {
          switch (body.action) {
            case 'rename':
              return r.rename({ id: body.id, name: body.name, expectedRev: body.expectedRev, byId })
            case 'retire':
              return r.retire({ id: body.id, reason: body.reason, byId })
            case 'setCwd':
              return r.setCwd({ id: body.id, cwd: body.cwd, expectedRev: body.expectedRev, byId })
            case 'claim':
              return r.claim({ id: body.id, owner: byId, expectedRev: body.expectedRev })
            case 'release':
              return r.release({ id: body.id, owner: byId, expectedRev: body.expectedRev })
            case 'heartbeat':
              return r.heartbeat({ id: body.id, owner: byId, expectedRev: body.expectedRev })
            default:
              throw new Error(`未知 action: ${body.action}`)
          }
        })
        sendJson(response, 200, { ok: true, bot: result })
        return
      }

      // ── 房间 ──────────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/rooms') {
        const rooms = await withService(services, 'room', (r) => r.list())
        sendJson(response, 200, { ok: true, rooms })
        return
      }

      if (request.method === 'POST' && path === '/rooms') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.create({ ...body, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      if (request.method === 'GET' && path === '/rooms/messages') {
        const roomId = qp(url, 'roomId')
        if (!roomId) {
          sendJson(response, 400, { ok: false, reason: 'roomId 必填' })
          return
        }
        const messages = await withService(services, 'room', (r) =>
          r.listMessages({ roomId, sinceSeq: qn(url, 'sinceSeq'), limit: qn(url, 'limit') }),
        )
        sendJson(response, 200, { ok: true, messages })
        return
      }

      if (request.method === 'POST' && path === '/rooms/post') {
        const body = (await readBody(request)) ?? {}
        const message = await withService(services, 'room', (r) =>
          r.post({ ...body, from: body.from ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, message })
        return
      }

      if (request.method === 'GET' && path === '/rooms/body') {
        const roomId = qp(url, 'roomId')
        const messageId = qp(url, 'messageId')
        if (!roomId || !messageId) {
          sendJson(response, 400, { ok: false, reason: 'roomId 与 messageId 必填' })
          return
        }
        const text = await withService(services, 'room', (r) => r.readBody({ roomId, messageId }))
        sendJson(response, 200, { ok: true, text })
        return
      }

      // ── 记忆 ──────────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/memory') {
        const layer = qp(url, 'layer')
        const query = qp(url, 'query')
        const entries = await withService(services, 'memory', (m) =>
          query ? m.search({ query, layers: layer ? [layer] : undefined, limit: qn(url, 'limit') })
                : m.list({ layer, limit: qn(url, 'limit') }),
        )
        sendJson(response, 200, { ok: true, entries })
        return
      }

      if (request.method === 'POST' && path === '/memory') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.add({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      if (request.method === 'GET' && path === '/memory/context') {
        const text = await withService(services, 'memory', (m) => m.contextFor({ branch: qp(url, 'branch') }))
        sendJson(response, 200, { ok: true, text })
        return
      }

      // ── 唤醒审计 ──────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/wakes') {
        const wakes = await withService(services, 'dispatcher', (d) =>
          d.list({ target: qp(url, 'target'), limit: qn(url, 'limit') ?? 100 }),
        )
        sendJson(response, 200, { ok: true, wakes })
        return
      }

      sendJson(response, 404, { ok: false, reason: `未知端点: ${request.method} ${path}` })
    } catch (error) {
      const status = Number.isFinite(error?.status) ? error.status : 400
      sendJson(response, status, {
        ok: false,
        code: error?.code ?? 'API_ERROR',
        reason: error?.message ?? String(error),
      })
    }
  }

  const dispose = registerRoute(ctx, API_BASE, handler)
  if (!dispose) {
    warn?.(`[cs-bots] webServer 不可用 → HTTP API 未注册（页面将无数据）`)
    return undefined
  }
  return dispose
}
