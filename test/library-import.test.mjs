/**
 * cs-bots 技能导入/导出测试（DESIGN-v2 特性 ⑤）。
 *
 * 为什么单独一组：导入/导出是**外部数据入口**，坏数据是常态（别的机器导出的、
 * 手写的、从 npm 包扒的）。这里重点守四件事：
 *   ① frontmatter 该严的地方严（坏语法必须抛 LIB_BAD_SKILL_MD，不静默猜）；
 *   ② 该宽松的地方宽松（没 frontmatter 时用目录名兜底，真实手写技能常漏 name）；
 *   ③ 批量导入「单条坏、整批不停」，但错误必须逐条可见（errors 不空）；
 *   ④ 导出能被自己解析回来（往返一致），否则备份/迁移就是假的。
 *
 * 纪律：只用一个临时 stateDir / 临时技能目录（mkdtempSync），结束 rmSync 清掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createLibrary,
  EXPORT_SEPARATOR,
  LibraryError,
  LIMITS,
  parseSkillMarkdown,
  scanSkillsDir,
  SKILLS_FILE,
} from '../src/library.js'

/** 每个用例一个独立 stateDir；结束自动清理。 */
function withLibrary(t, fn) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-lib-import-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  return fn(createLibrary({}, { stateDir }), stateDir)
}

/** 断言抛出指定 code 的 LibraryError（靠 code 而不是 message 文本）。 */
function throwsCode(fn, code) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof LibraryError, `期望抛出 LibraryError，实际：${caught}`)
  assert.equal(caught.code, code, `期望 code=${code}，实际 ${caught.code}：${caught.message}`)
  return caught
}

const NOW = 1_700_000_000_000

const md = (name, body = '# 说明\n\n正文', extra = '') => [
  '---',
  `name: ${name}`,
  'description: 一句话说明',
  'tags: [alpha, beta]',
  extra,
  '---',
  '',
  body,
].filter((line) => line !== '').join('\n')

// ── parseSkillMarkdown：有 / 无 / 坏 frontmatter ──────────────────────────────

test('parseSkillMarkdown：标准 frontmatter 解析出四个字段', () => {
  const text = [
    '---',
    'name: code-review',
    'description: "审查代码改动：关注边界与错误路径"',
    'tags: [review, quality]',
    '---',
    '',
    '# 代码审查',
    '',
    '1. 看边界',
    '2. 看错误路径',
  ].join('\n')
  const parsed = parseSkillMarkdown({ text, filename: '/tmp/skills/code-review/SKILL.md' })
  assert.equal(parsed.name, 'code-review')
  assert.equal(parsed.description, '审查代码改动：关注边界与错误路径')
  assert.deepEqual(parsed.tags, ['review', 'quality'])
  assert.equal(parsed.body, '# 代码审查\n\n1. 看边界\n2. 看错误路径')
})

test('parseSkillMarkdown：tags 也支持裸逗号分隔（无方括号）', () => {
  const text = '---\nname: tag-demo\ntags: a, b ,c\n---\n正文'
  const parsed = parseSkillMarkdown({ text })
  assert.deepEqual(parsed.tags, ['a', 'b', 'c'])
})

test('parseSkillMarkdown：含逗号的 tag 用引号包住不会被劈开', () => {
  const text = '---\nname: tag-demo\ntags: ["a,b", plain]\n---\n正文'
  const parsed = parseSkillMarkdown({ text })
  assert.deepEqual(parsed.tags, ['a,b', 'plain'])
})

test('parseSkillMarkdown：无 frontmatter 时用文件名兜底（不报错）', () => {
  const parsed = parseSkillMarkdown({ text: '\n# 只有正文\n\n做法……\n', filename: '/tmp/skills/standalone.md' })
  assert.equal(parsed.name, 'standalone')
  assert.equal(parsed.description, '')
  assert.deepEqual(parsed.tags, [])
  assert.equal(parsed.body, '# 只有正文\n\n做法……')
})

test('parseSkillMarkdown：无 frontmatter 且文件名是 SKILL.md 时取目录名', () => {
  const parsed = parseSkillMarkdown({ text: '正文', filename: '/tmp/skills/dir-named-skill/SKILL.md' })
  assert.equal(parsed.name, 'dir-named-skill')
})

