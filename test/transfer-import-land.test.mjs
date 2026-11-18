/**
 * 导入落地（0.20.0）—— 「导入完成 ✅ 但一个 Bot 都没多」的回归测试
 *
 * ## 2026-11-18 Boss Win 实测的原始故障
 *
 *   图 2/图 3：从 Linux 导出 → Win 导入，确认页写着
 *   「· 14 个 Bot 的工作目录不在本机主目录下 —— 导入后会改到 C:\...\.dsh\cs-bots/<部门>/<名字>」
 *   点确认后左树出现 `misc / ops / qa / dev` **四个空文件夹**，一个 Bot 都没有。
 *
 *   根因（代码事实，不是推测）：
 *     `applyImport` 的 bots 分支只把条目塞进 `applied.bots.plan`，
 *     **从未调用 `services.roster.create`** ⇒ 日志「已加 N 个」，registry 里 0 个。
 *
 * ## 本测试钉住的契约
 *   1. 导入必须**真的建出 Bot**（走 roster.create，cwd 由本机主目录重算）
 *   2. 来源机器的绝对路径（`C:\Users\Song\...`）**绝不**被带进来
 *   3. 包里的 `deptId` 决定 Bot 落在哪个部门
 *   4. 同名 = 覆盖（不 merge 成两个），三种策略各自行为正确
 *   5. 单条失败不影响其它条目，且**如实上报 failedDetail**（不假成功）
 *   6. 导入后三级分组登记（主目录 / 部门 / Bot）被调用
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildExport, applyImport, inspectPackage } from '../src/transfer.js'
import { ensureBotHierarchy } from '../src/ws-hierarchy.js'

let seq = 0

/**
 * 装一台「Linux 源机」：主目录 + 两个部门 + 两个 Bot。
 * @returns {{base:string, stateDir:string, root:string, services:object}}
 */
function sourceMachine(t) {
  seq += 1
  const base = mkdtempSync(join(tmpdir(), `cs-bots-imp-${process.pid}-${seq}-`))
  t?.after?.(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* */ } })
  const stateDir = join(base, 'src-state')
  const root = join(base, 'src-cs-bots')
  mkdirSync(stateDir, { recursive: true })
  const depts = [{ id: 'dev', name: '开发部' }, { id: '测试部门1', name: '测试部门1' }]
  mkdirSync(join(root, 'dev', '甲'), { recursive: true })
  mkdirSync(join(root, '测试部门1', '乙'), { recursive: true })
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
    botWorkspaceRoot: root, departments: depts,
  }), 'utf8')
  const bots = [
    { id: 'b1', name: '甲', cwd: join(root, 'dev', '甲'), preset: 'dev-steward', state: 'idle', profile: { identity: '我是甲' } },
    { id: 'b2', name: '乙', cwd: join(root, '测试部门1', '乙'), preset: '', state: 'idle', profile: { identity: '我是乙' } },
  ]
  const services = {
    settings: { botWorkspaceRoot: root, departments: depts },
    roster: { list: () => bots },
  }
  return { base, stateDir, root, services }
}

/** 导出一个小包（departments + bots）。 */
function exportPkg(m) {
  return buildExport({ stateDir: m.stateDir, services: m.services, sections: ['departments', 'bots'], includeFiles: false }).buffer
}

/**
 * 装一台「Windows 目标机」：空的 registry + 假的 roster。
 *
 * 为什么不用真的 roster 模块：真 create 需要宿主 agents 服务。
 * 这里用「行为等价的最小替身」——重点验证**调用与参数**，不验证 roster 内部。
 */
function targetMachine(t, { existing = [] } = {}) {
  seq += 1
  const base = mkdtempSync(join(tmpdir(), `cs-bots-tgt-${process.pid}-${seq}-`))
  t?.after?.(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* */ } })
  const stateDir = join(base, 'tgt-state')
  const root = join(base, 'win-cs-bots')
  mkdirSync(stateDir, { recursive: true })
  const depts = [{ id: 'dev', name: '开发部' }, { id: '测试部门1', name: '测试部门1' }]
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
    botWorkspaceRoot: root, departments: depts,
  }), 'utf8')

  const bots = [...existing]
  const createCalls = []
  const profileCalls = []
  const services = {
    settings: { botWorkspaceRoot: root, departments: depts },
    roster: {
      list: () => bots,
      async create(input) {
        createCalls.push(input)
        const cwd = join(root, String(input.department), String(input.name))
        mkdirSync(cwd, { recursive: true })
        const bot = {
          id: `nb-${bots.length + 1}`, name: input.name, cwd,
          preset: input.preset ?? '', state: 'idle', rev: 1, profile: {},
        }
        bots.push(bot)
        return bot
      },
      async setProfile(input) {
        profileCalls.push(input)
        return bots.find((b) => b.id === input.id) ?? null
      },
    },
  }
  return { base, stateDir, root, services, bots, createCalls, profileCalls }
}

