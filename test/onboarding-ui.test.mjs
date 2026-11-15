/**
 * 引导页 UI 契约（2026-11-15 Boss 截图反馈）。
 *
 * 报的两个问题：
 *   ① 「没办法选择目录，只能手动输入」 → 必须有目录选择按钮
 *   ② 「也没有默认的，至少应该先有默认的」 → 输入框必须有默认值，不能空
 *
 * 这两个都是**用户看到的东西**，静态断言能锁住结构。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')
const API = readFileSync(join(HERE, '..', 'src', 'api.js'), 'utf8')

test('引导页：必须有「选择目录」按钮（不能只让手填）', () => {
  assert.match(CLIENT, /onClick: \(\) => setRootPicking\(true\)/, '引导页要有打开选择器的按钮')
  assert.match(CLIENT, /rootPicking\s*\n?\s*\? h\(DirPicker/, '要真的挂上 DirPicker 组件')
})

test('引导页：选择结果要写回输入框', () => {
  assert.match(CLIENT, /onChange: \(p\) => setRootDraft\(p\)/, '选完目录要填进 rootDraft')
})

test('引导页：默认值来自后端真实路径，前端不瞎猜', () => {
  // Boss：「默认是自动获取系统安装目录，不是 C:\\Users\\你\\.dsh\\cs-bots」
  // ⇒ 前端不该出现 "你" 这种占位符，真实路径只有后端知道（它有 process.env）。
  assert.match(CLIENT, /settingsQ\.data\?\.diagnostics\?\.defaultRoot\s*\n?\s*\?\?\s*settingsQ\.data\?\.values\?\.botWorkspaceRoot/,
    '要有诊断值→设置值的兜底链')
  // 只看**代码里还返回**的假路径（注释里提到历史问题不算）
  assert.ok(
    !/return 'C:\\\\Users\\\\你/.test(CLIENT),
    '不该再 return 含 "你" 的假路径',
  )
})

test('后端：拿不到 stateDir 时也必须返回完整 diagnostics（否则引导页没默认值）', () => {
  // 旧实现：dir 为空就返回空 diagnostics（没有 defaultRoot/default... ）⇒ 引导页空白
  assert.match(API, /loadSettings\(dir \?\? kernelStateDir\(\)\)/,
    '要用 loadSettings(默认 stateDir) 兜底，而不是返回空对象')
  assert.ok(
    !/diagnostics:\s*\{\s*file:\s*''\s*,\s*source:\s*'unknown'/.test(API),
    '不该再有「返回空 diagnostics」的分支',
  )
})

test('后端：/settings 返回 diagnostics（引导页判据来源）', () => {
  assert.match(API, /diagnostics: disk\.diagnostics/, '/settings 必须带出 diagnostics')
})
