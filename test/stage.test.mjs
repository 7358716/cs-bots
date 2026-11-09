/**
 * StageService 测试 —— 工单执行阶段机（改造07 · 借鉴 Super-agent 的 stage table）。
 *
 * 重点：阶段判定是**纯函数**（无副作用、不落盘），
 * 自上而下首个命中，`needsPerson` 语义正确。
 *
 * 运行：`node --test test/stage.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STAGES,
  STAGE_ORDER,
  STAGE_LABEL,
  STAGE_GROUP,
  REPORT_STATES,
  deriveStage,
  attachStages,
  stageSummary,
} from '../src/stage.js'

// ── 阶段枚举 ───────────────────────────────────────────────────────────────

test('阶段枚举包含全部 8 个阶段，且标签与人话映射完整', () => {
  const expected = [
    'person/delivery', 'person/answer', 'person/review', 'person/blocked',
    'person/failed', 'working/queued', 'idle', 'working',
  ]
  assert.deepEqual(Object.values(STAGES), expected)
  // 每个阶段都有标签与分组
  for (const s of Object.values(STAGES)) {
    assert.ok(STAGE_LABEL[s], `阶段 ${s} 应有标签`)
    assert.ok(STAGE_GROUP[s], `阶段 ${s} 应有分组`)
  }
  // 报告状态枚举
  assert.deepEqual(Object.freeze(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']), [...REPORT_STATES])
})

test('阶段判定顺序：STAGE_ORDER 自上而下首个命中', () => {
  // 顺序就是优先级：先判 person/delivery，再 person/answer，...
  assert.deepEqual(STAGE_ORDER, [
    STAGES.PERSON_DELIVERY,
    STAGES.PERSON_ANSWER,
    STAGES.PERSON_REVIEW,
    STAGES.PERSON_BLOCKED,
    STAGES.PERSON_FAILED,
    STAGES.WORKING_QUEUED,
    STAGES.IDLE,
    STAGES.WORKING,
  ])
})

// ── 各阶段判定 ─────────────────────────────────────────────────────────────

test('投递失败 → person/delivery（最高优先级，需要人处理）', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    delivery: { error: 'agent-not-live', at: Date.now() - 60_000 },
  })
  assert.equal(r.stage, STAGES.PERSON_DELIVERY)
  assert.equal(r.group, 'person')
  assert.equal(r.needsPerson, true)
  assert.match(r.reason, /agent-not-live/)
})

test('有待回答问题 → person/answer（需要人回答）', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'waiting', attention: { question: '要不要拆任务？' } },
  })
  assert.equal(r.stage, STAGES.PERSON_ANSWER)
  assert.equal(r.needsPerson, true)
})

test('已报告 ready → person/review（需要人验收）', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'ready' },
  })
  assert.equal(r.stage, STAGES.PERSON_REVIEW)
  assert.equal(r.needsPerson, true)
})

test('已报告 blocked → person/blocked（受阻等救援）', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'blocked' },
  })
  assert.equal(r.stage, STAGES.PERSON_BLOCKED)
  assert.equal(r.needsPerson, true)
})

test('已报告 failed → person/failed（失败等处理）', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'failed' },
  })
  assert.equal(r.stage, STAGES.PERSON_FAILED)
  assert.equal(r.needsPerson, true)
})

test('无 owner → working/queued（排队等接活）', () => {
  const r = deriveStage({ status: 'pending' })
  assert.equal(r.stage, STAGES.WORKING_QUEUED)
  assert.equal(r.group, 'working')
  assert.equal(r.needsPerson, false)
})

test('最新报告 waiting → idle（空闲等触发）', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'waiting' },
  })
  assert.equal(r.stage, STAGES.IDLE)
  assert.equal(r.group, 'idle')
  assert.equal(r.needsPerson, false)
})

test('正在干 → working（兜底）', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'progress' },
  })
  assert.equal(r.stage, STAGES.WORKING)
  assert.equal(r.needsPerson, false)
})

test('已完成但未验收 → person/review（仍需要人处理）', () => {
  const r = deriveStage({ status: 'completed' })
  assert.equal(r.stage, STAGES.PERSON_REVIEW)
  assert.equal(r.needsPerson, true)
})

test('已完成且已验收 → idle', () => {
  const r = deriveStage({ status: 'completed', accepted: true })
  assert.equal(r.stage, STAGES.IDLE)
})

test('已删除 → idle（终态无执行阶段）', () => {
  const r = deriveStage({ status: 'deleted' })
  assert.equal(r.stage, STAGES.IDLE)
  assert.equal(r.needsPerson, false)
})

// ── 优先级：投递失败压过一切 ───────────────────────────────────────────────

test('投递失败压过 blocked/failed（最高优先级）', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'blocked' },
    delivery: { error: 'timeout' },
  })
  // 投递失败是最高级：必须压过报告的 blocked
  assert.equal(r.stage, STAGES.PERSON_DELIVERY)
})

test('待回答问题压过 report blocked', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'blocked', attention: { question: '缺什么？' } },
  })
  assert.equal(r.stage, STAGES.PERSON_ANSWER)
})

test('report ready 压过 waiting', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'ready' },
  })
  assert.equal(r.stage, STAGES.PERSON_REVIEW)
})

// ── 报告形状的宽容性 ───────────────────────────────────────────────────────

test('latestReport 是字符串时也认', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: 'ready',
  })
  assert.equal(r.stage, STAGES.PERSON_REVIEW)
})

test('latestReport 是 { state: "ready" } 时也认', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'ready' },
  })
  assert.equal(r.stage, STAGES.PERSON_REVIEW)
})

test('latestReport 是 { status: "ready" } 时也认', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { status: 'ready' },
  })
  assert.equal(r.stage, STAGES.PERSON_REVIEW)
})

test('attention 是字符串时也认', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'waiting', attention: '请提供 API key' },
  })
  assert.equal(r.stage, STAGES.PERSON_ANSWER)
})

test('attention 是 { question } 时也认', () => {
  const r = deriveStage({
    status: 'in_progress',
    ownerId: 'bot-a',
    latestReport: { state: 'waiting', attention: { question: '拆任务吗？' } },
  })
  assert.equal(r.stage, STAGES.PERSON_ANSWER)
})

// ── 空值与边界 ─────────────────────────────────────────────────────────────

test('空任务 → working/queued（保守，不猜）', () => {
  const r = deriveStage({})
  assert.equal(r.stage, STAGES.WORKING_QUEUED)
})

test('ownerId 是空字符串 → working/queued', () => {
  const r = deriveStage({ status: 'in_progress', ownerId: '' })
  assert.equal(r.stage, STAGES.WORKING_QUEUED)
})

test('lease 过期 → working/queued（owner 被回收）', () => {
  const r = deriveStage({
    status: 'in_progress',
    lease: { ownerId: 'bot-a', expiresAt: Date.now() - 60_000 },
  })
  assert.equal(r.stage, STAGES.WORKING_QUEUED)
})

test('lease 未过期 → 视为有 owner（无报告时落到 working）', () => {
  const r = deriveStage({
    status: 'in_progress',
    lease: { ownerId: 'bot-a', expiresAt: Date.now() + 60_000 },
  })
  // owner 存在（靠 lease 判定）→ 不是 queued；但无 latestReport → 落到 working 兜底
  assert.equal(r.stage, STAGES.WORKING)
})

// ── 批量与统计 ─────────────────────────────────────────────────────────────

test('attachStages 给每个任务加 stageInfo，不修改原任务', () => {
  const tasks = [
    { status: 'in_progress', ownerId: 'a', latestReport: { state: 'ready' } },
    { status: 'pending' },
    { status: 'completed' },
    { status: 'deleted' },
  ]
  const out = attachStages(tasks)
  assert.equal(out.length, 4)
  assert.ok(out[0].stageInfo.needsPerson === true)
  assert.ok(out[1].stageInfo.needsPerson === false)
  assert.ok(out[2].stageInfo.needsPerson === true)
  assert.ok(out[3].stageInfo.needsPerson === false)
  // 原数组未被修改（stageInfo 是副本上的字段）
  assert.equal(tasks[0].stageInfo, undefined)
})

test('stageSummary 按分组计数', () => {
  const tasks = [
    { status: 'in_progress', ownerId: 'a', latestReport: { state: 'ready' } },
    { status: 'in_progress', ownerId: 'a', latestReport: { state: 'blocked' } },
    { status: 'in_progress', ownerId: 'a', latestReport: { state: 'progress' } },
    { status: 'in_progress', ownerId: 'a', latestReport: { state: 'waiting' } },
    { status: 'pending' },
    { status: 'deleted' },
  ]
  const s = stageSummary(tasks)
  assert.equal(s.person, 2) // ready + blocked
  assert.equal(s.working, 2) // progress + pending
  assert.equal(s.idle, 1) // waiting
  assert.equal(s.total, 5) // deleted 被排除
})

// ── 纯函数性质 ─────────────────────────────────────────────────────────────

test('deriveStage 是纯函数：同一输入永远同一输出', () => {
  const t = { status: 'in_progress', ownerId: 'a', latestReport: { state: 'ready' } }
  const r1 = deriveStage(t)
  const r2 = deriveStage(t)
  assert.deepEqual(r1, r2)
  // 不修改入参
  assert.equal(t.stageInfo, undefined)
  assert.deepEqual(t, { status: 'in_progress', ownerId: 'a', latestReport: { state: 'ready' } })
})

test('deriveStage 不依赖 Date.now()（只有 lease 过期才需要）', () => {
  // lease 未过期时，deriveStage 不读时钟 → 纯函数
  const t = { status: 'in_progress', ownerId: 'a', lease: { expiresAt: 9_999_999_999_999 } }
  const r1 = deriveStage(t)
  const r2 = deriveStage(t)
  assert.equal(r1.stage, r2.stage)
})

// ── 与 Super-agent 的一致性 ─────────────────────────────────────────────────

test('needsPerson 只对 person/* 阶段为 true', () => {
  for (const stage of Object.values(STAGES)) {
    const group = STAGE_GROUP[stage]
    const needs = stage.startsWith('person/')
    assert.equal(
      group === 'person',
      needs,
      `阶段 ${stage}：person/* 必须 needsPerson=true，且 group 必须是 person`,
    )
  }
})

// ── 2026-11-09 修复：已指派 vs 未指派（现场「建了任务却只显示排队中」）──────────
test('排队中：已指派（assignee 存在但未 claim）时说明「等对方接活」', () => {
  const s = deriveStage({ status: 'pending', assignee: 'bot-6b654c19-6ea0-4c95-a73d-0913ce9c25c5' })
  assert.equal(s.stage, 'working/queued')
  assert.match(s.reason, /已指派给/, '必须区分「已指派」与「没人管」')
  assert.match(s.reason, /6b654c19/, '要显示是谁（缩写即可）')
})

test('排队中：未指派时说明「尚未指派」', () => {
  const s = deriveStage({ status: 'pending' })
  assert.equal(s.stage, 'working/queued')
  assert.match(s.reason, /尚未指派/)
})

test('投递失败：task.delivery.error 存在 ⇒ person/delivery 且压过其它阶段', () => {
  const base = { status: 'pending', assignee: 'bot-x' }
  const failed = deriveStage({ ...base, delivery: { error: '会话没有模型路由', at: 1 } })
  assert.equal(failed.stage, 'person/delivery')
  assert.equal(failed.group, 'person')
  assert.equal(failed.needsPerson, true)
  assert.match(failed.reason, /模型路由/, '原因要透传到页面（人得知道去修什么）')
})

test('投递失败：delivery 存在但 error 为空 ⇒ 不算失败（视为已恢复）', () => {
  const s = deriveStage({ status: 'pending', delivery: { error: '', at: 1 } })
  assert.notEqual(s.stage, 'person/delivery')
})
