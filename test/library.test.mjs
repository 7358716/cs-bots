/**
 * cs-bots 技能库 / 工作流库测试 —— 条目语义 + 落盘纪律。
 *
 * 为什么值得单独测：这两个库是**全局共享**的，一次静默的数据损坏或一次
 * 无声的名字覆盖，会让所有 Bot 拿到错误的能力，且事后无从复现。
 * 因此这里重点守三件事：
 *   ① 越界输入**报错**而不是被悄悄截断/改写；
 *   ② CAS 不匹配**必须**冲突，不能「后写覆盖先写」；
 *   ③ 库文件坏了**必须**报错，不能静默重置成空库。
 *
 * 纪律：只用一个临时 stateDir（mkdtempSync），结束 rmSync 清掉，
 * 不碰用户真实数据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createLibrary,
  LibraryError,
  LIMITS,
  LIBRARY_VERSION,
  SKILLS_FILE,
  WORKFLOWS_FILE,
} from '../src/library.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'library.js')

/** 每个用例一个独立 stateDir；结束自动清理。 */
function withLibrary(t, fn) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-library-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  return fn(createLibrary({}, { stateDir }), stateDir)
}

/** 断言抛出指定 code 的 LibraryError（而不是靠 message 文本）。 */
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

const skillInput = (patch = {}) => ({
  name: 'code-review',
  description: '审查代码改动',
  body: '# 代码审查\n\n1. 看边界\n2. 看错误路径',
  tags: ['review', 'quality'],
  by: 'tester',
  now: 1_700_000_000_000,
  ...patch,
})

const workflowInput = (patch = {}) => ({
  name: 'release-flow',
  description: '发版流程',
  steps: [
    { title: '冻结主干', ownerHint: 'lead' },
    { title: '跑全量测试', detail: 'node --test', done: false },
  ],
  tags: ['release'],
  by: 'tester',
  now: 1_700_000_000_000,
  ...patch,
})

// ── 1. 技能的 create / get / list + 名字唯一 ────────────────────────────────

test('技能：create → get → list 正常，且名字唯一（大小写不敏感）', (t) => {
  withLibrary(t, (lib) => {
    const created = lib.createSkill(skillInput())
    assert.equal(created.rev, 1)
    assert.equal(created.createdAt, 1_700_000_000_000)
    assert.equal(created.updatedAt, created.createdAt)
    assert.deepEqual(created.tags, ['review', 'quality'])
    assert.match(created.id, /^sk-/)

    const got = lib.getSkill(created.id)
    assert.deepEqual(got, created)
    assert.deepEqual(lib.listSkills(), [created])
    assert.equal(lib.stats().skills, 1)

    // 同大小写不同的重复名必须被拒 —— 否则落成目录时两个技能会撞同一个目录名
    throwsCode(() => lib.createSkill(skillInput({ name: 'CODE-Review' })), 'LIB_SKILL_NAME_TAKEN')
    assert.equal(lib.stats().skills, 1, '被拒的创建不得写入')
  })
})

// ── 2. 非法技能名 ──────────────────────────────────────────────────────────

test('技能：非法名字（路径穿越/带斜杠/超长）一律拒绝', (t) => {
  withLibrary(t, (lib) => {
    for (const name of ['../evil', 'a/b', '', '   ', '.hidden', 'has space', 'x'.repeat(LIMITS.name + 1)]) {
      throwsCode(() => lib.createSkill(skillInput({ name })), 'LIB_BAD_NAME')
    }
    // 合法边界：64 字符 + 允许的字符集
    const ok = lib.createSkill(skillInput({ name: 'x'.repeat(LIMITS.name) }))
    assert.equal(ok.name.length, LIMITS.name)
    assert.ok(lib.createSkill(skillInput({ name: 'A1._-ok' })).id)
  })
})

// ── 3. 技能 update 的 CAS ──────────────────────────────────────────────────

