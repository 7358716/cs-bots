/**
 * cs-bots 目录浏览器测试 —— 给 Web UI 开的「文件系统口子」必须被机械守住。
 *
 * 这个模块的输入直接来自浏览器请求，调用方**不可信**。所以测试的重点不是
 * "功能能用"，而是"越界一定被拒"：路径穿越、非法名、写到允许范围外、
 * 把 Bot 工作目录指到宿主配置目录上 —— 任何一条漏掉都是真实事故。
 *
 * 约定：每个 case 用 mkdtempSync 造独立目录，跑完即删；不碰真实的 ~/.dsh。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { createDirBrowser, DirBrowseError, MAX_ENTRIES, NAME_PATTERN } from '../src/dirbrowse.js'

/** 造一个独立临时目录（每个 case 一个，互不影响）。 */
function tmp() {
  return mkdtempSync(join(tmpdir(), 'cs-bots-dirbrowse-'))
}

/**
 * 容错清理：先把整棵树 chmod 回可进入（0o000 / 0o500 的目录否则删不掉），再删。
 */
function cleanup(dir) {
  const walk = (p) => {
    let st
    try {
      st = lstatSync(p)
    } catch {
      return
    }
    if (!st.isDirectory()) return
    try {
      chmodSync(p, 0o755)
    } catch {}
    let names = []
    try {
      names = readdirSync(p)
    } catch {
      names = []
    }
    for (const n of names) walk(join(p, n))
  }
  walk(dir)
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 造浏览器：stateDir 放在临时目录里，roots 默认放开这个临时目录
 * （否则 /tmp 不在"家目录 ∪ cwd ∪ roots"里，写操作会被安全闸拦掉）。
 */
function makeBrowser(base, extra = {}) {
  return createDirBrowser({ stateDir: join(base, 'cs-bots-state'), roots: [base], ...extra })
}

/** 取抛出的错误 code；没抛返回 null。 */
function codeOf(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof DirBrowseError ? error.code : `NOT_DIRBROWSE:${error?.name}:${error?.message}`
  }
}

/** p 是否在家目录之内（用于跳过"越界"类断言——在家目录内就造不出越界场景）。 */
function underHome(p) {
  const rel = relative(resolve(homedir()), resolve(p))
  return rel === '' || (rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel))
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

// ── 1. list 基本语义 ─────────────────────────────────────────────────────────

test('list 省略 path 时默认列家目录', () => {
  const base = tmp()
  try {
    const b = createDirBrowser({ stateDir: join(base, 'state') })
    const r = b.list()
    assert.equal(r.path, resolve(homedir()))
    assert.ok(Array.isArray(r.entries))
    assert.equal(typeof r.writable, 'boolean')
    assert.equal(r.outsideAllowedRoots, false, '家目录本身永远在允许范围内')
    assert.ok(r.parent === null || isAbsolute(r.parent))
  } finally {
    cleanup(base)
  }
})

test('list: 目录排在文件前；隐藏项默认不出现，showHidden 才出现', () => {
  const base = tmp()
  try {
    mkdirSync(join(base, 'bdir'))
    mkdirSync(join(base, 'adir'))
    mkdirSync(join(base, '.gdir'))
    writeFileSync(join(base, 'b.txt'), 'b')
    writeFileSync(join(base, 'A.md'), 'aaa')
    writeFileSync(join(base, '.env'), 'SECRET=1')
    const b = makeBrowser(base)

    const hidden = b.list({ path: base })
    const names = hidden.entries.map((e) => e.name)
    assert.deepEqual(names, ['adir', 'bdir', 'A.md', 'b.txt'], '目录在前、再按名字排；.gdir/.env 默认隐藏')
    assert.ok(!names.includes('.env'))
    assert.ok(!names.includes('.gdir'))

    const all = b.list({ path: base, showHidden: true }).entries.map((e) => e.name)
    assert.ok(all.includes('.env'))
    assert.ok(all.includes('.gdir'))
    assert.equal(all[0], '.gdir', '隐藏目录同样是目录，仍排在最前')

    // 字段形状
    const dir = hidden.entries.find((e) => e.name === 'adir')
    assert.equal(dir.kind, 'dir')
    assert.equal(dir.path, join(base, 'adir'))
    assert.equal(typeof dir.mtime, 'number')
    assert.ok(dir.mtime > 0)
    const file = hidden.entries.find((e) => e.name === 'A.md')
    assert.equal(file.kind, 'file')
    assert.equal(file.size, 3)
    assert.equal(typeof file.mtime, 'number')
  } finally {
    cleanup(base)
  }
})

