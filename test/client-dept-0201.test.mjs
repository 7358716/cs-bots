/**
 * 0.20.1 缺陷回归 —— 全部来自 Boss 2026-11-18 在 Win 桌面版上的实测。
 *
 * ## 这一轮修的六件事（每条都对应一句用户原话）
 *
 *   1「点击插件发布管理员，选择有误」
 *      → 派活下拉的默认值取自 `dept.bots[0]`，跟你点的人无关；
 *        任务栏还写「负责人（自动）」，但空串根本不发后端 ⇒ 静默建无人任务。
 *   2「点击新建，管理部门弹窗点击保存」报「还有 14 个 Bot」
 *      → 「＋ 新建」把草稿重置成只剩一个空部门 ⇒ 保存 = 删掉全部部门。
 *   3「新增部门就是一个字段，字段名称作为目录名称」
 *   4「主管应该选择，也可以选择其他没有在其他部门的 bot」
 *       → 原为手填文本框，Bot 改名后静默失效。
 *   5「删除部门前要校验并给弹窗，而不是在之后的页面展示」
 *   6「管理部门是要管理部门人员，对 bot 的增删改查，同步 bot 档案」
 *       → 弹窗里根本没有人员。
 *
 * ## 为什么用源码断言而不是渲染断言
 *
 *   client.js 是浏览器 bundle，`require('react')` 在这里拿不到 React 实例，
 *   做完整渲染要造一整套 shim（项目既有测试也是这个口径，见 client-*.test.mjs）。
 *   本文件断言**关键实现存在且旧缺陷写法已消失**，运行期行为由 win-regress 与人工验收覆盖。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')
const API = readFileSync(join(HERE, '..', 'src', 'api.js'), 'utf8')

/** 取某个函数体（从签名到下一个同级函数定义）——用于「局部断言」。 */
function fnBody(src, signature) {
  const start = src.indexOf(signature)
  assert.ok(start >= 0, `找不到函数：${signature}`)
  const rest = src.slice(start + signature.length)
  const next = rest.search(/\n {4}(?:async )?function |\n {4}\/\*\*/)
  return next < 0 ? rest : rest.slice(0, next)
}

// ── 1. 派活执行者选择 ───────────────────────────────────────────────────────
test('★1 派活下拉：按部门分组，且能看出是哪个部门的人', () => {
  const body = fnBody(CLIENT, 'function BotPicker(')
  assert.match(body, /optgroup/, '要分组渲染')
  assert.match(body, /本部门「/, '本部门单独一组')
  assert.match(body, /未指定（不派）/, '空值文案必须是「未指定（不派）」')
  assert.match(body, /title: b\.cwd/, '每项要带 cwd 提示，重名才分得清')
})

test('★1 派活默认值：只认「你点进来的那个 Bot」，不再取队列第一个', () => {
  assert.ok(
    !/assignee:\s*dept\?\.bots\?\.\[0\]\?\.sessionId/.test(CLIENT),
    '不许再出现 dept.bots[0] 作为默认派活对象',
  )
  assert.match(CLIENT, /fromBotId: activeBot\.id/, 'Bot 卡片入口要记录来源 Bot')
  assert.match(CLIENT, /leadBotOf\(dept\)\?\.sessionId/, '群聊入口默认 = 本部门主管')
})

test('★1 虚假的「负责人（自动）」必须消失', () => {
  assert.ok(!/负责人（自动）/.test(CLIENT), '「自动」并不存在，不能继续显示')
  assert.match(CLIENT, /未指定（不派）/, '替换成真实语义')
})

test('★1 派活按钮文案必须与行为一致', () => {
  assert.match(CLIENT, /assignForm\.assignee \? '创建并派活' : '仅创建任务（不派）'/, '没选人就不能写「派活」')
})

test('★1 跨部门派活要显式提示', () => {
  assert.match(CLIENT, /不是本部门的 Bot/, '选到别的部门的人必须喊出来')
})

// ── 2. 「＋ 新建」不再清空列表 ───────────────────────────────────────────────
test('★2 「＋ 新增部门」是追加，不是重置（原来点击新建会误判为删全部部门）', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /setDraft\(\[\.\.\.draft, \{ id: '', name: '' \}\]\)/, '必须基于现有 draft 追加')
  // 空状态（depts.length===0）下重置成一行空行是正确行为；只禁止「已有部门时」重置
  const resetAt = [...CLIENT.matchAll(/setDeptDraft\(\[\{ id: '', name: '' \}\]\)/g)].length
  const withDepts = [...CLIENT.matchAll(/setDeptDraft\(\[\.\.\.depts\.map/g)].length
  assert.equal(resetAt, 1, `「只有一个空行」的写法只允许出现在空状态，实际 ${resetAt} 处`)
  assert.ok(withDepts >= 1, '有部门时必须带上现有部门')
})

