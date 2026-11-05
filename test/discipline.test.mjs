/**
 * DisciplineService 测试 —— 分级纪律体系（DESIGN-v2 §特性②）。
 *
 * 纪律：每条断言都用**实际落盘产物**或**真实返回值**做证据，
 * 不接受「函数没抛错」这种弱断言。
 * 只碰 `node:test` + `node:assert` + `node:fs` + `node:os` + `node:path`。
 *
 * 运行：`node --test test/discipline.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createDiscipline, {
  DisciplineError,
  SCOPES,
  KINDS,
  IMPORT_MODES,
  LIMITS,
} from '../src/discipline.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/**
 * 每个用例一个独立状态目录（互不污染）。
 * 目录优先放 `DISCIPLINE_TEST_TMPDIR`（沙箱受限时可指定到工作区内），否则走系统临时目录。
 */
function setup(t, config = {}) {
  const base = process.env.DISCIPLINE_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-discipline-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const svc = createDiscipline({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

/** 读事件流（真相源）。 */
function events(dir) {
  const file = join(dir, 'discipline.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 快照文件路径。 */
function snapFile(dir) {
  return join(dir, 'discipline.snap.json')
}

/**
 * token 粗算的**独立实现**（用于验证模块内口径）：
 * 与 memory.js:estimateTokens 同款 —— ASCII 4 字符/token，宽字符（>U+2E80）1.5 字符/token。
 */
function estimate(text) {
  const s = String(text ?? '')
  if (s === '') return 0
  let wide = 0
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x2e80) wide += 1
  }
  return Math.ceil((s.length - wide) / 4 + wide / 1.5)
}

/** 建一条纪律（省去样板）。 */
function seed(svc, over = {}) {
  return svc.createDiscipline({
    scope: 'global', kind: 'rule', title: 'S', content: 'C', by: 'lead', ...over,
  })
}

// ── 1. 导出面 ───────────────────────────────────────────────────────────────

test('导出：与 board.js 同款 —— default 是工厂，命名导出常量与错误类', () => {
  assert.equal(typeof createDiscipline, 'function')
  assert.deepEqual(SCOPES, ['global', 'workspace', 'room', 'bot'])
  assert.deepEqual(KINDS, ['rule', 'requirement', 'principle', 'style'])
  assert.deepEqual(IMPORT_MODES, ['skip', 'overwrite', 'rename'])
  assert.equal(LIMITS.title, 120)
  assert.equal(LIMITS.content, 4000)
  assert.equal(typeof DisciplineError, 'function')
  assert.ok(Object.isFrozen(SCOPES) || Array.isArray(SCOPES))
})

test('错误类：DisciplineError 带 code 与 detail（契约要求）', () => {
  const err = new DisciplineError('boom', 'DISCIPLINE_TEST_CODE', { id: 'd-1' })
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'DisciplineError')
  assert.equal(err.code, 'DISCIPLINE_TEST_CODE')
  assert.deepEqual(err.detail, { id: 'd-1' })
  // 缺省 code 不能是 undefined（否则 API 层无法分支）
  assert.equal(new DisciplineError('x').code, 'DISCIPLINE_ERROR')
})

// ── 2. create / 模型形状 / 落盘 ─────────────────────────────────────────────

test('create：返回契约模型形状（含 id/rev/createdBy/updatedBy），事件与快照都落盘', (t) => {
  const { dir, svc } = setup(t)
  const at = 1_700_000_000_000
  const d = svc.createDiscipline({
    scope: 'room',
    scopeId: 'room-1',
    kind: 'requirement',
    title: '交付要带证据',
    content: '每个结论都要有可核查的退出码或日志',
    priority: 5,
    by: 'lead',
    now: at,
  })

  assert.equal(d.id, 'd-1')
  assert.equal(d.rev, 1)
  assert.equal(d.scope, 'room')
  assert.equal(d.scopeId, 'room-1')
  assert.equal(d.kind, 'requirement')
  assert.equal(d.title, '交付要带证据')
  assert.equal(d.priority, 5)
  assert.equal(d.enabled, true)
  assert.equal(d.createdAt, at)
  assert.equal(d.createdBy, 'lead')
  assert.equal(d.updatedAt, at)
  assert.equal(d.updatedBy, 'lead')

  const rows = events(dir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].disciplineId, 'd-1')
  assert.equal(rows[0].action, 'create')
  assert.equal(rows[0].rev, 1)
  assert.equal(rows[0].before, null)
  assert.equal(rows[0].after.content, '每个结论都要有可核查的退出码或日志')
  assert.ok(existsSync(snapFile(dir)), '快照应已写入')

  // 缺省值：priority=0 / enabled=true
  const d2 = svc.createDiscipline({ scope: 'global', kind: 'rule', title: 'T2', content: 'C2', by: 'lead' })
  assert.equal(d2.priority, 0)
  assert.equal(d2.enabled, true)
  assert.equal(d2.scopeId, null)
  assert.equal(d2.id, 'd-2')
})

test('create：字段校验全部抛可读错误（scope/kind/scopeId/title/content/priority/enabled/by）', (t) => {
  const { svc } = setup(t)
  const cases = [
    [{ kind: 'rule', title: 't', content: 'c', by: 'lead' }, 'DISCIPLINE_BAD_SCOPE', /scope/],
    [{ scope: 'galaxy', kind: 'rule', title: 't', content: 'c', by: 'lead' }, 'DISCIPLINE_BAD_SCOPE', /galaxy/],
    [{ scope: 'global', kind: 'oops', title: 't', content: 'c', by: 'lead' }, 'DISCIPLINE_BAD_KIND', /kind/],
    [{ scope: 'global', kind: 'rule', content: 'c', by: 'lead' }, 'DISCIPLINE_MISSING_FIELD', /title/],
    [{ scope: 'global', kind: 'rule', title: 't', by: 'lead' }, 'DISCIPLINE_MISSING_FIELD', /content/],
    [{ scope: 'global', kind: 'rule', title: 't', content: 'c' }, 'DISCIPLINE_MISSING_FIELD', /by/],
    [{ scope: 'global', scopeId: 'x', kind: 'rule', title: 't', content: 'c', by: 'lead' }, 'DISCIPLINE_BAD_SCOPE_ID', /global/],
    [{ scope: 'room', kind: 'rule', title: 't', content: 'c', by: 'lead' }, 'DISCIPLINE_BAD_SCOPE_ID', /scopeId/],
    [{ scope: 'global', kind: 'rule', title: 't'.repeat(121), content: 'c', by: 'lead' }, 'DISCIPLINE_TITLE_TOO_LONG', /120/],
    [{ scope: 'global', kind: 'rule', title: 't', content: 'c'.repeat(4001), by: 'lead' }, 'DISCIPLINE_CONTENT_TOO_LONG', /4000/],
    [{ scope: 'global', kind: 'rule', title: 't', content: 'c', priority: 'high', by: 'lead' }, 'DISCIPLINE_BAD_FIELD', /priority/],
    [{ scope: 'global', kind: 'rule', title: 't', content: 'c', enabled: 'yes', by: 'lead' }, 'DISCIPLINE_BAD_FIELD', /enabled/],
  ]
  for (const [input, code, re] of cases) {
    assert.throws(
      () => svc.createDiscipline(input),
      (e) => e instanceof DisciplineError && e.code === code && re.test(e.message) && e.detail !== undefined,
      `应抛 ${code}：${JSON.stringify(input)}`,
    )
  }
  // 校验失败不落盘、不占 id（下一次成功创建仍是 d-1）
  assert.equal(svc.listDisciplines().length, 0)
  assert.equal(seed(svc).id, 'd-1')
})

test('create：边界值 title=120 / content=4000 必须接受（不能多拒一个字符）', (t) => {
  const { svc } = setup(t)
  const ok = svc.createDiscipline({
    scope: 'global', kind: 'rule', title: 't'.repeat(120), content: 'c'.repeat(4000), by: 'lead',
  })
  assert.equal(ok.title.length, 120)
  assert.equal(ok.content.length, 4000)
})

test('写入失败绝不静默：stateDir 不可写时抛 DISCIPLINE_APPEND_FAILED，且内存不落脏数据', (t) => {
  const { dir } = setup(t)
  // 用「普通文件」冒充状态目录 → append 必然失败
  const blocked = join(dir, 'blocked-dir')
  writeFileSync(blocked, 'not a directory')
  const svc = createDiscipline({ logger: { info() {}, warn() {} } }, { stateDir: blocked })

  assert.throws(
    () => svc.createDiscipline({ scope: 'global', kind: 'rule', title: 't', content: 'c', by: 'lead' }),
    (e) => e instanceof DisciplineError && e.code === 'DISCIPLINE_APPEND_FAILED'
      && e.detail?.path === join(blocked, 'discipline.jsonl'),
  )
  // 事件流没写成 → 内存也必须原封不动（否则重启回放会凭空回退）
  assert.equal(svc.listDisciplines().length, 0)
  assert.equal(svc.stats().total, 0)
})

// ── 3. get / list ───────────────────────────────────────────────────────────

test('get：返回深拷贝（外部改它不影响库）；不存在返回 undefined', (t) => {
  const { svc } = setup(t)
  const d = seed(svc, { title: '原标题' })
  const got = svc.getDiscipline(d.id)
  got.title = '被外部改掉'
  got.__hack = true
  assert.equal(svc.getDiscipline(d.id).title, '原标题')
  assert.equal(svc.getDiscipline(d.id).__hack, undefined)
  assert.equal(svc.getDiscipline('d-999'), undefined)
  assert.equal(svc.getDiscipline(undefined), undefined)
})

test('list：按 scope/scopeId/kind/enabled/query 过滤（AND 语义），非法枚举值抛错', (t) => {
  const { svc } = setup(t)
  seed(svc, { scope: 'global', kind: 'rule', title: 'Alpha Rule', content: 'needle in body', enabled: true })
  seed(svc, { scope: 'workspace', scopeId: '/tmp/ws-a', kind: 'requirement', title: 'Beta 要求', enabled: true })
  seed(svc, { scope: 'bot', scopeId: 'bot-1', kind: 'style', title: 'Gamma 风格', enabled: false })

  assert.equal(svc.listDisciplines().length, 3)
  assert.equal(svc.listDisciplines({ scope: 'global' }).length, 1)
  assert.equal(svc.listDisciplines({ scope: 'workspace', scopeId: '/tmp/ws-a' }).length, 1)
  assert.equal(svc.listDisciplines({ kind: 'style' }).length, 1)
  assert.equal(svc.listDisciplines({ enabled: false }).length, 1)
  assert.equal(svc.listDisciplines({ enabled: true }).length, 2)
  assert.equal(svc.listDisciplines({ query: 'alpha' }).length, 1, 'query 应大小写不敏感')
  assert.equal(svc.listDisciplines({ query: 'NEEDLE' }).length, 1, 'query 应覆盖正文')
  assert.equal(svc.listDisciplines({ query: '不存在的词' }).length, 0)
  // 创建序
  assert.deepEqual(svc.listDisciplines().map((d) => d.id), ['d-1', 'd-2', 'd-3'])

  assert.throws(() => svc.listDisciplines({ scope: 'galaxy' }), (e) => e.code === 'DISCIPLINE_BAD_SCOPE')
  assert.throws(() => svc.listDisciplines({ kind: 'galaxy' }), (e) => e.code === 'DISCIPLINE_BAD_KIND')
})

// ── 4. update（CAS）────────────────────────────────────────────────────────

test('update：rev+1、updatedAt/updatedBy 刷新、字段生效，事件保留 before/after', (t) => {
  const { dir, svc } = setup(t)
  const d = seed(svc, { title: '旧标题', content: '旧正文', priority: 1, now: 1_700_000_000_000 })
  const updated = svc.updateDiscipline({
    id: d.id,
    expectedRev: 1,
    title: '新标题',
    content: '新正文',
    kind: 'principle',
    priority: 9,
    enabled: false,
    by: 'reviewer',
    now: 1_700_000_100_000,
  })

  assert.equal(updated.rev, 2)
  assert.equal(updated.title, '新标题')
  assert.equal(updated.content, '新正文')
  assert.equal(updated.kind, 'principle')
  assert.equal(updated.priority, 9)
  assert.equal(updated.enabled, false)
  assert.equal(updated.createdAt, 1_700_000_000_000, 'createdAt 不随更新变化')
  assert.equal(updated.createdBy, 'lead')
  assert.equal(updated.updatedAt, 1_700_000_100_000)
  assert.equal(updated.updatedBy, 'reviewer')

  const rows = events(dir)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].action, 'update')
  assert.equal(rows[1].rev, 2)
  assert.equal(rows[1].before.title, '旧标题')
  assert.equal(rows[1].after.title, '新标题')
  assert.equal(rows[1].byId, 'reviewer')
})