test('list: 根目录 parent 为 null；普通目录 parent 是上一级', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    const root = b.list({ path: '/' })
    assert.equal(root.path, '/')
    assert.equal(root.parent, null)
    mkdirSync(join(base, 'deep'))
    const sub = b.list({ path: join(base, 'deep') })
    assert.equal(sub.parent, base)
  } finally {
    cleanup(base)
  }
})

test('list: 超过 500 条显式截断（truncated + total）', () => {
  const base = tmp()
  try {
    for (let i = 0; i < MAX_ENTRIES + 10; i += 1) {
      writeFileSync(join(base, `f-${String(i).padStart(4, '0')}.txt`), '')
    }
    const b = makeBrowser(base)
    const r = b.list({ path: base })
    assert.equal(r.entries.length, MAX_ENTRIES)
    assert.equal(r.truncated, true)
    assert.equal(r.total, MAX_ENTRIES + 10)

    const small = (() => {
      const d = join(base, 'small')
      mkdirSync(d)
      writeFileSync(join(d, 'one.txt'), '')
      return b.list({ path: d })
    })()
    assert.equal(small.truncated, undefined, '没超限就不该出现 truncated 字段')
  } finally {
    cleanup(base)
  }
})

test('list: outsideAllowedRoots 标记 + 可写性', () => {
  const base = tmp()
  const other = tmp()
  try {
    const b = createDirBrowser({ stateDir: join(base, 'state'), roots: [base] })
    assert.equal(b.list({ path: base }).outsideAllowedRoots, false)
    if (!underHome(other)) {
      const r = b.list({ path: other })
      assert.equal(r.outsideAllowedRoots, true)
      assert.equal(r.error, undefined, '范围外只标记，不拒绝读')
    }
    assert.equal(b.list({ path: base }).writable, true)
    if (!isRoot) {
      const locked = join(base, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o500)
      try {
        assert.equal(b.list({ path: base }).entries.some((e) => e.name === 'locked'), true)
        assert.equal(b.list({ path: locked }).writable, false, '没有 W 权限时 writable:false')
      } finally {
        chmodSync(locked, 0o755)
      }
    }
  } finally {
    cleanup(base)
    cleanup(other)
  }
})

test('list: EACCES 不抛错，返回空 entries + error（用户要能继续往上翻）', () => {
  if (isRoot) return // root 无视权限位，测不出 EACCES
  const base = tmp()
  try {
    const locked = join(base, 'no-read')
    mkdirSync(locked)
    writeFileSync(join(locked, 'x.txt'), 'x')
    chmodSync(locked, 0o000)
    const b = makeBrowser(base)
    const r = b.list({ path: locked })
    assert.equal(r.error, 'EACCES')
    assert.deepEqual(r.entries, [])
    assert.equal(r.writable, false)
    assert.equal(r.path, locked)
    // 上翻正常
    assert.equal(b.list({ path: base }).error, undefined)
  } finally {
    cleanup(base)
  }
})

// ── 2~4. list 的拒绝路径 ────────────────────────────────────────────────────

test('list: 相对路径抛 DIR_NOT_ABSOLUTE', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    assert.equal(codeOf(() => b.list({ path: 'relative/dir' })), 'DIR_NOT_ABSOLUTE')
    assert.equal(codeOf(() => b.list({ path: './' })), 'DIR_NOT_ABSOLUTE')
    assert.equal(codeOf(() => b.list({ path: '~/x' })), 'DIR_NOT_ABSOLUTE')
    // 空串 / 非字符串：参数校验错（不静默退回家目录）
    assert.equal(codeOf(() => b.list({ path: '' })), 'DIR_BAD_PATH')
    assert.equal(codeOf(() => b.list({ path: 123 })), 'DIR_BAD_PATH')
  } finally {
    cleanup(base)
  }
})

test('list: 不存在的路径抛 DIR_NOT_FOUND', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    assert.equal(codeOf(() => b.list({ path: join(base, 'nope') })), 'DIR_NOT_FOUND')
  } finally {
    cleanup(base)
  }
})

test('list: 对文件调用抛 DIR_NOT_DIRECTORY', () => {
  const base = tmp()
  try {
    const file = join(base, 'a.txt')
    writeFileSync(file, 'x')
    const b = makeBrowser(base)
    assert.equal(codeOf(() => b.list({ path: file })), 'DIR_NOT_DIRECTORY')
  } finally {
    cleanup(base)
  }
})

