/**
 * cs-bots 升级09 · §8.2 升级预检与迁移（B 侧）
 *
 * 依据：`docs/CONTRACT-升级09-Boss体验.md` §8.2 与 §10（需求 9 = 升级接续，
 * 「升级后现有任务原样存活」是本次交付的硬门槛）。
 *
 * 手法同 api-revive/api-anchor：真 `apply()` + 真 handler，不启服务器；
 * 每个用例独立临时 stateDir，**绝不碰 `~/.dsh/cs-bots/`**。
 *
 * 为什么必须这样测（每条都对着一个真实的翻车方式）：
 *   - `preflight` 若偷偷写盘，「先看后动」就退化成「看了一眼就已经改了」——
 *     Boss 想「先看看会动什么」，结果状态已经变了。⇒ 必须验字节数 + mtime 都不变。
 *   - `migrate` 若不幂等，第二次跑会重复回填/重复备份，回滚点被覆盖掉。
 *   - 回填 `bossTouched` 若顺手重写整个任务，`rev` 会漂 ⇒ 前端拿到的 rev 对不上，
 *     这是契约 §8 明令禁止的实现方式。⇒ 必须逐字段断言「其余字段一字未动」。
 *   - 备份失败若还继续写，就是「半途而废地写一半」，契约明令禁止。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync,
  readdirSync, chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

/**
 * 启动一个最小可用宿主（升级端点不需要活会话）。
 *
 * ⚠️ stateDir 放在**私有父目录**里（`<root>/state`），不是直接把根临时目录当 stateDir：
 *   「备份失败」那条用例要把父目录设为只读，让 `cpSync` 建不出兄弟备份目录。
 *   若父目录是共享的 `/tmp`，只读化会波及整机 —— 那是测试事故，不是测试。
 */
