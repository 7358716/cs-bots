/**
 * 跳转类回归（2026-11-09 现场）。
 *
 * ## 现场
 *   用户：「任务栏里跳转不到房间，没有按钮，跳转不到对话，报错
 *          宿主不支持自动跳转，已复制会话 ID」；「团队页面点击去房间
 *          只跳转到 bot 创建页面」。
 *
 * ## 两个根因（都不是宿主的问题）
 *   ① `openSession` 官方签名是 `openSession(sessionId: string)`；
 *      我们传了对象 `{ sessionId }` → retain 拿到对象 → 抛错 → 被 catch 吞成
 *      「宿主不支持自动跳转」。**是我们传错了类型，还谎报给用户。**
 *   ② `onGoto('rooms', …)` 会被 `safeGoTab` 映射成主页签 `'team'`，
 *      再按**第一个子视图**渲染 ⇒ 落到了「Bot 档案」。必须显式带 `sub`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

test('J1 openSession 传字符串 id（不传对象）', () => {
  // 允许的唯一形态：svc.openSession(sessionId)
  assert.match(SOURCE, /svc\.openSession\(sessionId\)/, '必须以字符串 id 调用官方 openSession')
  // 反证：不得再出现把对象传进去的旧写法
  assert.doesNotMatch(SOURCE, /hostUiWorkspace\.openSession\(\s*\{/, '不得再传 { sessionId } 对象')
  assert.doesNotMatch(SOURCE, /openSession\(\s*\{\s*sessionId\s*:?/, '不得再传 { sessionId } 对象')
})

test('J2 打不开要报真原因，不许谎称「宿主不支持」', () => {
  assert.match(SOURCE, /打开会话失败：/, '失败必须把宿主的真实错误带出来')
})

test('J3 团队卡片「去房间」带 sub:rooms（否则落到 Bot 档案）', () => {
  // 契约 §3(UI)：按钮文案是「去房间」，且必须带 sub:'rooms'。
  // 有 roomId ⇒ 精确选中该房间；没有 ⇒ 退回按团队名筛（不能不带 sub，否则落到 Bot 档案）。
  assert.match(SOURCE, /'💬 去房间'/, '团队卡片按钮文案应为「去房间」')
  assert.match(SOURCE, /\{ sub: 'rooms', roomId: t\.roomId \}/, '有房间时必须按 roomId 精确选中')
  assert.match(SOURCE, /\{ sub: 'rooms', filter: t\.name \}/, '没有房间时退回按团队名筛（仍带 sub）')
  // 反证：团队卡片不得再出现不带 sub 的跳转
  assert.doesNotMatch(SOURCE, /onGoto\?\.\('team', \{ filter: t\.name \}\)/, '不得再出现不带 sub 的旧写法')
})

test('J4 来源跳转（回到消息出处）带 sub:rooms', () => {
  assert.match(SOURCE, /onGotoSource\('team', \{ sub: 'rooms', roomId: room\.roomId, seq \}\)/, '来源跳转必须带 sub')
  assert.doesNotMatch(SOURCE, /onGotoSource\('rooms', \{ roomId/, '不得再出现不带 sub 的旧写法')
})

test('J5 任务抽屉有「去房间 / 看执行者 / 看产出物」三个快捷入口', () => {
  assert.match(SOURCE, /'💬 去房间'/, '任务抽屉必须有去房间按钮')
  assert.match(SOURCE, /'🤖 看执行者'/, '任务抽屉必须有看执行者按钮')
  assert.match(SOURCE, /'📦 看产出物'/, '任务抽屉必须有看产出物按钮')
  assert.match(SOURCE, /onGotoSource\('workspace', \{ sub: 'artifacts' \}\)/, '看产出物要落到成果子页签')
})

test('J6 goTab 支持 opts.sub 精确落到子页签（能力本身）', () => {
  assert.match(SOURCE, /typeof opts\.sub === 'string'/, 'goTab 必须解析 opts.sub')
  assert.match(SOURCE, /const sub = next\?\.subs\?\.find\(\(v\) => v\.id === opts\.sub\)/, '只在目标页签真有该子视图时才设')
})