/** 最小 workspaceRegistry 替身（只为验证「三级登记被调用」）。 */
function fakeCtx() {
  const created = []
  const map = new Map()
  const registry = {
    async resolveByPath(p) { return map.get(p) },
    async create(p) {
      created.push(p)
      const ws = { path: p, attachSession() {} }
      map.set(p, ws)
      return { workspace: ws, created: true }
    },
  }
  return { created, ctx: { get: (k) => (k === 'workspaceRegistry' ? registry : undefined) } }
}

// ── 核心：导入必须真的建出 Bot ───────────────────────────────────────────────
test('导入：Bot 必须被真正创建（原实现只产出 plan，一个都不建）', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t)
  const buf = exportPkg(src)
  const r = await applyImport(buf, { stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(tgt.createCalls.length, 2, `应调用 create 两次，实际 ${tgt.createCalls.length}`)
  assert.equal(tgt.bots.length, 2, 'registry 里必须真的多两个 Bot')
  assert.deepEqual(tgt.bots.map((b) => b.name).sort(), ['乙', '甲'].sort())
})

test('导入：cwd 由本机主目录重算，来源机器的绝对路径绝不带入', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t)
  await applyImport(exportPkg(src), { stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx })
  for (const call of tgt.createCalls) {
    assert.ok(!('cwd' in call) || call.cwd === undefined, '不应把来源 cwd 传给 create')
    assert.ok(typeof call.department === 'string' && call.department, '必须指定部门（走派生路径）')
  }
  for (const b of tgt.bots) {
    assert.ok(b.cwd.startsWith(tgt.root), `cwd 必须在本机主目录下：${b.cwd}`)
    assert.ok(!/^[A-Za-z]:/.test(b.cwd), '不能出现盘符残留')
    assert.ok(!b.cwd.includes(src.root), '不能带来源机器的目录')
  }
})

test('导入：包里的 deptId 决定落在哪个部门（含汉字部门）', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t)
  await applyImport(exportPkg(src), { stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx })
  const byName = new Map(tgt.createCalls.map((c) => [c.name, c]))
  assert.equal(byName.get('甲').department, 'dev')
  assert.equal(byName.get('乙').department, '测试部门1', '汉字部门 id 必须原样保留')
  const yi = tgt.bots.find((b) => b.name === '乙')
  assert.ok(yi.cwd.includes('测试部门1'), `乙 应落在汉字部门目录下：${yi.cwd}`)
})

test('导入：档案写回（身份不能丢）', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t)
  await applyImport(exportPkg(src), { stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx })
  const ids = tgt.profileCalls.map((c) => c.profile?.identity).sort()
  assert.deepEqual(ids, ['我是乙', '我是甲'])
})

// ── 同名冲突三策略 ──────────────────────────────────────────────────────────
function existingBot() {
  return { id: 'old-1', name: '甲', cwd: '/old/cs-bots/dev/甲', preset: '', state: 'idle', rev: 3, profile: {} }
}

test('同名 + overwrite：更新档案，不新建（保留 id 与会话）', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t, { existing: [existingBot()] })
  const r = await applyImport(exportPkg(src), {
    stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx, onConflict: 'overwrite',
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(tgt.createCalls.length, 1, '只有「乙」是新建的')
  assert.equal(tgt.bots.find((b) => b.name === '甲').id, 'old-1', '甲 必须保留原 id')
  assert.ok(tgt.profileCalls.some((c) => c.id === 'old-1'), '甲 的档案必须被更新')
  assert.equal(r.applied.bots.overwritten, 1)
  assert.equal(r.applied.bots.added, 1)
})

test('同名 + skip：保留本机，不动档案也不新建', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t, { existing: [existingBot()] })
  const r = await applyImport(exportPkg(src), {
    stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx, onConflict: 'skip',
  })
  assert.equal(r.applied.bots.kept, 1)
  assert.equal(tgt.createCalls.length, 1, '只建「乙」')
  assert.ok(!tgt.profileCalls.some((c) => c.id === 'old-1'), 'skip 不许动本机档案')
})

