#!/usr/bin/env node
/**
 * migrate-memory-evolve.mjs — 把 dsh-memory-evolve 的记忆数据迁移到 cs-bots。
 *
 * 用法：
 *   node migrate-memory-evolve.mjs [--dry-run] [--stateDir ~/.dsh/cs-bots]
 *
 * 迁移映射（只迁移决策性记忆，跳过纯操作日志）：
 *   USER.md                  → L1 用户偏好（全局）
 *   MEMORY.md                → L2 团队全局（全局）
 *   projects/<hash>/KEY.md    → L3 项目 key（按 cwd 隔离，含 branch 标签）
 *   projects/<hash>/MEMORY.md → L4 任务笔记（跳过 watchdog 巡检日志 + 纯操作记录）
 *   daily/*.md               → L5 日札（跳过 [watchdog] 巡检条目）
 *   SUGGESTIONS.jsonl         → 建议队列（kind=memory）
 *   prompts.json              → 提示词库
 */

import { createMemory } from './src/memory.js'
import { createSuggest } from './src/suggest.js'
import { createPrompts } from './src/prompts.js'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
const meDir = resolve(process.env.HOME || '/home/ubuntu', '.dsh/memories')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const targetStateDir = args.includes('--stateDir')
  ? resolve(args[args.indexOf('--stateDir') + 1])
  : resolve(process.env.HOME || '/home/ubuntu', '.dsh/cs-bots')

// ── session tag → cwd 映射 ──────────────────────────────────────────────
const SESSION_TAG_TO_CWD = {
  dev: '/home/ubuntu/output2026/butlers/dev',
  watchdog: '/home/ubuntu/.dsh/watchdog',
  output2026: '/home/ubuntu/output2026',
  work: '/home/ubuntu/output2026/butlers/work',
  pa: '/home/ubuntu/output2026/butlers/pa',
}

// ── sha1 hash → cwd 映射（从 sessions 存储推断）──────────────────────────
const HASH_TO_CWD = {
  c7537d563ddc: '/home/ubuntu/output2026',
  ac088a50064b: '/home/ubuntu/output2026/butlers/dev',
  a763f981cee3: '/home/ubuntu/output2026/butlers/pa',
  c00201e0b38e: '/home/ubuntu/output2026/butlers/work',
  '16f9bca7cad0': '/home/ubuntu/.dsh/watchdog',
  '9a493b209316': '/home/ubuntu/output2026',
  '24a1cd89042c': '/home/ubuntu/output2026',
  '4251821e3a9e': '/home/ubuntu/output2026',
  'cd548813f0a6': '/home/ubuntu/output2026',
  '1e3b82b293a8': '/home/ubuntu/output2026',
  '1ea2109a060a': '/home/ubuntu/output2026',
}

// ── 统计 ────────────────────────────────────────────────────────────────
const stats = {
  l1: { added: 0, skipped: 0, errors: 0 },
  l2: { added: 0, skipped: 0, errors: 0 },
  l3: { added: 0, skipped: 0, errors: 0 },
  l4: { added: 0, skipped: 0, errors: 0 },
  l5: { added: 0, skipped: 0, errors: 0 },
  suggestions: { added: 0, skipped: 0, errors: 0 },
  prompts: { added: 0, skipped: 0, errors: 0 },
}
const errors = []

// ── 辅助函数 ────────────────────────────────────────────────────────────

/** 分割 § 分隔的条目 */
function splitEntries(text) {
  return text.split('§').map(s => s.trim()).filter(s => s.length > 0)
}

/** 从 KEY.md 条目提取 branch 标签 */
function extractBranches(entry) {
  const match = entry.match(/\[branch:([^\]]*)\]/)
  if (match) {
    return match[1].split(',').map(b => b.trim()).filter(Boolean)
  }
  return []
}

/** 去除 KEY.md 条目的头部 tag（时间戳、branch、dsh-only、summary） */
function stripEntryTags(entry) {
  return entry
    .replace(/^\[[\d: -]+\]\s*/, '')
    .replace(/\[branch:[^\]]*\]\s*/, '')
    .replace(/\[dsh-only\]\s*/, '')
    .replace(/\[summary:([^\]]*)\]\s*/, '')
    .trim()
}

/** 从 daily 条目提取 session tag */
function extractSessionTag(entry) {
  const match = entry.match(/^\[[\d:]+\]\s*\[(\w+)\]\s*/)
  return match ? match[1] : null
}

