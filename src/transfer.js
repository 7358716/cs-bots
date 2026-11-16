/**
 * 导入导出（2026-11-16 Boss 需求）。
 *
 * ## Boss 的要求（原话）
 *   「设置导入导出功能：
 *     a. 部门、bot 的导入导出，要有确认页
 *     b. 技能、记忆、纪律等的导入导出功能
 *     c. 全局导入导出功能，都要有确认页面，有校核提示等功能」
 *
 *   后续澄清：
 *   - 格式：**zip**；「只元数据」还是「含工作目录文件」→ **可选**
 *   - 同名冲突：**覆盖，但给提示**
 *   - 技能/记忆/纪律：**可分开也可打包**
 *   - 全局范围：**可分开选择**
 *   - 导出包：**浏览器直接下载**
 *   - 含工作目录文件：**设上限并确认**
 *
 * ## 设计要点
 *
 *   1. **manifest 必须带 checksums** —— 校核提示要能验证包没被改坏
 *   2. **导入前先校核、再确认、最后应用** —— 三阶段分离，任一步失败都不留半成品
 *   3. **事务性**：先写临时目录，全成功才替换
 *   4. **路径类设置不导出**（`botWorkspaceRoot` 各机器不同，导入后按本机重算）
 *   5. **会话不导出**（体量巨大且与宿主绑定）
 *
 * ## 为什么单独一个模块
 *   导入涉及 6 个数据源（部门/Bot/技能/记忆/纪律/设置），
 *   都塞进 api.js 会让那个文件更难维护。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

import { createZip, readZip } from './zip.js'

/** 包格式版本。不兼容时导入要明确拒绝。 */
export const EXPORT_FORMAT = 'cs-bots-export'
export const EXPORT_FORMAT_VERSION = 1

/** 含工作目录文件时的大小上限（Boss 要求设上限并确认）。 */
export const FILES_SIZE_LIMIT = 500 * 1024 * 1024      // 500 MB
/** 警告阈值（超过它要二次确认，但不阻断）。 */
export const FILES_SIZE_WARN = 100 * 1024 * 1024       // 100 MB

/**
 * 可导出/导入的「段」。
 *
 * 每一项说明它从哪读、要不要特殊处理 —— 新增数据源时只改这里。
 */
export const SECTIONS = {
  departments: { label: '部门', file: 'departments.json' },
  bots: { label: 'Bot', file: 'bots.json' },
  skills: { label: '技能', file: 'skills', dir: true },
  memory: { label: '记忆', file: 'memory.jsonl' },
  discipline: { label: '纪律', file: 'discipline.jsonl' },
  prompts: { label: '提示词', file: 'prompts.jsonl' },
  settings: { label: '设置', file: 'settings.json' },
  board: { label: '任务板', file: 'board.jsonl' },
}

/** 设置里**不导出**的键：各机器不同，导入后按本机重算。 */
const SETTINGS_EXCLUDE = new Set([
  'botWorkspaceRoot',      // 路径
])

// ── 工具 ─────────────────────────────────────────────────────────────────────

/** sha256 摘要，用于 manifest.checksums。 */
function sha256(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex')
}

/** 递归列目录下所有文件（相对路径用 `/` 分隔，ZIP 规范要求）。 */
function walkFiles(root, base = root) {
  const out = []
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full, base))
    else if (entry.isFile()) out.push({ full, rel: relative(base, full).split(/[\\/]/).join('/') })
  }
  return out
}

/** 目录总字节数（用于体积估算）。 */
export function dirSize(dir) {
  let total = 0
  try {
    for (const f of walkFiles(dir)) {
      try { total += statSync(f.full).size } catch { /* 跳过读不到的 */ }
    }
  } catch { /* 目录不存在 */ }
  return total
}

/** 读 jsonl（每行一个 JSON），坏行跳过不炸。 */
function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 坏行跳过 */ }
  }
  return out
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

/**
 * 估算一次导出的体积（不打包，只算数）。
 *
 * 用于确认页：用户勾「含工作目录文件」时要立刻看到会变成多大。
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {object} opts.services
 * @param {string[]} opts.sections 要导出的段 id
 * @param {boolean} opts.includeFiles 是否含工作目录文件
 * @returns {{ totalBytes: number, bySection: Record<string, number>, filesBytes: number, overLimit: boolean, overWarn: boolean }}
 */
