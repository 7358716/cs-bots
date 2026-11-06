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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { registerRoute, listPresets, defaultPreset } from './kernel.js'
import { createLibrary } from './library.js'
import { createDirBrowser } from './dirbrowse.js'
import { getServices } from './registry.js'
import { createFence } from './fence.js'

/** 请求体上限（防大包打爆内存）。 */
const MAX_BODY = 2 * 1024 * 1024

/** API 前缀。 */
export const API_BASE = '/cs-bots/api'

/**
 * 页面操作者身份。
 * 域服务用 `'user'` 表示「人类所有者 = 超级管理员」（见 room.js 的 USER 常量）。
 * 之前 API 传的是 `'ui'`，导致房间设置页一改就 `ROOM_NOT_MEMBER` —— 人类反而没权限。
 */
const OWNER = 'user'

/** 纪律层级与分类（前端下拉直接用，避免两边写死不一致）。 */
const DISCIPLINE_SCOPES = ['global', 'workspace', 'room', 'bot']
const DISCIPLINE_KINDS = ['rule', 'requirement', 'principle', 'style']

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

/** 数据浏览：合法文件名/子目录（防目录穿越）。 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/** 判断是否是安全的单段路径（无 `..`、无分隔符）。 */
function safeSegment(value) {
  if (typeof value !== 'string' || value === '') return false
  if (value === '.' || value === '..') return false
  if (value.includes('..')) return false
  return SAFE_SEGMENT.test(value)
}

/** 把 artifacts 归一成字符串数组（对象用单行 JSON）。 */
function normalizeArtifactItems(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (item === null || item === undefined) continue
    if (typeof item === 'string') {
      const t = item.trim()
      if (t) out.push(t)
    } else if (typeof item === 'object') {
      try {
        out.push(JSON.stringify(item))
      } catch {
        out.push(String(item))
      }
    } else {
      out.push(String(item))
    }
  }
  return out
}

/** 任务状态集合（与 board.js STATUSES 同口径，删除态不参与）。 */
const GRAPH_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'deleted']


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
 * 把一条建议**真正写进目标域**（建议确认制的"采纳"落地）。
 *
 * 为什么放在 api 层而不是 suggest.js：`suggest.js` 刻意不 import memory/library/discipline，
 * 避免循环依赖与越界写入。真正的写库动作由调用方以回调注入 —— 就是这里。
 *
 * 任一步抛错都会向上抛：`suggest.accept` 收到异常后会把该条**保持 pending**
 * 并记 `lastError`，绝不静默标记成"已采纳"。
 *
 * @param {object} services
 * @param {{ kind: string, layer?: string, payload?: object }} suggestion
 * @param {string} by
 */
function applySuggestion(services, suggestion, by) {
  const kind = suggestion?.kind
  const payload = suggestion?.payload ?? {}

  // ⚠️ 必须是**同步**函数：suggest.accept 的 apply 回调若返回 Promise，
  //   它会在真正落库前就把状态标成 accepted（假采纳）。而这里要写的三个域服务
  //   （memory / library / discipline）全部是同步内存写 + 同步落盘，所以可以同步完成。
  const need = (key) => {
    const svc = services?.[key]
    if (!svc) {
      const error = new Error(`${key} 服务未装配，无法落地这条建议`)
      error.code = `${String(key).toUpperCase()}_UNAVAILABLE`
      throw error
    }
    return svc
  }

  if (kind === 'memory') {
    const entry = need('memory').add({
      layer: suggestion.layer ?? payload.layer ?? 'L4',
      content: payload.content,
      tags: payload.tags,
      by,
      cwd: payload.cwd,
    })
    return { kind, id: Array.isArray(entry) ? entry[0]?.id : entry?.id }
  }
  if (kind === 'skill') {
    const skill = need('library').createSkill({
      name: payload.name,
      description: payload.description,
      body: payload.body,
      tags: payload.tags,
      by,
    })
    return { kind, id: skill?.id }
  }
  if (kind === 'discipline') {
    const item = need('discipline').createDiscipline({
      scope: payload.scope,
      scopeId: payload.scopeId,
      kind: payload.disciplineKind ?? payload.kind ?? 'rule',
      title: payload.title,
      content: payload.content,
      priority: payload.priority,
      by,
    })
    return { kind, id: item?.id }
  }
  throw new Error(`applySuggestion：未知建议类型 ${JSON.stringify(kind)}（拒绝静默忽略）`)
}

/**
 * 注册全部 API 路由。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ warn?: Function }} [deps]
 * @returns {(() => void) | undefined} disposer
 */
