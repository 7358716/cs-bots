/**
 * cs-bots /settings —— 平台设置（**持久化、且真正生效**）。
 *
 * 为什么单独一个文件：设置必须是**数据**而不是散落的魔法数。
 * 本文件的键会被 `index.js` 在装配时读取并传给各域服务，因此改设置=改行为
 *（内核级参数需重启 DSH 生效，UI 会明确标注）。
 *
 * 纪律：
 *   - **零依赖**：只用 node 内置 + store.js。
 *   - **缺文件用默认值**，坏文件**不静默**（返回 diagnostics 让 UI 显示）。
 *   - **写入前校验**：越界值一律拒绝并给可读原因（不写半坏配置）。
 */

import { readJson, writeJsonAtomic, ensureDir, statePath } from './store.js'
import { resolve, sep, isAbsolute, join } from 'node:path'

/** 设置项定义：默认值 + 校验。 */
export const SETTING_SPECS = Object.freeze({
  /** 任务默认占用时长（ms）：owner claim 后多久未心跳即视为失联。 */
  defaultLeaseMs: { def: 5 * 60_000, min: 10_000, max: 24 * 60 * 60_000, label: '任务占用默认时长（ms）' },
  /** 唤醒节流窗口（ms）：同一目标在窗内最多唤醒一次。 */
  throttleMs: { def: 5_000, min: 0, max: 60 * 60_000, label: '唤醒节流窗口（ms）' },
  /** 每目标唤醒队列上限（背压阈值）。 */
  maxWakesPerTarget: { def: 50, min: 1, max: 1000, label: '每目标唤醒队列上限' },
  /** 唤醒记录保留时长（ms）。 */
  wakeTtlMs: { def: 24 * 60 * 60_000, min: 60_000, max: 30 * 24 * 60 * 60_000, label: '唤醒记录保留（ms）' },
  /** 记忆单条上限（码点）。600 的依据：实测真实条目最长 826，ds-bot 的 300 会全拒收。 */
  memoryEntryMax: { def: 600, min: 100, max: 10_000, label: '记忆单条上限（字符）' },
  /** 超过该字符数的记忆条目在写入时自动切分（而非拒收）。 */
  memorySplitOnOverflow: { def: true, bool: true, label: '记忆超长自动切分' },
  /** K1 闸门：Bot 会话禁用 ask_user_question。关掉会让投递链有被堵风险。 */
  k1Enabled: { def: true, bool: true, label: 'K1：Bot 禁阻塞式提问' },
  // ── 记忆进化对等配置（2026-11-05，主管要求逐项核对）──
  /** 记忆审查调度：每 N 回合提醒模型做记忆自检。 */
  reviewEnabled: { def: true, bool: true, label: '记忆自审：启用' },
  /** 自审间隔（用户回合数）。 */
  reviewInterval: { def: 10, min: 1, max: 1000, label: '记忆自审间隔（回合）' },
  /** 自审模式：suggest=只提议，auto=自动执行（更安全）。 */
  reviewMode: { def: 'suggest', label: '记忆自审模式', options: ['suggest', 'auto'] },
  /** 技能审查：是否定期检查技能是否过期。 */
  skillReviewEnabled: { def: false, bool: true, label: '技能审查' },
  /** 技能单文件大小上限（字节）。 */
  skillMaxBytes: { def: 65536, min: 1024, max: 512 * 1024, label: '技能大小上限（字节）' },
  /** 记忆条目是否带日期前缀。 */
  entryDatePrefix: { def: true, bool: true, label: '记忆条目带日期前缀' },
  /** 渐进式披露：摘要模式 vs 全文模式。 */
  keyProgressiveDisclosure: { def: 'off', label: '渐进式披露', options: ['off', 'auto', 'on'] },
  /** auto 模式全量注入的条目数阈值。 */
  keyFullInjectThreshold: { def: 3, min: 1, max: 100, label: '全量注入条目数阈值' },
  /** auto 模式全量注入的字符阈值。 */
  keyFullInjectCharLimit: { def: 1500, min: 200, max: 10000, label: '全量注入字符阈值' },
  /** 每回合写入 duty 提醒：是否提醒模型该写记忆了。 */
  perTurnWrites: { def: true, bool: true, label: '每回合写入提醒' },
  /** 写入看门狗：连续 N 轮未写记忆时提醒。 */
  writeGuardThreshold: { def: 2, min: 1, max: 20, label: '写入看门狗阈值（轮）' },
  /** 写入看门狗开关。 */
  perTurnWriteGuard: { def: false, bool: true, label: '写入看门狗' },
  // ── P0-A：WIP 与 Feature Flag ──
  /** 每 Bot 同时 in_progress 任务上限。 */
  wipLimitPerBot: { def: 2, min: 1, max: 10, label: '每 Bot WIP 上限' },
  /** Feature Flag 集合：plain object，每个 value 必须是 boolean。 */
  featureFlags: { def: {}, object: true, label: 'Feature Flags' },
  // ── CS-BOTS 专用工作区（改造06）─────────────────────────────────────────
  /**
   * 新建 Bot 的默认目录：绝对路径，且必须落在 $DSH_HOME 之外（见 validateSetting）。
   *
   * 默认值**不写死**，而是「$DSH_HOME 的兄弟目录 `cs-bots`」——这是为了**通用性**：
   * 插件可能装在任意机器、任意用户下（`/home/alice`、`/Users/bob`、容器里 `/root`），
   * 写死 `/home/ubuntu/...` 会让其他用户的默认工作区指向一个不存在或无权的目录。
   *
   * 为什么是兄弟而不是 $DSH_HOME 内：`roster.js` 的 cwd 校验明确禁止 Bot 工作目录
   * 落在 $DSH_HOME 子树内（那是凭据/会话/记忆库所在，Bot 写进去 = 宿主数据污染）。
   * 兄弟目录既满足「放在主目录附近、一眼能找到」，又不越过那条安全线。
   *
   * 用户可在设置页改成任意绝对路径（只要不在 $DSH_HOME 内）。
   */
  botWorkspaceRoot: { def: defaultBotWorkspaceRoot(), path: true, label: 'CS-BOTS 专用工作区（新建 Bot 默认目录）' },
})

