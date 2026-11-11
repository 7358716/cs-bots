/**
 * cs-bots 升级09 · §2.2 / §2.3 / §4.2 阶段产出物（B 侧）
 *
 * 依据：`docs/CONTRACT-升级09-Boss体验.md` §2.2（读）、§2.3（写一条）、§4.2（改清单）。
 * 手法同 api-revive：真 `apply()` + 真 handler。
 *
 * 为什么必须测（真实翻车点）：
 *   - 读端若不按 `index >= phases.length` 过滤，Boss 把清单改短后旧产物会「诈尸」，
 *     页面显示一个根本不存在的阶段 —— 契约 §4.2 明写「保留但不再展示」；
 *   - 写端若越界不拦，index=99 的阶段行会写进 append-only 文件，**永久污染**（删不掉）；
 *   - artifacts 不归一（空格/重复/超长）⇒ 页面上出现空白条目或十万字长条；
 *   - 写不进 task-meta 却回 ok ⇒ 证据静默消失（契约要求 503）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

function boot() {
  const root = mkdtempSync(join(tmpdir(), 'cs-bots-phases-'))
  const stateDir = join(root, 'state')
  let handler = null

  const agents = {
    live: new Set(),
    async create(request) {
      const id = request?.sessionId
      agents.live.add(id)
      return { id, sessionId: id }
    },
    get: (id) => (agents.live.has(id) ? { id, sessionId: id } : undefined),
    list: () => [...agents.live].map((id) => ({ id, sessionId: id })),
  }

  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') return agents
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

  const metaPath = join(stateDir, 'task-meta.jsonl')
  const h = {
    ctx, root, stateDir, services, metaFile: metaPath,
    async req(method, path, body) {
      assert.ok(handler, 'API handler 应已注册')
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0, raw = ''
      const response = { writeHead(code) { status = code }, end(chunk) { raw += chunk ?? '' } }
      await handler(request, response)
      let json; try { json = JSON.parse(raw) } catch { json = { _raw: raw } }
      return { status, json }
    },
    createTask(input = {}) { return services.board.create({ byId: 'user', ...input }) },
    /** 直接往 task-meta.jsonl 追加一行（造老数据 / 造 longrun 记录）。 */
    appendMeta(record) {
      const line = JSON.stringify(record) + '\n'
      const prev = existsSync(h.metaFile) ? readFileSync(h.metaFile, 'utf8') : ''
      writeFileSync(h.metaFile, prev + line, 'utf8')
    },
    rows() {
      if (!existsSync(h.metaFile)) return []
      return readFileSync(h.metaFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
    cleanup() {
      for (const k of ['dispatcher', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { getServices(ctx)[k]?.dispose?.() } catch { /* 已释放 */ }
      }
      try { chmodSync(root, 0o755) } catch { /* 可能已恢复 */ }
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}


// ── 造数据：把任务变成「长任务」────────────────────────────────────────────

/** 直接写一条 kind:'longrun' 到 task-meta.jsonl（等价于 /tasks/evolve mode:longrun 的效果）。 */
function seedLongrun(h, taskId, phases) {
  h.appendMeta({
    kind: 'longrun',
    taskId,
    phases,
    note: '测试造的长任务',
    by: 'user',
    at: Date.now(),
  })
  h.services.board.replay()
}

// ── §2.2 读取端点 ──────────────────────────────────────────────────────────

test('§2.2 GET /tasks/phases：非长任务 ⇒ phases:[]、isLongrun:false，且 200（不是错误）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '普通任务' })

  const r = await h.req('GET', `/tasks/phases?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const j = r.json
  assert.equal(j.ok, true)
  assert.equal(j.taskId, task.id)
  assert.deepEqual(j.phases, [], '非长任务 phases 必须是空数组')
  assert.equal(j.isLongrun, false, '非长任务 isLongrun 必须是 false')
  assert.equal(j.totalArtifacts, 0, '非长任务 totalArtifacts 必须是 0')
  assert.equal(j.currentIndex, 0, '空清单 currentIndex 应为 0（= phases.length）')
})

test('§2.2 GET /tasks/phases：长任务形状严格照契约（index/title/state/artifacts/note/by/at）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '长任务' })
  seedLongrun(h, task.id, ['调研', '定稿', '交付'])

  const r = await h.req('GET', `/tasks/phases?id=${task.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const j = r.json
  assert.equal(j.isLongrun, true)
  assert.equal(j.phases.length, 3, '三个阶段都要出来')
  assert.deepEqual(j.phases.map((p) => p.title), ['调研', '定稿', '交付'], 'title 必须来自 longrun 清单顺序')
  assert.deepEqual(j.phases.map((p) => p.index), [0, 1, 2], 'index 必须 0..n-1')
  // 还没汇报过 ⇒ 全部 pending，currentIndex=0
  assert.ok(j.phases.every((p) => p.state === 'pending' || p.state === 'todo' || p.state === undefined),
    '未汇报阶段不得显示成 done')
  assert.equal(j.currentIndex, 0, '第一个未完成的下标应是 0')
  assert.equal(j.totalArtifacts, 0)
})

test('§2.2 GET /tasks/phases：同一 index 多行 ⇒ 最后一行胜（append-only 的语义）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '重复汇报' })
  seedLongrun(h, task.id, ['调研', '定稿'])

  // 同一 index 写两次，state 不同
  h.appendMeta({ kind: 'phase', taskId: task.id, index: 0, state: 'doing', artifacts: ['a.md'], by: 'bot-1', at: 1000 })
  h.appendMeta({ kind: 'phase', taskId: task.id, index: 0, state: 'done', artifacts: ['a.md', 'b.md'], by: 'bot-1', at: 2000 })
  h.services.board.replay()

  const r = await h.req('GET', `/tasks/phases?id=${task.id}`)
  const j = r.json
  const p0 = j.phases[0]
  assert.equal(p0.state, 'done', '同一 index 最后一行必须胜出')
  assert.deepEqual(p0.artifacts, ['a.md', 'b.md'], '产出物必须是最后一行那份')
  assert.equal(p0.at, 2000, 'at 必须取最后一行')
  assert.equal(j.totalArtifacts, 2, 'totalArtifacts 必须累计所有阶段的产出物数量')
  assert.equal(j.currentIndex, 1, 'index 0 已 done ⇒ currentIndex 应是 1')
})

test('§2.2 GET /tasks/phases：清单改短后，index>=phases.length 的旧行保留在盘上但不再展示', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '改短清单' })
  seedLongrun(h, task.id, ['调研', '定稿', '交付'])
  // 先在 index 2（交付）汇报过产出物
  h.appendMeta({ kind: 'phase', taskId: task.id, index: 2, state: 'done', artifacts: ['交付.zip'], by: 'bot-1', at: 3000 })
  h.services.board.replay()

  let r = await h.req('GET', `/tasks/phases?id=${task.id}`)
  assert.equal(r.json.phases.length, 3)
  assert.equal(r.json.totalArtifacts, 1, '此时应能看到 index 2 的产出物')

  // Boss 把清单改成 2 项（/tasks/phases 会再追加一条 longrun）
  r = await h.req('POST', '/tasks/phases', { id: task.id, phases: ['调研', '定稿'], by: 'user' })
  assert.equal(r.status, 200, JSON.stringify(r.json))

  r = await h.req('GET', `/tasks/phases?id=${task.id}`)
  const j = r.json
  assert.equal(j.phases.length, 2, '改短后只展示 2 个阶段')
  assert.equal(j.totalArtifacts, 0, 'index 2 的旧产出物不再计入（不在展示范围内）')
  // 但盘上那条行必须还在（append-only，不许删）
  const phaseRows = h.rows().filter((row) => row.kind === 'phase' && row.taskId === task.id)
  assert.equal(phaseRows.length, 1, '旧 phase 行必须留在 task-meta.jsonl 里（不丢证据）')
  assert.equal(phaseRows[0].index, 2)
  assert.deepEqual(phaseRows[0].artifacts, ['交付.zip'])
})

