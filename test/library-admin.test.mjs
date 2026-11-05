/**
 * cs-bots 技能管理器测试（特性⑩：来源分层 / 启停 / 自定义目录 / 目录树浏览）。
 *
 * 为什么单独一组：这批能力的风险点在**边界**上，而不是在 happy path：
 *   ① 老数据没有 source/enabled 字段，读取必须补缺省而不是把库判成损坏；
 *   ② 「禁用」必须是可逆的、清单缺省不露出，否则用户以为技能被删了；
 *   ③ 自定义目录来自用户手输的绝对路径 —— 敏感目录（~/.dsh、~/.ssh、/etc…）
 *      与符号链接绕过必须被挡住，否则等于把密钥目录挂进浏览/编辑入口；
 *   ④ 目录树浏览要「只读 + 单层 + 有界」：越界、超大目录、不可读文件都不能
 *      让整页崩掉（一个坏文件不该毁掉整个列表）。
 *
 * 纪律：只用一个临时 stateDir + 临时技能目录（mkdtempSync），结束 rmSync 清掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  createLibrary,
  LibraryError,
  SKILL_DIRS_FILE,
  SKILL_SOURCES,
  SKILLS_FILE,
} from '../src/library.js'

const NOW = 1_700_000_000_000

/** 每个用例一个独立 stateDir；结束自动清理。 */
function withLibrary(t, fn) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-lib-admin-'))
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

