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
import { applyTaskHint } from './routing/hints.js'

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
 * @returns {{ board?: object, roster?: object, room?: object, memory?: object, dispatcher?: object,
 *   todo?: object, scratch?: object, prompts?: object, discipline?: object, suggest?: object }}
 */
function servicesOf(ctx) {
  return getServices(ctx)
}

/** 取调用者标识（审计流必填字段用）。 */
function callerOf(exec) {
  return exec?.agent?.id ?? exec?.agent?.session?.id ?? 'unknown'
}

/** 从唤醒去重键反推任务 id：`task-assigned:t-3` / `task-unblocked:t-3` / `tasks-assigned:t-3`。 */
function taskIdFromDedup(dedupKey) {
  if (typeof dedupKey !== 'string') return undefined
  const m = /^tasks?-(?:assigned|unblocked):(t-\d+)$/.exec(dedupKey.trim())
  return m ? m[1] : undefined
}

/**
 * 用任务字段给某个会话写路由 hint（缺任务/缺会话/缺 cs-myfree 都返回 `undefined`，
 * 唤醒本身**照样要发出去** —— hint 只是优化）。
 *
 * @param {object|undefined} board
 * @param {string} taskId
 * @param {string} sessionId
 * @returns {{ ok: boolean, hint?: object, reason?: string } | undefined}
 */
