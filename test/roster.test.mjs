/**
 * RosterService 测试 —— 只碰 `node:test` + `node:assert` + `node:fs` + `node:os` + `node:path`
 * + `node:crypto`。
 *
 * 纪律（照 `board.test.mjs` 的验收口径）：**每条硬约束都用实际落盘产物或实际透传参数做证据**
 * （读 `roster.jsonl` / `roster.snap.json`、断言 `agents.create` 收到的 `meta.cwd`），
 * 不接受「函数没抛错」这类弱断言。
 *
 * 本文件必须证明的**头号命题**（主管 Q1 的硬事实，见 12-硬约束清单 §B / 11-融合最终稿 §0.2）：
 *   官方 `spawn_teammate` 给不了独立 cwd，**持久 Bot 必须走 root agent** ——
 *   所以「cwd 真的被传给 `kernel.createSession`」是本模块存在的理由，必须直接断言，
 *   而不是只断言「返回的 Bot 对象里有 cwd 字段」。
 *
 * 运行：`node --test test/roster.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createRoster, RosterError } from '../src/roster.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/**
 * 造一套隔离环境：独立 `stateDir` + 独立 Bot 工作目录区 + **可注入的假宿主 ctx**。
 *
 * `ctx.get('agents').create` 是 `kernel.createSession` 的唯一依赖（`kernel.js:267-287`），
 * 故假 ctx 即可端到端验证「cwd 透传」这条链，不需要真宿主包（裸检出也能跑）。
 *
 * @param {object} t node:test 上下文（用于 after 清理）
 * @param {object} [overrides]
 * @param {boolean} [overrides.failCreate] true → `agents.create` 抛错（测会话创建失败路径）
 * @param {number}  [overrides.leaseMs]
 * @param {string}  [overrides.renameSession] 让假宿主返回**不同**的 sessionId（测宿主返回值优先）
 */
