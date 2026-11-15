/**
 * 组件作用域测试（2026-11-15 Boss 在 Win 上报 `newDeptOpen is not defined`）。
 *
 * ## 这个 bug 的本质
 *   状态声明被放在了 `TasksTab` 里，而真正用它们的是 `BotsTab`
 *   ⇒ React 渲染到 BotsTab 时该标识符不在作用域 ⇒ 整页崩。
 *
 * ## 为什么静态测试能抓住它
 *   浏览器里才会真正抛错，但**「在哪个组件里声明、在哪个组件里用」是源码结构问题**，
 *   可以静态检查：把每个 `function XxxTab(...)` 的函数体切出来，
 *   断言用到的状态名必须在同一个函数体内声明。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')

/** 把源码按 `function XxxTab(` 切成块，返回 { 组件名 → 函数体文本 }。 */
function componentBodies(source) {
  const marks = []
  const re = /^    function ([A-Z][A-Za-z0-9_]*)\s*\(/gm
  let m
  while ((m = re.exec(source)) !== null) marks.push({ name: m[1], start: m.index })
  const out = {}
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : source.length
    out[marks[i].name] = source.slice(marks[i].start, end)
  }
  return out
}

const COMPONENTS = componentBodies(SOURCE)

test('组件作用域：BotsTab 用到的 newDept* 状态必须在它自己的函数体里声明', () => {
  const body = COMPONENTS.BotsTab
  assert.ok(body, 'BotsTab 应存在')
  for (const name of ['newDeptOpen', 'newDept', 'newDeptBusy']) {
    // 用到了（出现在体里）
    const used = body.includes(name)
    if (!used) continue
    // 就必须在体里声明
    assert.ok(
      new RegExp(`const \\[${name},`).test(body),
      `BotsTab 用了 ${name} 却没在自己函数体里声明 —— 这正是 `
      + '"newDeptOpen is not defined" 的成因',
    )
  }
})

test('组件作用域：TasksTab 不该残留 newDept* 声明（那是 BotsTab 的状态）', () => {
  const body = COMPONENTS.TasksTab
  assert.ok(body, 'TasksTab 应存在')
  for (const name of ['newDeptOpen', 'newDept', 'newDeptBusy']) {
    assert.ok(
      !new RegExp(`const \\[${name},`).test(body),
      `TasksTab 不该声明 ${name}（它属于 BotsTab）`,
    )
  }
})

test('组件作用域：每个用到的 useState 标识符都在同组件内声明（通用检查）', () => {
  const problems = []
  for (const [name, body] of Object.entries(COMPONENTS)) {
    // 找出本组件内声明的 useState 变量名
    const declared = new Set()
    const re = /const \[([A-Za-z0-9_]+),\s*set[A-Za-z0-9_]+\]\s*=\s*useState/g
    let m
    while ((m = re.exec(body)) !== null) declared.add(m[1])
    // 找出本组件用到但没声明的（只在「看起来像状态」的名字上检查，避免误报）
    const suspect = /(newDept[A-Za-z]*|convOpen|manageOpen|tidyOpen)\b/g
    const seen = new Set()
    while ((m = suspect.exec(body)) !== null) seen.add(m[1])
    for (const id of seen) {
      if (!declared.has(id)) problems.push(`${name} 用了 ${id} 但没声明`)
    }
  }
  assert.deepEqual(problems, [], problems.join('；'))
})