/** 建一个临时技能根目录，返回路径（结束自动清理）。 */
function withSkillsRoot(t, fn) {
  const root = mkdtempSync(join(tmpdir(), 'cs-bots-skill-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return fn(root)
}

/** 在 root 下写一个 `<name>/SKILL.md`。 */
function writeSkillFile(root, name, body = '# 正文', description = '') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const text = [
    '---',
    `name: ${name}`,
    description ? `description: ${JSON.stringify(description)}` : '',
    '---',
    '',
    body,
  ].filter((line, index) => !(index === 2 && line === '')).join('\n')
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
  return dir
}

const skillInput = (patch = {}) => ({
  name: 'code-review',
  description: '审查代码改动',
  body: '# 代码审查\n\n1. 看边界',
  tags: ['review'],
  by: 'tester',
  now: NOW,
  ...patch,
})

// ── 1. 模型扩展：source / enabled（新建/更新）───────────────────────────────

test('createSkill：source 缺省 custom、enabled 缺省 true', (t) => {
  withLibrary(t, (lib, stateDir) => {
    const skill = lib.createSkill(skillInput())
    assert.equal(skill.source, 'custom')
    assert.equal(skill.enabled, true)
    // 落盘必须带上新字段（老代码重启后不能丢分类）
    const disk = JSON.parse(readFileSync(join(stateDir, SKILLS_FILE), 'utf8'))
    assert.equal(disk.items[0].source, 'custom')
    assert.equal(disk.items[0].enabled, true)
    // 四条来源都收
    for (const [index, source] of SKILL_SOURCES.entries()) {
      const created = lib.createSkill(skillInput({ name: `skill-${index}`, source }))
      assert.equal(created.source, source)
    }
  })
})

test('createSkill：非法 source / enabled 抛 LIB_BAD_FIELD（不静默改写）', (t) => {
  withLibrary(t, (lib) => {
    throwsCode(() => lib.createSkill(skillInput({ source: 'imported' })), 'LIB_BAD_FIELD')
    throwsCode(() => lib.createSkill(skillInput({ enabled: 'yes' })), 'LIB_BAD_FIELD')
    // 失败的创建不得留下条目
    assert.equal(lib.listSkills({ all: true }).length, 0)
  })
})

test('updateSkill：可改 source/enabled；不传则保持原值', (t) => {
  withLibrary(t, (lib) => {
    const skill = lib.createSkill(skillInput({ source: 'project', enabled: false }))
    const updated = lib.updateSkill({
      id: skill.id, expectedRev: 1, description: '改说明', by: 'tester', now: NOW + 10,
    })
    assert.equal(updated.rev, 2)
    assert.equal(updated.source, 'project', '不传 source 时必须保持')
    assert.equal(updated.enabled, false, '不传 enabled 时必须保持')
    // 显式传才改
    const toggled = lib.updateSkill({
      id: skill.id, expectedRev: 2, source: 'user', enabled: true, by: 'tester', now: NOW + 20,
    })
    assert.equal(toggled.source, 'user')
    assert.equal(toggled.enabled, true)
    assert.equal(toggled.rev, 3)
  })
})

// ── 2. 启用 / 停用 ─────────────────────────────────────────────────────────

test('setSkillEnabled：禁用后缺省列表不返回，显式加回', (t) => {
  withLibrary(t, (lib, stateDir) => {
    const a = lib.createSkill(skillInput({ name: 'skill-a' }))
    lib.createSkill(skillInput({ name: 'skill-b' }))

    const off = lib.setSkillEnabled({ id: a.id, enabled: false, by: 'tester', expectedRev: 1, now: NOW + 100 })
    assert.equal(off.enabled, false)
    assert.equal(off.rev, 2)
    assert.equal(off.updatedAt, NOW + 100)

    // 缺省视图不露出禁用项
    assert.deepEqual(lib.listSkills().map((s) => s.name), ['skill-b'])
    // 只看禁用
    assert.deepEqual(lib.listSkills({ enabled: false }).map((s) => s.name), ['skill-a'])
    // 全都要
    assert.deepEqual(lib.listSkills({ all: true }).map((s) => s.name), ['skill-a', 'skill-b'])
    // 只看启用
    assert.deepEqual(lib.listSkills({ enabled: true }).map((s) => s.name), ['skill-b'])

    // 落盘：禁用状态不是内存假象
    const disk = JSON.parse(readFileSync(join(stateDir, SKILLS_FILE), 'utf8'))
    assert.equal(disk.items.find((s) => s.id === a.id).enabled, false)

    // 再启用回来
    const on = lib.setSkillEnabled({ id: a.id, enabled: true, by: 'tester', expectedRev: 2, now: NOW + 200 })
    assert.equal(on.enabled, true)
    assert.equal(on.rev, 3)
    assert.equal(lib.listSkills().length, 2)
  })
})

test('setSkillEnabled：CAS 冲突 / 缺参 / 不存在的 id', (t) => {
  withLibrary(t, (lib) => {
    const skill = lib.createSkill(skillInput())
    throwsCode(
      () => lib.setSkillEnabled({ id: skill.id, enabled: false, by: 'tester', expectedRev: 2 }),
      'LIB_CAS_CONFLICT',
    )
    throwsCode(() => lib.setSkillEnabled({ id: skill.id, by: 'tester', expectedRev: 1 }), 'LIB_BAD_FIELD')
    throwsCode(() => lib.setSkillEnabled({ id: skill.id, enabled: false, expectedRev: 1 }), 'LIB_BAD_FIELD')
    throwsCode(
      () => lib.setSkillEnabled({ id: 'sk-nope', enabled: false, by: 'tester', expectedRev: 1 }),
      'LIB_SKILL_NOT_FOUND',
    )
    // 失败的调用不得改 rev
    assert.equal(lib.getSkill(skill.id).rev, 1)
  })
})

// ── 3. 来源分层 ────────────────────────────────────────────────────────────

test('setSkillSource：改来源并可过滤；非法值被拒', (t) => {
  withLibrary(t, (lib) => {
    const a = lib.createSkill(skillInput({ name: 'skill-a' }))
    lib.createSkill(skillInput({ name: 'skill-b', source: 'bundled' }))

    const changed = lib.setSkillSource({ id: a.id, source: 'project', by: 'tester', expectedRev: 1, now: NOW + 5 })
    assert.equal(changed.source, 'project')
    assert.equal(changed.rev, 2)
    assert.deepEqual(lib.listSkills({ source: 'project' }).map((s) => s.name), ['skill-a'])
    assert.deepEqual(lib.listSkills({ source: 'bundled' }).map((s) => s.name), ['skill-b'])
    assert.deepEqual(lib.listSkills({ source: 'user' }), [])

    throwsCode(() => lib.setSkillSource({ id: a.id, source: 'mine', by: 'tester', expectedRev: 2 }), 'LIB_BAD_FIELD')
    throwsCode(() => lib.setSkillSource({ id: a.id, by: 'tester', expectedRev: 2 }), 'LIB_BAD_FIELD')
    throwsCode(() => lib.setSkillSource({ id: a.id, source: 'user', by: 'tester', expectedRev: 1 }), 'LIB_CAS_CONFLICT')
  })
})

test('listSkills：query 搜名字/说明/标签/正文；limit 截断；非法参数报错', (t) => {
  withLibrary(t, (lib) => {
    lib.createSkill(skillInput({ name: 'alpha', description: '第一条', tags: ['review'], body: '正文甲' }))
    lib.createSkill(skillInput({ name: 'beta', description: '部署相关', tags: ['ops'], body: '正文乙' }))
    lib.createSkill(skillInput({ name: 'gamma', description: '第三条', tags: ['review'], body: '看看端口占用' }))

    assert.deepEqual(lib.listSkills({ query: 'ALPHA' }).map((s) => s.name), ['alpha'])
    assert.deepEqual(lib.listSkills({ query: '部署' }).map((s) => s.name), ['beta'])
    assert.deepEqual(lib.listSkills({ query: 'ops' }).map((s) => s.name), ['beta'])
    assert.deepEqual(lib.listSkills({ query: '端口' }).map((s) => s.name), ['gamma'])
    assert.deepEqual(lib.listSkills({ query: '   ' }).length, 3, '空白 query 等于不筛')
    assert.deepEqual(lib.listSkills({ query: 'zzz' }), [])

    assert.deepEqual(lib.listSkills({ limit: 2 }).map((s) => s.name), ['alpha', 'beta'])
    assert.equal(lib.listSkills({ limit: 1 }).length, 1)
    throwsCode(() => lib.listSkills({ limit: 0 }), 'LIB_BAD_FIELD')
    throwsCode(() => lib.listSkills({ limit: 1.5 }), 'LIB_BAD_FIELD')
    throwsCode(() => lib.listSkills({ enabled: 'true' }), 'LIB_BAD_FIELD')
    throwsCode(() => lib.listSkills({ all: 'yes' }), 'LIB_BAD_FIELD')
    throwsCode(() => lib.listSkills({ source: 'nope' }), 'LIB_BAD_FIELD')
    throwsCode(() => lib.listSkills({ query: 42 }), 'LIB_BAD_FIELD')
  })
})

// ── 4. 老数据向后兼容 ──────────────────────────────────────────────────────

test('老数据（无 source/enabled）：读取补缺省，写入后归一落盘', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-lib-admin-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  writeFileSync(join(stateDir, SKILLS_FILE), JSON.stringify({
    version: 1,
    items: [{
      id: 'sk-old-1',
      name: 'old-skill',
      description: '老格式',
      body: '老正文',
      tags: ['legacy'],
      createdAt: NOW - 1000,
      updatedAt: NOW - 1000,
      rev: 1,
    }],
  }), 'utf8')

  const lib = createLibrary({}, { stateDir })
  const [old] = lib.listSkills()
  assert.equal(old.name, 'old-skill')
  assert.equal(old.source, 'custom', '老数据缺省视为 custom')
  assert.equal(old.enabled, true, '老数据缺省视为启用')

  // 禁用一次 → 记录归一后落盘，旧数据被补上字段
  lib.setSkillEnabled({ id: old.id, enabled: false, by: 'tester', expectedRev: 1, now: NOW })
  const disk = JSON.parse(readFileSync(join(stateDir, SKILLS_FILE), 'utf8'))
  assert.equal(disk.items[0].source, 'custom')
  assert.equal(disk.items[0].enabled, false)
})