function boot() {
  const root = mkdtempSync(join(tmpdir(), 'cs-bots-upgrade-'))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir)
  let handler = null

  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') {
        return {
          async create(request) { return { id: request?.sessionId, sessionId: request?.sessionId } },
          get: () => undefined,
          list: () => [],
        }
      }
      if (key === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      if (key === 'webServer') {
        return {
          register: ({ path, handler: h }) => {
            assert.equal(path, API_BASE)
            handler = h
            return () => {}
          },
        }
      }
      return undefined
    },
    on: () => {},
    effect: () => {},
  }
  apply(ctx, { stateDir })
  const services = getServices(ctx)

  const h = {
    ctx,
    root,
    stateDir,
    services,
    async req(method, path, body) {
      assert.ok(handler, 'API handler 应已注册')
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0
      let raw = ''
      const response = {
        writeHead(code) { status = code },
        end(chunk) { raw += chunk ?? '' },
      }
      await handler(request, response)
      let json
      try { json = JSON.parse(raw) } catch { json = { _raw: raw } }
      return { status, json }
    },
    createTask(input = {}) {
      return services.board.create({ byId: 'user', ...input })
    },
    /** 某文件的存在 / 字节数 / mtime（三件套一起看才叫「没动」）。 */
    fingerprint(name) {
      const file = join(stateDir, name)
      if (!existsSync(file)) return { exists: false, size: null, mtimeMs: null }
      const st = statSync(file)
      return { exists: true, size: st.size, mtimeMs: st.mtimeMs }
    },
    /** 读某文件的原始字节（比较「内容没变」用，比统计更硬）。 */
    bytes(name) {
      const file = join(stateDir, name)
      return existsSync(file) ? readFileSync(file) : null
    },
    /** 读某 jsonl 的全部行（解析后）。 */
    rows(name) {
      const buf = h.bytes(name)
      if (!buf) return []
      return buf.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
    /** 往 task-meta.jsonl 追加一行（模拟升级前的历史数据）。 */
    appendMeta(record) {
      const file = join(stateDir, 'task-meta.jsonl')
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
      writeFileSync(file, prev + JSON.stringify(record) + '\n', 'utf8')
    },
    cleanup() {
      for (const k of ['dispatcher', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { getServices(ctx)[k]?.dispose?.() } catch { /* 已释放 */ }
      }
      // 有的用例把 root 设为只读来制造备份失败；清理前必须自己先把权限还回来，
      // 否则 rmSync 会 EACCES 而把「用例通过」变成「清理失败」—— 假红。
      try { chmodSync(root, 0o755) } catch { /* 已是可写 */ }
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}

/** 造一个「已完成 + 有 longrun + 有总产出物」的长任务（用于阶段回填）。 */
function makeCompletedLongrun(h, subject, artifacts, phases = ['调研', '定稿', '交付']) {
  const task = h.createTask({ subject })
  h.appendMeta({ kind: 'longrun', taskId: task.id, phases, note: '这是个长任务', by: 'ui', at: Date.now() })
  h.services.board.update({ id: task.id, expectedRev: 1, action: 'claim', byId: 'bot-up-1' })
  const claimed = h.services.board.get(task.id)
  return h.services.board.update({
    id: task.id, expectedRev: claimed.rev, action: 'complete', byId: 'bot-up-1', artifacts,
  })
}

// ── preflight：只读 ────────────────────────────────────────────────────────

test('§8.2 preflight：只读 —— 跑完 board.jsonl / task-meta.jsonl 字节与 mtime 都不变', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.createTask({ subject: 'Boss 的任务' })
  h.appendMeta({ kind: 'longrun', taskId: 't-1', phases: ['一'], by: 'ui', at: Date.now() })

  const beforeBoard = { ...h.fingerprint('board.jsonl'), bytes: h.bytes('board.jsonl') }
  const beforeMeta = { ...h.fingerprint('task-meta.jsonl'), bytes: h.bytes('task-meta.jsonl') }
  const beforeSnap = { ...h.fingerprint('board.snap.json'), bytes: h.bytes('board.snap.json') }
  assert.equal(beforeBoard.exists, true, '前提：已有 board.jsonl')
  assert.equal(beforeMeta.exists, true, '前提：已有 task-meta.jsonl')

  const r = await h.req('GET', '/upgrade/preflight')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)

  const afterBoard = { ...h.fingerprint('board.jsonl'), bytes: h.bytes('board.jsonl') }
  const afterMeta = { ...h.fingerprint('task-meta.jsonl'), bytes: h.bytes('task-meta.jsonl') }
  const afterSnap = { ...h.fingerprint('board.snap.json'), bytes: h.bytes('board.snap.json') }

  assert.equal(afterBoard.size, beforeBoard.size, 'board.jsonl 字节数必须不变')
  assert.equal(afterBoard.mtimeMs, beforeBoard.mtimeMs, 'board.jsonl mtime 必须不变（说明真没写）')
  assert.deepEqual(afterBoard.bytes, beforeBoard.bytes, 'board.jsonl 内容必须逐字节相同')
  assert.deepEqual(afterMeta.bytes, beforeMeta.bytes, 'task-meta.jsonl 内容必须逐字节相同')
  assert.equal(afterMeta.mtimeMs, beforeMeta.mtimeMs, 'task-meta.jsonl mtime 必须不变')
  assert.deepEqual(afterSnap.bytes, beforeSnap.bytes, 'board.snap.json 内容必须不变')
})

test('§8.2 preflight：返回体形状 —— counts / willDo / risks / backupHint 齐备', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.createTask({ subject: '会补 bossTouched 的任务' })   // createdBy = 'user' ⇒ Boss 建的

  const r = await h.req('GET', '/upgrade/preflight')
  assert.equal(r.status, 200)
  const j = r.json
  assert.equal(j.ok, true)
  assert.equal(j.stateDir, h.stateDir, '必须回真实的 stateDir')
  for (const key of ['tasks', 'longrun', 'phaseRows', 'notes', 'wakes']) {
    assert.equal(typeof j.counts[key], 'number', `counts.${key} 必须是数字`)
  }
  assert.equal(j.counts.tasks, 1)
  assert.equal(j.counts.longrun, 0)
  assert.ok(Array.isArray(j.willDo) && j.willDo.length > 0, 'willDo 必须非空且是数组')
  assert.ok(j.willDo.some((s) => /bossTouched/.test(s)), `willDo 应提到 bossTouched，实际 ${JSON.stringify(j.willDo)}`)
  assert.ok(Array.isArray(j.risks), 'risks 必须数组')
  assert.equal(typeof j.backupHint, 'string')
  assert.ok(j.backupHint.length > 0, 'backupHint 必须是人话（告诉 Boss 怎么回滚）')
  // 预检不写盘 ⇒ 迁移前 schema 版本仍是 0
  assert.equal(j.schemaVersion, 0, '预检不得写 schema 版本')
  assert.equal(existsSync(join(h.stateDir, 'board.schema.json')), false, '预检不得创建 schema 文件')
})

