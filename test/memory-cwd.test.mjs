/**
 * cs-bots MemoryService · **cwd 作用域**（按工作目录隔离）测试 —— 对齐 `ANALYSIS-memory-evolve-parity.md` #2。
 *
 * 为什么必须机械化守住：
 *   改造前所有条目是全局单库，多项目记忆会串味（A 项目的「密钥在 .env.local」出现在 B 项目上下文里）。
 *   这个能力一旦退化，**不会报错**、只会悄悄把别的项目的记忆注入进来（最恶劣的静默失败），
 *   所以每条语义都要有测试：正向（该看见的看见）+ 反向（不该看见的不许出现）+ 兼容（缺省行为不变）。
 *
 * 覆盖：
 *   1. cwd 归一化与校验（绝对路径 / 去尾斜杠 / 拒收相对路径与 '*' 写入归属）
 *   2. 只有 L3/L4/L5 记 cwd；L1/L2 忽略（L0 模型不可写，见 memory.test.mjs）
 *   3. cwd 落盘 + replay 后仍在（split 标记踩过的坑：只挂返回克隆 = 读回来就丢）
 *   4. list/search/(contextFor) 的 cwd 过滤：全局 + 本项目；他项目不可见；'*' = 全部；缺省 = 旧行为
 *   5. 老数据（无 cwd）在具体 cwd 视图不出现、在 '*' 出现（**故意**的取舍，见 src/memory.js cwdVisible）
 *   6. stats().byCwd 聚合
 *   7. migrateCwd 批量归属 + migrated/skipped 计数 + 幂等
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemory, MemoryError, CWD_LAYERS } from '../src/memory.js'

/** 造隔离状态目录 + 记忆实例。 */
function harness(config = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-mem-cwd-'))
  const mem = createMemory({}, { stateDir, ...config })
  return {
    mem,
    stateDir,
    cleanup() {
      mem.dispose?.()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

/** 三个项目目录（都算绝对路径；测试里不要求真实存在）。 */
const A = '/proj/alpha'
const B = '/proj/beta'
const REL = 'proj/relative'

/** 断言抛出 MemoryError 且 code 匹配。 */
function throwsMemory(fn, codeRe, msg) {
  assert.throws(fn, (err) => err instanceof MemoryError && codeRe.test(String(err.code)), msg)
}

/** 造一条「旧版事件流」（改造前写入的条目：没有 cwd 字段，形态与老 jsonl 一致）。 */
function legacyEvent(id, layer, content, extra = {}) {
  const at = 1700000000000
  return {
    id,
    layer,
    rev: 1,
    action: 'add',
    byId: 'legacy',
    at,
    before: null,
    after: {
      id,
      rev: 1,
      layer,
      content,
      source: 'explicit',
      explicit: false,
      branches: [],
      tags: [],
      createdAt: at,
      createdBy: 'legacy',
      updatedAt: at,
      updatedBy: 'legacy',
      ...extra,
    },
  }
}

/** 把事件写进 `memory.jsonl`（模拟「升级前就在盘上的老数据」）。 */
function writeJsonl(stateDir, rows) {
  writeFileSync(join(stateDir, 'memory.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

// ── 1. 归一化与校验 ──────────────────────────────────────────────────────────

test('cwd 归一化：resolve + 去尾斜杠；相对路径必须抛 MEMORY_BAD_FIELD', () => {
  const h = harness()
  try {
    const e1 = h.mem.add({ layer: 'L3', content: '项目A的key', by: 'dev', cwd: `${A}/` })
    assert.equal(e1.cwd, A, '结尾斜杠必须被去掉（否则同一项目分裂成两个视图）')
    const e2 = h.mem.add({ layer: 'L3', content: '项目A的key 2', by: 'dev', cwd: `${A}//` })
    assert.equal(e2.cwd, A)
    // 归一后是同一个归属：两条都在 A 视图里
    assert.equal(h.mem.list({ cwd: A }).length, 2)

    // 相对路径：跨会话会按不同进程的 cwd 解释 → 必须拒收，不做猜
    throwsMemory(() => h.mem.add({ layer: 'L3', content: 'x', by: 'dev', cwd: REL }), /MEMORY_BAD_FIELD/)
    // 非字符串 / 空串
    throwsMemory(() => h.mem.add({ layer: 'L3', content: 'x', by: 'dev', cwd: 123 }), /MEMORY_BAD_FIELD/)
    throwsMemory(() => h.mem.add({ layer: 'L3', content: 'x', by: 'dev', cwd: '   ' }), /MEMORY_BAD_FIELD/)
    // '*' 是读侧视图标记，不能当写入归属（会写出谁都看不见的 cwd）
    throwsMemory(() => h.mem.add({ layer: 'L3', content: 'x', by: 'dev', cwd: '*' }), /MEMORY_BAD_FIELD/)
    // 元素层面：校验失败不能留下半条脏数据
    assert.equal(h.mem.list().length, 2)
    // 读侧过滤参数校验同样严格（非字符串 / 相对路径）
    throwsMemory(() => h.mem.list({ cwd: 123 }), /MEMORY_BAD_FIELD/)
    throwsMemory(() => h.mem.search({ query: 'key', cwd: REL }), /MEMORY_BAD_FIELD/)
    throwsMemory(() => h.mem.contextFor({ cwd: REL }), /MEMORY_BAD_FIELD/)
  } finally {
    h.cleanup()
  }
})

// ── 2. 哪些层记 cwd ──────────────────────────────────────────────────────────

test('只有 L3/L4/L5 记 cwd；L1/L2 是全局层，传了也忽略（不落字段）', () => {
  const h = harness()
  try {
    assert.deepEqual([...CWD_LAYERS], ['L3', 'L4', 'L5'], '隔离层清单必须是 L3/L4/L5')

    const l3 = h.mem.add({ layer: 'L3', content: 'L3项目key', by: 'dev', cwd: A })
    const l4 = h.mem.add({ layer: 'L4', content: 'L4任务笔记', by: 'bot', cwd: A })
    const l5 = h.mem.add({ layer: 'L5', content: 'L5日札', by: 'bot', cwd: B })
    assert.equal(l3.cwd, A)
    assert.equal(l4.cwd, A)
    assert.equal(l5.cwd, B)

    // 全局层：忽略 cwd，**不能**在条目上留 cwd 字段（否则全局条目被某个项目锁住）
    const l1 = h.mem.add({ layer: 'L1', content: '用户偏好中文', by: 'user', cwd: A })
    const l2 = h.mem.add({ layer: 'L2', content: '团队规矩', by: 'lead', cwd: B })
    for (const [name, entry] of [['L1', l1], ['L2', l2]]) {
      assert.equal('cwd' in entry, false, `${name} 是全局层，条目上不该出现 cwd 字段`)
      assert.equal(entry.cwd, undefined)
    }
    // 「传了也不记」是规格：全局层连非法 cwd 值也一并忽略（不因一个与它无关的字段报错）
    const l2star = h.mem.add({ layer: 'L2', content: '团队规矩2', by: 'lead', cwd: '*' })
    assert.equal('cwd' in l2star, false)
    // L0 人格层模型不可写（cwd 语义不适用）—— 原有闸门保持不变
    throwsMemory(() => h.mem.add({ layer: 'L0', content: 'x', by: 'bot', cwd: A }), /MEMORY_PERSONA_IMMUTABLE/)
  } finally {
    h.cleanup()
  }
})

// ── 3. 落盘 + replay ─────────────────────────────────────────────────────────

test('cwd 必须落盘：replay（等价重启）后仍在（不能只挂在返回克隆上）', () => {
  const h = harness()
  try {
    const created = h.mem.add({ layer: 'L3', content: '项目A的key在 .env.local', by: 'dev', cwd: A })
    h.mem.add({ layer: 'L3', content: '项目B的key在 .env.prod', by: 'dev', cwd: B })
    h.mem.add({ layer: 'L4', content: '归属A的任务笔记', by: 'bot', cwd: A })
    h.mem.add({ layer: 'L2', content: '团队全局', by: 'lead', cwd: A })

    // 新实例 = 重启（从 jsonl 回放）
    const mem2 = createMemory({}, { stateDir: h.stateDir })
    try {
      const replayed = mem2.list({ cwd: A })
      assert.ok(replayed.some((e) => e.id === created.id), 'replay 后该条目必须仍在 A 视图')
      const got = replayed.find((e) => e.id === created.id)
      assert.equal(got.cwd, A, 'replay 后 cwd 字段必须仍在（落盘验证）')
      // B 的条目不许出现在 A 视图
      assert.ok(!replayed.some((e) => /项目B/.test(e.content)))
      // '*' 视图能看到两个项目
      const all = mem2.list({ cwd: '*' })
      assert.ok(all.some((e) => /项目A/.test(e.content)))
      assert.ok(all.some((e) => /项目B/.test(e.content)))
    } finally {
      mem2.dispose?.()
    }
  } finally {
    h.cleanup()
  }
})

test('切分（split）产生的每个片段都继承 cwd，且 replay 后不丢', () => {
  const h = harness({ entryMax: 100, splitOnOverflow: true })
  try {
    const big = '项'.repeat(250) // 250 码点 > 100 ⇒ 切分
    const added = h.mem.add({ layer: 'L4', content: big, by: 'bot', cwd: A })
    assert.equal(added.cwd, A)
    const rows = h.mem.list({ layer: 'L4', cwd: A })
    assert.ok(rows.length >= 2, `应切分为多条，实际 ${rows.length}`)
    for (const r of rows) {
      assert.equal(r.cwd, A, `片段 ${r.id} 也必须带 cwd（否则片段会从项目视图里消失）`)
    }
    // 拼回无损（既有 split 语义不受影响）
    assert.equal(rows.sort((x, y) => x.splitIndex - y.splitIndex).map((r) => r.content).join(''), big)

    const mem2 = createMemory({}, { stateDir: h.stateDir, entryMax: 100, splitOnOverflow: true })
    try {
      const replayed = mem2.list({ layer: 'L4', cwd: A })
      assert.equal(replayed.length, rows.length, 'replay 后片段数一致')
      assert.ok(replayed.every((r) => r.cwd === A), 'replay 后每个片段的 cwd 仍在')
    } finally {
      mem2.dispose?.()
    }
  } finally {
    h.cleanup()
  }
})

// ── 4. list 过滤语义 ─────────────────────────────────────────────────────────

test('list({cwd}) = 全局条目 + 该 cwd 的 L3/L4/L5；不同 cwd 互不可见', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L1', content: '全局偏好', by: 'user' })
    h.mem.add({ layer: 'L2', content: '全局团队规矩', by: 'lead' })
    h.mem.add({ layer: 'L3', content: 'A项目密钥位置', by: 'dev', cwd: A })
    h.mem.add({ layer: 'L4', content: 'A项目任务笔记', by: 'bot', cwd: A })
    h.mem.add({ layer: 'L3', content: 'B项目密钥位置', by: 'dev', cwd: B })
    h.mem.add({ layer: 'L5', content: 'B项目日札', by: 'bot', cwd: B })

    const viewA = h.mem.list({ cwd: A })
    const textsA = viewA.map((e) => e.content)
    assert.ok(textsA.includes('A项目密钥位置'))
    assert.ok(textsA.includes('A项目任务笔记'))
    assert.ok(textsA.includes('全局偏好'), '全局层条目在任何 cwd 视图都必须可见')
    assert.ok(textsA.includes('全局团队规矩'))
    assert.ok(!textsA.includes('B项目密钥位置'), '★ A 视图不许出现 B 项目的记忆（串味红线）')
    assert.ok(!textsA.includes('B项目日札'))

    const viewB = h.mem.list({ cwd: B }).map((e) => e.content)
    assert.ok(viewB.includes('B项目密钥位置'))
    assert.ok(!viewB.includes('A项目密钥位置'), '★ B 视图不许出现 A 项目的记忆')
    assert.ok(viewB.includes('全局偏好'))

    // 互不可见：两个视图的 L3/L4/L5 集合交集必须为空
    const scopedA = viewA.filter((e) => CWD_LAYERS.includes(e.layer)).map((e) => e.id)
    const scopedB = h.mem.list({ cwd: B }).filter((e) => CWD_LAYERS.includes(e.layer)).map((e) => e.id)
    assert.equal(scopedA.filter((id) => scopedB.includes(id)).length, 0, '不同 cwd 的隔离层条目不许重叠')
  } finally {
    h.cleanup()
  }
})

test('cwd:"*" 返回全部；缺省不传 cwd 行为与旧版一致（逐条对拍）', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L1', content: '全局1', by: 'user' })
    h.mem.add({ layer: 'L3', content: 'A项目1', by: 'dev', cwd: A })
    h.mem.add({ layer: 'L4', content: 'B项目1', by: 'bot', cwd: B })
    h.mem.add({ layer: 'L3', content: '未归属老条目', by: 'dev' }) // 无 cwd

    const noArg = h.mem.list()
    const explicitEmpty = h.mem.list({})
    const star = h.mem.list({ cwd: '*' })
    const allIds = sortedIds(noArg)

    // ★ 缺省不传 = 改造前行为：返回全部（含他项目 + 未归属）
    assert.equal(noArg.length, 4, '缺省必须返回全部 4 条（旧行为）')
    assert.deepEqual(sortedIds(explicitEmpty), allIds, 'list() 与 list({}) 必须完全一致')
    assert.deepEqual(sortedIds(star), allIds, "cwd:'*' 与缺省结果一致（都是全部）")
    // HTTP 查询串里 ?cwd= 与「没这个参数」无法区分 ⇒ 读侧把空串也当「未提供」
    assert.deepEqual(sortedIds(h.mem.list({ cwd: '' })), allIds, "cwd:'' 也按未提供处理（读侧宽容）")

    // 而具体 cwd 视图必须更少（证明确实发生了过滤，不是「参数被忽略」）
    assert.ok(h.mem.list({ cwd: A }).length < noArg.length)
  } finally {
    h.cleanup()
  }
})

test('快照回落（事件流被删）时 cwd 仍在（两条恢复路径都得保住作用域）', () => {
  const h = harness()
  try {
    const e = h.mem.add({ layer: 'L3', content: '快照里的项目key', by: 'dev', cwd: A })
    // 删掉真相源（极端情形：jsonl 被误删/损坏），只剩 memory.snap.json
    rmSync(join(h.stateDir, 'memory.jsonl'), { force: true })
    const mem2 = createMemory({}, { stateDir: h.stateDir })
    try {
      assert.equal(mem2.diagnostics().hydratedFrom, 'snapshot', '应从快照恢复')
      const rows = mem2.list({ cwd: A })
      const got = rows.find((r) => r.id === e.id)
      assert.ok(got, '快照恢复后条目仍在 A 视图')
      assert.equal(got.cwd, A, '快照恢复后 cwd 不许丢')
    } finally {
      mem2.dispose?.()
    }
  } finally {
    h.cleanup()
  }
})

test('search({cwd}) 与 list 同口径：只命中全局 + 当前 cwd', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L3', content: '本项目密钥放在 .env.local', by: 'dev', cwd: A })
    h.mem.add({ layer: 'L3', content: '本项目密钥放在 .env.local', by: 'dev', cwd: B })
    h.mem.add({ layer: 'L2', content: '全局：密钥一律进 .env', by: 'lead' })

    const hitsA = h.mem.search({ query: '密钥', cwd: A })
    assert.ok(hitsA.length >= 1)
    for (const e of hitsA) {
      assert.ok(!CWD_LAYERS.includes(e.layer) || e.cwd === A, `A 视图命中里混进了他项目条目：${JSON.stringify(e)}`)
    }
    assert.equal(hitsA.filter((e) => CWD_LAYERS.includes(e.layer)).length, 1, 'A 的隔离层条目只应有 1 条命中')
    assert.ok(hitsA.some((e) => e.layer === 'L2'), '全局条目应可见')

    const hitsB = h.mem.search({ query: '密钥', cwd: B })
    assert.equal(hitsB.filter((e) => CWD_LAYERS.includes(e.layer)).length, 1)
    assert.notEqual(hitsA.find((e) => e.layer === 'L3').id, hitsB.find((e) => e.layer === 'L3').id)

    // 缺省不过滤（旧行为）：两条 L3 都命中
    assert.equal(h.mem.search({ query: '密钥' }).filter((e) => e.layer === 'L3').length, 2)
    // '*' 同缺省
    assert.equal(h.mem.search({ query: '密钥', cwd: '*' }).filter((e) => e.layer === 'L3').length, 2)
  } finally {
    h.cleanup()
  }
})