/** 从 daily 条目去除头部（时间戳 + session tag） */
function stripDailyHeader(entry) {
  return entry
    .replace(/^\[[\d:]+\]\s*\[\w+\]\s*/, '')
    .replace(/【反馈】.*$/s, '')
    .trim()
}

/** 内容 hash 去重 */
const seenHashes = new Set()
function contentHash(content) {
  return createHash('sha1').update(content).digest('hex').slice(0, 16)
}
function isDuplicate(content) {
  const h = contentHash(content)
  if (seenHashes.has(h)) return true
  seenHashes.add(h)
  return false
}

/** 读取目录下所有 .md 文件（按名排序） */
function listMdFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.md'))
    .map(d => d.name)
    .sort()
}

/** 读取子目录列表 */
function listSubdirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
}

// ── 决策性记忆过滤 ───────────────────────────────────────────────────────

/** watchdog 项目 hash（纯巡检日志，跳过） */
const WATCHDOG_HASHES = new Set(['16f9bca7cad0'])

/**
 * L4 条目是否包含「决策性」标记。
 * 决策性条目：含重要结论、设计决策、架构方案、根因分析、验收结论、反馈等。
 * 纯操作日志（如「看护第 N 轮巡检：正常」）不迁移。
 */
const DECISION_MARKERS = [
  /【重要】/, /【重要更正】/, /【架构】/, /【方案】/, /【设计】/, /【定稿】/,
  /【需立即修】/, /【根因】/, /【验收】/, /【调研】/, /【交付】/, /【更正】/,
  /【陷阱】/, /【反馈】/, /【预设】/, /【关键】/, /【覆盖后】/, /【默认绑】/,
  /【金额】/, /【重启后验收】/, /【识图】/, /【突破】/, /【决定】/, /【裁决】/,
  /【结论】/, /【发现】/, /【踩坑】/, /【教训】/, /【瓶颈】/, /【定案】/,
  /【定】/, /【裁决】/, /【验证】/, /【实测】/,
]

function isDecisionEntry(entry) {
  return DECISION_MARKERS.some(re => re.test(entry))
}

/** L5 条目是否应跳过（watchdog 巡检日志） */
function isWatchdogDaily(entry) {
  return /\[watchdog\]/.test(entry)
}

// ── 创建 cs-bots 服务 ────────────────────────────────────────────────────
const ctx = {
  logger: {
    info: (...a) => console.log('[info]', ...a),
    warn: (...a) => console.warn('[warn]', ...a),
  },
}
const memory = createMemory(ctx, { stateDir: targetStateDir, splitOnOverflow: true })
const suggest = createSuggest(ctx, { stateDir: targetStateDir })
const prompts = createPrompts(ctx, { stateDir: targetStateDir })

// ── 备份 ────────────────────────────────────────────────────────────────
function backupCsBots() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = resolve(targetStateDir, `.backup-${ts}`)
  if (existsSync(targetStateDir) && !dryRun) {
    mkdirSync(backupDir, { recursive: true })
    for (const f of ['memory.jsonl', 'memory.snap.json', 'suggestions.jsonl', 'suggestions.snap.json', 'prompts.jsonl', 'prompts.snap.json']) {
      const src = join(targetStateDir, f)
      if (existsSync(src)) copyFileSync(src, join(backupDir, f))
    }
    console.log(`[backup] cs-bots 数据已备份到 ${backupDir}`)
  }
}

// ── 迁移 USER.md → L1 ───────────────────────────────────────────────────
function migrateUserMd() {
  const file = join(meDir, 'USER.md')
  if (!existsSync(file)) { console.log('[user] USER.md 不存在，跳过'); return }
  const entries = splitEntries(readFileSync(file, 'utf8'))
  console.log(`[user] USER.md: ${entries.length} 条 → L1 用户偏好`)
  for (const entry of entries) {
    const content = entry.trim()
    if (isDuplicate(content)) { stats.l1.skipped++; continue }
    if (dryRun) { stats.l1.added++; continue }
    try {
      memory.add({ layer: 'L1', content, by: 'migration', source: 'explicit', tags: ['用户偏好', '迁移自 memory-evolve'] })
      stats.l1.added++
    } catch (e) { stats.l1.errors++; errors.push(`L1: ${e.message}`) }
  }
}