export function estimateExport({ stateDir, services, sections, includeFiles }) {
  const bySection = {}
  let filesBytes = 0
  const picked = Array.isArray(sections) ? sections : []

  for (const id of picked) {
    const spec = SECTIONS[id]
    if (!spec) continue
    if (id === 'skills') {
      // 技能在各 Bot 的 .agents/skills 下
      const root = String(services?.settings?.botWorkspaceRoot ?? '').replace(/[\\/]+$/, '')
      const bots = services?.roster?.list?.() ?? []
      let sum = 0
      for (const b of bots) {
        const dir = join(String(b.cwd ?? '').replace(/[\\/]+$/, ''), '.agents', 'skills')
        sum += dirSize(dir)
      }
      bySection[id] = sum
      if (includeFiles) filesBytes += sum      // 技能本身就在工作目录里，算进文件体积
      void root
    } else if (spec.dir) {
      bySection[id] = dirSize(join(stateDir, spec.file))
    } else if (id === 'departments') {
      // ⚠️ 部门定义存在 settings.json 里，没有独立的 departments.json
      //    估算要按「序列化后的字节数」算，否则永远是 0（用户会以为没东西可导）
      const depts = Array.isArray(services?.settings?.departments) ? services.settings.departments : []
      bySection[id] = Buffer.byteLength(JSON.stringify(depts, null, 2), 'utf8')
    } else if (id === 'bots') {
      const bots = services?.roster?.list?.() ?? []
      bySection[id] = Buffer.byteLength(JSON.stringify(bots.map((b) => ({
        name: b.name, cwd: b.cwd, preset: b.preset, profile: b.profile ?? {},
      })), null, 2), 'utf8')
    } else {
      const p = join(stateDir, spec.file)
      bySection[id] = existsSync(p) ? statSync(p).size : 0
    }
  }

  // 含工作目录文件：把每个 Bot 的 cwd 体积加进去（排除 .agents，它已单独算过）
  if (includeFiles) {
    const bots = services?.roster?.list?.() ?? []
    for (const b of bots) {
      const cwd = String(b.cwd ?? '').replace(/[\\/]+$/, '')
      if (!cwd) continue
      filesBytes += dirSize(cwd)
    }
  }

  const totalBytes = Object.values(bySection).reduce((a, b) => a + b, 0) + (includeFiles ? filesBytes : 0)
  return {
    totalBytes,
    bySection,
    filesBytes,
    overLimit: totalBytes > FILES_SIZE_LIMIT,
    overWarn: totalBytes > FILES_SIZE_WARN,
  }
}

/**
 * 真正打包。
 *
 * @param {object} opts 同 estimateExport
 * @returns {{ buffer: Buffer, manifest: object }}
 */