test('老数据里 source/enabled 值非法 → LIB_STORE_CORRUPT（不猜、不改写）', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-lib-admin-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  writeFileSync(join(stateDir, SKILLS_FILE), JSON.stringify({
    version: 1,
    items: [{ id: 'sk-bad', name: 'bad-skill', body: 'x', source: 'weird', enabled: 'yes', createdAt: 1, updatedAt: 1, rev: 1 }],
  }), 'utf8')
  throwsCode(() => createLibrary({}, { stateDir }), 'LIB_STORE_CORRUPT')
})

// ── 5. 导出跳过禁用项 ──────────────────────────────────────────────────────

test('exportSkills：禁用的技能不导出（显式给 id 也跳过）', (t) => {
  withLibrary(t, (lib) => {
    const on = lib.createSkill(skillInput({ name: 'enabled-skill' }))
    const off = lib.createSkill(skillInput({ name: 'disabled-skill' }))
    lib.setSkillEnabled({ id: off.id, enabled: false, by: 'tester', expectedRev: 1, now: NOW + 1 })

    const all = lib.exportSkills({})
    assert.equal(all.count, 1)
    assert.match(all.markdown, /name: enabled-skill/)
    assert.doesNotMatch(all.markdown, /disabled-skill/)

    // 显式点名禁用项：也跳过（不因为它被点名就导出）
    const named = lib.exportSkills({ ids: [off.id] })
    assert.equal(named.count, 0)
    assert.equal(named.markdown, '')

    // 启用项照常可导
    const namedOn = lib.exportSkills({ ids: [on.id] })
    assert.equal(namedOn.count, 1)
  })
})