test('parseSkillMarkdown：无 frontmatter 且无 filename → LIB_BAD_SKILL_MD', () => {
  throwsCode(() => parseSkillMarkdown({ text: '只有正文' }), 'LIB_BAD_SKILL_MD')
})

test('parseSkillMarkdown：frontmatter 未闭合 → LIB_BAD_SKILL_MD', () => {
  const err = throwsCode(() => parseSkillMarkdown({ text: '---\nname: broken\n正文' }), 'LIB_BAD_SKILL_MD')
  assert.match(err.message, /未闭合/)
})

test('parseSkillMarkdown：frontmatter 行不是 key: value → LIB_BAD_SKILL_MD', () => {
  throwsCode(
    () => parseSkillMarkdown({ text: '---\nname: broken\n这一行没有冒号\n---\n正文' }),
    'LIB_BAD_SKILL_MD',
  )
})

test('parseSkillMarkdown：未知 frontmatter 键忽略（真实技能常带扩展键）', () => {
  const parsed = parseSkillMarkdown({
    text: '---\nname: ext-skill\nlicense: MIT\nallowed-tools: [Read]\n---\n正文',
  })
  assert.equal(parsed.name, 'ext-skill')
  assert.equal(parsed.body, '正文')
})

test('parseSkillMarkdown：实例上也挂了同名方法（DESIGN 要求返回对象导出）', (t) => {
  withLibrary(t, (library) => {
    for (const key of ['parseSkillMarkdown', 'importSkills', 'scanSkillsDir', 'exportSkills']) {
      assert.equal(typeof library[key], 'function', `${key} 必须是实例方法`)
    }
  })
})

test('parseSkillMarkdown：非字符串 text 属于调用错误（LIB_BAD_FIELD）', () => {
  throwsCode(() => parseSkillMarkdown({ text: 123 }), 'LIB_BAD_FIELD')
})

// ── importSkills：三种 mode ──────────────────────────────────────────────────

test('importSkills：空库批量创建（mode 缺省 skip 等价于全新建）', (t) => {
  withLibrary(t, (library) => {
    const result = library.importSkills({
      items: [
        { name: 'skill-a', description: 'A', body: 'AAA', tags: ['a'] },
        { name: 'skill-b', body: 'BBB' },
      ],
      by: 'tester',
      now: NOW,
    })
    assert.equal(result.created.length, 2)
    assert.equal(result.updated.length, 0)
    assert.equal(result.skipped.length, 0)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.created.map((s) => s.name), ['skill-a', 'skill-b'])
    assert.equal(result.created[0].rev, 1)
    assert.equal(result.created[0].createdAt, NOW)
    assert.equal(library.listSkills().length, 2)
  })
})

test('importSkills：mode=skip 同名跳过，不动已有条目', (t) => {
  withLibrary(t, (library, stateDir) => {
    const first = library.createSkill({ name: 'code-review', description: '旧描述', body: '旧正文', by: 'tester', now: NOW - 1000 })
    const result = library.importSkills({
      items: [{ name: 'code-review', description: '新描述', body: '新正文' }],
      by: 'tester',
      mode: 'skip',
      now: NOW,
    })
    assert.deepEqual(result.created, [])
    assert.deepEqual(result.updated, [])
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].id, first.id)
    assert.equal(result.skipped[0].name, 'code-review')

    const stored = library.getSkill(first.id)
    assert.equal(stored.description, '旧描述')
    assert.equal(stored.body, '旧正文')
    assert.equal(stored.rev, 1)

    // 落盘也要是旧的（不能内存跳过了、磁盘却写了新的）
    const disk = JSON.parse(readFileSync(join(stateDir, SKILLS_FILE), 'utf8'))
    assert.equal(disk.items.length, 1)
    assert.equal(disk.items[0].body, '旧正文')
  })
})