test('list({cwd}) 与 branch / limit 组合：先过滤后截断', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L3', content: 'A主线1', by: 'dev', cwd: A, branch: 'main' })
    h.mem.add({ layer: 'L3', content: 'A特性1', by: 'dev', cwd: A, branch: 'feature-x' })
    h.mem.add({ layer: 'L3', content: 'B主线1', by: 'dev', cwd: B, branch: 'main' })

    const rows = h.mem.list({ cwd: A, branch: 'main' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].content, 'A主线1')

    // limit 在 cwd 过滤**之后**生效（否则 cwd 视图会被他项目条目占满名额）
    const limited = h.mem.list({ cwd: A, limit: 1 })
    assert.equal(limited.length, 1)
    assert.ok(CWD_LAYERS.includes(limited[0].layer))
  } finally {
    h.cleanup()
  }
})

// ── 5. 老数据（无 cwd）兼容 ─────────────────────────────────────────────────

test("老数据（真·旧 jsonl，无 cwd）：具体 cwd 视图不出现，'*' 与缺省出现", () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-mem-legacy-'))
  try {
    // 手写旧版事件流：形态就是改造前落盘的条目（没有 cwd 字段）
    writeJsonl(stateDir, [
      legacyEvent('legacy01', 'L1', '老用户偏好'),
      legacyEvent('legacy02', 'L2', '老团队规矩'),
      legacyEvent('legacy03', 'L3', '老项目key（不知道属于谁）'),
      legacyEvent('legacy04', 'L4', '老任务笔记（不知道属于谁）'),
      legacyEvent('legacy05', 'L5', '老日札（不知道属于谁）'),
      // 防御性：万一老数据里 L2 被手改带了 cwd，层语义优先 ⇒ 仍全局可见
      legacyEvent('legacy06', 'L2', '带 cwd 的老团队规矩', { cwd: A }),
    ])
    const mem = createMemory({}, { stateDir })
    try {
      // ① 缺省（旧行为）：全部可见
      assert.equal(mem.list().length, 6, '缺省必须看到全部老条目（升级不丢数据）')
      // ② '*' 跨项目视图：全部可见
      assert.equal(mem.list({ cwd: '*' }).length, 6)
      // ③ 具体 cwd 视图：全局层（L1/L2）可见，未归属的 L3/L4/L5 **不出现**（故意的取舍）
      const viewA = mem.list({ cwd: A }).map((e) => e.content)
      assert.ok(viewA.includes('老用户偏好'), 'L1 全局层必须可见')
      assert.ok(viewA.includes('老团队规矩'))
      assert.ok(viewA.includes('带 cwd 的老团队规矩'), '层语义优先：L2 即使带 cwd 也全局可见')
      assert.ok(!viewA.includes('老项目key（不知道属于谁）'), '★ 未归属老 L3 不许出现在具体项目视图（避免串味）')
      assert.ok(!viewA.includes('老任务笔记（不知道属于谁）'))
      assert.ok(!viewA.includes('老日札（不知道属于谁）'))
      // ④ search 同口径
      assert.equal(mem.search({ query: '老项目key', cwd: A }).length, 0)
      assert.ok(mem.search({ query: '老项目key', cwd: '*' }).length >= 1)
      // ⑤ contextFor 同口径：未归属老 L3 不注入具体项目上下文
      const ctxA = mem.contextFor({ cwd: A })
      assert.ok(!ctxA.includes('老项目key'), '未归属老 L3 不该注入项目上下文')
      assert.ok(ctxA.includes('老团队规矩'))
    } finally {
      mem.dispose?.()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ── 6. contextFor ──────────────────────────────────────────────────────────

test('contextFor({cwd})：只注入 全局 + 当前 cwd 的 L3；他项目 L3 不注入', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L1', content: '全局用户偏好', by: 'user' })
    h.mem.add({ layer: 'L2', content: '全局团队规矩', by: 'lead' })
    h.mem.add({ layer: 'L3', content: 'A项目专属key', by: 'dev', cwd: A })
    h.mem.add({ layer: 'L3', content: 'B项目专属key', by: 'dev', cwd: B })

    const textA = h.mem.contextFor({ cwd: A })
    assert.match(textA, /A项目专属key/)
    assert.doesNotMatch(textA, /B项目专属key/, '★ 他项目 L3 绝不许注入（串味红线）')
    assert.match(textA, /全局用户偏好/)
    assert.match(textA, /全局团队规矩/)
    assert.match(textA, /cwd=\/proj\/alpha/, '按项目裁剪时头部必须可见地标出 cwd')

    // 缺省（旧行为）：全部可见，且头部不加 cwd（输出与改造前口径一致）
    const textAll = h.mem.contextFor({})
    assert.match(textAll, /A项目专属key/)
    assert.match(textAll, /B项目专属key/)
    assert.doesNotMatch(textAll, /cwd=/, '不传 cwd 时输出不该出现 cwd 标记（保持旧行为）')
  } finally {
    h.cleanup()
  }
})

test('contextFor 默认返回字符串（兼容 api.js/tools.js）；withMeta 才返回 cwdScoped 结构', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L3', content: 'A项目key', by: 'dev', cwd: A })

    // 默认：字符串（既有调用方按字符串消费）
    assert.equal(typeof h.mem.contextFor(), 'string')
    assert.equal(typeof h.mem.contextFor({ cwd: A }), 'string')

    // withMeta:false 显式给也要是字符串
    assert.equal(typeof h.mem.contextFor({ cwd: A, withMeta: false }), 'string')

    // withMeta:true：结构里带 cwdScoped
    const scoped = h.mem.contextFor({ cwd: A, withMeta: true })
    assert.equal(typeof scoped.text, 'string')
    assert.equal(scoped.cwdScoped, true)
    assert.equal(scoped.cwd, A)

    const unscoped = h.mem.contextFor({ withMeta: true })
    assert.equal(unscoped.cwdScoped, false, '不传 cwd 时必须报 cwdScoped:false')
    assert.equal(unscoped.cwd, null)

    // '*' = 显式全部视图 → 仍算未裁剪（诊断语义：false = 没按项目裁剪）
    assert.equal(h.mem.contextFor({ cwd: '*', withMeta: true }).cwdScoped, false)

    // diagnostics 也能看到「上次注入是否按项目裁剪」
    h.mem.contextFor({ cwd: A })
    const diag = h.mem.diagnostics()
    assert.equal(diag.lastContextCwdScoped, true)
    assert.equal(diag.lastContextCwd, A)
    h.mem.contextFor({})
    assert.equal(h.mem.diagnostics().lastContextCwdScoped, false)

    // tokenBudget 与 cwd 可同时使用（既有裁剪语义不变）
    const trimmed = h.mem.contextFor({ cwd: A, tokenBudget: 30 })
    assert.equal(typeof trimmed, 'string')
    assert.match(trimmed, /tokenBudget 生效/)
  } finally {
    h.cleanup()
  }
})

