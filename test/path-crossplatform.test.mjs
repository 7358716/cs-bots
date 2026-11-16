/**
 * 跨平台路径判断（2026-11-16 Windows 实测事故）。
 *
 * ## 事故
 *   我到处写 `cwd.startsWith(`${root}/`)` 判断「是否在主目录下」。
 *   Windows 上 root 是 `C:\Users\Song\.dsh\cs-bots`，子路径是
 *   `C:\Users\Song\.dsh\cs-bots\dev\xxx`（**反斜杠**）
 *   ⇒ `startsWith('C:\Users\Song\.dsh\cs-bots/')` **永远 false**
 *   ⇒ 部门目录不登记、Bot 判定「不在主目录下」、挂载全跳过
 *   ⇒ **Win 上左侧栏什么都没有**。
 *
 * ## 这条测试怎么在 Linux 上测 Windows 路径
 *   直接给 `isInsideDir` 喂 Windows 风格的字符串。虽然 `path.relative`
 *   在 Linux 上把它当普通字符处理，但**分隔符归一化逻辑**（我做的 replace）
 *   是平台无关的，所以能验证「不再依赖硬编码 `/`」这个核心契约。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isInsideDir, isSameOrInsideDir, firstSegmentUnder } from '../src/botdirs.js'

// ── POSIX ────────────────────────────────────────────────────────────────────

test('POSIX：子路径在父目录内', () => {
  assert.equal(isInsideDir('/home/u/cs-bots', '/home/u/cs-bots/dev/x'), true)
  assert.equal(isInsideDir('/home/u/cs-bots', '/home/u/cs-bots/dev'), true)
})

test('POSIX：父目录自身不算「在里面」', () => {
  assert.equal(isInsideDir('/home/u/cs-bots', '/home/u/cs-bots'), false)
  assert.equal(isSameOrInsideDir('/home/u/cs-bots', '/home/u/cs-bots'), true)
})

test('POSIX：越界（../）不算', () => {
  assert.equal(isInsideDir('/home/u/cs-bots', '/home/u/cs-bots-other/x'), false)
  assert.equal(isInsideDir('/home/u/cs-bots', '/home/u/x'), false)
})

test('POSIX：尾部斜杠不影响判断', () => {
  assert.equal(isInsideDir('/home/u/cs-bots/', '/home/u/cs-bots/dev/'), true)
  assert.equal(isInsideDir('/home/u/cs-bots', '/home/u/cs-bots/'), false)
})

// ── Windows 风格（核心：不能再依赖硬编码 '/'）──────────────────────────────

test('★ Windows：反斜杠路径也能正确判断「在父目录内」', () => {
  assert.equal(
    isInsideDir('C:\\Users\\Song\\.dsh\\cs-bots', 'C:\\Users\\Song\\.dsh\\cs-bots\\dev\\x'),
    true,
    '硬编码 "/" 的实现会在这里失败 —— 这正是 Win 上左侧栏空白的根因',
  )
})

test('★ Windows：混合分隔符也能判断', () => {
  assert.equal(isInsideDir('C:\\Users\\Son\\.dsh\\cs-bots', 'C:\\Users\\Son\\.dsh\\cs-bots/dev/x'), true)
})

test('★ Windows：兄弟目录（前缀相同但不是子路径）不算', () => {
  assert.equal(
    isInsideDir('C:\\Users\\Song\\.dsh\\cs-bots', 'C:\\Users\\Song\\.dsh\\cs-bots-backup\\x'),
    false,
    '不能因为字符串前缀一样就当成子路径',
  )
})

test('★ Windows：取第一段（部门 id）', () => {
  assert.equal(firstSegmentUnder('C:\\Users\\Song\\.dsh\\cs-bots', 'C:\\Users\\Song\\.dsh\\cs-bots\\dev\\x'), 'dev')
  assert.equal(firstSegmentUnder('/home/u/cs-bots', '/home/u/cs-bots/qa/y'), 'qa')
})

test('firstSegmentUnder：不在内部 ⇒ null', () => {
  assert.equal(firstSegmentUnder('/a/b', '/a/c/d'), null)
  assert.equal(firstSegmentUnder('/a/b', '/a/b'), null)
})

test('非法输入一律 false / null，不抛', () => {
  for (const v of [null, undefined, '', 123, {}]) {
    assert.equal(isInsideDir(v, '/a/b'), false)
    assert.equal(isInsideDir('/a/b', v), false)
    assert.equal(firstSegmentUnder(v, '/a/b'), null)
  }
})