test('importSkills：对象条目可带 source/enabled；overwrite 不重置已有启停状态', (t) => {
  withLibrary(t, (lib) => {
    const result = lib.importSkills({
      items: [{ name: 'project-skill', body: '正文', source: 'project', enabled: false }],
      by: 'tester',
      now: NOW,
    })
    assert.equal(result.created[0].source, 'project')
    assert.equal(result.created[0].enabled, false)
    assert.deepEqual(lib.listSkills(), [], '禁用技能不出现在缺省列表')
    assert.deepEqual(lib.listSkills({ source: 'project', all: true }).map((s) => s.name), ['project-skill'])

    // overwrite 只覆盖正文，不该顺手把停用状态改成启用
    const overwrite = lib.importSkills({
      items: [{ name: 'project-skill', body: '新正文' }],
      by: 'tester',
      mode: 'overwrite',
      now: NOW + 10,
    })
    assert.equal(overwrite.updated[0].enabled, false)
    assert.equal(overwrite.updated[0].source, 'project')
    assert.equal(overwrite.updated[0].body, '新正文')
  })
})

// ── 6. 自定义技能目录：增删 / 探测 / 持久化 ────────────────────────────────

test('addSkillDir / listSkillDirs：登记真实目录并实时探测 exists/skillCount', (t) => {
  withLibrary(t, (lib, stateDir) => {
    withSkillsRoot(t, (root) => {
      writeSkillFile(root, 'alpha')
      writeSkillFile(root, 'beta')

      const added = lib.addSkillDir({ dir: root, by: 'tester', now: NOW })
      assert.equal(added.added, realpathSync(root))
      assert.equal(added.dirs.length, 1)
      const [entry] = added.dirs
      assert.equal(entry.dir, realpathSync(root))
      assert.equal(entry.label, basename(root), '缺省 label = 目录名')
      assert.equal(entry.addedAt, NOW)
      assert.equal(entry.exists, true)
      assert.equal(entry.skillCount, 2)

      // listSkillDirs 返回同样的形状（UI 依赖这些字段）
      assert.deepEqual(Object.keys(lib.listSkillDirs()[0]).sort(), ['addedAt', 'dir', 'exists', 'label', 'skillCount'])

      // 目录内容变化后是**实时**反映的，不是缓存
      writeSkillFile(root, 'gamma')
      assert.equal(lib.listSkillDirs()[0].skillCount, 3)

      // 清单落盘（同目录、独立文件）
      const disk = JSON.parse(readFileSync(join(stateDir, SKILL_DIRS_FILE), 'utf8'))
      assert.equal(disk.items.length, 1)
      assert.equal(disk.items[0].dir, realpathSync(root))

      // 目录被移走 → exists:false，但不清掉登记（用户可能只是临时拔了移动盘）
      rmSync(root, { recursive: true, force: true })
      const after = lib.listSkillDirs()[0]
      assert.equal(after.exists, false)
      assert.equal(after.skillCount, 0)
    })
  })
})

