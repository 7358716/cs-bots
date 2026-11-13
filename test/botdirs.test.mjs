/**
 * botdirs.js 测试 —— 「主目录 + 部门 + Bot 名」目录派生（2026-11-13 Boss 需求）。
 *
 * 重点覆盖**路径穿越**：实测不 sanitize 时 `../../etc` 能逃出大楼。
 * 这是安全边界，测试必须硬。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeDirSegment, deriveBotCwd, departmentOfCwd, isManagedCwd } from '../src/botdirs.js'

const DEPTS = [
  { id: 'dev', name: '开发部' },
  { id: 'qa', name: '测试部' },
  { id: 'ops', name: '综合部' },
]
const ROOT = '/home/ubuntu/cs-bots'

// ── sanitizeDirSegment ────────────────────────────────────────────────────

test('sanitize：正常名字原样保留（中文/英文/数字/-/_）', () => {
  assert.equal(sanitizeDirSegment('开发执行岗'), '开发执行岗')
  assert.equal(sanitizeDirSegment('dev-bot_01'), 'dev-bot_01')
  assert.equal(sanitizeDirSegment('  前后空白  '), '前后空白')
})

test('sanitize：路径分隔符被删掉（否则能多套一层）', () => {
  assert.equal(sanitizeDirSegment('a/b'), 'ab')
  assert.equal(sanitizeDirSegment('a\\b'), 'ab')
})

test('sanitize：`..` 与 `.` 这类纯点号被剥成空', () => {
  assert.equal(sanitizeDirSegment('..'), '')
  assert.equal(sanitizeDirSegment('.'), '')
  assert.equal(sanitizeDirSegment('...'), '')
})

test('sanitize：`../../etc` 被洗成 `etc`（不再含 .. 与分隔符）', () => {
  const out = sanitizeDirSegment('../../etc')
  assert.equal(out, 'etc')
  assert.doesNotMatch(out, /\.\.|\//, '洗完不能还含 .. 或 /')
})

test('sanitize：控制字符与 Windows 保留字符被删', () => {
  assert.equal(sanitizeDirSegment('a\u0000b'), 'ab')
  assert.equal(sanitizeDirSegment('a:b*c?"d<e>f|g'), 'abcdefg')
})

test('sanitize：非字符串返回空', () => {
  assert.equal(sanitizeDirSegment(null), '')
  assert.equal(sanitizeDirSegment(undefined), '')
  assert.equal(sanitizeDirSegment(123), '')
})

// ── deriveBotCwd ──────────────────────────────────────────────────────────

test('derive：正常派生 <root>/<dept>/<name>', () => {
  const r = deriveBotCwd({ botsRoot: ROOT, departments: DEPTS, department: 'dev', botName: '开发执行岗' })
  assert.equal(r.ok, true)
  assert.equal(r.cwd, '/home/ubuntu/cs-bots/dev/开发执行岗')
  assert.equal(r.department.id, 'dev')
})

test('derive：主目录未设置 ⇒ BOT_ROOT_UNSET（引导用户先设置）', () => {
  const r = deriveBotCwd({ botsRoot: null, departments: DEPTS, department: 'dev', botName: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BOT_ROOT_UNSET')
})

test('derive：主目录非绝对路径 ⇒ BOT_ROOT_NOT_ABSOLUTE', () => {
  const r = deriveBotCwd({ botsRoot: 'relative/path', departments: DEPTS, department: 'dev', botName: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BOT_ROOT_NOT_ABSOLUTE')
})

test('derive：部门不存在 ⇒ BOT_DEPT_UNKNOWN，reason 里列出可选部门', () => {
  const r = deriveBotCwd({ botsRoot: ROOT, departments: DEPTS, department: 'nope', botName: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BOT_DEPT_UNKNOWN')
  assert.match(r.reason, /dev/, 'reason 应列出可选部门，方便用户改')
})

test('derive：Bot 名洗成空 ⇒ BOT_NAME_UNUSABLE', () => {
  const r = deriveBotCwd({ botsRoot: ROOT, departments: DEPTS, department: 'dev', botName: '..' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BOT_NAME_UNUSABLE')
})

test('derive：★ 路径穿越被拦 —— 恶意名只能落在部门目录内', () => {
  const evil = ['../../etc', '..', '../..', '../../../etc/passwd']
  for (const botName of evil) {
    const r = deriveBotCwd({ botsRoot: ROOT, departments: DEPTS, department: 'dev', botName })
    if (r.ok) {
      assert.ok(
        r.cwd.startsWith('/home/ubuntu/cs-bots/dev/'),
        `Bot 名 ${JSON.stringify(botName)} 派生出 ${r.cwd} —— 逃出了部门目录！`,
      )
    } else {
      assert.ok(['BOT_NAME_UNUSABLE', 'BOT_CWD_ESCAPED'].includes(r.code), `意外错误码 ${r.code}`)
    }
  }
})

// ── departmentOfCwd / isManagedCwd ────────────────────────────────────────

test('departmentOfCwd：能认出属于哪个部门', () => {
  const r = departmentOfCwd({ botsRoot: ROOT, departments: DEPTS, cwd: '/home/ubuntu/cs-bots/qa/测试员' })
  assert.equal(r.inside, true)
  assert.equal(r.department.id, 'qa')
})

test('departmentOfCwd：不在主目录下 ⇒ inside=false', () => {
  const r = departmentOfCwd({ botsRoot: ROOT, departments: DEPTS, cwd: '/home/ubuntu/output/散落' })
  assert.equal(r.inside, false)
})

test('isManagedCwd：三层结构且部门在字典里 ⇒ true（禁止改名）', () => {
  assert.equal(isManagedCwd({ botsRoot: ROOT, departments: DEPTS }, { cwd: '/home/ubuntu/cs-bots/dev/某岗' }), true)
})

test('isManagedCwd：不在主目录下 ⇒ false（仍可改名）', () => {
  assert.equal(isManagedCwd({ botsRoot: ROOT, departments: DEPTS }, { cwd: '/home/ubuntu/output/散落' }), false)
})

test('isManagedCwd：部门不在字典里（用户手工放的）⇒ false', () => {
  assert.equal(isManagedCwd({ botsRoot: ROOT, departments: DEPTS }, { cwd: '/home/ubuntu/cs-bots/手工目录/某岗' }), false)
})

test('isManagedCwd：层级不是正好两层 ⇒ false', () => {
  assert.equal(isManagedCwd({ botsRoot: ROOT, departments: DEPTS }, { cwd: '/home/ubuntu/cs-bots/dev/a/b' }), false)
  assert.equal(isManagedCwd({ botsRoot: ROOT, departments: DEPTS }, { cwd: '/home/ubuntu/cs-bots/dev' }), false)
})