export function installApi(ctx, { warn } = {}) {
  // ⚠️ 修复（2026-11-04 测试，P0）：此前本 API **完全没有鉴权**——
  //   公网 `curl -X POST http://<IP>/cs-bots/api/tasks` 直接 200，
  //   任何人都能建任务/改记忆/写房间/改 Bot 注册表，并借此绕过下游的受保护区写闸门。
  //   现在所有请求先过 fence.judgeHttp：宿主不认证就一律 403。
  const fence = createFence({ ctx, warn })

  const handler = async (request, response) => {
    const services = getServices(ctx)
    // 鉴权先于一切业务逻辑（连 URL 解析都不做，避免攻击面）
    const verdict = fence.judgeHttp(request)
    if (!verdict.ok) {
      sendJson(response, verdict.status ?? 403, { ok: false, reason: verdict.reason ?? 'unauthorized' })
      return
    }
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
        // 状态面要覆盖**全部**域服务：新增模块若不上报，页面「系统体检」就会
        // 显示「一切正常」而实际某功能没装配 —— 那是本平台最忌讳的静默失败。
        const SERVICE_KEYS = [
          'roster', 'board', 'dispatcher', 'room', 'memory',
          'library', 'discipline', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer',
        ]
        for (const key of SERVICE_KEYS) {
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
        const attention = qp(url, 'attention') === '1'
        const priority = qn(url, 'priority')
        const source = qp(url, 'source')
        const sort = qp(url, 'sort')
        const byId = qp(url, 'byId')
        const opts = { status: status ?? undefined, attention: attention || undefined, priority: priority ?? undefined, source: source ?? undefined, sort: sort ?? undefined, byId }
        const tasks = await withService(services, 'board', (b) =>
          onlyReady ? b.ready() : b.list(opts),
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
        // 同目录共享检测：**允许**，但必须告知（两个 Bot 在同一目录会互相覆盖文件）
        let sharedWith = []
        try {
          const all = services.roster?.list?.() ?? []
          sharedWith = all
            .filter((b) => b.id !== bot.id && b.state !== 'retired' && String(b.cwd) === String(bot.cwd))
            .map((b) => ({ id: b.id, name: b.name }))
        } catch {
          /* 检测失败不影响创建 */
        }
        sendJson(response, 200, {
          ok: true,
          bot,
          ...(memory ? { memory } : {}),
          ...(sharedWith.length
            ? {
                warnings: [
                  `目录 ${bot.cwd} 已被 ${sharedWith.map((b) => b.name).join('、')} 使用 —— 两个 Bot 会互相覆盖文件`,
                ],
                sharedWith,
              }
            : {}),
        })
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
        // includeArchived=1 时连归档房一起返回（超级管理员的"回收站"视图）
        const rooms = await withService(services, 'room', (r) =>
          r.list({ includeArchived: qp(url, 'includeArchived') === '1' }),
        )
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
          r.listMessages({
            roomId,
            sinceSeq: qn(url, 'sinceSeq'),
            limit: qn(url, 'limit'),
            withBody: qp(url, 'withBody') === '1',
          }),
        )
        sendJson(response, 200, { ok: true, messages })
        return
      }

      if (request.method === 'POST' && path === '/rooms/post') {
        const body = (await readBody(request)) ?? {}
        const message = await withService(services, 'room', (r) =>
          r.post({ ...body, from: body.from ?? 'ui' }),
        )

        // ── 发言后自动唤醒房间内的 Bot ──
        //
        // 为什么需要这步：主管报"我在群聊里说话，Bot 没有反应"。
        // 根因是 /rooms/post 只落消息、不做任何投递，房间变成"死信箱"——
        // 消息写进去了，但没有任何机制告诉 Bot "有人在说话"。
        //
        // 唤醒策略（与 dispatcher 的 dedupKey 一致）：
        //   - 只唤醒**非本人**的成员（不唤醒发送者自己）；
        //   - 房间设置 `allowBotAutoPost` 为 false 时跳过（给用户关开关的权利）；
        //   - dedupKey 用消息 ID，天然幂等，同一消息不会重复唤醒；
        //   - dispatcher 缺失时降级为「只落消息不唤醒」，不抛错。
        const room = await withService(services, 'room', (r) => r.get(message.roomId))
        const senderSession = body.from ?? 'ui'
        const members = room?.members ?? []
        const skipSelf = (senderSession !== 'ui' && senderSession)
        const toWake = members.filter((m) => m !== skipSelf)
        if (toWake.length > 0 && room?.settings?.allowBotAutoPost !== false) {
          for (const target of toWake) {
            await withService(services, 'dispatcher', (d) => d.notify({
              target,
              reason: 'room-message',
              dedupKey: `room-msg:${message.id}:${target}`,
              text: `[房间「${room.name ?? message.roomId}」有新消息] ${message.text.slice(0, 200)}`,
            })).catch(() => {
              // dispatcher 降级：唤醒失败不影响消息已落盘的事实
            })
          }
        }

        sendJson(response, 200, { ok: true, message, wakes: toWake.length })
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
        const botId = qp(url, 'botId')
        const entries = await withService(services, 'memory', (m) =>
          query ? m.search({
              query,
              layers: layer ? [layer] : undefined,
              limit: qn(url, 'limit'),
              botId,
              includeArchived: qp(url, 'includeArchived') === '1',
            })
                : m.list({
              layer,
              limit: qn(url, 'limit'),
              botId,
              cwd: qp(url, 'cwd'),
              includeArchived: qp(url, 'includeArchived') === '1',
              onlyArchived: qp(url, 'onlyArchived') === '1',
            }),
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

      if (request.method === 'GET' && path === '/memory/stats') {
        const stats = await withService(services, 'memory', (m) => m.stats())
        sendJson(response, 200, { ok: true, stats })
        return
      }

      if (request.method === 'GET' && path === '/memory/context') {
        // cwd：按项目裁剪注入内容（不传＝全局口径，与改造前逐字一致）
        const text = await withService(services, 'memory', (m) => m.contextFor({
          branch: qp(url, 'branch'),
          cwd: qp(url, 'cwd'),
        }))
        sendJson(response, 200, { ok: true, text })
        return
      }

      // ── 成果聚合（只读）────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/artifacts') {
        const q = qp(url, 'q')
        const ownerId = qp(url, 'ownerId')
        const status = qp(url, 'status')
        const limit = qn(url, 'limit')
        const cap = limit !== undefined && limit > 0 ? Math.min(limit, 1000) : 200
        const kw = q ? String(q).toLowerCase() : ''
        const rows = await withService(services, 'board', (b) => b.list({ status: status ?? undefined }))
        const artifacts = []
        let itemCount = 0
        let danglingSkipped = 0
        for (const t of rows) {
          if (ownerId && t.ownerId !== ownerId) continue
          const items = normalizeArtifactItems(t.artifacts)
          if (items.length === 0) continue
          if (kw) {
            const hay = `${t.subject ?? ''} ${items.join(' ')}`.toLowerCase()
            if (!hay.includes(kw)) continue
          }
          itemCount += items.length
          artifacts.push({
            taskId: t.id,
            subject: t.subject,
            status: t.status,
            ownerId: t.ownerId,
            accepted: t.accepted === true,
            completedAt: t.completedAt ?? t.createdAt,
            items,
          })
        }
        artifacts.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
        const sliced = artifacts.slice(0, cap)
        sendJson(response, 200, {
          ok: true,
          artifacts: sliced,
          stats: { tasks: sliced.length, items: sliced.reduce((n, a) => n + a.items.length, 0) },
          note: `已扫描 ${rows.length} 个任务${danglingSkipped ? `，跳过 ${danglingSkipped} 个悬空引用` : ''}`,
        })
        return
      }

      // ── 数据浏览（只读，绝不提供写接口）────────────────────────────────────
      if (request.method === 'GET' && path === '/data/files') {
        const dirParam = qp(url, 'dir')
        const boardSvc = services.board
        const stateDir = boardSvc?.paths?.stateDir ?? services.roster?.paths?.stateDir
        if (!stateDir) {
          sendJson(response, 503, { ok: false, reason: '状态目录不可用（域服务均未装配）' })
          return
        }
        let root = stateDir
        if (dirParam !== undefined && dirParam !== '') {
          if (!safeSegment(dirParam)) {
            sendJson(response, 400, { ok: false, reason: '非法子目录名' })
            return
          }
          root = join(stateDir, dirParam)
        }
        const files = []
        let note
        try {
          for (const name of readdirSync(root)) {
            if (!/\.(jsonl|json)$/i.test(name)) continue
            if (!safeSegment(name)) continue
            let st
            try {
              st = statSync(join(root, name))
            } catch {
              continue
            }
            if (!st.isFile()) continue
            const kind = /\.jsonl$/i.test(name) ? 'jsonl' : 'json'
            let lines = 0
            let truncated = false
            if (kind === 'jsonl') {
              if (st.size > 8 * 1024 * 1024) {
                lines = null
                truncated = true
              } else {
                try {
                  const text = readFileSync(join(root, name), 'utf8')
                  lines = text === '' ? 0 : text.split('\n').filter((x) => x.trim() !== '').length
                } catch {
                  lines = null
                  truncated = true
                }
              }
            }
            const row = { name, bytes: st.size, lines, mtime: st.mtimeMs, kind }
            if (truncated) row.truncated = true
            files.push(row)
          }
          files.sort((a, b) => b.mtime - a.mtime)
          note = `共 ${files.length} 个文件（只读浏览；写请走域服务与 CAS）`
        } catch (error) {
          note = `目录不可读：${error?.message ?? error}`
        }
        sendJson(response, 200, { ok: true, stateDir: root, files, note })
        return
      }

      if (request.method === 'GET' && path === '/data/rows') {
        const name = qp(url, 'name')
        if (!name) {
          sendJson(response, 400, { ok: false, reason: 'name 必填' })
          return
        }
        if (!safeSegment(name) || !/\.(jsonl|json)$/i.test(name)) {
          sendJson(response, 400, { ok: false, reason: '非法文件名' })
          return
        }
        const dirParam = qp(url, 'dir')
        if (dirParam !== undefined && dirParam !== '' && !safeSegment(dirParam)) {
          sendJson(response, 400, { ok: false, reason: '非法子目录名' })
          return
        }
        const boardSvc = services.board
        const stateDir = boardSvc?.paths?.stateDir ?? services.roster?.paths?.stateDir
        if (!stateDir) {
          sendJson(response, 503, { ok: false, reason: '状态目录不可用（域服务均未装配）' })
          return
        }
        const root = dirParam ? join(stateDir, dirParam) : stateDir
        const abs = join(root, name)
        const limitRaw = qn(url, 'limit')
        const limit = limitRaw !== undefined && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
        const offsetRaw = qn(url, 'offset')
        const offset = offsetRaw !== undefined && offsetRaw > 0 ? offsetRaw : 0
        let text
        try {
          text = readFileSync(abs, 'utf8')
        } catch (error) {
          sendJson(response, 404, { ok: false, reason: `读取失败：${error?.message ?? error}` })
          return
        }
        const all = text.split('\n').filter((line) => line.trim() !== '')
        const page = all.slice(offset, offset + limit)
        const rowsOut = page.map((raw, i) => {
          const row = { _line: offset + i + 1, _raw: raw.length > 4000 ? raw.slice(0, 4000) : raw }
          if (raw.length > 4000) row._truncated = true
          if (/\.jsonl$/i.test(name)) {
            try {
              JSON.parse(raw)
            } catch {
              row._parseError = true
            }
          }
          return row
        })
        sendJson(response, 200, {
          ok: true,
          name,
          total: all.length,
          offset,
          rows: rowsOut,
          note: `共 ${all.length} 行，显示 ${all.length ? offset + 1 : 0}-${Math.min(offset + limit, all.length)}`,
        })
        return
      }

      // ── 任务依赖图（只读）──────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/tasks/graph') {
        const id = qp(url, 'id')
        const all = await withService(services, 'board', (b) =>
          b.list({}).filter((t) => t.status !== 'deleted'))
        const byIdMap = new Map(all.map((t) => [t.id, t]))
        const dependents = new Map()
        let danglingEdges = 0
        for (const t of all) {
          for (const dep of t.blockedBy ?? []) {
            if (!byIdMap.has(dep)) {
              danglingEdges += 1
              continue
            }
            if (!dependents.has(dep)) dependents.set(dep, [])
            dependents.get(dep).push(t.id)
          }
        }
        let picked
        if (id) {
          if (!byIdMap.has(id)) {
            sendJson(response, 404, { ok: false, reason: `任务 ${id} 不存在` })
            return
          }
          const keep = new Set()
          const up = [id]
          while (up.length) {
            const cur = up.pop()
            if (keep.has(cur)) continue
            keep.add(cur)
            const t = byIdMap.get(cur)
            if (!t) continue
            for (const dep of t.blockedBy ?? []) {
              if (byIdMap.has(dep) && !keep.has(dep)) up.push(dep)
            }
          }
          const down = [id]
          while (down.length) {
            const cur = down.pop()
            for (const child of dependents.get(cur) ?? []) {
              if (!keep.has(child)) {
                keep.add(child)
                down.push(child)
              }
            }
          }
          picked = all.filter((t) => keep.has(t.id))
        } else {
          picked = all
        }
        // 字段恒定出现（前端画图不判 undefined）：ownerId/priority 缺省给 null/0
        const nodes = picked.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          ownerId: t.ownerId ?? null,
          progress: t.progress ?? 0,
          priority: t.priority ?? 0,
        }))
        const pickedIds = new Set(nodes.map((n) => n.id))
        const edges = []
        for (const t of picked) {
          for (const dep of t.blockedBy ?? []) {
            if (!pickedIds.has(dep)) continue
            edges.push({ from: t.id, to: dep, kind: 'blockedBy' })
          }
        }
        sendJson(response, 200, {
          ok: true,
          nodes,
          edges,
          note: `节点 ${nodes.length} 个，边 ${edges.length} 条${danglingEdges ? `，忽略悬空依赖 ${danglingEdges} 条` : ''}`,
        })
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

      if (request.method === 'POST' && path === '/tasks/expire-leases') {
        // ⚠️ 修复（2026-11-04 测试，P1-4）：expireLeases 之前无任何调用者，
        //   owner 崩溃/失联后任务永久停在 in_progress。现在通过 API 暴露回收能力。
        const body = (await readBody(request)) ?? {}
        const recycled = await withService(services, 'board', (b) =>
          b.expireLeases({ now: Number.isFinite(body.now) ? body.now : undefined }),
        )
        sendJson(response, 200, { ok: true, recycled, note: recycled.length ? `回收了 ${recycled.length} 个过期任务` : '没有过期租约需要回收' })
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
      if (request.method === 'POST' && path === '/rooms/update') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.update({ ...body, byId: body.byId ?? 'ui' }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

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

      // ── 目录浏览（宿主原生选择器不可用时的兜底，也是唯一能「新建/重命名」的路径）──
      if (request.method === 'GET' && path === '/fs/roots') {
        const r = await withService(services, 'dirbrowse', (d) => d.roots())
        sendJson(response, 200, { ok: true, ...r })
        return
      }
      if (request.method === 'GET' && path === '/fs/list') {
        const dir = qp(url, 'path')
        const showHidden = qp(url, 'showHidden') === '1'
        const listing = await withService(services, 'dirbrowse', (d) =>
          d.list({ ...(dir ? { path: dir } : {}), showHidden }),
        )
        sendJson(response, 200, { ok: true, ...listing })
        return
      }
      if (request.method === 'POST' && path === '/fs/mkdir') {
        const body = (await readBody(request)) ?? {}
        const created = await withService(services, 'dirbrowse', (d) => d.mkdir(body))
        sendJson(response, 200, { ok: true, ...created })
        return
      }
      if (request.method === 'POST' && path === '/fs/rename') {
        const body = (await readBody(request)) ?? {}
        const renamed = await withService(services, 'dirbrowse', (d) => d.rename(body))
        sendJson(response, 200, { ok: true, ...renamed })
        return
      }
      if (request.method === 'POST' && path === '/fs/validate') {
        const body = (await readBody(request)) ?? {}
        const verdict = await withService(services, 'dirbrowse', (d) => d.validateAsBotCwd({ path: body.path }))
        sendJson(response, 200, { ok: true, verdict })
        return
      }

      // ── 技能库 / 工作流库 ─────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/library/skills') {
        const rows = await withService(services, 'library', (l) => l.listSkills({ tag: qp(url, 'tag') }))
        sendJson(response, 200, { ok: true, skills: rows })
        return
      }
      if (request.method === 'POST' && path === '/library/skills') {
        const body = (await readBody(request)) ?? {}
        const skill = await withService(services, 'library', (l) => l.createSkill({ ...body, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/update') {
        const body = (await readBody(request)) ?? {}
        const skill = await withService(services, 'library', (l) => l.updateSkill({ ...body, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'library', (l) => l.removeSkill({ id: body.id, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'GET' && path === '/library/workflows') {
        const rows = await withService(services, 'library', (l) => l.listWorkflows({ tag: qp(url, 'tag') }))
        sendJson(response, 200, { ok: true, workflows: rows })
        return
      }
      if (request.method === 'POST' && path === '/library/workflows') {
        const body = (await readBody(request)) ?? {}
        const workflow = await withService(services, 'library', (l) => l.createWorkflow({ ...body, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, workflow })
        return
      }
      if (request.method === 'POST' && path === '/library/workflows/update') {
        const body = (await readBody(request)) ?? {}
        const workflow = await withService(services, 'library', (l) => l.updateWorkflow({ ...body, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, workflow })
        return
      }
      if (request.method === 'POST' && path === '/library/workflows/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'library', (l) => l.removeWorkflow({ id: body.id, by: body.by ?? 'ui' }))
        sendJson(response, 200, { ok: true, result })
        return
      }

      // ── 设置 ──────────────────────────────────────────────────────────────
      // ⚠️ 修复（2026-11-04 测试）：
      //   ① GET 之前只返回 services.settings（启动时一次性加载的内存副本）⇒
      //      「保存后立刻 GET 却看不到新值」的假象（磁盘上其实已写对）。
      //      现改为：`saved` 永远来自磁盘（真相源），`effective` 才是运行时内存值。
      //   ② POST 之前只回 saved.values，调用方无法区分「写进去的」与「当前生效的」⇒
      //      现补 `effective` 与 `persisted` 两个字段，让 UI 能如实标注。
      if (request.method === 'GET' && path === '/settings') {
        const { SETTING_SPECS, loadSettings } = await import('./settings.js')
        const dir = services.board?.paths?.stateDir ?? services.roster?.paths?.stateDir
        const disk = dir ? loadSettings(dir) : { values: {}, diagnostics: { file: '', source: 'unknown', badKeys: [] } }
        sendJson(response, 200, {
          ok: true,
          values: disk.values,
          saved: disk.values,
          effective: services.settings ?? {},
          specs: SETTING_SPECS,
          diagnostics: disk.diagnostics,
          baseDir: dir,
          note: Object.keys(disk.values).length
            && JSON.stringify(disk.values) !== JSON.stringify(services.settings ?? {})
            ? '磁盘值与内存生效值不同：内核级参数需重启 DSH 才生效'
            : undefined,
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
          saved: saved.values,
          effective: services.settings ?? {},
          persisted: true,
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


      // ══════════════════════════════════════════════════════════════════════
      // v2 新增端点（2026-11-04，五大功能）
      // ══════════════════════════════════════════════════════════════════════

      // ── 特性①：房间超级管理员 ────────────────────────────────────────────
      if (request.method === 'POST' && path === '/rooms/archive') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.archiveRoom({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }
      if (request.method === 'POST' && path === '/rooms/unarchive') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.unarchiveRoom({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }
      if (request.method === 'POST' && path === '/rooms/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'room', (r) =>
          r.removeRoom({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/rooms/member-role') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.setMemberRole({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }
      if (request.method === 'POST' && path === '/rooms/kick') {
        const body = (await readBody(request)) ?? {}
        const room = await withService(services, 'room', (r) =>
          r.kickMember({ ...body, byId: body.byId ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, room })
        return
      }

      // ── 特性②：分级纪律体系 ──────────────────────────────────────────────
      if (request.method === 'GET' && path === '/disciplines') {
        const items = await withService(services, 'discipline', (d) => d.listDisciplines({
          scope: qp(url, 'scope'),
          scopeId: qp(url, 'scopeId'),
          kind: qp(url, 'kind'),
          query: qp(url, 'query'),
          enabled: qp(url, 'enabled') === undefined ? undefined : qp(url, 'enabled') === '1',
        }))
        sendJson(response, 200, { ok: true, items, scopes: DISCIPLINE_SCOPES, kinds: DISCIPLINE_KINDS })
        return
      }
      if (request.method === 'POST' && path === '/disciplines') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'discipline', (d) =>
          d.createDiscipline({ ...body, by: body.by ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, item })
        return
      }
      if (request.method === 'POST' && path === '/disciplines/update') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'discipline', (d) =>
          d.updateDiscipline({ ...body, by: body.by ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, item })
        return
      }
      if (request.method === 'POST' && path === '/disciplines/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'discipline', (d) =>
          d.removeDiscipline({ id: body.id, expectedRev: body.expectedRev, by: body.by ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/disciplines/import') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'discipline', (d) =>
          d.importDisciplines({ items: body.items ?? [], mode: body.mode, by: body.by ?? OWNER }),
        )
        sendJson(response, 200, { ok: true, result })
        return
      }
      // 合并预览：给定 bot/cwd/room，看"这个对象实际会看到哪些纪律"
      if (request.method === 'GET' && path === '/disciplines/resolve') {
        const resolved = await withService(services, 'discipline', (d) => d.resolveDisciplines({
          botId: qp(url, 'botId'),
          cwd: qp(url, 'cwd'),
          roomId: qp(url, 'roomId'),
        }))
        sendJson(response, 200, { ok: true, ...resolved })
        return
      }
      if (request.method === 'GET' && path === '/disciplines/preview') {
        const resolved = await withService(services, 'discipline', (d) => d.renderDisciplinePrompt({
          botId: qp(url, 'botId'),
          cwd: qp(url, 'cwd'),
          roomId: qp(url, 'roomId'),
          tokenBudget: qn(url, 'tokenBudget'),
        }))
        sendJson(response, 200, { ok: true, ...resolved })
        return
      }

      // ── 特性③：Bot 档案增强（导入记忆 / 关联技能）────────────────────────
      if (request.method === 'POST' && path === '/roster/profile/memory') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const out = await withService(services, 'roster', (r) =>
          r.addProfileMemory({
            id: body.id,
            entries: body.entries ?? [],
            dedup: body.dedup !== false,
            byId: body.byId ?? OWNER,
            expectedRev: body.expectedRev,
          }),
        )
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/roster/skills/link') {
        const body = (await readBody(request)) ?? {}
        if (!body.id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const bot = await withService(services, 'roster', (r) =>
          r.linkSkills({
            id: body.id,
            skills: body.skills ?? [],
            byId: body.byId ?? OWNER,
            expectedRev: body.expectedRev,
          }),
        )
        sendJson(response, 200, { ok: true, bot })
        return
      }

      // ── 特性④：记忆档案完整增删改查 ──────────────────────────────────────
      if (request.method === 'GET' && path === '/memory/detail') {
        const id = qp(url, 'id')
        const layer = qp(url, 'layer')
        if (!id || !layer) {
          sendJson(response, 400, { ok: false, reason: 'id 与 layer 必填' })
          return
        }
        const entry = await withService(services, 'memory', (m) => m.get({ layer, id }))
        const history = await withService(services, 'memory', (m) => m.history(id))
        sendJson(response, 200, { ok: true, entry, history })
        return
      }
      if (request.method === 'POST' && path === '/memory/purge') {
        // 彻底删除（不可恢复）：与 /memory/remove（软删除，可恢复）区分开
        const body = (await readBody(request)) ?? {}
        const entry = await withService(services, 'memory', (m) =>
          m.purge({ layer: body.layer, id: body.id, expectedRev: body.expectedRev, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, purged: entry })
        return
      }
      if (request.method === 'POST' && path === '/memory/migrate-cwd') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'memory', (m) =>
          m.migrateCwd({ cwd: body.cwd, by: body.by ?? OWNER, now: body.now }))
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/memory/import') {
        const body = (await readBody(request)) ?? {}
        const rows = Array.isArray(body.entries) ? body.entries : []
        const added = []
        const failed = []
        for (const row of rows) {
          try {
            const entry = await withService(services, 'memory', (m) => m.add({
              layer: row.layer ?? body.layer ?? 'L4',
              content: row.content ?? row,
              by: body.by ?? OWNER,
              tags: row.tags,
              explicit: row.explicit,
            }))
            const id = Array.isArray(entry) ? entry[0]?.id : entry?.id
            if (id) added.push(id)
          } catch (error) {
            failed.push({ content: String(row?.content ?? row).slice(0, 60), reason: error?.message ?? String(error) })
          }
        }
        sendJson(response, 200, { ok: true, added: added.length, ids: added, failed })
        return
      }

      // ── 特性⑤：技能导入 / 导出 ───────────────────────────────────────────
      if (request.method === 'POST' && path === '/library/skills/parse') {
        const body = (await readBody(request)) ?? {}
        const parsed = await withService(services, 'library', (l) =>
          l.parseSkillMarkdown({ text: body.text ?? '', filename: body.filename }),
        )
        sendJson(response, 200, { ok: true, parsed })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/import') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'library', (l) =>
          l.importSkills({
            items: body.items ?? [],
            mode: body.mode ?? 'skip',
            by: body.by ?? OWNER,
          }),
        )
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/scan') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'library', (l) =>
          l.scanSkillsDir({ dir: body.dir }),
        )
        sendJson(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'GET' && path === '/library/skills/detail') {
        const id = qp(url, 'id')
        if (!id) {
          sendJson(response, 400, { ok: false, reason: 'id 必填' })
          return
        }
        const skill = await withService(services, 'library', (l) => l.getSkill(id))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'GET' && path === '/library/skills/export') {
        const ids = qp(url, 'ids')
        const out = await withService(services, 'library', (l) =>
          l.exportSkills({ ids: ids ? ids.split(',').filter(Boolean) : undefined }),
        )
        sendJson(response, 200, { ok: true, ...out })
        return
      }

      // ── 特性⑥：四轨待办 ──────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/todos') {
        const out = await withService(services, 'todo', (t) => t.listTodos({
          track: qp(url, 'track'),
          cwd: qp(url, 'cwd'),
          date: qp(url, 'date'),
          status: qp(url, 'status'),
          query: qp(url, 'query'),
          all: qp(url, 'all') === '1',
          past: qp(url, 'past') === '1',
          expired: qp(url, 'expired') === '1',
          limit: qn(url, 'limit'),
        }))
        // listTodos 返回 {items,total,truncated,defaultView,today,hint}；
        // 原样展开（页面读 items）+ 保留 todos 别名（老调用方兼容）
        sendJson(response, 200, { ok: true, ...out, todos: out.items ?? [] })
        return
      }
      if (request.method === 'POST' && path === '/todos') {
        const body = (await readBody(request)) ?? {}
        const todo = await withService(services, 'todo', (t) => t.createTodo({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, todo })
        return
      }
      if (request.method === 'POST' && path === '/todos/update') {
        const body = (await readBody(request)) ?? {}
        const todo = await withService(services, 'todo', (t) => t.updateTodo({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, todo })
        return
      }
      if (request.method === 'POST' && path === '/todos/promote') {
        // 「待办 → 任务」升级：待办是个人备忘，任务是要交给别人/Bot 干的协作单元。
        // 两者是漏斗上下游，所以必须有一条**确定性**的升级通道（不是让用户手抄一遍）。
        // 幂等靠 board 的 sourceSeq=`todo:<id>`：连点两次也只会产生一个任务。
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'todo', async (t) => {
          const todo = t.getTodo(body.id)
          if (!todo) {
            const error = new Error(`待办不存在：${body.id}`)
            error.status = 404
            error.code = 'TODO_NOT_FOUND'
            throw error
          }
          if (body.expectedRev !== undefined && todo.rev !== body.expectedRev) {
            const error = new Error(`待办 CAS 冲突：期望 rev=${body.expectedRev}，实际 rev=${todo.rev}`)
            error.status = 409
            error.code = 'TODO_REV_CONFLICT'
            throw error
          }
          const task = await withService(services, 'board', (b) => b.create({
            subject: String(todo.content).split(String.fromCharCode(10))[0].slice(0, 120),
            description: todo.content,
            priority: body.priority,
            dueAt: todo.due ? Date.parse(`${todo.due}T00:00:00+08:00`) : undefined,
            byId: body.by ?? OWNER,
            sourceSeq: `todo:${todo.id}`,
          }))
          // 升级后把待办标成"进行中"，避免它又出现在「要关注」里被重复安排
          let next = todo
          if (todo.status === 'pending') {
            next = t.updateTodo({ id: todo.id, expectedRev: todo.rev, status: 'doing', by: body.by ?? OWNER })
          }
          return { task, todo: next }
        })
        sendJson(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'POST' && path === '/todos/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'todo', (t) =>
          t.removeTodo({ id: body.id, expectedRev: body.expectedRev, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, result })
        return
      }

      // ── 特性⑦：便签 ──────────────────────────────────────────────────────
      if (request.method === 'GET' && path === '/scratch') {
        const out = await withService(services, 'scratch', (s) => s.read({ scope: qp(url, 'scope') }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/scratch') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'scratch', (s) =>
          s.write({ scope: body.scope, text: body.text ?? '', by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'GET' && path === '/scratch/scopes') {
        const scopes = await withService(services, 'scratch', (s) => s.listScopes())
        sendJson(response, 200, { ok: true, scopes })
        return
      }

      // ── 特性⑧：提示词库 + 注入轨 ──────────────────────────────────────────
      if (request.method === 'GET' && path === '/prompts') {
        const items = await withService(services, 'prompts', (p) => p.listPrompts({
          category: qp(url, 'category'),
          tag: qp(url, 'tag'),
          query: qp(url, 'query'),
          enabled: qp(url, 'enabled') === undefined ? undefined : qp(url, 'enabled') === '1',
          limit: qn(url, 'limit'),
        }))
        const categories = await withService(services, 'prompts', (p) => p.listCategories())
        sendJson(response, 200, { ok: true, items, categories })
        return
      }
      if (request.method === 'POST' && path === '/prompts') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'prompts', (p) => p.createPrompt({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, item })
        return
      }
      if (request.method === 'POST' && path === '/prompts/update') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'prompts', (p) => p.updatePrompt({ ...body, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, item })
        return
      }
      if (request.method === 'POST' && path === '/prompts/remove') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'prompts', (p) =>
          p.removePrompt({ id: body.id, expectedRev: body.expectedRev, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST' && path === '/prompts/categories/add') {
        const body = (await readBody(request)) ?? {}
        const categories = await withService(services, 'prompts', (p) =>
          p.addCategory({ name: body.name, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, categories })
        return
      }
      if (request.method === 'POST' && path === '/prompts/categories/remove') {
        const body = (await readBody(request)) ?? {}
        const categories = await withService(services, 'prompts', (p) =>
          p.removeCategory({ name: body.name, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, categories })
        return
      }
      if (request.method === 'POST' && path === '/prompts/inject') {
        const body = (await readBody(request)) ?? {}
        const injection = await withService(services, 'prompts', (p) => p.inject({
          promptId: body.promptId,
          text: body.text,
          sessionId: body.sessionId,
          times: body.times,
          every: body.every,
          immediate: body.immediate,
          by: body.by ?? OWNER,
        }))
        sendJson(response, 200, { ok: true, injection })
        return
      }
      if (request.method === 'POST' && path === '/prompts/injection/stop') {
        const body = (await readBody(request)) ?? {}
        const result = await withService(services, 'prompts', (p) => p.stopInjection({ id: body.id, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'GET' && path === '/prompts/injections') {
        const injections = await withService(services, 'prompts', (p) => p.listInjections({ sessionId: qp(url, 'sessionId') }))
        sendJson(response, 200, { ok: true, injections })
        return
      }

      // ── 特性⑨：建议确认队列 + 审查调度 ───────────────────────────────────
      if (request.method === 'GET' && path === '/suggestions') {
        const items = await withService(services, 'suggest', (s) => s.listSuggestions({
          kind: qp(url, 'kind'),
          status: qp(url, 'status') ?? 'pending',
          limit: qn(url, 'limit'),
        }))
        sendJson(response, 200, { ok: true, items })
        return
      }
      if (request.method === 'POST' && path === '/suggestions/propose') {
        const body = (await readBody(request)) ?? {}
        const suggestion = await withService(services, 'suggest', (sg) => sg.suggest({
          kind: body.kind,
          layer: body.layer,
          payload: body.payload,
          reason: body.reason,
          source: body.source ?? 'model',
          confidence: body.confidence,
          by: body.by ?? OWNER,
        }))
        sendJson(response, 200, { ok: true, suggestion })
        return
      }
      if (request.method === 'POST' && path === '/suggestions/accept') {
        const body = (await readBody(request)) ?? {}
        // apply 回调把建议真正写进目标域（memory / library / discipline）
        const applied = await withService(services, 'suggest', (s) => s.accept({
          id: body.id,
          by: body.by ?? OWNER,
          apply: (sg) => applySuggestion(services, sg, body.by ?? OWNER),
        }))
        sendJson(response, 200, { ok: true, suggestion: applied })
        return
      }
      if (request.method === 'POST' && path === '/suggestions/reject') {
        const body = (await readBody(request)) ?? {}
        const item = await withService(services, 'suggest', (s) =>
          s.reject({ id: body.id, reason: body.reason, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, suggestion: item })
        return
      }
      if (request.method === 'GET' && path === '/review/status') {
        const status = await withService(services, 'reviewer', (r) => r.status({ sessionId: qp(url, 'sessionId') }))
        sendJson(response, 200, { ok: true, status })
        return
      }
      if (request.method === 'POST' && path === '/review/note-turn') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'reviewer', (r) => r.noteTurn({ sessionId: body.sessionId }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/review/mark-reviewed') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'reviewer', (r) =>
          r.markReviewed({ sessionId: body.sessionId, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/review/interval') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'reviewer', (r) => r.setInterval({ interval: body.interval }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }

      // ── 特性⑩：技能管理器（来源/启用/自定义目录/浏览）────────────────────
      if (request.method === 'POST' && path === '/library/skills/enable') {
        const body = (await readBody(request)) ?? {}
        const skill = await withService(services, 'library', (l) => l.setSkillEnabled({
          id: body.id, enabled: body.enabled, by: body.by ?? OWNER, expectedRev: body.expectedRev,
        }))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/source') {
        const body = (await readBody(request)) ?? {}
        const skill = await withService(services, 'library', (l) => l.setSkillSource({
          id: body.id, source: body.source, by: body.by ?? OWNER, expectedRev: body.expectedRev,
        }))
        sendJson(response, 200, { ok: true, skill })
        return
      }
      if (request.method === 'GET' && path === '/library/skills/dirs') {
        const dirs = await withService(services, 'library', (l) => l.listSkillDirs())
        sendJson(response, 200, { ok: true, dirs })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/dirs/add') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'library', (l) =>
          l.addSkillDir({ dir: body.dir, label: body.label, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/dirs/remove') {
        const body = (await readBody(request)) ?? {}
        const out = await withService(services, 'library', (l) =>
          l.removeSkillDir({ dir: body.dir, by: body.by ?? OWNER }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'GET' && path === '/library/skills/browse') {
        const out = await withService(services, 'library', (l) =>
          l.browseSkillDir({ dir: qp(url, 'dir'), sub: qp(url, 'sub') }))
        sendJson(response, 200, { ok: true, ...out })
        return
      }
      if (request.method === 'POST' && path === '/library/skills/scan-all') {
        const out = await withService(services, 'library', (l) => l.scanAllSkillDirs())
        sendJson(response, 200, { ok: true, ...out })
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
