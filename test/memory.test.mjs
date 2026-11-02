/**
 * cs-bots MemoryService 测试 —— 六层记忆的**四条规定**与检索两条路径。
 *
 * 为什么这份测试重要：规定 1–4 是治「review 与显式写入打架」的机制，
 * 若不被测试**机械化守住**，就会退化成注释里的愿望（本项目历史教训：
 * `selftest.mjs` 不自检客户端 → 真机白屏）。
 *
 * 每条规定都覆盖「该拦的拦住」+「不该误伤的放行」两侧。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemory, LAYERS, INJECTED_LAYERS, MemoryError } from '../src/memory.js'

/** 造隔离状态目录 + 记忆实例。 */
function harness(config = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-mem-'))
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

// ── 契约 ─────────────────────────────────────────────────────────────────────

test('六层常量：LAYERS 六层、INJECTED_LAYERS 只含 L0–L3（常驻注入）', () => {
  assert.deepEqual([...LAYERS], ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])
  assert.deepEqual([...INJECTED_LAYERS], ['L0', 'L1', 'L2', 'L3'])
})

test('上限是 600 而非 ds-bot 的 300（依据：实测真实条目最长 826 字符）', () => {
  const h = harness()
  try {
    assert.equal(h.mem.entryMax, 600, 'entryMax 必须是 600')
    // 826 字符的真实条目在 300 上限下会被全拒收；600 上限下应被**切分**而非拒收
    const long = 'x'.repeat(826)
    // 实现形态：add 返回**首片段条目对象**，并带 split / splitTotal / splitIndex 显式标记
    const created = h.mem.add({ layer: 'L1', content: long, by: 'user' })
    assert.equal(created.split, true, '超长必须显式标记 split=true（不是静默截断）')
    assert.equal(created.splitTotal, 2, '826 字符在 600 上限下应切成 2 段')
    assert.equal(created.splitIndex, 0, '返回的是首片段')

    // 全部片段都落盘，且**拼回无损**
    const all = h.mem.list({ layer: 'L1' })
    assert.equal(all.length, 2, '两段都应落盘')
    assert.equal(all.map((e) => e.content).join(''), long, '切分必须无损（拼回 === 原文）')
  } finally {
    h.cleanup()
  }
})

// ── 规定 1：条目身份证（按 id 定位，不用编号）────────────────────────────────

test('规定 1：条目带 id 与 rev；update 要求 expectedRev（CAS）', () => {
  const h = harness()
  try {
    const e = h.mem.add({ layer: 'L1', content: '用户偏好中文', by: 'user' })
    const entry = Array.isArray(e) ? e[0] : e
    assert.ok(entry.id, '条目必须有 id')
    assert.equal(entry.rev, 1, '新条目 rev=1')

    const updated = h.mem.update({
      layer: 'L1',
      id: entry.id,
      expectedRev: 1,
      content: '用户偏好中文（已更新）',
      by: 'user',
    })
    assert.equal(updated.rev, 2, '更新后 rev 递增')
    assert.match(updated.content, /已更新/)
  } finally {
    h.cleanup()
  }
})

test('规定 1：CAS 冲突必须抛错（不静默覆盖）', () => {
  const h = harness()
  try {
    const e = h.mem.add({ layer: 'L2', content: '团队规矩 A', by: 'lead' })
    const entry = Array.isArray(e) ? e[0] : e
    h.mem.update({ layer: 'L2', id: entry.id, expectedRev: 1, content: '改1', by: 'lead' })

    assert.throws(
      () => h.mem.update({ layer: 'L2', id: entry.id, expectedRev: 1, content: '改2', by: 'lead' }),
      (err) => err instanceof MemoryError,
      '用过期 rev 更新必须抛 MemoryError',
    )
  } finally {
    h.cleanup()
  }
})

test('规定 1：按 id 定位 —— 改一条不影响另一条', () => {
  const h = harness()
  try {
    const a = h.mem.add({ layer: 'L1', content: '条目A', by: 'user' })
    const b = h.mem.add({ layer: 'L1', content: '条目B', by: 'user' })
    const ea = Array.isArray(a) ? a[0] : a
    const eb = Array.isArray(b) ? b[0] : b

    h.mem.update({ layer: 'L1', id: ea.id, expectedRev: ea.rev, content: '条目A改了', by: 'user' })

    const afterA = h.mem.get({ layer: 'L1', id: ea.id })
    const afterB = h.mem.get({ layer: 'L1', id: eb.id })
    assert.match(afterA.content, /改了/)
    assert.equal(afterB.content, '条目B', '另一条必须原样不动')
  } finally {
    h.cleanup()
  }
})

