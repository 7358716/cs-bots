/**
 * TodoService 测试 —— 四轨待办（ANALYSIS-memory-evolve-parity #10）。
 *
 * 纪律（与 discipline/board 测试一致）：每条断言都用**真实返回值**或**实际落盘产物**
 * 做证据，不接受「函数没抛错」这种弱断言。
 * 只碰 `node:test` + `node:assert` + `node:fs` + `node:os` + `node:path`。
 *
 * 运行：`node --test test/todo.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createTodo, {
  TodoError,
  TRACKS,
  STATUSES,
  QUADRANTS,
  LIMITS,
  SMART_VIEW_LIMIT,
  ACTIVE_STATUSES,
  localDate,
} from '../src/todo.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0
const BY = 'lead'

/**
 * 每个用例一个独立状态目录（互不污染）。
 * 目录优先放 `TODO_TEST_TMPDIR`（沙箱受限时可指定到工作区内），否则走系统临时目录。
 */
function setup(t) {
  const base = process.env.TODO_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-todo-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const svc = createTodo({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  return { dir, svc }
}

/** 建一条待办（省去样板，缺省 life 轨）。 */
function add(svc, over = {}) {
  return svc.createTodo({ track: 'life', content: '待办事项', by: BY, ...over })
}

/** 读事件流（真相源）。 */
function events(dir) {
  const file = join(dir, 'todo.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 断言抛出 TodoError 且 code 精确匹配。 */
function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TodoError, `期望 TodoError，实际是 ${error?.name}: ${error?.message}`)
    assert.equal(error.code, code, `期望 code=${code}，实际 code=${error.code}（${error.message}）`)
    return true
  })
}

/** 相对今天偏移 N 天的 YYYY-MM-DD（本地时区；不用 toISOString 以免 UTC 偏移）。 */
function dateOffset(days, base = Date.now()) {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return localDate(d.getTime())
}

/** 今天（本地日历日）。 */
function today() {
  return localDate()
}

// ── 1. 四轨 CRUD ────────────────────────────────────────────────────────────

test('四轨 CRUD：life/work/project/daily 都能创建、读取、更新、删除', (t) => {
  const { svc } = setup(t)

  const life = svc.createTodo({ track: 'life', content: '交水电费', due: '2026-12-01', cat: '生活', by: BY })
  const work = svc.createTodo({ track: 'work', content: '写周报', important: true, by: BY })
  const project = svc.createTodo({ track: 'project', cwd: '/work/proj-a', content: '修登录 bug', urgent: true, by: BY })
  const daily = svc.createTodo({ track: 'daily', content: '晨跑', by: BY })

  // id 形如 td-xxxxxxxx（8 位 hex）
  assert.match(life.id, /^td-[0-9a-f]{8}$/)
  // 四轨齐全（TRACKS 就是契约字面量）
  assert.deepEqual(TRACKS, ['life', 'work', 'project', 'daily'])
  assert.equal(life.track, 'life')
  assert.equal(life.rev, 1)
  assert.equal(life.cwd, null)
  assert.equal(life.date, null)
  assert.equal(life.quadrant, 'q4')
  assert.equal(life.important, false)
  assert.equal(life.urgent, false)
  assert.equal(life.status, 'pending')
  assert.equal(life.doneAt, null)
  assert.equal(life.createdBy, BY)
  assert.equal(life.updatedBy, BY)
  assert.equal(life.due, '2026-12-01')
  assert.equal(life.cat, '生活')

  assert.equal(project.cwd, '/work/proj-a') // project 轨带 cwd
  assert.equal(project.date, null)
  assert.equal(daily.date, today()) // daily 缺省 = 今天
  assert.equal(daily.cwd, null)

  // 读取
  assert.deepEqual(svc.getTodo(life.id), life)
  assert.equal(svc.getTodo(work.id).content, '写周报')
  assert.equal(svc.getTodo(project.id).track, 'project')
  assert.equal(svc.getTodo(daily.id).track, 'daily')

  // 更新
  const updated = svc.updateTodo({ id: life.id, expectedRev: 1, content: '交水电费（已交）', by: 'bot-1', now: 5000 })
  assert.equal(updated.rev, 2)
  assert.equal(updated.content, '交水电费（已交）')
  assert.equal(updated.updatedBy, 'bot-1')
  assert.equal(updated.updatedAt, 5000)
  assert.equal(updated.createdAt, life.createdAt) // 创建时间不被更新改写

  // 删除（硬删）
  const removed = svc.removeTodo({ id: work.id, expectedRev: 1, by: BY })
  assert.deepEqual(removed, { id: work.id, rev: 2, removed: true })
  assert.equal(svc.getTodo(work.id), null)

  // 剩下 3 条；不带 cwd 时 project 轨按隔离规则不出现（只剩 life + daily）
  const all = svc.listTodos({ all: true })
  assert.equal(all.items.length, 2)
  assert.deepEqual(all.items.map((x) => x.track).sort(), ['daily', 'life'])
  // 带上 cwd 才看得到项目轨
  assert.equal(svc.listTodos({ all: true, cwd: '/work/proj-a' }).items.length, 3)
  assert.deepEqual(STATUSES, ['pending', 'doing', 'done', 'blocked', 'cancelled'])
  assert.deepEqual(QUADRANTS, ['q1', 'q2', 'q3', 'q4'])
  assert.deepEqual(ACTIVE_STATUSES, ['pending', 'doing', 'blocked'])
})