test('§2.2 GET /tasks/phases：缺 id ⇒ 400；任务不存在 ⇒ 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r1 = await h.req('GET', '/tasks/phases')
  assert.equal(r1.status, 400, '缺 id 必须 400')
  assert.equal(r1.json.ok, false)

  const r2 = await h.req('GET', '/tasks/phases?id=t-999999')
  assert.equal(r2.status, 404, '任务不存在必须 404')
  assert.equal(r2.json.ok, false)
})

// ── §2.3 写入端点 ──────────────────────────────────────────────────────────

test('§2.3 POST /tasks/phase：正常写入 ⇒ {ok, phase, phases}，且 task-meta 多一行 kind:phase', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '写入阶段' })
  seedLongrun(h, task.id, ['调研', '定稿'])
  const before = h.rows().filter((r) => r.kind === 'phase').length

  const r = await h.req('POST', '/tasks/phase', {
    id: task.id, index: 0, state: 'done', artifacts: ['docs/a.md'], note: '调研完毕', by: 'bot-1',
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const j = r.json
  assert.equal(j.ok, true)
  assert.ok(j.phase, '必须回 phase 对象')
  assert.equal(j.phase.index, 0)
  assert.equal(j.phase.state, 'done')
  assert.deepEqual(j.phase.artifacts, ['docs/a.md'])
  assert.equal(j.phase.note, '调研完毕')
  assert.ok(Array.isArray(j.phases), '必须回填整份最新视图')
  assert.equal(j.phases.length, 2)

  const after = h.rows().filter((r) => r.kind === 'phase' && r.taskId === task.id)
  assert.equal(after.length, before + 1, 'task-meta.jsonl 必须多一行 phase 记录')
  assert.equal(after.at(-1).index, 0)
  assert.equal(after.at(-1).state, 'done')
  assert.equal(after.at(-1).by, 'bot-1', 'by 必须落盘')
})