test('技能：update 走 CAS —— rev 正确则 +1，过期 rev 抛 LIB_CAS_CONFLICT', (t) => {
  withLibrary(t, (lib) => {
    const created = lib.createSkill(skillInput())

    const updated = lib.updateSkill({ id: created.id, expectedRev: 1, body: '新正文', by: 'tester', now: 1_700_000_001_000 })
    assert.equal(updated.rev, 2)
    assert.equal(updated.body, '新正文')
    assert.equal(updated.updatedAt, 1_700_000_001_000)
    assert.equal(updated.name, created.name, '未提供的字段不得被清空')

    // 过期 rev（1 已被用掉）必须冲突，且不改内存
    throwsCode(
      () => lib.updateSkill({ id: created.id, expectedRev: 1, body: '偷偷覆盖', by: 'tester' }),
      'LIB_CAS_CONFLICT',
    )
    assert.equal(lib.getSkill(created.id).body, '新正文')
    assert.equal(lib.getSkill(created.id).rev, 2)

    // expectedRev 缺失 → 参数错误（CAS 没有默认值可用）
    throwsCode(() => lib.updateSkill({ id: created.id, body: 'x', by: 'tester' }), 'LIB_BAD_FIELD')

    // 改名撞已有名字也要被拒
    const other = lib.createSkill(skillInput({ name: 'other-skill' }))
    throwsCode(
      () => lib.updateSkill({ id: other.id, expectedRev: other.rev, name: 'code-review', by: 'tester' }),
      'LIB_SKILL_NAME_TAKEN',
    )
    // 改成自己当前的名字不算冲突
    assert.equal(lib.updateSkill({ id: other.id, expectedRev: other.rev, name: 'other-skill', by: 'tester' }).rev, 2)
  })
})

// ── 4. body 上限 ───────────────────────────────────────────────────────────

test('技能：body 必填且不得超长（超长报错，不截断）', (t) => {
  withLibrary(t, (lib) => {
    throwsCode(() => lib.createSkill(skillInput({ body: '' })), 'LIB_BAD_FIELD')
    throwsCode(() => lib.createSkill(skillInput({ body: '   ' })), 'LIB_BAD_FIELD')

    const atLimit = 'x'.repeat(LIMITS.skillBody)
    const ok = lib.createSkill(skillInput({ body: atLimit }))
    assert.equal(ok.body.length, LIMITS.skillBody, '恰好到上限应接受')

    const over = throwsCode(
      () => lib.createSkill(skillInput({ name: 'body-over', body: atLimit + 'x' })),
      'LIB_TOO_LONG',
    )
    assert.equal(over.detail.length, LIMITS.skillBody + 1)

    // update 走同一条校验
    throwsCode(
      () => lib.updateSkill({ id: ok.id, expectedRev: ok.rev, body: atLimit + 'x', by: 'tester' }),
      'LIB_TOO_LONG',
    )
    assert.equal(lib.getSkill(ok.id).body.length, LIMITS.skillBody)
  })
})

// ── 5. 工作流 create / update / remove + steps 校验 ────────────────────────

test('工作流：create/update/remove 正常；steps 空、缺 title、超 50 步都被拒', (t) => {
  withLibrary(t, (lib) => {
    const created = lib.createWorkflow(workflowInput())
    assert.match(created.id, /^wf-/)
    assert.equal(created.steps.length, 2)
    assert.equal(created.steps[0].title, '冻结主干')
    assert.equal(created.steps[0].ownerHint, 'lead')
    assert.equal(created.steps[1].done, false)
    assert.equal(created.rev, 1)

    // steps 不能是空数组 / 非数组
    const bad = (name, patch) => lib.createWorkflow(workflowInput({ name, ...patch }))
    throwsCode(() => bad('wf-empty', { steps: [] }), 'LIB_STEPS_EMPTY')
    throwsCode(() => bad('wf-nosteps', { steps: undefined }), 'LIB_BAD_FIELD')
    throwsCode(() => bad('wf-notarray', { steps: 'not-array' }), 'LIB_BAD_FIELD')
    // 单步缺 title
    throwsCode(() => bad('wf-notitle', { steps: [{ detail: '没标题' }] }), 'LIB_BAD_FIELD')
    throwsCode(() => bad('wf-blanktitle', { steps: [{ title: '  ' }] }), 'LIB_BAD_FIELD')
    // 超过 50 步
    const tooMany = Array.from({ length: LIMITS.steps + 1 }, (_, i) => ({ title: `step-${i}` }))
    throwsCode(() => bad('wf-toomany', { steps: tooMany }), 'LIB_TOO_MANY')
    // 恰好 50 步可以
    const fifty = Array.from({ length: LIMITS.steps }, (_, i) => ({ title: `step-${i}` }))
    const atLimit = lib.createWorkflow(workflowInput({ name: 'full-flow', steps: fifty }))
    assert.equal(atLimit.steps.length, LIMITS.steps)

    // 名字唯一 + update（含 steps 非法时不得写入）
    throwsCode(() => lib.createWorkflow(workflowInput({ name: 'release-flow' })), 'LIB_WORKFLOW_NAME_TAKEN')
    throwsCode(
      () => lib.updateWorkflow({ id: created.id, expectedRev: 1, steps: [], by: 'tester' }),
      'LIB_STEPS_EMPTY',
    )
    assert.equal(lib.getWorkflow(created.id).rev, 1, '失败的 update 不得改 rev')

    const updated = lib.updateWorkflow({
      id: created.id,
      expectedRev: 1,
      steps: [{ title: '只留一步' }],
      tags: ['release', 'hotfix'],
      by: 'tester',
      now: 1_700_000_002_000,
    })
    assert.equal(updated.rev, 2)
    assert.equal(updated.steps.length, 1)
    assert.deepEqual(updated.tags, ['release', 'hotfix'])
    throwsCode(
      () => lib.updateWorkflow({ id: created.id, expectedRev: 1, description: 'x', by: 'tester' }),
      'LIB_CAS_CONFLICT',
    )

    // 删除：真删，删完 get 报 NOT_FOUND，再删也报 NOT_FOUND
    assert.deepEqual(lib.removeWorkflow({ id: created.id, by: 'tester' }), { id: created.id, removed: true })
    throwsCode(() => lib.getWorkflow(created.id), 'LIB_WORKFLOW_NOT_FOUND')
    throwsCode(() => lib.removeWorkflow({ id: created.id, by: 'tester' }), 'LIB_WORKFLOW_NOT_FOUND')
    assert.equal(lib.stats().workflows, 1)
  })
})

