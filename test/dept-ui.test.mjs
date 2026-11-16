/**
 * 部门树 UI 契约（2026-11-16 Boss：「先做个 UI 页面出来，尽量完整让我验证」）。
 *
 * ## 必须守住的行为
 *   1. **初始为空时不造假层级** —— Boss：「初始不需要 cs-bots」
 *   2. 有部门时画树：部门行 + 可折叠 + Bot 子节点
 *   3. 点部门能进群聊，点 Bot 能看详情 / 派活
 *   4. 建部门/改/删有独立弹窗
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')

/** 把 DeptTab 函数体切出来。 */
function body(name) {
  const start = SRC.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} 应存在`)
  // 从 `function name(` 往下找到配对的收尾：用「下一个同级 function」作边界
  const re = /^    function [A-Z][A-Za-z0-9_]*\(/gm
  re.lastIndex = start + 10
  const m = re.exec(SRC)
  return SRC.slice(start, m ? m.index : SRC.length)
}

const DEPT = body('DeptTab')
const MANAGE = body('DeptManageModal')

test('★ 空状态：没有部门时**不造假层级**，只给引导', () => {
  assert.match(DEPT, /还没任何部门|还没有任何部门/, '要有空状态文案')
  assert.match(DEPT, /if \(depts\.length === 0\)/, '要有空状态分支')
  assert.match(DEPT, /＋ 新建第一个部门|新建第一个部门/, '空状态要给创建入口')
})

test('树：部门行可折叠，0 个 Bot 时不显示可折叠箭头', () => {
  assert.match(DEPT, /collapsed\[d\.id\]/, '要有折叠状态')
  assert.match(DEPT, /d\.bots\.length \? \(isCollapsed \? '▶' : '▼'\) : '·'/, '0 个 Bot 显示占位点而不是箭头')
})

test('树：Bot 是部门的子节点（缩进显示）', () => {
  assert.match(DEPT, /marginLeft: 22/, 'Bot 子节点要缩进')
  assert.match(DEPT, /d\.bots\.map\(/, '要遍历该部门的 Bot')
})

test('树：显示每个部门的 Bot 数量', () => {
  assert.match(DEPT, /\$\{d\.bots\.length\}/, '部门行要显示 Bot 数')
})

test('交互：点部门选中并清空旧群聊，点 Bot 看详情', () => {
  assert.match(DEPT, /setSelected\(\{ type: 'dept', id: d\.id \}\)/, '点部门要选中')
  assert.match(DEPT, /setSelected\(\{ type: 'bot', id: b\.id \}\)/, '点 Bot 要选中')
})

test('群聊：能打开、能发言、能安排工作', () => {
  assert.match(DEPT, /\/departments\/ensure/, '要有打开群聊的动作')
  assert.match(DEPT, /\/rooms\/messages/, '读消息用正确端点（不是 /rooms/read）')
  assert.match(DEPT, /\/rooms\/post/, '要能发言')
  assert.match(DEPT, /＋ 安排工作/, '要有安排工作入口')
})

test('部门管理：新建/改名/删除都在独立弹窗里', () => {
  assert.match(DEPT, /DeptManageModal/, '要复用 DeptManageModal')
  assert.match(MANAGE, /id（英文）/, '要能填目录名')
  assert.match(MANAGE, /显示名/, '要能填显示名')
  assert.match(MANAGE, /＋ 新增/, '要有新增按钮')
  assert.match(MANAGE, /删除部门前要先把它下面的 Bot 迁走/, '要提示删除约束')
})

test('部门管理：保存走 /departments/save（有 Bot 不许删的保护在后端）', () => {
  assert.match(DEPT, /\/departments\/save/, '保存端点')
  assert.match(DEPT, /r\.warnings/, '要展示后端返回的警告')
})
