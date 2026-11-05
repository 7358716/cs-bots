/**
 * PromptService 测试 —— 提示词库 + 注入轨。
 *
 * 纪律（与 board/discipline 测试同款）：每条断言都用**真实落盘产物**
 * （`prompts.jsonl` / `prompts.snap.json`）或**真实返回值**做证据，
 * 不接受「函数没抛错」这种弱断言。
 *
 * 运行：`node --test test/prompts.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createPrompts, {
  PromptError,
  DEFAULT_CATEGORY,
  DEFAULT_CATEGORIES,
  MAX_BODY,
  expandTemplates,
} from '../src/prompts.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/** 每个用例一个独立状态目录（互不污染），用例结束递归清理。 */
function setup(t, config = {}) {
  const base = process.env.PROMPTS_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-prompts-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const svc = createPrompts({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

/** 读事件流（真相源）。 */
function events(dir) {
  const file = join(dir, 'prompts.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 建一条提示词（省样板）。 */
function seed(svc, over = {}) {
  return svc.createPrompt({ name: 'P', body: 'B', by: 'lead', ...over })
}

/** 跑一个回合：返回本轮产出文本，并推进回合。 */
function playTurn(svc, sessionId, now) {
  const got = svc.activeInjectionsFor({ sessionId, ...(now === undefined ? {} : { now }) })
  const tick = svc.tickTurn({ sessionId, ...(now === undefined ? {} : { now }) })
  return { texts: got.map((x) => x.text), ids: got.map((x) => x.id), tick }
}

// ── 1. 导出面 ───────────────────────────────────────────────────────────────

test('导出：default 是工厂，命名导出错误类/常量/模板展开', () => {
  assert.equal(typeof createPrompts, 'function')
  assert.equal(typeof PromptError, 'function')
  assert.equal(DEFAULT_CATEGORY, '未分类')
  assert.deepEqual(DEFAULT_CATEGORIES, ['未分类', '通用', '编程', '写作', '分析'])
  assert.equal(MAX_BODY, 256 * 1024)
  assert.equal(typeof expandTemplates, 'function')
})

// ── 2. 提示词 CRUD ──────────────────────────────────────────────────────────

test('create/get：id 形如 pt-8位hex，rev=1，缺省 category=未分类 / enabled=true / useCount=0', (t) => {
  const { svc } = setup(t)
  const now = 1_700_000_000_000
  const p = svc.createPrompt({
    name: '每日站会',
    description: '让所有 Bot 先报进度',
    body: '请先汇报昨日完成与今日计划',
    tags: ['协作', '流程'],
    by: 'lead',
    now,
  })
  assert.match(p.id, /^pt-[0-9a-f]{8}$/)
  assert.equal(p.rev, 1)
  assert.equal(p.category, DEFAULT_CATEGORY)
  assert.equal(p.enabled, true)
  assert.equal(p.useCount, 0)
  assert.equal(p.createdAt, now)
  assert.equal(p.createdBy, 'lead')
  assert.equal(p.updatedAt, now)
  assert.deepEqual(p.tags, ['协作', '流程'])

  const got = svc.getPrompt(p.id)
  assert.deepEqual(got, p)
  assert.equal(svc.getPrompt('pt-doesnotexist'), null, '不存在的 id 返回 null，不抛错')
})

test('create：标签去空去重、正文按字节限长、非法输入一律抛 PromptError', (t) => {
  const { svc } = setup(t)
  const p = seed(svc, { tags: [' a ', 'a', '', 'b', 'b'] })
  assert.deepEqual(p.tags, ['a', 'b'])

  assert.throws(() => seed(svc, { name: '   ' }), (e) => e.code === 'PROMPT_BAD_INPUT')
  assert.throws(() => seed(svc, { body: 123 }), (e) => e.code === 'PROMPT_BAD_BODY')
  assert.throws(() => seed(svc, { tags: 'a,b' }), (e) => e.code === 'PROMPT_BAD_TAGS')
  assert.throws(() => seed(svc, { enabled: 'false' }), (e) => e.code === 'PROMPT_BAD_ENABLED')
  assert.throws(
    () => seed(svc, { body: 'x'.repeat(MAX_BODY + 1) }),
    (e) => e.code === 'PROMPT_TOO_LARGE' && e.detail.max === MAX_BODY,
  )
  assert.throws(
    () => svc.createPrompt({ name: 'P', body: 'B' }), // 缺 by
    (e) => e.code === 'PROMPT_MISSING_ACTOR',
  )
})

test('update CAS：rev 不匹配/未给 expectedRev 抛错；正确 rev 才生效且 rev+1', (t) => {
  const { svc, dir } = setup(t)
  const now = 1_700_000_000_000
  const p = seed(svc, { now })
  const p2 = svc.updatePrompt({
    id: p.id, expectedRev: 1, name: 'P2', body: 'B2', enabled: false, by: 'lead', now: now + 1000,
  })
  assert.equal(p2.rev, 2)
  assert.equal(p2.name, 'P2')
  assert.equal(p2.body, 'B2')
  assert.equal(p2.enabled, false)
  assert.equal(p2.updatedAt, now + 1000)
  assert.equal(p2.updatedBy, 'lead')

  // 用旧 rev 再改 → CAS 冲突（绝不静默覆盖）
  assert.throws(
    () => svc.updatePrompt({ id: p.id, expectedRev: 1, name: 'X', by: 'lead' }),
    (e) => {
      assert.equal(e.code, 'PROMPT_REV_CONFLICT')
      assert.equal(e.detail.expectedRev, 1)
      assert.equal(e.detail.rev, 2)
      return true
    },
  )
  assert.throws(
    () => svc.updatePrompt({ id: p.id, name: 'X', by: 'lead' }),
    (e) => e.code === 'PROMPT_MISSING_EXPECTED_REV',
  )
  // 冲突后磁盘上仍是 rev=2 的那次更新
  assert.equal(svc.getPrompt(p.id).name, 'P2')
  assert.equal(events(dir).filter((e) => e.kind === 'prompt' && e.action === 'update').length, 1)
})

test('update：未知字段 / 空补丁拒绝；description 与 tags 允许显式清空', (t) => {
  const { svc } = setup(t)
  const p = seed(svc, { description: 'D', tags: ['x'] })
  assert.throws(
    () => svc.updatePrompt({ id: p.id, expectedRev: 1, scope: 'global', by: 'lead' }),
    (e) => e.code === 'PROMPT_UNKNOWN_FIELD' && e.detail.unknown.includes('scope'),
  )
  assert.throws(
    () => svc.updatePrompt({ id: p.id, expectedRev: 1, by: 'lead' }),
    (e) => e.code === 'PROMPT_NO_PATCH_FIELDS',
  )
  const cleared = svc.updatePrompt({ id: p.id, expectedRev: 1, description: '', tags: [], by: 'lead' })
  assert.equal(cleared.description, '')
  assert.deepEqual(cleared.tags, [])
})

test('removePrompt：CAS 删除后 get=null，事件流留 remove；旧 rev 再删抛冲突', (t) => {
  const { svc, dir } = setup(t)
  const p = seed(svc)
  const out = svc.removePrompt({ id: p.id, expectedRev: 1, by: 'lead' })
  assert.deepEqual(out, { removed: p.id, injections: 0 })
  assert.equal(svc.getPrompt(p.id), null)
  assert.equal(events(dir).filter((e) => e.kind === 'prompt' && e.action === 'remove').length, 1)
  assert.throws(
    () => svc.removePrompt({ id: p.id, expectedRev: 1, by: 'lead' }),
    (e) => e.code === 'PROMPT_NOT_FOUND',
  )
})

// ── 3. 列表筛选与分类 ───────────────────────────────────────────────────────

test('listPrompts：category / tag / query / enabled / limit 全部生效，按 updatedAt 倒序', (t) => {
  const { svc } = setup(t)
  const base = 1_700_000_000_000
  const a = seed(svc, { name: 'Alpha 复盘', body: '复盘要点', category: '编程', tags: ['review'], now: base })
  const b = seed(svc, { name: 'Beta 计划', body: '计划要点', category: '写作', tags: ['plan'], enabled: false, now: base + 1000 })
  seed(svc, { name: 'Gamma', body: '随机内容', category: '编程', tags: ['review', 'misc'], now: base + 2000 })

  assert.equal(svc.listPrompts().length, 3)
  assert.deepEqual(svc.listPrompts({ category: '编程' }).map((p) => p.name).sort(), ['Alpha 复盘', 'Gamma'])
  assert.deepEqual(svc.listPrompts({ tag: 'REVIEW' }).map((p) => p.name).sort(), ['Alpha 复盘', 'Gamma'])
  assert.deepEqual(svc.listPrompts({ enabled: false }).map((p) => p.id), [b.id])
  assert.deepEqual(svc.listPrompts({ query: '复盘' }).map((p) => p.id).sort(), [a.id])
  assert.equal(svc.listPrompts({ limit: 2 }).length, 2)
  // 倒序：最后更新的在前（Gamma base+2000, Beta +1000, Alpha base）
  assert.deepEqual(svc.listPrompts().map((p) => p.name), ['Gamma', 'Beta 计划', 'Alpha 复盘'])
})

test('分类：新建/重复拒绝/自由文本自动登记/删除后提示词迁到「未分类」/「未分类」受保护', (t) => {
  const { svc, dir } = setup(t)
  const added = svc.addCategory({ name: '测试分类', by: 'lead', now: 1_700_000_000_000 })
  assert.deepEqual(added, { name: '测试分类', createdAt: 1_700_000_000_000, createdBy: 'lead' })
  assert.throws(() => svc.addCategory({ name: '测试分类', by: 'lead' }), (e) => e.code === 'PROMPT_CATEGORY_EXISTS')

  // 自由文本分类自动登记（UI 里直接填新分类不该报错）
  const p1 = seed(svc, { name: 'A', category: '测试分类' })
  const p2 = seed(svc, { name: 'B', category: '野生分类' })
  const cats = svc.listCategories()
  const testCat = cats.find((c) => c.name === '测试分类')
  assert.equal(testCat.count, 1)
  assert.equal(testCat.builtin, false)
  assert.ok(cats.some((c) => c.name === '野生分类'), '未知分类应被自动登记')
  assert.ok(cats.some((c) => c.name === DEFAULT_CATEGORY && c.protected === true))

  // 删分类 → 其下提示词迁到「未分类」，rev 递增（内容没丢，只是换分类）
  const out = svc.removeCategory({ name: '测试分类', by: 'lead' })
  assert.deepEqual(out, { removed: '测试分类', moved: 1 })
  const moved = svc.getPrompt(p1.id)
  assert.equal(moved.category, DEFAULT_CATEGORY)
  assert.equal(moved.rev, 2)
  assert.equal(svc.getPrompt(p2.id).category, '野生分类', '其它分类的提示词不受影响')
  assert.ok(!svc.listCategories().some((c) => c.name === '测试分类'))
  assert.throws(
    () => svc.removeCategory({ name: '测试分类', by: 'lead' }),
    (e) => e.code === 'PROMPT_CATEGORY_NOT_FOUND',
  )
  assert.throws(
    () => svc.removeCategory({ name: DEFAULT_CATEGORY, by: 'lead' }),
    (e) => e.code === 'PROMPT_PROTECTED_CATEGORY',
  )
  // 迁移动作进事件流（可回放）
  const upd = events(dir).filter((e) => e.kind === 'prompt' && e.action === 'update' && e.id === p1.id)
  assert.equal(upd.length, 1)
  assert.equal(upd[0].after.category, DEFAULT_CATEGORY)
})

// ── 4. 注入轨：every 间隔 ───────────────────────────────────────────────────

test('注入每 2 回合：只在「本回合序号 % every === 0」的回合产出（4 回合实测）', (t) => {
  const { svc } = setup(t)
  const inj = svc.inject({ text: '每两回合出现', sessionId: 's1', every: 2, by: 'lead' })
  assert.equal(inj.every, 2)
  assert.equal(inj.times, 0, 'times 缺省 = 0 = 无限')

  const texts = []
  const turns = []
  for (let i = 0; i < 4; i += 1) {
    const got = svc.activeInjectionsFor({ sessionId: 's1' })
    texts.push(got.map((x) => x.text))
    turns.push(svc.tickTurn({ sessionId: 's1' }).turn)
  }
  assert.deepEqual(turns, [1, 2, 3, 4])
  assert.deepEqual(texts, [[], ['每两回合出现'], [], ['每两回合出现']])
  // 无限注入不因回合推进消失
  assert.equal(svc.listInjections({ sessionId: 's1' }).length, 1)
})

test('注入 every=1：每回合都产出；同回合重复查询幂等（不重复扣次数）', (t) => {
  const { svc } = setup(t)
  const inj = svc.inject({ text: '每回合', sessionId: 's', times: 3, every: 1, by: 'lead' })

  const first = svc.activeInjectionsFor({ sessionId: 's' })
  const again = svc.activeInjectionsFor({ sessionId: 's' })
  assert.deepEqual(first.map((x) => x.id), [inj.id])
  assert.deepEqual(again, first, '同一回合重复查询应返回同一批（幂等）')

  const tick = svc.tickTurn({ sessionId: 's' })
  assert.equal(tick.consumed, 1)
  assert.equal(svc.listInjections({ sessionId: 's' })[0].remaining, 2, '只扣一次，不是两次')
})

// ── 5. times 耗尽自动过期 / times=0 永不过期 ────────────────────────────────

test('times=2：两次产出后自动移除，事件流记 tick 与 expire，第 3 回合不再产出', (t) => {
  const { svc, dir } = setup(t)
  const inj = svc.inject({ text: '只念两次', sessionId: 's', times: 2, by: 'lead' })
  assert.equal(inj.remaining, 2)

  const t1 = playTurn(svc, 's')
  assert.deepEqual(t1.texts, ['只念两次'])
  assert.equal(t1.tick.consumed, 1)
  assert.equal(t1.tick.expired, 0)
  assert.equal(svc.listInjections({ sessionId: 's' })[0].remaining, 1)

  const t2 = playTurn(svc, 's')
  assert.deepEqual(t2.texts, ['只念两次'])
  assert.equal(t2.tick.expired, 1, '第二次产出后剩余归零 → 自动过期')
  assert.equal(svc.listInjections({ sessionId: 's' }).length, 0)

  const t3 = playTurn(svc, 's')
  assert.deepEqual(t3.texts, [], '耗尽后不再产出')

  const actions = events(dir).filter((e) => e.kind === 'injection' && e.id === inj.id).map((e) => e.action)
  assert.deepEqual(actions, ['create', 'tick', 'expire'])
})

test('times=0：无限注入，5 回合后仍存在，永不自动过期', (t) => {
  const { svc } = setup(t)
  const inj = svc.inject({ text: '持续注入', sessionId: 's', times: 0, every: 1, by: 'lead' })
  for (let i = 0; i < 5; i += 1) {
    const { texts, tick } = playTurn(svc, 's')
    assert.deepEqual(texts, ['持续注入'])
    assert.equal(tick.expired, 0)
  }
  const list = svc.listInjections({ sessionId: 's' })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, inj.id)
  assert.equal(list[0].remaining, 0, '无限注入的 remaining 保持 0（哨兵值）')
})

// ── 6. immediate：只产出一次，无视 times/every ──────────────────────────────

test('immediate=true：忽略传入的 times/every，只产出一次后移除', (t) => {
  const { svc } = setup(t)
  const inj = svc.inject({
    text: '立即执行一次', sessionId: 's', times: 5, every: 3, immediate: true, by: 'lead',
  })
  assert.equal(inj.immediate, true)
  assert.equal(inj.times, 1, 'immediate 覆盖 times')
  assert.equal(inj.every, 0, 'immediate 覆盖 every')

  // 第 1 回合（even 不是 3 的倍数）也能产出 —— immediate 不看间隔
  const t1 = playTurn(svc, 's')
  assert.deepEqual(t1.texts, ['立即执行一次'])
  assert.equal(t1.tick.expired, 1)
  assert.equal(svc.listInjections({ sessionId: 's' }).length, 0)

  const t2 = playTurn(svc, 's')
  assert.deepEqual(t2.texts, [], '只产出一次')
})

// ── 7. {{date}} / {{time}} 在产出时展开 ─────────────────────────────────────

test('{{date}}/{{time}}：在**产出时**展开，且每次产出都按当时的 now 展开', (t) => {
  const { svc } = setup(t)
  const day1 = new Date(2026, 10, 4, 9, 5, 0).getTime() // 本地 2026-11-04 09:05
  const day2 = new Date(2026, 10, 5, 18, 30, 0).getTime() // 本地 2026-11-05 18:30
  svc.inject({ text: '今天是 {{date}} {{time}}，未知识别 {{path}}', sessionId: 's', by: 'lead' })

  const t1 = playTurn(svc, 's', day1)
  assert.deepEqual(t1.texts, ['今天是 2026-11-04 09:05，未知识别 {{path}}'])
  const t2 = playTurn(svc, 's', day2)
  assert.deepEqual(t2.texts, ['今天是 2026-11-05 18:30，未知识别 {{path}}'],
    '同一注入第二天产出必须是新日期（证明不是创建时写死）')
})

// ── 8. 停止注入 ─────────────────────────────────────────────────────────────

test('stopInjection：停止后不再产出；重复停止抛 PROMPT_INJECTION_NOT_FOUND', (t) => {
  const { svc, dir } = setup(t)
  const inj = svc.inject({ text: '马上停', sessionId: 's', times: 0, by: 'lead' })
  svc.activeInjectionsFor({ sessionId: 's' }) // 已产出但先 stop
  const out = svc.stopInjection({ id: inj.id, by: 'lead' })
  assert.deepEqual(out, { stopped: inj.id })
  assert.equal(svc.listInjections({ sessionId: 's' }).length, 0)
  assert.deepEqual(svc.activeInjectionsFor({ sessionId: 's' }), [])
  assert.throws(
    () => svc.stopInjection({ id: inj.id, by: 'lead' }),
    (e) => e.code === 'PROMPT_INJECTION_NOT_FOUND',
  )
  assert.deepEqual(
    events(dir).filter((e) => e.kind === 'injection' && e.id === inj.id).map((e) => e.action),
    ['create', 'stop'],
  )
  // tick 不应因 pending 残留而报错
  assert.equal(svc.tickTurn({ sessionId: 's' }).consumed, 0)
})

// ── 9. 删除提示词级联清注入 ─────────────────────────────────────────────────

test('removePrompt：级联删除其名下全部活跃注入，ad-hoc 注入与其它提示词的注入不受影响', (t) => {
  const { svc, dir } = setup(t)
  const p1 = seed(svc, { name: 'P1', body: 'B1' })
  const p2 = seed(svc, { name: 'P2', body: 'B2' })
  const inj1 = svc.inject({ promptId: p1.id, sessionId: 's-a', by: 'lead' })
  const inj2 = svc.inject({ promptId: p1.id, sessionId: 's-b', by: 'lead' })
  const inj3 = svc.inject({ promptId: p2.id, sessionId: 's-a', by: 'lead' })
  const inj4 = svc.inject({ text: '临时提醒', sessionId: 's-a', by: 'lead' })

  const out = svc.removePrompt({ id: p1.id, expectedRev: p1.rev, by: 'lead' })
  assert.deepEqual(out, { removed: p1.id, injections: 2 })

  const left = svc.listInjections().map((x) => x.id).sort()
  assert.deepEqual(left, [inj3.id, inj4.id].sort())
  assert.equal(svc.listInjections().find((x) => x.id === inj1.id), undefined)
  assert.equal(svc.listInjections().find((x) => x.id === inj2.id), undefined)

  const stopEvents = events(dir).filter((e) => e.kind === 'injection' && e.action === 'stop')
  assert.deepEqual(stopEvents.map((e) => e.id).sort(), [inj1.id, inj2.id].sort())
  // 悬空引用不会产出
  svc.tickTurn({ sessionId: 's-a' })
  assert.deepEqual(svc.activeInjectionsFor({ sessionId: 's-b' }), [])
})

// ── 10. 会话隔离与产出正文 ─────────────────────────────────────────────────

test('会话隔离：注入只对指定 sessionId 生效', (t) => {
  const { svc } = setup(t)
  svc.inject({ text: '给 A 的', sessionId: 'sess-A', by: 'lead' })
  svc.inject({ text: '给 B 的', sessionId: 'sess-B', by: 'lead' })
  assert.deepEqual(svc.activeInjectionsFor({ sessionId: 'sess-A' }).map((x) => x.text), ['给 A 的'])
  svc.tickTurn({ sessionId: 'sess-A' })
  assert.deepEqual(svc.activeInjectionsFor({ sessionId: 'sess-B' }).map((x) => x.text), ['给 B 的'])
  assert.deepEqual(svc.activeInjectionsFor({ sessionId: 'sess-C' }), [])
  assert.equal(svc.listInjections({ sessionId: 'sess-A' }).length, 1)
  assert.equal(svc.listInjections().length, 2)
})

test('提示词注入：产出时实时读最新 body（改了正文，下一回合就念新版本）', (t) => {
  const { svc } = setup(t)
  const p = seed(svc, { name: 'P', body: '旧正文' })
  svc.inject({ promptId: p.id, sessionId: 's', by: 'lead' })
  assert.deepEqual(svc.activeInjectionsFor({ sessionId: 's' }).map((x) => x.text), ['旧正文'])
  svc.tickTurn({ sessionId: 's' })

  svc.updatePrompt({ id: p.id, expectedRev: 1, body: '新正文', by: 'lead' })
  assert.deepEqual(svc.activeInjectionsFor({ sessionId: 's' }).map((x) => x.text), ['新正文'])
})

// ── 11. 注入入参校验 ────────────────────────────────────────────────────────

test('inject 入参：promptId/text 二选一、停用提示词不可注入、非法 timing 拒绝', (t) => {
  const { svc } = setup(t)
  const p = seed(svc, { name: 'P', body: 'B' })
  assert.throws(
    () => svc.inject({ promptId: p.id, text: 'x', sessionId: 's', by: 'lead' }),
    (e) => e.code === 'PROMPT_AMBIGUOUS_INPUT',
  )
  assert.throws(
    () => svc.inject({ sessionId: 's', by: 'lead' }),
    (e) => e.code === 'PROMPT_MISSING_TEXT',
  )
  assert.throws(
    () => svc.inject({ text: 'x', by: 'lead' }),
    (e) => e.code === 'PROMPT_BAD_INPUT', // 缺 sessionId
  )
  assert.throws(
    () => svc.inject({ text: 'x', sessionId: 's', times: -1, by: 'lead' }),
    (e) => e.code === 'PROMPT_BAD_TIMING',
  )
  assert.throws(
    () => svc.inject({ text: 'x', sessionId: 's', every: 1.5, by: 'lead' }),
    (e) => e.code === 'PROMPT_BAD_TIMING',
  )

  svc.updatePrompt({ id: p.id, expectedRev: 1, enabled: false, by: 'lead' })
  assert.throws(
    () => svc.inject({ promptId: p.id, sessionId: 's', by: 'lead' }),
    (e) => e.code === 'PROMPT_DISABLED',
  )
  assert.throws(
    () => svc.inject({ promptId: 'pt-nope', sessionId: 's', by: 'lead' }),
    (e) => e.code === 'PROMPT_NOT_FOUND',
  )
})

// ── 12. useCount 遥测（不碰 prompt.rev）─────────────────────────────────────

test('useCount：每回合产出计一次，prompt.rev 不被后台计数推高（CAS 不被遥测干扰）', (t) => {
  const { svc } = setup(t)
  const p = seed(svc, { name: 'P', body: 'B' })
  svc.inject({ promptId: p.id, sessionId: 's', times: 0, by: 'lead' })
  playTurn(svc, 's')
  playTurn(svc, 's')
  const after = svc.getPrompt(p.id)
  assert.equal(after.useCount, 2)
  assert.equal(after.rev, 1, '遥测不得推高内容 rev（否则 UI 编辑会一直 CAS 冲突）')
  // UI 用会话开始时的 rev=1 编辑仍然成功
  const edited = svc.updatePrompt({ id: p.id, expectedRev: 1, name: 'P2', by: 'lead' })
  assert.equal(edited.rev, 2)
})

// ── 13. replay 恢复（事件流真相源 + 快照兜底）──────────────────────────────

test('replay：新实例从 prompts.jsonl 恢复提示词/注入/剩余次数/回合序号/useCount', (t) => {
  const { dir, svc } = setup(t)
  const p = seed(svc, { name: '持久化', body: '正文' })
  svc.inject({ promptId: p.id, sessionId: 's', times: 3, by: 'lead' })
  svc.inject({ text: 'ad-hoc', sessionId: 's', times: 0, by: 'lead' })

  // 跑 2 回合：两个注入各消耗 2 次 → prompt 注入 remaining=1，useCount=2
  playTurn(svc, 's')
  playTurn(svc, 's')

  const svc2 = createPrompts({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const info = svc2.replay()
  assert.equal(info.from, 'jsonl')
  assert.equal(info.prompts, 1)
  assert.equal(info.injections, 2)
  assert.equal(info.sessions, 1)

  const restored = svc2.getPrompt(p.id)
  assert.equal(restored.name, '持久化')
  assert.equal(restored.useCount, 2, 'usage 事件回放后计数不归零')
  assert.equal(restored.rev, 1)

  const injs = svc2.listInjections({ sessionId: 's' })
  assert.equal(injs.length, 2)
  const byPrompt = injs.find((x) => x.promptId === p.id)
  assert.equal(byPrompt.remaining, 1, '剩余次数必须回放（否则重启后无限续命）')

  // 回合序号已推进到 2 → 下一回合是第 3 回合，every=1 仍产出；第 3 次消耗后过期
  assert.equal(svc2.activeInjectionsFor({ sessionId: 's' }).length, 2)
  const tick = svc2.tickTurn({ sessionId: 's' })
  assert.equal(tick.turn, 3)
  assert.equal(tick.expired, 1, 'remaining=1 消耗后归零 → 过期')
  assert.equal(svc2.listInjections({ sessionId: 's' }).length, 1, '只剩无限注入')
})

test('replay：事件流被删时从快照恢复（快照是兜底，不是真相源）', (t) => {
  const { dir, svc } = setup(t)
  const p = seed(svc, { name: '快照恢复', body: 'B' })
  svc.inject({ promptId: p.id, sessionId: 's', times: 2, by: 'lead' })
  svc.tickTurn({ sessionId: 's' })

  // 模拟"jsonl 丢了"（人为删掉真相源，验证快照兜底能力）
  rmSync(join(dir, 'prompts.jsonl'), { force: true })

  const svc2 = createPrompts({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const info = svc2.replay()
  assert.equal(info.from, 'snapshot')
  assert.equal(info.prompts, 1)
  assert.equal(info.injections, 1)
  assert.equal(info.sessions, 1)
  assert.equal(svc2.getPrompt(p.id).name, '快照恢复')
  assert.equal(svc2.listInjections({ sessionId: 's' })[0].remaining, 2)
})

test('replay：坏行不被静默丢弃（bad 计数可见），好行照常恢复', (t) => {
  const { dir, svc } = setup(t)
  const p = seed(svc, { name: '好数据', body: 'B' })
  const jsonl = join(dir, 'prompts.jsonl')
  appendFileSync(jsonl, '{这不是合法 JSON\n')
  const svc2 = createPrompts({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const info = svc2.replay()
  assert.equal(info.from, 'jsonl')
  assert.equal(info.bad, 1)
  assert.equal(info.prompts, 1)
  assert.equal(svc2.getPrompt(p.id).name, '好数据')
})

// ── 14. stats / dispose ─────────────────────────────────────────────────────

test('stats：提示词/分类/注入/标签计数与 byCategory 可核对', (t) => {
  const { svc } = setup(t)
  seed(svc, { name: 'A', category: '编程', tags: ['x'] })
  seed(svc, { name: 'B', category: '编程', tags: ['x', 'y'], enabled: false })
  svc.inject({ text: 't', sessionId: 's1', by: 'lead' })
  svc.inject({ text: 't', sessionId: 's2', by: 'lead' })
  const s = svc.stats()
  assert.equal(s.prompts, 2)
  assert.equal(s.enabled, 1)
  assert.equal(s.disabled, 1)
  assert.equal(s.categories, DEFAULT_CATEGORIES.length)
  assert.equal(s.tags, 2)
  assert.equal(s.injections, 2)
  assert.equal(s.sessions, 0, '会话要 tick 过才有编号')
  assert.deepEqual(s.byCategory, { 编程: 2 })
  assert.deepEqual(s.bySession, { s1: 1, s2: 1 })
  assert.ok(s.events >= 4)
})

test('dispose：之后所有方法抛 PROMPT_DISPOSED，文件保留', (t) => {
  const { dir, svc } = setup(t)
  seed(svc)
  const out = svc.dispose()
  assert.equal(out.disposed, true)
  assert.equal(out.prompts, 1)
  assert.equal(existsSync(join(dir, 'prompts.jsonl')), true)
  for (const fn of [
    () => svc.createPrompt({ name: 'X', body: 'B', by: 'lead' }),
    () => svc.getPrompt('pt-x'),
    () => svc.listPrompts(),
    () => svc.listCategories(),
    () => svc.inject({ text: 'x', sessionId: 's', by: 'lead' }),
    () => svc.activeInjectionsFor({ sessionId: 's' }),
    () => svc.tickTurn({ sessionId: 's' }),
    () => svc.stats(),
    () => svc.replay(),
  ]) {
    assert.throws(fn, (e) => {
      assert.equal(e.code, 'PROMPT_DISPOSED')
      return true
    })
  }
})
