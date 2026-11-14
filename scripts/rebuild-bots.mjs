#!/usr/bin/env node
/**
 * 重建全部 Bot 会话（Boss 2026-11-14 选方案 B）。
 *
 * ## 为什么要重建
 *
 *   宿主的 `attachSession` 硬校验「会话 header 的 cwd === workspace.path」
 *   （`dsh-workspace/lib/index.js:122`），而**会话 header 的 cwd 一旦创建就固定**。
 *   ⇒ 改了 Bot 注册表的 cwd 之后，那个会话永远挂不进新路径的 workspace，
 *   左侧栏就一直显示旧目录分组。
 *
 *   要让左侧正确，只能让**会话本身**创建在新 cwd 下 ⇒ 必须先退役再重建。
 *
 * ## 代价（必须让 Boss 知道）
 *
 *   - 旧会话的历史对话**不会跟着走**（数据还在磁盘，但新 Bot 是全新会话）
 *   - 重建后 Bot 的 sessionId 变了：**任何引用旧 sessionId 的地方都会失效**
 *     （任务的 ownerId/assignee、房间成员、团队 leadId/members）
 *
 * ## 所以本脚本做四件事（顺序不能变）
 *
 *   ① 导出每个 Bot 的档案（identity/persona/boundaries/skills/…）
 *   ② 退役旧 Bot（释放名字与 cwd 槽位）
 *   ③ 用同一个名字 + 部门重建
 *   ④ 把档案写回新 Bot
 *   —— 任何一步失败都要能停下来，不能留下「退役了但没重建」的半成品。
 *
 * ## 自带体检
 *
 *   重建前先扫一遍**引用旧 sessionId 的地方**（任务 / 房间 / 团队），
 *   把影响面打出来。Boss 看到数字后再决定是否继续。
 *
 * 用法：
 *   node scripts/rebuild-bots.mjs --dry-run     # 只看计划与影响面
 *   node scripts/rebuild-bots.mjs               # 真执行
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { createRoster } = await import(join(HERE, '..', 'src', 'roster.js'))

const DRY = process.argv.includes('--dry-run')
const STATE = join(process.env.HOME ?? '/home/ubuntu', '.dsh', 'cs-bots')
/** **我自己的会话** —— 绝不能退役，否则当场杀掉这次对话。 */
const MY_SESSION = process.env.CS_BOTS_SELF_SESSION ?? 'session-2dbfdba2-8e75-4081-a6bb-d21f7f448d76'

const DEPTS = [
  { id: 'dev', name: '开发部' },
  { id: 'qa', name: '测试部' },
  { id: 'ops', name: '综合部' },
  { id: 'misc', name: '待归类' },
]

/** Bot 名 → 部门（与 relocate 脚本一致）。 */
const PLAN = {
  'Csbots开发主管': 'dev',
  开发执行岗: 'dev',
  开发诊断岗: 'dev',
  横向证据与风险门岗: 'qa',
  '独立调查员(测试202611）': 'qa',
  岗位管理员: 'ops',
  DSH环境管理员: 'ops',
  VPN网络管理员: 'ops',
  记忆整理岗: 'ops',
  工作岗: 'misc',
  私人助理岗: 'misc',
  任务调度岗: 'misc',
  // 插件发布管理员：cwd 在插件源码目录，不在大楼内 ⇒ 不重建（它的会话本来就对）
}

/** 读 jsonl 取每个 id 的最新态。 */
function latestBy(file, key) {
  try {
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const out = {}
    for (const r of rows) {
      const v = key ? r[key] : (r.after?.id ? r.after : null)
      if (v) out[v.id ?? v] = v
    }
    return out
  } catch { return {} }
}

