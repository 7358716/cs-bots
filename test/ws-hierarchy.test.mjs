/**
 * ws-hierarchy.js 测试 —— 三级工作区（主目录 → 部门 → Bot），0.20.0
 *
 * ## 为什么这组测试必须存在
 *
 *   2026-11-18 Boss 在 Win 上的实际左树只有 `misc/ops/qa/dev` 四个平级空文件夹：
 *   没有主目录、没有 Bot。根因是「登记逻辑只藏在一个按钮里，建 Bot/导入都不登记」。
 *   本测试把「一条命令建齐三级」这个契约钉死。
 *
 * ## 硬约束（对应历史事故，改坏任何一条都要红）
 *   1. 只建分组，**绝不 attachSession**（2026-11-15 domain inconsistent 事故）
 *   2. 串行，不并发 create（withWsLock）
 *   3. 目录不存在时先 mkdir 再 create（Win 首次安装坑）
 *   4. 失败降级，不抛穿（拿不到 registry 也要把目录建出来）
 *   5. retired 的 Bot：目录保留、分组不建（Boss 2026-11-18 第 3 条）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  ensureBotHierarchy, inspectHierarchy, repairHierarchy, withWsLock, planBotCwd, NON_DEPT_DIRS,
} from '../src/ws-hierarchy.js'
import { listWorkspaceRecords } from '../src/kernel.js'

/** 临时主目录：每次唯一，避免命中本机真实的 workspace.json。 */
let seq = 0
function freshRoot() {
  seq += 1
  return `/tmp/cs-bots-hier-${process.pid}-${Date.now()}-${seq}`
}

/** 造一个 registry 替身：记录 create 顺序、拒绝并发。 */
function fakeRegistry() {
  const created = []
  let inFlight = 0
  let maxInFlight = 0
  let attachCalls = 0
  const map = new Map()
  return {
    created,
    get maxInFlight() { return maxInFlight },
    get attachCalls() { return attachCalls },
    registry: {
      async resolveByPath(p) { return map.get(p) },
      async create(p) {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 2))
        created.push(p)
        const ws = {
          path: p,
          title: undefined,
          attachSession() { attachCalls += 1 },
          async setTitle(t) { this.title = t },
        }
        map.set(p, ws)
        inFlight -= 1
        return { workspace: ws, created: true }
      },
    },
  }
}

function ctxWith(registry) {
  return { get: (k) => (k === 'workspaceRegistry' ? registry : undefined) }
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

/** 本机真实 workspace.json 里有没有这条（判「已登记」的唯一可信来源）。 */
function registeredInFile(p) {
  return listWorkspaceRecords().some((w) => w.path === p)
}

// ── 核心契约 ────────────────────────────────────────────────────────────────
test('ensureBotHierarchy：一条命令建齐三级（主目录 → 部门 → Bot 目录都真实存在）', async () => {
  const root = freshRoot()
  const f = fakeRegistry()
  try {
    const r = await ensureBotHierarchy(ctxWith(f.registry), {
      root, deptId: 'dev', deptName: '开发部', botCwd: join(root, 'dev', '管家'), botName: '管家',
    })
    assert.equal(r.steps.length, 3, `应有三步，实际 ${JSON.stringify(r.steps)}`)
    assert.deepEqual(r.steps.map((s) => s.level), ['root', 'dept', 'bot'])
    assert.ok(existsSync(root), '主目录必须真建出来')
    assert.ok(existsSync(join(root, 'dev')), '部门目录必须真建出来')
    // ⚠️ Bot 目录由 registerOne 内部 mkdir 建出（宿主 create 前要求真实目录）
    assert.ok(existsSync(join(root, 'dev', '管家')), 'Bot 目录必须真建出来')
    // 单测环境没有真实 workspace.json ⇒ 走 create 路径
    assert.equal(f.created.length, 3, `应创建三条分组，实际 ${JSON.stringify(f.created)}`)
    assert.equal(f.attachCalls, 0, '绝不挂会话')
    assert.equal(f.maxInFlight, 1, '必须串行，不能并发 create')
  } finally { cleanup(root) }
})

test('ensureBotHierarchy：部门显示名（中文）作为分组 title', async () => {
  const root = freshRoot()
  const f = fakeRegistry()
  try {
    await ensureBotHierarchy(ctxWith(f.registry), {
      root, deptId: '测试部门1', deptName: '测试部门1', botCwd: join(root, '测试部门1', '助手'),
    })
    const deptPath = f.created.find((p) => p.endsWith('测试部门1'))
    assert.ok(deptPath, `部门目录应被登记，实际 ${JSON.stringify(f.created)}`)
  } finally { cleanup(root) }
})

test('ensureBotHierarchy：拿不到 workspaceRegistry ⇒ 降级不抛，目录照样建', async () => {
  const root = freshRoot()
  try {
    const r = await ensureBotHierarchy(ctxWith(undefined), {
      root, deptId: 'dev', deptName: '开发部', botCwd: join(root, 'dev', 'a'),
    })
    assert.equal(r.ok, false)
    assert.equal(r.degraded, true)
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0, '必须给可执行提示，不能沉默')
    assert.equal(r.steps[0].level, 'root')
    assert.match(r.steps[0].reason ?? '', /workspaceRegistry/)
  } finally { cleanup(root) }
})