test('createTodo({ stateDir }) 简写与 (ctx, config) 双参写法等价', (t) => {
  const { dir } = setup(t)
  // 只传一个带 stateDir 的对象（splitArgs 的简写路径）
  const shorthand = createTodo({ stateDir: dir, name: 'shortcut' })
  assert.equal(shorthand.name, 'shortcut')
  const created = shorthand.createTodo({ track: 'life', content: '简写创建', by: BY })
  assert.equal(created.track, 'life')

  // 双参写法能读到同一份状态
  const normal = createTodo({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(normal.getTodo(created.id).content, '简写创建')
  assert.equal(normal.diagnostics().hydratedFrom, 'jsonl')
})

// ── 2. CAS ──────────────────────────────────────────────────────────────────

test('CAS：rev 不匹配 / 缺 expectedRev 一律抛错，且状态不被改写', (t) => {
  const { svc } = setup(t)
  const todo = add(svc, { content: '原始内容' })

  // rev 不匹配
  throwsCode(() => svc.updateTodo({ id: todo.id, expectedRev: 0, content: '越权覆盖', by: BY }), 'TODO_REV_CONFLICT')
  assert.equal(svc.getTodo(todo.id).rev, 1)
  assert.equal(svc.getTodo(todo.id).content, '原始内容')

  // 完全不给 expectedRev（不允许"省略即覆盖"）
  throwsCode(() => svc.updateTodo({ id: todo.id, content: '偷偷覆盖', by: BY }), 'TODO_MISSING_EXPECTED_REV')
  assert.equal(svc.getTodo(todo.id).content, '原始内容')

  // 删除同样受 CAS 保护
  throwsCode(() => svc.removeTodo({ id: todo.id, expectedRev: 7, by: BY }), 'TODO_REV_CONFLICT')
  assert.notEqual(svc.getTodo(todo.id), null)

  // 正确 rev 才能更新/删除
  const updated = svc.updateTodo({ id: todo.id, expectedRev: 1, content: '新内容', by: BY })
  assert.equal(updated.rev, 2)
  assert.equal(svc.getTodo(todo.id).content, '新内容')
  assert.deepEqual(svc.removeTodo({ id: todo.id, expectedRev: 2, by: BY }), { id: todo.id, rev: 3, removed: true })
  assert.equal(svc.getTodo(todo.id), null)
})

// ── 3. 四象限 ───────────────────────────────────────────────────────────────

test('四象限推导：只给布尔推出象限，只给 quadrant 反推布尔', (t) => {
  const { svc } = setup(t)
  const none = add(svc, { content: '都不' })
  assert.equal(none.quadrant, 'q4')
  assert.equal(none.important, false)
  assert.equal(none.urgent, false)

  const importantOnly = add(svc, { content: '重要不紧急', important: true })
  assert.equal(importantOnly.quadrant, 'q2')
  assert.equal(importantOnly.important, true)
  assert.equal(importantOnly.urgent, false)

  const urgentOnly = add(svc, { content: '紧急不重要', urgent: true })
  assert.equal(urgentOnly.quadrant, 'q3')

  const both = add(svc, { content: '重要且紧急', important: true, urgent: true })
  assert.equal(both.quadrant, 'q1')

  // 只给 quadrant：布尔必须被反推出来，否则 UI 色块与文字会对不上
  const fromQ1 = add(svc, { content: '由 q1 反推', quadrant: 'q1' })
  assert.equal(fromQ1.important, true)
  assert.equal(fromQ1.urgent, true)
  const fromQ3 = add(svc, { content: '由 q3 反推', quadrant: 'q3' })
  assert.equal(fromQ3.important, false)
  assert.equal(fromQ3.urgent, true)
})

test('四象限冲突：quadrant 与 important/urgent 矛盾时抛 TODO_QUADRANT_CONFLICT', (t) => {
  const { svc } = setup(t)
  throwsCode(
    () => add(svc, { content: '矛盾1', quadrant: 'q1', important: false }),
    'TODO_QUADRANT_CONFLICT',
  )
  throwsCode(
    () => add(svc, { content: '矛盾2', quadrant: 'q3', urgent: false }),
    'TODO_QUADRANT_CONFLICT',
  )
  throwsCode(
    () => add(svc, { content: '非法象限', quadrant: 'q9' }),
    'TODO_BAD_QUADRANT',
  )
})

test('update 四象限联动：q2 加 urgent → q1，q1 去 important → q3', (t) => {
  const { svc } = setup(t)
  const todo = add(svc, { content: '联动', important: true })
  assert.equal(todo.quadrant, 'q2')

  const urgentNow = svc.updateTodo({ id: todo.id, expectedRev: 1, urgent: true, by: BY })
  assert.equal(urgentNow.quadrant, 'q1')
  assert.equal(urgentNow.important, true)
  assert.equal(urgentNow.urgent, true)

  const notImportant = svc.updateTodo({ id: todo.id, expectedRev: 2, important: false, by: BY })
  assert.equal(notImportant.quadrant, 'q3')
  assert.equal(notImportant.important, false)
  assert.equal(notImportant.urgent, true)

  // 显式改 quadrant 也要同步布尔
  const q4 = svc.updateTodo({ id: todo.id, expectedRev: 3, quadrant: 'q4', by: BY })
  assert.equal(q4.important, false)
  assert.equal(q4.urgent, false)
})

// ── 4. 日期 / 逾期 ──────────────────────────────────────────────────────────

test('due 逾期判定：due<今天=逾期、due=今天=今日到期、无 due 不算', (t) => {
  const { svc } = setup(t)
  const overdue = add(svc, { content: '逾期项', due: dateOffset(-1) })
  const dueToday = add(svc, { content: '今日到期', due: dateOffset(0) })
  add(svc, { content: '无截止' })

  const s = svc.stats()
  assert.equal(s.overdue, 1)
  assert.equal(s.dueToday, 1)
  assert.equal(s.active, 3)

  // 智能视图：逾期排最前，今日到期第二；无 due 的 q4 琐事不进智能视图
  const view = svc.listTodos()
  assert.equal(view.items.length, 2)
  assert.equal(view.items[0].id, overdue.id)
  assert.equal(view.items[1].id, dueToday.id)

  // 显式按状态查则三条都在
  assert.equal(svc.listTodos({ status: 'pending' }).items.length, 3)
})

test('非法日期/状态/超长字段在入口拒绝，且失败不落事件流', (t) => {
  const { svc, dir } = setup(t)
  throwsCode(() => add(svc, { content: '假日期', due: '2026-02-30' }), 'TODO_BAD_DATE')
  throwsCode(() => add(svc, { content: '斜杠日期', due: '2026/02/01' }), 'TODO_BAD_DATE')
  throwsCode(() => add(svc, { content: '非法状态', status: 'archived' }), 'TODO_BAD_STATUS')
  // 空串/'all' 不是合法 status：不许被悄悄当成"没给"（create 与 update 都要拒绝）
  throwsCode(() => add(svc, { content: '空状态', status: '' }), 'TODO_BAD_STATUS')
  throwsCode(() => add(svc, { content: 'all 不是状态', status: 'all' }), 'TODO_BAD_STATUS')
  throwsCode(() => add(svc, { content: '   ' }), 'TODO_MISSING_FIELD')
  throwsCode(() => add(svc, { content: 'x'.repeat(LIMITS.content + 1) }), 'TODO_CONTENT_TOO_LONG')
  throwsCode(() => add(svc, { content: '分类超长', cat: 'x'.repeat(LIMITS.cat + 1) }), 'TODO_CAT_TOO_LONG')
  throwsCode(() => add(svc, { content: '非法轨', track: 'home' }), 'TODO_BAD_TRACK')
  throwsCode(() => add(svc, { content: '非法 track 类型', track: 123 }), 'TODO_BAD_TRACK')
  throwsCode(() => svc.createTodo({ content: '缺 track', by: BY }), 'TODO_MISSING_FIELD')
  throwsCode(() => svc.createTodo({ track: 'life', content: '缺 by' }), 'TODO_MISSING_FIELD')

  // 全部失败 → 没有任何幽灵条目/事件
  assert.equal(svc.listTodos({ all: true }).items.length, 0)
  assert.equal(events(dir).length, 0)
})

// ── 5. 轨绑定 ───────────────────────────────────────────────────────────────

test('轨绑定：project 必须 cwd、daily 缺省今天、非 daily 拒绝 date/cwd', (t) => {
  const { svc } = setup(t)

  throwsCode(() => add(svc, { track: 'project', content: '无 cwd 项目待办' }), 'TODO_CWD_REQUIRED')
  throwsCode(() => add(svc, { track: 'life', content: 'life 带 cwd', cwd: '/x' }), 'TODO_BAD_FIELD')
  throwsCode(() => add(svc, { track: 'work', content: 'work 带 date', date: '2026-01-01' }), 'TODO_BAD_FIELD')
  throwsCode(() => add(svc, { track: 'daily', content: 'daily 带 cwd', cwd: '/x' }), 'TODO_BAD_FIELD')

  // daily 缺省今天；显式 date 生效
  const daily = add(svc, { track: 'daily', content: '今天' })
  assert.equal(daily.date, today())
  const yesterday = dateOffset(-1)
  const dailyPast = add(svc, { track: 'daily', content: '昨天', date: yesterday })
  assert.equal(dailyPast.date, yesterday)

  // project cwd 归一：尾部分隔符 / 相对路径归一后存同一把隔离键
  const project = add(svc, { track: 'project', content: '项目项', cwd: '/work/proj-a/' })
  assert.equal(project.cwd, '/work/proj-a')

  // 换轨自动清空旧轨专属字段
  const nowWork = svc.updateTodo({ id: project.id, expectedRev: 1, track: 'work', by: BY })
  assert.equal(nowWork.track, 'work')
  assert.equal(nowWork.cwd, null)
  const nowDaily = svc.updateTodo({ id: nowWork.id, expectedRev: 2, track: 'daily', by: BY })
  assert.equal(nowDaily.date, today())
  assert.equal(nowDaily.cwd, null)
  const backToProject = svc.updateTodo({ id: nowDaily.id, expectedRev: 3, track: 'project', cwd: '/work/proj-b', by: BY })
  assert.equal(backToProject.cwd, '/work/proj-b')
  assert.equal(backToProject.date, null)

  // life → project 却没给 cwd：必须报错，不能猜
  const life = add(svc, { content: '普通生活待办' })
  throwsCode(() => svc.updateTodo({ id: life.id, expectedRev: 1, track: 'project', by: BY }), 'TODO_CWD_REQUIRED')
})

// ── 6. doneAt ───────────────────────────────────────────────────────────────

test('done 自动盖 doneAt：进入 done 盖戳、离开 done 清空、重复 done 不改旧戳', (t) => {
  const { svc } = setup(t)
  const todo = svc.createTodo({ track: 'life', content: '完成时间', by: BY, now: 1000 })
  assert.equal(todo.status, 'pending')
  assert.equal(todo.doneAt, null)

  const doing = svc.updateTodo({ id: todo.id, expectedRev: 1, status: 'doing', by: BY, now: 2000 })
  assert.equal(doing.status, 'doing')
  assert.equal(doing.doneAt, null)

  const done = svc.updateTodo({ id: todo.id, expectedRev: 2, status: 'done', by: BY, now: 3000 })
  assert.equal(done.status, 'done')
  assert.equal(done.doneAt, 3000) // 自动盖戳，时间取本次操作时间

  const reopened = svc.updateTodo({ id: todo.id, expectedRev: 3, status: 'doing', by: BY, now: 4000 })
  assert.equal(reopened.doneAt, null) // 离开 done 清空

  // 创建即 done 也要盖章
  const bornDone = svc.createTodo({ track: 'daily', content: '出生即完成', status: 'done', by: BY, now: 5000 })
  assert.equal(bornDone.doneAt, 5000)

  // 已经是 done 再显式置 done：不刷新旧戳（否则"完成时间"会随调用漂移）
  const again = svc.updateTodo({ id: bornDone.id, expectedRev: 1, status: 'done', by: BY, now: 6000 })
  assert.equal(again.doneAt, 5000)

  // 取消也算"离开 done"的一种
  const maybe = svc.createTodo({ track: 'life', content: '可能取消', by: BY })
  svc.updateTodo({ id: maybe.id, expectedRev: 1, status: 'done', by: BY, now: 7000 })
  const cancelled = svc.updateTodo({ id: maybe.id, expectedRev: 2, status: 'cancelled', by: BY, now: 8000 })
  assert.equal(cancelled.doneAt, null)
})

// ── 7. 删除与审计 ───────────────────────────────────────────────────────────

test('removeTodo 硬删但事件流保留 before 快照，history 可追溯', (t) => {
  const { svc, dir } = setup(t)
  const todo = add(svc, { content: '要删除的' })
  svc.removeTodo({ id: todo.id, expectedRev: 1, by: 'bot-9' })

  assert.equal(svc.getTodo(todo.id), null)
  const rows = events(dir)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].action, 'remove')
  assert.equal(rows[1].byId, 'bot-9')
  assert.equal(rows[1].after, null)
  assert.equal(rows[1].before.content, '要删除的') // 删除后仍可审计原始内容

  const h = svc.history(todo.id)
  assert.deepEqual(h.map((e) => e.action), ['create', 'remove'])
  assert.deepEqual(h.map((e) => e.rev), [1, 2])
  assert.equal(svc.history().length, 2) // 不传 id = 全量
})