test('addSkillDir：重复登记 / 相对路径 / 不存在 / 非目录 都被拒', (t) => {
  withLibrary(t, (lib) => {
    withSkillsRoot(t, (root) => {
      lib.addSkillDir({ dir: root, by: 'tester', now: NOW })
      throwsCode(() => lib.addSkillDir({ dir: root, by: 'tester', now: NOW + 1 }), 'LIB_DIR_EXISTS')
      throwsCode(() => lib.addSkillDir({ dir: 'relative/path', by: 'tester' }), 'LIB_BAD_DIR')
      throwsCode(() => lib.addSkillDir({ dir: join(root, 'nope'), by: 'tester' }), 'LIB_BAD_DIR')
      writeFileSync(join(root, 'plain.txt'), 'x', 'utf8')
      throwsCode(() => lib.addSkillDir({ dir: join(root, 'plain.txt'), by: 'tester' }), 'LIB_BAD_DIR')
      throwsCode(() => lib.addSkillDir({ dir: root }), 'LIB_BAD_FIELD')
      throwsCode(() => lib.addSkillDir({ by: 'tester' }), 'LIB_BAD_DIR')
      // label 校验
      throwsCode(() => lib.addSkillDir({ dir: join(root, 'sub'), label: '', by: 'tester' }), 'LIB_BAD_DIR')
      mkdirSync(join(root, 'sub'), { recursive: true })
      throwsCode(() => lib.addSkillDir({ dir: join(root, 'sub'), label: '', by: 'tester' }), 'LIB_BAD_FIELD')
      throwsCode(() => lib.addSkillDir({ dir: join(root, 'sub'), label: 'x'.repeat(200), by: 'tester' }), 'LIB_TOO_LONG')
      const named = lib.addSkillDir({ dir: join(root, 'sub'), label: '我的技能', by: 'tester', now: NOW + 2 })
      assert.equal(named.dirs.find((d) => d.label === '我的技能').dir, realpathSync(join(root, 'sub')))
    })
  })
})

test('addSkillDir：敏感目录（系统/凭据/主目录）一律拒绝，含符号链接绕过', (t) => {
  withLibrary(t, (lib) => {
    for (const dir of ['/', '/etc', '/proc', '/sys', '/dev', '/root', '/usr', homedir(), join(homedir(), '.ssh'), join(homedir(), '.dsh')]) {
      // 安全属性是「一律 LIB_BAD_DIR」；原因文案会随「目录不存在」或「受保护」变化，
      // 所以文案断言只放在确定性路径上（不把环境差异写进测试）
      throwsCode(() => lib.addSkillDir({ dir, by: 'tester' }), 'LIB_BAD_DIR')
    }
    // 确定性敏感路径：/etc 必然存在且必然受保护
    const etcError = throwsCode(() => lib.addSkillDir({ dir: '/etc', by: 'tester' }), 'LIB_BAD_DIR')
    assert.match(etcError.message, /受保护|拒绝/)
    const homeError = throwsCode(() => lib.addSkillDir({ dir: homedir(), by: 'tester' }), 'LIB_BAD_DIR')
    assert.match(homeError.message, /主目录/)
    // /etc/passwd 是文件（即便它在受保护目录里，也先按文件/敏感拒绝）
    throwsCode(() => lib.addSkillDir({ dir: '/etc/passwd', by: 'tester' }), 'LIB_BAD_DIR')

    // 符号链接绕过：/tmp/xxx/ssh-link -> ~/.ssh，realpath 后必须仍被拒
    withSkillsRoot(t, (root) => {
      try {
        symlinkSync(join(homedir(), '.ssh'), join(root, 'ssh-link'), 'dir')
      } catch {
        t.diagnostic('当前环境无法创建符号链接，跳过该断言')
        return
      }
      throwsCode(() => lib.addSkillDir({ dir: join(root, 'ssh-link'), by: 'tester' }), 'LIB_BAD_DIR')
      // 同一个链接如果指向普通目录则允许（证明拒绝来自目标而不是「链接」本身）
      const plainTarget = join(root, 'plain-target')
      mkdirSync(plainTarget)
      try {
        symlinkSync(plainTarget, join(root, 'plain-link'), 'dir')
      } catch {
        return
      }
      const ok = lib.addSkillDir({ dir: join(root, 'plain-link'), by: 'tester', now: NOW })
      assert.equal(ok.dirs.length, 1)
    })
  })
})