test('update：CAS 冲突 / 缺 expectedRev / 未知字段 / 空补丁 / 条目不存在 → 全部抛错', (t) => {
  const { svc } = setup(t)
  const d = seed(svc)

  assert.throws(
    () => svc.updateDiscipline({ id: d.id, expectedRev: 999, title: 'x', by: 'lead' }),
    (e) => e instanceof DisciplineError && e.code === 'DISCIPLINE_REV_CONFLICT'
      && e.detail.expectedRev === 999 && e.detail.rev === 1,
  )
  assert.throws(
    () => svc.updateDiscipline({ id: d.id, title: 'x', by: 'lead' }),
    (e) => e.code === 'DISCIPLINE_MISSING_EXPECTED_REV',
  )
  assert.throws(
    () => svc.updateDiscipline({ id: d.id, expectedRev: 1, scope: 'bot', by: 'lead' }),
    (e) => e.code === 'DISCIPLINE_UNKNOWN_FIELD' && /scope/.test(e.message),
  )
  assert.throws(
    () => svc.updateDiscipline({ id: d.id, expectedRev: 1, by: 'lead' }),
    (e) => e.code === 'DISCIPLINE_NO_PATCH_FIELDS',
  )
  assert.throws(
    () => svc.updateDiscipline({ id: 'd-999', expectedRev: 1, title: 'x', by: 'lead' }),
    (e) => e.code === 'DISCIPLINE_NOT_FOUND',
  )
  // 校验失败的更新不产生事件、不改内存
  assert.equal(events===events && svc.getDiscipline(d.id).rev, 1)
  assert.equal(svc.history().length, 1)
})

