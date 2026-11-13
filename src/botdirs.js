/**
 * Bot 目录派生 —— 「主目录 + 部门 + Bot 名」两级模型（2026-11-13 Boss 需求）。
 *
 * ## 需求原文
 *   「默认主目录由用户指定，安装完插件首次指定目录，创建 bot 时指定部门，
 *     在部门目录下自动建一个目录作为该 bot 的目录工作区」
 *
 * ## 派生规则
 *   `cwd = ${botsRoot}/${department.id}/${botName}`
 *
 *   例：主目录 `/home/ubuntu/cs-bots` + 部门 `dev` + Bot 名 `开发执行岗`
 *       ⇒ `/home/ubuntu/cs-bots/dev/开发执行岗`
 *
 * ## 为什么这个文件必须存在（而不是就地拼字符串）
 *
 *   实测（2026-11-13）：`path.join(root, dept, botName)` 不 sanitize 时——
 *   ```bash
 *   ⚠️ 穿越!  "../../etc" → /home/ubuntu/etc       ← 直接逃出大楼
 *   ⚠️ 穿越!  ".."        → /home/ubuntu/cs-bots   ← 逃出部门
 *   ```
 *   ⇒ 一个叫 `../../etc` 的 Bot 能把文件写到系统任何地方。
 *   **安全逻辑必须集中一处、且被测试覆盖**，不能散落在各调用点。
 *
 * ## 三层防护
 *   1. `sanitizeDirSegment`：把单个名字洗成安全目录名
 *   2. `deriveBotCwd`：拼完后**再校验前缀**（兜底，防规则有漏）
 *   3. 调用方 `assertBotCwd`：已有的一道（拒绝 `$DSH_HOME` 等）
 *
 * 依赖面：node 内置。零第三方依赖。
 */

import { isAbsolute, resolve, sep } from 'node:path'

/**
 * 把一个字符串洗成**安全的单层目录名**。
 *
 * 规则（按顺序）：
 *   1. 去掉路径分隔符 `/` 与 `\`（否则能多套一层）
 *   2. 去掉控制字符（\x00-\x1f，包括 \n \t）—— 它们会让路径莫名其妙
 *   3. 去掉 Windows 保留字符 `: * ? " < > |`
 *   4. 折叠连续空白为一个空格
 *   5. 去掉首尾空白与**首尾的点**（`.hidden` / `trailing.` 在某些系统上行为不同）
 *   6. 结果若是空、`.`、`..` ⇒ 返回 ''（由调用方决定回退策略）
 *
 * **刻意不做的事**：不转义中文、不限制长度（长度由上层 LIMITS 管）。
 * 中文目录名在 Linux/Windows/macOS 上都合法，转义反而让人看不懂自己建了什么。
 *
 * @param {string} raw
 * @returns {string} 安全目录名；无法得到安全名时返回 `''`
 */