test('importSkills：mode=overwrite 覆盖内容且 rev+1', (t) => {
  withLibrary(t, (library, stateDir) => {
    const first = library.createSkill({ name: 'code-review', description: '旧描述', body: '旧正文', tags: ['old'], by: 'tester', now: NOW - 1000 })
    const result = library.importSkills({
      items: [{ name: 'code-review', description: '新描述', body: '新正文', tags: ['new'] }],
      by: 'tester',
      mode: 'overwrite',
      now: NOW,
    })
    assert.equal(result.updated.length, 1)
    const updated = result.updated[0]
    assert.equal(updated.id, first.id)
    assert.equal(updated.rev, 2)
    assert.equal(updated.description, '新描述')
    assert.equal(updated.body, '新正文')
    assert.deepEqual(updated.tags, ['new'])
    assert.equal(updated.updatedAt, NOW)

    // 落盘校验（writeJsonAtomic 真的写了）
    const disk = JSON.parse(readFileSync(join(stateDir, SKILLS_FILE), 'utf8'))
    assert.equal(disk.items.length, 1)
    assert.equal(disk.items[0].rev, 2)
    assert.equal(disk.items[0].body, '新正文')
  })
})

test('importSkills：mode=rename 加 -2，-2 也占用时加 -3', (t) => {
  withLibrary(t, (library) => {
    library.createSkill({ name: 'code-review', body: 'v1', by: 'tester', now: NOW - 3000 })
    library.createSkill({ name: 'code-review-2', body: 'v2', by: 'tester', now: NOW - 2000 })
    const result = library.importSkills({
      items: [{ name: 'code-review', body: 'v3' }],
      by: 'tester',
      mode: 'rename',
      now: NOW,
    })
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].name, 'code-review-3')
    assert.equal(result.created[0].body, 'v3')
    assert.equal(library.listSkills().length, 3)
  })
})

test('importSkills：rename 在名字空闲时不改名', (t) => {
  withLibrary(t, (library) => {
    const result = library.importSkills({ items: [{ name: 'fresh-skill', body: 'x' }], by: 'tester', mode: 'rename', now: NOW })
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].name, 'fresh-skill')
  })
})

test('importSkills：mode 非法直接抛 LIB_BAD_FIELD；items 非数组同', (t) => {
  withLibrary(t, (library) => {
    throwsCode(() => library.importSkills({ items: [], by: 'tester', mode: 'merge' }), 'LIB_BAD_FIELD')
    throwsCode(() => library.importSkills({ items: 'not-array', by: 'tester' }), 'LIB_BAD_FIELD')
    throwsCode(() => library.importSkills({ items: [] }), 'LIB_BAD_FIELD')
  })
})

// ── importSkills：非法条目与部分失败 ────────────────────────────────────────

test('importSkills：非法 kebab 名进 errors，同批合法条目照常创建', (t) => {
  withLibrary(t, (library) => {
    const result = library.importSkills({
      items: [
        { name: 'Bad_Name', body: 'x' },        // 下划线 + 大写：非法
        { name: 'good-one', body: 'y' },        // 合法
        { name: 'has space', body: 'z' },       // 空格：非法
      ],
      by: 'tester',
      now: NOW,
    })
    assert.deepEqual(result.created.map((s) => s.name), ['good-one'])
    assert.equal(result.errors.length, 2)
    assert.deepEqual(result.errors.map((e) => e.name), ['Bad_Name', 'has space'])
    for (const entry of result.errors) {
      assert.match(entry.reason, /LIB_BAD_NAME/)
    }
  })
})

test('importSkills：body 超长进 errors，不中断整批', (t) => {
  withLibrary(t, (library) => {
    const result = library.importSkills({
      items: [
        { name: 'too-long', body: 'x'.repeat(LIMITS.skillBody + 1) },
        { name: 'fine', body: 'ok' },
      ],
      by: 'tester',
      now: NOW,
    })
    assert.deepEqual(result.created.map((s) => s.name), ['fine'])
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].name, 'too-long')
    assert.match(result.errors[0].reason, /LIB_TOO_LONG/)
  })
})

test('importSkills：坏 SKILL.md 原文进 errors，且后续条目继续', (t) => {
  withLibrary(t, (library) => {
    const result = library.importSkills({
      items: [
        '---\nname: unclosed\n正文',                      // 坏：frontmatter 未闭合
        { text: md('from-md'), filename: '/tmp/x/SKILL.md' }, // 好：带 text 的对象
        { name: 'plain', body: 'ok' },                       // 好：直接给字段
      ],
      by: 'tester',
      now: NOW,
    })
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].name, '#0')
    assert.match(result.errors[0].reason, /LIB_BAD_SKILL_MD/)
    assert.deepEqual(result.created.map((s) => s.name), ['from-md', 'plain'])
  })
})