// ── 7. stats 聚合 ──────────────────────────────────────────────────────────

test('stats().byCwd 只统计有 cwd 的条目；未归属的隔离层条目单独计数', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L3', content: 'A-1', by: 'dev', cwd: A })
    h.mem.add({ layer: 'L4', content: 'A-2', by: 'bot', cwd: A })
    h.mem.add({ layer: 'L5', content: 'B-1', by: 'bot', cwd: B })
    h.mem.add({ layer: 'L1', content: '全局（无 cwd）', by: 'user' })
    h.mem.add({ layer: 'L3', content: '未归属', by: 'dev' })
    // 归档一条：byCwd 是库分布，含归档
    const arch = h.mem.add({ layer: 'L4', content: 'A-归档', by: 'bot', cwd: A })
    h.mem.remove({ layer: 'L4', id: arch.id, expectedRev: arch.rev, by: 'bot' })

    const st = h.mem.stats()
    assert.deepEqual(st.byCwd, { [A]: 3, [B]: 1 }, 'byCwd 只统计有 cwd 的条目（含归档）')
    assert.ok(st.cwd, 'stats 应含 cwd 段（给 UI 完整视图）')
    assert.deepEqual([...st.cwd.layers], ['L3', 'L4', 'L5'])
    assert.equal(st.cwd.unassignedActive, 1, '未归属的活跃隔离层条目 = 1（可迁移）')
    assert.equal(st.cwd.unassignedArchived, 0, '归档条目已带 cwd，不计未归属')

    // 与 list 对齐：A 视图 = 2 条隔离层（L3+L4 活跃；那条 L4 已归档）+ 1 条全局 L1
    const viewA = h.mem.list({ cwd: A })
    assert.equal(viewA.length, 3)
    assert.equal(viewA.filter((e) => CWD_LAYERS.includes(e.layer)).length, 2)
  } finally {
    h.cleanup()
  }
})

