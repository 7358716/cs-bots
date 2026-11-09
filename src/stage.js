/**
 * cs-bots StageService —— 工单执行阶段机（改造07 · 借鉴 Super-agent 的 stage table）。
 *
 * ## 为什么需要它
 *
 * 现有任务状态只有 5 个粗粒度值（pending / in_progress / completed / blocked / deleted），
 * 它回答的是「这个任务还在不在做」，但**回答不了「此刻卡在谁身上」**。
 * 实测痛点：任务显示 in_progress 十几小时纹丝不动，人不知道为什么——
 * 是 Bot 在跑？在排队？在等人回答？还是投递失败没人知道？
 *
 * Super-agent 的 stage table 把「在做」切成 7 个可判定的阶段，
 * 其中 4 个是「等人」（person/*），人一眼就能看出**该我动手了**。
 *
 * ## 三条铁律
 *
 * 1. **纯函数、无副作用**：阶段永远由 (Task, 最新报告, 投递状态) 派生，不落盘。
 *    落盘会让阶段与事实脱钩（磁盘上的阶段是历史，不是现在）。
 * 2. **表驱动、自上而下、首个命中**：与 Super-agent 的 stage table 同构，
 *    调换顺序就会改变语义，所以顺序写在常量里并由测试锁死。
 * 3. **绝不猜**：证据不足时落到 `working`（保守），绝不假装「等待人」骗人来看。
 *
 * ## 派生输入（全部可选，缺省按保守值）
 *
 * | 信号 | 来源字段 | 缺省 |
 * |---|---|---|
 * | 任务状态 | `task.status` | 必填 |
 * | 最新报告 | `task.latestReport` | 无 → 视为未报告 |
 * | 投递失败 | `task.delivery` | 无 → 视为投递正常 |
 * | 有无 Assignment | `task.ownerId` / `task.lease` | 无 → 未开工 |
 * | 是否被直接中止 | `task.blockedReason` | 无 → 未中止 |
 *
 * ## 依赖面
 *
 * 零依赖：只用 node 内置。不 import 任何 `@deepseek-ai/*`（CI 检查 1 覆盖）。
 */

/** 阶段枚举（值即稳定 id，落进 API 与前端文案，**不可改名**）。 */
export const STAGES = Object.freeze({
  PERSON_DELIVERY: 'person/delivery',
  PERSON_ANSWER: 'person/answer',
  PERSON_REVIEW: 'person/review',
  PERSON_BLOCKED: 'person/blocked',
  PERSON_FAILED: 'person/failed',
  WORKING_QUEUED: 'working/queued',
  IDLE: 'idle',
  WORKING: 'working',
})

/** 全部阶段（顺序 = 判定优先级，自上而下首个命中）。 */
export const STAGE_ORDER = Object.freeze([
  STAGES.PERSON_DELIVERY,
  STAGES.PERSON_ANSWER,
  STAGES.PERSON_REVIEW,
  STAGES.PERSON_BLOCKED,
  STAGES.PERSON_FAILED,
  STAGES.WORKING_QUEUED,
  STAGES.IDLE,
  STAGES.WORKING,
])

/** 阶段 → 人类可读标签（界面直接展示，不暴露 `/` 与英文）。 */
export const STAGE_LABEL = Object.freeze({
  [STAGES.PERSON_DELIVERY]: '投递失败',
  [STAGES.PERSON_ANSWER]: '等你回答',
  [STAGES.PERSON_REVIEW]: '等你验收',
  [STAGES.PERSON_BLOCKED]: '受阻等你',
  [STAGES.PERSON_FAILED]: '失败等你',
  [STAGES.WORKING_QUEUED]: '排队中',
  [STAGES.IDLE]: '空闲等触发',
  [STAGES.WORKING]: '正在干',
})

/**
 * 阶段 → 语义分组（前端配色与「是否要人」判定用）。
 * - `person`：必须人动手，否则永远不动 → 强调色
 * - `working`：机器在推进 → 常规色
 * - `idle`：可继续但无人在推 → 弱化色
 */