test('§2.3 POST /tasks/phase：index 越界 ⇒ 400，且理由说明合法范围（关键：不许污染 append-only 文件）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '越界' })
  seedLongrun(h, task.id, ['调研', '定稿', '交付'])
  const before = h.rows().length

  for (const bad of [3, 99, -1]) {
    const r = await h.req('POST', '/tasks/phase', { id: task.id, index: bad, state: 'done', by: 'bot-1' })
    assert.equal(r.status, 400, `index=${bad} 必须 400`)
    assert.equal(r.json.ok, false)
    // 理由必须说清合法范围（0..2）
    assert.ok(/0.*2|合法|范围|range/i.test(r.json.reason), `index=${bad} 的理由应说明合法范围，实际：${r.json.reason}`)
  }
  assert.equal(h.rows().length, before, '越界必须一个字节都不写（append-only 污染无法撤销）')
})

test('§2.3 POST /tasks/phase：artifacts 归一 —— 去空、去重、≤50 项、每项 ≤2000 字', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '归一' })
  seedLongrun(h, task.id, ['调研'])

  // 先测「正常归一」：去空、去重
  const r = await h.req('POST', '/tasks/phase', {
    id: task.id,
    index: 0,
    state: 'done',
    by: 'bot-1',
    artifacts: ['a.md', '  ', '', 'a.md', null, 'b.md'],
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const arts = r.json.phase.artifacts
  assert.deepEqual(arts, ['a.md', 'b.md'], '去空 + 去重后只剩两项，且保持原顺序')
  assert.ok(!arts.some((a) => a.trim() === ''), '不得有空白项')

  // ⚠️ 超长项：实现**选择报错而不是静默截断**（normalizePhaseArtifacts 注释原文：
  //    「产出物是证据，悄悄丢掉一条比拒绝写入更糟」）。
  //    契约 §2.3 只写「每项 ≤2000 字」，没说截断还是拒绝；这里锁定实现的实际语义。
  const before = h.rows().length
  const rLong = await h.req('POST', '/tasks/phase', {
    id: task.id, index: 0, state: 'done', artifacts: ['y'.repeat(2500)], by: 'bot-1',
  })
  assert.equal(rLong.status, 400, '超长单项必须 400（不许静默截断、也不许静默丢）')
  assert.equal(rLong.json.code, 'PHASE_BAD_ARTIFACTS')
  assert.ok(/2000/.test(rLong.json.reason), `理由应写明上限 2000，实际：${rLong.json.reason}`)
  assert.equal(h.rows().length, before, '拒绝写入时不得落任何行')

  // 恰好 2000 字必须放行（边界是闭区间）
  const rEdge = await h.req('POST', '/tasks/phase', {
    id: task.id, index: 0, state: 'done', artifacts: ['z'.repeat(2000)], by: 'bot-1',
  })
  assert.equal(rEdge.status, 200, '恰好 2000 字必须放行（≤ 是闭区间）')
  assert.equal(rEdge.json.phase.artifacts[0].length, 2000)

  // 50 项上限：50 放行，51 报错
  const fifty = Array.from({ length: 50 }, (_, i) => `f${i}.md`)
  const r50 = await h.req('POST', '/tasks/phase', { id: task.id, index: 0, state: 'done', artifacts: fifty, by: 'bot-1' })
  assert.equal(r50.status, 200, '50 项必须放行')
  assert.equal(r50.json.phase.artifacts.length, 50)

  const r51 = await h.req('POST', '/tasks/phase', {
    id: task.id, index: 0, state: 'done', artifacts: [...fifty, 'f50.md'], by: 'bot-1',
  })
  assert.equal(r51.status, 400, '51 项必须 400（超限报错不截断）')
  assert.equal(r51.json.code, 'PHASE_BAD_ARTIFACTS')
})

