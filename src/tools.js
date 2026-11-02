/**
 * cs-bots /tools —— 模型面（**模型能调用的工具**）。
 *
 * 为什么必须有这一层：L2 域服务（board / roster / room / memory / dispatcher）只是
 * 宿主侧的对象；**没有工具，模型在新机器上装完插件后看不到任何能力**，
 * 平台等于不存在。工具是「域服务 ↔ 模型」的唯一桥。
 *
 * 设计纪律：
 *   - **零第三方依赖**：不 import 任何非内置包；宿主耦合全部经 `kernel.registerTool`。
 *   - **缺服务降级**：每个工具执行时先查域服务，缺则返回**可读失败**（不是抛崩）。
 *   - **绝不静默**：所有失败都返回 `{ ok: false, reason }` 让模型看见。
 *   - **工具名带 `bot_` 前缀**：避免与官方/其他插件撞名（`insert` 不去重，见硬约束 C1）。
 */

import { registerTool } from './kernel.js'
import { getServices } from './registry.js'

/** 统一的失败构造（所有工具都返回它，绝不抛出去让宿主崩）。 */
function failure(reason, extra = {}) {
  return { ok: false, reason, ...extra }
}

/** 统一的结果包装（成功）。 */
function success(payload) {
  return { ok: true, ...payload }
}

/**
 * 从宿主上下文取本平台的域服务。
 * @param {object} ctx
 * @returns {{ board?: object, roster?: object, room?: object, memory?: object, dispatcher?: object }}
 */
function servicesOf(ctx) {
  return getServices(ctx)
}

/** 取调用者标识（审计流必填字段用）。 */
function callerOf(exec) {
  return exec?.agent?.id ?? exec?.agent?.session?.id ?? 'unknown'
}

// ── 工具定义表 ───────────────────────────────────────────────────────────────
//
// 每个条目：{ name, description, parameters, run(services, args, exec) }
// `run` 返回规范无损 JSON 值；失败走 `failure()`。