// ── 8. 智能视图 ─────────────────────────────────────────────────────────────

test('智能视图：只列需要关注项 + 优先级排序 + 8 条上限', (t) => {
  const { svc } = setup(t)
  const now = Date.now()
  const day = (n) => dateOffset(n, now)

  // 5 条逾期（due 从早到晚，便于断言排序）
  const overdue = []
  for (let i = 5; i >= 1; i -= 1) {
    overdue.push(add(svc, { content: `逾期${i}`, due: day(-i) }))
  }
  const dueToday = add(svc, { content: '今日到期', due: day(0) })
  const project = add(svc, { track: 'project', cwd: '/proj/view', content: '本项目未完成', quadrant: 'q3' })
  const q1 = add(svc, { content: '重要紧急', quadrant: 'q1' })
  const q2 = add(svc, { content: '重要不紧急', quadrant: 'q2' })
  const daily = add(svc, { track: 'daily', content: '今日每日待办' })
  // 不该进智能视图的两条：非重要非紧急且无截止
  const noiseQ3 = add(svc, { content: '琐事q3', quadrant: 'q3' })
  const noiseQ4 = add(svc, { content: '琐事q4', quadrant: 'q4' })

  const view = svc.listTodos({ cwd: '/proj/view', now })
  assert.equal(view.defaultView, true)
  assert.equal(view.total, 10) // 5 逾期 + 今日 + 项目 + q1 + q2 + 今日每日
  assert.equal(view.items.length, SMART_VIEW_LIMIT) // 硬上限 8
  assert.equal(view.truncated, true)

  // 逾期最前，且按 due 升序（早的在前）
  assert.deepEqual(view.items.slice(0, 5).map((x) => x.id), overdue.map((x) => x.id))
  assert.equal(view.items[5].id, dueToday.id)
  // 本项目（cwd 匹配）排在重要紧急之前
  assert.equal(view.items[6].id, project.id)
  assert.equal(view.items[7].id, q1.id)
  // 被截断的 q2/每日待办不出现；噪音项根本不参与
  assert.ok(!view.items.some((x) => x.id === q2.id))
  assert.ok(!view.items.some((x) => x.id === daily.id))
  assert.ok(!view.items.some((x) => x.id === noiseQ3.id))
  assert.ok(!view.items.some((x) => x.id === noiseQ4.id))

  // 显式 limit 只能再收紧，不能突破 8 条上限
  assert.equal(svc.listTodos({ cwd: '/proj/view', now, limit: 3 }).items.length, 3)
  // all:true 看全部（12 条），不受智能视图过滤与上限约束
  const all = svc.listTodos({ all: true, cwd: '/proj/view', now })
  assert.equal(all.defaultView, false)
  assert.equal(all.items.length, 12)
})