test('同名 + rename：新建一个带 _2 后缀的，原名不动', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t, { existing: [existingBot()] })
  const r = await applyImport(exportPkg(src), {
    stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx, onConflict: 'rename',
  })
  const names = tgt.createCalls.map((c) => c.name).sort()
  assert.deepEqual(names, ['乙', '甲_2'].sort(), `实际 ${JSON.stringify(names)}`)
  assert.equal(r.applied.bots.renamed, 1)
})

// ── 失败不假成功 ────────────────────────────────────────────────────────────
test('导入：部门在本机不存在 ⇒ 该条失败并给出原因，其它条照常导入', async (t) => {
  const src = sourceMachine(t)
  // 目标机删掉「测试部门1」这个部门
  const tgt = targetMachine(t)
  tgt.services.settings.departments = [{ id: 'dev', name: '开发部' }]
  writeFileSync(join(tgt.stateDir, 'settings.json'), JSON.stringify({
    botWorkspaceRoot: tgt.root, departments: tgt.services.settings.departments,
  }), 'utf8')
  const r = await applyImport(exportPkg(src), { stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx })
  assert.equal(r.ok, true)
  assert.equal(r.applied.bots.added, 1, '只有「甲」能进')
  assert.equal(r.applied.bots.failed, 1, '「乙」必须算失败，不能静默丢掉')
  assert.match(r.applied.bots.failedDetail[0].reason, /部门/)
})

test('导入：本机未设主目录 ⇒ 全部失败并说明下一步（不产生半成品目录）', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t)
  tgt.services.settings.botWorkspaceRoot = ''
  const r = await applyImport(exportPkg(src), { stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx })
  assert.equal(r.applied.bots.added, 0)
  assert.equal(r.applied.bots.failed, 2)
  assert.match(r.applied.bots.failedDetail[0].reason, /主目录/)
  assert.equal(tgt.createCalls.length, 0)
})

// ── 三级分组 ────────────────────────────────────────────────────────────────
test('导入：建 Bot 后三级分组（主目录/部门/Bot）被登记', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t)
  const f = fakeCtx()
  try {
    await applyImport(exportPkg(src), { stateDir: tgt.stateDir, services: tgt.services, ctx: f.ctx })
    assert.ok(f.created.includes(tgt.root), '主目录必须被登记')
    assert.ok(f.created.some((p) => p.endsWith('dev')), '部门目录必须被登记')
    assert.ok(f.created.some((p) => p.endsWith('甲')), 'Bot 目录必须被登记')
    // 单测环境的 workspace.json 里没有这些路径 ⇒ 走 create 分支
    const levels = new Set(f.created.map((p) => (p === tgt.root ? 'root' : p.endsWith('甲') || p.endsWith('乙') ? 'bot' : 'dept')))
    assert.ok(levels.has('root') && levels.has('dept') && levels.has('bot'), '三级都要有')
  } finally { /* 临时目录由 t.after 清理 */ }
})

// ── 校核文案跨平台 ──────────────────────────────────────────────────────────
test('校核：跨平台提示里的示例路径必须按本机分隔符输出（Boss 截图红圈）', (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t)
  const rep = inspectPackage(exportPkg(src), tgt.services)
  const w = rep.warnings.find((x) => x.includes('导入后会改到'))
  assert.ok(w, `应有「导入后会改到」提示，实际 ${JSON.stringify(rep.warnings)}`)
  // Linux 上不能出现反斜杠；Win 上不能出现正斜杠（示例路径部分）
  if (process.platform === 'win32') {
    assert.ok(!/<部门>/.test(w) || !w.split('导入后会改到')[1]?.includes('/<'), 'Win 上不能出现 /<部门>')
  } else {
    assert.ok(!w.includes('\\'), `非 Win 平台不该出现反斜杠：${w}`)
  }
})

test('导入：applyImport 对「包里没有 bots 段」不报错也不建东西', async (t) => {
  const src = sourceMachine(t)
  const tgt = targetMachine(t)
  const buf = buildExport({ stateDir: src.stateDir, services: src.services, sections: ['departments'], includeFiles: false }).buffer
  const r = await applyImport(buf, { stateDir: tgt.stateDir, services: tgt.services, ctx: fakeCtx().ctx })
  assert.equal(r.ok, true)
  assert.equal(tgt.createCalls.length, 0)
})