test('importSkills：条目缺 body 也算单条错误（overwrite 不许静默不改）', (t) => {
  withLibrary(t, (library) => {
    library.createSkill({ name: 'keep-me', body: '原有正文', by: 'tester', now: NOW - 1000 })
    const result = library.importSkills({
      items: [{ name: 'keep-me' }],
      by: 'tester',
      mode: 'overwrite',
      now: NOW,
    })
    assert.equal(result.updated.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].reason, /LIB_BAD_FIELD/)
    // 原有条目一个字节都没变
    assert.equal(library.listSkills()[0].body, '原有正文')
    assert.equal(library.listSkills()[0].rev, 1)
  })
})

test('importSkills：非对象/非字符串条目进 errors', (t) => {
  withLibrary(t, (library) => {
    const result = library.importSkills({ items: [null, 42, ['x'], { name: 'ok-one', body: 'b' }], by: 'tester', now: NOW })
    assert.equal(result.errors.length, 3)
    assert.equal(result.created.length, 1)
  })
})

test('importSkills：同一批里重复名字按 mode 处理（skip 第二次跳过）', (t) => {
  withLibrary(t, (library) => {
    const result = library.importSkills({
      items: [{ name: 'dup', body: '1' }, { name: 'dup', body: '2' }],
      by: 'tester',
      mode: 'skip',
      now: NOW,
    })
    assert.equal(result.created.length, 1)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.created[0].body, '1')
  })
})

// ── exportSkills + 往返 ────────────────────────────────────────────────────

test('exportSkills→parseSkillMarkdown 往返一致（含多技能分隔）', (t) => {
  withLibrary(t, (library) => {
    const a = library.createSkill({
      name: 'skill-a',
      description: '带冒号: 和"引号"的说明',
      body: '# A\n\n- 一\n- 二',
      tags: ['alpha', 'a,b'],
      by: 'tester',
      now: NOW - 2000,
    })
    const b = library.createSkill({
      name: 'skill-b',
      description: '',
      body: '只有正文',
      tags: [],
      by: 'tester',
      now: NOW - 1000,
    })

    const { markdown, count } = library.exportSkills({ ids: [a.id, b.id] })
    assert.equal(count, 2)

    const chunks = markdown.split(EXPORT_SEPARATOR)
    assert.equal(chunks.length, 2)

    const backA = parseSkillMarkdown({ text: chunks[0] })
    assert.equal(backA.name, a.name)
    assert.equal(backA.description, a.description)
    assert.equal(backA.body, a.body)
    assert.deepEqual(backA.tags, ['alpha', 'a,b'])

    const backB = parseSkillMarkdown({ text: chunks[1] })
    assert.equal(backB.name, b.name)
    assert.equal(backB.description, '')
    assert.equal(backB.body, b.body)
    assert.deepEqual(backB.tags, [])
  })
})

test('exportSkills：ids 省略时导出全部；未知 id 抛 LIB_SKILL_NOT_FOUND', (t) => {
  withLibrary(t, (library) => {
    library.createSkill({ name: 'one', body: '1', by: 'tester', now: NOW - 1000 })
    library.createSkill({ name: 'two', body: '2', by: 'tester', now: NOW - 900 })

    const all = library.exportSkills({})
    assert.equal(all.count, 2)
    assert.equal(all.markdown.split(EXPORT_SEPARATOR).length, 2)

    throwsCode(() => library.exportSkills({ ids: ['sk-not-exist'] }), 'LIB_SKILL_NOT_FOUND')
    throwsCode(() => library.exportSkills({ ids: 'sk-1' }), 'LIB_BAD_FIELD')
  })
})

test('exportSkills：重复 id 只导一份（count 可信）', (t) => {
  withLibrary(t, (library) => {
    const only = library.createSkill({ name: 'only', body: '1', by: 'tester', now: NOW - 1000 })
    const out = library.exportSkills({ ids: [only.id, only.id] })
    assert.equal(out.count, 1)
  })
})