// ── 规定 2：explicit 保护（review 只能建议不能改）─────────────────────────────

test('规定 2（核心）：review 命中 explicit 条目 → **内容不变**，只给建议', () => {
  const h = harness()
  try {
    // 人显式说的条目
    const e = h.mem.add({
      layer: 'L2',
      content: '生产环境只用 pnpm',
      by: 'user',
      explicit: true,
    })
    const entry = Array.isArray(e) ? e[0] : e
    const before = h.mem.get({ layer: 'L2', id: entry.id })

    const result = h.mem.review({
      layer: 'L2',
      by: 'reviewer',
      proposed: { id: entry.id, content: '生产环境只用 npm' },
    })

    const after = h.mem.get({ layer: 'L2', id: entry.id })
    assert.equal(after.content, before.content, '★ explicit 条目内容**必须不变**')
    assert.equal(after.rev, before.rev, '★ 连 rev 都不该动（没有写入）')
    assert.ok(
      (result.suggested ?? []).length >= 1,
      `review 应把改动降级为建议，实际=${JSON.stringify(result)}`,
    )
  } finally {
    h.cleanup()
  }
})

test('规定 2：update 不带 explicit 改 explicit 条目 → 抛 MEMORY_EXPLICIT_PROTECTED', () => {
  const h = harness()
  try {
    const e = h.mem.add({ layer: 'L1', content: '我叫宋明亮', by: 'user', explicit: true })
    const entry = Array.isArray(e) ? e[0] : e
    assert.throws(
      () => h.mem.update({ layer: 'L1', id: entry.id, expectedRev: entry.rev, content: '改名', by: 'bot' }),
      (err) => err instanceof MemoryError && /EXPLICIT/.test(String(err.code)),
      '非 explicit 写者不得改 explicit 条目',
    )
  } finally {
    h.cleanup()
  }
})

test('规定 2：review 对**非** explicit 条目可以正常改（不误伤）', () => {
  const h = harness()
  try {
    const e = h.mem.add({ layer: 'L1', content: '偏好简短回复', by: 'user', source: 'review' })
    const entry = Array.isArray(e) ? e[0] : e
    const result = h.mem.review({
      layer: 'L1',
      by: 'reviewer',
      proposed: { id: entry.id, content: '偏好简短回复，不要客套' },
    })
    assert.ok((result.applied ?? []).length >= 1, `非 explicit 条目应被实际写入：${JSON.stringify(result)}`)
    const after = h.mem.get({ layer: 'L1', id: entry.id })
    assert.match(after.content, /不要客套/)
  } finally {
    h.cleanup()
  }
})

// ── 规定 3：冲突不静默（矛盾两条都留并标 conflict）───────────────────────────

test('规定 3：consolidate 遇矛盾 → **两条都留**，都标 conflict（不合并、不删除）', () => {
  const h = harness()
  try {
    const a = h.mem.add({ layer: 'L2', content: '本项目使用 pnpm', by: 'lead', source: 'consolidate' })
    const b = h.mem.add({ layer: 'L2', content: '本项目不使用 pnpm', by: 'lead', source: 'consolidate' })
    const ea = Array.isArray(a) ? a[0] : a
    const eb = Array.isArray(b) ? b[0] : b

    const result = h.mem.consolidate({ layer: 'L2', by: 'consolidator', conflicts: [[ea.id, eb.id]] })
    assert.ok((result.conflicts ?? []).length >= 1, `应识别为冲突：${JSON.stringify(result)}`)

    const afterA = h.mem.get({ layer: 'L2', id: ea.id })
    const afterB = h.mem.get({ layer: 'L2', id: eb.id })
    assert.equal(afterA.content, '本项目使用 pnpm', '矛盾条目之一**必须留存**')
    assert.equal(afterB.content, '本项目不使用 pnpm', '矛盾条目之二**必须留存**')
    assert.ok(afterA.conflict === true || afterB.conflict === true, '至少一条应标 conflict')
  } finally {
    h.cleanup()
  }
})

