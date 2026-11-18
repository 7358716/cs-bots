/**
 * ws-hierarchy.js —— 三级工作区登记（主目录 → 部门 → Bot），0.20.0
 *
 * ## 它解决什么（2026-11-18 Boss Win 截图）
 *
 *   Boss：「没有出现 cs-bots 主目录，我要求三级展示：部门目录在 cs-bots 主目录下，
 *          bot 工作区在部门目录下」
 *
 *   截图里的实际左树：`misc / ops / qa / dev` 四个**平级空文件夹**，
 *   既没有主目录，也没有 Bot。原因不是「宿主不嵌套」，而是：
 *     · 三级登记逻辑只藏在「整理工作区」一个按钮里（api.js）
 *     · 建 Bot / 换部门 / 导入这三条路径**一次都不登记**
 *     · 导入根本不会建 Bot（transfer.js 只产出 plan 不落地）
 *
 * ## 设计约束（每条都对应一次真实事故）
 *
 *   1. **串行 + 全局锁**：2026-11-15 `workspace domain is inconsistent`
 *      就是启动时并发 create 把同一路径注册两次造成的（5 个组件 pending、
 *      页面登录不了）。本文件所有写操作都必须经过调用方提供的 `lock`。
 *   2. **磁盘优先判重**：`registry.resolveByPath` 读的是内存态 `entities`，
 *      在 workspace 域初始化期间不可靠。建之前先读 `workspace.json`。
 *   3. **目录必须先 mkdir**：`registry.create` 第一行是 `realpath`，
 *      目录不存在直接抛（Win 首次安装的主坑）。
 *   4. **不挂会话**：只建分组容器。会话归属交给宿主在新会话创建时处理。
 *   5. **失败降级，绝不抛穿**：拿不到 `workspaceRegistry`（老宿主/域未就绪）
 *      ⇒ 返回 `degraded:true` + 原因，业务主流程照常走完。
 *   6. **retired 的 Bot 不登记分组**（Boss 2026-11-18 第 3 条），目录保留。
 *
 * 依赖面：node 内置 + kernel.js 的 `ensureWorkspaceDir` / `listWorkspaceRecords`。
 * 所有路径比较走 `paths-cross.js`（Win 大小写/分隔符归一）。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ensureWorkspaceDir, listWorkspaceRecords } from './kernel.js'
import { normPath, isInside, pathsEqual, displayPath, checkSegment } from './paths-cross.js'

/** 主目录下的「引导目录」：不是部门，不该出现在左侧栏。 */
export const NON_DEPT_DIRS = new Set(['archive', 'shared', 'scratch', 'node_modules', '.git'])

/**
 * 在全局串行锁里跑一段异步逻辑。
 *
 * 为什么不用 `Promise.all`：见文件头约束 1。
 * 锁挂在 `globalThis` 上，因为宿主可能热重载插件模块 ⇒ 模块级变量会被重置，
 * 而 globalThis 不会（这是 0.10.2 事故后定下来的做法）。
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withWsLock(fn) {
  const KEY = '__csBotsWorkspaceRegLock'
  const prev = globalThis[KEY] ?? Promise.resolve()
  let release
  globalThis[KEY] = new Promise((r) => { release = r })
  try {
    await prev
    return await fn()
  } finally {
    release()
  }
}

/** 取宿主 workspaceRegistry（拿不到返回 undefined，不抛）。 */
function registryOf(ctx) {
  try {
    const reg = ctx?.get?.('workspaceRegistry') ?? ctx?.reflect?.get?.('workspaceRegistry')
    return reg && typeof reg.create === 'function' ? reg : undefined
  } catch {
    return undefined
  }
}

/** 磁盘上是否已有这条登记（`workspace.json` 是唯一不会被内存态欺骗的真相源）。 */
function inWorkspaceFile(dir) {
  try {
    return listWorkspaceRecords().some((w) => pathsEqual(w.path, dir))
  } catch {
    return false
  }
}

/** 确保目录存在（失败返回 false，不抛）。 */
function ensureDirExists(dir) {
  try {
    if (existsSync(dir)) return true
    mkdirSync(dir, { recursive: true })
    return existsSync(dir)
  } catch {
    return false
  }
}

