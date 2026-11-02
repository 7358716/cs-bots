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

import { registerRoute, listPresets, defaultPreset } from './kernel.js'
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
 * 把 Bot 档案里的「预制记忆」同步进记忆服务（带 botId）。
 * 建 Bot 与改档案两处都要调用 —— 否则会出现"AGENTS.md 有、记忆库里没有"的不一致。
 * @param {object} services
 * @param {{ id: string, profile?: object }} bot
 * @param {string} by
 * @returns {{ added: number, failed: object[] } | undefined}
 */
function seedBotMemory(services, bot, by) {
  const seed = Array.isArray(bot?.profile?.memory) ? bot.profile.memory : []
  if (!services.memory || seed.length === 0) return undefined
  const added = []
  const failed = []
  for (const content of seed) {
    try {
      const entry = services.memory.add({
        layer: 'L2',
        content: String(content).slice(0, 600),
        by,
        source: 'explicit',
        botId: bot.id,
      })
      const id = Array.isArray(entry) ? entry[0]?.id : entry?.id
      if (id) added.push(id)
    } catch (error) {
      failed.push({ content: String(content).slice(0, 40), reason: error?.message ?? String(error) })
    }
  }
  return { added: added.length, failed }
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
        const out = { ok: true, services: {}, compat: services.compat ?? null }
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

      // ── agent 预设（建 Bot 时可选）─────────────────────────────────────────
      if (request.method === 'GET' && path === '/presets') {
        let presets = []
        let defaultId
        try {
          presets = await listPresets(ctx)
          defaultId = defaultPreset(ctx)
        } catch (error) {
          sendJson(response, 200, { ok: true, presets: [], defaultId: undefined, note: `预设服务不可用：${error?.message ?? error}` })
          return
        }
        sendJson(response, 200, {
          ok: true,
          presets: presets.map((p) => ({
            id: p.id,
            name: p.name ?? p.id,
            description: p.description,
            order: p.order,
            broken: p.broken,
          })),
          defaultId,
          note: presets.length ? undefined : '宿主未提供 agentPresets 服务（Bot 将使用默认预设）',
        })
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
        // 预制记忆同步（建 Bot 与改档案必须一致）
        const memory = seedBotMemory(services, bot, body.byId ?? 'ui')
        sendJson(response, 200, { ok: true, bot, ...(memory ? { memory } : {}) })
        return
      }

      // ── Bot 档案（身份 / 经验 / 技能 / 预制记忆）──────────────────────────
      if (request.method === 'GET' && path === '/roster/profile') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const detail = await withService(services, 'roster', (r) => r.getProfile(id))
        sendJson(response, 200, {
          ok: true,
          bot: detail.bot,
          profile: detail.profile ?? {},
          profilePath: detail.profilePath,
          managedText: detail.managedText,
          hasOutside: detail.hasOutside,
          profileError: detail.profileError,
        })
        return
      }

      if (request.method === 'POST' && path === '/roster/profile') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const bot = await withService(services, 'roster', (r) =>
          r.setProfile({ id: body.id, profile: body.profile ?? {}, byId: body.byId ?? 'ui', expectedRev: body.expectedRev }),
        )
        // 预制记忆同步（与建 Bot 共用同一段逻辑）
        const memory = seedBotMemory(services, bot, body.byId ?? 'ui')
        sendJson(response, 200, { ok: true, bot, ...(memory ? { memory } : {}) })
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

      // ── 任务：详情穿透 / 指派 / 终止 / 编辑 ──────────────────────────────
      if (request.method === 'GET' && path === '/tasks/detail') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const detail = await withService(services, 'board', (b) => ({
          task: b.get(id),
          history: typeof b.history === 'function' ? b.history(id) : [],
        }))
        if (!detail.task) {
          sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
          return
        }
        sendJson(response, 200, { ok: true, ...detail })
        return
      }

      if (request.method === 'POST' && path === '/tasks/assign') {
        const body = (await readBody(request)) ?? {}
        if (!body.id || !body.ownerId) {
          sendJson(response, 400, { ok: false, reason: 'id 与 ownerId 必填' })
          return
        }
        // 指派 = 用 ownerId 作为 claim 的 byId（board 的 claim 把 by 记为 owner）
        const task = await withService(services, 'board', (b) =>
          b.update({
            id: body.id,
            expectedRev: body.expectedRev,
            action: 'claim',
            byId: body.ownerId,
            ...(body.leaseMs ? { leaseMs: body.leaseMs } : {}),
          }),
        )
        // 指派后立刻定向唤醒（dedupKey 幂等：同任务同原因只唤一次）
        let wake
        if (services.dispatcher && body.wake !== false) {
          wake = services.dispatcher.notify({
            target: body.ownerId,
            reason: 'task-assigned',
            dedupKey: `task-assigned:${task.id}:${task.rev}`,
            text: `新任务 ${task.id}：${task.subject}\n${task.description ?? ''}`.trim(),
          })
        }
        sendJson(response, 200, { ok: true, task, wake })
        return
      }

      if (request.method === 'POST' && path === '/tasks/abort') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        // 终止 = block + 原因（board 的 block 会置 blocked 并留 reason；可 reopen）
        const task = await withService(services, 'board', (b) =>
          b.update({
            id: body.id,
            expectedRev: body.expectedRev,
            action: 'block',
            note: body.reason ?? '用户终止',
            byId: body.byId ?? 'ui',
          }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      if (request.method === 'POST' && path === '/tasks/edit') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const task = await withService(services, 'board', (b) =>
          b.update({ ...body, action: 'edit', byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, task })
        return
      }

      if (request.method === 'GET' && path === '/tasks/history') {
        const id = qp(url, 'id')
        const history = await withService(services, 'board', (b) =>
          typeof b.history === 'function' ? b.history(id) : [],
        )
        sendJson(response, 200, { ok: true, history })
        return
      }

      // ── 房间：成员管理 / 转发 ─────────────────────────────────────────────
      if (request.method === 'POST' && path === '/rooms/join') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.join({ roomId: body.roomId, sessionId: body.sessionId, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      if (request.method === 'POST' && path === '/rooms/leave') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.leave({ roomId: body.roomId, sessionId: body.sessionId, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      if (request.method === 'POST' && path === '/rooms/relay') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'room', (r) =>
          r.relay({ roomId: body.roomId, messageId: body.messageId, targets: body.targets }),
        )
        sendJson(response, 200, { ok: true, ...result })
        return
      }

      // ── 记忆：改 / 归档 / 恢复 ────────────────────────────────────────────
      if (request.method === 'POST' && path === '/memory/update') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.update({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      if (request.method === 'POST' && path === '/memory/remove') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.remove({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      if (request.method === 'POST' && path === '/memory/archive') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.archive({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      if (request.method === 'POST' && path === '/memory/restore') {
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.restore({ ...body, by: body.by ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, entry })
        return
      }

      // ── 设置 ──────────────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/settings') {
        const { SETTING_SPECS } = await import('./settings.js')
        sendJson(response, 200, {
          ok: true,
          values: services.settings ?? {},
          specs: SETTING_SPECS,
          diagnostics: services.settingsDiagnostics,
          baseDir: services.board?.paths?.stateDir ?? services.roster?.paths?.stateDir,
        })
        return
      }

      if (request.method === 'POST' && path === '/settings') {
        const body = (await readBody(request)) ?? {}
        const { saveSettings } = await import('./settings.js')
        const dir = services.board?.paths?.stateDir ?? services.roster?.paths?.stateDir
        const saved = saveSettings(dir, body)
        if (!saved.ok) {
          sendJson(response, 400, { ok: false, reason: saved.reason })
          return
        }
        sendJson(response, 200, {
          ok: true,
          values: saved.values,
          note: '已写入 settings.json；内核级参数需重启 DSH 生效',
        })
        return
      }

      // ── 手动唤醒 ──────────────────────────────────────────────────────────
      if (request.method === 'POST' && path === '/wakes/notify') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'dispatcher', (d) => d.notify(body))
        sendJson(response, 200, { ok: true, result })
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
