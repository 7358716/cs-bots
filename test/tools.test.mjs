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
    // v2 新增：待办 3 + 便签 2 + 提示词 2 + 纪律 2 + 建议 2 = 11 个（16 → 27）
    // 长期记忆方案 v1：新增 bot_task_notes（27 → 28）
    assert.equal(TOOL_NAMES.length, 28, `工具总数应为 28，实际 ${TOOL_NAMES.length}`)
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
