#!/usr/bin/env node
/**
 * 存量 Bot 归位：把散落各处的 Bot 工作目录迁到统一大楼 `<主目录>/<部门>/<名字>`。
 *
 * ## 为什么需要这个脚本（而不是直接调 roster.setCwd）
 *
 *   `setCwd` 只改**注册表**并迁移 `AGENTS.md`，**不搬其他文件**。
 *   实测每个旧目录里除 AGENTS.md 外还有：
 *     - `.agents/skills/<name>/SKILL.md`（Bot 的技能，丢了它就干不了活）
 *     - `AGENTS.md.bak-when-*`（历史备份）
 *   ⇒ 必须先把整个目录搬过去，再改注册表；顺序反了会出现「注册表指新目录、
 *     文件还在旧目录」的中间态。
 *
 * ## 安全策略
 *
 *   - **逐个处理**：一个失败不影响其余，最后汇总
 *   - **目标已存在就拒绝**（不合并两个 Bot 的目录 —— 那正是 t-46 缺陷#1 的成因）
 *   - **搬运失败则注册表不动**（保证「名字与目录」一致）
 *   - **旧目录不删**：搬走后留空目录 + `.moved-from.json` 面包屑，由人确认后再删
 *   - **完全幂等**：重复执行跳过已归位的
 *
 * ## 用法
 *
 *   node scripts/relocate-bots.mjs --dry-run     # 只看计划
 *   node scripts/relocate-bots.mjs               # 真执行
 *   node scripts/relocate-bots.mjs --detach-workspaces  # 顺带解绑历史会话（需宿主服务）
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { createRoster } = await import(join(HERE, '..', 'src', 'roster.js'))
const { deriveBotCwd } = await import(join(HERE, '..', 'src', 'botdirs.js'))

const DRY = process.argv.includes('--dry-run')

// ── 迁移计划：Bot 名 → 部门 ────────────────────────────────────────────────
//
// `插件发布管理员` **不在计划里**：它的活（发布 cs-bots）就在插件源码目录，
// 迁走会破坏它的工作。这不是遗漏，是刻意保留。
const PLAN = {
  'Csbots开发主管': 'dev',
  '开发执行岗': 'dev',
  '开发诊断岗': 'dev',
  '横向证据与风险门岗': 'qa',
  'bots试用测试': 'qa',
  '独立调查员(测试202611）': 'qa',
  '岗位管理员': 'ops',
  'DSH环境管理员': 'ops',
  'VPN网络管理员': 'ops',
  '记忆整理岗': 'ops',
  '工作岗': 'misc',
  '私人助理岗': 'misc',
  '任务调度岗': 'misc',
  // Csbots开发主管 原名目录是 Bots升级，按名字派生
}

const DEPTS = [
  { id: 'dev', name: '开发部' },
  { id: 'qa', name: '测试部' },
  { id: 'ops', name: '综合部' },
  { id: 'misc', name: '待归类' },
]

/** 递归复制目录内容（保留结构），目标已存在的文件不覆盖。 */
function copyDirInto(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDirInto(s, d)
    else if (!existsSync(d)) cpSync(s, d)
  }
}

async function main() {
  const stateDir = join(process.env.HOME ?? '/home/ubuntu', '.dsh', 'cs-bots')
  // 从 settings 读主目录与部门（与运行时同源）
  let botsRoot = '/home/ubuntu/cs-bots'
  try {
    const raw = JSON.parse(await import('node:fs').then((m) => m.readFileSync(join(stateDir, 'settings.json'), 'utf8')))
    if (typeof raw.botWorkspaceRoot === 'string') botsRoot = raw.botWorkspaceRoot
  } catch { /* 没有设置文件就用默认 */ }

  const roster = createRoster({ logger: { info() {}, warn() {} }, get: () => undefined }, {
    stateDir, botsRoot, departments: DEPTS,
  })

  const bots = roster.list()
  const results = []

  for (const [name, dept] of Object.entries(PLAN)) {
    const bot = bots.find((b) => b.name === name)
    if (!bot) { results.push({ name, status: 'skip', reason: '找不到这个 Bot（可能已退役）' }); continue }

    const d = deriveBotCwd({ botsRoot, departments: DEPTS, department: dept, botName: name })
    if (!d.ok) { results.push({ name, status: 'fail', reason: d.reason }); continue }

    if (resolve(bot.cwd) === d.cwd) {
      results.push({ name, status: 'skip', reason: '已归位' }); continue
    }
    if (existsSync(d.cwd)) {
      results.push({ name, status: 'fail', reason: `目标已存在，拒绝合并：${d.cwd}` }); continue
    }

    console.log(`${DRY ? '[计划]' : '[执行]'} ${name}：${bot.cwd} → ${d.cwd}`)

    if (DRY) {
      results.push({ name, status: 'plan', from: bot.cwd, to: d.cwd })
      continue
    }

    // ① 先搬文件（目标不存在才不会合并）
    try {
      if (existsSync(bot.cwd)) copyDirInto(bot.cwd, d.cwd)
      else mkdirSync(d.cwd, { recursive: true })
    } catch (error) {
      results.push({ name, status: 'fail', reason: `文件搬运失败：${error?.message ?? error}` })
      continue
    }

    // ② 再改注册表（失败则回滚已建的目标目录，保持「要么都成、要么都不动」）
    try {
      roster.setCwd({ id: bot.id, cwd: d.cwd, byId: 'ui', expectedRev: bot.rev })
    } catch (error) {
      try { rmSync(d.cwd, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
      results.push({ name, status: 'fail', reason: `注册表更新失败：${error?.message ?? error}` })
      continue
    }

    // ③ 旧目录留面包屑，不删（用户确认后再清）
    try {
      mkdirSync(bot.cwd, { recursive: true })
      writeFileSync(
        join(bot.cwd, '.moved-from.json'),
        JSON.stringify({ botId: bot.id, from: bot.cwd, to: d.cwd, movedAt: Date.now() }, null, 2) + '\n',
        'utf8',
      )
    } catch { /* 面包屑失败不影响主结果 */ }

    results.push({ name, status: 'ok', from: bot.cwd, to: d.cwd })
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  console.log('\n════ 汇总 ════')
  for (const r of results) {
    const icon = { ok: '✅', skip: '⏭ ', fail: '❌', plan: '📋' }[r.status] ?? '?'
    console.log(`${icon} ${r.name.padEnd(24)} ${r.status}${r.reason ? ' —— ' + r.reason : ''}${r.to ? ' → ' + r.to : ''}`)
  }
  const n = (s) => results.filter((r) => r.status === s).length
  console.log(`\n成功 ${n('ok')} · 跳过 ${n('skip')} · 失败 ${n('fail')} · 计划 ${n('plan')}`)
  if (n('fail') > 0) process.exitCode = 1
}

await main()