// ── 5~6. mkdir ──────────────────────────────────────────────────────────────

test('mkdir: 成功创建、目录真实存在；同名再建抛 DIR_EXISTS', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    const r = b.mkdir({ path: base, name: 'new-bot' })
    assert.deepEqual(r, { path: join(base, 'new-bot'), created: true })
    assert.equal(existsSync(join(base, 'new-bot')), true)
    assert.equal(b.list({ path: base }).entries.some((e) => e.name === 'new-bot' && e.kind === 'dir'), true)

    assert.equal(codeOf(() => b.mkdir({ path: base, name: 'new-bot' })), 'DIR_EXISTS')
    // 同名文件也算已存在（不静默复用）
    writeFileSync(join(base, 'plain.txt'), 'x')
    assert.equal(codeOf(() => b.mkdir({ path: base, name: 'plain.txt' })), 'DIR_EXISTS')
  } finally {
    cleanup(base)
  }
})

test('mkdir: 非法名全部被拒（含 / 、.. 、空串、反斜杠、保留字符、控制字符、超长）', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    const bad = [
      'a/b',
      '..',
      '.',
      '',
      '   ',
      'a\\b',
      '../escape',
      'a:b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      'a\u0000b',
      'a\u001fb',
      'x'.repeat(256),
      undefined,
      null,
      42,
    ]
    for (const name of bad) {
      assert.equal(
        codeOf(() => b.mkdir({ path: base, name })),
        'DIR_BAD_NAME',
        `name=${JSON.stringify(name)} 必须被拒`,
      )
    }
    // 全被拒 ⇒ 目录里一个新东西都没留下
    assert.deepEqual(b.list({ path: base }).entries, [])
    // 名字元字符全覆盖：255 长度是合法的
    assert.equal(NAME_PATTERN.test('x'.repeat(255)), true)
    assert.equal(b.mkdir({ path: base, name: '  padded  ' }).path, join(base, 'padded'), '首尾空白被裁掉')
  } finally {
    cleanup(base)
  }
})

test('mkdir: 父目录不存在抛 DIR_NOT_FOUND；父路径是文件也拒', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    assert.equal(codeOf(() => b.mkdir({ path: join(base, 'nope'), name: 'x' })), 'DIR_NOT_FOUND')
    assert.equal(codeOf(() => b.mkdir({ path: 'relative', name: 'x' })), 'DIR_NOT_ABSOLUTE')
    writeFileSync(join(base, 'file.txt'), 'x')
    assert.equal(codeOf(() => b.mkdir({ path: join(base, 'file.txt'), name: 'x' })), 'DIR_NOT_DIRECTORY')
  } finally {
    cleanup(base)
  }
})

test('mkdir: 越出允许范围被拒（DIR_OUTSIDE_ROOTS）', () => {
  const base = tmp()
  const inside = join(base, 'allowed')
  const outside = join(base, 'outside')
  try {
    mkdirSync(inside)
    mkdirSync(outside)
    if (underHome(outside)) return // 家目录内造不出"范围外"场景
    const b = createDirBrowser({ stateDir: join(base, 'state'), roots: [inside] })
    assert.equal(codeOf(() => b.mkdir({ path: outside, name: 'bot' })), 'DIR_OUTSIDE_ROOTS')
    assert.equal(existsSync(join(outside, 'bot')), false)
    assert.equal(b.mkdir({ path: inside, name: 'bot' }).created, true, '范围内照常')
  } finally {
    cleanup(base)
  }
})

test('mkdir: 符号链接指到范围外时同样被拒（不跟随做写操作）', () => {
  const base = tmp()
  const inside = join(base, 'allowed')
  const outside = join(base, 'outside')
  try {
    mkdirSync(inside)
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'x')
    if (underHome(outside)) return
    symlinkSync(outside, join(inside, 'link'))
    const b = createDirBrowser({ stateDir: join(base, 'state'), roots: [inside] })
    // 读可以（符号链接只是入口）
    assert.ok(Array.isArray(b.list({ path: join(inside, 'link') }).entries))
    // 写不行：realpath 落在 allowed 之外
    assert.equal(codeOf(() => b.mkdir({ path: join(inside, 'link'), name: 'bot' })), 'DIR_OUTSIDE_ROOTS')
    assert.equal(existsSync(join(outside, 'bot')), false)
  } finally {
    cleanup(base)
  }
})

// ── 7. rename ───────────────────────────────────────────────────────────────