export const STAGE_GROUP = Object.freeze({
  [STAGES.PERSON_DELIVERY]: 'person',
  [STAGES.PERSON_ANSWER]: 'person',
  [STAGES.PERSON_REVIEW]: 'person',
  [STAGES.PERSON_BLOCKED]: 'person',
  [STAGES.PERSON_FAILED]: 'person',
  [STAGES.WORKING_QUEUED]: 'working',
  [STAGES.IDLE]: 'idle',
  [STAGES.WORKING]: 'working',
})

/** 报告取值枚举（Super-agent 的 Report 六态，映射到 cs-bots 的 latestReport）。 */
export const REPORT_STATES = Object.freeze([
  'progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped',
])

/**
 * 判定一个任务的执行阶段。
 *
 * @param {object} task 任务（board 的 Task 形状；只读，绝不修改）
 * @returns {{
 *   stage: string, label: string, group: 'person'|'working'|'idle',
 *   needsPerson: boolean, reason: string,
 * }}
 *
 * @example
 * deriveStage({ status: 'in_progress', ownerId: 'bot-a' })
 * // → { stage: 'working', label: '正在干', needsPerson: false, ... }
 */
export function deriveStage(task) {
  const t = task && typeof task === 'object' ? task : {}

  // 终态优先：已删除/已完成的任务没有「执行阶段」概念，直接给稳定结果，
  // 避免前端对终态任务显示出「等你验收」这类误导。
  if (t.status === 'deleted') {
    return result(STAGES.IDLE, '已删除（终态，无执行阶段）')
  }
  if (t.status === 'completed') {
    // 已完成但未验收 → 仍是「等人验收」，这是真实需要人动手的事。
    if (t.accepted !== true) return result(STAGES.PERSON_REVIEW, '已完成，等待验收')
    return result(STAGES.IDLE, '已完成且已验收')
  }

  // 1. 投递失败：最高优先级——它是「本该发生却没发生」的静默失败，
  //    人不处理就永远不会恢复，必须压过所有其它阶段。
  if (hasDeliveryFailure(t)) {
    return result(STAGES.PERSON_DELIVERY, `输入投递失败：${deliveryError(t)}`)
  }

  // 2. 等待回答：最新报告带结构化问题（Super-agent 的 Attention）。
  if (hasAttention(t)) {
    return result(STAGES.PERSON_ANSWER, '执行者提了问题，等你回答')
  }

  // 3. 受阻/失败：最新报告如此，且此后没有新的人类消息解锁。
  const report = reportState(t)
  if (report === 'blocked') return result(STAGES.PERSON_BLOCKED, '执行者报告受阻')
  if (report === 'failed') return result(STAGES.PERSON_FAILED, '执行者报告失败')

  // 4. 等待验收：报告 ready（交付物已就绪）。
  if (report === 'ready') return result(STAGES.PERSON_REVIEW, '交付物就绪，等你验收')

  // 5. 排队中：任务已激活但还没有人领（无 owner / 无租约）。
  if (!hasOwner(t)) {
    // 2026-11-09 现场：「建了任务、也指派给了 Bot，页面却只显示『排队中』」。
    // 指派（`assignee`）与持有（`ownerId` / 租约）是两件事：指派只是把活放到了
    // 某人名下，真正开工由对方 claim 产生租约。但「有人管」和「没人管」对用户
    // 是**完全不同的两件事**，不能都叫「排队中」——
    //   有 assignee ⇒ 已经有人负责，在等对方接活（可重试唤醒 / 换人）
    //   无 assignee ⇒ 真的没人管，需要先指派
    const assignee = typeof t.assignee === 'string' && t.assignee.trim() !== '' ? t.assignee.trim() : ''
    if (assignee) {
      return result(STAGES.WORKING_QUEUED, `已指派给 ${shortId(assignee)}，等待对方接活`)
    }
    return result(STAGES.WORKING_QUEUED, '尚未指派，等待分配给某个 Bot')
  }

  // 6. 空闲：有人领、但最新报告是 waiting，说明这一轮干完了，等新触发。
  if (report === 'waiting') return result(STAGES.IDLE, '执行者已交付本轮，等待新触发')

  // 7. 兜底：正在干（保守，不猜「等谁」）。
  return result(STAGES.WORKING, '执行者持有租约，正在推进')
}