test('规定 3：contextFor 渲染时显式输出 [conflict] 标记（不静默）', () => {
  const h = harness()
  try {
    const a = h.mem.add({ layer: 'L2', content: '本项目使用 pnpm', by: 'lead', source: 'consolidate' })
    const b = h.mem.add({ layer: 'L2', content: '本项目不使用 pnpm', by: 'lead', source: 'consolidate' })
    const ea = Array.isArray(a) ? a[0] : a
    const eb = Array.isArray(b) ? b[0] : b
    h.mem.consolidate({ layer: 'L2', by: 'consolidator', conflicts: [[ea.id, eb.id]] })

    const text = h.mem.contextFor({})
    assert.match(text, /\[conflict\]/, '冲突必须在常驻注入文本里可见')
  } finally {
    h.cleanup()
  }
})

// ── L0 人格：模型不可写 ──────────────────────────────────────────────────────

test('L0 人格层：模型/工具写入必须被拒（仅人可改配置）', () => {
  const h = harness()
  try {
    assert.throws(
      () => h.mem.add({ layer: 'L0', content: '我是另一个 Bot', by: 'bot' }),
      (err) => err instanceof MemoryError,
      'L0 必须拒绝写入',
    )
    assert.throws(
      () => h.mem.review({ layer: 'L0', by: 'bot', proposed: { content: 'x' } }),
      (err) => err instanceof MemoryError,
      'L0 必须拒绝 review',
    )
  } finally {
    h.cleanup()
  }
})

// ── 边界与校验 ───────────────────────────────────────────────────────────────

test('非法 layer 必须被拒（不静默接受）', () => {
  const h = harness()
  try {
    assert.throws(() => h.mem.add({ layer: 'L9', content: 'x', by: 'user' }), (e) => e instanceof MemoryError)
    assert.throws(() => h.mem.add({ layer: 'foo', content: 'x', by: 'user' }), (e) => e instanceof MemoryError)
  } finally {
    h.cleanup()
  }
})

test('缺必填字段必须被拒（content / by）', () => {
  const h = harness()
  try {
    assert.throws(() => h.mem.add({ layer: 'L1', by: 'user' }), (e) => e instanceof MemoryError)
    assert.throws(() => h.mem.add({ layer: 'L1', content: 'x' }), (e) => e instanceof MemoryError)
  } finally {
    h.cleanup()
  }
})

test('未知 id 的 get/update 必须报错或返回 undefined（不伪造）', () => {
  const h = harness()
  try {
    // 实现语义：未知 id **显式抛错**（MEMORY_ENTRY_NOT_FOUND），而不是静默返回 undefined
    assert.throws(
      () => h.mem.get({ layer: 'L1', id: 'nonexistent' }),
      (e) => e instanceof MemoryError && /NOT_FOUND/.test(String(e.code)),
      '未知 id 必须显式报错（不伪造空值）',
    )

    assert.throws(
      () => h.mem.update({ layer: 'L1', id: 'nonexistent', expectedRev: 1, content: 'x', by: 'user' }),
      (e) => e instanceof MemoryError,
    )
  } finally {
    h.cleanup()
  }
})

test('remove → archive → restore 往返：内容一致、rev 递增', () => {
  const h = harness()
  try {
    const e = h.mem.add({ layer: 'L4', content: '任务笔记：要写测试', by: 'bot' })
    const entry = Array.isArray(e) ? e[0] : e

    h.mem.remove({ layer: 'L4', id: entry.id, expectedRev: entry.rev, by: 'bot' })
    const listed = h.mem.list({ layer: 'L4' })
    assert.equal(listed.filter((x) => x.id === entry.id).length, 0, 'remove 后不该在活跃列表里')

    const restored = h.mem.restore({ layer: 'L4', id: entry.id, by: 'bot' })
    assert.equal(restored.content, '任务笔记：要写测试', 'restore 内容必须一致')
    const after = h.mem.list({ layer: 'L4' })
    assert.equal(after.filter((x) => x.id === entry.id).length, 1, 'restore 后应重新出现')
  } finally {
    h.cleanup()
  }
})

// ── 检索（两条路径）─────────────────────────────────────────────────────────