// ── 5. remove（CAS）────────────────────────────────────────────────────────

test('remove：CAS 保护、返回 { removed }、条目消失但事件流留 before 快照', (t) => {
  const { dir, svc } = setup(t)
  const d = seed(svc, { title: '将被删除' })

  assert.throws(
    () => svc.removeDiscipline({ id: d.id, expectedRev: 7, by: 'lead' }),
    (e) => e.code === 'DISCIPLINE_REV_CONFLICT',
  )
  assert.deepEqual(svc.removeDiscipline({ id: d.id, expectedRev: 1, by: 'lead' }), { removed: d.id })
  assert.equal(svc.getDiscipline(d.id), undefined)
  assert.equal(svc.listDisciplines().length, 0)

  const rows = events(dir)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].action, 'remove')
  assert.equal(rows[1].before.title, '将被删除')
  assert.equal(rows[1].after, null)
  assert.equal(rows[1].rev, 2)

  assert.throws(
    () => svc.removeDiscipline({ id: d.id, expectedRev: 2, by: 'lead' }),
    (e) => e.code === 'DISCIPLINE_NOT_FOUND',
  )
})

// ── 6. resolve：层级合并 ───────────────────────────────────────────────────

test('resolve：同 priority=0 时按 scope 具体度排序 bot > room > workspace > global', (t) => {
  const { svc } = setup(t)
  // 故意乱序创建，证明输出顺序来自排序而不是插入序
  seed(svc, { scope: 'workspace', scopeId: '/tmp/ws-a', kind: 'rule', title: 'W', content: 'w' })
  seed(svc, { scope: 'global', kind: 'rule', title: 'G', content: 'g' })
  seed(svc, { scope: 'bot', scopeId: 'bot-1', kind: 'rule', title: 'B', content: 'b' })
  seed(svc, { scope: 'room', scopeId: 'room-1', kind: 'rule', title: 'R', content: 'r' })

  const r = svc.resolveDisciplines({ botId: 'bot-1', cwd: '/tmp/ws-a', roomId: 'room-1' })
  assert.deepEqual(r.items.map((d) => d.scope), ['bot', 'room', 'workspace', 'global'])
  assert.deepEqual(r.items.map((d) => d.title), ['B', 'R', 'W', 'G'])
  assert.deepEqual(r.byScope, { global: 1, workspace: 1, room: 1, bot: 1 })
  assert.equal(r.truncated, false)
  assert.equal(r.dropped, 0)
  // 分节 markdown 顺序：纪律 → 要求 → 原则 → 风格（全部 rule 时只有「纪律」）
  assert.ok(r.text.startsWith('## 纪律'), r.text)
  assert.ok(r.text.indexOf('- **B**：b') < r.text.indexOf('- **R**：r'))
})

