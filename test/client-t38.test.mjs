/**
 * t-38 止血批（2026-11-11）：唤醒风暴 + 团队可达性 + 徽标文案。
 *
 * ## 现场（Boss 实测）
 *   ① `wakes.jsonl` 里 `room-msg:m-1` **一条消息产生 3 次唤醒，全部 failed**，
 *      其中一条去唤醒 `ui`（Boss 自己）。真金白银在烧。
 *   ② Boss 说徽标里的「人建」不好听 ⇒ 改「Boss建设」/「智能体建设」。
 *   ③ Boss 纠正：AI 建的团队**不能置灰** —— 「用户可能点击进去查看，也有可能发言」。
 *
 * ## 本文件锁三件事
 *   G1 徽标文案 + kind 字段 + 旧数据 createdBy 兜底（不显示 undefined）
 *   G2 AI 团队可进入 + 明确提示「你可以查看和发言」，且不得置灰
 *   G3 房间输入框旁有 @ 提示，且设置页能开关 mentionOnly
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

// ── G1 徽标文案（Boss 明确要求：不要「人建」）──────────────────────────────

test('G1a 徽标文案是「Boss建设」/「智能体建设」，且不再出现「人建」', () => {
  assert.match(SOURCE, /👤 Boss建设/, '人建的团队徽标必须写「👤 Boss建设」')
  assert.match(SOURCE, /🤖 智能体建设/, 'Bot 建的团队徽标必须写「🤖 智能体建设」')
  // Boss 原话：「这个人建不太好听」⇒ 全文件不得再出现
  assert.doesNotMatch(SOURCE, /人建/, '「人建」这词 Boss 说不好听，不得再出现（含注释）')
})

test('G1b kind 字段优先，旧数据按 createdBy 兜底（不显示 undefined）', () => {
  // 契约：kind === 'human' | 'agent'；旧数据无 kind 时按 createdBy 判断
  assert.match(SOURCE, /t\.kind \?\?/, '团队来源必须优先读 kind 字段')
  assert.match(SOURCE, /\['ui','user','person'\]\.includes\(t\.createdBy\)/,
    '旧数据必须按 createdBy 兜底（ui/user/person ⇒ Boss建设）')
  // 兜底必须收敛成 human/agent 两个值，不能把原始值直接当文案渲染
  assert.match(SOURCE, /teamKind === 'human'/, '兜底结果必须归一成 human/agent 两态')
})

test('G1c 徽标在两处团队卡片都显示（团队页 + 工作区页）', () => {
  const hits = SOURCE.match(/👤 Boss建设/g) ?? []
  assert.ok(hits.length >= 2, `团队页与工作区页都要显示徽标（实际 ${hits.length} 处）`)
})

// ── G2 AI 团队可进入、可发言 ──────────────────────────────────────────────

test('G2a AI 团队不置灰：徽标不是禁用态，且没有按来源 disable 的分支', () => {
  // 徽标用的是普通 span + 常规徽标 class，不是 disabled 按钮
  assert.match(SOURCE, /'🤖 智能体建设'/, '智能体建设徽标必须渲染出来')
  // 反证：不得出现「按团队来源禁用/置灰」的判断
  assert.doesNotMatch(SOURCE, /teamKind\s*===\s*'agent'\s*\?\s*[^:]*disabled/,
    'AI 建的团队不得置灰/禁用（Boss：用户可能点进去查看和发言）')
  assert.doesNotMatch(SOURCE, /kind\s*===\s*'agent'\s*\?\s*[^:]*disabled/,
    'AI 建的团队不得置灰/禁用')
})

test('G2b AI 团队卡片有「进入团队」入口 + 「你可以查看和发言」提示', () => {
  assert.match(SOURCE, /'🏠 进入团队'/, '团队卡片必须有「进入团队」入口')
  assert.match(SOURCE, /这是智能体自己建的团队，你可以查看和发言/,
    'AI 建的团队必须明说「你可以查看和发言」')
  // 提示只在 agent 团队出现
  assert.match(SOURCE, /teamKind === 'agent'\s*\n?\s*\? h\('div'/,
    '提示必须按 teamKind 分支，不能给 Boss 建的团队也挂这句')
})

// ── G3 房间 @ 提示（配合定向唤醒，止血点）──────────────────────────────────

test('G3a 房间输入框旁有 @ 提示（缺省 mentionOnly=true 时显示）', () => {
  assert.match(SOURCE, /只有被 @ 的人会被唤醒；不 @ 就只记录不打扰。/,
    '房间输入框旁必须有 @ 提示原文')
  // 必须按 mentionOnly 判断显示，不是无条件挂
  assert.match(SOURCE, /current\.settings\?\.mentionOnly !== false/,
    '提示必须按 mentionOnly !== false 判断（缺省 true 才显示）')
})

test('G3b 房间设置能开关 mentionOnly，且提交时带上（缺省 true）', () => {
  // 读到 state：缺省 true
  assert.match(SOURCE, /mentionOnly: room\.settings\?\.mentionOnly !== false/,
    '设置页读 mentionOnly 必须缺省 true')
  // 提交时带上
  assert.match(SOURCE, /mentionOnly: settings\.mentionOnly,/,
    '保存房间设置必须把 mentionOnly 一起提交')
  // 有可点的开关
  assert.match(SOURCE, /checked: settings\.mentionOnly/,
    '设置页必须能勾选/取消 mentionOnly')
  assert.match(SOURCE, /只有被 @ 的人才被唤醒/, '开关必须有可读的标签')
})