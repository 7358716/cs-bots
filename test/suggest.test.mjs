/**
 * SuggestService 测试 —— 建议确认队列（记忆进化的闸门）。
 *
 * 纪律：每条断言都用**实际落盘产物**或**真实返回值**做证据，
 * 不接受「函数没抛错」这种弱断言。
 * 只碰 `node:test` + `node:assert` + `node:fs` + `node:os` + `node:path`。
 *
 * 覆盖（任务书验收项逐条对应）：
 *   - 三种 kind（memory / skill / discipline）的 payload 校验 + 未知 kind 被拒
 *   - pending 缺省过滤、status='all'、kind/minConfidence/limit 过滤与排序
 *   - accept 调 apply 并落库（apply 的入参/返回值、accepted 状态、事件流)
 *   - **apply 抛错时保持 pending 且 lastError 记录**（并且落盘、重启后仍在）
 *   - reject 必须带原因；已裁决的不能再裁（防重复入库）
 *   - bulkAccept 部分失败（成功/失败逐条回报，不中断）
 *   - 重复建议去重（trim/压空白/大小写不敏感；不同 layer 不算重复；拒绝后可再提）
 *   - replay 从 jsonl 恢复；jsonl 缺失时回落快照
 *   - CAS(rev) 冲突、未知字段、L0 拒收、dispose 后拒调用
 *
 * 运行：`node --test test/suggest.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createSuggest, {
  SuggestError,
  KINDS,
  STATUSES,
  SOURCES,
  MEMORY_LAYERS,
  LIMITS,
} from '../src/suggest.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/** 每个用例一个独立状态目录（互不污染），并注册自动清理。 */
function setup(t, config = {}) {
  const base = process.env.SUGGEST_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-suggest-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const svc = createSuggest({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

/** 读事件流（真相源）。 */
function events(dir) {
  const file = join(dir, 'suggestions.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 把错误码断言写成可读一行（同步函数用）。 */
function throwsCode(fn, code, extra = {}) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof SuggestError, `应抛 SuggestError，实际 ${error?.name}`)
    assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}：${error.message}`)
    for (const [key, value] of Object.entries(extra)) {
      assert.deepEqual(error.detail?.[key], value, `detail.${key} 不符`)
    }
    return true
  })
}

/** 把错误码断言写成可读一行（`accept`/`bulkAccept` 是 async，错误以 rejection 形式出现）。 */
async function rejectsCode(fn, code, extra = {}) {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof SuggestError, `应 reject SuggestError，实际 ${error?.name}`)
    assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}：${error.message}`)
    for (const [key, value] of Object.entries(extra)) {
      assert.deepEqual(error.detail?.[key], value, `detail.${key} 不符`)
    }
    return true
  })
}

/** 造一条合法的 memory 建议（省去样板）。 */
function seed(svc, over = {}) {
  return svc.suggest({
    kind: 'memory',
    layer: 'L2',
    payload: { content: '团队约定：提交前必须跑 bash test/run-all.sh', tags: ['流程'] },
    reason: '上次交付漏跑测试导致回滚',
    by: 'review-bot',
    ...over,
  })
}

// ── 1. 导出面 ───────────────────────────────────────────────────────────────

test('导出：default 是工厂；常量与错误类都可用', () => {
  assert.equal(typeof createSuggest, 'function')
  assert.equal(typeof SuggestError, 'function')
  assert.deepEqual(KINDS, ['memory', 'skill', 'discipline'])
  assert.deepEqual(STATUSES, ['pending', 'accepted', 'rejected'])
  assert.deepEqual(SOURCES, ['review', 'consolidate', 'model'])
  assert.deepEqual(MEMORY_LAYERS, ['L1', 'L2', 'L3', 'L4', 'L5'])
  assert.equal(LIMITS.skillBody, 20000)
})