test('all:true 关掉智能过滤；默认视图把无截止的 q4 琐事挡在外面', (t) => {
  const { svc } = setup(t)
  for (let i = 0; i < 12; i += 1) {
    add(svc, { content: `琐事${i}` })
  }
  assert.equal(svc.listTodos({ all: true }).items.length, 12)
  assert.equal(svc.listTodos().items.length, 0) // 全是不需要关注的项
  assert.equal(svc.listTodos().defaultView, true)
})

// ── 9. past / expired（真实踩坑点）──────────────────────────────────────────

test('past/expired：过往每日待办默认隐藏，只带 past 会漏掉未完成遗留', (t) => {
  const { svc } = setup(t)
  const yesterday = dateOffset(-1)
  const twoDaysAgo = dateOffset(-2)

  const todayItem = add(svc, { track: 'daily', content: '今天要做' })
  const leftYesterday = add(svc, { track: 'daily', content: '昨天没做完', date: yesterday })
  const doneYesterday = add(svc, { track: 'daily', content: '昨天做完', date: yesterday, status: 'done' })
  const leftTwoDays = add(svc, { track: 'daily', content: '前天没做完', date: twoDaysAgo })

  // 默认：历史整体不可见，只剩今天
  const def = svc.listTodos()
  assert.deepEqual(def.items.map((x) => x.id), [todayItem.id])

  // 只带 past：历史里"未完成且过期"的遗留仍被隐藏 → 只剩已完结的
  const pastOnly = svc.listTodos({ past: true })
  assert.deepEqual(pastOnly.items.map((x) => x.id).sort(), [todayItem.id, doneYesterday.id].sort())
  assert.ok(pastOnly.hint && pastOnly.hint.includes('expired=true'), '只带 past 时必须提示补 expired=true')

  // past + expired：遗留任务全部挖出来（这就是"昨天没待办"错觉的解法）
  const withExpired = svc.listTodos({ past: true, expired: true })
  assert.equal(withExpired.hint, null)
  const ids = withExpired.items.map((x) => x.id)
  assert.equal(ids.length, 4)
  assert.equal(ids[0], todayItem.id) // 今天在前，历史垫底
  assert.ok(ids.includes(leftYesterday.id))
  assert.ok(ids.includes(doneYesterday.id))
  assert.ok(ids.includes(leftTwoDays.id))
  // 历史排序：新的一天在前
  assert.ok(ids.indexOf(leftYesterday.id) < ids.indexOf(leftTwoDays.id))

  // 显式 date 是"查某一天的历史"，不受 past 开关影响
  const byDate = svc.listTodos({ date: yesterday })
  assert.deepEqual(byDate.items.map((x) => x.id).sort(), [leftYesterday.id, doneYesterday.id].sort())
})