test('resolve：priority 是第一关键字（高 priority 的 global 排在低 priority 的 bot 前）', (t) => {
  const { svc } = setup(t)
  seed(svc, { scope: 'bot', scopeId: 'bot-1', kind: 'rule', title: 'B', content: 'b', priority: 0 })
  seed(svc, { scope: 'global', kind: 'rule', title: 'G', content: 'g', priority: 10 })
  seed(svc, { scope: 'room', scopeId: 'room-1', kind: 'rule', title: 'R', content: 'r', priority: 5 })

  const r = svc.resolveDisciplines({ botId: 'bot-1', roomId: 'room-1' })
  assert.deepEqual(r.items.map((d) => d.title), ['G', 'R', 'B'])
  assert.deepEqual(r.items.map((d) => d.priority), [10, 5, 0])
})

test('resolve：只取 enabled !== false；disabled 条目既不进结果也不计入 dropped', (t) => {
  const { svc } = setup(t)
  seed(svc, { scope: 'global', kind: 'rule', title: '开的', content: 'on', enabled: true })
  seed(svc, { scope: 'global', kind: 'rule', title: '关的', content: 'off', enabled: false })

  const r = svc.resolveDisciplines({})
  assert.deepEqual(r.items.map((d) => d.title), ['开的'])
  assert.equal(r.dropped, 0, 'disabled 是被过滤掉而不是被去重丢弃')
  assert.ok(!r.text.includes('off'))
  assert.equal(r.byScope.global, 1)
})

test('resolve：scopeId 不匹配的层级条目不会被收集（cwd/roomId/botId 缺省即不收集）', (t) => {
  const { svc } = setup(t)
  seed(svc, { scope: 'global', kind: 'rule', title: 'G', content: 'g' })
  seed(svc, { scope: 'workspace', scopeId: '/tmp/ws-a', kind: 'rule', title: 'W', content: 'w' })
  seed(svc, { scope: 'room', scopeId: 'room-1', kind: 'rule', title: 'R', content: 'r' })
  seed(svc, { scope: 'bot', scopeId: 'bot-1', kind: 'rule', title: 'B', content: 'b' })

  // 只给 botId：workspace / room 都不该进来
  const onlyBot = svc.resolveDisciplines({ botId: 'bot-1' })
  assert.deepEqual(onlyBot.items.map((d) => d.title), ['B', 'G'])
  assert.equal(onlyBot.byScope.workspace, 0)
  assert.equal(onlyBot.byScope.room, 0)

  // 什么都不给：只剩 global
  const onlyGlobal = svc.resolveDisciplines()
  assert.deepEqual(onlyGlobal.items.map((d) => d.title), ['G'])
  assert.deepEqual(onlyGlobal.byScope, { global: 1, workspace: 0, room: 0, bot: 0 })

  // cwd 尾部斜杠应等价（路径归一后比较）
  const slash = svc.resolveDisciplines({ cwd: '/tmp/ws-a/' })
  assert.equal(slash.byScope.workspace, 1)
})

