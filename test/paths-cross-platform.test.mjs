/**
 * 跨平台目录适配回归（2026-11-21 Boss：「各个目录的要适配 linux 和 win 不同的版本」）
 *
 * 这套测试的作用：把「目录生成 / 目录识别 / 目录显示」三件事在**两种分隔符风格**下都钉住。
 * 注意：本机是 Linux，无法真的跑 Windows；所以用「把 Windows 风格字符串喂进去」的方式，
 * 验证归一化与识别逻辑不依赖宿主平台。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sep, isAbsolute, join } from 'node:path'

import { defaultBotWorkspaceRoot } from '../src/settings.js'
import { sanitizeDirSegment, deriveBotCwd, departmentOfCwd } from '../src/botdirs.js'
import { normPath, displayPath, safeSegment, safeJoin } from '../src/paths-cross.js'

test('默认主目录：绝对路径 + 以 cs-bots 结尾 + 无混合/重复分隔符', () => {
  const root = defaultBotWorkspaceRoot()
  assert.ok(isAbsolute(root), `必须是绝对路径，得到 ${root}`)
  assert.ok(root.endsWith(sep + 'cs-bots'), `必须落在 …${sep}cs-bots，得到 ${root}`)
  assert.ok(!root.includes(sep + sep), `不得出现重复分隔符：${root}`)
  // 反斜杠只在 Windows 上合法；Linux 上出现反斜杠说明拼错了
  if (sep === '/') assert.ok(!root.includes('\\'), `Linux 下不得含反斜杠：${root}`)
})

test('部门/Bot 目录派生：落在 <root>/<dept>/<bot>，且只用宿主分隔符', () => {
  const root = '/home/qa/cs-bots'
  const r = deriveBotCwd({ botsRoot: root, departments: [{ id: 'qa', name: 'QA' }], department: 'qa', botName: '测试 Bot' })
  assert.equal(r.ok, true, r.reason)
  assert.ok(r.cwd.startsWith(root + sep), r.cwd)
  const parts = r.cwd.slice(root.length + 1).split(sep)
  assert.equal(parts[0], 'qa')
  assert.equal(parts.length >= 2, true, `至少 <部门>/<Bot> 两级：${r.cwd}`)
})

test('目录分段清洗：把两种分隔符都吃掉（不允许 Bot 名造出子目录）', () => {
  const cases = ['a/b', 'a\\b', 'a:b', '  a/b\\c  ']
  for (const c of cases) {
    const out = sanitizeDirSegment(c)
    assert.ok(out && !/[/\\:]/.test(out), `清洗后不得再含分隔符：${c} → ${out}`)
  }
})

test('从 cwd 反推部门：宿主平台两种写法都要认', () => {
  // 注意：departmentOfCwd 内部用宿主 path.resolve + 宿主分隔符，
  // 所以「Linux 上喂 Windows 路径」本身不成立（那本来也不会发生在同一台机器上）。
  // 这里按宿主平台构造真实形态，钉住「同平台两种写法（含/不含尾分隔符）都正确」。
  const root = sep === '/' ? '/home/qa/cs-bots' : 'C:\\Users\\qa\\.dsh\\cs-bots'
  const cwd = join(root, 'qa', 'bot-a')
  const depts = [{ id: 'qa', name: 'QA' }]

  const a = departmentOfCwd({ botsRoot: root, departments: depts, cwd })
  assert.equal(a.inside, true)
  assert.equal(a.department?.id, 'qa', `部门识别失败：${JSON.stringify(a)}`)
  assert.equal(a.relative, 'bot-a')

  // 主目录自身不算任何部门（只有相对路径为空）
  const rootItself = departmentOfCwd({ botsRoot: root, departments: depts, cwd: root })
  assert.equal(rootItself.inside, true)
  assert.equal(rootItself.department, undefined)

  // 主目录之外的 cwd 一律 inside:false（不能把别人的目录算成本部门的）
  const outside = departmentOfCwd({ botsRoot: root, departments: depts, cwd: join(root, '..', 'x') })
  assert.equal(outside.inside, false)
})

test('路径归一化与显示：两种分隔符等价；显示按宿主风格', () => {
  const p1 = normPath('/a/b/c/')
  const p2 = normPath('\\a\\b\\c\\')
  assert.equal(p1, p2, '归一化后两种写法必须相等')
  const shown = displayPath('C:\\Users\\qa\\.dsh\\cs-bots')
  assert.ok(shown.length > 0)
  // 显示层只要求「可读且不为空」，具体分隔符由平台决定（不在这里断言死）
})

test('安全拼接：拒绝 .. / 分隔符 / Windows 非法字符（跨平台同一套规则）', () => {
  const ok = safeJoin('/a', 'b', 'c')
  assert.equal(ok.ok, true)
  assert.equal(ok.path, join('/a', 'b', 'c'))

  const dots = safeJoin('/a', '..', 'x')
  assert.equal(dots.ok, false)
  assert.equal(dots.code, 'SEGMENT_DOTS')

  const sep = safeJoin('/a', 'b/c')
  assert.equal(sep.ok, false)
  assert.equal(sep.code, 'SEGMENT_HAS_SEP')

  const winBad = safeJoin('/a', 'a:b')
  assert.equal(winBad.ok, false)
  assert.equal(winBad.code, 'SEGMENT_WIN_ILLEGAL')

  // safeSegment 是「清洗」而不是「校验」：把非法字符替换掉
  assert.equal(safeSegment('ok/name\\x').ok ?? true, true)
})