test('removeSkillDir：取消登记、持久化；未登记报 LIB_DIR_NOT_FOUND；不动磁盘', (t) => {
  withLibrary(t, (lib, stateDir) => {
    withSkillsRoot(t, (root) => {
      writeSkillFile(root, 'alpha')
      lib.addSkillDir({ dir: root, by: 'tester', now: NOW })

      const removed = lib.removeSkillDir({ dir: root, by: 'tester' })
      assert.deepEqual(removed.dirs, [])
      assert.deepEqual(lib.listSkillDirs(), [])
      // 只取消登记，目录与文件必须原样还在
      assert.ok(readFileSync(join(root, 'alpha', 'SKILL.md'), 'utf8').includes('alpha'))
      throwsCode(() => lib.removeSkillDir({ dir: root, by: 'tester' }), 'LIB_DIR_NOT_FOUND')
      throwsCode(() => lib.removeSkillDir({ dir: root }), 'LIB_BAD_FIELD')

      // 重启后仍然是「已取消」状态
      const reopened = createLibrary({}, { stateDir })
      assert.deepEqual(reopened.listSkillDirs(), [])
    })
  })
})

test('scanAllSkillDirs：聚合所有登记目录的条目与错误（不自动入库）', (t) => {
  withLibrary(t, (lib) => {
    withSkillsRoot(t, (rootA) => {
      withSkillsRoot(t, (rootB) => {
        writeSkillFile(rootA, 'alpha', 'A 正文')
        writeSkillFile(rootA, 'beta', 'B 正文')
        writeSkillFile(rootB, 'gamma', 'C 正文')
        // 一个坏技能文件：只进 errors，不影响其它条目
        mkdirSync(join(rootB, 'broken'), { recursive: true })
        writeFileSync(join(rootB, 'broken', 'SKILL.md'), '---\nname: broken\n没闭合 fence', 'utf8')

        lib.addSkillDir({ dir: rootA, label: 'A 目录', by: 'tester', now: NOW })
        lib.addSkillDir({ dir: rootB, label: 'B 目录', by: 'tester', now: NOW + 1 })

        const out = lib.scanAllSkillDirs()
        assert.equal(out.items.length, 3)
        assert.deepEqual(out.items.map((s) => s.name), ['alpha', 'beta', 'gamma'])
        assert.equal(out.items[0].dir, realpathSync(rootA))
        assert.equal(out.items[0].dirLabel, 'A 目录')
        assert.equal(out.errors.length, 1)
        assert.match(out.errors[0].path, /broken/)
        assert.equal(out.errors[0].dir, realpathSync(rootB))
        assert.deepEqual(out.dirs.map((d) => d.label), ['A 目录', 'B 目录'])
        // 全程不得入库
        assert.equal(lib.listSkills({ all: true }).length, 0)

        // 扫描结果可直接导入（端到端）
        const imported = lib.importSkills({ items: out.items, by: 'tester', now: NOW + 2 })
        assert.equal(imported.created.length, 3)
        assert.deepEqual(imported.created.map((s) => s.source), ['custom', 'custom', 'custom'])
      })
    })
  })
})

test('scanAllSkillDirs：目录消失 → errors 里可见，不抛', (t) => {
  withLibrary(t, (lib) => {
    withSkillsRoot(t, (root) => {
      writeSkillFile(root, 'alpha')
      lib.addSkillDir({ dir: root, by: 'tester', now: NOW })
      rmSync(root, { recursive: true, force: true })
      const out = lib.scanAllSkillDirs()
      assert.deepEqual(out.items, [])
      assert.equal(out.errors.length, 1)
      assert.match(out.errors[0].reason, /LIB_BAD_DIR/)
      assert.equal(out.dirs[0].exists, false)
    })
  })
})