test('resolve：同 title 只保留最具体那条，丢弃计入 dropped（具体度优先于 priority）', (t) => {
  const { svc } = setup(t)
  // global 的 priority 极高，但 bot 更具体 → 仍然保留 bot
  seed(svc, { scope: 'global', kind: 'rule', title: 'X', content: 'GLOBAL-BODY', priority: 100 })
  seed(svc, { scope: 'bot', scopeId: 'bot-1', kind: 'rule', title: 'X', content: 'BOT-BODY', priority: 0 })
  // 另一个同 title 的 room 条目也参与去重
  seed(svc, { scope: 'room', scopeId: 'room-1', kind: 'rule', title: 'X', content: 'ROOM-BODY', priority: 50 })

  const r = svc.resolveDisciplines({ botId: 'bot-1', roomId: 'room-1' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].scope, 'bot')
  assert.equal(r.items[0].content, 'BOT-BODY')
  assert.equal(r.dropped, 2, '同 title 的 global + room 两条都被丢弃')
  assert.ok(!r.text.includes('GLOBAL-BODY'))
  assert.ok(!r.text.includes('ROOM-BODY'))
  assert.ok(r.text.includes('BOT-BODY'))
})

test('resolve：空库返回空 text 与全零 byScope（UI 不用判空）', (t) => {
  const { svc } = setup(t)
  const r = svc.resolveDisciplines({})
  assert.deepEqual(r.items, [])
  assert.equal(r.text, '')
  assert.equal(r.truncated, false)
  assert.equal(r.dropped, 0)
  assert.deepEqual(r.byScope, { global: 0, workspace: 0, room: 0, bot: 0 })
})

// ── 7. render：分节 markdown / token 预算 ──────────────────────────────────

test('render：分节 markdown 按「纪律 → 要求 → 原则 → 风格」渲染，空分类不出现', (t) => {
  const { svc } = setup(t)
  seed(svc, { scope: 'global', kind: 'style', title: 'S', content: '这样说话' })
  seed(svc, { scope: 'global', kind: 'rule', title: 'R', content: '不许跳过测试' })
  seed(svc, { scope: 'global', kind: 'principle', title: 'P', content: '证据优先' })
  seed(svc, { scope: 'global', kind: 'requirement', title: 'Q', content: '必须带退出码' })

  const r = svc.renderDisciplinePrompt({})
  for (const header of ['## 纪律', '## 要求', '## 原则', '## 风格']) {
    assert.ok(r.text.includes(header), `缺小节 ${header}`)
  }
  const order = ['## 纪律', '## 要求', '## 原则', '## 风格'].map((h) => r.text.indexOf(h))
  assert.deepEqual([...order].sort((a, b) => a - b), order, `小节顺序错乱：${r.text}`)
  assert.ok(r.text.includes('- **R**：不许跳过测试'))
  assert.equal(r.tokens, estimate(r.text), 'tokens 必须与声明口径一致')
  assert.equal(r.truncated, false)
  assert.equal(r.dropped, 0)

  // 只留一种 kind → 只有一个小节
  const onlyRule = setup(t)
  seed(onlyRule.svc, { kind: 'rule' })
  const r2 = onlyRule.svc.renderDisciplinePrompt({})
  assert.ok(r2.text.includes('## 纪律'))
  assert.ok(!r2.text.includes('## 要求') && !r2.text.includes('## 风格'))
})

test('render：tokenBudget 超出 → 从低优先级丢、truncated=true、末尾加省略提示、tokens≤预算', (t) => {
  const { svc } = setup(t)
  for (let i = 1; i <= 4; i += 1) {
    seed(svc, {
      scope: 'global',
      kind: 'rule',
      title: `T${i}`,
      content: 'x'.repeat(800), // 每条 ~200 token，4 条远超预算
      priority: i * 10,
    })
  }
  const full = svc.resolveDisciplines({})
  assert.equal(full.items.length, 4)
  assert.deepEqual(full.items.map((d) => d.priority), [40, 30, 20, 10])

  // 预算 = 全量 - 150：至少必须丢一条，且不会全丢光
  const budget = estimate(full.text) - 150
  const r = svc.renderDisciplinePrompt({ tokenBudget: budget })
  assert.equal(r.truncated, true)
  assert.ok(r.items.length > 0 && r.items.length < 4, `应保留部分条目，实际 ${r.items.length}`)
  assert.ok(r.tokens <= budget, `tokens=${r.tokens} 应 ≤ budget=${budget}`)
  assert.ok(r.dropped >= 1)
  // 保留的必须是排序前缀（高优先级优先保留）
  assert.deepEqual(r.items.map((d) => d.priority), [40, 30, 20, 10].slice(0, r.items.length))
  // 末尾提示的 N 与丢弃数一致
  const omitted = 4 - r.items.length
  assert.ok(r.text.endsWith(`⚠️ 已省略 ${omitted} 条（超出预算）`), r.text.slice(-80))
  assert.equal(r.dropped, omitted)
})

test('render：预算可容纳 → truncated=false 且不加提示', (t) => {
  const { svc } = setup(t)
  seed(svc, { title: 'A', content: 'aaa' })
  const base = svc.renderDisciplinePrompt({})
  const r = svc.renderDisciplinePrompt({ tokenBudget: base.tokens + 100 })
  assert.equal(r.truncated, false)
  assert.equal(r.dropped, 0)
  assert.ok(!r.text.includes('已省略'))
  assert.equal(r.tokens, base.tokens)
})

