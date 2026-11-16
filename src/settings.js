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
import { sanitizeDirSegment } from './botdirs.js'
import { homedir } from 'node:os'

/** 设置项定义：默认值 + 校验。 */
export const SETTING_SPECS = Object.freeze({
  // ── 部门字典 + 默认部门（2026-11-13 Boss 需求）──────────────────────────
  //
  // ⚠️ 主目录**复用已有的 `botWorkspaceRoot`**（见文件末尾），不另设 `botsRoot`。
  //    `botWorkspaceRoot` 的默认值正好是 `<$DSH_HOME 父目录>/cs-bots`，
  //    即 Boss 说的「大楼」。重复造一个字段只会让两处配置漂移。
  //
  // 部门字典：`[{ id: 'dev', name: '开发部' }]`。
  // `id` 用作目录名（英文、短、URL 安全），`name` 用作显示（中文）。
  // 保序（用户可拖拽排序）⇒ 用数组不用对象。
  // 部门列表。
  //
  // ⚠️ 2026-11-16 Boss 定：**不内置任何部门**，全部由用户自己建。
  //   之前写死了 dev/qa/ops 三个，后果是：
  //     · 用户看到一堆自己没建过的部门，不知道哪来的
  //     · 「待归类 misc」这种内部兜底目录也被当成部门展示
  //   ⇒ 默认空数组。用户第一次进「部门」页时自己加。
  departments: {
    def: [],
    departments: true,
    label: '部门',
  },

  // 新建 Bot 时预选的部门 id（必须是 departments 里存在的）
  // 默认部门 id。**不写死白名单** —— 部门是用户可增删的字典，
  // 写死 options 会导致「用户新增部门后设不成默认」。
  // 「是否存在」由 `validateDepartmentsPatch` 交叉校验（见 validateSetting 末尾）。
  // ⚠️ 没有内置部门了，默认值也跟着空 —— 否则「默认部门 dev」指向一个不存在的部门。
  defaultDepartment: { def: '', departmentRef: true, label: '默认部门' },

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
  // 2026-11-15 Boss 定：**不再用同级目录，改为 $DSH_HOME 的下级**
  //   旧：`<DSH_HOME 的父级>/cs-bots`   → C:\Users\你\cs-bots
  //   新：`<DSH_HOME>/cs-bots`          → C:\Users\你\.dsh\cs-bots
  // 目录名仍是 `cs-bots`。
  return join(resolve(dshHomeDir()), 'cs-bots')
}

/**
 * 定位 `$DSH_HOME`（宿主数据目录）。
 *
 * ## ⚠️ 跨平台（2026-11-15 Windows 实测踩坑）
 *
 *   原实现是 `process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh``。
 *   **Windows 上没有 `HOME` 环境变量**（用的是 `USERPROFILE`），
 *   于是退化成 `'.'` ⇒ `resolve('.', '.dsh')` = **当前工作目录下的 .dsh**，
 *   跟着启动目录乱跑 ⇒ 默认主目录算错 ⇒ 左侧栏分组登记到不存在的地方。
 *
 *   ⇒ 按平台优先级逐个试：DSH_HOME → USERPROFILE（Win）→ HOME（*nix）→ os.homedir() → '.'。
 *
 * @returns {string} 绝对路径
 */
function dshHomeDir() {
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim()) return resolve(explicit.trim())
  const candidates = [
    process.env.USERPROFILE,     // Windows
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`   // Windows 旧式
      : '',
    process.env.HOME,            // macOS / Linux
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return resolve(c.trim(), '.dsh')
  }
  // 最后兜底：Node 自己知道用户主目录（跨平台，Win 上是 C:\Users\<你>）
  try {
    const h = homedir()
    if (typeof h === 'string' && h.trim()) return resolve(h, '.dsh')
  } catch { /* 继续 */ }
  return resolve('.dsh')
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

  // ── 部门字典类型：`[{ id, name }]`，id 必须唯一且是安全的目录名 ────────
  if (spec.departments) {
    if (!Array.isArray(raw)) return { ok: false, reason: `${key} 必须是数组` }
    const out = []
    const seen = new Set()
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: `${key} 的每一项必须是 { id, name }` }
      }
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (!id || !name) return { ok: false, reason: `${key} 的每一项都必须有非空 id 与 name` }
      // id 会**直接当目录名**用 ⇒ 必须过目录名安全检查（防 ../ 与路径分隔符）
      const safe = sanitizeDirSegment(id)
      if (safe !== id) {
        return {
          ok: false,
          reason: `${key}.id=${JSON.stringify(id)} 不是安全的目录名（只允许字母数字中文与 - _，且不能是 . 或 ..）`
            + `${safe ? `；建议改为 ${JSON.stringify(safe)}` : ''}`,
        }
      }
      if (seen.has(id)) return { ok: false, reason: `${key} 里 id 重复：${id}` }
      seen.add(id)
      // 部门主管（2026-11-16 Boss：「需要人工设置」，不能拿第一个 Bot）
      //   存的是 **Bot 名字**（比 sessionId 稳定：重建 Bot 会换 sessionId，名字不变）
      //   空/null = 该部门暂无主管 ⇒ 群聊发言时唤醒全部成员
      const leadRaw = item.leadBotName
      let leadBotName = null
      if (leadRaw !== undefined && leadRaw !== null) {
        if (typeof leadRaw !== 'string') {
          return { ok: false, reason: `${key}.leadBotName 必须是字符串或 null` }
        }
        leadBotName = leadRaw.trim() || null
      }
      out.push({ id, name, ...(leadBotName ? { leadBotName } : {}) })
    }
    return { ok: true, value: out }
  }

  // 部门引用：非空字符串（存在性在跨字段校验里做，单独 validate 时无从得知字典）
  if (spec.departmentRef) {
    // 允许空字符串 = 「没有默认部门」（2026-11-16：取消内置部门后，
    // 新装用户一个部门都没有，此时「默认部门」只能为空）。
    if (typeof raw !== 'string') {
      return { ok: false, reason: `${key} 必须是字符串` }
    }
    return { ok: true, value: raw.trim() }
  }

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
    // 工作区目录：必须是绝对路径。
    //
    // ⚠️ 2026-11-15 Boss 定：**取消「不得落在 $DSH_HOME 内」这条限制**。
    //   原因：默认值本身就改成 `<DSH_HOME>/cs-bots` 了，再禁 $DSH_HOME 子树
    //   就等于「默认值自己不合法」。
    //   旧限制的担心（宿主数据/凭据被 Bot 写坏）依然成立，但既然用户主动选了
    //   `.dsh\cs-bots` 这个专用子目录，就尊重这个选择 —— 它跟 sessions/storages
    //   是平级隔离的，不是混在同一处。
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, reason: '工作区必须是非空字符串' }
    }
    const rawTrim = raw.trim()
    if (!isAbsolute(rawTrim)) {
      return { ok: false, reason: '工作区必须是绝对路径' }
    }
    return { ok: true, value: resolve(rawTrim) }
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

  // ── 首次引导标记（2026-11-15 Boss：首次进入要提示选定工作区）──────────────
  //
  // 判据：设置文件里**没有写 botWorkspaceRoot 这个键** ⇒ 说明用户从没选过。
  //   注意不能只看 `values.botWorkspaceRoot` —— 它有默认值，永远非空，
  //   那样永远判断不出「没选过」。
  //   也不能只看 diagnostics.source（用户可能改过别的设置、但没动主目录）。
  const hasExplicitRoot = Boolean(
    stored && typeof stored === 'object'
    && typeof stored.botWorkspaceRoot === 'string' && stored.botWorkspaceRoot.trim() !== '',
  )
  diagnostics.needsOnboarding = !hasExplicitRoot
  diagnostics.defaultRoot = values.botWorkspaceRoot
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