// ── 3. 单字段即目录名 ───────────────────────────────────────────────────────
test('★3 新增部门只有一个字段，名字即目录名', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /部门名（就是目录名/, '要明说名字即目录名')
  assert.ok(!/placeholder: 'id（英文）'/.test(body), '不再有独立的 id 输入框')
})

// ── 4. 主管改为下拉 ─────────────────────────────────────────────────────────
test('★4 主管是下拉选择，且候选含「未归属部门的 Bot」', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /leadBotName/, '字段仍是 leadBotName（后端契约不变）')
  assert.match(body, /未归属部门的 Bot/, 'Boss 明确要求能选不在其他部门的 Bot')
  assert.match(body, /没有主管，说话唤醒全部/, '留空的含义要写清楚')
  assert.ok(!/placeholder: '填这个部门当主管/.test(body), '不再是手填')
})

test('★4 主管按名字找不到时降级为空，绝不静默挑第一个', () => {
  const body = fnBody(CLIENT, 'const leadBotOf = ')
  assert.match(body, /return null/, '找不到就返回 null')
  assert.ok(!/bots\?\.\[0\]/.test(body), '不许拿第一个 Bot 顶替主管')
})

// ── 5. 删部门前置校验 ───────────────────────────────────────────────────────
test('★5 删除部门：先校验再弹窗，不在保存后才报错', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /removeAt/, '删除走统一入口')
  assert.match(body, /不能删除「/, '有 Bot 时前置拦截')
  assert.match(body, /去迁移这些 Bot/, '拦截后给出迁移入口')
  assert.match(body, /确认删除/, '无 Bot 时二次确认')
  assert.match(body, /磁盘上的目录文件不会删/, '必须说清目录不删')
})

test('★5 后端：保存时仍自校验一遍，并回报「这次删了谁」', () => {
  assert.match(API, /removed: removedNames/, '响应里要明确列出被删部门')
  const body = API.slice(API.indexOf("path === '/departments/save'"))
  assert.match(body.slice(0, 6000), /DEPT_HAS_BOTS/, '有 Bot 仍要拒绝（多端并发兜底）')
})

test('★5 部门改名要全盘联动，且不偷偷改磁盘目录', () => {
  const body = API.slice(API.indexOf("path === '/departments/save'")).slice(0, 14000)
  assert.match(body, /services\.room\.update/, '群聊改名走 room.update')
  assert.match(body, /磁盘目录没有改名/, '磁盘目录不重命名，必须如实告知')
})

// ── 6. 部门人员管理 ─────────────────────────────────────────────────────────
test('★6 部门弹窗里能管理人员：列 Bot / 改档案 / 移出 / 退役 / 新建', () => {
  assert.match(CLIENT, /renderDeptMembers/, '要有人员管理渲染')
  const body = fnBody(CLIENT, 'const renderDeptMembers = ')
  assert.match(body, /'档案'/, '能打开档案')
  assert.match(body, /'退役'/, '能退役')
  assert.match(body, /移到部门…/, '能迁出本部门')
  assert.match(body, /在本部门新建 Bot/, '能在本部门新建')
})

test('★6 改档案复用同一个抽屉 —— 规则只有一份，不存在两套表单', () => {
  assert.match(CLIENT, /h\(BotProfileDrawer, \{\s*\n\s*bot,/, '人员管理里直接挂 BotProfileDrawer')
  // 全文件只允许一个档案编辑组件定义
  const defs = CLIENT.match(/function BotProfileDrawer\(/g) ?? []
  assert.equal(defs.length, 1, `档案编辑组件必须唯一，实际 ${defs.length} 个`)
  // 保存都走同一个端点
  const saveSites = CLIENT.match(/call\('\/roster\/profile'/g) ?? []
  assert.ok(saveSites.length >= 1, '档案保存走 POST /roster/profile')
})

test('★6 退役是二次确认，且说明「目录与档案保留」', () => {
  assert.match(CLIENT, /退役 ≠ 删除/, '要说明语义')
  assert.match(CLIENT, /确认退役/, '要二次确认')
})

// ── 组装口径唯一 ────────────────────────────────────────────────────────────
test('Bot 按部门归类的组装只有一个函数（口径唯一）', () => {
  const defs = CLIENT.match(/function groupBotsByDept\(/g) ?? []
  assert.equal(defs.length, 1, '只允许一个组装函数')
  const body = fnBody(CLIENT, 'function groupBotsByDept(')
  assert.ok(!/startsWith\(`\$\{root\}\/`\)/.test(body), '不能写死正斜杠前缀（Win 会错）')
  // 目标行：const norm = (x) => String(x ?? '').replace(/\\/g, '/') …
  assert.ok(body.includes(".replace(/\\\\/g, '/')"), '要先归一分隔符再比（Win 的反斜杠）')
})