test('render：预算连提示行都装不下时仍返回省略提示（不静默伪装成「无纪律」）', (t) => {
  const { svc } = setup(t)
  seed(svc, { title: 'A', content: 'a'.repeat(400) })
  const r = svc.renderDisciplinePrompt({ tokenBudget: 3 })
  assert.equal(r.truncated, true)
  assert.equal(r.items.length, 0)
  assert.equal(r.dropped, 1)
  assert.equal(r.text, '⚠️ 已省略 1 条（超出预算）')
})

// ── 8. import：三种 mode + 去重 + 单条失败不中断 ───────────────────────────

test('import(skip)：库内与批内同 scope+scopeId+title 都跳过，其余创建', (t) => {
  const { svc } = setup(t)
  seed(svc, { scope: 'global', kind: 'rule', title: '既有', content: 'old' })

  const result = svc.importDisciplines({
    by: 'lead',
    mode: 'skip',
    items: [
      { scope: 'global', kind: 'rule', title: '既有', content: 'new' }, // 与库内重复
      { scope: 'global', kind: 'rule', title: '新增', content: 'n1' },
      { scope: 'global', kind: 'rule', title: '新增', content: 'n2' }, // 批内重复
    ],
  })

  assert.equal(result.created.length, 1)
  assert.equal(result.created[0].title, '新增')
  assert.equal(result.updated.length, 0)
  assert.equal(result.skipped.length, 2)
  assert.equal(result.skipped[0].reason, 'duplicate')
  assert.equal(result.skipped[0].id, 'd-1')
  assert.equal(result.errors.length, 0)
  // 跳过不能覆盖原内容
  assert.equal(svc.getDiscipline('d-1').content, 'old')
  assert.equal(svc.listDisciplines().length, 2)
})

test('import(overwrite)：同键条目被覆盖（rev+1、内容替换、createdAt 保留）', (t) => {
  const { svc } = setup(t)
  const d = seed(svc, { scope: 'bot', scopeId: 'bot-1', kind: 'rule', title: '规范', content: 'v1', now: 1_700_000_000_000 })

  const result = svc.importDisciplines({
    by: 'importer',
    mode: 'overwrite',
    now: 1_700_000_500_000,
    items: [
      { scope: 'bot', scopeId: 'bot-1', kind: 'requirement', title: '规范', content: 'v2', priority: 7 },
    ],
  })

  assert.equal(result.created.length, 0)
  assert.equal(result.updated.length, 1)
  assert.equal(result.skipped.length, 0)
  const got = svc.getDiscipline(d.id)
  assert.equal(got.rev, 2)
  assert.equal(got.content, 'v2')
  assert.equal(got.kind, 'requirement')
  assert.equal(got.priority, 7)
  assert.equal(got.createdAt, 1_700_000_000_000)
  assert.equal(got.updatedAt, 1_700_000_500_000)
  assert.equal(got.updatedBy, 'importer')
})

test('import(rename)：同键条目改名为「标题 (2)」后创建，原条目不动', (t) => {
  const { svc } = setup(t)
  const d = seed(svc, { scope: 'global', kind: 'rule', title: '命名', content: 'first' })

  const result = svc.importDisciplines({
    by: 'lead',
    mode: 'rename',
    items: [
      { scope: 'global', kind: 'rule', title: '命名', content: 'second' },
      { scope: 'global', kind: 'rule', title: '命名', content: 'third' },
    ],
  })

  assert.equal(result.created.length, 2)
  assert.deepEqual(result.created.map((x) => x.title), ['命名 (2)', '命名 (3)'])
  assert.equal(result.errors.length, 0)
  assert.equal(svc.getDiscipline(d.id).content, 'first')
  assert.equal(svc.listDisciplines().length, 3)
})

test('import：单条非法不中断整批（进 errors[]，其余照常创建）', (t) => {
  const { svc } = setup(t)
  const result = svc.importDisciplines({
    by: 'lead',
    items: [
      { scope: 'global', kind: 'rule', title: '好的1', content: 'c1' },
      { scope: 'galaxy', kind: 'rule', title: '坏 scope', content: 'c2' },
      { scope: 'global', kind: 'oops', title: '坏 kind', content: 'c3' },
      { scope: 'global', kind: 'rule', title: '缺正文' },
      { scope: 'bot', scopeId: 'bot-9', kind: 'style', title: '好的2', content: 'c4' },
    ],
  })

  assert.equal(result.created.length, 2)
  assert.equal(result.errors.length, 3)
  assert.deepEqual(result.errors.map((e) => e.index), [1, 2, 3])
  assert.ok(result.errors.every((e) => typeof e.reason === 'string' && e.reason.length > 0))
  assert.equal(result.errors[0].code, 'DISCIPLINE_BAD_SCOPE')
  assert.equal(svc.listDisciplines().length, 2)
})

