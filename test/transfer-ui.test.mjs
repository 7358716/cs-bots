/**
 * 导入导出 UI 契约（2026-11-16 Boss：都要有确认页 + 校核提示）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')
const API = readFileSync(join(HERE, '..', 'src', 'api.js'), 'utf8')

function body(name) {
  const start = SRC.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} 应存在`)
  const re = /^    function [A-Z][A-Za-z0-9_]*\(/gm
  re.lastIndex = start + 10
  const m = re.exec(SRC)
  return SRC.slice(start, m ? m.index : SRC.length)
}

const EXP = body('TransferExportModal')
const IMP = body('TransferImportModal')

test('★ 导出：有确认页，能勾选内容，含文件可选', () => {
  assert.match(EXP, /选择要导出的内容/, '要有说明')
  assert.match(EXP, /SECTIONS_UI\.map/, '内容可勾选')
  assert.match(EXP, /包含工作目录文件/, '含文件是独立开关')
  assert.match(EXP, /'导出 zip'/, '有导出按钮')
})

test('★ 导出：实时显示体积，超上限要二次确认', () => {
  assert.match(EXP, /\/transfer\/export\/estimate/, '要调体积估算')
  assert.match(EXP, /预计体积/, '要显示体积')
  assert.match(EXP, /超过 500MB 上限，需确认/, '超限要提示')
  assert.match(EXP, /确认导出（体积较大）/, '超限后按钮文案要变')
  assert.match(EXP, /confirmLarge/, '要带 confirmLarge 才能强制导出')
})

test('★ 导出：浏览器直接下载（Boss 要求）', () => {
  assert.match(EXP, /createObjectURL/, '要生成下载链接')
  assert.match(EXP, /a\.download/, '要触发下载')
  assert.match(EXP, /\.zip/, '文件名是 zip')
})

test('★ 导入：先校核再确认，不能直接改数据', () => {
  assert.match(IMP, /\/transfer\/inspect/, '先调校核')
  assert.match(IMP, /导入前会先校核，不会直接改动数据/, '要说明这一点')
  assert.match(IMP, /disabled: busy \|\| !rep\?\.ok/, '校核不过不许点导入')
  assert.match(IMP, /confirm: true/, '应用时带 confirm')
})

test('★ 导入：校核提示分「阻断」与「警告」两类', () => {
  assert.match(IMP, /rep\.blocking/, '要展示阻断项')
  assert.match(IMP, /不能导入/, '阻断要明确说不能导')
  assert.match(IMP, /rep\.warnings/, '要展示警告')
  assert.match(IMP, /校核提示/, '警告区要有标题')
})

test('★ 导入：同名冲突三种策略（默认覆盖）', () => {
  assert.match(IMP, /onConflict: mode/, '要传冲突策略')
  assert.match(IMP, /mode === 'overwrite'/, '覆盖')
  assert.match(IMP, /mode === 'skip'/, '跳过')
  assert.match(IMP, /mode === 'rename'/, '自动改名')
  assert.match(IMP, /默认，上面的提示里会列出会覆盖哪些/, '覆盖要说明会列出影响面')
})

test('后端：三个端点齐全，且 export 有体积上限保护', () => {
  for (const p of ['/transfer/export/estimate', '/transfer/export', '/transfer/import', '/transfer/inspect']) {
    assert.ok(API.includes(`path === '${p}'`), `${p} 要存在`)
  }
  assert.ok(API.includes("path === '/transfer/export/estimate'"), 'estimate 端点')
  assert.match(API, /TRANSFER_TOO_LARGE/, '超限要报这个 code')
  assert.match(API, /TRANSFER_NEEDS_CONFIRM/, '导入要 confirm')
})

test('入口：部门页有导出/导入按钮', () => {
  assert.match(SRC, /⬇ 导出/, '导出入口')
  assert.match(SRC, /⬆ 导入/, '导入入口')
})