/**
 * 计算默认的 CS-BOTS 工作区根目录：`<$DSH_HOME 的父目录>/cs-bots`。
 *
 * 之所以暴露成函数：测试与 `GET /workspace` 需要知道「默认应该是哪」，
 * 避免在多处重复同一段 resolve 逻辑导致口径漂移。
 *
 * @returns {string} 归一化绝对路径
 */
export function defaultBotWorkspaceRoot() {
  const home = resolve(process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`)
  return join(resolve(home, '..'), 'cs-bots')
}

/** 默认设置。 */
export function defaultSettings() {
  const out = {}
  for (const [key, spec] of Object.entries(SETTING_SPECS)) out[key] = spec.def
  return out
}

/**
 * 校验单项设置。
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function validateSetting(key, raw) {
  const spec = SETTING_SPECS[key]
  if (!spec) return { ok: false, reason: `未知设置项：${key}` }
  // options 类型：字符串值，必须在白名单里
  if (spec.options) {
    if (typeof raw !== 'string') return { ok: false, reason: `${key} 必须是字符串` }
    if (!spec.options.includes(raw)) return { ok: false, reason: `${key} 非法：${raw}（可选：${spec.options.join(' | ')}）` }
    return { ok: true, value: raw }
  }
  if (spec.bool) {
    if (typeof raw !== 'boolean') return { ok: false, reason: `${key} 必须是布尔值` }
    return { ok: true, value: raw }
  }
  if (spec.object) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: `${key} 必须是 plain object` }
    }
    // 原型链检查：必须是 plain object
    if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) {
      return { ok: false, reason: `${key} 必须是 plain object` }
    }
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'boolean') {
        return { ok: false, reason: `${key}.${k} 必须是 boolean，得到 ${typeof v}` }
      }
    }
    return { ok: true, value: { ...raw } }
  }
  if (spec.path) {
    // 工作区目录：必须是绝对路径，且不得落在 $DSH_HOME 子树内
    //（那是宿主数据/凭据目录，Bot 写进去就是数据污染 —— 与 roster.js 的 cwd 校验同口径）。
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, reason: '工作区必须是非空字符串' }
    }
    const rawTrim = raw.trim()
    if (!isAbsolute(rawTrim)) {
      return { ok: false, reason: '工作区必须是绝对路径' }
    }
    const dir = resolve(rawTrim)
    const home = resolve(process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`)
    if (dir === home || dir.startsWith(home + sep)) {
      return { ok: false, reason: '工作区必须是 $DSH_HOME 之外的绝对路径' }
    }
    return { ok: true, value: dir }
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { ok: false, reason: `${key} 必须是数字` }
  if (n < spec.min || n > spec.max) {
    return { ok: false, reason: `${key} 越界：${n} 不在 [${spec.min}, ${spec.max}]` }
  }
  return { ok: true, value: n }
}

/**
 * 读取设置（缺文件/坏文件都退回默认值，并把诊断暴露出来）。
 * @param {string} stateDir
 * @returns {{ values: object, diagnostics: object }}
 */
export function loadSettings(stateDir) {
  const file = statePath(stateDir, 'settings.json')
  const stored = readJson(file, undefined)
  const values = defaultSettings()
  const diagnostics = { file, source: 'default', badKeys: [] }
  if (stored && typeof stored === 'object') {
    diagnostics.source = 'file'
    for (const [key, raw] of Object.entries(stored)) {
      const result = validateSetting(key, raw)
      if (result.ok) values[key] = result.value
      else diagnostics.badKeys.push({ key, raw, reason: result.reason })
    }
  } else if (stored !== undefined) {
    diagnostics.source = 'invalid'
  }
  return { values, diagnostics }
}

/**
 * 保存设置（只写校验过的键）。
 * @param {string} stateDir
 * @param {object} patch
 * @returns {{ ok: true, values: object } | { ok: false, reason: string }}
 */
export function saveSettings(stateDir, patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, reason: 'patch 必须是对象' }
  const rejected = []
  const accepted = {}
  for (const [key, raw] of Object.entries(patch)) {
    const result = validateSetting(key, raw)
    if (result.ok) accepted[key] = result.value
    else rejected.push(result.reason)
  }
  if (rejected.length) return { ok: false, reason: rejected.join('；') }

  if (!ensureDir(stateDir)) return { ok: false, reason: `状态目录不可写：${stateDir}` }
  const { values } = loadSettings(stateDir)
  const next = { ...values, ...accepted }
  if (!writeJsonAtomic(statePath(stateDir, 'settings.json'), next)) {
    return { ok: false, reason: '写入 settings.json 失败' }
  }
  return { ok: true, values: next }
}