// ── 6. 持久化：新实例重新读取一致 ──────────────────────────────────────────

test('持久化：新实例从磁盘读回的内容与写入一致', (t) => {
  withLibrary(t, (lib, stateDir) => {
    const skill = lib.createSkill(skillInput())
    const workflow = lib.createWorkflow(workflowInput())

    // 落盘形态必须是 { version, items }
    const rawSkills = JSON.parse(readFileSync(join(stateDir, SKILLS_FILE), 'utf8'))
    assert.equal(rawSkills.version, LIBRARY_VERSION)
    assert.equal(rawSkills.items.length, 1)
    assert.equal(rawSkills.items[0].id, skill.id)
    const rawWorkflows = JSON.parse(readFileSync(join(stateDir, WORKFLOWS_FILE), 'utf8'))
    assert.equal(rawWorkflows.items[0].steps.length, 2)

    const reopened = createLibrary({}, { stateDir })
    assert.deepEqual(reopened.listSkills(), [skill])
    assert.deepEqual(reopened.listWorkflows(), [workflow])
    assert.deepEqual(reopened.stats(), { skills: 1, workflows: 1 })

    // replay() 从磁盘重建并返回内容
    assert.deepEqual(reopened.replay(), { skills: [skill], workflows: [workflow] })

    // 首次使用（文件都不存在）必须是空库而不是报错
    const emptyDir = join(stateDir, 'nested', 'fresh')
    const fresh = createLibrary({}, { stateDir: emptyDir })
    assert.deepEqual(fresh.stats(), { skills: 0, workflows: 0 })
    assert.deepEqual(fresh.listSkills(), [])
  })
})

// ── 7. 坏文件 → LIB_STORE_CORRUPT（不静默重置）─────────────────────────────

test('坏库文件：JSON 非法时抛 LIB_STORE_CORRUPT 且消息带路径', (t) => {
  withLibrary(t, (_lib, stateDir) => {
    const badPath = join(stateDir, SKILLS_FILE)
    writeFileSync(badPath, '{ "version": 1, "items": [ 这不是 JSON', 'utf8')

    const error = throwsCode(() => createLibrary({}, { stateDir }), 'LIB_STORE_CORRUPT')
    assert.ok(error.message.includes(badPath), `错误消息必须带文件路径，实际：${error.message}`)
    assert.equal(error.detail.file, badPath)
    // 坏文件必须原样留在磁盘上（没有被「修复」成空库）
    assert.ok(readFileSync(badPath, 'utf8').includes('这不是 JSON'))

    // 工作流库坏掉同样报错
    const dir2 = mkdtempSync(join(tmpdir(), 'cs-bots-library-bad-'))
    t.after(() => rmSync(dir2, { recursive: true, force: true }))
    writeFileSync(join(dir2, WORKFLOWS_FILE), 'null', 'utf8')
    throwsCode(() => createLibrary({}, { stateDir: dir2 }), 'LIB_STORE_CORRUPT')

    // 结构不对（items 不是数组）也不当成空库
    const dir3 = mkdtempSync(join(tmpdir(), 'cs-bots-library-shape-'))
    t.after(() => rmSync(dir3, { recursive: true, force: true }))
    writeFileSync(join(dir3, SKILLS_FILE), JSON.stringify({ version: 1, items: {} }), 'utf8')
    throwsCode(() => createLibrary({}, { stateDir: dir3 }), 'LIB_STORE_CORRUPT')
  })
})

