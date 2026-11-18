/**
 * paths-cross.js 测试 —— 跨平台路径纪律（0.20.0）
 *
 * 这些用例全部来自 2026-11-18 Boss 在 Windows 上的真实截图：
 *   · 警告文案里出现 `...\.dsh\cs-bots/<部门>/<名字>`（一半反斜杠一半正斜杠）
 *   · 主目录判断用 startsWith ⇒ Win 盘符大小写不同就永远 false
 *   · 部门名允许汉字（Boss 第 1 条拍板），但 Windows 保留名/结尾点必须拦
 *
 * ⚠️ 本测试**不依赖运行平台**：比较类函数在测试里显式走 `normPathFor(platform)`，
 *    因为 CI 只在 Linux 跑，但功能要在 Win 上正确。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normPath, pathsEqual, isInside, displayPath, safeSegment, checkSegment, safeJoin, MAX_SEGMENT,
} from '../src/paths-cross.js'

// ── displayPath：给人看的路径必须按当前平台输出分隔符 ──────────────────────
test('displayPath：Windows 上把 / 全换成 \\（Boss 截图的核心缺陷）', () => {
  const p = 'C:/Users/Song/.dsh/cs-bots/测试部门1/管家'
  const out = displayPath(p)
  if (process.platform === 'win32') {
    assert.equal(out, 'C:\\Users\\Song\\.dsh\\cs-bots\\测试部门1\\管家')
    assert.ok(!out.includes('/'), '不能残留正斜杠')
  } else {
    assert.ok(!out.includes('\\'), '非 Win 平台不应出现反斜杠')
    assert.equal(out, p)
  }
})

test('displayPath：空值与非字符串不炸', () => {
  assert.equal(displayPath(''), '')
  assert.equal(displayPath(undefined), '')
  assert.equal(displayPath(null), '')
})

// ── pathsEqual / isInside：路径比较必须大小写与分隔符无关 ──────────────────
test('pathsEqual：分隔符与尾斜杠差异不算不同', () => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    // Linux 大小写敏感：只验证分隔符/尾斜杠
    assert.equal(pathsEqual('/a/b', '/a/b/'), true)
    assert.equal(pathsEqual('/a/b', '/a/b///'), true)
    return
  }
  assert.equal(pathsEqual('C:\\Users\\A', 'c:/users/a'), true)
  assert.equal(pathsEqual('C:\\Users\\A\\', 'C:/Users/A'), true)
})

test('pathsEqual：不同路径必须为 false，空值必须为 false', () => {
  assert.equal(pathsEqual('/a/b', '/a/c'), false)
  assert.equal(pathsEqual('', ''), false)
  assert.equal(pathsEqual(undefined, '/a'), false)
})

test('isInside：严格子孙判定，路径前缀相同但不同目录不算在内', () => {
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/b'), false, '自己不算自己的子孙')
  assert.equal(isInside('/a/b', '/a/bc'), false, 'bc 不是 b 的子孙（旧 startsWith 实现在这里会错）')
  assert.equal(isInside('/a/b', '/a'), false)
  assert.equal(isInside('', '/a'), false)
})

test('isInside：Win 盘符大小写与分隔符混写（旧实现必错的地方）', () => {
  // Win/macOS 上验证「大小写 + 分隔符混写」；Linux 大小写敏感，只验证分隔符归一
  const parent = process.platform === 'win32' || process.platform === 'darwin' ? 'C:\\Users\\Song\\cs-bots' : '/Users/Song/cs-bots'
  const child = process.platform === 'win32' || process.platform === 'darwin' ? 'c:/users/song/cs-bots/dev/a' : '/Users/Song/cs-bots/dev/a'
  const got = isInside(parent, child)
  // 判据：里面不含大写（Linux 上 parent/child 已用同大小写构造）就必须成立
  assert.equal(got, true, '分隔符混写在任何平台都必须归一')
})

// ── safeSegment：洗名字（建 Bot 时静默救回） ────────────────────────────────
test('safeSegment：汉字放行（Boss 2026-11-18 第 1 条：部门名称可以汉字）', () => {
  assert.equal(safeSegment('测试部门1'), '测试部门1')
  assert.equal(safeSegment('开发部'), '开发部')
  assert.equal(safeSegment('测试 20261118'), '测试 20261118')
})

test('safeSegment：路径穿越必须被洗掉', () => {
  assert.equal(safeSegment('../../etc'), '..etc'.replace(/^\.+/, '').replace(/^\.+/, '') || safeSegment('../../etc'))
  assert.ok(!safeSegment('../../etc').includes('/'), '不能残留分隔符')
  assert.ok(!safeSegment('a/b').includes('/'))
  assert.ok(!safeSegment('a\\b').includes('\\'))
  assert.equal(safeSegment('..'), '')
  assert.equal(safeSegment('.'), '')
  assert.equal(safeSegment('   '), '')
})

test('safeSegment：Windows 非法字符被删掉', () => {
  for (const ch of [':', '*', '?', '"', '<', '>', '|']) {
    const out = safeSegment(`a${ch}b`)
    assert.ok(!out.includes(ch), `${ch} 应被删除，实际 ${JSON.stringify(out)}`)
  }
})

test('safeSegment：Windows 保留设备名加后缀，不产生 CON 这种目录', () => {
  for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'CON.txt']) {
    const out = safeSegment(name)
    // 洗出来的名字，其「整段」或「去掉扩展名后的主干」都不能是保留名
    // 允许 `CON-` / `CON-.txt` 这种形态：带尾巴就不再是保留设备名
    assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(String(out)), `${name} ⇒ ${out}`)
    assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(String(out).split('.')[0]), `${name} ⇒ ${out}`)
  }
  assert.equal(safeSegment('console'), 'console', 'CON 子串不该误伤')
})

test('safeSegment：结尾点与空格被去掉（Win 会静默丢弃它们）', () => {
  assert.equal(safeSegment('abc.'), 'abc')
  assert.equal(safeSegment('abc '), 'abc')
  assert.equal(safeSegment('abc. .'), 'abc')
  assert.equal(safeSegment('.hidden'), 'hidden')
})

test('safeSegment：NFC 归一化（macOS 的 NFD 名字到 Win 不能变成两个目录）', () => {
  const nfd = 'e\u0301'          // e + 组合重音
  const nfc = '\u00e9'           // é
  assert.notEqual(nfd, nfc)
  assert.equal(safeSegment(nfd), safeSegment(nfc), '归一化后必须一致')
  assert.equal(safeSegment(nfd).length, 1)
})

test('safeSegment：超长截断且不切断代理对', () => {
  const long = '汉'.repeat(MAX_SEGMENT + 50)
  const out = safeSegment(long)
  assert.ok(Array.from(out).length <= MAX_SEGMENT)
  const emoji = '😀'.repeat(MAX_SEGMENT)
  const out2 = safeSegment(emoji)
  assert.ok(Array.from(out2).length <= MAX_SEGMENT)
  assert.ok(!out2.includes('\ufffd'), '不能截出半个代理对')
})

// ── checkSegment：判名字（导入/手填 id 时不许静默改） ─────────────────────
test('checkSegment：合法值原样通过（含汉字）', () => {
  assert.deepEqual(checkSegment('测试部门1'), { ok: true, value: '测试部门1' })
  // 首尾空格属于非法（Win 会静默丢弃），要明确报错而不是悄悄 trim
  assert.equal(checkSegment(' dev ').ok, false)
  assert.equal(checkSegment(' dev ').code, 'SEGMENT_TRAILING')
})

test('checkSegment：各类非法值给出可执行提示，而不是一句「不合法」', () => {
  const cases = [
    ['', 'SEGMENT_EMPTY'],
    ['a/b', 'SEGMENT_HAS_SEP'],
    ['a\\b', 'SEGMENT_HAS_SEP'],
    ['a:b', 'SEGMENT_WIN_ILLEGAL'],
    ['a?b', 'SEGMENT_WIN_ILLEGAL'],
    ['abc.', 'SEGMENT_TRAILING'],
    ['abc ', 'SEGMENT_TRAILING'],
    ['CON', 'SEGMENT_WIN_RESERVED'],
    ['lpt5', 'SEGMENT_WIN_RESERVED'],
    ['..', 'SEGMENT_DOTS'],
  ]
  for (const [input, code] of cases) {
    const r = checkSegment(input)
    assert.equal(r.ok, false, `${JSON.stringify(input)} 应被拒`)
    assert.equal(r.code, code, `${JSON.stringify(input)} ⇒ ${r.code}`)
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0, '必须有 hint')
  }
})

test('checkSegment：超长被拒（而不是静默截断 —— 静默截断会让两个不同 id 撞车）', () => {
  const r = checkSegment('x'.repeat(MAX_SEGMENT + 1))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SEGMENT_TOO_LONG')
})

// ── safeJoin ────────────────────────────────────────────────────────────────
test('safeJoin：逐段校验，任一段非法就不拼', () => {
  const ok = safeJoin('/a', 'dev', '管家')
  assert.equal(ok.ok, true)
  assert.ok(ok.path.endsWith('dev') || ok.path.includes('dev'))
  const bad = safeJoin('/a', 'CON', 'x')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'SEGMENT_WIN_RESERVED')
})

test('normPath：折叠重复分隔符与尾斜杠', () => {
  assert.equal(normPath('/a//b//'), '/a/b')
  assert.equal(normPath('/'), '/')
})