// ── 10. project 轨 cwd 隔离 ─────────────────────────────────────────────────

test('project 轨 cwd 隔离：A 看不到 B，未指定 cwd 时项目待办零泄露', (t) => {
  const { svc } = setup(t)
  const a = add(svc, { track: 'project', cwd: '/proj/a', content: 'A 项目待办' })
  const b = add(svc, { track: 'project', cwd: '/proj/b/', content: 'B 项目待办' })
  const life = add(svc, { content: '生活待办' })

  // 指定 cwd：项目轨只看本项目（尾部分隔符归一后仍命中）；
  // life/work/daily 是全局轨，不受 cwd 影响，照常出现
  const listA = svc.listTodos({ cwd: '/proj/a', all: true })
  assert.deepEqual(listA.items.map((x) => x.id).sort(), [a.id, life.id].sort())
  const listB = svc.listTodos({ cwd: '/proj/b', all: true })
  assert.deepEqual(listB.items.map((x) => x.id).sort(), [b.id, life.id].sort())
  assert.equal(listA.items.filter((x) => x.track === 'project').length, 1)
  assert.equal(listB.items.filter((x) => x.track === 'project').length, 1)

  // 不带 cwd：项目待办整体不出现（跨项目零泄露），生活待办照常
  assert.deepEqual(svc.listTodos({ all: true }).items.map((x) => x.id), [life.id])
  // 智能视图同样不泄露
  assert.ok(!svc.listTodos().items.some((x) => x.track === 'project'))

  // 显式要项目待办却不说哪个项目 → 拒绝（不猜、不汇总）
  throwsCode(() => svc.listTodos({ track: 'project' }), 'TODO_CWD_REQUIRED')
  // 说清楚了就能查
  assert.deepEqual(svc.listTodos({ track: 'project', cwd: '/proj/a' }).items.map((x) => x.id), [a.id])

  // 统计仍然是全局视图（聚合数字不含内容，不构成泄露）
  const s = svc.stats()
  assert.equal(s.total, 3)
  assert.equal(s.byTrack.project, 2)
})

