/**
 * cs-bots 模型面工具测试。
 *
 * 为什么单独测这一层：域服务（board/roster/room/memory/dispatcher）即使全部正常，
 * **只要工具没注册上，模型在新机器上就看不到任何能力** —— 平台等于不存在。
 * 这条链（域服务 → registerTool → 模型可调）此前只在临时 profile 启动时人工验过一次，
 * 必须被测试机械守住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { TOOL_NAMES, installTools } from '../src/tools.js'

/** 造一个带「记录型 tools 服务」的宿主替身。 */
function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-tools-'))
  const registered = []
  const warnings = []

  const ctx = {
    logger: {
      info: () => {},
      warn: (...a) => warnings.push(a.join(' ')),
    },
    get: (key) =>
      key === 'tools'
        ? {
            register: (def) => {
              registered.push(def)
              return () => {}
            },
            guard: () => () => {},
            schemas: () => [],
          }
        : undefined,
    on: () => {},
    effect: () => {},
  }

  apply(ctx, { stateDir })

  return {
    ctx,
    stateDir,
    registered,
    warnings,
    byName(name) {
      return registered.find((d) => d.name === name)
    },
    async call(name, args, agent = { id: 'probe-session' }) {
      const def = this.byName(name)
      assert.ok(def, `工具 ${name} 应已注册`)
      return def.execute(args, { agent })
    },
    cleanup() {
      getServices(ctx).dispatcher?.dispose?.()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

// ── 注册完整性 ───────────────────────────────────────────────────────────────

test('工具全部注册成功，且数量与 TOOL_NAMES 一致', () => {
  const h = boot()
  try {
    assert.equal(
      h.registered.length,
      TOOL_NAMES.length,
      `应注册 ${TOOL_NAMES.length} 个，实际 ${h.registered.length}；warnings=${JSON.stringify(h.warnings)}`,
    )
    // PDCA 建设：cycle 4 + metrics 2 + verify 1 + teams 3 = 10 个（28 → 38）；
// 改造07：subscription 3 个（task_subscribe / unsubscribe / subscriptions）→ 41
// 升级09（契约 §2.4）：阶段产出物 bot_task_phase（纯增量新工具）→ 42
    assert.equal(TOOL_NAMES.length, 42, `工具总数应为 42，实际 ${TOOL_NAMES.length}`)
  } finally {
    h.cleanup()
  }
})

test('每个工具结构完整：name / description / parameters / output.schema / output.render / execute', () => {
  const h = boot()
  try {
    for (const def of h.registered) {
      assert.ok(def.name, 'name 必填')
      assert.ok(def.description && def.description.length > 10, `${def.name}: description 应非空且可读`)
      assert.equal(def.parameters?.type, 'object', `${def.name}: parameters 应是 object schema`)
      assert.ok(def.output?.schema, `${def.name}: output.schema 必填（官方契约）`)
      assert.equal(typeof def.output.render, 'function', `${def.name}: output.render 必填`)
      assert.equal(typeof def.execute, 'function', `${def.name}: execute 必填`)
    }
  } finally {
    h.cleanup()
  }
})

test('工具名全部带 bot_ 前缀（避免与其他插件撞名 —— insert 不去重）', () => {
  const h = boot()
  try {
    for (const def of h.registered) {
      assert.match(def.name, /^bot_[a-z_]+$/, `${def.name} 应带 bot_ 前缀`)
    }
  } finally {
    h.cleanup()
  }
})

test('工具名唯一（重复注册会被宿主拒）', () => {
  const h = boot()
  try {
    const names = h.registered.map((d) => d.name)
    assert.equal(new Set(names).size, names.length, '工具名必须唯一')
  } finally {
    h.cleanup()
  }
})

// ── 真实调用（端到端：工具 → 域服务）────────────────────────────────────────

test('bot_task_create 真能建任务（工具 → BoardService 打通）', async () => {
  const h = boot()
  try {
    const res = await h.call('bot_task_create', { subject: '写测试' })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.task.subject, '写测试')
    assert.equal(res.task.status, 'pending')
    assert.equal(res.task.rev, 1)
  } finally {
    h.cleanup()
  }
})

test('bot_task_update 用过期 rev 返回**可读失败**（不是抛崩）', async () => {
  const h = boot()
  try {
    const created = await h.call('bot_task_create', { subject: 'CAS 任务' })
    const id = created.task.id
    // 第一次 claim 成功
    const claimed = await h.call('bot_task_update', { id, expectedRev: 1, action: 'claim' })
    assert.equal(claimed.ok, true, JSON.stringify(claimed))
    // 用过期 rev=1 再改 → 必须 ok:false 且带 message（不抛）
    const stale = await h.call('bot_task_update', { id, expectedRev: 1, action: 'complete', artifacts: ['x'] })
    assert.equal(stale.ok, false, '过期 rev 应返回失败')
    assert.ok(stale.message && String(stale.message).length > 0, '失败必须带可读原因')
  } finally {
    h.cleanup()
  }
})

test('bot_roster_create 把 cwd 透传到 agents.create 的 meta（目录隔离的核心断言）', async () => {
  const h = boot()
  try {
    // boot 的 ctx 没有 agents 服务 → roster.create 应返回可读失败而不是崩
    const res = await h.call('bot_roster_create', { name: 'w1', cwd: join(h.stateDir, 'w1') })
    assert.equal(res.ok, false, '无 agents 服务时应失败')
    assert.ok(res.reason || res.message, '失败要可读')
  } finally {
    h.cleanup()
  }
})

test('bot_wake 缺 dedupKey 仍可发，但重复同键会被去重', async () => {
  const h = boot()
  try {
    // 无 agents 服务：投递会失败，但**记账与去重**逻辑仍应生效
    const first = await h.call('bot_wake', {
      target: 'sess-x',
      reason: 'task-assigned',
      dedupKey: 'k1',
    })
    assert.ok(first.result, '应返回决策结果')

    const second = await h.call('bot_wake', {
      target: 'sess-x',
      reason: 'task-assigned',
      dedupKey: 'k1',
    })
    assert.equal(second.result, 'skipped', '同 dedupKey 第二次必须 skipped')
  } finally {
    h.cleanup()
  }
})

test('未知工具名调用：byName 返回 undefined（测试辅助自身可信）', () => {
  const h = boot()
  try {
    assert.equal(h.byName('bot_not_a_tool'), undefined)
  } finally {
    h.cleanup()
  }
})

// ── 阶段产出物（契约 §2.4，纯增量新工具）─────────────────────────────────────

test('bot_task_phase：注入可用时把 patch 交给 phaseWrite 并透传结果', async () => {
  const h = boot()
  try {
    let seen = null
    // B 侧 installApi 会把 phaseWrite 挂到 services 上；测试直接模拟这个注入点
    getServices(h.ctx).phaseWrite = (taskId, patch) => {
      seen = { taskId, patch }
      return { ok: true, taskId, phases: [] }
    }
    const res = await h.call('bot_task_phase', {
      id: 't-1',
      index: 0,
      state: 'done',
      artifacts: ['docs/a.md'],
      note: '确认完毕',
    })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(seen.taskId, 't-1')
    assert.equal(seen.patch.index, 0)
    assert.equal(seen.patch.state, 'done')
    assert.deepEqual(seen.patch.artifacts, ['docs/a.md'])
    assert.equal(seen.patch.note, '确认完毕')
    // `by` 是事实留痕：取调用者身份，不猜
    assert.equal(seen.patch.by, 'probe-session')
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：state 缺省为 done；给了 expectedRev 就透传做 CAS', async () => {
  const h = boot()
  try {
    let seen = null
    getServices(h.ctx).phaseWrite = (taskId, patch) => { seen = patch; return { ok: true } }
    const res = await h.call('bot_task_phase', { id: 't-9', index: 2, expectedRev: 7 })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(seen.state, 'done', 'state 缺省必须是 done')
    assert.equal(seen.expectedRev, 7, 'expectedRev 应透传给后端做 CAS')
    assert.equal(seen.index, 2)
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：注入缺失时返回 failure("phase-unavailable")，绝不静默成功', async () => {
  const h = boot()
  try {
    // ⚠️ 为什么必须**显式构造**「注入缺失」，不能指望 boot() 天然没有：
    //   `boot()` 走的是完整 `apply()`，而 B 侧 `installApi` 会在模块级就把
    //   `services.phaseWrite` 挂上（src/api.js 的 mountPhaseWrite）。
    //   于是「ctx 里没有 phaseWrite」这个前提**已经不成立**了 —— 旧写法看起来在
    //   测降级路径，实际跑的是真实写入路径（t-1 不存在 ⇒ PHASE_TASK_NOT_FOUND）。
    //   那是「套件假装覆盖了却没覆盖」的典型：测试绿着，降级分支一次没跑。
    //   ⇒ 这里先断言前提确实存在过，再显式删掉，把 services 还原成
    //   「后端未就绪」的真状态，让 tools.js 的 `typeof w !== 'function'` 分支真的被执行。
    const services = getServices(h.ctx)
    assert.equal(typeof services.phaseWrite, 'function', '前提：installApi 应先挂上 phaseWrite')
    delete services.phaseWrite
    assert.equal(typeof services.phaseWrite, 'undefined', '前置：注入必须已被移除，否则本用例无意义')

    const res = await h.call('bot_task_phase', { id: 't-1', index: 0 })
    assert.equal(res.ok, false, '后端未注入时必须失败，不能静默成功')
    assert.equal(res.reason, 'phase-unavailable')
    assert.ok(res.hint && String(res.hint).length > 0, '失败必须带可读 hint')
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：注入存在但任务不存在 ⇒ PHASE_TASK_NOT_FOUND（与降级是两回事）', async () => {
  const h = boot()
  try {
    // 这一条走**真实** phaseWrite（installApi 已挂），验证后端业务失败原样透出。
    // 与上一条的区别：这里是「后端就绪、但这条活不存在」；上一条是「后端根本没就绪」。
    // 两者都必须是可读失败，但错误码语义不同 —— 不许混成一个断言。
    const res = await h.call('bot_task_phase', { id: 't-not-exist', index: 0 })
    assert.equal(res.ok, false, '任务不存在时必须失败')
    assert.notEqual(res.reason, 'phase-unavailable', '这不是降级路径，后端是就绪的')
    assert.equal(res.reason, 'PHASE_TASK_NOT_FOUND')
    assert.ok(res.message && String(res.message).length > 0, '失败必须带可读原因')
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：phaseWrite 抛错时返回可读失败（不吞证据）', async () => {
  const h = boot()
  try {
    getServices(h.ctx).phaseWrite = () => {
      const error = new Error('task-meta 落盘失败')
      error.code = 'PHASE_WRITE_FAILED'
      throw error
    }
    const res = await h.call('bot_task_phase', { id: 't-1', index: 0 })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'PHASE_WRITE_FAILED')
    assert.ok(res.message && res.message.includes('task-meta'), '必须带真实错误信息')
  } finally {
    h.cleanup()
  }
})

test('bot_task_phase：缺 id / index 非法时返回可读失败', async () => {
  const h = boot()
  try {
    getServices(h.ctx).phaseWrite = () => { throw new Error('不该被调用') }
    const noId = await h.call('bot_task_phase', { index: 0 })
    assert.equal(noId.ok, false)
    assert.equal(noId.reason, 'bad-argument')
    assert.equal(noId.field, 'id')

    const badIndex = await h.call('bot_task_phase', { id: 't-1', index: -1 })
    assert.equal(badIndex.ok, false)
    assert.equal(badIndex.field, 'index')

    const badState = await h.call('bot_task_phase', { id: 't-1', index: 0, state: 'done-ish' })
    assert.equal(badState.ok, false)
    assert.equal(badState.field, 'state')
  } finally {
    h.cleanup()
  }
})

// ── 降级 ─────────────────────────────────────────────────────────────────────

test('tools 服务不可用时：installTools 返回空、但不抛（降级安全）', () => {
  const warnings = []
  const ctx = { logger: { info: () => {}, warn: (...a) => warnings.push(a.join(' ')) }, get: () => undefined }
  const names = installTools(ctx, { warn: (m) => warnings.push(m) })
  assert.deepEqual(names, [], '无 tools 服务时应注册 0 个')
})

test('域服务缺失时工具返回可读失败（不是抛崩）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-tools-deg-'))
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) =>
      key === 'tools'
        ? { register: (d) => (registered.push(d), () => {}), guard: () => () => {}, schemas: () => [] }
        : undefined,
    on: () => {},
    effect: () => {},
  }
  try {
    // 注意：这次**不**调用 apply，所以 registry 里没有域服务
    installTools(ctx, {})
    const def = registered.find((d) => d.name === 'bot_task_create')
    assert.ok(def)
    const res = await def.execute({ subject: 'x' }, { agent: { id: 'p' } })
    assert.equal(res.ok, false, '无域服务时应返回失败')
    assert.equal(res.reason, 'board-unavailable', '失败原因应可读且具体')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
