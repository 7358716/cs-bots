/**
 * cs-bots Bot 档案测试 —— 身份 / 经验 / 技能 / 预制记忆 的落盘语义。
 *
 * 为什么单独测：档案靠**改写用户目录里的 AGENTS.md** 生效。
 * 一旦我们手滑覆盖了用户手写的内容，就是不可逆的数据损失 ——
 * 所以「只动托管段、段外原样保留」必须被机械守住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeProfile,
  writeAgentsFile,
  readAgentsFile,
  writeSkill,
  listSkills,
  renderManagedSection,
  assertWritableCwd,
  ProfileError,
  MARK_BEGIN,
  MARK_END,
  AGENTS_FILE,
  SKILLS_DIR,
  LIMITS,
} from '../src/botprofile.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cs-bots-prof-'))
}

// ── 校验 ─────────────────────────────────────────────────────────────────────

test('normalizeProfile 只取认识字段，其余忽略', () => {
  const out = normalizeProfile({ identity: '我是 A', experience: '规矩 B', skills: ['s1'], memory: ['m1'], junk: 1 })
  assert.deepEqual(out, { identity: '我是 A', experience: '规矩 B', skills: ['s1'], memory: ['m1'] })
})

test('identity 超长必须抛错（不静默截断）', () => {
  assert.throws(
    () => normalizeProfile({ identity: 'x'.repeat(LIMITS.identity + 1) }),
    (e) => e instanceof ProfileError && e.code === 'PROFILE_TOO_LONG',
  )
})

test('skills 非法类型/过多/单项超长都抛错', () => {
  assert.throws(() => normalizeProfile({ skills: 'not-array' }), (e) => e.code === 'PROFILE_BAD_FIELD')
  assert.throws(
    () => normalizeProfile({ skills: Array.from({ length: LIMITS.skillsCount + 1 }, (_, i) => `s${i}`) }),
    (e) => e.code === 'PROFILE_TOO_MANY',
  )
  assert.throws(() => normalizeProfile({ skills: ['x'.repeat(65)] }), (e) => e.code === 'PROFILE_TOO_LONG')
})

test('cwd 必须是存在的绝对路径', () => {
  assert.throws(() => assertWritableCwd('relative/path'), (e) => e.code === 'PROFILE_BAD_CWD')
  assert.throws(() => assertWritableCwd('/definitely/not/here-xyz'), (e) => e.code === 'PROFILE_BAD_CWD')
  const dir = tmp()
  try {
    assert.equal(assertWritableCwd(dir), assertWritableCwd(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── AGENTS.md 托管段 ─────────────────────────────────────────────────────────

test('首次写入：创建 AGENTS.md 且含托管段标记', () => {
  const dir = tmp()
  try {
    const r = writeAgentsFile(dir, { identity: '我是后端', experience: '先写迁移', botName: '后端' })
    assert.equal(r.created, true)
    assert.equal(r.hadManaged, false)
    const text = readFileSync(r.path, 'utf8')
    assert.ok(text.includes(MARK_BEGIN))
    assert.ok(text.includes(MARK_END))
    assert.match(text, /我是后端/)
    assert.match(text, /先写迁移/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 段外用户手写内容必须原样保留', () => {
  const dir = tmp()
  try {
    const file = join(dir, AGENTS_FILE)
    writeFileSync(file, '# 用户自己的说明\n\n这一段是我手写的，绝对不能被覆盖。\n', 'utf8')

    writeAgentsFile(dir, { identity: '机器写的身份' })
    let text = readFileSync(file, 'utf8')
    assert.match(text, /这一段是我手写的，绝对不能被覆盖。/, '用户内容必须还在')
    assert.match(text, /机器写的身份/)

    // 再写一次（更新托管段）——用户内容仍要在，且托管段只有一份
    writeAgentsFile(dir, { identity: '改过的身份' })
    text = readFileSync(file, 'utf8')
    assert.match(text, /这一段是我手写的，绝对不能被覆盖。/, '第二次写也不能吃掉用户内容')
    assert.match(text, /改过的身份/)
    assert.ok(!text.includes('机器写的身份'), '旧托管段应被替换')
    assert.equal(text.split(MARK_BEGIN).length - 1, 1, '托管段必须只有一份')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAgentsFile 能分离托管段与段外内容', () => {
  const dir = tmp()
  try {
    const file = join(dir, AGENTS_FILE)
    writeFileSync(file, '用户前置说明\n', 'utf8')
    writeAgentsFile(dir, { identity: '身份甲', skills: ['review'] })

    const r = readAgentsFile(dir)
    assert.equal(r.exists, true)
    assert.match(r.managed, /身份甲/)
    assert.match(r.managed, /review/)
    assert.match(r.outside, /用户前置说明/)
    assert.ok(!r.outside.includes(MARK_BEGIN), '段外内容不该含标记')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有 AGENTS.md 时 readAgentsFile 返回 exists=false（不抛）', () => {
  const dir = tmp()
  try {
    const r = readAgentsFile(dir)
    assert.equal(r.exists, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('用户文件里有残缺标记时，不吞掉用户内容', () => {
  const dir = tmp()
  try {
    const file = join(dir, AGENTS_FILE)
    writeFileSync(file, `我的内容\n${MARK_BEGIN}\n没写完的段落\n`, 'utf8')
    writeAgentsFile(dir, { identity: '新身份' })
    const text = readFileSync(file, 'utf8')
    assert.match(text, /我的内容/, '残缺标记下用户内容仍要保留')
    assert.match(text, /新身份/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderManagedSection 渲染四块内容', () => {
  const md = renderManagedSection({
    botName: '前端',
    preset: 'standard',
    identity: '我是前端',
    experience: '别改后端',
    skills: ['a', 'b'],
    memory: ['生产库只读'],
  })
  assert.match(md, /前端/)
  assert.match(md, /我是前端/)
  assert.match(md, /别改后端/)
  assert.match(md, /`a`/)
  assert.match(md, /生产库只读/)
  assert.ok(md.startsWith(MARK_BEGIN))
  assert.ok(md.trimEnd().endsWith(MARK_END))
})

// ── 技能落盘 ─────────────────────────────────────────────────────────────────

test('writeSkill 写到 .agents/skills/<名>/SKILL.md，含 frontmatter', () => {
  const dir = tmp()
  try {
    const r = writeSkill(dir, 'code-review', { description: '代码评审', body: '# 评审\n\n先看测试。' })
    assert.ok(existsSync(r.file))
    assert.ok(r.file.includes(join(SKILLS_DIR, 'code-review')))
    const text = readFileSync(r.file, 'utf8')
    assert.match(text, /^---/)
    assert.match(text, /name: code-review/)
    assert.match(text, /先看测试/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 技能名禁止路径穿越', () => {
  const dir = tmp()
  try {
    for (const bad of ['../evil', 'a/b', '..', '', 'x y', '.hidden']) {
      assert.throws(
        () => writeSkill(dir, bad, { body: 'x' }),
        (e) => e instanceof ProfileError && e.code === 'PROFILE_BAD_SKILL_NAME',
        `技能名 ${JSON.stringify(bad)} 必须被拒`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listSkills 只列出含 SKILL.md 的目录', () => {
  const dir = tmp()
  try {
    writeSkill(dir, 'good-one', { body: 'x' })
    writeSkill(dir, 'good-two', { body: 'y' })
    mkdirSync(join(dir, SKILLS_DIR, 'empty-dir'), { recursive: true })
    const names = listSkills(dir).sort()
    assert.deepEqual(names, ['good-one', 'good-two'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('技能正文超长抛错', () => {
  const dir = tmp()
  try {
    assert.throws(
      () => writeSkill(dir, 'big', { body: 'x'.repeat(LIMITS.skillBody + 1) }),
      (e) => e.code === 'PROFILE_TOO_LONG',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── t-46 缺陷#4：空身份必须能被调用方发现 ────────────────────────────────
// 过去空档案只渲染「_（未填写身份描述）_」，无任何告警。
// 实测后果：空档案 Bot 与有档案 Bot 共用 cwd 时，后者 142 行身份说明被覆盖成 10 行。

test('writeAgentsFile：档案有 identity ⇒ identityMissing=false', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-id-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const out = writeAgentsFile(dir, { identity: '我是测试岗', botName: 'x', preset: 'dev-steward' })
  assert.equal(out.identityMissing, false, '有身份时不该标缺失')
})

test('writeAgentsFile：档案无 identity ⇒ identityMissing=true（调用方可据此告警）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-noid-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const out = writeAgentsFile(dir, { botName: 'x', preset: 'dev-steward' })
  assert.equal(out.identityMissing, true, '空身份必须如实标记，否则覆盖别人也没人知道')
  const text = readFileSync(out.path, 'utf8')
  assert.match(text, /未填写身份描述/, '文件里仍是占位符（渲染行为不变）')
})