// ── 迁移 MEMORY.md → L2 ─────────────────────────────────────────────────
function migrateMemoryMd() {
  const file = join(meDir, 'MEMORY.md')
  if (!existsSync(file)) { console.log('[memory] MEMORY.md 不存在，跳过'); return }
  const entries = splitEntries(readFileSync(file, 'utf8'))
  console.log(`[memory] MEMORY.md: ${entries.length} 条 → L2 团队全局`)
  for (const entry of entries) {
    const content = entry.trim()
    if (isDuplicate(content)) { stats.l2.skipped++; continue }
    if (dryRun) { stats.l2.added++; continue }
    try {
      memory.add({ layer: 'L2', content, by: 'migration', source: 'explicit', tags: ['团队全局', '迁移自 memory-evolve'] })
      stats.l2.added++
    } catch (e) { stats.l2.errors++; errors.push(`L2: ${e.message}`) }
  }
}

// ── 迁移 projects/<hash>/KEY.md → L3 ────────────────────────────────────
function migrateKeyFiles() {
  const projectsDir = join(meDir, 'projects')
  const hashes = listSubdirs(projectsDir)
  let total = 0
  for (const hash of hashes) {
    const keyFile = join(projectsDir, hash, 'KEY.md')
    if (!existsSync(keyFile)) continue
    const cwd = HASH_TO_CWD[hash] || null
    const entries = splitEntries(readFileSync(keyFile, 'utf8'))
    total += entries.length
    console.log(`[key] ${hash} (cwd=${cwd}): ${entries.length} 条 → L3 项目 key`)
    for (const raw of entries) {
      const branches = extractBranches(raw)
      const content = stripEntryTags(raw)
      if (isDuplicate(content)) { stats.l3.skipped++; continue }
      if (dryRun) { stats.l3.added++; continue }
      try {
        memory.add({
          layer: 'L3', content, by: 'migration', source: 'explicit',
          branches: branches.length > 0 ? branches : undefined,
          cwd, tags: ['项目关键记忆', `迁移自 memory-evolve/${hash}`],
        })
        stats.l3.added++
      } catch (e) { stats.l3.errors++; errors.push(`L3(${hash}): ${e.message}`) }
    }
  }
  console.log(`[key] 合计 ${total} 条`)
}

// ── 迁移 projects/<hash>/MEMORY.md → L4 ─────────────────────────────────
function migrateProjectMemoryFiles() {
  const projectsDir = join(meDir, 'projects')
  const hashes = listSubdirs(projectsDir)
  let total = 0
  for (const hash of hashes) {
    // 跳过 watchdog 项目（纯巡检日志）
    if (WATCHDOG_HASHES.has(hash)) {
      console.log(`[proj-mem] ${hash} → 跳过（watchdog 巡检日志）`)
      continue
    }
    const memFile = join(projectsDir, hash, 'MEMORY.md')
    if (!existsSync(memFile)) continue
    const cwd = HASH_TO_CWD[hash] || null
    const entries = splitEntries(readFileSync(memFile, 'utf8'))
    // 只统计决策性条目
    const decisions = entries.filter(e => isDecisionEntry(e))
    total += decisions.length
    console.log(`[proj-mem] ${hash} (cwd=${cwd}): ${decisions.length}/${entries.length} 条决策性 → L4 任务笔记`)
    for (const raw of decisions) {
      const content = raw.trim()
      if (isDuplicate(content)) { stats.l4.skipped++; continue }
      if (dryRun) { stats.l4.added++; continue }
      try {
        memory.add({
          layer: 'L4', content, by: 'migration', source: 'explicit',
          cwd, tags: ['项目日志', `迁移自 memory-evolve/${hash}`],
        })
        stats.l4.added++
      } catch (e) { stats.l4.errors++; errors.push(`L4(${hash}): ${e.message}`) }
    }
  }
  console.log(`[proj-mem] 合计 ${total} 条决策性记忆`)
}

// ── 迁移 daily/*.md → L5 ───────────────────────────────────────────────
function migrateDailyFiles() {
  const dailyDir = join(meDir, 'daily')
  const files = listMdFiles(dailyDir)
  let total = 0
  for (const file of files) {
    const text = readFileSync(join(dailyDir, file), 'utf8')
    const entries = splitEntries(text)
    // 跳过 watchdog 巡检条目，只保留工作性条目
    const workEntries = entries.filter(e => !isWatchdogDaily(e))
    const skipped = entries.length - workEntries.length
    total += workEntries.length
    if (skipped > 0) console.log(`[daily] ${file}: ${workEntries.length} 条保留, ${skipped} 条 watchdog 巡检跳过`)
    for (const raw of workEntries) {
      const tag = extractSessionTag(raw)
      const cwd = SESSION_TAG_TO_CWD[tag] || null
      const content = stripDailyHeader(raw)
      if (isDuplicate(content)) { stats.l5.skipped++; continue }
      if (dryRun) { stats.l5.added++; continue }
      try {
        memory.add({
          layer: 'L5', content, by: 'migration', source: 'explicit',
          cwd, tags: ['日札', `迁移自 memory-evolve/${file}`],
        })
        stats.l5.added++
      } catch (e) { stats.l5.errors++; errors.push(`L5(${file}): ${e.message}`) }
    }
  }
  console.log(`[daily] 合计 ${total} 条 → L5 日札`)
}