/** 构造统一返回形状（保证四个字段恒存在，前端不用做 null 判断）。 */
function result(stage, reason) {
  const group = STAGE_GROUP[stage] ?? 'working'
  return {
    stage,
    label: STAGE_LABEL[stage] ?? stage,
    group,
    needsPerson: group === 'person',
    reason,
  }
}

/** 会话 id 缩写（`bot-6b654c19-…` → `6b654c19`）—— 页面上一行长文案要短。 */
function shortId(id) {
  const raw = String(id)
  const m = /^bot-([0-9a-f]{8})/.exec(raw)
  if (m) return m[1]
  return raw.length > 12 ? `${raw.slice(0, 12)}…` : raw
}

/** 是否有投递失败（`task.delivery` 存在且未被清除）。 */
function hasDeliveryFailure(t) {
  const d = t.delivery
  if (!d) return false
  // 约定：delivery 为对象且有 error 字段 = 最近一次投递失败且尚未被成功投递清除。
  return typeof d === 'object' && typeof d.error === 'string' && d.error.length > 0
}

/** 投递失败的可读原因。 */
function deliveryError(t) {
  const e = t.delivery?.error
  return typeof e === 'string' && e ? e : '未知原因'
}

/** 是否有待回答的问题（最新报告里带 attention 字段）。 */
function hasAttention(t) {
  const r = t.latestReport
  if (!r || typeof r !== 'object') return false
  const a = r.attention
  if (!a) return false
  // 支持两种形状：字符串（问题原文）与对象（{ question } / { text }）
  if (typeof a === 'string') return a.trim().length > 0
  if (typeof a === 'object') {
    const text = a.question ?? a.text ?? a.content
    return typeof text === 'string' && text.trim().length > 0
  }
  return false
}

/**
 * 最新报告的规范状态。
 * 支持字符串（`'ready'`）与对象（`{ state: 'ready' }` / `{ status }` / `{ report }`）三种历史形状，
 * 因为 latestReport 的写入方前后演进过，读侧必须宽容。
 */
function reportState(t) {
  const r = t.latestReport
  if (!r) return null
  if (typeof r === 'string') return REPORT_STATES.includes(r) ? r : null
  if (typeof r !== 'object') return null
  const s = r.state ?? r.status ?? r.report
  return typeof s === 'string' && REPORT_STATES.includes(s) ? s : null
}

/** 是否有人持有（owner 或未过期租约任一存在即算）。 */
function hasOwner(t) {
  if (typeof t.ownerId === 'string' && t.ownerId.length > 0) return true
  const lease = t.lease
  if (!lease || typeof lease !== 'object') return false
  const exp = Number(lease.expiresAt)
  return Number.isFinite(exp) && exp > Date.now()
}

/**
 * 批量派生阶段（Board 列表页用；纯函数、不修改入参）。
 *
 * @param {object[]} tasks
 * @returns {Array<object & { stageInfo: object }>}
 */
export function attachStages(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  return list.map((t) => ({ ...t, stageInfo: deriveStage(t) }))
}

/**
 * 阶段统计（面板概览用）：按语义分组计数。
 *
 * @param {object[]} tasks
 * @returns {{ person: number, working: number, idle: number, total: number }}
 */
export function stageSummary(tasks) {
  const out = { person: 0, working: 0, idle: 0, total: 0 }
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.status === 'deleted') continue
    const s = deriveStage(t)
    out[s.group] = (out[s.group] ?? 0) + 1
    out.total += 1
  }
  return out
}

export default { STAGES, STAGE_ORDER, STAGE_LABEL, STAGE_GROUP, REPORT_STATES, deriveStage, attachStages, stageSummary }