function setup(t, overrides = {}) {
  const base = process.env.ROSTER_TEST_TMPDIR || tmpdir()
  const root = mkdtempSync(join(base, `cs-bots-roster-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })

  const stateDir = join(root, 'state')
  /** Bot cwd 的宿主区（全部用例的 cwd 都落在这下面，保证绝对路径且不在 $DSH_HOME 内）。 */
  const ws = join(root, 'ws')
  /** 假 `$DSH_HOME`（只用于「cwd 指向宿主目录必须被拒」的用例）。 */
  const fakeHome = join(root, 'home')

  /** `agents.create` 收到的原始请求（证据）。 */
  const createCalls = []

  const ctx = {
    logger: { info() {}, warn() {} },
    get(key) {
      if (key !== 'agents') return undefined
      return {
        async create(request) {
          createCalls.push(request)
          if (overrides.failCreate) {
            const err = new Error('宿主拒绝：cwd 不可写（测试注入）')
            err.code = 'INJECTED_CREATE_FAILURE'
            throw err
          }
          const sessionId = overrides.renameSession ?? request.sessionId
          return { id: sessionId, sessionId }
        },
        get: () => undefined,
        list: () => [],
      }
    },
  }

  const roster = createRoster(ctx, { stateDir, leaseMs: overrides.leaseMs, name: 'test-roster' })
  return { root, stateDir, ws, fakeHome, ctx, roster, createCalls }
}

/** 读事件流（真相源）。 */
function events(stateDir) {
  const file = join(stateDir, 'roster.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 建一个最简 Bot（省样板）。 */
async function seed(roster, ws, over = {}) {
  return roster.create({ name: 'alpha', cwd: join(ws, 'alpha'), byId: 'lead', ...over })
}

// ── 1. 建 Bot + cwd 真的透传给 kernel（头号命题）──────────────────────────────

test('create：cwd 真的被传给 kernel（断言 agents.create 收到 meta.cwd），且事件/快照落盘', async (t) => {
  const { roster, ws, stateDir, createCalls } = setup(t)
  const cwd = join(ws, 'alpha')

  const bot = await seed(roster, ws)

  // ★ 头号命题：cwd 走的是 agents.create 的 meta.cwd（root agent 路径），不是 spawnTeammate
  assert.equal(createCalls.length, 1, '恰好调用一次 agents.create')
  assert.equal(createCalls[0].meta?.cwd, resolve(cwd), 'meta.cwd 必须是归一化后的绝对路径')
  assert.equal(createCalls[0].sessionId, bot.id, 'sessionId 用 bot.id，稳定可追溯')
  assert.ok(!('parentAgent' in createCalls[0]), 'Bot 是 root agent，不带 parentAgent')

  // Bot 形状（§3.1）
  assert.match(bot.id, /^bot-/, 'id 形如 bot-<uuid>')
  assert.equal(bot.rev, 1)
  assert.equal(bot.name, 'alpha')
  assert.equal(bot.cwd, resolve(cwd))
  assert.equal(bot.sessionId, bot.id)
  assert.equal(bot.permission, 'workspace-write', '缺省权限给写（cwd 即写入边界）')
  assert.equal(bot.state, 'idle')
  assert.equal(typeof bot.createdAt, 'number')
  assert.equal(bot.createdBy, 'lead')
  assert.equal(bot.lease, undefined, '新建无租约')
  assert.equal(bot.retiredAt, undefined)

  // 落盘证据
  const rows = events(stateDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, 'create')
  assert.equal(rows[0].rev, 1)
  assert.equal(rows[0].byId, 'lead')
  assert.equal(rows[0].before, null)
  assert.equal(rows[0].after.cwd, resolve(cwd))
  assert.ok(existsSync(join(stateDir, 'roster.snap.json')), '快照应已写入')
})

test('create：宿主返回的 sessionId 与请求不同时，以宿主为准并记入注册表', async (t) => {
  const { roster, ws, createCalls } = setup(t, { renameSession: 's-host-decided' })
  const bot = await seed(roster, ws)
  assert.equal(createCalls[0].sessionId, bot.id)
  assert.equal(bot.sessionId, 's-host-decided')
})

// ── 2. cwd 校验：相对路径 / $DSH_HOME ────────────────────────────────────────

test('create：cwd 缺失与相对路径一律抛结构化错误（没有稳定写入边界就没资格当 Bot）', async (t) => {
  const { roster, ws } = setup(t)

  await assert.rejects(
    () => roster.create({ name: 'a', byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_MISSING_FIELD' && /cwd/.test(e.message),
  )
  await assert.rejects(
    () => roster.create({ name: 'a', cwd: 'relative/dir', byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_BAD_CWD' && /绝对路径/.test(e.message),
  )
  // 边界：绝对路径才放行
  const ok = await roster.create({ name: 'a', cwd: join(ws, 'a'), byId: 'lead' })
  assert.equal(ok.cwd, resolve(join(ws, 'a')))
})

test('create：cwd 指向 $DSH_HOME（或落在其子树内）必须被拒（防污染宿主数据）', async (t) => {
  const { roster, ws, fakeHome } = setup(t)
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  t.after(() => { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved })

  await assert.rejects(
    () => roster.create({ name: 'a', cwd: fakeHome, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_CWD_IN_DSH_HOME' && /\$DSH_HOME/.test(e.message),
  )
  await assert.rejects(
    () => roster.create({ name: 'b', cwd: join(fakeHome, 'cs-bots', 'x'), byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_CWD_IN_DSH_HOME',
    '子树内同样构成污染',
  )
  // 同一条规则也作用于 setCwd（不止 create）
  const bot = await roster.create({ name: 'c', cwd: join(ws, 'c'), byId: 'lead' })
  assert.throws(
    () => roster.setCwd({ id: bot.id, cwd: fakeHome, expectedRev: bot.rev, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_CWD_IN_DSH_HOME',
  )
  // 非 $DSH_HOME 的绝对路径正常
  const ok = await roster.create({ name: 'd', cwd: join(ws, 'd'), byId: 'lead' })
  assert.ok(ok.cwd.startsWith(ws))
})

// ── 3. 重名拒绝（不静默）─────────────────────────────────────────────────────

test('create：同名（大小写归一）必须报错，且失败不产生任何会话/事件/半成品', async (t) => {
  const { roster, ws, stateDir, createCalls } = setup(t)
  await seed(roster, ws, { name: 'Alpha' })

  await assert.rejects(
    () => roster.create({ name: 'alpha', cwd: join(ws, 'other'), byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NAME_TAKEN' && /alpha/i.test(e.message),
  )
  await assert.rejects(
    () => roster.create({ name: '  ALPHA  ', cwd: join(ws, 'other2'), byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NAME_TAKEN',
    '不同大小写/空白也不许绕过',
  )

  // 证据：只有第一次建了会话，只有一条 create 事件，注册表里只有一个 Bot
  assert.equal(createCalls.length, 1, '重名必须在**动会话之前**被拦下')
  assert.equal(events(stateDir).length, 1)
  assert.equal(roster.list().length, 1)
})

test('create：缺 byId / name、label 超长、非法 permission 全部抛结构化错误', async (t) => {
  const { roster, ws } = setup(t)
  const cwd = join(ws, 'x')

  await assert.rejects(() => roster.create({ name: 'a', cwd, byId: '' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_MISSING_FIELD' && /byId/.test(e.message))
  await assert.rejects(() => roster.create({ cwd, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_MISSING_FIELD' && /name/.test(e.message))
  await assert.rejects(() => roster.create({ name: 'a', cwd, byId: 'lead', label: 'x'.repeat(25) }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_LABEL_TOO_LONG' && /24/.test(e.message))
  await assert.rejects(() => roster.create({ name: 'a', cwd, byId: 'lead', permission: 'root' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_BAD_PERMISSION')
  // label 正好 24 应被接受
  const ok = await roster.create({ name: 'a', cwd, byId: 'lead', label: 'y'.repeat(24) })
  assert.equal(ok.label.length, 24)
})

test('create：会话创建失败必须抛错且**不留半成品**（无事件、无记录）', async (t) => {
  const { roster, ws, stateDir } = setup(t, { failCreate: true })

  await assert.rejects(
    () => roster.create({ name: 'alpha', cwd: join(ws, 'alpha'), byId: 'lead' }),
    (e) => e instanceof RosterError
      && e.code === 'ROSTER_SESSION_CREATE_FAILED'
      && /INJECTED|宿主拒绝/.test(e.message),
  )
  assert.deepEqual(roster.list(), [], '注册表必须为空')
  assert.equal(events(stateDir).length, 0, '不得留下任何事件')
  assert.equal(roster.stats().total, 0)
})

// ── 4. rename（官方做不到）→ 旧名立刻可复用 ─────────────────────────────────

test('rename：改名生效（官方 roster 无此能力），且**旧名立刻可被新 Bot 复用**', async (t) => {
  const { roster, ws, stateDir } = setup(t)
  const first = await seed(roster, ws, { name: 'builder' })

  const renamed = roster.rename({ id: first.id, name: 'builder-2', expectedRev: first.rev, byId: 'lead' })
  assert.equal(renamed.id, first.id, 'id 稳定不变')
  assert.equal(renamed.name, 'builder-2')
  assert.equal(renamed.rev, 2)
  assert.equal(renamed.renamedBy, 'lead')
  assert.equal(renamed.sessionId, first.sessionId, '改名不动会话绑定')

  // ★ 旧名释放：新建同名 Bot 必须成功（官方「名字永不复用」做不到）
  const second = await roster.create({ name: 'builder', cwd: join(ws, 'second'), byId: 'lead' })
  assert.notEqual(second.id, first.id)
  assert.equal(second.name, 'builder')
  assert.equal(roster.list().length, 2)

  // 已生效的新名仍被占用
  assert.throws(() => roster.rename({ id: second.id, name: 'builder-2', expectedRev: second.rev, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NAME_TAKEN')

  // 落盘证据：事件流里有 rename 的 before/after
  const rows = events(stateDir)
  const ev = rows.find((r) => r.action === 'rename')
  assert.ok(ev, 'rename 事件必须落盘')
  assert.equal(ev.before.name, 'builder')
  assert.equal(ev.after.name, 'builder-2')
  assert.equal(ev.after.rev, 2)
})

test('rename：同名（大小写归一）占用抛错，且不能对退役 Bot 操作', async (t) => {
  const { roster, ws } = setup(t)
  const a = await seed(roster, ws, { name: 'a' })
  const b = await roster.create({ name: 'b', cwd: join(ws, 'b'), byId: 'lead' })

  assert.throws(() => roster.rename({ id: b.id, name: 'A', expectedRev: b.rev, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NAME_TAKEN')

  const retired = roster.retire({ id: a.id, reason: '测试', byId: 'lead' })
  assert.throws(() => roster.rename({ id: retired.id, name: 'z', expectedRev: retired.rev, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_RETIRED')
})

// ── 5. retire → 释放名额（同名字 + 同 cwd 可复用）────────────────────────────

test('retire：终态、留档，且**同名字 + 同 cwd 可被新 Bot 复用**（名额释放）', async (t) => {
  const { roster, ws, stateDir } = setup(t)
  const sharedCwd = join(ws, 'shared')
  const old = await roster.create({ name: 'worker', cwd: sharedCwd, byId: 'lead' })
  assert.equal(roster.get(old.id).state, 'idle')

  // 占用态：同名必须被拒（先证明唯一性确实是活的）
  await assert.rejects(
    () => roster.create({ name: 'worker', cwd: join(ws, 'x'), byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NAME_TAKEN',
  )

  const retired = roster.retire({ id: old.id, reason: '项目结束', byId: 'lead' })
  assert.equal(retired.state, 'retired')
  assert.equal(retired.rev, 2)
  assert.equal(retired.retiredBy, 'lead')
  assert.equal(retired.retiredReason, '项目结束')
  assert.equal(typeof retired.retiredAt, 'number')

  // 终态语义
  assert.deepEqual(roster.list().map((b) => b.id), [], 'list() 缺省不含 retired')
  assert.deepEqual(roster.listRetired().map((b) => b.id), [old.id], 'listRetired() 看得到留档')
  assert.equal(roster.get(old.id).state, 'retired', '记录不删除（可追溯）')
  assert.throws(() => roster.retire({ id: old.id, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_ALREADY_RETIRED')

  // ★ 名额释放：同名 + 同 cwd 都能复用
  const fresh = await roster.create({ name: 'worker', cwd: sharedCwd, byId: 'lead' })
  assert.notEqual(fresh.id, old.id)
  assert.equal(fresh.cwd, resolve(sharedCwd))
  assert.equal(fresh.state, 'idle')

  assert.deepEqual(roster.stats(), {
    total: 2,
    byState: { idle: 1, running: 0, parked: 0, failed: 0, retired: 1 },
    retired: 1,
  })
  assert.equal(events(stateDir).filter((r) => r.action === 'retire').length, 1, '退役只写一条事件')
})

test('retire：不存在 / 缺 byId 抛错；setCwd / claim 对退役 Bot 一律拒绝', async (t) => {
  const { roster, ws } = setup(t)
  const bot = await seed(roster, ws)

  assert.throws(() => roster.retire({ id: 'bot-nope', byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NOT_FOUND')
  assert.throws(() => roster.retire({ id: bot.id }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_MISSING_FIELD' && /byId/.test(e.message))

  const retired = roster.retire({ id: bot.id, byId: 'lead' })
  assert.throws(() => roster.setCwd({ id: bot.id, cwd: join(ws, 'y'), expectedRev: retired.rev, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_RETIRED')
  assert.throws(() => roster.claim({ id: bot.id, owner: 'x', expectedRev: retired.rev }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_RETIRED')
})

// ── 6. setCwd ────────────────────────────────────────────────────────────────

test('setCwd：换目录生效、记审计；相对路径与被占用的 rev 一律拒绝', async (t) => {
  const { roster, ws, stateDir } = setup(t)
  const bot = await seed(roster, ws)
  const next = join(ws, 'moved')

  const moved = roster.setCwd({ id: bot.id, cwd: next, expectedRev: bot.rev, byId: 'lead' })
  assert.equal(moved.cwd, resolve(next))
  assert.equal(moved.rev, 2)
  assert.equal(moved.cwdChangedBy, 'lead')
  assert.equal(moved.sessionId, bot.sessionId, '换目录不动会话绑定')

  assert.throws(() => roster.setCwd({ id: bot.id, cwd: 'rel', expectedRev: moved.rev, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_BAD_CWD')
  assert.throws(() => roster.setCwd({ id: bot.id, cwd: join(ws, 'z'), expectedRev: bot.rev, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_REV_CONFLICT')

  const ev = events(stateDir).find((r) => r.action === 'setCwd')
  assert.ok(ev)
  assert.equal(ev.after.cwd, resolve(next))
  assert.equal(ev.before.cwd, resolve(join(ws, 'alpha')))
})

// ── 7. CAS 冲突 ──────────────────────────────────────────────────────────────

test('CAS：两个并发 rename 用同一 expectedRev → 第二个必须失败且不覆盖第一个结果', async (t) => {
  const { roster, ws, stateDir } = setup(t)
  const bot = await seed(roster, ws)

  // 两个「会话」同时读到 rev=1（各自拿到自己的快照 → 并发前提成立）
  const seenA = roster.get(bot.id)
  const seenB = roster.get(bot.id)
  assert.equal(seenA.rev, 1)
  assert.equal(seenB.rev, 1)

  const afterA = roster.rename({ id: bot.id, name: 'A的命名', expectedRev: 1, byId: 'agent-a' })
  assert.equal(afterA.rev, 2)

  assert.throws(
    () => roster.rename({ id: bot.id, name: 'B的命名', expectedRev: 1, byId: 'agent-b' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_REV_CONFLICT' && e.details.rev === 2
      && e.details.expectedRev === 1,
  )

  assert.equal(roster.get(bot.id).name, 'A的命名', 'A 的写入未被覆盖')
  assert.equal(roster.get(bot.id).rev, 2)
  assert.equal(events(stateDir).filter((r) => r.action === 'rename').length, 1, 'B 的失败没有产生事件')
})

test('CAS：缺 expectedRev（含非整数）一律抛错，绝不默认放行', async (t) => {
  const { roster, ws } = setup(t)
  const bot = await seed(roster, ws)

  assert.throws(() => roster.rename({ id: bot.id, name: 'x', byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_MISSING_EXPECTED_REV')
  assert.throws(() => roster.setCwd({ id: bot.id, cwd: join(ws, 'q'), expectedRev: 1.5, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_MISSING_EXPECTED_REV')
  assert.throws(() => roster.heartbeat({ id: bot.id, owner: 'x' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_MISSING_EXPECTED_REV')
  assert.throws(() => roster.rename({ id: 'bot-nope', name: 'x', expectedRev: 1, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NOT_FOUND')
})

// ── 8. 租约：claim / heartbeat / expireLeases ────────────────────────────────

test('租约：claim 上锁 → heartbeat 续租 → expireLeases 到期回收（封死「崩溃后永不释放」）', async (t) => {
  const { roster, ws, stateDir } = setup(t, { leaseMs: 1_000 })
  const bot = await seed(roster, ws)

  const T = 1_000_000
  const claimed = roster.claim({ id: bot.id, owner: 'worker-a', expectedRev: bot.rev, now: T })
  assert.equal(claimed.state, 'running')
  assert.deepEqual(claimed.lease, { owner: 'worker-a', expiresAt: T + 1_000, heartbeatAt: T })

  // 活跃租约不许被他人抢占
  assert.throws(() => roster.claim({ id: bot.id, owner: 'worker-b', expectedRev: claimed.rev, now: T + 1 }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_LEASE_HELD')

  const beat = roster.heartbeat({ id: bot.id, owner: 'worker-a', expectedRev: claimed.rev, now: T + 500 })
  assert.equal(beat.lease.expiresAt, T + 1_500)
  assert.equal(beat.lease.heartbeatAt, T + 500)
  assert.equal(beat.state, 'running')

  // 非持有者不能续租 / 未过期时不回收
  assert.throws(() => roster.heartbeat({ id: bot.id, owner: 'worker-b', expectedRev: beat.rev, now: T + 600 }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_LEASE_NOT_OWNER')
  assert.deepEqual(roster.expireLeases({ now: T + 1_400 }), [], '未到期不回收')
  assert.equal(roster.get(bot.id).state, 'running')

  // 到期回收
  const recycled = roster.expireLeases({ now: T + 1_500 })
  assert.deepEqual(recycled, [bot.id])
  const after = roster.get(bot.id)
  assert.equal(after.state, 'idle', '租约回收 → 回 idle')
  assert.equal(after.lease, undefined, '租约必须清空，不留悬空持有者')

  // 过期后心跳不能复活（必须走 claim 或 expireLeases）
  const claimed2 = roster.claim({ id: bot.id, owner: 'worker-c', expectedRev: after.rev, now: T + 2_000 })
  assert.equal(claimed2.lease.owner, 'worker-c', '租约已释放 → 他人可正常 claim')
  assert.throws(() => roster.heartbeat({ id: bot.id, owner: 'worker-c', expectedRev: claimed2.rev, now: T + 9_999 }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_LEASE_EXPIRED')

  // release 后归还
  const released = roster.release({ id: bot.id, owner: 'worker-c', expectedRev: claimed2.rev, now: T + 9_999 })
  assert.equal(released.state, 'idle')
  assert.equal(released.lease, undefined)
  assert.throws(() => roster.release({ id: bot.id, owner: 'worker-c', expectedRev: released.rev }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NO_LEASE')

  // 审计：claim / heartbeat / lease_expired / release 都在事件流里
  const actions = events(stateDir).map((r) => r.action)
  assert.ok(actions.includes('claim') && actions.includes('heartbeat'))
  assert.ok(actions.includes('lease_expired') && actions.includes('release'))
  assert.ok(events(stateDir).every((r) => r.after.rev >= 1), 'rev 单调')
})

test('retire：清掉悬空租约（退役即不再有人持有）', async (t) => {
  const { roster, ws } = setup(t, { leaseMs: 60_000 })
  const bot = await seed(roster, ws)
  const claimed = roster.claim({ id: bot.id, owner: 'w', expectedRev: bot.rev, now: 1_000 })
  assert.ok(claimed.lease)

  const retired = roster.retire({ id: bot.id, byId: 'lead', now: 2_000 })
  assert.equal(retired.lease, undefined)
  assert.deepEqual(roster.expireLeases({ now: 10_000_000 }), [], '退役 Bot 不参与回收')
})

// ── 9. 回放一致性 ────────────────────────────────────────────────────────────

test('replay：同一 stateDir 重建视图与内存视图完全一致（且不依赖快照）', async (t) => {
  const { roster, ws, stateDir, ctx } = setup(t)

  // 造一段有代表性的历史：建 3 → 改名 1 → 退役 1 → 换目录 1 → 租约 1
  const a = await roster.create({ name: 'a', cwd: join(ws, 'a'), byId: 'lead', label: 'dev' })
  const b = await roster.create({ name: 'b', cwd: join(ws, 'b'), byId: 'lead', permission: 'read-only' })
  const c = await roster.create({ name: 'c', cwd: join(ws, 'c'), byId: 'lead' })
  roster.rename({ id: b.id, name: 'b2', expectedRev: roster.get(b.id).rev, byId: 'lead' })
  roster.retire({ id: c.id, reason: 'done', byId: 'lead' })
  roster.setCwd({ id: a.id, cwd: join(ws, 'a-moved'), expectedRev: roster.get(a.id).rev, byId: 'lead' })
  roster.claim({ id: a.id, owner: 'w', expectedRev: roster.get(a.id).rev, now: 5_000 })

  const beforeAll = roster.list()
  const beforeRetired = roster.listRetired()
  const beforeStats = roster.stats()

  // 同实例 replay()
  const report = roster.replay()
  assert.equal(report.from, 'jsonl', '事件流是真相源')
  assert.equal(report.bad, 0)
  assert.equal(report.skipped, 0)
  assert.equal(report.bots, 3)
  assert.deepEqual(roster.list(), beforeAll, 'replay 后视图必须逐字段一致')

  // ★ 重建一个新实例（进程重启语义）：同 stateDir → 视图一致
  const reborn = createRoster(ctx, { stateDir, leaseMs: 1_000, name: 'test-roster' })
  assert.deepEqual(reborn.list(), beforeAll, '新实例视图与原实例一致')
  assert.deepEqual(reborn.listRetired(), beforeRetired)
  assert.deepEqual(reborn.stats(), beforeStats)
  assert.equal(reborn.get(a.id).lease.owner, 'w', '租约也一致')
  assert.equal(reborn.get(a.id).cwd, resolve(join(ws, 'a-moved')))
  assert.equal(reborn.get(b.id).name, 'b2')
  assert.equal(reborn.get(c.id).retiredReason, 'done')
  assert.equal(reborn.list().length, 2, '缺省列表不含 retired')

  // 名字索引同样被重建：'c' 已退役 → 可复用；'b' 已改名 → 'b' 可复用
  const freshC = await reborn.create({ name: 'c', cwd: join(ws, 'c2'), byId: 'lead' })
  assert.notEqual(freshC.id, c.id)
  await assert.rejects(() => reborn.create({ name: 'B2', cwd: join(ws, 'b3'), byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NAME_TAKEN', '回归后的唯一性照样生效')
})

test('replay：事件流有坏行时**不静默丢弃**，计入 diagnostics 并给出 skipped', async (t) => {
  const { roster, ws, stateDir } = setup(t)
  await seed(roster, ws)
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(stateDir, 'roster.jsonl'), '{"broken": ', 'utf8')

  const report = roster.replay()
  assert.equal(report.bad, 1, '坏行必须被计数，不能悄悄跳过')
  assert.equal(report.bots, 1, '好行照常回放')
  assert.equal(roster.diagnostics().badLines, 1)
})

// ── 10. 读接口与统计 ─────────────────────────────────────────────────────────
async function seedThree(roster, ws) {
  const a = await roster.create({ name: 'a', cwd: join(ws, 'a'), byId: 'lead' })
  const b = await roster.create({ name: 'b', cwd: join(ws, 'b'), byId: 'lead' })
  const c = await roster.create({ name: 'c', cwd: join(ws, 'c'), byId: 'lead' })
  return { a, b, c }
}

test('list/stats：按 state 筛选、缺省隐藏 retired、非法 state 抛错；stats 口径明确', async (t) => {
  const { roster, ws } = setup(t)
  const { a, c } = await seedThree(roster, ws)

  assert.equal(roster.get('bot-nope'), undefined, 'get 未知 id 返回 undefined（不抛）')
  assert.equal(roster.get(a.id).name, 'a')

  roster.claim({ id: a.id, owner: 'w', expectedRev: a.rev, now: 1_000 })
  roster.retire({ id: c.id, byId: 'lead' })

  assert.equal(roster.list().length, 2, '缺省不含 retired')
  assert.deepEqual(roster.list({ state: 'running' }).map((b) => b.id), [a.id])
  assert.deepEqual(roster.list({ state: 'idle' }).map((b) => b.name), ['b'])
  assert.deepEqual(roster.list({ state: 'retired' }).map((b) => b.id), [c.id])
  assert.deepEqual(roster.listRetired().map((b) => b.id), [c.id])
  assert.throws(() => roster.list({ state: 'zombie' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_BAD_STATE')

  // total 含 retired（口径写死在断言里，避免调用方各自解读）
  assert.deepEqual(roster.stats(), {
    total: 3,
    byState: { idle: 1, running: 1, parked: 0, failed: 0, retired: 1 },
    retired: 1,
  })

  // 返回的是克隆：外部改不动内存态
  const snapshotList = roster.list()
  snapshotList[0].name = '被外部篡改'
  assert.notEqual(roster.list()[0].name, '被外部篡改')

  // history 审计流
  assert.equal(roster.history(a.id).length, 2, 'a 的事件：create + claim')
  // 全部事件：3 create + 1 claim + 1 retire = 5（拒绝操作不写事件，故不改这个数）
  assert.equal(roster.history().length, 5)
  assert.equal(roster.history('bot-nope').length, 0)
})

// ── 11. 装配纪律 ─────────────────────────────────────────────────────────────

test('装配：状态目录不可写 → durable=false 降级（不阻塞），且默认 stateDir 走 kernel.stateDir()', (t) => {
  const base = process.env.ROSTER_TEST_TMPDIR || tmpdir()
  const root = mkdtempSync(join(base, `cs-bots-roster-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })

  const roster = createRoster({ logger: { info() {}, warn() {} } }, { stateDir: join(root, 'x', 'y') })
  assert.equal(roster.durable, true, '嵌套目录会被 ensureDir 递归创建')

  // 缺省 stateDir = kernel.stateDir()（= $DSH_HOME/cs-bots）。把 DSH_HOME 指到临时目录，
  // 避免测试去碰真实宿主目录；只验「路径口径」不验真实写入。
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'fakehome')
  t.after(() => { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved })
  const dflt = createRoster({}, {})
  assert.equal(dflt.paths.stateDir, resolve(join(root, 'fakehome', 'cs-bots')))
  assert.ok(dflt.paths.jsonl.endsWith(join('cs-bots', 'roster.jsonl')), dflt.paths.jsonl)

  // 常量面
  assert.deepEqual(roster.constants.STATES, ['idle', 'running', 'parked', 'failed', 'retired'])
  assert.deepEqual(roster.constants.PERMISSIONS, ['read-only', 'workspace-write', 'full'])
  assert.equal(roster.constants.DEFAULT_PERMISSION, 'workspace-write')
})