test('§8.2 preflight：长任务与阶段行计入 counts，legacy 报告缺字段的任务数', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = makeCompletedLongrun(h, '长任务', ['x.md'])
  h.appendMeta({ kind: 'phase', taskId: task.id, index: 0, state: 'done', artifacts: [], by: 'ui', at: Date.now() })

  const r = await h.req('GET', '/upgrade/preflight')
  assert.equal(r.status, 200)
  assert.equal(r.json.counts.tasks, 1)
  assert.equal(r.json.counts.longrun, 1, 'counts.longrun 应数出 1 个长任务')
  assert.equal(r.json.counts.phaseRows, 1, 'counts.phaseRows 应数出 1 条阶段行')
  assert.ok(Array.isArray(r.json.legacy), 'legacy 必须是数组')
  // bossTouched 在迁移前必然缺失 ⇒ 必须在 legacy 报告里被点名
  const touchedLegacy = r.json.legacy.find((x) => x.field === 'bossTouched')
  assert.ok(touchedLegacy, `legacy 应报出 bossTouched 缺失，实际 ${JSON.stringify(r.json.legacy)}`)
  assert.equal(touchedLegacy.missing, 1)
})

test('§8.2 preflight：没有任何数据也不崩（空状态目录）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  for (const name of readdirSync(h.stateDir)) {
    rmSync(join(h.stateDir, name), { force: true, recursive: true })
  }
  const r = await h.req('GET', '/upgrade/preflight')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.counts.tasks, 0)
  assert.ok(r.json.willDo.length > 0, '即使无事可做也要有一句人话说明')
})

// ── migrate：幂等 / 备份 ───────────────────────────────────────────────────

test('§8.2 migrate：幂等 —— 跑两次第二次 0 改动，且两次 backupPath 不同', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.createTask({ subject: 'Boss 建的任务' })

  const first = await h.req('POST', '/upgrade/migrate', { by: 'ui' })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(first.json.ok, true)
  assert.equal(first.json.bossTouched.updated, 1, '第一次应补 1 条')
  t.after(() => rmSync(first.json.backupPath, { recursive: true, force: true }))

  const second = await h.req('POST', '/upgrade/migrate', { by: 'ui' })
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.equal(second.json.bossTouched.updated, 0, '第二次必须 0 改动（幂等）')
  assert.equal(second.json.phases.backfilled, 0, '第二次必须 0 回填（幂等）')
  t.after(() => rmSync(second.json.backupPath, { recursive: true, force: true }))

  // 两次各备份一次，路径必须不同 —— 否则第二次把「升级前」的备份盖掉了
  assert.ok(first.json.backupPath, '必须回 backupPath')
  assert.ok(second.json.backupPath, '必须回 backupPath')
  assert.notEqual(
    first.json.backupPath, second.json.backupPath,
    '两次备份路径必须不同（同一秒内会互相覆盖，回滚点就丢了）',
  )
})

test('§8.2 migrate：备份真的生成 —— backupPath 存在且含迁移前的 board.jsonl', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.createTask({ subject: '要备份的任务' })

  const r = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(r.status, 200)
  const path = r.json.backupPath
  assert.ok(typeof path === 'string' && path.length > 0, 'backupPath 必须是非空字符串')
  assert.equal(existsSync(path), true, `备份目录必须真的存在：${path}`)
  t.after(() => rmSync(path, { recursive: true, force: true }))
  const entries = readdirSync(path)
  assert.ok(entries.length > 0, '备份目录不能是空的')
  assert.ok(entries.includes('board.jsonl'), '备份里必须有 board.jsonl（回滚要它）')
  // 备份必须是「迁移前」的形态：里面不该有 bossTouched=true
  const bakRows = readFileSync(join(path, 'board.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(
    bakRows.filter((ev) => ev?.after?.bossTouched === true).length, 0,
    '备份应是迁移前的原始形态（不含回填的 bossTouched）',
  )
})

// ── migrate：bossTouched 回填且不动其它字段 ────────────────────────────────