// ── 11. 查询过滤 ────────────────────────────────────────────────────────────

test('查询过滤：status / query / date / track / status:all', (t) => {
  const { svc } = setup(t)
  const report = add(svc, { content: '写周报' })
  const doneItem = add(svc, { content: '买菜', status: 'done' })
  const code = add(svc, { track: 'work', content: '写代码', status: 'doing' })
  const daily = add(svc, { track: 'daily', content: '晨跑' })

  const done = svc.listTodos({ status: 'done' })
  assert.deepEqual(done.items.map((x) => x.id), [doneItem.id])
  assert.equal(done.defaultView, false)

  const writing = svc.listTodos({ query: '写' })
  assert.deepEqual(writing.items.map((x) => x.id).sort(), [report.id, code.id].sort())

  const lifeTrack = svc.listTodos({ track: 'life' })
  assert.deepEqual(lifeTrack.items.map((x) => x.id).sort(), [report.id, doneItem.id].sort())

  // status:'all' 表示"不要智能视图、也不要状态过滤"（显式查询）
  const everything = svc.listTodos({ status: 'all' })
  assert.equal(everything.defaultView, false)
  assert.equal(everything.items.length, 4)

  // date 只匹配 daily 轨（life/work 没有 date 字段）
  const byDate = svc.listTodos({ date: today() })
  assert.deepEqual(byDate.items.map((x) => x.id), [daily.id])

  // limit 参数校验
  throwsCode(() => svc.listTodos({ limit: 0 }), 'TODO_BAD_FIELD')
  throwsCode(() => svc.listTodos({ limit: 1.5 }), 'TODO_BAD_FIELD')
})

