/**
 * 回归测试 —— 2026-11-20 Windows 端 lead 会话全量测试发现的 4 个缺陷。
 *
 * 为什么单独一个文件：这四条都是**「装配期快照 / 跨字段不归一化 / 渲染层直接拼字符串」
 * 造成的静默失败**，单测里此前没有任何一条能兜住。它们的共同特征是「默认配置下必现、
 * 但要点开某个操作才会暴露」，所以必须钉死在回归里。
 *
 * 钉住三件事（对应报告 §5）：
 *   1. `createRoster(departments:[])` → 建 Bot 失败；`updateConfig({departments})` 后**立刻**成功（缺陷 1）
 *   2. `$DSH_HOME` 下的 `<root>/<dept>/<bot>` 允许；`$DSH_HOME` 自身、`<root>` 自身、
 *      `$DSH_HOME/sessions` 仍拒绝（缺陷 2）
 *   3. `departments:[] + defaultDepartment:"dev"` 读入即置空，保存非法值也置空（缺陷 3）
 *
 * 缺陷 4（穿透面板 `[object Object]`）是纯渲染层，靠 UI 回归 + 截图钉，
 * 本文件不重复造 React 环境。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRoster } from '../src/roster.js'
import { loadSettings, saveSettings } from '../src/settings.js'

/** 造一个能接受 `agents.create` 的最小宿主。 */
function makeHost(overrides = {}) {
  const createCalls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(key) {
      if (key !== 'agents') return undefined
      return {
        async create(request) {
          createCalls.push(request)
          if (overrides.failCreate) {
            const err = new Error('宿主拒绝（测试注入）')
            err.code = 'INJECTED_CREATE_FAILURE'
            throw err
          }
          return { id: request.sessionId, sessionId: request.sessionId }
        },
        get: () => undefined,
        list: () => [],
      }
    },
  }
  return { ctx, createCalls }
}

/**
 * 造一个「默认布局」的 roster：主目录 = `<fakeHome>/cs-bots`（正是 Boss 2026-11-15 定的默认值）。
 * @param {object[]} departments 装配期的部门字典（模拟**尚未包含**新部门）
 */
function setupDefaultLayout(departments) {
  const root = mkdtempSync(join(tmpdir(), 'csb-reg-'))
  const fakeHome = join(root, 'home')
  const botsRoot = join(fakeHome, 'cs-bots')
  mkdirSync(botsRoot, { recursive: true })
  const stateDir = join(root, 'state')
  const host = makeHost()
  const roster = createRoster(host.ctx, { stateDir, departments, botsRoot })
  return { root, fakeHome, botsRoot, stateDir, roster, ...host }
}

// ── 缺陷 1：部门快照 → 建 Bot 必失败，updateConfig 后立刻可见 ──────────────────