test('§8.2 migrate：Boss 建的任务补 bossTouched=true，且 id/rev/其余字段一字未动', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const bossTask = h.createTask({ subject: 'Boss 亲手建的', description: '描述要原样保留', priority: 3 })
  const workerTask = h.createTask({ subject: '智能体建的', byId: 'bot-x' })
  // 再把 Boss 的任务推进到 rev 2（证明回填不会把 rev 打回 1）
  h.services.board.update({ id: bossTask.id, expectedRev: 1, action: 'edit', byId: 'bot-x', priority: 5 })

  const beforeBoss = JSON.parse(JSON.stringify(h.services.board.get(bossTask.id)))
  const beforeWorker = JSON.parse(JSON.stringify(h.services.board.get(workerTask.id)))
  assert.ok(beforeBoss.rev > 1, '前提：Boss 的任务 rev 已 > 1')

  const r = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(r.status, 200, JSON.stringify(r.json))
  t.after(() => rmSync(r.json.backupPath, { recursive: true, force: true }))
  assert.equal(r.json.bossTouched.updated, 1, '只应补 Boss 建的那一条')

  const rows = h.rows('board.jsonl')
  const lastBoss = rows.filter((ev) => ev.taskId === bossTask.id).at(-1)
  const lastWorker = rows.filter((ev) => ev.taskId === workerTask.id).at(-1)

  assert.equal(lastBoss.after.bossTouched, true, 'Boss 建的任务必须回填 bossTouched=true')
  assert.equal(lastWorker.after.bossTouched, undefined, '智能体建的任务不得被误标')

  // ★ 核心承诺：除 bossTouched 外，其余字段与迁移前完全一致（rev / id / 内容都不许漂）
  const strip = (x) => { const c = { ...x }; delete c.bossTouched; return c }
  assert.equal(lastBoss.after.id, beforeBoss.id, 'id 不许变')
  assert.equal(lastBoss.after.rev, beforeBoss.rev, 'rev 不许变')
  assert.deepEqual(strip(lastBoss.after), beforeBoss, '除 bossTouched 外所有字段必须一字未动')
  assert.equal(lastWorker.after.rev, beforeWorker.rev, '未命中的任务 rev 也不许变')
  assert.deepEqual(strip(lastWorker.after), beforeWorker, '未命中的任务其余字段必须一字未动')

  // 事件流是逐条合并而非重写：行数与备份里完全一致
  const bakRows = readFileSync(join(r.json.backupPath, 'board.jsonl'), 'utf8')
    .split('\n').filter(Boolean)
  assert.equal(rows.length, bakRows.length, '事件行数必须不变（逐条合并，不重写事件流）')
})

test('§8.2 migrate：mandate.sender 是 Boss 也算碰过；历史 byId 是 Boss 也算', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const mandated = h.services.board.create({
    subject: '带 mandate 的任务', byId: 'bot-m',
    mandate: { basis: 'room', sender: 'ui' },
  })
  const edited = h.createTask({ subject: '智能体建的但 Boss 改过', byId: 'bot-e' })
  h.services.board.update({ id: edited.id, expectedRev: 1, action: 'edit', byId: 'ui', subject: 'Boss 改过' })

  const r = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(r.status, 200, JSON.stringify(r.json))
  t.after(() => rmSync(r.json.backupPath, { recursive: true, force: true }))

  const rows = h.rows('board.jsonl')
  assert.equal(rows.filter((ev) => ev.taskId === mandated.id).at(-1).after.bossTouched, true,
    'mandate.sender 是 Boss ⇒ 算碰过')
  assert.equal(rows.filter((ev) => ev.taskId === edited.id).at(-1).after.bossTouched, true,
    '历史 byId 是 Boss ⇒ 算碰过')
})

// ── migrate：阶段产物回填 ──────────────────────────────────────────────────

test('§8.2 migrate：已完成长任务无 phase 行 ⇒ 按总产出物回填末阶段', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = makeCompletedLongrun(h, '长任务：调研并交付', ['docs/report.md', 'src/impl.js'])

  const r = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(r.status, 200, JSON.stringify(r.json))
  t.after(() => rmSync(r.json.backupPath, { recursive: true, force: true }))
  assert.equal(r.json.phases.backfilled, 1, '应回填 1 条阶段产物')
  assert.deepEqual(r.json.phases.tasks, [task.id])

  const phaseRows = h.rows('task-meta.jsonl').filter((row) => row.kind === 'phase' && row.taskId === task.id)
  assert.equal(phaseRows.length, 1, '必须恰好追加 1 条 kind:phase 行')
  const row = phaseRows[0]
  assert.equal(row.index, 2, 'index 必须是 phases.length-1（3 个阶段 ⇒ 2）')
  assert.equal(row.state, 'done')
  assert.match(row.note, /升级迁移：按总产出物回填/, 'note 必须写明是迁移推断写入')
  assert.deepEqual(row.artifacts, ['docs/report.md', 'src/impl.js'], '产出物要取任务的总产出物')

  // 通过只读端点看得到（证明新行真的被 buildPhaseView 读到）
  const view = await h.req('GET', `/tasks/phases?id=${task.id}`)
  assert.equal(view.status, 200, JSON.stringify(view.json))
  assert.equal(view.json.isLongrun, true)
  assert.equal(view.json.phases.length, 3)
  assert.equal(view.json.phases[2].state, 'done')
})