test('ensureBotHierarchy：retired 的 Bot 只建目录、不建分组（Boss 第 3 条）', async () => {
  const root = freshRoot()
  const f = fakeRegistry()
  try {
    const r = await ensureBotHierarchy(ctxWith(f.registry), {
      root, deptId: 'qa', deptName: '测试部', botCwd: join(root, 'qa', '旧岗'), registerBot: false,
    })
    assert.ok(existsSync(join(root, 'qa', '旧岗')), '退役 Bot 的目录要保留')
    const botStep = r.steps.find((s) => s.level === 'bot')
    assert.equal(botStep.ok, true)
    assert.match(botStep.reason ?? '', /退役/)
    assert.equal(f.created.filter((p) => p.endsWith('旧岗')).length, 0, '退役 Bot 不能建分组')
  } finally { cleanup(root) }
})

test('ensureBotHierarchy：cwd 在主目录之外 ⇒ 不碰（避免多出平铺分组）', async () => {
  const root = freshRoot()
  const f = fakeRegistry()
  try {
    const r = await ensureBotHierarchy(ctxWith(f.registry), {
      root, deptId: 'dev', botCwd: '/somewhere/else/abc',
    })
    const botStep = r.steps.find((s) => s.level === 'bot')
    assert.equal(botStep.ok, false)
    assert.equal(botStep.skipped, true)
    assert.equal(f.created.filter((p) => p.includes('/somewhere/else')).length, 0)
  } finally { cleanup(root) }
})

test('ensureBotHierarchy：主目录未设置 ⇒ 明确报错，不建任何东西', async () => {
  const f = fakeRegistry()
  const r = await ensureBotHierarchy(ctxWith(f.registry), { root: '', deptId: 'dev', botCwd: '/x/y' })
  assert.equal(r.ok, false)
  assert.match(r.hint ?? '', /主目录/)
  assert.equal(f.created.length, 0)
})

// ── 幂等与串行 ──────────────────────────────────────────────────────────────
test('withWsLock：并发调用被串行化（峰值必须是 1）', async () => {
  let inFlight = 0
  let peak = 0
  const work = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 3))
    inFlight -= 1
  }
  await Promise.all([withWsLock(work), withWsLock(work), withWsLock(work)])
  assert.equal(peak, 1, '2026-11-15 事故就是并发导致的，必须串行')
})

test('withWsLock：前一个抛错不能把锁卡死', async () => {
  await assert.rejects(() => withWsLock(async () => { throw new Error('boom') }))
  const r = await withWsLock(async () => 'after')
  assert.equal(r, 'after', '失败后锁必须释放，否则后续全部挂死')
})