// ── 7. 目录树浏览 ──────────────────────────────────────────────────────────

test('browseSkillDir：只读浏览已登记目录，目录在前、字段齐全', (t) => {
  withLibrary(t, (lib) => {
    withSkillsRoot(t, (root) => {
      writeSkillFile(root, 'alpha')
      mkdirSync(join(root, 'notes'), { recursive: true })
      writeFileSync(join(root, 'notes', 'readme.md'), '说明', 'utf8')
      writeFileSync(join(root, 'top.md'), '顶层文件', 'utf8')
      lib.addSkillDir({ dir: root, by: 'tester', now: NOW })

      const out = lib.browseSkillDir({ dir: root })
      assert.equal(out.path, realpathSync(root))
      assert.equal(out.truncated, false)
      assert.deepEqual(Object.keys(out.entries[0]).sort(), ['mtime', 'name', 'readable', 'size', 'type'])
      // 目录在前
      assert.deepEqual(out.entries.map((e) => `${e.type}:${e.name}`), ['dir:alpha', 'dir:notes', 'file:top.md'])
      const top = out.entries.find((e) => e.name === 'top.md')
      assert.equal(top.readable, true)
      assert.ok(top.size > 0)
      assert.ok(top.mtime > 0)

      // 进入子目录
      const sub = lib.browseSkillDir({ dir: root, sub: 'notes' })
      assert.equal(sub.path, realpathSync(join(root, 'notes')))
      assert.deepEqual(sub.entries.map((e) => e.name), ['readme.md'])
    })
  })
})

test('browseSkillDir：越界 / 未登记 / 不存在 / 不是目录 都被拒', (t) => {
  withLibrary(t, (lib) => {
    withSkillsRoot(t, (root) => {
      withSkillsRoot(t, (outside) => {
        writeSkillFile(root, 'alpha')
        lib.addSkillDir({ dir: root, by: 'tester', now: NOW })

        throwsCode(() => lib.browseSkillDir({ dir: outside }), 'LIB_BAD_DIR')       // 未登记
        throwsCode(() => lib.browseSkillDir({ dir: join(root, 'nope') }), 'LIB_BAD_DIR') // 不存在
        throwsCode(() => lib.browseSkillDir({ dir: root, sub: '../..' }), 'LIB_BAD_DIR') // 上跳
        throwsCode(() => lib.browseSkillDir({ dir: root, sub: join(outside, 'x') }), 'LIB_BAD_DIR') // 绝对路径
        throwsCode(() => lib.browseSkillDir({ dir: root, sub: 'alpha/SKILL.md' }), 'LIB_BAD_DIR') // 不是目录
        throwsCode(() => lib.browseSkillDir({ dir: root, sub: 42 }), 'LIB_BAD_FIELD')
        throwsCode(() => lib.browseSkillDir({}), 'LIB_BAD_DIR')

        // 「只允许已登记目录及其子目录」：把子目录当 dir 传也不行
        throwsCode(() => lib.browseSkillDir({ dir: join(root, 'alpha') }), 'LIB_BAD_DIR')
      })
    })
  })
})

test('browseSkillDir：符号链接指向登记目录之外 → 越界拒绝', (t) => {
  withLibrary(t, (lib) => {
    withSkillsRoot(t, (root) => {
      withSkillsRoot(t, (outside) => {
        writeFileSync(join(outside, 'secret.txt'), '不该被看到', 'utf8')
        writeSkillFile(root, 'alpha')
        try {
          symlinkSync(outside, join(root, 'escape'), 'dir')
        } catch {
          t.skip('当前环境无法创建符号链接')
          return
        }
        lib.addSkillDir({ dir: root, by: 'tester', now: NOW })
        const error = throwsCode(() => lib.browseSkillDir({ dir: root, sub: 'escape' }), 'LIB_BAD_DIR')
        assert.match(error.message, /越界/)
        // 目录里「指向登记目录内部」的链接是允许的
        symlinkSync(join(root, 'alpha'), join(root, 'self-link'), 'dir')
        const ok = lib.browseSkillDir({ dir: root, sub: 'self-link' })
        assert.equal(ok.path, realpathSync(join(root, 'alpha')))
      })
    })
  })
})