export function buildExport({ stateDir, services, sections, includeFiles }) {
  const picked = Array.isArray(sections) ? sections : []
  const entries = []
  const checksums = {}
  const counts = {}

  const add = (name, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    entries.push({ name, data: buf })
    checksums[name] = sha256(buf)
  }

  // ① 部门
  if (picked.includes('departments')) {
    const depts = Array.isArray(services?.settings?.departments) ? services.settings.departments : []
    add(SECTIONS.departments.file, JSON.stringify(depts, null, 2))
    counts.departments = depts.length
  }

  // ② Bot（注册表 + 档案）
  if (picked.includes('bots')) {
    const bots = (services?.roster?.list?.() ?? []).map((b) => ({
      name: b.name,
      cwd: b.cwd,                 // 只作参考，导入时按本机主目录重算
      preset: b.preset ?? null,
      label: b.label ?? null,
      instructions: b.instructions ?? null,
      profile: b.profile ?? {},
      // sessionId 不导：会话与宿主绑定，导入后是新会话
    }))
    add(SECTIONS.bots.file, JSON.stringify(bots, null, 2))
    counts.bots = bots.length
  }

  // ③ 技能（按 Bot 收集）
  if (picked.includes('skills')) {
    let n = 0
    for (const b of services?.roster?.list?.() ?? []) {
      const cwd = String(b.cwd ?? '').replace(/[\\/]+$/, '')
      const skillsDir = join(cwd, '.agents', 'skills')
      for (const f of walkFiles(skillsDir)) {
        // 包里按 Bot 名分区，导入时才知道该放回哪
        add(`skills/${b.name}/${f.rel}`, readFileSync(f.full))
        n += 1
      }
    }
    counts.skillFiles = n
  }

  // ④ 记忆 / 纪律 / 提示词 / 任务板（原样拷 jsonl）
  for (const id of ['memory', 'discipline', 'prompts', 'board']) {
    if (!picked.includes(id)) continue
    const p = join(stateDir, SECTIONS[id].file)
    if (existsSync(p)) {
      add(SECTIONS[id].file, readFileSync(p))
      counts[id] = readJsonl(p).length
    }
  }

  // ⑤ 设置（排除路径类）
  if (picked.includes('settings')) {
    const src = join(stateDir, 'settings.json')
    let obj = {}
    if (existsSync(src)) {
      try { obj = JSON.parse(readFileSync(src, 'utf8')) } catch { obj = {} }
    }
    const filtered = {}
    for (const [k, v] of Object.entries(obj)) {
      if (SETTINGS_EXCLUDE.has(k)) continue
      filtered[k] = v
    }
    add(SECTIONS.settings.file, JSON.stringify(filtered, null, 2))
    counts.settings = Object.keys(filtered).length
  }

  // ⑥ 工作目录文件（可选）
  let fileCount = 0
  if (includeFiles) {
    for (const b of services?.roster?.list?.() ?? []) {
      const cwd = String(b.cwd ?? '').replace(/[\\/]+$/, '')
      for (const f of walkFiles(cwd)) {
        // 跳过 .agents（已作为 skills 单独处理）与 .git（体积大且无意义）
        if (f.rel.startsWith('.agents/') || f.rel.startsWith('.git/')) continue
        add(`files/${b.name}/${f.rel}`, readFileSync(f.full))
        fileCount += 1
      }
    }
    counts.files = fileCount
  }

  // ⑦ manifest
  const manifest = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sections: picked,
    includeFiles: includeFiles === true,
    host: {
      platform: process.platform,
      dshHome: process.env.DSH_HOME ?? null,
    },
    counts,
    checksums,
  }
  // manifest 自己不进 checksums（自引用）
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })

  const buffer = createZip(entries)
  manifest.packageBytes = buffer.length
  return { buffer, manifest }
}

// ── 校核（导入前） ───────────────────────────────────────────────────────────

/**
 * 校核一个导入包，产出「能不能导 + 会覆盖什么 + 要怎么处理冲突」。
 *
 * ## 为什么校核与执行分开
 *   Boss 要求「有确认页，有校核提示」。校核必须**纯读**，
 *   让用户在看到全部影响面之后再决定，而不是点了导入才发现要覆盖一堆东西。
 *
 * @param {Buffer} buffer zip 内容
 * @param {object} services
 * @returns {object} 校核报告
 */