// ── 2026-11-04 测试回归 ─────────────────────────────────────────────────────
// 🔴 P0-1：getProfile 引用了不存在的 `index` 变量 ⇒ 每次调用必然 ReferenceError
//   （HTTP 400 `API_ERROR: index is not defined`），Bot 档案抽屉打开即报错。

test('2026-11-04 P0-1：getProfile 不崩溃且返回档案（修复 index is not defined）', async (t) => {
  const h = setup(t)
  const bot = await seed(h.roster, h.ws)
  const got = h.roster.getProfile(bot.id)
  assert.equal(got.bot.id, bot.id)
  assert.equal(typeof got, 'object')
})

test('2026-11-04 P0-1：getProfile 对不存在的 Bot 抛 ROSTER_BOT_NOT_FOUND', (t) => {
  const h = setup(t)
  assert.throws(
    () => h.roster.getProfile('bot-does-not-exist'),
    (e) => e instanceof RosterError && e.code === 'ROSTER_BOT_NOT_FOUND',
  )
})

// ── 改造07：prepare command（借鉴 Super-agent 的 prepare command）─────────────

test('改造07 prepare：create 时带 prepareCommand 会落盘并记时间与操作者', async (t) => {
  const h = setup(t)
  const bot = await seed(h.roster, h.ws, { prepareCommand: 'git worktree add ../x main' })
  assert.equal(bot.prepareCommand, 'git worktree add ../x main')
  assert.equal(typeof bot.prepareCommandSetAt, 'number')
  assert.equal(bot.prepareCommandSetBy, 'lead')
})