test('rename: 成功改名；目标已存在被拒；重命名根被拒', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    mkdirSync(join(base, 'old-name'))
    const r = b.rename({ path: join(base, 'old-name'), name: 'new-name' })
    assert.deepEqual(r, { from: join(base, 'old-name'), to: join(base, 'new-name') })
    assert.equal(existsSync(join(base, 'new-name')), true)
    assert.equal(existsSync(join(base, 'old-name')), false)

    mkdirSync(join(base, 'other'))
    assert.equal(codeOf(() => b.rename({ path: join(base, 'new-name'), name: 'other' })), 'DIR_EXISTS')
    assert.equal(existsSync(join(base, 'new-name')), true, '失败后原目录必须还在')

    assert.equal(codeOf(() => b.rename({ path: '/', name: 'whatever' })), 'DIR_CANNOT_RENAME_ROOT')
    assert.equal(codeOf(() => b.rename({ path: join(base, 'new-name'), name: 'a/b' })), 'DIR_BAD_NAME')
    assert.equal(codeOf(() => b.rename({ path: join(base, 'new-name'), name: '..' })), 'DIR_BAD_NAME')
    assert.equal(codeOf(() => b.rename({ path: join(base, 'ghost'), name: 'x' })), 'DIR_NOT_FOUND')

    // 同名 ⇒ 无操作（不报错、不误删）
    const same = b.rename({ path: join(base, 'new-name'), name: 'new-name' })
    assert.deepEqual(same, { from: join(base, 'new-name'), to: join(base, 'new-name') })
    assert.equal(existsSync(join(base, 'new-name')), true)
  } finally {
    cleanup(base)
  }
})

// ── 8. validateAsBotCwd ─────────────────────────────────────────────────────

test('validateAsBotCwd: 普通可写目录 ok=true 且无 errors/warnings', () => {
  const base = tmp()
  try {
    const work = join(base, 'work')
    mkdirSync(work)
    const b = makeBrowser(base, { dshHome: join(base, '_dsh') })
    const r = b.validateAsBotCwd({ path: work })
    assert.equal(r.ok, true)
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.warnings, [])
    assert.equal(r.path, work)
  } finally {
    cleanup(base)
  }
})

test('validateAsBotCwd: 在 dshHome 之内 ok=false 且 errors 提到', () => {
  const base = tmp()
  try {
    const dshHome = join(base, 'fake-dsh')
    const bot = join(dshHome, 'bots', 'a')
    mkdirSync(bot, { recursive: true })
    const b = makeBrowser(base, { dshHome })
    const r = b.validateAsBotCwd({ path: bot })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('DSH 家目录')), `errors 应提到 DSH 家目录，实际：${JSON.stringify(r.errors)}`)
    // dshHome 本身也算"之内"
    assert.equal(b.validateAsBotCwd({ path: dshHome }).ok, false)
  } finally {
    cleanup(base)
  }
})

test('validateAsBotCwd: 在 stateDir / ~/.agents 内 ok=false', () => {
  const base = tmp()
  try {
    const stateDir = join(base, 'state')
    const inState = join(stateDir, 'board')
    mkdirSync(inState, { recursive: true })
    const b = createDirBrowser({ stateDir, roots: [base] })
    const r = b.validateAsBotCwd({ path: inState })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('状态目录')), JSON.stringify(r.errors))

    // ~/.agents 用真实家目录判定（只读判断，不创建任何东西）
    const agents = join(homedir(), '.agents')
    if (existsSync(agents)) {
      const ra = b.validateAsBotCwd({ path: agents })
      assert.equal(ra.ok, false)
      assert.ok(ra.errors.some((e) => e.includes('~/.agents')), JSON.stringify(ra.errors))
    }
  } finally {
    cleanup(base)
  }
})

test('validateAsBotCwd: 不存在 / 是文件 / 相对路径 都 ok=false', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    const nope = b.validateAsBotCwd({ path: join(base, 'nope') })
    assert.equal(nope.ok, false)
    assert.ok(nope.errors.length > 0)

    writeFileSync(join(base, 'f.txt'), 'x')
    const file = b.validateAsBotCwd({ path: join(base, 'f.txt') })
    assert.equal(file.ok, false)
    assert.ok(file.errors.some((e) => e.includes('不是目录')))

    assert.equal(b.validateAsBotCwd({ path: 'rel/path' }).ok, false)
    assert.equal(b.validateAsBotCwd({}).ok, false)
    assert.equal(b.validateAsBotCwd({ path: '' }).ok, false)
  } finally {
    cleanup(base)
  }
})