// ── 8. tag 过滤 ────────────────────────────────────────────────────────────

test('tag 过滤：技能与工作流都支持，大小写不敏感，无命中返回空数组', (t) => {
  withLibrary(t, (lib) => {
    const a = lib.createSkill(skillInput({ name: 'skill-a', tags: ['Review', 'exec'] }))
    const b = lib.createSkill(skillInput({ name: 'skill-b', tags: ['docs'] }))
    lib.createSkill(skillInput({ name: 'skill-c', tags: [] }))

    assert.deepEqual(lib.listSkills({ tag: 'review' }).map((s) => s.id), [a.id])
    assert.deepEqual(lib.listSkills({ tag: 'Exec' }).map((s) => s.id), [a.id])
    assert.deepEqual(lib.listSkills({ tag: 'docs' }).map((s) => s.id), [b.id])
    assert.deepEqual(lib.listSkills({ tag: 'nope' }), [])
    assert.equal(lib.listSkills().length, 3, '不带 tag 时返回全部')

    const wf1 = lib.createWorkflow(workflowInput({ name: 'wf-a', tags: ['release'] }))
    lib.createWorkflow(workflowInput({ name: 'wf-b', tags: ['ops'] }))
    assert.deepEqual(lib.listWorkflows({ tag: 'release' }).map((w) => w.id), [wf1.id])
    assert.equal(lib.listWorkflows().length, 2)
  })
})

// ── 9. stats ───────────────────────────────────────────────────────────────

test('stats：数量与增删一致；paths/dispose 等通用能力齐备', (t) => {
  withLibrary(t, (lib, stateDir) => {
    assert.deepEqual(lib.stats(), { skills: 0, workflows: 0 })
    const s1 = lib.createSkill(skillInput({ name: 's1' }))
    lib.createSkill(skillInput({ name: 's2' }))
    lib.createWorkflow(workflowInput({ name: 'w1' }))
    assert.deepEqual(lib.stats(), { skills: 2, workflows: 1 })

    lib.removeSkill({ id: s1.id, by: 'tester' })
    throwsCode(() => lib.getSkill(s1.id), 'LIB_SKILL_NOT_FOUND')
    assert.deepEqual(lib.stats(), { skills: 1, workflows: 1 })

    // paths 指向两个确定的库文件
    assert.equal(lib.paths.stateDir, stateDir)
    assert.equal(lib.paths.skillsFile, join(stateDir, SKILLS_FILE))
    assert.equal(lib.paths.workflowsFile, join(stateDir, WORKFLOWS_FILE))
    assert.ok(existsSync(lib.paths.skillsFile))
    assert.ok(existsSync(lib.paths.workflowsFile))

    // dispose 必须存在，且之后拒绝继续用（避免半死对象被当成正常实例）
    assert.equal(typeof lib.dispose, 'function')
    lib.dispose()
    throwsCode(() => lib.listSkills(), 'LIB_DISPOSED')
  })
})

// ── 10. 零依赖 ─────────────────────────────────────────────────────────────

// 待查字面量必须**拼**出来：若整个字面量出现在本文件里，这条检查会自己抓自己
const SCOPE = '@deepseek' + '-ai/'
const REQUIRE_CALL = 'requ' + 'ire('

test('零依赖：库文件不得引用第三方模块（含 ' + SCOPE + '）', () => {

  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, '')

  for (const file of [SRC, join(HERE, 'library.test.mjs')]) {
    const code = stripComments(readFileSync(file, 'utf8'))
    assert.equal(code.includes(SCOPE), false, `${file} 出现了 ${SCOPE} 引用`)
    assert.equal(code.includes(REQUIRE_CALL), false, `${file} 出现了 CommonJS require 调用`)
  }

  // 只允许 node: 内置模块与相对路径
  const specifiers = [...stripComments(readFileSync(SRC, 'utf8')).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.ok(specifiers.length > 0)
  for (const spec of specifiers) {
    assert.ok(
      spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
      `${SRC} 引用了非内置模块：${spec}`,
    )
  }
})