export function sanitizeDirSegment(raw) {
  if (typeof raw !== 'string') return ''
  let v = raw
    // ① 分隔符：直接删掉而不是替换成 '-'，避免 "a/b" 变成 "a-b" 后与原名 "a-b" 撞车
    .replace(/[/\\]/g, '')
    // ② 控制字符
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    // ③ Windows 保留字符
    .replace(/[:*?"<>|]/g, '')
    // ④ 折叠空白
    .replace(/\s+/g, ' ')
    // ⑤ 首尾空白
    .trim()
  // ⑤ 首尾的点：`..` 是上级目录、`.` 是当前目录、`.x` 是隐藏文件，都不适合当 Bot 目录
  v = v.replace(/^\.+/, '').replace(/\.+$/, '').trim()
  // ⑥ 退化检查
  if (v === '' || v === '.' || v === '..') return ''
  return v
}

/**
 * 派生一个 Bot 的绝对工作目录，并做**前缀兜底校验**。
 *
 * @param {{ botsRoot: string, departments: Array<{id: string, name: string}>,
 *           department: string, botName: string }} input
 * @returns {{ ok: true, cwd: string, department: object, segment: string }
 *          | { ok: false, code: string, reason: string }}
 *
 * 失败码：
 *   - `BOT_ROOT_UNSET`        主目录未设置
 *   - `BOT_ROOT_NOT_ABSOLUTE` 主目录不是绝对路径
 *   - `BOT_DEPT_UNKNOWN`      部门不存在
 *   - `BOT_NAME_UNUSABLE`     Bot 名洗完后为空
 *   - `BOT_CWD_ESCAPED`       兜底：拼出的路径逃出了部门目录（不该发生，发生了就是有漏）
 */
export function deriveBotCwd(input) {
  const { botsRoot, departments, department, botName } = input ?? {}

  if (typeof botsRoot !== 'string' || botsRoot.trim() === '') {
    return { ok: false, code: 'BOT_ROOT_UNSET', reason: '尚未设置 Bot 主目录 —— 请先在设置里指定' }
  }
  const root = botsRoot.trim()
  if (!isAbsolute(root)) {
    return { ok: false, code: 'BOT_ROOT_NOT_ABSOLUTE', reason: `Bot 主目录必须是绝对路径，收到 ${JSON.stringify(root)}` }
  }

  const deptId = typeof department === 'string' ? department.trim() : ''
  if (!deptId) {
    return { ok: false, code: 'BOT_DEPT_UNKNOWN', reason: '必须指定部门' }
  }
  const list = Array.isArray(departments) ? departments : []
  const dept = list.find((d) => d && d.id === deptId)
  if (!dept) {
    const ids = list.map((d) => d?.id).filter(Boolean)
    return {
      ok: false,
      code: 'BOT_DEPT_UNKNOWN',
      reason: `部门 ${JSON.stringify(deptId)} 不存在（可选：${ids.length ? ids.join(' | ') : '（尚未配置任何部门）'}）`,
    }
  }

  const segment = sanitizeDirSegment(botName)
  if (!segment) {
    return {
      ok: false,
      code: 'BOT_NAME_UNUSABLE',
      reason: `Bot 名 ${JSON.stringify(botName)} 洗成安全目录名后为空 —— 请换一个名字（只含字母/数字/中文/-/_ 等）`,
    }
  }

  const rootAbs = resolve(root)
  const deptDir = resolve(rootAbs, dept.id)
  const cwd = resolve(deptDir, segment)

  // ── 兜底校验（第 2 层防护）──────────────────────────────────────────────
  // 即使 sanitize 有漏（比如未来加了新字符集），这一步也能拦住。
  // 判据：cwd 必须是 `${root}/${dept}/` 的**严格子孙**。
  const prefix = deptDir.endsWith(sep) ? deptDir : deptDir + sep
  if (!cwd.startsWith(prefix)) {
    return {
      ok: false,
      code: 'BOT_CWD_ESCAPED',
      reason: `派生出的路径 ${cwd} 逃出了部门目录 ${deptDir} —— 拒绝创建（这不该发生，请报告这个 Bot 名：${JSON.stringify(botName)}）`,
    }
  }

  return { ok: true, cwd, department: dept, segment }
}

/**
 * 从已有 cwd 反推它属于哪个部门（存量归位用）。
 *
 * @param {{ botsRoot: string, departments: Array<{id: string, name: string}>, cwd: string }} input
 * @returns {{ inside: boolean, department?: object, relative?: string }}
 */
export function departmentOfCwd(input) {
  const { botsRoot, departments, cwd } = input ?? {}
  if (typeof botsRoot !== 'string' || !botsRoot.trim() || typeof cwd !== 'string' || !cwd) {
    return { inside: false }
  }
  const rootAbs = resolve(botsRoot.trim())
  const cwdAbs = resolve(cwd)
  if (cwdAbs !== rootAbs && !cwdAbs.startsWith(rootAbs + sep)) return { inside: false }

  const rel = cwdAbs === rootAbs ? '' : cwdAbs.slice(rootAbs.length + 1)
  const head = rel.split(sep)[0] ?? ''
  const list = Array.isArray(departments) ? departments : []
  const dept = list.find((d) => d && d.id === head)
  if (!dept) return { inside: true, relative: rel }
  return { inside: true, department: dept, relative: rel.slice(head.length + 1) }
}
/**
 * 判断一个 Bot 的 cwd 是否「受主目录管理」。
 *
 * 受管 = 形状正好是 `<botsRoot>/<dept>/<叶子>`，且 `<dept>` 在部门字典里。
 * 这种 Bot 的**目录名就是 Bot 名的镜像** ⇒ 改名会造成脱节（见 `roster.rename` 注释）。
 *
 * 不受管的情况（仍允许改名，因为名字与目录本来就无关）：
 *   - 没设 `botsRoot`
 *   - cwd 不在 `botsRoot` 下
 *   - 层级不是正好两层（`<dept>/<name>`）
 *   - `<dept>` 不在部门字典里（用户手工放的）
 *
 * @param {{ botsRoot?: string, departments?: Array<{id: string}> }} config
 * @param {{ cwd?: string }} bot
 * @returns {boolean}
 */
export function isManagedCwd(config, bot) {
  const botsRoot = config?.botsRoot
  const cwd = bot?.cwd
  if (typeof botsRoot !== 'string' || !botsRoot.trim()) return false
  if (typeof cwd !== 'string' || !cwd) return false

  const rootAbs = resolve(botsRoot.trim())
  const cwdAbs = resolve(cwd)
  if (!cwdAbs.startsWith(rootAbs + sep)) return false

  const rel = cwdAbs.slice(rootAbs.length + 1).split(sep)
  if (rel.length !== 2) return false
  const list = Array.isArray(config?.departments) ? config.departments : []
  return list.some((d) => d && d.id === rel[0])
}