test('§2.3 POST /tasks/phase：写不进 task-meta ⇒ 503（不许静默丢证据）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '写不进' })
  seedLongrun(h, task.id, ['调研'])

  // ⚠️ 只把 stateDir 设成 0o555 **拦不住**：那只阻止新建文件，
  //    而 task-meta.jsonl 已经存在且属主可写 ⇒ 追加照样成功（第一版就是这么假绿的）。
  //    必须 chmod **文件本身** 到只读。
  assert.ok(existsSync(h.metaFile), '前提：task-meta.jsonl 必须已存在')
  chmodSync(h.metaFile, 0o444)
  t.after(() => { try { chmodSync(h.metaFile, 0o644) } catch { /* 已恢复 */ } })

  const r = await h.req('POST', '/tasks/phase', { id: task.id, index: 0, state: 'done', by: 'bot-1' })
  assert.equal(r.status, 503, `写不进必须 503，实际 ${r.status}`)
  assert.equal(r.json.ok, false)
  assert.ok(r.json.reason && r.json.reason.length > 0, '必须给出理由')
})

test('§2.3 POST /tasks/phase：非长任务（没有阶段清单）⇒ 400，不许凭空建 index 0', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '非长任务' })
  const before = h.rows().length

  const r = await h.req('POST', '/tasks/phase', { id: task.id, index: 0, state: 'done', by: 'bot-1' })
  assert.equal(r.status, 400, '没有阶段清单就没有合法 index')
  assert.equal(r.json.ok, false)
  assert.equal(h.rows().length, before, '不得写任何行')
})

// ── §4.2 编辑阶段清单 ──────────────────────────────────────────────────────

test('§4.2 POST /tasks/phases：改清单 ⇒ 追加 kind:longrun，note 缺省为「Boss 调整阶段清单」', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '改清单' })

  const r = await h.req('POST', '/tasks/phases', { id: task.id, phases: ['甲', '乙'], by: 'user' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)

  const longruns = h.rows().filter((row) => row.kind === 'longrun' && row.taskId === task.id)
  assert.equal(longruns.length, 1, '必须追加一条 longrun 记录')
  assert.deepEqual(longruns[0].phases, ['甲', '乙'])
  assert.equal(longruns[0].note, 'Boss 调整阶段清单', 'note 空时必须自动填契约文案')

  // 读端立即可见
  const v = await h.req('GET', `/tasks/phases?id=${task.id}`)
  assert.equal(v.json.isLongrun, true, '改完清单就该是长任务')
  assert.deepEqual(v.json.phases.map((p) => p.title), ['甲', '乙'])
})