// ── 8. migrateCwd ──────────────────────────────────────────────────────────

test('migrateCwd：把未归属老条目批量归属，migrated/skipped 数报对，迁移后可查', () => {
  const h = harness()
  try {
    const m1 = h.mem.add({ layer: 'L3', content: '老key', by: 'dev' })       // 未归属 → 迁移
    const m2 = h.mem.add({ layer: 'L4', content: '老笔记', by: 'bot' })      // 未归属 → 迁移
    const m3 = h.mem.add({ layer: 'L5', content: '老日札', by: 'bot' })      // 未归属但归档 → skipped
    const m4 = h.mem.add({ layer: 'L3', content: 'B项目key', by: 'dev', cwd: B }) // 已归属他处 → alreadyScoped
    h.mem.remove({ layer: 'L5', id: m3.id, expectedRev: m3.rev, by: 'bot' })
    h.mem.add({ layer: 'L2', content: '全局规矩', by: 'lead' })              // 全局层 → 不参与

    // 迁移前：A 视图看不到未归属条目（这正是用户要解决的；全局 L2 仍可见，属正常）
    assert.equal(
      h.mem.list({ cwd: A }).filter((e) => CWD_LAYERS.includes(e.layer)).length,
      0,
      'A 视图迁移前不该有隔离层条目',
    )

    const res = h.mem.migrateCwd({ cwd: `${A}/`, by: 'user' })
    assert.equal(res.cwd, A, '返回值里的 cwd 是归一化后的路径')
    assert.equal(res.migrated, 2, `应迁移 2 条，实际 ${res.migrated}`)
    assert.equal(res.skipped, 1, '已归档未归属条目计入 skipped（不动归档证据）')
    assert.equal(res.alreadyScoped, 1, '已归属 B 的条目不动，单独计数')
    assert.equal(res.skippedEntries[0].code, 'MEMORY_ENTRY_ARCHIVED')
    assert.deepEqual(res.migratedIds.slice().sort(), [m1.id, m2.id].sort())

    // 迁移后：A 视图能看到它们；B 视图看不到（没有被偷过去）
    const viewA = h.mem.list({ cwd: A }).map((e) => e.content)
    assert.ok(viewA.includes('老key'))
    assert.ok(viewA.includes('老笔记'))
    assert.ok(!h.mem.list({ cwd: B }).map((e) => e.content).includes('老key'))

    // 只改元数据：正文与 content 不变，rev+1，事件流留痕 action:'migrate'
    const after = h.mem.get({ layer: 'L3', id: m1.id })
    assert.equal(after.content, '老key', '迁移不许改正文')
    assert.equal(after.rev, 2)
    assert.equal(after.cwd, A)
    assert.equal(after.updatedBy, 'user')
    const evts = h.mem.history(m1.id)
    assert.equal(evts.at(-1).action, 'migrate', '迁移必须在审计流里可见')

    // 幂等：再迁一次，没有可迁的了
    const again = h.mem.migrateCwd({ cwd: A, by: 'user' })
    assert.equal(again.migrated, 0)
    assert.equal(again.skipped, 1, '归档未归属条目仍然只有那 1 条')
    assert.equal(again.alreadyScoped, 3, '此时 3 条已归属（2 条新迁 + 1 条 B）')
  } finally {
    h.cleanup()
  }
})