/**
 * 登记一个目录为 Workspace 分组（幂等，串行由调用方保证）。
 *
 * @param {object} ctx
 * @param {string} dir 绝对路径
 * @param {string} [title] 显示名（部门用中文名）
 * @returns {Promise<{ ok: boolean, created?: boolean, reason?: string }>}
 */
async function registerOne(ctx, dir, title) {
  const reg = registryOf(ctx)
  if (!reg) return { ok: false, reason: '宿主未提供 workspaceRegistry' }
  // 约束 3：先建目录
  if (!ensureDirExists(dir)) return { ok: false, reason: `目录不存在且创建失败：${displayPath(dir)}` }
  // 约束 2：磁盘优先
  if (inWorkspaceFile(dir)) {
    // 已登记：顺手对齐 title（部门改名后左侧栏要跟着变）
    if (typeof title === 'string' && title.trim()) {
      try {
        const ent = await reg.resolveByPath?.(dir)
        if (ent && typeof ent.setTitle === 'function' && ent.title !== title.trim()) {
          await ent.setTitle(title.trim())
        }
      } catch { /* 改名失败不影响「已登记」这个事实 */ }
    }
    return { ok: true, created: false }
  }
  try {
    const r = await ensureWorkspaceDir(ctx, dir, title)
    return r?.ok ? { ok: true, created: Boolean(r.created) } : { ok: false, reason: r?.reason ?? '未知原因' }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 算出某个 Bot 应该住在哪 —— **与 `botdirs.deriveBotCwd` 同口径**，
 * 但导入/迁移场景下允许「部门不在字典里」时仍能给出候选路径（带 `deptMissing` 标记）。
 *
 * @param {{ root: string, deptId: string, botName: string }} input
 * @returns {{ ok: boolean, cwd?: string, reason?: string }}
 */
export function planBotCwd({ root, deptId, botName }) {
  if (!root || typeof root !== 'string') return { ok: false, reason: '主目录未设置' }
  const d = checkSegment(deptId)
  if (!d.ok) return { ok: false, reason: `部门 id 不合法：${d.hint}` }
  const b = checkSegment(botName)
  if (!b.ok) return { ok: false, reason: `Bot 名不合法：${b.hint}` }
  const abs = resolve(root)
  return { ok: true, cwd: join(abs, d.value, b.value) }
}

/**
 * **核心入口**：为单个 Bot 建齐三级目录与三级分组。
 *
 * 顺序固定：主目录 → 部门目录 → Bot 目录，逐级 await（约束 1）。
 * 任何一级失败都不阻断后续（降级继续），最终用 `steps` 如实汇报。
 *
 * @param {object} ctx
 * @param {{
 *   root: string,
 *   deptId: string,
 *   deptName?: string,
 *   botCwd: string,
 *   botName?: string,
 *   registerBot?: boolean,   // false = 只建目录不登记（retired Bot）
 * }} input
 * @returns {Promise<{ ok: boolean, degraded: boolean, steps: Array<object>, hint?: string }>}
 */
export async function ensureBotHierarchy(ctx, input) {
  const { root, deptId, deptName, botCwd, botName, registerBot = true } = input ?? {}
  /** @type {Array<{level: string, path: string, ok: boolean, created?: boolean, reason?: string}>} */
  const steps = []
  let degraded = false

  if (!root || typeof root !== 'string' || !resolve(root)) {
    return { ok: false, degraded: false, steps, hint: '主目录未设置 —— 先到「设置 → Bot 主目录」指定' }
  }
  const rootAbs = resolve(root)
  const reg = registryOf(ctx)
  if (!reg) {
    degraded = true
    steps.push({ level: 'root', path: rootAbs, ok: false, reason: '宿主未提供 workspaceRegistry（域未就绪）' })
    return {
      ok: false,
      degraded,
      steps,
      hint: '工作区服务尚未就绪：目录仍会创建，但左侧栏分组这次跳过；稍后可在「Bot 档案」点「重建分组」',
    }
  }

  // ① 主目录
  const st1 = await registerOne(ctx, rootAbs, 'cs-bots')
  steps.push({ level: 'root', path: rootAbs, ...st1 })

  // ② 部门目录（id 非法就停在这一级，但仍然返回可读原因）
  if (deptId) {
    const deptDir = join(rootAbs, deptId)
    const st2 = await registerOne(ctx, deptDir, deptName || deptId)
    steps.push({ level: 'dept', path: deptDir, ...st2 })
  }

  // ③ Bot 目录
  if (botCwd) {
    const botAbs = resolve(botCwd)
    // 只在主目录**之内**才登记（外来的 cwd 不碰，避免多出平铺分组）
    if (!isInside(rootAbs, botAbs) && !pathsEqual(rootAbs, botAbs)) {
      steps.push({
        level: 'bot', path: botAbs, ok: false, skipped: true,
        reason: `cwd 不在主目录下（${displayPath(rootAbs)}），不建也不登记`,
      })
    } else if (!registerBot) {
      ensureDirExists(botAbs)
      steps.push({
        level: 'bot', path: botAbs, ok: true, created: false,
        reason: '已退役 —— 目录保留，但不在左侧栏显示分组',
      })
    } else {
      const st3 = await registerOne(ctx, botAbs, botName)
      steps.push({ level: 'bot', path: botAbs, ...st3 })
    }
  }

  const ok = steps.every((s) => s.ok)
  const failed = steps.filter((s) => !s.ok)
  return {
    ok,
    degraded: degraded || failed.length > 0,
    steps,
    ...(failed.length
      ? { hint: `以下步骤没成功：${failed.map((s) => `${s.level}（${displayPath(s.path)}）：${s.reason ?? '未知'}`).join('；')}` }
      : {}),
  }
}

/**
 * 只读体检：算出「磁盘上有、但 `workspace.json` 里没有」的登记缺口。
 *
 * **不写任何东西** —— 启动时只跑这个（约束 5 的配套：把不可控副作用挪出启动路径）。
 *
 * @param {{ root: string, departments: Array<{id: string, name?: string}>, bots: Array<{name: string, cwd: string, state?: string}> }} input
 * @returns {{
 *   root: string, rootExists: boolean, rootRegistered: boolean,
 *   departments: Array<{ id: string, name?: string, dirExists: boolean, registered: boolean, bots: number, botsRegistered: number }>,
 *   missing: Array<{ level: string, path: string, hint?: string }>,
 *   hint?: string,
 * }}
 */
export function inspectHierarchy({ root, departments, bots }) {
  const rootAbs = root && typeof root === 'string' ? resolve(root) : ''
  const records = (() => { try { return listWorkspaceRecords() } catch { return [] } })()
  const registered = (dir) => records.some((w) => pathsEqual(w.path, dir))

  const deptList = Array.isArray(departments) ? departments.filter((d) => d && d.id) : []
  const botList = Array.isArray(bots) ? bots.filter((b) => b && typeof b.cwd === 'string' && b.cwd) : []
  const missing = []

  if (!rootAbs) {
    return { root: '', rootExists: false, rootRegistered: false, departments: [], missing, hint: '主目录未设置' }
  }
  const rootExists = existsSync(rootAbs)
  const rootRegistered = registered(rootAbs)
  if (!rootExists) missing.push({ level: 'root', path: rootAbs, hint: '主目录不存在' })
  else if (!rootRegistered) missing.push({ level: 'root', path: rootAbs, hint: '主目录还没登记为工作区分组' })

  // 部门 = 字典里的 ∪ 实际有 Bot 的一级目录
  const ids = new Set(deptList.map((d) => d.id))
  for (const b of botList) {
    if (!isInside(rootAbs, b.cwd)) continue
    const rel = normPath(b.cwd).slice(normPath(rootAbs).length + 1)
    const first = rel.split('/')[0]
    if (first && !NON_DEPT_DIRS.has(first)) ids.add(first)
  }

  const depts = []
  for (const id of ids) {
    if (NON_DEPT_DIRS.has(id)) continue
    const dir = join(rootAbs, id)
    const dirExists = existsSync(dir)
    const reg = registered(dir)
    const inDept = botList.filter((b) => isInside(dir, b.cwd))
    let botsRegistered = 0
    for (const b of inDept) if (registered(b.cwd)) botsRegistered += 1
    depts.push({
      id,
      name: deptList.find((d) => d.id === id)?.name,
      dirExists,
      registered: reg,
      bots: inDept.length,
      botsRegistered,
    })
    if (!dirExists) missing.push({ level: 'dept', path: dir, hint: `部门目录不存在（${id}）` })
    else if (!reg) missing.push({ level: 'dept', path: dir, hint: `部门「${deptList.find((d) => d.id === id)?.name ?? id}」还没分组` })
    for (const b of inDept) {
      if (!registered(b.cwd)) {
        missing.push({ level: 'bot', path: b.cwd, hint: `Bot「${b.name}」还没分组` })
      }
    }
  }

  return {
    root: rootAbs,
    rootExists,
    rootRegistered,
    departments: depts,
    missing,
    ...(missing.length
      ? { hint: `有 ${missing.length} 项还没进左侧栏 —— 到「Bot 档案 → 重建分组」一键补（幂等，可重复点）` }
      : { hint: '三级结构完整' }),
  }
}

/**
 * 批量补登记（「重建分组」按钮的实现，幂等）。
 *
 * 与 `inspectHierarchy` 配合：先体检，再按清单补。**不删任何登记**。
 *
 * @param {object} ctx
 * @param {{
 *   root: string,
 *   departments: Array<{id: string, name?: string}>,
 *   bots: Array<{name: string, cwd: string, state?: string}>,
 * }} input
 * @returns {Promise<{ ok: boolean, fixed: number, skipped: number, failed: Array<{path: string, reason: string}>, degraded: boolean }>}
 */
export async function repairHierarchy(ctx, { root, departments, bots }) {
  const report = { ok: false, fixed: 0, skipped: 0, failed: [], degraded: false }
  const rootAbs = root && typeof root === 'string' ? resolve(root) : ''
  if (!rootAbs) return { ...report, failed: [{ path: '', reason: '主目录未设置' }] }
  const deptList = Array.isArray(departments) ? departments.filter((d) => d && d.id) : []
  const botList = Array.isArray(bots) ? bots.filter((b) => b && b.cwd) : []

  return withWsLock(async () => {
    // ① 主目录
    const r1 = await registerOne(ctx, rootAbs, 'cs-bots')
    if (r1.ok) { if (r1.created) report.fixed += 1; else report.skipped += 1 } else { report.failed.push({ path: rootAbs, reason: r1.reason ?? '未知' }); report.degraded = true }

    // ② 部门（字典 ∪ 有 Bot 的一级目录）
    const ids = new Set(deptList.map((d) => d.id))
    for (const b of botList) {
      if (!isInside(rootAbs, b.cwd)) continue
      const rel = normPath(b.cwd).slice(normPath(rootAbs).length + 1)
      const first = rel.split('/')[0]
      if (first && !NON_DEPT_DIRS.has(first)) ids.add(first)
    }
    for (const id of ids) {
      if (NON_DEPT_DIRS.has(id)) continue
      const dir = join(rootAbs, id)
      const r = await registerOne(ctx, dir, deptList.find((d) => d.id === id)?.name || id)
      if (r.ok) { if (r.created) report.fixed += 1; else report.skipped += 1 } else { report.failed.push({ path: dir, reason: r.reason ?? '未知' }); report.degraded = true }
    }

    // ③ Bot（retired 不登记分组）
    for (const b of botList) {
      if (!isInside(rootAbs, b.cwd)) continue
      if (b.state === 'retired') { ensureDirExists(resolve(b.cwd)); report.skipped += 1; continue }
      const r = await registerOne(ctx, resolve(b.cwd), b.name)
      if (r.ok) { if (r.created) report.fixed += 1; else report.skipped += 1 } else { report.failed.push({ path: resolve(b.cwd), reason: r.reason ?? '未知' }); report.degraded = true }
    }

    report.ok = report.failed.length === 0
    return report
  })
}

export { displayPath, isInside, pathsEqual }