// ── 12. replay / 快照 ───────────────────────────────────────────────────────

test('replay：jsonl 重建、快照兜底、坏行计数', (t) => {
  const { dir, svc } = setup(t)
  const a = add(svc, { content: 'A' })
  const b = add(svc, { content: 'B' })
  const c = add(svc, { content: 'C' })
  svc.updateTodo({ id: a.id, expectedRev: 1, content: 'A2', by: BY })
  svc.removeTodo({ id: b.id, expectedRev: 1, by: BY })
  assert.ok(existsSync(join(dir, 'todo.jsonl')))
  assert.ok(existsSync(join(dir, 'todo.snap.json')))

  // 第二个实例从 jsonl 回放
  const svc2 = createTodo({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  const r2 = svc2.replay()
  assert.equal(r2.from, 'jsonl')
  assert.equal(r2.todos, 2)
  assert.equal(r2.events, 5) // create×3 + update + remove
  assert.equal(r2.bad, 0)
  assert.equal(svc2.getTodo(b.id), null) // remove 事件生效
  assert.deepEqual(svc2.getTodo(a.id), svc.getTodo(a.id)) // 内存态与重建态逐字段一致
  assert.equal(svc2.getTodo(c.id).content, 'C')

  // 删掉事件流 → 只能靠快照恢复（事件流是真相源，但快照必须能独立兜底）
  unlinkSync(join(dir, 'todo.jsonl'))
  const svc3 = createTodo({ stateDir: dir })
  const r3 = svc3.replay()
  assert.equal(r3.from, 'snapshot')
  assert.equal(r3.todos, 2)
  assert.equal(svc3.getTodo(a.id).content, 'A2')

  // 坏行不静默丢弃：计入 bad 并 warn，仍然靠快照恢复
  appendFileSync(join(dir, 'todo.jsonl'), '{这不是合法 JSON\n')
  const svc4 = createTodo({ stateDir: dir })
  const r4 = svc4.replay()
  assert.equal(r4.from, 'snapshot')
  assert.equal(r4.bad, 1)
  assert.equal(r4.todos, 2)
})

// ── 13. 写失败绝不静默 ──────────────────────────────────────────────────────

test('写失败绝不静默：append 失败抛 TODO_APPEND_FAILED，内存不留幽灵条目', (t) => {
  const base = mkdtempSync(join(process.env.TODO_TEST_TMPDIR || tmpdir(), `cs-bots-todo-blocked-${process.pid}-`))
  t.after(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* ignore */ } })

  // 把 stateDir 指到一个「普通文件」上：目录无法创建 → append 必然失败
  const blocked = join(base, 'blocked-state')
  writeFileSync(blocked, 'x')
  const svc = createTodo({ logger: { info() {}, warn() {} } }, { stateDir: blocked })
  assert.equal(svc.diagnostics().hydratedFrom, 'empty')

  throwsCode(
    () => svc.createTodo({ track: 'life', content: '写不进去', by: BY }),
    'TODO_APPEND_FAILED',
  )
  // 失败后内存必须原封不动（不能"内存有、磁盘无"）
  assert.equal(svc.listTodos({ all: true }).items.length, 0)
  assert.equal(svc.stats().total, 0)
})

// ── 14. dispose / 不存在 / 空更新 / 多行 / 字段形状 ─────────────────────────

test('dispose：之后调用一律 TODO_DISPOSED，replay 可复活实例', (t) => {
  const { svc } = setup(t)
  const todo = add(svc, { content: '销毁前' })
  const out = svc.dispose()
  assert.deepEqual(out, { disposed: true, todos: 1, events: 1 })

  throwsCode(() => svc.getTodo(todo.id), 'TODO_DISPOSED')
  throwsCode(() => svc.listTodos(), 'TODO_DISPOSED')
  throwsCode(() => svc.stats(), 'TODO_DISPOSED')
  throwsCode(() => svc.createTodo({ track: 'life', content: 'x', by: BY }), 'TODO_DISPOSED')

  // replay 是"重新上班"的入口（与 discipline.js 同语义）
  const revived = svc.replay()
  assert.equal(revived.todos, 1)
  assert.equal(svc.getTodo(todo.id).content, '销毁前')
})