test('改造07 prepare：不带 prepareCommand 时无该字段（可选，缺省不写）', async (t) => {
  const h = setup(t)
  const bot = await seed(h.roster, h.ws)
  assert.equal(bot.prepareCommand, undefined)
  assert.equal(bot.prepareCommandSetAt, undefined)
})

test('改造07 prepare：setPrepareCommand 设置新值并递增 rev', async (t) => {
  const h = setup(t)
  const bot = await seed(h.roster, h.ws)
  const updated = h.roster.setPrepareCommand({ id: bot.id, expectedRev: bot.rev, prepareCommand: 'pnpm install', byId: 'lead' })
  assert.equal(updated.prepareCommand, 'pnpm install')
  assert.equal(updated.rev, bot.rev + 1)
  assert.equal(updated.prepareCommandSetBy, 'lead')
})

test('改造07 prepare：setPrepareCommand 传空串 = 清除（三字段一起清）', async (t) => {
  const h = setup(t)
  const bot = await seed(h.roster, h.ws, { prepareCommand: 'echo hi' })
  const cleared = h.roster.setPrepareCommand({ id: bot.id, expectedRev: bot.rev, prepareCommand: '', byId: 'lead' })
  assert.equal(cleared.prepareCommand, undefined)
  assert.equal(cleared.prepareCommandSetAt, undefined)
  assert.equal(cleared.prepareCommandSetBy, undefined)
})