test('validateAsBotCwd: 不可写 ⇒ ok=false；系统顶层目录 ⇒ 只给 warning', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base, { dshHome: join(base, '_dsh') })
    const locked = join(base, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    try {
      const r = b.validateAsBotCwd({ path: locked })
      assert.equal(r.ok, false)
      assert.ok(r.errors.some((e) => e.includes('不可写')), JSON.stringify(r.errors))
    } finally {
      chmodSync(locked, 0o755)
    }

    const sys = b.validateAsBotCwd({ path: '/tmp' })
    assert.equal(sys.ok, true, '系统目录只给 warning，不阻挡用户')
    assert.ok(sys.warnings.some((w) => w.includes('系统根目录')), JSON.stringify(sys.warnings))
    // 深度 > 1 的普通目录不误报
    const deep = join(base, 'deep')
    mkdirSync(deep)
    assert.deepEqual(b.validateAsBotCwd({ path: deep }).warnings, [])
  } finally {
    cleanup(base)
  }
})

// ── 9. resolveSuggested ─────────────────────────────────────────────────────

test('resolveSuggested: 正常拼接；非法 name 抛错；不创建任何东西', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    assert.deepEqual(b.resolveSuggested({ parent: base, name: 'my-bot' }), { path: join(base, 'my-bot') })
    assert.deepEqual(b.resolveSuggested({ parent: base, name: ' a b ' }), { path: join(base, 'a b') })
    assert.equal(existsSync(join(base, 'my-bot')), false, '只算路径，不落盘')

    for (const name of ['../evil', 'a/b', '..', '', 'x'.repeat(300), 'a\u0000b']) {
      assert.equal(codeOf(() => b.resolveSuggested({ parent: base, name })), 'DIR_BAD_NAME', JSON.stringify(name))
    }
    assert.equal(codeOf(() => b.resolveSuggested({ parent: 'rel', name: 'x' })), 'DIR_NOT_ABSOLUTE')
    assert.equal(codeOf(() => b.resolveSuggested({ name: 'x' })), 'DIR_BAD_PATH')
  } finally {
    cleanup(base)
  }
})

// ── 10. roots / dispose / 零依赖 ────────────────────────────────────────────

test('roots: 返回家目录 / cwd / 额外 roots', () => {
  const base = tmp()
  try {
    const b = createDirBrowser({ stateDir: join(base, 'state'), roots: [base, resolve(base, 'x')] })
    const r = b.roots()
    assert.equal(r.home, resolve(homedir()))
    assert.equal(r.cwd, process.cwd())
    assert.deepEqual(r.roots, [base, resolve(base, 'x')])
    assert.equal(createDirBrowser({ stateDir: join(base, 's2') }).roots().roots.length, 0)
  } finally {
    cleanup(base)
  }
})

test('config: 缺 stateDir 或类型不对直接抛 DIR_BAD_CONFIG（不静默兜底）', () => {
  assert.equal(codeOf(() => createDirBrowser({})), 'DIR_BAD_CONFIG')
  assert.equal(codeOf(() => createDirBrowser({ stateDir: '' })), 'DIR_BAD_CONFIG')
  assert.equal(codeOf(() => createDirBrowser({ stateDir: '/tmp/x', roots: 'nope' })), 'DIR_BAD_CONFIG')
  assert.equal(codeOf(() => createDirBrowser({ stateDir: '/tmp/x', roots: [42] })), 'DIR_BAD_CONFIG')
})

test('dispose(): 存在且可安全重复调用', () => {
  const base = tmp()
  try {
    const b = makeBrowser(base)
    assert.equal(typeof b.dispose, 'function')
    b.dispose()
    b.dispose()
    assert.ok(Array.isArray(b.list({ path: base }).entries), 'dispose 后仍可用（无资源需释放）')
  } finally {
    cleanup(base)
  }
})

test('零依赖：src/dirbrowse.js 不引用任何宿主/第三方包', () => {
  const src = readFileSync(new URL('../src/dirbrowse.js', import.meta.url), 'utf8')
  assert.equal(src.includes('@deepseek-ai/'), false, '不得出现 @deepseek-ai/')
  const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.ok(specs.length > 0, '应能解析到 import')
  for (const spec of specs) {
    assert.ok(spec.startsWith('node:'), `只允许 node: 内置模块，收到 ${spec}`)
  }
  assert.deepEqual(new Set(specs), new Set(['node:fs', 'node:path', 'node:os']))
})