// ── scanSkillsDir：读真实临时目录 ───────────────────────────────────────────

test('scanSkillsDir：扫描真实目录（目录式 + 单文件式 + 坏文件）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cs-bots-skills-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  mkdirSync(join(root, 'alpha'), { recursive: true })
  writeFileSync(join(root, 'alpha', 'SKILL.md'), md('alpha', '# Alpha\n\n正文'), 'utf8')
  writeFileSync(join(root, 'beta.md'), '---\nname: beta\ndescription: 单文件式\n---\n# Beta', 'utf8')
  mkdirSync(join(root, 'broken'), { recursive: true })
  writeFileSync(join(root, 'broken', 'SKILL.md'), '---\nname: broken\n正文没有结束 fence', 'utf8')
  mkdirSync(join(root, 'notes'), { recursive: true })            // 无 SKILL.md：应静默跳过
  writeFileSync(join(root, 'notes', 'readme.md'), '不是技能', 'utf8')
  mkdirSync(join(root, '.git'), { recursive: true })             // 隐藏目录：跳过
  writeFileSync(join(root, 'ignore.txt'), 'x', 'utf8')           // 非 md：跳过

  const { items, errors } = scanSkillsDir({ dir: root })
  assert.deepEqual(items.map((s) => s.name), ['alpha', 'beta'])
  assert.equal(items[0].body, '# Alpha\n\n正文')
  assert.equal(items[1].description, '单文件式')
  assert.equal(items[0].sourcePath, join(root, 'alpha', 'SKILL.md'))
  assert.equal(errors.length, 1)
  assert.equal(errors[0].path, join(root, 'broken', 'SKILL.md'))
  assert.match(errors[0].reason, /LIB_BAD_SKILL_MD/)
})

test('scanSkillsDir：不存在的目录 / 非目录 → LIB_BAD_DIR（不静默返回空）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cs-bots-skills-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'not-a-dir.txt')
  writeFileSync(file, 'x', 'utf8')
  throwsCode(() => scanSkillsDir({ dir: join(root, 'nope') }), 'LIB_BAD_DIR')
  throwsCode(() => scanSkillsDir({ dir: file }), 'LIB_BAD_DIR')
  throwsCode(() => scanSkillsDir({}), 'LIB_BAD_DIR')
})

test('scanSkillsDir：符号链接的技能目录也能扫到（Dirent 会误判）', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'cs-bots-symlink-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const realDir = join(base, 'shared-skills', 'linked-real')
  mkdirSync(realDir, { recursive: true })
  writeFileSync(join(realDir, 'SKILL.md'), md('linked-real', '链接来的正文'), 'utf8')
  const root = join(base, 'root')
  mkdirSync(root)
  try {
    symlinkSync(realDir, join(root, 'linked-real'), 'dir')
  } catch {
    t.skip('当前平台/文件系统不支持符号链接')
    return
  }
  const { items, errors } = scanSkillsDir({ dir: root })
  assert.equal(errors.length, 0)
  assert.deepEqual(items.map((s) => s.name), ['linked-real'])
  assert.equal(items[0].body, '链接来的正文')
})

test('scanSkillsDir 的纯读取结果可直接喂给 importSkills（端到端）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cs-bots-skills-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'alpha'), { recursive: true })
  writeFileSync(join(root, 'alpha', 'SKILL.md'), md('alpha', 'A 正文', 'tags: [x, y]'), 'utf8')
  writeFileSync(join(root, 'beta.md'), '---\nname: beta\n---\nB 正文', 'utf8')

  withLibrary(t, (library) => {
    const scanned = library.scanSkillsDir({ dir: root })
    assert.equal(scanned.items.length, 2)

    // 扫描本身不写库
    assert.equal(library.listSkills().length, 0)

    const result = library.importSkills({ items: scanned.items, by: 'tester', now: NOW })
    assert.deepEqual(result.created.map((s) => s.name), ['alpha', 'beta'])
    assert.deepEqual(result.created[0].tags, ['x', 'y'])
    assert.equal(result.created[1].body, 'B 正文')
    assert.equal(library.listSkills().length, 2)
  })
})