test('缺陷1：departments 为空时建部门 Bot 必失败，updateConfig 后无需重启即成功', async (t) => {
  // 默认主目录落在 $DSH_HOME 下（fakeHome 就是本用例的 DSH_HOME），
  // 这同时覆盖缺陷 2 的「合法路径要放行」
  const h = setupDefaultLayout([])
  process.env.DSH_HOME = h.fakeHome
  t.after(() => {
    rmSync(h.root, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })

  // ① 装配期部门为空 → 派生失败（这是缺陷 1 的「现象」）
  await assert.rejects(
    () => h.roster.create({ name: 'b-after-newdept', department: 'qa20261120', byId: 'lead' }),
    (err) => {
      assert.equal(err.code, 'BOT_DEPT_UNKNOWN')
      assert.match(err.message, /qa20261120/)
      return true
    },
    '部门不存在时必须报 BOT_DEPT_UNKNOWN（不能静默兜底）',
  )

  // ② 运行期新增部门（等价于 POST /departments/save 之后）→ 立刻可见
  const updated = h.roster.updateConfig({ departments: [{ id: 'qa20261120', name: 'QA20261120' }] })
  assert.deepEqual(updated.departments, [{ id: 'qa20261120', name: 'QA20261120' }])

  const bot = await h.roster.create({ name: 'b-after-newdept', department: 'qa20261120', byId: 'lead' })
  assert.ok(bot.id, '新建部门后建 Bot 必须成功')
  assert.ok(
    bot.cwd.startsWith(join(h.botsRoot, 'qa20261120')),
    `Bot cwd 必须落在 <主目录>/<部门> 下，实际 ${bot.cwd}`,
  )
  // 目录真的建出来了（create 在派生分支里会 mkdir）
  assert.ok(existsSync(bot.cwd), '创建后 Bot 工作目录必须真实存在')
})

// ── 缺陷 2：$DSH_HOME 子树禁令的精度边界 ────────────────────────────────────────

test('缺陷2：主目录真子目录放行；$DSH_HOME 自身 / 主目录自身 / sessions 子树仍拒绝', async (t) => {
  const h = setupDefaultLayout([{ id: 'qa', name: 'QA' }])
  process.env.DSH_HOME = h.fakeHome
  t.after(() => {
    rmSync(h.root, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })
  const home = process.env.DSH_HOME

  // ① 主目录的真子目录：放行（部门派生路径）
  const bot = await h.roster.create({ name: 'ok-bot', department: 'qa', byId: 'lead' })
  assert.equal(bot.cwd, join(h.botsRoot, 'qa', 'ok-bot'))

  // ② $DSH_HOME 自身：必须拒绝
  await assert.rejects(
    () => h.roster.create({ name: 'bad-home', cwd: home, byId: 'lead' }),
    (err) => err.code === 'ROSTER_CWD_IN_DSH_HOME',
  )

  // ③ 主目录自身（虽在 $DSH_HOME 下，但那是「容器不是 Bot 目录」）：必须拒绝
  await assert.rejects(
    () => h.roster.create({ name: 'bad-root', cwd: h.botsRoot, byId: 'lead' }),
    (err) => err.code === 'ROSTER_CWD_IN_DSH_HOME',
  )

  // ④ $DSH_HOME 的其它子树（sessions）：必须拒绝（不能被 allowRoot 顺带放行）
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  await assert.rejects(
    () => h.roster.create({ name: 'bad-sessions', cwd: join(sessions, 'x'), byId: 'lead' }),
    (err) => err.code === 'ROSTER_CWD_IN_DSH_HOME',
  )

  // ⑤ 主目录之外、$DSH_HOME 之外：照旧允许（不能把正常路径误伤）
  const outside = join(h.root, 'outside-ws')
  mkdirSync(outside, { recursive: true })
  const normal = await h.roster.create({ name: 'normal-bot', cwd: outside, byId: 'lead' })
  assert.equal(normal.cwd, outside)
})

// ── 缺陷 3：defaultDepartment 悬空 → 读盘/写盘都置空 ───────────────────────────

test('缺陷3：defaultDepartment 指向不存在的部门时，读盘即置空且留诊断', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'csb-reg-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  // 复刻 Windows 桌面 settings.json 的现场：有默认部门、但部门字典是空的
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
    departments: [],
    defaultDepartment: 'dev',
  }), 'utf8')

  const loaded = loadSettings(stateDir)
  assert.equal(loaded.values.defaultDepartment, '', '悬空的默认部门必须置空')
  assert.ok(
    loaded.diagnostics.badKeys.some((b) => b.key === 'defaultDepartment'),
    '必须留一条 badKeys 诊断（否则永远查不出为什么建 Bot 会失败）',
  )

  // 保存非法值同样归一化（避免把悬空值再写回磁盘）
  const saved = saveSettings(stateDir, { defaultDepartment: 'dev' })
  assert.equal(saved.ok, true)
  assert.equal(saved.values.defaultDepartment, '')
  const onDisk = JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8'))
  assert.equal(onDisk.defaultDepartment, '', '磁盘上也必须是空，不能只改返回值')
})

test('缺陷3 反面：默认部门真实存在时必须保留（归一化不能误杀）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'csb-reg-settings2-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
    departments: [{ id: 'qa', name: 'QA' }],
    defaultDepartment: 'qa',
  }), 'utf8')

  const loaded = loadSettings(stateDir)
  assert.equal(loaded.values.defaultDepartment, 'qa', '存在的默认部门必须原样保留')
  assert.equal(loaded.diagnostics.badKeys.length, 0)

  const saved = saveSettings(stateDir, { defaultDepartment: 'qa' })
  assert.equal(saved.ok, true)
  assert.equal(saved.values.defaultDepartment, 'qa')
})