function hintForTask(board, taskId, sessionId) {
  if (!board || typeof board.get !== 'function') return undefined
  try {
    const task = board.get(taskId)
    if (!task) return undefined
    return applyTaskHint(task, sessionId, { role: 'subagent' })
  } catch {
    return undefined
  }
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
      '在 cs-bots 跨会话任务板上创建一个任务。返回任务 id 与 rev；后续用 bot_task_update 推进状态（CAS 需带 expectedRev）。' +
      '【复杂度路由】规划 Agent 拆解任务时**必须**给每个子任务显式标注 expectedComplexity（即 expected_complexity，' +
      'T0 简单 / T1 常规 / T2 较难 / T3 很难）：子智能体默认 free_only（只走免费渠道），**只有** requiresPaid=true ' +
      '（即 requires_paid:true）的子任务才获 paid_allowed。拿不准就给低档 + 不标 requiresPaid —— ' +
      '误判为免费只是慢，误判为付费是浪费钱。',
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
        expectedComplexity: {
          type: 'string',
          enum: ['T0', 'T1', 'T2', 'T3'],
          description: '该子任务的复杂度档位（路由用）：T0 一句话问答 / T1 常规改动 / T2 跨文件或多步 / T3 架构级',
        },
        requiresPaid: {
          type: 'boolean',
          description: '该子任务是否值得用付费渠道（默认 false ⇒ free_only）；只有确实需要强模型时才置 true',
        },
        cycle: { type: 'string', description: '周期名（PDCA 复盘周期标识）' },
        milestone: { type: 'string', description: '里程碑名' },
        estimate: { type: 'number', description: '预估工作量（≥0）' },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.board) return failure('board-unavailable', { hint: '任务板未装配（状态目录不可写？）' })
      try {
        return success({ task: s.board.create({ ...a, byId: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'create-failed', { message: error?.message ?? String(error) })
      }
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
        expectedComplexity: {
          type: 'string',
          enum: ['T0', 'T1', 'T2', 'T3'],
          description: '复杂度档位标注（claim 时可补/改；null = 清除）',
        },
        requiresPaid: {
          type: 'boolean',
          description: '是否值得付费渠道（claim 时可补/改；null = 清除；缺省 ⇒ free_only）',
        },
      },
      required: ['id', 'expectedRev', 'action'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.board) return failure('board-unavailable')
      const byId = callerOf(exec)
      try {
        const task = s.board.update({ ...a, byId })
        // 契约 §6：子任务被 claim 时，用任务字段给 owner 会话写 hint（付费用「任务标注」说了算）。
        // hint 写失败只是少了优化，**不影响** claim 结果 ⇒ 只作为附加字段回报。
        const hint = a.action === 'claim' ? applyTaskHint(task, byId) : undefined
        return hint ? success({ task, hint }) : success({ task })
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
        taskId: {
          type: 'string',
          description: '关联任务 id（可选）：给了就用该任务的 expectedComplexity/requiresPaid 给目标会话写路由 hint',
        },
      },
      required: ['target', 'reason'],
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.dispatcher) return failure('dispatcher-unavailable')
      const { taskId, ...request } = a ?? {}
      const res = s.dispatcher.notify(request)
      // 契约 §6：唤醒时同样用任务字段写 hint。taskId 显式优先，否则从
      // dedupKey（"task-assigned:t-3"）反推 —— 平台内部唤醒本来就是这么编键的。
      const hintTaskId = taskId ?? taskIdFromDedup(request.dedupKey)
      const hint = hintTaskId ? hintForTask(s.board, hintTaskId, request.target) : undefined
      return hint ? { ...res, hint } : res
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
        preset: {
          type: 'string',
          description:
            'agent 预设 id（决定该 Bot 的人格/系统提示/技能/工具面）。' +
            '不传则用宿主默认预设。可用 bot_roster_list 的 presets 字段或 GET /cs-bots/api/presets 查可选项。',
        },
        prepareCommand: {
          type: 'string',
          description:
            '可选。改造07 · 借鉴 Super-agent：该 Bot 首次接活前在 cwd 下执行的准备命令，' +
            '典型如 `git worktree add ../<name> main`。准备失败会让 claim 拒绝并记录原因。',
        },
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
      'retire=退役（终态，名字与目录可被复用）/ setCwd=换工作目录 / prepare=设置或清除开工准备命令 / ' +
      'claim=取租约 / release / heartbeat。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['rename', 'retire', 'setCwd', 'prepare', 'claim', 'release', 'heartbeat'] },
        name: { type: 'string', description: 'rename 用' },
        cwd: { type: 'string', description: 'setCwd 用（绝对路径）' },
        prepareCommand: {
          type: 'string',
          description:
            'prepare 用（改造07 · 借鉴 Super-agent）：Bot 首次接活前在该 cwd 下执行的准备命令，' +
            '典型如 `git worktree add ...`。传空字符串 = 清除。',
        },
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
          case 'prepare':
            return success({
              bot: s.roster.setPrepareCommand({
                id: a.id,
                prepareCommand: a.prepareCommand,
                expectedRev: a.expectedRev,
                byId,
              }),
            })
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
        taskId: { type: 'string', description: 'L4 任务笔记用：关联 board 任务 id，notesForTask 据此拉取' },
        phase: { type: 'string', description: 'L4 任务笔记用：plan / doing / block / done' },
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
    description: '取常驻注入用的记忆文本（L0–L3 冻结快照）。用于拼自己的上下文。可传 tokenBudget 按模型窗口裁剪。',
    parameters: {
      type: 'object',
      properties: {
        branch: { type: 'string' },
        cwd: { type: 'string', description: '按项目裁剪：只注入「全局 + 该项目」的 L3（不传＝全局口径）' },
        tokenBudget: { type: 'number', description: '注入 token 预算（0/缺省=不裁剪）' },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.memory) return failure('memory-unavailable')
      return success({ text: s.memory.contextFor(a ?? {}) })
    },
  },
  {
    name: 'bot_task_notes',
    description:
      '拉取某个 board 任务的全部 L4 任务笔记（倒序，最新在前）。接手任务时先看任务详情，再调本工具读历史笔记恢复上下文，' +
      '不依赖旧会话消息。笔记由 bot_memory_add(layer=L4, taskId) 写入。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'board 任务 id' },
        cwd: { type: 'string', description: '按项目裁剪' },
        limit: { type: 'number', description: '最多返回条数（缺省全部）' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.memory) return failure('memory-unavailable')
      try {
        return success({ notes: s.memory.notesForTask(a ?? {}) })
      } catch (error) {
        return failure(error?.code ?? 'task-notes-failed', { message: error?.message ?? String(error) })
      }
    },
  },

  // ── 待办（TodoService）──────────────────────────────────────────────────────
  {
    name: 'bot_todo_add',
    description: '记一件待办。track: life 生活 / work 工作 / project 本项目 / daily 每日（截止=今天）。'
      + 'quadrant: q1 重要且紧急 / q2 重要不紧急 / q3 紧急不重要 / q4 都不。',
    parameters: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: ['life', 'work', 'project', 'daily'] },
        content: { type: 'string' },
        quadrant: { type: 'string', enum: ['q1', 'q2', 'q3', 'q4'] },
        due: { type: 'string', description: 'YYYY-MM-DD' },
        cat: { type: 'string' },
        cwd: { type: 'string', description: 'project 轨用：项目工作目录' },
        date: { type: 'string', description: 'daily 轨用：YYYY-MM-DD（缺省=今天）' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.todo) return failure('todo-unavailable')
      try {
        return success({ todo: s.todo.createTodo({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'todo-add-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_todo_list',
    description: '查待办。缺省只返回需要关注的（逾期/今日到期/当前项目），要全部请传 all=true。'
      + '查过往每日待办请同时传 past=true 与 expired=true。',
    parameters: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: ['life', 'work', 'project', 'daily'] },
        cwd: { type: 'string' },
        date: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'doing', 'done', 'blocked', 'cancelled'] },
        query: { type: 'string' },
        all: { type: 'boolean' },
        past: { type: 'boolean' },
        expired: { type: 'boolean' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.todo) return failure('todo-unavailable')
      return success({ todos: s.todo.listTodos(a ?? {}) })
    },
  },
  {
    name: 'bot_todo_update',
    description: '改待办（必须带 expectedRev 防覆盖）。可改 content/quadrant/due/cat/status。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expectedRev: { type: 'number' },
        content: { type: 'string' },
        quadrant: { type: 'string', enum: ['q1', 'q2', 'q3', 'q4'] },
        due: { type: 'string' },
        cat: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'doing', 'done', 'blocked', 'cancelled'] },
      },
      required: ['id', 'expectedRev'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.todo) return failure('todo-unavailable')
      try {
        return success({ todo: s.todo.updateTodo({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'todo-update-failed', { message: error?.message ?? String(error) })
      }
    },
  },

  // ── 便签（ScratchService）──────────────────────────────────────────────────
  {
    name: 'bot_scratch_read',
    description: '读便签（scope 缺省 global）。便签是随手记的地方，不参与任何自动整理。',
    parameters: {
      type: 'object',
      properties: { scope: { type: 'string' } },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.scratch) return failure('scratch-unavailable')
      return success(s.scratch.read(a ?? {}))
    },
  },
  {
    name: 'bot_scratch_write',
    description: '整篇覆盖写便签（不是追加）。要保留原文请先 read 再写回。上限 512 KB。',
    parameters: {
      type: 'object',
      properties: { scope: { type: 'string' }, text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.scratch) return failure('scratch-unavailable')
      try {
        return success(s.scratch.write({ ...a, by: callerOf(exec) }))
      } catch (error) {
        return failure(error?.code ?? 'scratch-write-failed', { message: error?.message ?? String(error) })
      }
    },
  },

  // ── 提示词库（PromptService）──────────────────────────────────────────────
  {
    name: 'bot_prompt_list',
    description: '列出提示词模板（可按分类/标签/关键词过滤）。缺省只列启用中的。',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        tag: { type: 'string' },
        query: { type: 'string' },
        enabled: { type: 'boolean' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.prompts) return failure('prompts-unavailable')
      return success({ prompts: s.prompts.listPrompts(a ?? {}) })
    },
  },
  {
    name: 'bot_prompt_get',
    description: '取一条提示词的完整正文（含 {{date}}/{{time}} 展开前的原文）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.prompts) return failure('prompts-unavailable')
      const p = s.prompts.getPrompt({ id: a?.id })
      return p ? success({ prompt: p }) : failure('prompt-not-found')
    },
  },

  // ── 纪律（DisciplineService，分级）────────────────────────────────────────
  {
    name: 'bot_discipline_list',
    description: '查分级纪律（global 全局 / workspace 工作区 / room 房间 / bot 单个 Bot）。'
      + '可按 scope/scopeId 过滤。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'workspace', 'room', 'bot'] },
        scopeId: { type: 'string' },
        kind: { type: 'string', enum: ['rule', 'requirement', 'principle', 'style'] },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.discipline) return failure('discipline-unavailable')
      return success({ disciplines: s.discipline.listDisciplines(a ?? {}) })
    },
  },
  {
    name: 'bot_discipline_resolve',
    description: '取「我实际要遵守哪些纪律」的合并结果（按层合并、同名去重、优先级排序、预算裁剪）。',
    parameters: {
      type: 'object',
      properties: {
        botId: { type: 'string' },
        cwd: { type: 'string' },
        roomId: { type: 'string' },
        tokenBudget: { type: 'number' },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.discipline) return failure('discipline-unavailable')
      return success(s.discipline.resolveDisciplines(a ?? {}))
    },
  },

  // ── 建议确认（SuggestService）─────────────────────────────────────────────
  {
    name: 'bot_suggestion_propose',
    description: '提议一条要长期记住的东西（记忆/技能/纪律）。**不会直接生效** —— '
      + '进入待确认队列，人点了采纳才落库。这是模型改长期记忆的唯一合法途径。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['memory', 'skill', 'discipline'] },
        layer: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4', 'L5'] },
        payload: { type: 'object', description: 'memory: {content,tags}；skill: {name,description,body}；discipline: {scope,scopeId,title,content,disciplineKind,priority}' },
        reason: { type: 'string', description: '为什么建议记这条' },
        confidence: { type: 'number' },
      },
      required: ['kind', 'payload'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.suggest) return failure('suggest-unavailable')
      try {
        // memory 类建议必须带 layer —— 模型漏传时补 L4（任务笔记），而不是让它抛错后丢失
        const payload = { ...a, source: 'model', by: callerOf(exec) }
        if (payload.kind === 'memory' && !payload.layer) payload.layer = 'L4'
        return success({ suggestion: s.suggest.suggest(payload) })
      } catch (error) {
        return failure(error?.code ?? 'suggest-propose-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_suggestion_list',
    description: '查建议确认队列（缺省 pending）。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['memory', 'skill', 'discipline'] },
        status: { type: 'string', enum: ['pending', 'accepted', 'rejected'] },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.suggest) return failure('suggest-unavailable')
      return success({ suggestions: s.suggest.listSuggestions(a ?? {}) })
    },
  },

  // ── PDCA-4：复盘与标准化（Act）─────────────────────────────────────────────
  {
    name: 'bot_cycle_start',
    description:
      '为一个任务开启 PDCA 复盘周期。阶段：planned→doing→checking→acting→done，不许跳步。\n'
      + '**kind 决定周期类型（需求4）**：\n'
      + '  · human（默认）= 人跟长任务，五步不可跳，复盘后人显式确认完成；\n'
      + '  · agent = 智能体事后归纳，可在 review 时一次性提交并自动闭环（用于定期总结提升）。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id' },
        objective: { type: 'string', description: '目标原文（防漂移锚）' },
        kind: {
          type: 'string',
          enum: ['human', 'agent'],
          description: '周期类型：human=人跟长任务（默认）；agent=智能体归纳（可一次性提交）',
        },
        cycle: { type: 'string' },
        milestone: { type: 'string' },
        estimate: { type: 'number' },
      },
      required: ['taskId', 'objective'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.cycle) return failure('cycle-unavailable')
      try {
        return success({ cycle: s.cycle.start({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'cycle-start-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_cycle_advance',
    description:
      '推进复盘阶段。**human 周期不许跳步**：planned→doing→checking→acting→done，五步都要走。\n'
      + 'agent 周期（智能体事后归纳）不需要逐步推进：直接 review 即可一次性提交并自动闭环。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expectedRev: { type: 'number' },
        phase: { type: 'string', enum: ['doing', 'checking', 'acting', 'done'] },
        progress: { type: 'number' },
        evidence: { type: 'string' },
      },
      required: ['id', 'phase'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.cycle) return failure('cycle-unavailable')
      try {
        return success({ cycle: s.cycle.advance({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'cycle-advance-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_cycle_check',
    description:
      '记录检查结果。pass 前进到 acting，reject 打回 doing 重做。\n'
      + '这是**人验货**的环节（human 周期用）；agent 归纳周期不走检查，别对它调这个。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expectedRev: { type: 'number' },
        result: { type: 'string', enum: ['pass', 'reject'] },
        evidence: { type: 'string' },
      },
      required: ['id', 'result'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.cycle) return failure('cycle-unavailable')
      try {
        return success({ cycle: s.cycle.check({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'cycle-check-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_cycle_review',
    description:
      '复盘（Act）：记录经验教训，并提议标准化建议（纪律/记忆）。建议走确认制，人采纳才落库。\n'
      + '**human 周期**：只能在 acting 阶段提交，提交后人显式推进到 done。\n'
      + '**agent 周期**（智能体定期归纳）：任意阶段可直接提交，提交即自动闭环 done（返回 autoClosed=true）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expectedRev: { type: 'number' },
        summary: { type: 'string', description: '复盘总结（≤8000）' },
        lessons: { type: 'array', items: { type: 'string' }, description: '经验教训（≤20 条）' },
        standards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scope: { type: 'string', enum: ['global', 'workspace', 'room', 'bot'] },
              scopeId: { type: 'string' },
              kind: { type: 'string', enum: ['rule', 'requirement', 'principle', 'style'] },
              title: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['scope', 'kind', 'title', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['id', 'summary'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.cycle) return failure('cycle-unavailable')
      try {
        return success(s.cycle.review({ ...a, by: callerOf(exec) }))
      } catch (error) {
        return failure(error?.code ?? 'cycle-review-failed', { message: error?.message ?? String(error) })
      }
    },
  },

  // ── PDCA-3：测量（metrics）────────────────────────────────────────────────
  {
    name: 'bot_metrics_record',
    description: '记一条 PDCA 测量指标（cycle_start/accept_pass/accept_reject/task_claim 等）。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['cycle_start', 'cycle_complete', 'review_proposed', 'review_done',
            'accept_pass', 'accept_reject', 'task_claim', 'task_complete', 'task_blocked',
            'lead_create', 'bot_create', 'room_create', 'turn_end'],
        },
        taskId: { type: 'string' },
        cycleId: { type: 'string' },
        sessionId: { type: 'string' },
        value: { type: 'number' },
        labels: { type: 'object' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.metrics) return failure('metrics-unavailable')
      try {
        return success({ record: s.metrics.record({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'metrics-record-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_metrics_aggregate',
    description: '聚合测量指标：按 kind 计数 + 求和 + 首末时间。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        since: { type: 'number', description: 'epoch ms' },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.metrics) return failure('metrics-unavailable')
      return success({ aggregate: s.metrics.aggregate(a ?? {}) })
    },
  },

  // ── PDCA-2：验收证据 ──────────────────────────────────────────────────────
  {
    name: 'bot_verify_evaluate',
    description: '对一组产出路径做存在性检查（机器证据，不接受"我完成了"）。',
    parameters: {
      type: 'object',
      properties: {
        artifacts: { type: 'array', items: { type: 'string' }, description: '产出文件路径' },
      },
      required: ['artifacts'],
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.verify) return failure('verify-unavailable')
      return success(s.verify.evaluate(a?.artifacts ?? []))
    },
  },

  // ── 大/小团队 ──────────────────────────────────────────────────────────────
  {
    name: 'bot_teams_create',
    description: '创建一个团队。big 团队（人建的）必须带 leadId；small 团队（智能体自建的）leadId 可选。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['big', 'small'] },
        purpose: { type: 'string' },
        memberIds: { type: 'array', items: { type: 'string' } },
        leadId: { type: 'string' },
      },
      required: ['name', 'type'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.teams) return failure('teams-unavailable')
      try {
        return success({ team: s.teams.create({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'teams-create-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_teams_list',
    description: '列出团队（按类型/状态过滤）。大团队是人建的稳定结构，小团队是智能体自建的临时小组。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['big', 'small'] },
        status: { type: 'string', enum: ['open', 'closed'] },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.teams) return failure('teams-unavailable')
      return success({ teams: s.teams.list(a ?? {}) })
    },
  },
  {
    name: 'bot_teams_add',
    description: '向团队添加成员（需带 expectedRev 做 CAS）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expectedRev: { type: 'number' },
        memberId: { type: 'string' },
      },
      required: ['id', 'memberId'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.teams) return failure('teams-unavailable')
      try {
        return success({ team: s.teams.addMember({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'teams-add-failed', { message: error?.message ?? String(error) })
      }
    },
  },

  // ── 任务订阅（改造07 · 借鉴 Super-agent Subscription 扇出）──────────────────
  {
    name: 'bot_task_subscribe',
    description:
      '让一个任务订阅某个房间：该房间的**后续消息自动到达这个任务**（作为上下文），'
      + '不需要再 @ Bot。只加上下文，**不改变任务状态、不授予开工权力**。幂等：重复订阅返回既有记录。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id' },
        roomId: { type: 'string', description: '房间 id' },
        note: { type: 'string', description: '可选备注（为什么订阅）' },
      },
      required: ['taskId', 'roomId'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.subscription) return failure('subscription-unavailable')
      try {
        return success({ sub: s.subscription.subscribe({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'subscribe-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_task_unsubscribe',
    description: '取消任务的房间订阅（终态，不可恢复；需要时重新订阅）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '订阅 id（不是 taskId）' },
        expectedRev: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (s, a, exec) => {
      if (!s.subscription) return failure('subscription-unavailable')
      try {
        return success({ sub: s.subscription.unsubscribe({ ...a, by: callerOf(exec) }) })
      } catch (error) {
        return failure(error?.code ?? 'unsubscribe-failed', { message: error?.message ?? String(error) })
      }
    },
  },
  {
    name: 'bot_task_subscriptions',
    description: '查看订阅：按 taskId / roomId / state 过滤。任务详情用 taskId 拉「订阅了什么」。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        roomId: { type: 'string' },
        state: { type: 'string', enum: ['active', 'dropped'] },
      },
      additionalProperties: false,
    },
    run: (s, a) => {
      if (!s.subscription) return failure('subscription-unavailable')
      try {
        return success({
          subs: s.subscription.list(a ?? {}),
          stats: s.subscription.stats(),
        })
      } catch (error) {
        return failure(error?.code ?? 'subscriptions-failed', { message: error?.message ?? String(error) })
      }
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