test('migrateCwd：非法归属必须拒收（相对路径 / 缺 cwd / "*"）', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L4', content: '未归属笔记', by: 'bot' })
    throwsMemory(() => h.mem.migrateCwd({ by: 'user' }), /MEMORY_BAD_FIELD/, '缺 cwd 必须报错（不猜）')
    throwsMemory(() => h.mem.migrateCwd({ cwd: REL, by: 'user' }), /MEMORY_BAD_FIELD/)
    throwsMemory(() => h.mem.migrateCwd({ cwd: '*', by: 'user' }), /MEMORY_BAD_FIELD/)
    // 全部失败后数据未被改动
    assert.equal(h.mem.get({ layer: 'L4', id: h.mem.list({ layer: 'L4' })[0].id }).rev, 1)
    assert.equal(h.mem.stats().cwd.unassignedActive, 1)
  } finally {
    h.cleanup()
  }
})

// ── 9. update 的 cwd 语义 ──────────────────────────────────────────────────

test('update 可重新归属 cwd；不传 cwd 保持原归属；L1 传 cwd 被忽略（不误伤）', () => {
  const h = harness()
  try {
    const e = h.mem.add({ layer: 'L3', content: '项目key', by: 'dev', cwd: A })

    // 不传 cwd：保持原归属（只改内容）
    const u1 = h.mem.update({ layer: 'L3', id: e.id, expectedRev: e.rev, content: '项目key v2', by: 'dev' })
    assert.equal(u1.cwd, A, '不传 cwd 必须保持原归属')
    assert.equal(u1.rev, 2)

    // 传 cwd：改归属（A → B）
    const u2 = h.mem.update({ layer: 'L3', id: e.id, expectedRev: u1.rev, cwd: `${B}/`, by: 'dev' })
    assert.equal(u2.cwd, B)
    assert.ok(!h.mem.list({ cwd: A }).some((r) => r.id === e.id), '改归属后 A 视图不该再有它')
    assert.ok(h.mem.list({ cwd: B }).some((r) => r.id === e.id))

    // 非法 cwd：抛错且状态不变（rev 不推进）
    throwsMemory(
      () => h.mem.update({ layer: 'L3', id: e.id, expectedRev: u2.rev, cwd: REL, by: 'dev' }),
      /MEMORY_BAD_FIELD/,
    )
    assert.equal(h.mem.get({ layer: 'L3', id: e.id }).rev, u2.rev)

    // 全局层：传 cwd 被忽略（不报错、不落字段 —— 便利调用不该变成硬失败）
    const g = h.mem.add({ layer: 'L1', content: '偏好', by: 'user' })
    const gu = h.mem.update({ layer: 'L1', id: g.id, expectedRev: g.rev, content: '偏好v2', cwd: A, by: 'user' })
    assert.equal(gu.cwd, undefined)
    assert.equal('cwd' in gu, false)

    // 既有 CAS 语义不变：过期 rev 仍然抛
    throwsMemory(
      () => h.mem.update({ layer: 'L1', id: g.id, expectedRev: g.rev, content: 'x', by: 'user' }),
      /MEMORY_CAS_CONFLICT/,
    )
  } finally {
    h.cleanup()
  }
})

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 稳定排序后的 id 列表（用于两个视图逐条对拍）。 */
function sortedIds(rows) {
  return rows.map((e) => e.id).sort()
}
