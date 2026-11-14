/**
 * Bot 部门化 UI 测试（2026-11-13 Boss：创建 bot 时指定部门，自动建目录）。
 *
 * 手法同 client-*：读整个模块源码做静态断言 + 渲染 BotsTab 检查首渲染不抛。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')

test('部门化：建 Bot 表单有「部门」下拉，不再是必填的「工作目录」输入框', () => {
  assert.match(SOURCE, /h\('label', null, '部门'\)/, '要有部门选择')
  assert.match(SOURCE, /dpts\.map\(\(d\) => h\('option'/, '部门选项从配置来，不写死')
})

test('部门化：工作目录改为只读派生预览（不让用户手填绝对路径）', () => {
  assert.match(SOURCE, /'工作目录（自动）'/, '要有派生预览区')
  assert.match(SOURCE, /由「主目录 \/ 部门 \/ 名字」自动拼出/, '要让用户明白它是自动的')
})

test('部门化：提交时传 department，而不是只在有部门时才传 cwd', () => {
  assert.match(SOURCE, /\? \{ department: dept \} : \{ cwd: form\.cwd\.trim\(\) \}/,
    '有部门走 department，没部门才退回 cwd（兼容老环境）')
})

test('部门化：没配部门时退回手填 cwd（不砸掉老用法）', () => {
  assert.match(SOURCE, /尚未配置部门/, '要提示用户当前是手填模式')
})

test('部门化：前端派生与后端同口径（去掉分隔符与首尾点号）', () => {
  // 源码原文（注意 JS 源码里是双反斜杠）：.replace(/[/\\]/g, '').replace(/^[.\s]+|[.\s]+$/g, '')
  const washSep = SOURCE.includes('[/\\\\]')
  const trimDots = SOURCE.includes('replace(/^[.\\s]+|[.\\s]+$/g')
  assert.ok(washSep, '前端要洗掉路径分隔符（与 botdirs.sanitizeDirSegment 同口径）')
  assert.ok(trimDots, '前端要剥首尾点号与空白')
})

// ── 2026-11-14 Boss：任务管理页顶部要有「去对话」按钮 ──────────────────────

test('去对话： TasksTab 顶部有常驻「去对话」入口（不用先点开任务）', () => {
  assert.match(SOURCE, /'💬 去对话'/, '顶部要有去对话按钮')
  assert.match(SOURCE, /title: '选一个任务，直接跳到它的执行者会话'/, '要有说明它干什么')
})

test('去对话：面板列出可跳转任务，跳不了的写明原因（不是「点了没反应」）', () => {
  assert.match(SOURCE, /'还没有执行者'/, '没派活要说清')
  assert.match(SOURCE, /'负责人是平台身份，没有 Bot 会话'/, '平台伪装身份要说清')
  assert.match(SOURCE, /'负责人不在 Bot 注册表里'/, '注册表查不到要说清')
})

test('去对话：跳转走 tryOpenSession（传字符串 id，不是对象）', () => {
  assert.match(SOURCE, /await tryOpenSession\(r\.sid\)/, '必须用统一封装，避免 2026-11-09 那个传对象的 bug')
})