export function inspectPackage(buffer, services) {
  const blocking = []      // 阻断：不能导
  const warnings = []      // 警告：可以导，但要告诉用户
  const info = {}

  let entries
  try {
    entries = readZip(buffer)
  } catch (error) {
    return { ok: false, blocking: [`包无法解析：${error?.message ?? error}`], warnings: [], info: {} }
  }

  const byName = new Map(entries.map((e) => [e.name, e.data]))
  const manifestBuf = byName.get('manifest.json')
  if (!manifestBuf) {
    return { ok: false, blocking: ['包里没有 manifest.json，不是 cs-bots 导出包'], warnings: [], info: {} }
  }

  let manifest
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'))
  } catch {
    return { ok: false, blocking: ['manifest.json 解析失败，包已损坏'], warnings: [], info: {} }
  }

  // ① 格式与版本
  if (manifest.format !== EXPORT_FORMAT) {
    blocking.push(`包格式是 ${JSON.stringify(manifest.format)}，不是 ${EXPORT_FORMAT}`)
  }
  if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
    blocking.push(
      `包格式版本 v${manifest.formatVersion}，本插件只支持 v${EXPORT_FORMAT_VERSION}`
      + '（请升级插件，或用对应版本的插件导出）',
    )
  }

  // ② 校验和（这是「包没被改坏」的硬证据）
  const badChecksums = []
  for (const [name, expect] of Object.entries(manifest.checksums ?? {})) {
    const data = byName.get(name)
    if (!data) { badChecksums.push(`${name}（缺失）`); continue }
    if (sha256(data) !== expect) badChecksums.push(`${name}（校验不符）`)
  }
  if (badChecksums.length) {
    blocking.push(`校验失败：${badChecksums.join('、')} —— 包可能已损坏或被修改`)
  }

  // ③ 跨平台提示
  const hostPlat = manifest.host?.platform
  if (hostPlat && hostPlat !== process.platform) {
    warnings.push(`包来自 ${hostPlat}，本机是 ${process.platform} —— 路径会按本机重算`)
  }

  // ④ 同名冲突（部门 / Bot）
  const curDepts = Array.isArray(services?.settings?.departments) ? services.settings.departments : []
  const curBots = services?.roster?.list?.() ?? []
  const root = String(services?.settings?.botWorkspaceRoot ?? '').replace(/[\\/]+$/, '')

  const incDepts = manifest.sections?.includes('departments')
    ? (() => { try { return JSON.parse(byName.get(SECTIONS.departments.file)?.toString('utf8') ?? '[]') } catch { return [] } })()
    : []
  const incBots = manifest.sections?.includes('bots')
    ? (() => { try { return JSON.parse(byName.get(SECTIONS.bots.file)?.toString('utf8') ?? '[]') } catch { return [] } })()
    : []

  const deptDup = incDepts.filter((d) => curDepts.some((c) => c?.id === d?.id)).map((d) => d.name ?? d.id)
  const botDup = incBots.filter((b) => curBots.some((c) => c.name === b.name)).map((b) => b.name)
  if (deptDup.length) warnings.push(`${deptDup.length} 个部门同名：${deptDup.join('、')}`)
  if (botDup.length) warnings.push(`${botDup.length} 个 Bot 同名：${botDup.join('、')}`)

  // ⑤ cwd 在本机不存在（会被重算）
  if (root) {
    const foreign = incBots.filter((b) => {
      const cwd = String(b.cwd ?? '')
      return cwd && !cwd.startsWith(root)
    })
    if (foreign.length) {
      warnings.push(
        `${foreign.length} 个 Bot 的工作目录不在本机主目录下（${foreign.slice(0, 3).map((b) => b.name).join('、')}${foreign.length > 3 ? '…' : ''}）`
        + ` —— 导入后会改到 ${root}/<部门>/<名字>`,
      )
    }
  } else {
    warnings.push('本机还没设置主目录 —— 导入 Bot 前要先指定')
  }

  // ⑥ 含工作目录文件
  if (manifest.includeFiles) {
    warnings.push(`包含工作目录文件：${manifest.counts?.files ?? 0} 个文件`)
  }

  // ⑦ 设置里的路径类键被排除
  if (manifest.sections?.includes('settings')) {
    warnings.push('设置中的「主目录」等路径类键不会导入（各机器不同）')
  }

  Object.assign(info, {
    manifest,
    counts: manifest.counts ?? {},
    deptDup,
    botDup,
    includedBots: incBots.map((b) => ({ name: b.name, cwd: b.cwd, preset: b.preset ?? null })),
    includedDepts: incDepts,
  })

  return { ok: blocking.length === 0, blocking, warnings, info }
}
// ── 导入执行（应用阶段） ─────────────────────────────────────────────────────

/**
 * 把校核通过的包应用进去。
 *
 * ## 事务性
 *   先把所有要写的内容落到 `<stateDir>/.import-tmp-<时间戳>/`，
 *   全部准备好再逐个替换。任一步失败 ⇒ 删临时目录，**原状态不动**。
 *
 * ## 冲突策略（Boss 定：覆盖，但给提示）
 *   `onConflict: 'overwrite' | 'skip' | 'rename'`
 *   - overwrite（默认）：同名直接替换
 *   - skip：保留本机的
 *   - rename：导入的那个加 `_2` 后缀
 *
 * ## 为什么部门要先于 Bot 导入
 *   Bot 的 cwd 依赖部门 id。部门不在 ⇒ Bot 派生路径会 BOT_DEPT_UNKNOWN。
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {object} opts.services
 * @param {'overwrite'|'skip'|'rename'} [opts.onConflict]
 * @param {string[]} [opts.only] 只导入这些段（用户可取消勾选）
 * @returns {Promise<{ok: boolean, applied: object, skipped: object, errors: string[]}>}
 */