test('§8.2 migrate：已有 phase 行的任务 —— 行数与内容都不动', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = makeCompletedLongrun(h, '已有阶段产物的长任务', ['a.md'])
  h.appendMeta({
    kind: 'phase', taskId: task.id, index: 0, state: 'done',
    artifacts: ['人工阶段物.md'], note: '人工记的', by: 'ui', at: Date.now(),
  })
  const metaPath = join(h.stateDir, 'task-meta.jsonl')
  const before = readFileSync(metaPath, 'utf8')

  const r = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(r.status, 200, JSON.stringify(r.json))
  t.after(() => rmSync(r.json.backupPath, { recursive: true, force: true }))
  assert.equal(r.json.phases.backfilled, 0, '已有 phase 行 ⇒ 不得回填（契约 §8.2 第 3 条）')
  assert.equal(readFileSync(metaPath, 'utf8'), before, 'task-meta.jsonl 必须一字未改')
})

test('§8.2 migrate：非长任务 / 未完成的任务不得被回填', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  // ① 未完成的长任务
  const pending = h.createTask({ subject: '还没做完的长任务' })
  h.appendMeta({ kind: 'longrun', taskId: pending.id, phases: ['一', '二'], by: 'ui', at: Date.now() })
  // ② 已完成但没有 longrun 的普通任务
  const plain = h.createTask({ subject: '普通任务' })
  h.services.board.update({ id: plain.id, expectedRev: 1, action: 'claim', byId: 'bot-p' })
  h.services.board.update({ id: plain.id, expectedRev: 2, action: 'complete', byId: 'bot-p', artifacts: ['x.md'] })

  const r = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(r.status, 200, JSON.stringify(r.json))
  t.after(() => rmSync(r.json.backupPath, { recursive: true, force: true }))
  assert.equal(r.json.phases.backfilled, 0, '未完成 / 非长任务都不该回填')
  assert.equal(h.rows('task-meta.jsonl').filter((row) => row.kind === 'phase').length, 0,
    '不得凭空造出阶段行')
})

test('§8.2 migrate：迁移后新增的 Boss 任务，再跑一次仍能补上（不被 schema 门控挡掉）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.createTask({ subject: '第一批任务' })

  const first = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(first.status, 200, JSON.stringify(first.json))
  t.after(() => rmSync(first.json.backupPath, { recursive: true, force: true }))
  assert.equal(first.json.bossTouched.updated, 1)

  // 迁移之后再建一个 Boss 任务：磁盘上 schema 已是 v2，
  // store.migrate 会因版本相等直接跳过 migrateFn ⇒ 必须自己绕过门控，否则永远补不上。
  const late = h.createTask({ subject: '升级后才建的任务' })
  const second = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(second.status, 200, JSON.stringify(second.json))
  t.after(() => rmSync(second.json.backupPath, { recursive: true, force: true }))
  assert.equal(second.json.bossTouched.updated, 1, '升级后新增的 Boss 任务必须仍被回填')

  const rows = h.rows('board.jsonl')
  assert.equal(rows.filter((ev) => ev.taskId === late.id).at(-1).after.bossTouched, true,
    '新任务必须真的带上 bossTouched=true（证明没被版本门控静默跳过）')
})

// ── 失败路径：备份失败 ⇒ 一个字节都不写 ────────────────────────────────────