test('getTodo 不存在返回 null；update/remove 不存在抛 TODO_NOT_FOUND', (t) => {
  const { svc } = setup(t)
  assert.equal(svc.getTodo('td-deadbeef'), null)
  assert.equal(svc.getTodo(''), null)
  assert.equal(svc.getTodo(undefined), null)
  throwsCode(() => svc.updateTodo({ id: 'td-deadbeef', expectedRev: 1, content: 'x', by: BY }), 'TODO_NOT_FOUND')
  throwsCode(() => svc.removeTodo({ id: 'td-deadbeef', expectedRev: 1, by: BY }), 'TODO_NOT_FOUND')
})

test('update 没有任何可更新字段时抛 TODO_EMPTY_UPDATE（拒绝无意义 rev 递增）', (t) => {
  const { svc } = setup(t)
  const todo = add(svc)
  throwsCode(() => svc.updateTodo({ id: todo.id, expectedRev: 1, by: BY }), 'TODO_EMPTY_UPDATE')
  assert.equal(svc.getTodo(todo.id).rev, 1)
})

test('content 多行保留：首行即标题，中间缩进不被吃掉', (t) => {
  const { svc } = setup(t)
  const todo = add(svc, { content: '  标题行\n  详情缩进\n第二段  ' })
  assert.equal(todo.content, '标题行\n  详情缩进\n第二段')
  assert.equal(todo.content.split('\n')[0], '标题行')
})

test('落盘记录字段形状固定（JSON 归一，无 undefined 键）', (t) => {
  const { dir, svc } = setup(t)
  const todo = add(svc, { content: '形状' })
  const expectedKeys = [
    'id', 'rev', 'track', 'cwd', 'date', 'content', 'quadrant', 'important', 'urgent',
    'due', 'cat', 'status', 'doneAt', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  ]
  assert.deepEqual(Object.keys(todo), expectedKeys)
  // 落盘事件里的 after 也必须是同一形状（replay 才能逐字段还原）
  const rows = events(dir)
  assert.deepEqual(Object.keys(rows[0].after), expectedKeys)
  assert.equal(JSON.stringify(todo).includes('undefined'), false)
})

// ── 15. 补充：部分更新 / 完成态可见性 ───────────────────────────────────────

test('部分更新：只改给的字段，due/cat 可用 null/空串清空', (t) => {
  const { svc } = setup(t)
  const todo = add(svc, { content: '原内容', due: dateOffset(3), cat: '生活', quadrant: 'q1' })

  // 只改 cat：其余字段一律保持
  const catOnly = svc.updateTodo({ id: todo.id, expectedRev: 1, cat: '健康', by: BY })
  assert.equal(catOnly.cat, '健康')
  assert.equal(catOnly.due, todo.due)
  assert.equal(catOnly.content, '原内容')
  assert.equal(catOnly.quadrant, 'q1')
  assert.equal(catOnly.important, true)

  // 清空 due（null）
  assert.equal(svc.updateTodo({ id: todo.id, expectedRev: 2, due: null, by: BY }).due, null)
  // 清空 cat（空串）
  assert.equal(svc.updateTodo({ id: todo.id, expectedRev: 3, cat: '', by: BY }).cat, null)

  // 非法 due / 空 status 在 update 同样入口拒绝，且 rev 不被推进
  throwsCode(() => svc.updateTodo({ id: todo.id, expectedRev: 4, due: '2026-13-01', by: BY }), 'TODO_BAD_DATE')
  throwsCode(() => svc.updateTodo({ id: todo.id, expectedRev: 4, status: '', by: BY }), 'TODO_BAD_STATUS')
  assert.equal(svc.getTodo(todo.id).rev, 4)
})

test('已完成/已取消不进智能视图，但 status/all 显式查询可见', (t) => {
  const { svc } = setup(t)
  const pending = add(svc, { content: '待办', due: dateOffset(0) })
  const done = add(svc, { content: '完成的', due: dateOffset(-1), status: 'done' })
  const cancelled = add(svc, { content: '取消的', due: dateOffset(-1), status: 'cancelled' })

  const view = svc.listTodos()
  assert.deepEqual(view.items.map((x) => x.id), [pending.id]) // 已结束项不该挤占智能视图
  assert.equal(svc.listTodos({ status: 'done' }).items[0].id, done.id)
  assert.equal(svc.listTodos({ status: 'cancelled' }).items[0].id, cancelled.id)
  assert.equal(svc.listTodos({ all: true }).items.length, 3)
  assert.equal(svc.stats().done, 1)
})