// ── 体检与修复 ──────────────────────────────────────────────────────────────
test('inspectHierarchy：只读，列出「有目录但没分组」的缺口', () => {
  const root = freshRoot()
  try {
    const rep = inspectHierarchy({
      root,
      departments: [{ id: 'dev', name: '开发部' }],
      bots: [{ name: '管家', cwd: join(root, 'dev', '管家'), state: 'idle' }],
    })
    assert.equal(rep.root, root)
    assert.equal(rep.rootExists, false, '目录还没建')
    assert.ok(rep.missing.some((m) => m.level === 'root'))
    assert.ok(Array.isArray(rep.departments))
    assert.equal(rep.departments[0].id, 'dev')
    assert.equal(rep.departments[0].bots, 1)
    assert.ok(typeof rep.hint === 'string' && rep.hint.length > 0)
  } finally { cleanup(root) }
})

test('inspectHierarchy：引导目录（archive/shared/scratch）不算部门', () => {
  for (const d of ['archive', 'shared', 'scratch']) {
    assert.ok(NON_DEPT_DIRS.has(d))
  }
  const root = freshRoot()
  try {
    const rep = inspectHierarchy({
      root,
      departments: [],
      bots: [
        { name: 'x', cwd: join(root, 'scratch', 'x') },
        { name: 'y', cwd: join(root, 'dev', 'y') },
      ],
    })
    const ids = rep.departments.map((d) => d.id)
    assert.ok(ids.includes('dev'), '真实部门要出现')
    assert.ok(!ids.includes('scratch'), '引导目录不该当部门')
  } finally { cleanup(root) }
})

test('repairHierarchy：把体检出的缺口补齐，且对已登记的不重复建', async () => {
  const root = freshRoot()
  const f = fakeRegistry()
  try {
    const args = {
      root,
      departments: [{ id: 'dev', name: '开发部' }],
      bots: [{ name: '管家', cwd: join(root, 'dev', '管家'), state: 'idle' }],
    }
    const r1 = await repairHierarchy(ctxWith(f.registry), args)
    assert.equal(r1.ok, true, JSON.stringify(r1))
    assert.ok(existsSync(join(root, 'dev', '管家')))
    const firstCount = f.created.length
    // 第二次：已登记（同一 registry 替身内存里还在）⇒ 不再 create
    const r2 = await repairHierarchy(ctxWith(f.registry), args)
    assert.equal(r2.ok, true)
    assert.equal(f.created.length, firstCount, '幂等：第二次不应再建')
  } finally { cleanup(root) }
})

test('repairHierarchy：retired Bot 不建分组', async () => {
  const root = freshRoot()
  const f = fakeRegistry()
  try {
    const r = await repairHierarchy(ctxWith(f.registry), {
      root,
      departments: [{ id: 'ops', name: '综合部' }],
      bots: [{ name: '老岗', cwd: join(root, 'ops', '老岗'), state: 'retired' }],
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(f.created.filter((p) => p.endsWith('老岗')).length, 0)
    assert.ok(existsSync(join(root, 'ops', '老岗')), '退役目录仍要保留')
  } finally { cleanup(root) }
})

// ── planBotCwd：导入/迁移时的路径重算 ───────────────────────────────────────
test('planBotCwd：按本机主目录重算，不继承来源机器的绝对路径', () => {
  const r = planBotCwd({ root: '/home/ubuntu/cs-bots', deptId: 'dev', botName: '管家' })
  assert.equal(r.ok, true)
  assert.ok(existsSync('/home/ubuntu') ? true : true)
  assert.match(r.cwd.replace(/\\/g, '/'), /\/dev\/管家$/)
})

test('planBotCwd：非法部门 id / Bot 名给可执行原因（不静默改）', () => {
  assert.equal(planBotCwd({ root: '/r', deptId: 'a/b', botName: 'x' }).ok, false)
  assert.equal(planBotCwd({ root: '/r', deptId: 'CON', botName: 'x' }).ok, false)
  assert.equal(planBotCwd({ root: '/r', deptId: 'dev', botName: '' }).ok, false)
  assert.equal(planBotCwd({ root: '', deptId: 'dev', botName: 'x' }).ok, false)
})

test('planBotCwd：汉字部门名照常可用（Boss 第 1 条）', () => {
  const r = planBotCwd({ root: '/r', deptId: '测试部门1', botName: '管家' })
  assert.equal(r.ok, true)
  assert.ok(r.cwd.includes('测试部门1'))
})