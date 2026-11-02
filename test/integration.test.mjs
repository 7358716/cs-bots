/**
 * cs-bots 端到端集成测试 —— 把 L2 三个域（board / dispatcher / kernel 桥）串起来，
 * 验证「发布任务 → 派活（唤醒） → 进度 → 结果 → 归档」这条**一期核心闭环**真的能走通。
 *
 * 测的是**跨模块真实集成**（不 mock board、不 mock dispatcher），只把宿主侧
 * （agents / tools / webServer）替换为可控替身 —— 那是 kernel.js 的职责边界。
 *
 * 关键纪律验证点：
 *   1. 任务完成后能**唤醒 owner**（官方 `Task readiness never starts an owner` 的补位）；
 *   2. 唤醒**去重**（同任务同原因只唤一次），避免唤醒风暴；
 *   3. 背压**可见**（队列满必须落 failed，绝不静默丢弃）；
 *   4. 租约**自动回收**（owner 崩溃后任务回到 pending，封死官方「owner 永不释放」）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'

/**
 * 造一个可控宿主替身 + 隔离状态目录，并按插件真实入口装配。
 * @param {{ withAgent?: boolean, maxPerTarget?: number }} [opts]
 */
function boot(opts = {}) {
  const { withAgent = true, withTools = false, withOn = true } = opts
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-e2e-'))
  const logs = []
  const warns = []

  let clock = 1_000_000
  const delivered = []
  const sessionId = 'session-worker-1'

  const fakeAgent = {
    id: sessionId,
    followup(message) {
      delivered.push(message)
    },
    steer() {
      throw new Error('不该走 steer')
    },
  }

  // 动态 Bot 会话注册表：roster.create 走 kernel.createSession → agents.create
  const createdSessions = new Map()
  const agents = {
    get: (id) => (id === sessionId ? fakeAgent : createdSessions.get(id)),
    list: () => [fakeAgent, ...createdSessions.values()],
    create: async (options) => {
      const handle = { id: options?.sessionId, meta: options?.meta }
      createdSessions.set(options?.sessionId, handle)
      return handle
    },
  }

  // 工具面替身：guard 收闸门、restrict 收摘除请求
  const guards = []
  const restricted = []
  const botToolCtx = () => ({
    tools: {
      guard: (fn) => {
        guards.push(fn)
        return () => {}
      },
      schemas: () => [{ name: 'ask_user_question' }, { name: 'bash' }],
      restrict: (filter) => {
        restricted.push(filter)
        return () => {}
      },
    },
  })

  const listeners = {}
  const ctx = {
    logger: {
      info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => warns.push(a.join(' ')),
    },
    get: (key) => {
      if (key === 'agents') return withAgent ? agents : undefined
      if (key === 'tools' && withTools) return botToolCtx().tools
      return undefined
    },
    ...(withOn ? { on: (name, fn) => { listeners[name] = fn } } : {}),
    effect: () => {},
  }

  apply(ctx, { stateDir })

  const board = getServices(ctx).board
  const dispatcher = getServices(ctx).dispatcher
  const roster = getServices(ctx).roster

  return {
    ctx,
    board,
    dispatcher,
    roster,
    sessionId,
    delivered,
    logs,
    warns,
    stateDir,
    guards,
    restricted,
    /** 触发已注册的宿主事件（如 agent/created）。 */
    emit(name, payload) {
      return listeners[name]?.(payload)
    },
    hasListener(name) {
      return typeof listeners[name] === 'function'
    },
    tick(ms) {
      clock += ms
    },
    wakes() {
      const f = join(stateDir, 'wakes.jsonl')
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    },
    cleanup() {
      dispatcher?.dispose?.()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

// ── 装配本身 ─────────────────────────────────────────────────────────────────

test('装配：board 与 dispatcher 都就绪，且日志可读（无未插值占位）', () => {
  const h = boot()
  try {
    assert.ok(h.board, 'board 应就绪')
    assert.ok(h.dispatcher, 'dispatcher 应就绪')
    assert.ok(
      h.logs.some((l) => l.includes('装配完成')),
      `应有「装配完成」日志，实际：${JSON.stringify(h.logs)}`,
    )
    // %s 未插值的形态（本次真实踩过的 bug）：不能出现「（stateDir=%s）」
    assert.ok(
      !h.logs.some((l) => l.includes('%s')),
      `日志不应留未插值的 %s：${JSON.stringify(h.logs)}`,
    )
  } finally {
    h.cleanup()
  }
})

test('降级：无 agents 服务时插件照样装配（缺服务不阻塞启动）', () => {
  const h = boot({ withAgent: false })
  try {
    assert.ok(h.board, 'board 不依赖 agents，应就绪')
    assert.ok(h.dispatcher, 'dispatcher 应就绪（投递会失败但模块可加载）')
  } finally {
    h.cleanup()
  }
})

// ── 一期核心闭环：发布 → 派活 → 进度 → 结果 → 归档 ───────────────────────────

test('闭环：发布任务 → 唤醒 owner → claim → complete（带 artifacts）→ 归档', () => {
  const h = boot()
  try {
    // ① 发布
    const task = h.board.create({ subject: '实现登录', byId: 'lead' })
    assert.equal(task.status, 'pending')
    assert.equal(task.rev, 1)

    // ② 派活 = 向 owner 去一条唤醒（带去重键：同任务同原因只唤一次）
    const wake = h.dispatcher.notify({
      target: h.sessionId,
      reason: 'task-assigned',
      dedupKey: `task-assigned:${task.id}`,
      text: `新任务 ${task.id}：${task.subject}`,
    })
    assert.equal(wake.result, 'sent')
    assert.equal(h.delivered.length, 1, 'owner 应真的收到一条投递')

    // ③ 进度：claim 取租约
    const claimed = h.board.update({ id: task.id, expectedRev: task.rev, action: 'claim', byId: h.sessionId })
    assert.equal(claimed.status, 'in_progress')
    assert.equal(claimed.ownerId, h.sessionId)
    assert.ok(claimed.lease, 'claim 应产生租约')
    assert.equal(claimed.rev, 2)

    // ④ 结果：complete 必须带 artifacts（空数组要被拒）
    assert.throws(
      () => h.board.update({ id: task.id, expectedRev: claimed.rev, action: 'complete', artifacts: [], byId: h.sessionId }),
      /artifacts/i,
      '空 artifacts 必须被拒',
    )
    const done = h.board.update({
      id: task.id,
      expectedRev: claimed.rev,
      action: 'complete',
      artifacts: ['src/login.js', 'test/login.test.mjs'],
      byId: h.sessionId,
    })
    assert.equal(done.status, 'completed')
    assert.deepEqual(done.artifacts, ['src/login.js', 'test/login.test.mjs'])
    assert.equal(done.lease, undefined, 'complete 应释放租约')

    // ⑤ 归档：已完成的从 list 默认视图里……仍在（未删除），但推进不了
    const list = h.board.list()
    assert.equal(list.length, 1)
    // delete = tombstone
    const tomb = h.board.update({ id: task.id, expectedRev: done.rev, action: 'delete', byId: 'lead' })
    assert.equal(tomb.status, 'deleted')
    assert.equal(h.board.list().length, 0, '删除后不应出现在默认视图')
    assert.ok(h.board.get(task.id), 'tombstone 仍可 get（审计可追溯）')
  } finally {
    h.cleanup()
  }
})

// ── 唤醒去重（防唤醒风暴）─────────────────────────────────────────────────────

test('唤醒去重：同 dedupKey 第二次 skipped，owner 只被唤一次', () => {
  const h = boot()
  try {
    const task = h.board.create({ subject: '去重任务', byId: 'lead' })
    const key = `task-assigned:${task.id}`

    const a = h.dispatcher.notify({ target: h.sessionId, reason: 'task-assigned', dedupKey: key })
    const b = h.dispatcher.notify({ target: h.sessionId, reason: 'task-assigned', dedupKey: key })

    assert.equal(a.result, 'sent')
    assert.equal(b.result, 'skipped')
    assert.equal(b.reason, 'dedup-hit')
    assert.equal(h.delivered.length, 1, '去重后 owner 只应收到一条')
  } finally {
    h.cleanup()
  }
})

// ── 依赖 DAG：未解锁的不能派 ──────────────────────────────────────────────────

test('依赖：上游未完成时子任务不在 ready()，完成后才可派', () => {
  const h = boot()
  try {
    const parent = h.board.create({ subject: '父任务', byId: 'lead' })
    const child = h.board.create({ subject: '子任务', byId: 'lead', blockedBy: [parent.id] })

    // 父任务自身无依赖 → ready；子任务有未完成依赖 → 不 ready
    assert.deepEqual(h.board.ready().map((t) => t.id), [parent.id], '父未完成 → 只有父自己 ready')

    h.board.update({ id: parent.id, expectedRev: parent.rev, action: 'claim', byId: h.sessionId })
    const p2 = h.board.get(parent.id)
    h.board.update({ id: parent.id, expectedRev: p2.rev, action: 'complete', artifacts: ['x'], byId: h.sessionId })

    const ready = h.board.ready()
    assert.equal(ready.length, 1, '父完成后只剩子任务 ready（父已 completed）')
    assert.equal(ready[0].id, child.id)
  } finally {
    h.cleanup()
  }
})

test('依赖：blockedBy 指向不存在的任务必须被拒（防悬空引用）', () => {
  const h = boot()
  try {
    assert.throws(
      () => h.board.create({ subject: '坏依赖', byId: 'lead', blockedBy: ['task-does-not-exist'] }),
      /不存在|not.?found|unknown/i,
    )
  } finally {
    h.cleanup()
  }
})

// ── 租约自动回收（封死官方硬伤）───────────────────────────────────────────────

test('租约回收：owner 崩溃后任务自动回 pending，可被重新认领', () => {
  const h = boot()
  try {
    const task = h.board.create({ subject: '会崩溃的任务', byId: 'lead' })
    // claim 时传一个很短的租约（直接改 task 不可行，故用 board 的 leaseMs 由 config 控制；
    // 此处退一步：claim 后手工把租约判死点前移 —— 用 expireLeases 的 now 参数）
    const claimed = h.board.update({ id: task.id, expectedRev: task.rev, action: 'claim', byId: h.sessionId })
    const deadline = claimed.lease.expiresAt
    assert.ok(typeof deadline === 'number')

    // 未到期：不应回收
    assert.deepEqual(h.board.expireLeases({ now: deadline - 1 }), [])

    // 到期：回收
    const reaped = h.board.expireLeases({ now: deadline + 1 })
    assert.deepEqual(reaped, [task.id])

    const back = h.board.get(task.id)
    assert.equal(back.status, 'pending', '回收后应回 pending')
    assert.equal(back.lease, undefined)
    assert.equal(back.ownerId, undefined)
    // 回收来源应可审计（board 会在事件流里记，任务上带 releasedBy 或 list 里可查）
    const hist = h.board.history(task.id)
    assert.ok(
      hist.some((e) => /expire|releas|timeout/i.test(String(e.action ?? ''))),
      `事件流应记录租约回收，实际 actions=${JSON.stringify(hist.map((e) => e.action))}`,
    )
  } finally {
    h.cleanup()
  }
})

// ── 背压可见（K4）─────────────────────────────────────────────────────────────

test('背压：队列满时拒绝且**落盘可见**（绝不静默丢弃）', () => {
  const h = boot()
  try {
    // dispatcher 默认 maxPerTarget=50；灌满它
    let sawBackpressure = false
    for (let i = 0; i < 60; i += 1) {
      const r = h.dispatcher.notify({
        target: h.sessionId,
        reason: 'room-message',
        dedupKey: `room-${i}`,
        delayMs: 600_000, // 全部挂起，不立即投递
      })
      if (r.reason === 'backpressure') {
        sawBackpressure = true
        assert.equal(r.ok, false)
        break
      }
    }
    assert.ok(sawBackpressure, '超过队列上限后必须出现背压拒绝')

    const failed = h.wakes().filter(
      (w) => w.result === 'failed' && String(w.detail ?? '').startsWith('queue-full:'),
    )
    assert.ok(failed.length >= 1, '背压必须落一条 failed 记录（可见）')
  } finally {
    h.cleanup()
  }
})

// ── 重启回放一致性 ───────────────────────────────────────────────────────────

test('回放：重新装配后 board 视图与之前一致（重启不丢）', () => {
  const h = boot()
  let snapshotIds = []
  let stateDir = h.stateDir
  try {
    const a = h.board.create({ subject: '任务A', byId: 'lead' })
    const b = h.board.create({ subject: '任务B', byId: 'lead' })
    h.board.update({ id: a.id, expectedRev: a.rev, action: 'claim', byId: h.sessionId })
    snapshotIds = h.board.list().map((t) => `${t.id}:${t.status}:${t.rev}`).sort()
    assert.equal(snapshotIds.length, 2)

    // 模拟重启：同一 stateDir 重新装配
    h.dispatcher.dispose()
    const ctx2 = {
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
      effect: () => {},
    }
    apply(ctx2, { stateDir })
    const after = getServices(ctx2).board.list().map((t) => `${t.id}:${t.status}:${t.rev}`).sort()
    assert.deepEqual(after, snapshotIds, '回放后的视图必须与重启前一致')
    getServices(ctx2).dispatcher?.dispose?.()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('幂等：同 sourceSeq 重复建任务只产生一条（防双写）', () => {
  const h = boot()
  try {
    const seq = 'msg-abc-123'
    const first = h.board.create({ subject: '幂等任务', byId: 'lead', sourceSeq: seq })
    const second = h.board.create({ subject: '幂等任务（重投）', byId: 'lead', sourceSeq: seq })
    assert.equal(second.id, first.id, '同 sourceSeq 必须命中同一条')
    assert.equal(h.board.list().length, 1)
  } finally {
    h.cleanup()
  }
})

// ── CAS 冲突显式失败 ─────────────────────────────────────────────────────────

test('CAS：过期 revision 必须抛错而非静默覆盖', () => {
  const h = boot()
  try {
    const t = h.board.create({ subject: 'CAS 任务', byId: 'lead' })
    h.board.update({ id: t.id, expectedRev: t.rev, action: 'claim', byId: h.sessionId })
    assert.throws(
      () => h.board.update({ id: t.id, expectedRev: t.rev, action: 'complete', artifacts: ['x'], byId: h.sessionId }),
      /rev|revision|stale|冲突/i,
      '用过期 rev 提交必须失败',
    )
  } finally {
    h.cleanup()
  }
})

// ── P5：RosterService 集成（目录隔离 + K1 接线）──────────────────────────────

test('P5 装配：roster / board / dispatcher 三域就绪', () => {
  const h = boot()
  try {
    assert.ok(h.roster, 'roster 应就绪')
    assert.ok(h.board, 'board 应就绪')
    assert.ok(h.dispatcher, 'dispatcher 应就绪')
  } finally {
    h.cleanup()
  }
})

test('P5 目录隔离：roster.create 把 cwd 传给 agents.create 的 meta（真正的写入边界）', async () => {
  const h = boot()
  try {
    const cwd = join(h.stateDir, 'bot-a-dir')
    const bot = await h.roster.create({ name: 'bot-a', cwd, byId: 'lead' })
    assert.equal(bot.cwd, cwd)

    // 决定性断言：请求体必须带 meta.cwd（不是"Bot 对象里有 cwd 字段"）
    const handle = h.roster.get(bot.id)
    assert.ok(handle, 'bot 应可 get')
    const created = [...getServices(h.ctx).roster.list()].find((b) => b.id === bot.id)
    assert.ok(created, 'bot 应在 list 里')

    // 直接查宿主收到的调用参数
    const agentHandle = h.ctx.get('agents').get(bot.sessionId)
    assert.ok(agentHandle, 'agents.create 应已注册该会话')
    assert.equal(agentHandle.meta?.cwd, cwd, 'agents.create 必须收到 meta.cwd')
  } finally {
    h.cleanup()
  }
})

test('P5 目录隔离：cwd 拒绝相对路径与 $DSH_HOME（防止污染宿主数据）', async () => {
  const h = boot()
  try {
    await assert.rejects(() => h.roster.create({ name: 'bad-1', cwd: 'relative/path', byId: 'lead' }))
    const dshHome = process.env.DSH_HOME || `${process.env.HOME}/.dsh`
    await assert.rejects(
      () => h.roster.create({ name: 'bad-2', cwd: `${dshHome}/cs-bots`, byId: 'lead' }),
      /DSH_HOME|\.dsh/i,
      '不得把 Bot 目录建在 DSH_HOME 内',
    )
  } finally {
    h.cleanup()
  }
})

test('P5 官方做不到的能力：改名 + 退役后**名额可回收**', async () => {
  const h = boot()
  try {
    const cwd = join(h.stateDir, 'dir-x')
    const b1 = await h.roster.create({ name: 'worker', cwd, byId: 'lead' })

    // 官方 roster 不可改名（README:205 flat immutable）——本平台可以
    const renamed = h.roster.rename({ id: b1.id, name: 'worker-renamed', expectedRev: b1.rev, byId: 'lead' })
    assert.equal(renamed.name, 'worker-renamed')

    // 退役
    const retired = h.roster.retire({ id: b1.id, reason: 'done', byId: 'lead' })
    assert.equal(retired.state, 'retired')

    // 旧名与目录**可被新 Bot 复用**（官方的名字永不复用）
    const b2 = await h.roster.create({ name: 'worker', cwd, byId: 'lead' })
    assert.ok(b2.id)
    assert.notEqual(b2.id, b1.id)
  } finally {
    h.cleanup()
  }
})

test('P5 同名拒绝（大小写归一）', async () => {
  const h = boot()
  try {
    await h.roster.create({ name: 'dup', cwd: join(h.stateDir, 'd1'), byId: 'lead' })
    await assert.rejects(
      () => h.roster.create({ name: 'DUP', cwd: join(h.stateDir, 'd2'), byId: 'lead' }),
      // 实现给的错误文案（中文，明确说明归一后冲突）："名字 ... 已被占用（大小写不敏感归一后冲突）"
      /已被占用|占用|冲突|unique/i,
    )
  } finally {
    h.cleanup()
  }
})

test('P5 K1：agent/created 时把 ask_user_question 从 Bot 工具表摘除', async () => {
  const h = boot({ withTools: true, withOn: true })
  try {
    assert.ok(h.hasListener('agent/created'), 'agent/created 监听器应已注册')

    const cwd = join(h.stateDir, 'k1-dir')
    const bot = await h.roster.create({ name: 'k1-bot', cwd, byId: 'lead' })

    // 模拟宿主为这个 Bot 会话创建 agent
    const agent = { id: bot.sessionId, ctx: { tools: { schemas: () => [{ name: 'ask_user_question' }, { name: 'bash' }], restrict: (f) => h.restricted.push(f) } } }
    h.emit('agent/created', { agent })

    assert.ok(
      h.restricted.some((f) => Array.isArray(f?.deny) && f.deny.includes('ask_user_question')),
      `Bot 会话应被摘除 ask_user_question，实际=${JSON.stringify(h.restricted)}`,
    )
  } finally {
    h.cleanup()
  }
})

test('P5 K1：闸门放行非 Bot 会话（不误伤人类会话/官方 teammate）', () => {
  const h = boot({ withTools: true })
  try {
    assert.ok(h.guards.length >= 1, '应有 guard 注册')
    const guard = h.guards[0]

    // 未注册的人类会话 → 放行
    const human = { name: 'ask_user_question', agent: { id: 'session-human-not-bot' } }
    assert.equal(guard(human), undefined, '非 Bot 会话必须放行')

    // 其他工具 → 放行
    const other = { name: 'bash', agent: { id: 'session-human-not-bot' } }
    assert.equal(guard(other), undefined, '非目标工具必须放行')
  } finally {
    h.cleanup()
  }
})

test('P5 K1：闸门拦截已注册 Bot 会话（拒绝理由可读）', async () => {
  const h = boot({ withTools: true })
  try {
    const bot = await h.roster.create({ name: 'k1-gate', cwd: join(h.stateDir, 'k1g'), byId: 'lead' })
    const guard = h.guards[0]

    const blocked = guard({ name: 'ask_user_question', agent: { id: bot.sessionId } })
    assert.ok(typeof blocked === 'string' && blocked.length > 0, 'Bot 会话应被拒且理由可读')
    assert.match(blocked, /投递链|ask_user_question/, '理由应说明原因')
  } finally {
    h.cleanup()
  }
})

test('P5 回放：roster 重启后视图一致', async () => {
  const h = boot()
  const stateDir = h.stateDir
  try {
    await h.roster.create({ name: 'persist-1', cwd: join(stateDir, 'p1'), byId: 'lead' })
    const before = h.roster.list().map((b) => `${b.id}:${b.name}`).sort()

    h.dispatcher.dispose()
    const ctx2 = { logger: { info: () => {}, warn: () => {} }, get: () => undefined, effect: () => {} }
    apply(ctx2, { stateDir })
    const after = getServices(ctx2).roster.list().map((b) => `${b.id}:${b.name}`).sort()

    assert.deepEqual(after, before, '回放后 roster 必须一致')
    getServices(ctx2).dispatcher?.dispose?.()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