test('import：非法 mode / 非数组 items 直接抛错（参数错误不许静默兜底）', (t) => {
  const { svc } = setup(t)
  assert.throws(() => svc.importDisciplines({ items: [], by: 'lead', mode: 'merge' }),
    (e) => e.code === 'DISCIPLINE_BAD_MODE')
  assert.throws(() => svc.importDisciplines({ items: 'nope', by: 'lead' }),
    (e) => e.code === 'DISCIPLINE_BAD_ITEMS')
  assert.throws(() => svc.importDisciplines({ items: [], by: '' }),
    (e) => e.code === 'DISCIPLINE_MISSING_FIELD')
  // mode 不传 / 传 null（UI 表单空值）等价于缺省 skip
  assert.deepEqual(
    svc.importDisciplines({ items: [], by: 'lead', mode: null }),
    { created: [], updated: [], skipped: [], errors: [] },
  )
})

// ── 9. replay / 重启恢复 ───────────────────────────────────────────────────

test('replay：create/update/remove 后从 jsonl 完整重建（内容、rev、事件流）', (t) => {
  const { dir, svc } = setup(t)
  const d1 = seed(svc, { title: 'A', content: 'v1', now: 1_700_000_000_000 })
  svc.updateDiscipline({ id: d1.id, expectedRev: 1, content: 'v2', by: 'r', now: 1_700_000_001_000 })
  const d2 = seed(svc, { title: 'B', content: 'b1' })
  svc.removeDiscipline({ id: d2.id, expectedRev: 1, by: 'lead' })

  const out = svc.replay()
  assert.equal(out.from, 'jsonl')
  assert.equal(out.disciplines, 1)
  assert.equal(out.events, 4, 'create+update+create+remove 共 4 条事件')
  assert.equal(out.bad, 0)
  assert.equal(svc.getDiscipline(d1.id).content, 'v2')
  assert.equal(svc.getDiscipline(d1.id).rev, 2)
  assert.equal(svc.getDiscipline(d2.id), undefined)
  assert.equal(svc.history(d1.id).length, 2)
  assert.equal(svc.history(d2.id).length, 2)
})