const DEFS = [
  // ── 任务板（BoardService）───────────────────────────────────────────────────
  {
    name: 'bot_task_create',
    description:
      '在 cs-bots 跨会话任务板上创建一个任务。返回任务 id 与 rev；后续用 bot_task_update 推进状态（CAS 需带 expectedRev）。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '任务标题（必填）' },
        description: { type: 'string', description: '任务详情' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id 列表' },
        writeScopes: { type: 'array', items: { type: 'string' }, description: '预期写入的文件前缀（提示性）' },
        priority: { type: 'number', description: '优先级（数值越大越先）' },
        dueAt: { type: 'number', description: '截止时间（epoch ms）' },
        sourceSeq: { type: 'string', description: '幂等键：同键重复创建只产生一条' },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.board) return failure('board-unavailable', { hint: '任务板未装配（状态目录不可写？）' })
      return success({ task: s.board.create({ ...a, byId: callerOf(exec) }) })
    },
  },
  {
    name: 'bot_task_list',
    description: '列出 cs-bots 任务板上的任务。默认不含已删除（tombstone）；传 status 可只看某状态。',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'blocked', 'deleted'],
          description: '只看该状态',
        },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.board) return failure('board-unavailable')
      return success({ tasks: s.board.list(a?.status ? { status: a.status } : {}) })
    },
  },
  {
    name: 'bot_task_ready',
    description:
      '列出**就绪**任务：状态为 pending 且全部 blockedBy 依赖已完成，按 priority 降序。用于「该我干了」的领活判断。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (s) => {
      if (!s.board) return failure('board-unavailable')
      return success({ tasks: s.board.ready() })
    },
  },
  {
    name: 'bot_task_update',
    description:
      '推进任务状态（CAS：必须带当前 expectedRev，不匹配会被拒，绝不静默覆盖）。' +
      'action: claim=取租约并置 in_progress / heartbeat=续租 / release=放租约回 pending / ' +
      'complete=完成（**必须带非空 artifacts**）/ reopen=重开 / block / unblock / delete=tombstone / set=改字段。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        expectedRev: { type: 'number', description: '当前 rev（CAS 必需）' },
        action: {
          type: 'string',
          enum: ['claim', 'heartbeat', 'release', 'complete', 'reopen', 'block', 'unblock', 'delete', 'set'],
        },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'complete 必填：交付物路径' },
        reason: { type: 'string', description: 'block 的原因' },
        subject: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number' },
        dueAt: { type: 'number' },
        writeScopes: { type: 'array', items: { type: 'string' } },
        blockedBy: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'expectedRev', 'action'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.board) return failure('board-unavailable')
      try {
        return success({ task: s.board.update({ ...a, byId: callerOf(exec) }) })
      } catch (error) {
        // CAS 冲突等业务失败**返回**给模型（而不是抛崩），模型可重读 rev 后重试
        return failure(error?.code ?? 'update-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_task_accept',
    description: '对已完成任务记一次验收（官方没有这个动作）：result=pass 通过 / reject 驳回（驳回会把任务打回 pending）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        result: { type: 'string', enum: ['pass', 'reject'] },
        note: { type: 'string', description: '验收意见' },
      },
      required: ['id', 'result'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.board) return failure('board-unavailable')
      try {
        return success({ task: s.board.accept({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'accept-failed', { message: error?.message ?? String(error) })
      }
    },
  },

  // ── 唤醒桥（Dispatcher）────────────────────────────────────────────────────
  {
    name: 'bot_wake',
    description:
      '定向唤醒一个会话干新活（走 followup：新开一个回合）。**必须给 dedupKey**——同键只唤一次，防唤醒风暴。' +
      'reason: task-assigned / task-unblocked / room-message / lease-timeout / timer。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标会话 id' },
        reason: {
          type: 'string',
          enum: ['task-assigned', 'task-unblocked', 'room-message', 'lease-timeout', 'timer'],
        },
        dedupKey: { type: 'string', description: '去重键（强烈建议：如 "task-assigned:<taskId>"）' },
        text: { type: 'string', description: '唤醒正文；缺省按 reason 生成' },
        delayMs: { type: 'number', description: '延后投递（ms）' },
      },
      required: ['target', 'reason'],
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.dispatcher) return failure('dispatcher-unavailable')
      return s.dispatcher.notify(a)
    },
  },

  // ── Bot 注册表（RosterService）──────────────────────────────────────────────
  {
    name: 'bot_roster_create',
    description:
      '创建一个持久 Bot（独立会话 + **独立工作目录**，cwd 同时是它的写入边界）。' +
      '官方 spawn_teammate 无法指定目录，所以持久 Bot 必须走这里。cwd 必须是绝对路径，且不得在 DSH_HOME 内。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '唯一名（大小写不敏感）' },
        cwd: { type: 'string', description: '独立工作目录（绝对路径，必填）' },
        label: { type: 'string', description: '角色标签（≤24）' },
        model: { type: 'string' },
        instructions: { type: 'string', description: '该 Bot 的职责说明' },
        permission: { type: 'string', enum: ['read-only', 'workspace-write', 'full'] },
      },
      required: ['name', 'cwd'],
      additionalProperties: false,
    },
    run: async (s, a, exec) => {
      if (!s.roster) return failure('roster-unavailable')
      try {
        return success({ bot: await s.roster.create({ ...a, byId: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'roster-create-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_roster_list',
    description: '列出 Bot 注册表。includeRetired=true 时含已退役（官方 roster 做不到回收，本平台可以）。',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', description: '只看该状态' },
        includeRetired: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.roster) return failure('roster-unavailable')
      const live = s.roster.list(a?.state ? { state: a.state } : {})
      const retired = a?.includeRetired ? s.roster.listRetired() : []
      return success({ bots: [...live, ...retired] })
    },
  },
  {
    name: 'bot_roster_manage',
    description:
      '管理已注册的 Bot（**官方 roster 做不到的能力**）：rename=改名（旧名随即释放）/ ' +
      'retire=退役（终态，名字与目录可被复用）/ setCwd=换工作目录 / claim=取租约 / release / heartbeat。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['rename', 'retire', 'setCwd', 'claim', 'release', 'heartbeat'] },
        name: { type: 'string', description: 'rename 用' },
        cwd: { type: 'string', description: 'setCwd 用（绝对路径）' },
        reason: { type: 'string' },
        expectedRev: { type: 'number' },
      },
      required: ['id', 'action'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.roster) return failure('roster-unavailable')
      const byId = callerOf(exec)
      try {
        switch (a.action) {
          case 'rename':
            return success({ bot: s.roster.rename({ id: a.id, name: a.name, expectedRev: a.expectedRev, byId }) })
          case 'retire':
            return success({ bot: s.roster.retire({ id: a.id, reason: a.reason, byId }) })
          case 'setCwd':
            return success({ bot: s.roster.setCwd({ id: a.id, cwd: a.cwd, expectedRev: a.expectedRev, byId }) })
          case 'claim':
            return success({ bot: s.roster.claim({ id: a.id, owner: byId, expectedRev: a.expectedRev }) })
          case 'release':
            return success({ bot: s.roster.release({ id: a.id, owner: byId, expectedRev: a.expectedRev }) })
          case 'heartbeat':
            return success({ bot: s.roster.heartbeat({ id: a.id, owner: byId, expectedRev: a.expectedRev }) })
          default:
            return failure('unknown-action', { action: a.action })
        }
      } catch (error) {
        return failure(error?.code ?? 'roster-manage-failed', { message: error?.message ?? String(error) })
      }
    },
  },

  // ── 房间（RoomService，P3）──────────────────────────────────────────────────
  {
    name: 'bot_room_create',
    description: '创建一个房间（多会话群聊）。members 为会话 id 列表。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        members: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['admin', 'everyone'] },
        adminId: { type: 'string' },
        notice: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.room) return failure('room-unavailable', { hint: 'P3 房间服务未装配' })
      try {
        // 注意：room 的公开方法是 `create`（内部实现名 createRoom_ 不对外）
        return success({ room: s.room.create({ ...a, byId: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'room-create-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_room_post',
    description: '往房间发言（**确定性写入**：直接落盘，不经 HTTP、不经模型转手）。长正文自动落旁路文件。',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string' },
        text: { type: 'string' },
        kind: { type: 'string', enum: ['normal', 'pass', 'notice', 'late', 'steer'] },
        to: { type: 'string', description: '定向给某成员' },
        dedupKey: { type: 'string', description: '幂等键' },
      },
      required: ['roomId', 'text'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.room) return failure('room-unavailable')
      try {
        return success({ message: s.room.post({ ...a, from: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'room-post-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_room_read',
    description: '读房间消息（含 seq 游标，用于断点续传）。长正文会带 bodyRef，用 bot_room_body 取全文。',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string' },
        sinceSeq: { type: 'number', description: '只取该 seq 之后的消息' },
        limit: { type: 'number' },
      },
      required: ['roomId'],
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.room) return failure('room-unavailable')
      return success({ messages: s.room.listMessages(a) })
    },
  },
  {
    name: 'bot_room_body',
    description: '取某条房间消息的**长正文全文**（log 里只存了引用与指纹）。',
    parameters: {
      type: 'object',
      properties: { roomId: { type: 'string' }, messageId: { type: 'string' } },
      required: ['roomId', 'messageId'],
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.room) return failure('room-unavailable')
      const text = s.room.readBody(a)
      if (text === undefined) return failure('body-not-found')
      return success({ text })
    },
  },

  // ── 记忆（MemoryService，P4）────────────────────────────────────────────────
  {
    name: 'bot_memory_add',
    description:
      '往分层记忆写一条。layer: L0 人格（**仅人可写，模型调用会被拒**）/ L1 用户偏好 / L2 团队全局 / ' +
      'L3 项目 key / L4 任务笔记 / L5 日札。explicit=true 表示「人显式说的」——之后 review 只能建议不能改。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] },
        content: { type: 'string' },
        explicit: { type: 'boolean' },
        branch: { type: 'string', description: 'L3 用：限定 git 分支' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['layer', 'content'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.memory) return failure('memory-unavailable', { hint: 'P4 记忆服务未装配' })
      try {
        return success({ entry: s.memory.add({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'memory-add-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_memory_search',
    description: '检索记忆（FTS5，缺则退化字面匹配）。可按层与分支过滤。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        layers: { type: 'array', items: { type: 'string' } },
        branch: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.memory) return failure('memory-unavailable')
      return success({ entries: s.memory.search(a) })
    },
  },
  {
    name: 'bot_memory_context',
    description: '取常驻注入用的记忆文本（L0–L3 冻结快照）。用于拼自己的上下文。',
    parameters: {
      type: 'object',
      properties: { branch: { type: 'string' } },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.memory) return failure('memory-unavailable')
      return success({ text: s.memory.contextFor(a ?? {}) })
    },
  },
]

/**
 * 注册全部工具。缺 `tools` 服务时**只 warn 不抛**（降级：模型看不到工具，
 * 但域服务仍可被其他插件/测试直接调用）。
 *
 * @param {object} ctx
 * @param {{ warn?: Function }} [deps]
 * @returns {string[]} 实际注册成功的工具名
 */
export function installTools(ctx, { warn } = {}) {
  const registered = []
  for (const def of DEFS) {
    try {
      const dispose = registerTool(ctx, {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        outputSchema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
        execute: async (args, exec) => {
          try {
            return def.run(servicesOf(ctx), args ?? {}, exec)
          } catch (error) {
            // 域服务内部异常也要转成**模型可读的失败**，绝不让宿主崩
            return failure('tool-crashed', {
              tool: def.name,
              message: error?.message ?? String(error),
            })
          }
        },
      })
      if (dispose) registered.push(def.name)
    } catch (error) {
      warn?.(`[cs-bots] 注册工具 ${def.name} 失败：${error?.message ?? error}`)
    }
  }
  return registered
}

/** 工具名清单（供测试与文档引用，避免各处硬编码）。 */
export const TOOL_NAMES = Object.freeze(DEFS.map((d) => d.name))