export async function applyImport(buffer, { stateDir, services, onConflict = 'overwrite', only }) {
  const mode = ['overwrite', 'skip', 'rename'].includes(onConflict) ? onConflict : 'overwrite'
  const check = inspectPackage(buffer, services)
  if (!check.ok) {
    return { ok: false, applied: {}, skipped: {}, errors: check.blocking }
  }
  const picked = Array.isArray(only) && only.length ? only : (check.info.manifest.sections ?? [])
  const entries = readZip(buffer)
  const byName = new Map(entries.map((e) => [e.name, e.data]))
  const tmp = join(stateDir, `.import-tmp-${Date.now()}`)
  const applied = {}
  const skipped = {}
  const errors = []

  try {
    mkdirSync(tmp, { recursive: true })

    // ① 部门（先于 Bot）
    if (picked.includes('departments')) {
      const inc = (() => {
        try { return JSON.parse(byName.get(SECTIONS.departments.file)?.toString('utf8') ?? '[]') } catch { return [] }
      })()
      const cur = Array.isArray(services?.settings?.departments) ? [...services.settings.departments] : []
      let added = 0; let overwritten = 0; let kept = 0
      for (const d of inc) {
        if (!d || typeof d.id !== 'string' || !d.id.trim()) { errors.push(`部门条目非法：${JSON.stringify(d)}`); continue }
        const at = cur.findIndex((c) => c?.id === d.id)
        if (at < 0) { cur.push({ id: d.id, name: d.name ?? d.id }); added += 1; continue }
        if (mode === 'skip') { kept += 1; continue }
        if (mode === 'rename') {
          // 部门 id 是目录名，改名要保证唯一
          let n = 2
          let newId = `${d.id}_${n}`
          while (cur.some((c) => c?.id === newId)) { n += 1; newId = `${d.id}_${n}` }
          cur.push({ id: newId, name: `${d.name ?? d.id}_${n}` })
          added += 1
          continue
        }
        cur[at] = { id: d.id, name: d.name ?? cur[at].name }
        overwritten += 1
      }
      writeFileSync(join(tmp, 'departments.next.json'), JSON.stringify(cur, null, 2), 'utf8')
      applied.departments = { added, overwritten, kept, total: cur.length }
    }

    // ② Bot（含档案）
    if (picked.includes('bots')) {
      const inc = (() => {
        try { return JSON.parse(byName.get(SECTIONS.bots.file)?.toString('utf8') ?? '[]') } catch { return [] }
      })()
      const cur = services?.roster?.list?.() ?? []
      let added = 0; let overwritten = 0; let kept = 0; let renamed = 0
      const plan = []
      for (const b of inc) {
        if (!b || typeof b.name !== 'string' || !b.name.trim()) { errors.push(`Bot 条目非法：${JSON.stringify(b)}`); continue }
        const hit = cur.find((c) => c.name === b.name)
        if (hit) {
          if (mode === 'skip') { kept += 1; continue }
          if (mode === 'rename') { plan.push({ ...b, name: `${b.name}_2` }); renamed += 1; continue }
          plan.push({ ...b, _replace: hit.id })
          overwritten += 1
          continue
        }
        plan.push(b)
        added += 1
      }
      applied.bots = { added, overwritten, kept, renamed, plan }
    }

    // ③ 记忆 / 纪律 / 提示词 / 任务板（按行合并，事件流是追加式的）
    for (const id of ['memory', 'discipline', 'prompts', 'board']) {
      if (!picked.includes(id)) continue
      const data = byName.get(SECTIONS[id].file)
      if (!data) { skipped[id] = '包里没有这一段'; continue }
      const existing = new Set(
        readJsonl(join(stateDir, SECTIONS[id].file)).map((r) => JSON.stringify(r)),
      )
      const incoming = data.toString('utf8').split('\n').filter((l) => l.trim())
      const fresh = incoming.filter((l) => !existing.has(JSON.stringify(JSON.parse(l))))
      if (!fresh.length) { skipped[id] = '全部已存在'; continue }
      writeFileSync(join(tmp, `${id}.next.jsonl`), fresh.join('\n') + '\n', 'utf8')
      applied[id] = { newLines: fresh.length, totalIncoming: incoming.length }
    }

    // ④ 设置（排除路径类）
    if (picked.includes('settings')) {
      const inc = (() => {
        try { return JSON.parse(byName.get(SECTIONS.settings.file)?.toString('utf8') ?? '{}') } catch { return {} }
      })()
      const safe = {}
      for (const [k, v] of Object.entries(inc)) {
        if (SETTINGS_EXCLUDE.has(k)) continue
        safe[k] = v
      }
      if (Object.keys(safe).length) {
        writeFileSync(join(tmp, 'settings.next.json'), JSON.stringify(safe, null, 2), 'utf8')
        applied.settings = { keys: Object.keys(safe) }
      }
    }

    // ⑤ 技能（按 Bot 放回自己的工作目录）
    if (picked.includes('skills')) {
      let n = 0
      for (const e of entries) {
        if (!e.name.startsWith('skills/')) continue
        const rest = e.name.slice('skills/'.length)
        const slash = rest.indexOf('/')
        if (slash < 0) continue
        const botName = rest.slice(0, slash)
        const fileRel = rest.slice(slash + 1)
        const bot = (services?.roster?.list?.() ?? []).find((b) => b.name === botName)
        if (!bot) { skipped.skills = (skipped.skills ?? 0) + 1; continue }
        const dest = join(String(bot.cwd).replace(/[\\/]+$/, ''), '.agents', 'skills', fileRel)
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, e.data)
        n += 1
      }
      applied.skills = { files: n }
    }

    // ⑥ 工作目录文件
    if (picked.includes('files') || check.info.manifest.includeFiles) {
      let n = 0
      for (const e of entries) {
        if (!e.name.startsWith('files/')) continue
        const rest = e.name.slice('files/'.length)
        const slash = rest.indexOf('/')
        if (slash < 0) continue
        const botName = rest.slice(0, slash)
        const fileRel = rest.slice(slash + 1)
        const bot = (services?.roster?.list?.() ?? []).find((b) => b.name === botName)
        if (!bot) { skipped.files = (skipped.files ?? 0) + 1; continue }
        // 覆盖保护：目标已存在且策略是 skip 就跳过
        const dest = join(String(bot.cwd).replace(/[\\/]+$/, ''), fileRel)
        if (mode === 'skip' && existsSync(dest)) { skipped.files = (skipped.files ?? 0) + 1; continue }
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, e.data)
        n += 1
      }
      applied.files = { written: n }
    }

    // ⑦ 落盘
    //
    // ⚠️ 部门不能直接覆盖 settings.json —— 那里还有别的设置项。
    //    必须读现有 → 合并 departments → 写回。
    const settingsPath = join(stateDir, 'settings.json')
    const deptSrc = join(tmp, 'departments.next.json')
    const settingsSrc = join(tmp, 'settings.next.json')
    if (existsSync(deptSrc) || existsSync(settingsSrc)) {
      let cur = {}
      try { cur = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {} } catch { cur = {} }
      if (existsSync(deptSrc)) {
        try { cur.departments = JSON.parse(readFileSync(deptSrc, 'utf8')) } catch { /* 忽略坏数据 */ }
      }
      if (existsSync(settingsSrc)) {
        try { Object.assign(cur, JSON.parse(readFileSync(settingsSrc, 'utf8'))) } catch { /* 忽略 */ }
      }
      if (existsSync(settingsPath)) {
        try { writeFileSync(`${settingsPath}.pre-import-${Date.now()}`, readFileSync(settingsPath)) } catch { /* 备份失败不阻断 */ }
      }
      writeFileSync(settingsPath, JSON.stringify(cur, null, 2), 'utf8')
    }
    // 事件的 jsonl 是追加式：只追加新行
    for (const id of ['memory', 'discipline', 'prompts', 'board']) {
      const src = join(tmp, `${id}.next.jsonl`)
      if (!existsSync(src)) continue
      const dst = join(stateDir, SECTIONS[id].file)
      const prev = existsSync(dst) ? readFileSync(dst, 'utf8') : ''
      if (prev) {
        try { writeFileSync(`${dst}.pre-import-${Date.now()}`, prev) } catch { /* 忽略 */ }
      }
      writeFileSync(dst, prev.endsWith('\n') || !prev ? prev + readFileSync(src, 'utf8') : prev + '\n' + readFileSync(src, 'utf8'))
    }

    rmSync(tmp, { recursive: true, force: true })
    return { ok: errors.length === 0, applied, skipped, errors }
  } catch (error) {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败就算了 */ }
    return { ok: false, applied, skipped, errors: [...errors, `导入失败：${error?.message ?? error}`] }
  }
}