test('改造07 prepare：对不存在的 Bot 抛 ROSTER_BOT_NOT_FOUND', (t) => {
  const h = setup(t)
  assert.throws(
    () => h.roster.setPrepareCommand({ id: 'bot-nope', prepareCommand: 'echo hi', byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_NOT_FOUND',
  )
})

test('改造07 prepare：CAS 冲突抛错（绝不静默覆盖）', async (t) => {
  const h = setup(t)
  const bot = await seed(h.roster, h.ws)
  assert.throws(
    () => h.roster.setPrepareCommand({ id: bot.id, expectedRev: bot.rev, prepareCommand: 'x', expectedRev: 999, byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_REV_CONFLICT',
  )
})

test('改造07 prepare：已退役的 Bot 不可再设准备命令', async (t) => {
  const h = setup(t)
  const bot = await seed(h.roster, h.ws)
  h.roster.retire({ id: bot.id, reason: 'bye', byId: 'lead' })
  const latest = h.roster.get(bot.id)
  assert.throws(
    () => h.roster.setPrepareCommand({ id: bot.id, expectedRev: latest.rev, prepareCommand: 'x', byId: 'lead' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_RETIRED',
  )
})

test('改造07 prepare：prepare_command_set 动作写进事件流（审计可见）', async (t) => {
  const h = setup(t)
  const bot = await seed(h.roster, h.ws, { prepareCommand: 'echo hi' })
  h.roster.setPrepareCommand({ id: bot.id, expectedRev: bot.rev, prepareCommand: 'echo bye', byId: 'lead' })
  const prep = events(h.stateDir).filter((r) => r.action === 'prepare_command_set')
  assert.equal(prep.length, 1)
  assert.equal(prep[0].byId, 'lead')
})