test('replay：重启（新实例同 stateDir）从 jsonl 恢复，id 继续单调递增', (t) => {
  const { dir, svc } = setup(t)
  seed(svc, { title: 'A', now: 1_700_000_000_000 })
  seed(svc, { title: 'B', now: 1_700_000_000_001 })
  const before = svc.listDisciplines()

  const svc2 = createDiscipline({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.deepEqual(svc2.listDisciplines(), before, '重启后数据必须逐字段一致')
  const d3 = svc2.createDiscipline({ scope: 'global', kind: 'rule', title: 'C', content: 'c', by: 'lead' })
  assert.equal(d3.id, 'd-3', 'id 计数器不能回退')
})

test('replay：事件流为空时从快照恢复（快照回退路径）', (t) => {
  const { dir, svc } = setup(t)
  seed(svc, { title: '快照条目1' })
  seed(svc, { title: '快照条目2' })
  // 模拟事件流丢失（例如被误删），只剩快照
  rmSync(join(dir, 'discipline.jsonl'), { force: true })

  const svc2 = createDiscipline({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(svc2.listDisciplines().length, 2)
  assert.deepEqual(svc2.listDisciplines().map((d) => d.title), ['快照条目1', '快照条目2'])
  assert.equal(svc2.diagnostics().hydratedFrom, 'snapshot')
})

test('replay：坏行不静默——计入 bad 并告警，其余行照常恢复', (t) => {
  const { dir, svc } = setup(t)
  seed(svc, { title: 'A' })
  appendFileSync(join(dir, 'discipline.jsonl'), '{坏行不是JSON}\n')
  seed(svc, { title: 'B' })

  const out = svc.replay()
  assert.equal(out.bad, 1)
  assert.equal(out.disciplines, 2, '坏行之后的合法事件仍要恢复')
})

// ── 10. stats / history / dispose ─────────────────────────────────────────

test('stats：total/enabled/disabled/byScope/byKind/events 全部有数', (t) => {
  const { svc } = setup(t)
  seed(svc, { scope: 'global', kind: 'rule', title: 'G' })
  seed(svc, { scope: 'workspace', scopeId: '/tmp/ws-a', kind: 'requirement', title: 'W', enabled: false })
  seed(svc, { scope: 'room', scopeId: 'room-1', kind: 'style', title: 'R' })

  const s = svc.stats()
  assert.equal(s.total, 3)
  assert.equal(s.enabled, 2)
  assert.equal(s.disabled, 1)
  assert.deepEqual(s.byScope, { global: 1, workspace: 1, room: 1, bot: 0 })
  assert.deepEqual(s.byKind, { rule: 1, requirement: 1, principle: 0, style: 1 })
  assert.equal(s.events, 3)
  assert.equal(s.idCounter, 3)
})

test('history：全量事件按落盘顺序；按 id 过滤；未知 id 返回空数组', (t) => {
  const { svc } = setup(t)
  const d = seed(svc, { title: 'A' })
  svc.updateDiscipline({ id: d.id, expectedRev: 1, title: 'A2', by: 'r' })
  seed(svc, { title: 'B' })

  assert.equal(svc.history().length, 3)
  assert.deepEqual(svc.history().map((e) => e.action), ['create', 'update', 'create'])
  assert.equal(svc.history(d.id).length, 2)
  assert.deepEqual(svc.history(d.id).map((e) => e.rev), [1, 2])
  assert.deepEqual(svc.history('d-999'), [])
  // 返回克隆：改它不影响内部审计流
  svc.history()[0].action = 'hacked'
  assert.equal(svc.history()[0].action, 'create')
})

test('dispose：返回计数、清内存；之后所有方法抛 DISCIPLINE_DISPOSED（不静默返回空）', (t) => {
  const { svc } = setup(t)
  seed(svc, { title: 'A' })
  const out = svc.dispose()
  assert.deepEqual(out, { disposed: true, disciplines: 1, events: 1 })
  assert.throws(() => svc.createDiscipline({ scope: 'global', kind: 'rule', title: 'x', content: 'c', by: 'lead' }),
    (e) => e.code === 'DISCIPLINE_DISPOSED')
  assert.throws(() => svc.listDisciplines(), (e) => e.code === 'DISCIPLINE_DISPOSED')
  assert.throws(() => svc.getDiscipline('d-1'), (e) => e.code === 'DISCIPLINE_DISPOSED')
  assert.throws(() => svc.resolveDisciplines({}), (e) => e.code === 'DISCIPLINE_DISPOSED')
  assert.throws(() => svc.renderDisciplinePrompt({}), (e) => e.code === 'DISCIPLINE_DISPOSED')
  assert.throws(() => svc.stats(), (e) => e.code === 'DISCIPLINE_DISPOSED')
  assert.throws(() => svc.replay(), (e) => e.code === 'DISCIPLINE_DISPOSED')
  // dispose 幂等（重复调用不抛）
  assert.equal(svc.dispose().disposed, true)
})

test('操作者字段：契约名 by 与 board 风格别名 byId 都接受（api/tools 混用不假失败）', (t) => {
  const { svc } = setup(t)
  const a = svc.createDiscipline({ scope: 'global', kind: 'rule', title: 'A', content: 'a', byId: 'lead' })
  assert.equal(a.createdBy, 'lead')
  const b = svc.updateDiscipline({ id: a.id, expectedRev: 1, content: 'a2', byId: 'reviewer' })
  assert.equal(b.updatedBy, 'reviewer')
  const r = svc.importDisciplines({
    items: [{ scope: 'global', kind: 'rule', title: 'B', content: 'b' }],
    byId: 'importer',
  })
  assert.equal(r.created[0].createdBy, 'importer')
  assert.deepEqual(svc.removeDiscipline({ id: a.id, expectedRev: b.rev, byId: 'lead' }), { removed: a.id })
})

test('集成形态：模拟 api.js 调用（qp() 空值 / 数字字符串 / mode 空串）不假失败，坏值仍抛错', (t) => {
  const { svc } = setup(t)
  // POST /disciplines：UI 数字输入框把 priority 序列化成 "7"
  const created = svc.createDiscipline({
    scope: 'global', kind: 'rule', title: 'UI 条目', content: 'c', priority: '7', by: 'user',
  })
  assert.equal(created.priority, 7)

  // GET /disciplines：qp() 缺省是 undefined；清空下拉框可能是 ''
  assert.equal(svc.listDisciplines({
    scope: undefined, scopeId: undefined, kind: undefined, query: undefined, enabled: undefined,
  }).length, 1)
  assert.equal(svc.listDisciplines({ scope: '', scopeId: '', kind: '', query: '' }).length, 1)
  // 放宽空值不等于放过坏值
  assert.throws(() => svc.listDisciplines({ scope: 'galaxy' }), (e) => e.code === 'DISCIPLINE_BAD_SCOPE')

  // POST /disciplines/import：mode 传 ''（下拉框未选）等价缺省 skip
  const imp = svc.importDisciplines({
    items: [{ scope: 'global', kind: 'rule', title: '导入的', content: 'x' }], mode: '', by: 'user',
  })
  assert.equal(imp.created.length, 1)

  // GET /disciplines/resolve + /preview：qp() 缺省全 undefined
  const r = svc.resolveDisciplines({ botId: undefined, cwd: undefined, roomId: undefined })
  assert.equal(r.items.length, 2)
  const p = svc.renderDisciplinePrompt({ botId: undefined, cwd: undefined, roomId: undefined, tokenBudget: undefined })
  assert.equal(p.tokens, estimate(p.text))
})

test('service：短别名与契约函数名指向同一实现（api/tools 层两种风格都能调）', (t) => {
  const { svc } = setup(t)
  assert.equal(svc.create, svc.createDiscipline)
  assert.equal(svc.get, svc.getDiscipline)
  assert.equal(svc.list, svc.listDisciplines)
  assert.equal(svc.update, svc.updateDiscipline)
  assert.equal(svc.remove, svc.removeDiscipline)
  assert.equal(svc.import, svc.importDisciplines)
  assert.equal(svc.resolve, svc.resolveDisciplines)
  assert.equal(svc.render, svc.renderDisciplinePrompt)
  // paths 冻结（防止外部改路径后写错文件）
  assert.ok(Object.isFrozen(svc.paths))
  assert.equal(svc.paths.jsonl, join(svc.paths.stateDir, 'discipline.jsonl'))
})