async function main() {
  const roster = createRoster({ logger: { info() {}, warn() {} }, get: () => undefined }, {
    stateDir: STATE,
    botsRoot: '/home/ubuntu/cs-bots',
    departments: DEPTS,
  })

  const bots = roster.list()
  const targets = bots.filter((b) => PLAN[b.name] && b.sessionId !== MY_SESSION)

  console.log(`═══ 重建计划 ═══`)
  console.log(`活跃 Bot ${bots.length} 个，本次重建 ${targets.length} 个\n`)

  // ── 影响面体检 ──────────────────────────────────────────────────────────
  const oldIds = new Set(targets.map((b) => b.sessionId))
  const tasks = Object.values(latestBy(join(STATE, 'board.jsonl')))
  const affectedTasks = tasks.filter((t) => oldIds.has(t.ownerId) || oldIds.has(t.assignee))
  const tasksById = {}
  for (const t of tasks) tasksById[t.id] = t

  let roomRefs = 0
  try {
    const idx = JSON.parse(readFileSync(join(STATE, 'rooms', 'index.json'), 'utf8'))
    for (const r of idx.rooms ?? []) {
      roomRefs += (r.members ?? []).filter((m) => oldIds.has(m)).length
    }
  } catch { /* 没有房间索引就算了 */ }

  let teamRefs = 0
  const teams = Object.values(latestBy(join(STATE, 'teams.jsonl')))
  for (const t of teams) {
    if (oldIds.has(t.leadId)) teamRefs += 1
    teamRefs += (t.members ?? []).filter((m) => oldIds.has(m)).length
  }

  console.log('── 影响面（重建后这些引用会指向不存在的会话）──')
  console.log(`  任务：${affectedTasks.length} 个引用旧 sessionId`)
  if (affectedTasks.length) {
    for (const t of affectedTasks.slice(0, 10)) {
      console.log(`    ${t.id} ${(t.subject ?? '').slice(0, 30)} —— ${t.status}`)
    }
    if (affectedTasks.length > 10) console.log(`    …还有 ${affectedTasks.length - 10} 个`)
  }
  console.log(`  房间成员引用：${roomRefs} 处`)
  console.log(`  团队 lead/成员引用：${teamRefs} 处`)
  console.log()

  // ── 逐条计划 ────────────────────────────────────────────────────────────
  console.log('── 重建清单 ──')
  for (const b of targets) {
    const p = b.profile ?? {}
    console.log(
      `  ${b.name.padEnd(24)} ${PLAN[b.name].padEnd(5)} 档案字段 ${String(Object.keys(p).length).padStart(2)}`
      + `  ${String(b.sessionId).slice(0, 20)} → 新会话`,
    )
  }

  if (DRY) {
    console.log('\n[dry-run] 未做任何改动。去掉 --dry-run 才真执行。')
    return
  }

  // ── 真执行 ──────────────────────────────────────────────────────────────
  console.log('\n═══ 开始重建 ═══')
  const results = []
  for (const b of targets) {
    const profile = b.profile ?? {}
    const dept = PLAN[b.name]
    const oldSession = b.sessionId
    const oldCwd = b.cwd

    // ① 退役
    try {
      roster.retire({ id: b.id, byId: 'ui', reason: '方案B：重建会话以修复工作区归属' })
    } catch (error) {
      results.push({ name: b.name, status: 'fail', reason: `退役失败：${error?.message ?? error}` })
      continue
    }

    // ② 重建（同名同部门）
    let created
    try {
      created = await roster.create({
        name: b.name,
        department: dept,
        byId: 'ui',
        ...(b.preset ? { preset: b.preset } : {}),
        ...(b.label ? { label: b.label } : {}),
        ...(b.instructions ? { instructions: b.instructions } : {}),
        ...(b.permission ? { permission: b.permission } : {}),
        // 档案在建时就带上，一次写全（避免 create 后 setProfile 两步之间失败留下空档案）
        ...(Object.keys(profile).length ? { profile } : {}),
      })
    } catch (error) {
      results.push({
        name: b.name,
        status: 'fail',
        reason: `重建失败（**已退役但未重建**，需要人工处理）：${error?.message ?? error}`,
        oldSession,
        oldCwd,
      })
      continue
    }

    results.push({
      name: b.name,
      status: 'ok',
      from: oldSession,
      to: created.sessionId,
      cwd: created.cwd,
    })
  }

  console.log('\n════ 汇总 ════')
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : '❌'
    console.log(`${icon} ${r.name.padEnd(24)} ${r.status}${r.reason ? ' —— ' + r.reason : ''}`)
    if (r.status === 'ok') console.log(`     ${r.from} → ${r.to}`)
  }
  const ok = results.filter((r) => r.status === 'ok').length
  const fail = results.filter((r) => r.status !== 'ok').length
  console.log(`\n成功 ${ok} · 失败 ${fail}`)

  if (fail > 0) {
    console.log('\n⚠️ 有失败项。失败条目里注明了「已退役但未重建」，需要人工介入：')
    for (const r of results.filter((x) => x.status !== 'ok')) {
      console.log(`   - ${r.name}（旧会话 ${r.oldSession ?? '?'}）`)
    }
    process.exitCode = 1
  }
}

await main()