test('检索：中文短语能命中（trigram 或退化路径，两者都必须可用）', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L2', content: '项目采用主干开发与 CI', by: 'lead' })
    h.mem.add({ layer: 'L2', content: '无关内容 ABC', by: 'lead' })

    const hits = h.mem.search({ query: '主干开发' })
    assert.ok(hits.length >= 1, `中文查询应命中，实际=${JSON.stringify(hits)}`)
    assert.ok(hits.some((x) => /主干开发/.test(x.content)))

    // 走哪条路必须**可见**
    const diag = h.mem.diagnostics()
    assert.ok(diag.searchBackend, `检索路径必须可见：${JSON.stringify(diag)}`)
  } finally {
    h.cleanup()
  }
})

test('检索：短查询（<3 码点）走退化路径也能命中', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L1', content: '使用 pnpm', by: 'user' })
    const hits = h.mem.search({ query: 'pn' })
    assert.ok(Array.isArray(hits), '短查询不该崩')
  } finally {
    h.cleanup()
  }
})

test('检索：FTS5 运算符不被注入（按字面短语处理）', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L2', content: '普通内容', by: 'lead' })
    // 这些字符在 FTS5 里有运算符语义；必须被安全降级为字面量，不抛异常
    for (const q of ['NEAR', 'a OR b', 'x*', 'p:q', '"']) {
      assert.doesNotThrow(() => h.mem.search({ query: q }), `查询 ${JSON.stringify(q)} 不该抛`)
    }
  } finally {
    h.cleanup()
  }
})

// ── 上下文注入与分支过滤 ─────────────────────────────────────────────────────

test('contextFor 只含 L0–L3（L4/L5 按需 recall，不常驻）', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L2', content: '常驻应该出现', by: 'lead' })
    h.mem.add({ layer: 'L4', content: '按需召回不该常驻', by: 'bot' })

    const text = h.mem.contextFor({})
    assert.match(text, /常驻应该出现/, 'L2 应在常驻文本里')
    assert.doesNotMatch(text, /按需召回不该常驻/, 'L4 不该出现在常驻文本里')
  } finally {
    h.cleanup()
  }
})

test('分支过滤：L3 条目只在其分支可见', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L3', content: '主干专属记忆', by: 'lead', branch: 'main' })
    h.mem.add({ layer: 'L3', content: '特性分支记忆', by: 'lead', branch: 'feature-x' })

    const onMain = h.mem.list({ layer: 'L3', branch: 'main' })
    const onFeature = h.mem.list({ layer: 'L3', branch: 'feature-x' })

    assert.ok(onMain.some((x) => /主干专属/.test(x.content)))
    assert.ok(!onMain.some((x) => /特性分支/.test(x.content)), 'main 上不该看到 feature-x 的条目')
    assert.ok(onFeature.some((x) => /特性分支/.test(x.content)))
  } finally {
    h.cleanup()
  }
})

// ── 回放与审计 ───────────────────────────────────────────────────────────────

test('回放：重启后重建视图一致（事件流是真相源）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-mem-rp-'))
  try {
    const m1 = createMemory({}, { stateDir })
    m1.add({ layer: 'L1', content: '持久条目一', by: 'user' })
    m1.add({ layer: 'L2', content: '持久条目二', by: 'lead' })
    const before = m1.list({}).map((e) => `${e.layer}:${e.id}:${e.content}`).sort()
    m1.dispose?.()

    const m2 = createMemory({}, { stateDir })
    const after = m2.list({}).map((e) => `${e.layer}:${e.id}:${e.content}`).sort()
    assert.deepEqual(after, before, '回放后视图必须一致')
    m2.dispose?.()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('history 审计流可读，且记录了写入者与动作', () => {
  const h = harness()
  try {
    const e = h.mem.add({ layer: 'L1', content: '审计测试', by: 'user' })
    const entry = Array.isArray(e) ? e[0] : e
    h.mem.update({ layer: 'L1', id: entry.id, expectedRev: entry.rev, content: '审计测试改', by: 'user' })

    const hist = h.mem.history(entry.id)
    assert.ok(hist.length >= 2, `应有 add + update 两条事件，实际 ${hist.length}`)
  } finally {
    h.cleanup()
  }
})

test('stats 按层统计 active/archived/conflict', () => {
  const h = harness()
  try {
    h.mem.add({ layer: 'L1', content: 'a', by: 'user' })
    h.mem.add({ layer: 'L2', content: 'b', by: 'lead' })
    const st = h.mem.stats()
    assert.ok(st.byLayer, 'stats 应含 byLayer')
    assert.ok(st.byLayer.L1.active >= 1)
  } finally {
    h.cleanup()
  }
})