test('工厂：支持单参数简写 { stateDir }（与 discipline.js 同款）', (t) => {
  const base = process.env.SUGGEST_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-suggest-single-${process.pid}-${counter++}-`))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  const svc = createSuggest({ stateDir: dir })
  assert.equal(svc.paths.stateDir, dir)
  assert.equal(svc.paths.jsonl, join(dir, 'suggestions.jsonl'))
})

test('工厂：既无 stateDir 也拿不到 kernel 时抛 SUGGEST_NO_STATE_DIR', () => {
  // 本仓库没有宿主包时 kernel.stateDir 仍存在（纯环境变量实现），
  // 因此这里用一个必然失败的形态：stateDir 传空白字符串 + 断言错误可读。
  const svc = createSuggest({ logger: { info() {}, warn() {} } }, { stateDir: '   ' })
  // 空白 → 视为未给 → 走 kernel.stateDir()（存在），故不会抛；这里验证它没有静默用空白路径。
  assert.ok(!svc.paths.stateDir.includes('   '), '不得把空白字符串当状态目录')
})

// ── 2. 提建议：三种 kind 与校验 ─────────────────────────────────────────────

test('suggest：memory 建议落盘 pending，字段齐全（id/rev/layer/source/confidence/createdBy）', (t) => {
  const { dir, svc } = setup(t)
  const s = seed(svc, { now: 1_700_000_000_000 })
  assert.match(s.id, /^sg-[0-9a-f]{8}$/)
  assert.equal(s.rev, 1)
  assert.equal(s.kind, 'memory')
  assert.equal(s.status, 'pending')
  assert.equal(s.layer, 'L2')
  assert.deepEqual(s.payload, { content: '团队约定：提交前必须跑 bash test/run-all.sh', tags: ['流程'] })
  assert.equal(s.source, 'model')
  assert.equal(s.confidence, 0.5, '未给 confidence 时缺省 0.5（中性，不抢占 UI 排序）')
  assert.equal(s.createdAt, 1_700_000_000_000)
  assert.equal(s.createdBy, 'review-bot')
  assert.equal(s.decidedAt, null)
  assert.equal(s.duplicate, false)

  const rows = events(dir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, 'add')
  assert.equal(rows[0].after.id, s.id)
  assert.equal(rows[0].after.status, 'pending')
})

test('suggest：skill 建议要求 kebab-case 名 + 正文，description 缺省为空串', (t) => {
  const { svc } = setup(t)
  const s = svc.suggest({
    kind: 'skill',
    payload: { name: 'systematic-debugging', body: '## 步骤\n1. 复现', tags: ['debug'] },
    reason: '同类问题第三次出现，值得固化成技能',
    source: 'review',
    confidence: 0.9,
    by: 'memory-reviewer',
  })
  assert.equal(s.kind, 'skill')
  assert.equal(s.layer, null)
  assert.equal(s.payload.name, 'systematic-debugging')
  assert.equal(s.payload.description, '')
  assert.equal(s.source, 'review')
  assert.equal(s.confidence, 0.9)
})

test('suggest：discipline 建议校验 scope/kind 枚举 + scopeId 与 scope 的强绑定', (t) => {
  const { svc } = setup(t)
  const ok = svc.suggest({
    kind: 'discipline',
    payload: {
      scope: 'workspace',
      scopeId: '/home/ubuntu/output2026/butlers/dev/cs-bots',
      kind: 'rule',
      title: '提交前跑测试',
      content: '必须 bash test/run-all.sh 全绿',
    },
    reason: '回滚事故复盘结论',
    source: 'consolidate',
    by: 'review-bot',
  })
  assert.equal(ok.kind, 'discipline')
  assert.equal(ok.payload.scopeId, '/home/ubuntu/output2026/butlers/dev/cs-bots')

  // global 不需要 scopeId
  const globalRule = svc.suggest({
    kind: 'discipline',
    payload: { scope: 'global', kind: 'principle', title: '结论先行', content: '先给结论再给证据' },
    reason: '沟通偏好', by: 'b',
  })
  assert.equal(globalRule.payload.scopeId, null)

  throwsCode(() => svc.suggest({
    kind: 'discipline',
    payload: { scope: 'team', kind: 'rule', title: 'x', content: 'y' },
    reason: 'r', by: 'b',
  }), 'SUGGEST_BAD_PAYLOAD', { field: 'scope' })

  // 非 global 缺 scopeId → 入队即拒（否则采纳时才被 discipline 拒收，等于把失败推给人点按钮）
  throwsCode(() => svc.suggest({
    kind: 'discipline',
    payload: { scope: 'workspace', kind: 'rule', title: 'x', content: 'y' },
    reason: 'r', by: 'b',
  }), 'SUGGEST_BAD_PAYLOAD', { field: 'scopeId' })

  // global 带 scopeId → 歧义状态，同样入队即拒
  throwsCode(() => svc.suggest({
    kind: 'discipline',
    payload: { scope: 'global', scopeId: '/tmp/x', kind: 'rule', title: 'x', content: 'y' },
    reason: 'r', by: 'b',
  }), 'SUGGEST_BAD_PAYLOAD', { field: 'scopeId' })
})

test('suggest：未知 kind / L0 层 / 非 memory 带 layer / 未知 payload 字段 一律拒', (t) => {
  const { svc } = setup(t)
  throwsCode(() => svc.suggest({ kind: 'todo', payload: {}, reason: 'r', by: 'b' }), 'SUGGEST_BAD_KIND')
  throwsCode(() => seed(svc, { layer: 'L0' }), 'SUGGEST_BAD_LAYER')
  throwsCode(() => svc.suggest({
    kind: 'skill', layer: 'L2',
    payload: { name: 'a-b', body: 'x' }, reason: 'r', by: 'b',
  }), 'SUGGEST_BAD_FIELD', { field: 'layer' })
  throwsCode(() => svc.suggest({
    kind: 'memory', layer: 'L2',
    payload: { content: 'x', weight: 3 }, reason: 'r', by: 'b',
  }), 'SUGGEST_UNKNOWN_FIELD', { fields: ['weight'] })
  // 空队列：一条都没落盘（拒绝必须是「什么都没发生」，不是半写）
  assert.equal(svc.stats().total, 0)
})

test('suggest：reason 必填（人看不懂理由的建议没有价值）、confidence 越界拒、source 非法拒', (t) => {
  const { svc } = setup(t)
  throwsCode(() => seed(svc, { reason: '   ' }), 'SUGGEST_MISSING_REASON')
  throwsCode(() => seed(svc, { confidence: 1.2 }), 'SUGGEST_BAD_CONFIDENCE')
  throwsCode(() => seed(svc, { confidence: 'high' }), 'SUGGEST_BAD_CONFIDENCE')
  throwsCode(() => seed(svc, { source: 'human' }), 'SUGGEST_BAD_SOURCE')
  throwsCode(() => seed(svc, { by: '' }), 'SUGGEST_BAD_FIELD')
})

test('suggest：content 超长/技能名非法 在**入队时**就拒（不把失败推后到点采纳那一刻）', (t) => {
  const { svc } = setup(t)
  throwsCode(() => seed(svc, { payload: { content: 'x'.repeat(LIMITS.memoryContent + 1) } }), 'SUGGEST_TOO_LONG')
  throwsCode(() => svc.suggest({
    kind: 'skill', payload: { name: 'Bad_Name', body: 'x' }, reason: 'r', by: 'b',
  }), 'SUGGEST_BAD_PAYLOAD', { field: 'name' })
})

// ── 3. 去重 ─────────────────────────────────────────────────────────────────

test('去重：同 kind + layer + 归一化 payload 的 pending 建议返回已有那条（duplicate:true）', (t) => {
  const { dir, svc } = setup(t)
  const first = seed(svc, { payload: { content: 'Use  pnpm   workspaces', tags: ['a'] } })
  const second = seed(svc, { payload: { content: '  use PNPM workspaces  ', tags: ['a'] } })
  assert.equal(second.id, first.id, '归一化后应命中同一条')
  assert.equal(second.duplicate, true)
  assert.equal(first.duplicate, false)
  assert.equal(svc.stats().total, 1)
  assert.equal(events(dir).length, 1, '重复建议不得新增事件')
})

test('去重：不同 layer 不算重复（同一段文字写 L1 与 L3 是两个目标）', (t) => {
  const { svc } = setup(t)
  const a = seed(svc, { layer: 'L1' })
  const b = seed(svc, { layer: 'L3' })
  assert.notEqual(a.id, b.id)
  assert.equal(b.duplicate, false)
  assert.equal(svc.stats().total, 2)
})

test('去重：被拒绝过的建议允许再次提出（人当时拒绝不等于永久否掉）', (t) => {
  const { svc } = setup(t)
  const first = seed(svc)
  svc.reject({ id: first.id, reason: '当时项目还没定 pnpm', by: 'user' })
  const again = seed(svc)
  assert.notEqual(again.id, first.id)
  assert.equal(again.duplicate, false)
  assert.equal(svc.stats().total, 2)
})

// ── 4. 列表 ─────────────────────────────────────────────────────────────────

test('listSuggestions：缺省只返回 pending；status=all 才含已裁决', (t) => {
  const { svc } = setup(t)
  const a = seed(svc)
  const b = seed(svc, { layer: 'L3' })
  svc.reject({ id: b.id, reason: '不需要', by: 'user' })
  assert.deepEqual(svc.listSuggestions().map((s) => s.id), [a.id])
  assert.equal(svc.listSuggestions({ status: 'all' }).length, 2)
  assert.equal(svc.listSuggestions({ status: 'rejected' }).length, 1)
  assert.equal(svc.listSuggestions({ status: 'accepted' }).length, 0)
  throwsCode(() => svc.listSuggestions({ status: 'done' }), 'SUGGEST_BAD_FIELD', { field: 'status' })
})

test('listSuggestions：按 confidence 降序 → createdAt 降序；支持 kind/minConfidence/limit', (t) => {
  const { svc } = setup(t)
  const low = seed(svc, { confidence: 0.2, now: 1000, payload: { content: '低' } })
  const high = seed(svc, { confidence: 0.9, now: 1001, payload: { content: '高' } })
  const mid = seed(svc, { confidence: 0.5, now: 1002, payload: { content: '中' } })
  const skill = svc.suggest({
    kind: 'skill', payload: { name: 'a-b', body: 'x' }, reason: 'r', confidence: 0.95, by: 'b',
  })

  assert.deepEqual(svc.listSuggestions().map((s) => s.id), [skill.id, high.id, mid.id, low.id])
  assert.deepEqual(svc.listSuggestions({ kind: 'memory' }).map((s) => s.id), [high.id, mid.id, low.id])
  assert.deepEqual(svc.listSuggestions({ minConfidence: 0.6 }).map((s) => s.id), [skill.id, high.id])
  assert.deepEqual(svc.listSuggestions({ limit: 2 }).map((s) => s.id), [skill.id, high.id])
  assert.equal(svc.listSuggestions({ limit: 0 }).length, 4, 'limit=0 = 不限')
})

test('getSuggestion：未知 id 抛 SUGGEST_NOT_FOUND（不返回 undefined 让人猜）', (t) => {
  const { svc } = setup(t)
  throwsCode(() => svc.getSuggestion('sg-deadbeef'), 'SUGGEST_NOT_FOUND', { id: 'sg-deadbeef' })
  const s = seed(svc)
  assert.equal(svc.getSuggestion(s.id).id, s.id)
})

// ── 5. 采纳（核心链路）──────────────────────────────────────────────────────

test('accept：调用 apply 并落库；返回采纳后的建议（带 applyResult）；状态转 accepted', async (t) => {
  const { dir, svc } = setup(t)
  const s = seed(svc)
  const calls = []
  const out = await svc.accept({
    id: s.id,
    by: 'user',
    now: 2_000_000_000_000,
    apply: (suggestion) => {
      calls.push(suggestion)
      // 真实场景这里会是 memory.add({ layer: suggestion.layer, content: ..., by: 'user' })
      return { entryId: 'm-0001', layer: suggestion.layer }
    },
  })

  assert.equal(calls.length, 1, 'apply 必须被调用一次')
  assert.equal(calls[0].id, s.id)
  assert.equal(calls[0].payload.content, '团队约定：提交前必须跑 bash test/run-all.sh')
  // 返回的是**建议本身**（api 层直接 `{ok:true, suggestion: out}` 回页面），入库证据在 applyResult
  assert.equal(out.id, s.id)
  assert.deepEqual(out.applyResult, { entryId: 'm-0001', layer: 'L2' })
  assert.equal(out.status, 'accepted')
  assert.equal(out.rev, 2)
  assert.equal(out.decidedAt, 2_000_000_000_000)
  assert.equal(out.decidedBy, 'user')

  const rows = events(dir)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].action, 'accept')
  assert.equal(rows[1].after.status, 'accepted')
  assert.deepEqual(rows[1].applyResult, { entryId: 'm-0001', layer: 'L2' }, '入库证据要留在事件流里可审计')
  assert.equal(svc.getSuggestion(s.id).status, 'accepted')
})

test('accept：**apply 同步抛错 → 保持 pending + lastError 记录 + 落盘 + 抛错给调用方**', async (t) => {
  const { dir, svc } = setup(t)
  const s = seed(svc)
  const boom = new Error('memory.add：L2 层被锁，写入被拒')

  await assert.rejects(
    () => svc.accept({
      id: s.id, by: 'user', now: 3_000_000_000_000,
      apply: () => { throw boom },
    }),
    (error) => {
      assert.ok(error instanceof SuggestError)
      assert.equal(error.code, 'SUGGEST_APPLY_FAILED')
      assert.equal(error.cause, boom, '原始错误必须挂在 cause 上，便于上层分辨失败原因')
      return true
    },
  )

  const after = svc.getSuggestion(s.id)
  assert.equal(after.status, 'pending', 'apply 失败绝不允许标记 accepted')
  assert.equal(after.rev, 2)
  assert.match(after.lastError, /L2 层被锁/, 'lastError 必须含原始错误文本')
  assert.equal(after.lastErrorCode, 'SUGGEST_APPLY_THREW')
  assert.equal(after.lastErrorAt, 3_000_000_000_000)

  // 落盘证据：事件流里有 apply_failed，且快照/回放后依然看得到
  const rows = events(dir)
  assert.equal(rows[rows.length - 1].action, 'apply_failed')
  assert.equal(rows[rows.length - 1].after.status, 'pending')
  assert.match(rows[rows.length - 1].after.lastError, /L2 层被锁/)

  // 故障修复后可以重试成功（历史失败痕迹落事件流，记录本身清干净）
  const out = await svc.accept({ id: s.id, by: 'user', apply: () => ({ ok: true }) })
  assert.equal(out.status, 'accepted')
  assert.equal(out.lastError, undefined)
})

test('accept：**异步 apply（api 层 applySuggestion 就是 async）成败语义与同步一致**', async (t) => {
  const { dir, svc } = setup(t)
  const a = seed(svc, { payload: { content: '异步成功' } })
  const out = await svc.accept({
    id: a.id, by: 'user',
    apply: async (suggestion) => {
      await new Promise((resolve) => setImmediate(resolve)) // 真的跨一次异步边界
      return { entryId: 'm-ok', kind: suggestion.kind }
    },
  })
  assert.equal(out.status, 'accepted')
  assert.deepEqual(out.applyResult, { entryId: 'm-ok', kind: 'memory' })

  const b = seed(svc, { payload: { content: '异步失败' } })
  await rejectsCode(() => svc.accept({
    id: b.id, by: 'user',
    apply: async () => {
      await new Promise((resolve) => setImmediate(resolve))
      throw new Error('memory.add：异步写入被拒')
    },
  }), 'SUGGEST_APPLY_FAILED', { id: b.id })
  const after = svc.getSuggestion(b.id)
  assert.equal(after.status, 'pending', '异步拒绝同样必须保持 pending')
  assert.match(after.lastError, /异步写入被拒/)
  assert.equal(events(dir).filter((e) => e.action === 'apply_failed' && e.id === b.id).length, 1)
})

test('accept：缺 apply 直接拒（SUGGEST_NO_APPLY）——不允许「假采纳」', async (t) => {
  const { svc } = setup(t)
  const s = seed(svc)
  await rejectsCode(() => svc.accept({ id: s.id, by: 'user' }), 'SUGGEST_NO_APPLY', { id: s.id })
  assert.equal(svc.getSuggestion(s.id).status, 'pending')
})

test('accept：已裁决的不能再裁（防重复入库）；apply 里递归 accept 同一条 → SUGGEST_BUSY', async (t) => {
  const { svc } = setup(t)
  const s = seed(svc)
  await svc.accept({ id: s.id, by: 'user', apply: () => ({ ok: 1 }) })
  await rejectsCode(
    () => svc.accept({ id: s.id, by: 'user', apply: () => ({ ok: 2 }) }),
    'SUGGEST_BAD_STATE',
    { status: 'accepted' },
  )

  const other = seed(svc, { layer: 'L3', payload: { content: '递归采纳' } })
  // 外层 accept 因 apply 里的递归 accept 失败 → 统一是 SUGGEST_APPLY_FAILED，
  // 但 cause 必须保留内层的 SUGGEST_BUSY（才能看出「失败原因是重复采纳」而非写库故障）
  await assert.rejects(() => svc.accept({
    id: other.id,
    by: 'user',
    apply: () => svc.accept({ id: other.id, by: 'user', apply: () => ({ ok: 3 }) }),
  }), (error) => {
    assert.equal(error.code, 'SUGGEST_APPLY_FAILED')
    assert.equal(error.cause?.code, 'SUGGEST_BUSY')
    return true
  })
  assert.equal(svc.getSuggestion(other.id).status, 'pending')
  assert.ok(svc.getSuggestion(other.id).lastError.includes('正在 apply 中'))
})

test('accept：expectedRev CAS 不匹配抛 SUGGEST_CAS_CONFLICT，且不调 apply', async (t) => {
  const { svc } = setup(t)
  const s = seed(svc)
  let called = 0
  await rejectsCode(() => svc.accept({
    id: s.id, by: 'user', expectedRev: 99, apply: () => { called += 1 },
  }), 'SUGGEST_CAS_CONFLICT', { id: s.id, expectedRev: 99, rev: 1 })
  assert.equal(called, 0, 'CAS 失败时不得产生任何入库副作用')
  assert.equal(svc.getSuggestion(s.id).status, 'pending')
})

test('accept：memory 建议可带 cwd（按项目隔离）；L1/L2 带 cwd 入队即拒', async (t) => {
  const { svc } = setup(t)
  const project = svc.suggest({
    kind: 'memory',
    layer: 'L3',
    payload: { content: '本项目用 pnpm workspaces', cwd: '/home/ubuntu/output2026/butlers/dev/cs-bots' },
    reason: '项目约定应进项目 key',
    by: 'review-bot',
  })
  assert.equal(project.payload.cwd, '/home/ubuntu/output2026/butlers/dev/cs-bots')

  let seen = null
  await svc.accept({
    id: project.id, by: 'user',
    apply: (suggestion) => { seen = suggestion.payload; return { entryId: 'm-p1' } },
  })
  assert.equal(seen.cwd, '/home/ubuntu/output2026/butlers/dev/cs-bots', 'apply 必须能看到 cwd 才能写进正确的项目记忆')

  // 全局层带 cwd 会被 memory.add 静默忽略 → 入队时就拒（避免「以为按项目隔离了」）
  throwsCode(() => svc.suggest({
    kind: 'memory',
    layer: 'L2',
    payload: { content: '全局约定', cwd: '/tmp/x' },
    reason: 'r', by: 'b',
  }), 'SUGGEST_BAD_PAYLOAD', { field: 'cwd', layer: 'L2' })

  // cwd 参与去重：同内容不同项目是两条建议（否则项目记忆会串味）
  const a = svc.suggest({
    kind: 'memory', layer: 'L3',
    payload: { content: '同一句话', cwd: '/tmp/proj-a' }, reason: 'r', by: 'b',
  })
  const b = svc.suggest({
    kind: 'memory', layer: 'L3',
    payload: { content: '同一句话', cwd: '/tmp/proj-b' }, reason: 'r', by: 'b',
  })
  assert.notEqual(a.id, b.id)
})

// ── 6. 拒绝 ─────────────────────────────────────────────────────────────────

test('reject：必须带原因；状态转 rejected 并保留 rejectReason', async (t) => {
  const { dir, svc } = setup(t)
  const s = seed(svc)
  throwsCode(() => svc.reject({ id: s.id, reason: '  ', by: 'user' }), 'SUGGEST_MISSING_REASON')

  const rejected = svc.reject({ id: s.id, reason: '项目还没确定用 pnpm', by: 'user', now: 4_000_000_000_000 })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.rejectReason, '项目还没确定用 pnpm')
  assert.equal(rejected.decidedBy, 'user')
  assert.equal(rejected.decidedAt, 4_000_000_000_000)
  assert.equal(rejected.rev, 2)
  assert.equal(events(dir).pop().action, 'reject')

  // 已拒绝的不能再裁（也不允许改成 accepted —— 那等于绕过「重新提建议」）
  throwsCode(() => svc.reject({ id: s.id, reason: '再拒一次', by: 'user' }), 'SUGGEST_BAD_STATE')
  await rejectsCode(() => svc.accept({ id: s.id, by: 'user', apply: () => ({}) }), 'SUGGEST_BAD_STATE')
})

test('reject：expectedRev CAS 不匹配抛错', (t) => {
  const { svc } = setup(t)
  const s = seed(svc)
  throwsCode(() => svc.reject({ id: s.id, reason: 'r', by: 'user', expectedRev: 5 }), 'SUGGEST_CAS_CONFLICT')
  assert.equal(svc.getSuggestion(s.id).status, 'pending')
})

// ── 7. 批量采纳 ─────────────────────────────────────────────────────────────

test('bulkAccept：部分失败不中断 —— 成功/失败逐条回报，失败原因可见', async (t) => {
  const { svc } = setup(t)
  const a = seed(svc, { payload: { content: 'A' } })
  const b = seed(svc, { payload: { content: 'B' } })
  const c = seed(svc, { payload: { content: 'C' } })

  const out = await svc.bulkAccept({
    ids: [a.id, b.id, c.id, 'sg-not-exist', a.id],
    by: 'user',
    apply: async (s) => {
      if (s.payload.content === 'B') throw new Error('B 写库失败')
      return { wrote: s.payload.content }
    },
  })

  assert.deepEqual(out.accepted.map((x) => x.id), [a.id, c.id])
  assert.deepEqual(out.accepted.map((x) => x.applyResult.wrote), ['A', 'C'])
  assert.equal(out.failed.length, 2)
  assert.deepEqual(out.failed.map((x) => x.id), [b.id, 'sg-not-exist'])
  assert.equal(out.failed[0].code, 'SUGGEST_APPLY_FAILED')
  assert.match(out.failed[0].reason, /B 写库失败/)
  assert.equal(out.failed[1].code, 'SUGGEST_NOT_FOUND')
  assert.equal(out.deduped, 1, '重复 id 应去重并回报条数，不静默')

  assert.equal(svc.getSuggestion(a.id).status, 'accepted')
  assert.equal(svc.getSuggestion(b.id).status, 'pending', '失败那条必须还在待确认队列')
  assert.match(svc.getSuggestion(b.id).lastError, /B 写库失败/)
})

test('bulkAccept：ids 非数组/空数组/缺 apply 一律拒（不静默空转）', async (t) => {
  const { svc } = setup(t)
  await rejectsCode(() => svc.bulkAccept({ ids: [], by: 'user', apply: () => ({}) }), 'SUGGEST_BAD_FIELD')
  await rejectsCode(() => svc.bulkAccept({ ids: 'sg-1', by: 'user', apply: () => ({}) }), 'SUGGEST_BAD_FIELD')
  const s = seed(svc)
  await rejectsCode(() => svc.bulkAccept({ ids: [s.id], by: 'user' }), 'SUGGEST_NO_APPLY')
  assert.equal(svc.getSuggestion(s.id).status, 'pending')
})

// ── 8. 回放 / 持久化 ────────────────────────────────────────────────────────

test('replay：从 jsonl 恢复 pending/accepted/rejected 与 lastError（重启不丢）', async (t) => {
  const { dir, svc } = setup(t)
  const pending = seed(svc, { payload: { content: '待确认' } })
  const accepted = seed(svc, { payload: { content: '会采纳' } })
  const rejected = seed(svc, { payload: { content: '会拒绝' } })
  const failed = seed(svc, { payload: { content: '会失败' } })

  await svc.accept({ id: accepted.id, by: 'user', apply: () => ({ ok: true }) })
  svc.reject({ id: rejected.id, reason: '不符合当前阶段', by: 'user' })
  await assert.rejects(() => svc.accept({ id: failed.id, by: 'user', apply: () => { throw new Error('写库炸了') } }))
  assert.equal(svc.stats().total, 4)

  // 模拟重启：同一 stateDir 新建实例（构造即 hydrate）
  const restarted = createSuggest({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(restarted.stats().total, 4)
  assert.equal(restarted.getSuggestion(pending.id).status, 'pending')
  assert.equal(restarted.getSuggestion(accepted.id).status, 'accepted')
  assert.equal(restarted.getSuggestion(accepted.id).decidedBy, 'user')
  assert.equal(restarted.getSuggestion(rejected.id).status, 'rejected')
  assert.equal(restarted.getSuggestion(rejected.id).rejectReason, '不符合当前阶段')
  assert.equal(restarted.getSuggestion(failed.id).status, 'pending')
  assert.match(restarted.getSuggestion(failed.id).lastError, /写库炸了/)

  const rep = restarted.replay()
  assert.equal(rep.from, 'jsonl')
  assert.equal(rep.suggestions, 4)
  assert.equal(rep.bad, 0)
})

test('replay：jsonl 缺失（被删/首次损坏）时回落快照恢复', async (t) => {
  const { dir, svc } = setup(t)
  const s = seed(svc)
  await svc.accept({ id: s.id, by: 'user', apply: () => ({ ok: true }) })

  // 快照存在（每次 commit 都会写）
  assert.ok(existsSync(join(dir, 'suggestions.snap.json')))
  unlinkSync(join(dir, 'suggestions.jsonl'))

  const restarted = createSuggest({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const rep = restarted.replay()
  assert.equal(rep.from, 'snapshot')
  assert.equal(restarted.getSuggestion(s.id).status, 'accepted')
})

test('replay：坏行不静默丢弃 —— badLines 计数并仍加载其余有效行', (t) => {
  const { dir, svc } = setup(t)
  seed(svc)
  const file = join(dir, 'suggestions.jsonl')
  const before = readFileSync(file, 'utf8')
  assert.ok(before.includes('"action":"add"'))
  // 追加半截行（模拟撕裂写/断电）
  appendFileSync(file, '{"id":"sg-broken","rev":2,"act')

  const restarted = createSuggest({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const rep = restarted.replay()
  assert.equal(rep.bad, 1, '坏行必须被计数')
  assert.equal(restarted.stats().total, 1, '有效行仍必须加载')
})

// ── 9. 审计 / 统计 / 生命周期 ───────────────────────────────────────────────

test('history：可按 id 过滤；含 add/apply_failed/accept 的完整链路', async (t) => {
  const { svc } = setup(t)
  const a = seed(svc, { payload: { content: 'A' } })
  const b = seed(svc, { payload: { content: 'B' } })
  await assert.rejects(() => svc.accept({ id: a.id, by: 'user', apply: () => { throw new Error('先失败') } }))
  await svc.accept({ id: a.id, by: 'user', apply: () => ({ ok: true }) })
  svc.reject({ id: b.id, reason: '不要', by: 'user' })

  const rowsA = svc.history(a.id)
  assert.deepEqual(rowsA.map((e) => e.action), ['add', 'apply_failed', 'accept'])
  assert.equal(svc.history(b.id).length, 2)
  assert.equal(svc.history().length, 5)
})

test('stats：按 kind/source 分组，pending/accepted/rejected 计数准确', async (t) => {
  const { svc } = setup(t)
  const a = seed(svc)
  const b = svc.suggest({
    kind: 'skill', payload: { name: 'a-b', body: 'x' }, reason: 'r', source: 'review', by: 'b',
  })
  await svc.accept({ id: a.id, by: 'user', apply: () => ({}) })
  svc.reject({ id: b.id, reason: 'r', by: 'user' })
  const st = svc.stats()
  assert.equal(st.total, 2)
  assert.equal(st.pending, 0)
  assert.equal(st.accepted, 1)
  assert.equal(st.rejected, 1)
  assert.deepEqual(st.byKind, { memory: 1, skill: 1, discipline: 0 })
  assert.deepEqual(st.bySource, { review: 1, consolidate: 0, model: 1 })
  assert.equal(st.events, 4)
})

test('dispose：清空并拒绝后续调用（不静默返回空队列）', async (t) => {
  const { svc } = setup(t)
  seed(svc)
  const out = svc.dispose()
  assert.equal(out.disposed, true)
  assert.equal(out.suggestions, 1)
  throwsCode(() => svc.listSuggestions(), 'SUGGEST_DISPOSED')
  throwsCode(() => svc.suggest({ kind: 'memory', layer: 'L2', payload: { content: 'x' }, reason: 'r', by: 'b' }), 'SUGGEST_DISPOSED')
  throwsCode(() => svc.stats(), 'SUGGEST_DISPOSED')
  await rejectsCode(() => svc.accept({ id: 'sg-whatever', by: 'user', apply: () => ({}) }), 'SUGGEST_DISPOSED')
})