test('browseSkillDir：不可读文件标 readable:false、不抛；超大目录 truncated', (t) => {
  withLibrary(t, (lib) => {
    withSkillsRoot(t, (root) => {
      try {
        symlinkSync(join(root, 'definitely-missing-target'), join(root, 'broken-link'), 'file')
      } catch {
        t.skip('当前环境无法创建符号链接')
        return
      }
      writeFileSync(join(root, 'secret.txt'), 'x', 'utf8')
      chmodSync(join(root, 'secret.txt'), 0o000)
      lib.addSkillDir({ dir: root, by: 'tester', now: NOW })

      const out = lib.browseSkillDir({ dir: root })
      const broken = out.entries.find((e) => e.name === 'broken-link')
      assert.equal(broken.readable, false, '断链必须标不可读而不是让整页崩')
      const secret = out.entries.find((e) => e.name === 'secret.txt')
      // 非 root 用户才能验证权限位；root 会绕过文件权限，此时跳过该断言
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        assert.equal(secret.readable, false)
      }
    })
  })
})

test('browseSkillDir：单层超过 500 条时 truncated=true 且只返回 500 条', (t) => {
  withLibrary(t, (lib) => {
    withSkillsRoot(t, (root) => {
      for (let i = 0; i < 505; i += 1) {
        writeFileSync(join(root, `f-${String(i).padStart(3, '0')}.md`), 'x', 'utf8')
      }
      lib.addSkillDir({ dir: root, by: 'tester', now: NOW })
      const out = lib.browseSkillDir({ dir: root })
      assert.equal(out.truncated, true)
      assert.equal(out.entries.length, 500)
      assert.equal(out.entries[0].name, 'f-000.md')
    })
  })
})

// ── 8. replay / 实例能力 ───────────────────────────────────────────────────

test('replay：来源/启停/目录清单都从磁盘恢复', (t) => {
  withLibrary(t, (lib, stateDir) => {
    withSkillsRoot(t, (root) => {
      const skill = lib.createSkill(skillInput({ source: 'bundled' }))
      lib.setSkillEnabled({ id: skill.id, enabled: false, by: 'tester', expectedRev: 1, now: NOW + 1 })
      lib.addSkillDir({ dir: root, label: '我的', by: 'tester', now: NOW + 2 })
      // 清掉内存态前，先确认 replay 是磁盘重建
      const replayed = lib.replay()
      assert.equal(replayed.skills[0].source, 'bundled')
      assert.equal(replayed.skills[0].enabled, false)
      assert.deepEqual(lib.listSkills(), [], '禁用项不在缺省列表')
      assert.deepEqual(lib.listSkills({ all: true }).map((s) => s.source), ['bundled'])
      assert.deepEqual(lib.listSkillDirs().map((d) => d.label), ['我的'])

      // 新实例（进程重启）同样恢复
      const reopened = createLibrary({}, { stateDir })
      assert.equal(reopened.listSkills({ all: true })[0].enabled, false)
      assert.deepEqual(reopened.listSkillDirs().map((d) => d.dir), [realpathSync(root)])
    })
  })
})

test('新增实例方法齐备；dispose 之后全部拒绝', (t) => {
  withLibrary(t, (lib) => {
    for (const key of ['setSkillEnabled', 'setSkillSource', 'addSkillDir', 'removeSkillDir', 'listSkillDirs', 'scanAllSkillDirs', 'browseSkillDir']) {
      assert.equal(typeof lib[key], 'function', `${key} 必须是实例方法`)
    }
    assert.equal(typeof lib.paths.skillDirsFile, 'string')
    lib.dispose()
    throwsCode(() => lib.listSkillDirs(), 'LIB_DISPOSED')
    throwsCode(() => lib.scanAllSkillDirs(), 'LIB_DISPOSED')
    throwsCode(() => lib.browseSkillDir({ dir: '/tmp' }), 'LIB_DISPOSED')
    throwsCode(() => lib.setSkillEnabled({ id: 'x', enabled: false, by: 't', expectedRev: 1 }), 'LIB_DISPOSED')
  })
})