test('§8.2 migrate：备份失败 ⇒ 明确理由 + board.jsonl 未被修改（绝不写一半）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.createTask({ subject: '不许被写一半的任务' })

  const boardFile = join(h.stateDir, 'board.jsonl')
  const before = readFileSync(boardFile)

  // 让 backupState 必然失败：把**私有父目录**设为只读，
  // cpSync 建不出 `<stateDir>.bak-*` 兄弟目录 ⇒ EACCES。
  chmodSync(h.root, 0o555)
  t.after(() => { try { chmodSync(h.root, 0o755) } catch { /* 已恢复 */ } })

  const r = await h.req('POST', '/upgrade/migrate', {})
  assert.notEqual(r.status, 200, '备份失败必须非 0 结果，不能假装成功')
  assert.equal(r.json.ok, false)
  assert.ok(r.json.reason && r.json.reason.length > 0, '必须给明确理由')
  assert.match(r.json.reason, /备份/, `理由应说明是备份环节，实际：${r.json.reason}`)

  // ★ 核心：board.jsonl 一个字节都没动
  assert.deepEqual(readFileSync(boardFile), before, '备份失败时 board.jsonl 必须原样不动')
  assert.equal(existsSync(join(h.stateDir, 'board.schema.json')), false, '备份失败时不得写 schema 版本')
})

test('§8.2 migrate：board.jsonl 有坏行 ⇒ 拒绝在不完整数据上迁移', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.createTask({ subject: '正常任务' })
  const boardFile = join(h.stateDir, 'board.jsonl')
  writeFileSync(boardFile, readFileSync(boardFile, 'utf8') + '{这行不是合法 JSON\n', 'utf8')
  const before = readFileSync(boardFile)

  const r = await h.req('POST', '/upgrade/migrate', {})
  assert.notEqual(r.status, 200, '坏行必须让迁移失败，而不是跳过它继续写')
  assert.equal(r.json.ok, false)
  assert.ok(/无法解析|坏行|解析/.test(r.json.reason), `理由应点明解析问题，实际：${r.json.reason}`)
  assert.deepEqual(readFileSync(boardFile), before, '失败时文件必须原样不动')
})
test('§8.2 migrate：schema 已是 v2 且 board.jsonl 有坏行 ⇒ 绕门控分支也必须拒绝重写', async (t) => {
  // 为什么单独一条：schema 到 v2 之后，若又出现「待补 bossTouched」的新任务，
  // migrate 会走「绕版本门控」分支（store.migrate 在 current===to 时根本不调 migrateFn，
  // 会把新任务静默漏补）。那条分支是**整份事件流读进内存、改完整体重写**——
  // 而 facts.boardEvents 来自 readJsonl()，它会静默跳过坏行。
  // ⇒ 若不做坏行自查，坏行会被永久抹掉，而这是常走的分支。
  const h = boot()
  t.after(() => h.cleanup())
  h.createTask({ subject: '先补掉的老任务' })

  // 第一次迁移：schema 0 → v2，老任务补上 bossTouched
  const first = await h.req('POST', '/upgrade/migrate', {})
  assert.equal(first.status, 200, JSON.stringify(first.json))
  t.after(() => rmSync(first.json.backupPath, { recursive: true, force: true }))
  assert.equal(existsSync(join(h.stateDir, 'board.schema.json')), true, '第一次后应已写 schema')

  // ★ 再造一个**待补**的 Boss 任务：这样第二次迁移才会进「绕门控」分支
  //   （targets 为空时走 store.migrate，版本已 v2 ⇒ migrated:false 不重写，那条路本来就安全）
  h.createTask({ subject: 'v2 之后新建的 Boss 任务' })

  // 此时再塞一个坏行
  const boardFile = join(h.stateDir, 'board.jsonl')
  writeFileSync(boardFile, readFileSync(boardFile, 'utf8') + '{坏行不能活过重写\n', 'utf8')
  const before = readFileSync(boardFile)

  // 第二次迁移：schema 已是 v2 且有待补任务 ⇒ 走绕门控分支 ⇒ 必须拒绝
  const second = await h.req('POST', '/upgrade/migrate', {})
  assert.notEqual(second.status, 200, '绕门控分支遇到坏行必须拒绝，不许整体重写')
  assert.equal(second.json.ok, false)
  assert.ok(
    /无法解析|坏行|不完整/.test(second.json.reason),
    `理由应点明解析问题，实际：${second.json.reason}`,
  )
  // ★ 核心：坏行必须还在 —— 这是「不静默丢证据」的机器证据
  assert.deepEqual(readFileSync(boardFile), before, '拒绝时必须原样不动，尤其坏行不能消失')
  t.after(() => { if (second.json?.backupPath) rmSync(second.json.backupPath, { recursive: true, force: true }) })
})