test('§4.2 POST /tasks/phases：显式 note 必须原样落盘', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '带备注' })

  const r = await h.req('POST', '/tasks/phases', { id: task.id, phases: ['甲'], note: '客户要求加一个阶段', by: 'user' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const row = h.rows().filter((x) => x.kind === 'longrun' && x.taskId === task.id).at(-1)
  assert.equal(row.note, '客户要求加一个阶段', '显式 note 必须原样落盘，不许被覆盖成缺省文案')
})

test('§4.2 POST /tasks/phases：改清单不动既有 kind:phase 行（已汇报的产物不丢）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '产物不丢' })
  seedLongrun(h, task.id, ['调研', '定稿'])
  h.appendMeta({ kind: 'phase', taskId: task.id, index: 0, state: 'done', artifacts: ['a.md'], by: 'bot-1', at: 1000 })
  h.services.board.replay()
  const phaseBefore = h.rows().filter((r) => r.kind === 'phase')
  const snapshot = JSON.stringify(phaseBefore)

  const r = await h.req('POST', '/tasks/phases', { id: task.id, phases: ['调研', '定稿', '交付'], by: 'user' })
  assert.equal(r.status, 200, JSON.stringify(r.json))

  const phaseAfter = h.rows().filter((r) => r.kind === 'phase')
  assert.equal(phaseAfter.length, phaseBefore.length, 'phase 行数量不得变（只增不减，这里连增都不该有）')
  assert.equal(JSON.stringify(phaseAfter), snapshot, 'phase 行内容必须逐字节不变')
})

test('§4.2 POST /tasks/phases：非法清单 ⇒ 400（normalizePhases 的边界：>12 项 / 单项 >200 字 / 空白）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '非法清单' })
  const before = h.rows().length

  const cases = [
    { label: '超过 12 项', phases: Array.from({ length: 13 }, (_, i) => `阶段${i}`) },
    { label: '单项超过 200 字', phases: ['x'.repeat(201)] },
    { label: '全是空白', phases: ['   ', '\t'] },
    { label: '不是数组', phases: 'not-an-array' },
    { label: '数组里有非字符串', phases: ['甲', 42] },
  ]
  for (const c of cases) {
    const r = await h.req('POST', '/tasks/phases', { id: task.id, phases: c.phases, by: 'user' })
    assert.equal(r.status, 400, `${c.label} 必须 400，实际 ${r.status} ${JSON.stringify(r.json)}`)
    assert.equal(r.json.ok, false)
  }
  assert.equal(h.rows().length, before, '非法输入必须一个字节都不写')
})

test('§4.2 POST /tasks/phases：空数组/缺 phases ⇒ 用默认阶段清单（normalizePhases 既有语义，不是 400）', async (t) => {
  // 这是 normalizePhases 的既有行为：`undefined | null | []` 一律落到 LONGRUN_DEFAULT_PHASES。
  // 契约 §4.2 只写「复用 normalizePhases()」，所以这里锁定复用语义 ——
  // 换成 400 就等于悄悄改了 §2.4/evolve 共用的那条老路径。
  const h = boot()
  t.after(() => h.cleanup())
  const task = h.createTask({ subject: '缺省清单' })

  const r = await h.req('POST', '/tasks/phases', { id: task.id, phases: [], by: 'user' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const v = await h.req('GET', `/tasks/phases?id=${task.id}`)
  assert.equal(v.json.isLongrun, true)
  assert.ok(v.json.phases.length >= 3, '空数组应落到默认三阶段清单')
  assert.deepEqual(v.json.phases.map((p) => p.title), ['范围与验收标准确认', '执行与自测', '交付与复盘'],
    '默认清单必须与 LONGRUN_DEFAULT_PHASES 逐字一致')
})

test('§4.2 POST /tasks/phases：缺 id ⇒ 400；任务不存在 ⇒ 404', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const r1 = await h.req('POST', '/tasks/phases', { phases: ['甲'] })
  assert.equal(r1.status, 400, '缺 id 必须 400')

  const r2 = await h.req('POST', '/tasks/phases', { id: 't-999999', phases: ['甲'], by: 'user' })
  assert.equal(r2.status, 404, '任务不存在必须 404')
})