// ── 迁移 SUGGESTIONS.jsonl ──────────────────────────────────────────────
function migrateSuggestions() {
  const file = join(meDir, 'SUGGESTIONS.jsonl')
  if (!existsSync(file)) { console.log('[suggest] SUGGESTIONS.jsonl 不存在，跳过'); return }
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(l => l.trim())
  console.log(`[suggest] SUGGESTIONS.jsonl: ${lines.length} 条 → 建议队列`)
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const target = obj.target === 'key' ? 'L3' : obj.target === 'personal' ? 'L1' : 'L2'
      const payload = { content: obj.content, tags: ['迁移自 memory-evolve'] }
      if (obj.cwd && ['L3', 'L4', 'L5'].includes(target)) payload.cwd = obj.cwd
      if (isDuplicate(obj.content)) { stats.suggestions.skipped++; continue }
      if (dryRun) { stats.suggestions.added++; continue }
      try {
        suggest.suggest({
          kind: 'memory', layer: target, payload,
          reason: obj.reason || '迁移自 memory-evolve SUGGESTIONS.jsonl',
          source: 'consolidate', by: 'migration',
        })
        stats.suggestions.added++
      } catch (e) { stats.suggestions.errors++; errors.push(`suggest: ${e.message}`) }
    } catch (e) {
      stats.suggestions.errors++; errors.push(`suggest(parse): ${e.message}`)
    }
  }
}

// ── 迁移 prompts.json ──────────────────────────────────────────────────
function migratePrompts() {
  const file = join(meDir, 'prompts.json')
  if (!existsSync(file)) { console.log('[prompts] prompts.json 不存在，跳过'); return }
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const list = data.prompts || []
  console.log(`[prompts] prompts.json: ${list.length} 条 → 提示词库`)
  for (const p of list) {
    if (isDuplicate(p.content || '')) { stats.prompts.skipped++; continue }
    if (dryRun) { stats.prompts.added++; continue }
    try {
      prompts.createPrompt({
        name: p.name, description: p.description || '',
        category: p.category || '迁移', tags: p.tags || [],
        body: p.content || '', enabled: p.enabled !== false, by: 'migration',
      })
      stats.prompts.added++
    } catch (e) { stats.prompts.errors++; errors.push(`prompt(${p.name}): ${e.message}`) }
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
function main() {
  console.log('='.repeat(60))
  console.log('迁移 memory-evolve → cs-bots')
  console.log(`模式: ${dryRun ? 'DRY-RUN（不写入）' : '写入'}`)
  console.log(`源: ${meDir}`)
  console.log(`目标: ${targetStateDir}`)
  console.log('='.repeat(60))

  if (!dryRun) backupCsBots()

  migrateUserMd()
  migrateMemoryMd()
  migrateKeyFiles()
  migrateProjectMemoryFiles()
  migrateDailyFiles()
  migrateSuggestions()
  migratePrompts()

  console.log('\n' + '='.repeat(60))
  console.log('迁移统计')
  console.log('='.repeat(60))
  const all = [
    ['L1 用户偏好', stats.l1],
    ['L2 团队全局', stats.l2],
    ['L3 项目key', stats.l3],
    ['L4 任务笔记', stats.l4],
    ['L5 日札', stats.l5],
    ['建议队列', stats.suggestions],
    ['提示词库', stats.prompts],
  ]
  for (const [name, s] of all) {
    const total = s.added + s.skipped + s.errors
    console.log(`  ${name.padEnd(12)} 总计: ${String(total).padStart(4)} | 新增: ${String(s.added).padStart(4)} | 跳过: ${String(s.skipped).padStart(4)} | 失败: ${String(s.errors).padStart(3)}`)
  }

  if (errors.length > 0) {
    console.log(`\n错误详情（前20条）:`)
    for (const e of errors.slice(0, 20)) console.log(`  ❌ ${e}`)
    if (errors.length > 20) console.log(`  ... 及其他 ${errors.length - 20} 条`)
  }

  console.log(dryRun ? '\n[DRY-RUN] 未写入任何数据。去掉 --dry-run 执行实际迁移。' : '\n迁移完成。')
}

main()
