/**
 * ScratchService 测试 —— 临时便签（自由 Markdown / 按作用域隔离 / 原子写）。
 *
 * 纪律（与 discipline.test.mjs、board.test.mjs 同款）：
 *   每条断言都用**真实落盘产物**或**真实返回值**做证据，不用「函数没抛错」这种弱断言。
 *   只碰 `node:test` + `node:assert` + `node:fs` + `node:os` + `node:path`。
 *
 * 运行：`node --test test/scratch.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createScratch, {
  ScratchError,
  DEFAULT_SCOPE,
  MAX_BYTES,
} from '../src/scratch.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/** 每个用例一个独立状态目录（互不污染），用例结束递归清理。 */
function setup(t, config = {}) {
  const base = process.env.SCRATCH_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-scratch-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { chmodSync(dir, 0o755) } catch { /* 已被删/无权限 */ } })
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ } })
  const svc = createScratch({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc, scratchDir: join(dir, 'scratch') }
}

/** 便签目录里的文件名（测试「原子写不残留临时文件」用）。 */
function files(scratchDir) {
  try {
    return readdirSync(scratchDir).sort()
  } catch {
    return []
  }
}

// ── 1. 导出面与缺省值 ───────────────────────────────────────────────────────

test('导出：default 是工厂，命名导出错误类与常量', () => {
  assert.equal(typeof createScratch, 'function')
  assert.equal(typeof ScratchError, 'function')
  assert.equal(DEFAULT_SCOPE, 'global')
  assert.equal(MAX_BYTES, 512 * 1024)
})

test('构造：缺省 scope 是 global，文件落在 <stateDir>/scratch/<scope>.md', (t) => {
  const { svc, scratchDir } = setup(t)
  assert.equal(svc.paths.dir, scratchDir)
  const res = svc.write({ text: '默认作用域' })
  assert.equal(res.scope, 'global')
  assert.equal(res.exists, true)
  assert.deepEqual(files(scratchDir), ['global.md'])
  assert.equal(readFileSync(join(scratchDir, 'global.md'), 'utf8'), '默认作用域')
})

// ── 2. 写读往返 ─────────────────────────────────────────────────────────────

test('写读往返：bytes 按 UTF-8 字节算（中文一字 3 字节）', (t) => {
  const { svc, scratchDir } = setup(t)
  const text = '# 标题\n中文内容 abc'
  const w = svc.write({ scope: 'notes', text, by: 'bot-1' })
  // 独立实现：Buffer.byteLength 是 UTF-8 字节数的权威口径
  assert.equal(w.bytes, Buffer.byteLength(text, 'utf8'))
  assert.equal(w.text, text)

  const r = svc.read({ scope: 'notes' })
  assert.equal(r.text, text)
  assert.equal(r.bytes, Buffer.byteLength(text, 'utf8'))
  assert.equal(r.exists, true)
  assert.equal(r.scope, 'notes')
  assert.ok(Number.isFinite(r.updatedAt) && r.updatedAt > 0)
  // 磁盘大小也应当是字节数（不留 BOM、不做换行转换）
  assert.equal(statSync(join(scratchDir, 'notes.md')).size, Buffer.byteLength(text, 'utf8'))
})

test('空正文可保存：exists=true、bytes=0（空便签是合法状态）', (t) => {
  const { svc, scratchDir } = setup(t)
  const w = svc.write({ scope: 'empty', text: '' })
  assert.equal(w.bytes, 0)
  assert.equal(w.exists, true)
  const r = svc.read({ scope: 'empty' })
  assert.equal(r.text, '')
  assert.equal(r.bytes, 0)
  assert.equal(r.exists, true)
  assert.deepEqual(files(scratchDir), ['empty.md'])
})

// ── 3. 读不存在的 scope：返回空，不报错 ─────────────────────────────────────

test('读不存在的 scope：返回 { text:"", exists:false }，不抛错', (t) => {
  const { svc } = setup(t)
  const r = svc.read({ scope: 'never-written' })
  assert.deepEqual(r, { scope: 'never-written', text: '', updatedAt: 0, bytes: 0, exists: false })
})

// ── 4. 原子写：覆盖不残留 tmp；中途失败旧内容完整 ──────────────────────────

test('原子写：覆盖写后目录里只有目标文件，无 .tmp-* 残留，内容完全替换', (t) => {
  const { svc, scratchDir } = setup(t)
  svc.write({ scope: 'atomic', text: 'v1'.repeat(1000) })
  const w2 = svc.write({ scope: 'atomic', text: 'v2' })
  assert.equal(w2.text, 'v2')
  assert.deepEqual(files(scratchDir), ['atomic.md'], '临时文件必须在 rename 后消失')
  assert.equal(readFileSync(join(scratchDir, 'atomic.md'), 'utf8'), 'v2')
})

test('原子写：写失败时旧便签保持完整，且不残留临时文件', (t) => {
  const { svc, scratchDir } = setup(t)
  svc.write({ scope: 'keep', text: '旧内容-完整' })

  // 把便签目录设为只读 → 无法创建临时文件 → 写入必须失败（不静默、也不破坏旧文件）
  chmodSync(scratchDir, 0o555)
  try {
    assert.throws(
      () => svc.write({ scope: 'keep', text: '新内容-不该生效' }),
      (error) => {
        assert.ok(error instanceof ScratchError)
        assert.equal(error.code, 'SCRATCH_WRITE_FAILED')
        assert.equal(error.detail.scope, 'keep')
        return true
      },
    )
  } finally {
    chmodSync(scratchDir, 0o755)
  }

  // 旧内容仍在（rename 之前目标文件从未被打开写），且没有半截临时文件
  const r = svc.read({ scope: 'keep' })
  assert.equal(r.text, '旧内容-完整')
  assert.deepEqual(files(scratchDir), ['keep.md'])
})

// ── 5. 超长拒绝 ─────────────────────────────────────────────────────────────

test('超长拒绝：>512KiB 抛 SCRATCH_TOO_LARGE，且不产生/不破坏文件', (t) => {
  const { svc, scratchDir } = setup(t)
  // 已有内容的便签：拒绝后必须保持原样
  svc.write({ scope: 'big', text: '旧' })
  const tooBig = 'x'.repeat(MAX_BYTES + 1)
  assert.throws(
    () => svc.write({ scope: 'big', text: tooBig }),
    (error) => {
      assert.equal(error.code, 'SCRATCH_TOO_LARGE')
      assert.equal(error.detail.bytes, MAX_BYTES + 1)
      assert.equal(error.detail.max, MAX_BYTES)
      return true
    },
  )
  assert.equal(svc.read({ scope: 'big' }).text, '旧')
  // 从未写过的 scope：拒绝后不应凭空出现空文件
  assert.throws(() => svc.write({ scope: 'newbig', text: tooBig }), /超过上限/)
  assert.equal(svc.read({ scope: 'newbig' }).exists, false)
  assert.deepEqual(files(scratchDir), ['big.md'])

  // 中文按字节算：171 个三字节汉字 = 513 字节 > 512 KiB，而字符数远小于上限
  const cjk = '中'.repeat(Math.ceil(MAX_BYTES / 3) + 1)
  assert.ok(cjk.length < MAX_BYTES, '前提：字符数未超上限')
  assert.throws(() => svc.write({ scope: 'cjk', text: cjk }), /超过上限/)
})

test('超长拒绝：恰好等于上限时允许（边界不误杀）', (t) => {
  const { svc } = setup(t)
  const exact = 'a'.repeat(MAX_BYTES)
  const w = svc.write({ scope: 'exact', text: exact })
  assert.equal(w.bytes, MAX_BYTES)
  assert.equal(svc.read({ scope: 'exact' }).bytes, MAX_BYTES)
})

// ── 6. 多 scope 隔离 + listScopes ───────────────────────────────────────────

test('多 scope 隔离：项目便签与全局便签互不影响', (t) => {
  const { svc } = setup(t)
  // 项目便签用 cwd 的 hash（生产代码由调用方算好传入，这里用等价字面量）
  const projectA = 'project-1a2b3c4d'
  const projectB = 'project-deadbeef'
  svc.write({ scope: DEFAULT_SCOPE, text: '全局便签' })
  svc.write({ scope: projectA, text: 'A 项目便签' })
  svc.write({ scope: projectB, text: 'B 项目便签' })

  assert.equal(svc.read({ scope: DEFAULT_SCOPE }).text, '全局便签')
  assert.equal(svc.read({ scope: projectA }).text, 'A 项目便签')
  assert.equal(svc.read({ scope: projectB }).text, 'B 项目便签')

  // 改 A 不影响 B（不同 inode，不存在"共享文件互相覆盖"）
  svc.write({ scope: projectA, text: 'A 项目便签 v2' })
  assert.equal(svc.read({ scope: projectB }).text, 'B 项目便签')
  assert.equal(svc.read({ scope: DEFAULT_SCOPE }).text, '全局便签')
})

test('listScopes：返回全部便签的 scope / updatedAt / bytes，按 scope 字典序', (t) => {
  const { svc } = setup(t)
  assert.deepEqual(svc.listScopes(), [], '空目录返回空数组，不抛错')

  svc.write({ scope: 'zeta', text: 'z' })
  svc.write({ scope: 'global', text: '全局' })
  svc.write({ scope: 'project-abcdef12', text: '项目' })

  const list = svc.listScopes()
  assert.deepEqual(list.map((x) => x.scope), ['global', 'project-abcdef12', 'zeta'])
  for (const item of list) {
    assert.ok(Number.isFinite(item.updatedAt) && item.updatedAt > 0)
    assert.ok(Number.isInteger(item.bytes) && item.bytes > 0)
  }
  const global = list.find((x) => x.scope === 'global')
  assert.equal(global.bytes, Buffer.byteLength('全局', 'utf8'))

  // 临时文件与非法文件名不得被当成便签列出
  writeFileSync(join(svc.paths.dir, 'global.md.tmp-999-deadbeef'), 'half')
  writeFileSync(join(svc.paths.dir, 'not-a-note.txt'), 'x')
  writeFileSync(join(svc.paths.dir, 'illegal name.md'), 'x')
  assert.deepEqual(svc.listScopes().map((x) => x.scope), ['global', 'project-abcdef12', 'zeta'])
})

// ── 7. scope 校验（安全边界）────────────────────────────────────────────────

test('scope 校验：路径穿越/非法字符一律抛 SCRATCH_BAD_SCOPE（不静默改名）', (t) => {
  const { svc } = setup(t)
  for (const bad of ['../escape', '..', 'a/b', '.hidden', 'a b', 'x'.repeat(65), '中文']) {
    assert.throws(
      () => svc.write({ scope: bad, text: 'x' }),
      (error) => {
        assert.equal(error.code, 'SCRATCH_BAD_SCOPE', `scope=${bad} 应当被拒绝`)
        return true
      },
    )
  }
  // 读也走同一套校验：不允许用读接口探测目录外文件
  assert.throws(() => svc.read({ scope: '../MEMORY' }), /非法 scope/)
  assert.deepEqual(files(join(svc.paths.dir)), [], '被拒绝的 scope 不得留下任何文件')
})

test('scope 校验：合法命名（global / project-<hash> / a.b_c-1）可写', (t) => {
  const { svc } = setup(t)
  for (const ok of ['global', 'project-1a2b3c4d', 'a.b_c-1', 'A1', 'x'.repeat(64)]) {
    assert.equal(svc.write({ scope: ok, text: ok }).scope, ok)
  }
})

// ── 8. now 注入（逻辑时间与磁盘 mtime 一致）─────────────────────────────────

test('now 注入：write 后 read 的 updatedAt 就是传入的逻辑时间', (t) => {
  const { svc } = setup(t)
  const now = 1_700_000_000_123
  const w = svc.write({ scope: 'clock', text: 'x', now })
  assert.equal(w.updatedAt, now)
  assert.equal(svc.read({ scope: 'clock' }).updatedAt, now)
  // 二次写入用更晚的时间 → updatedAt 前进（UI 的"最后保存时间"可信）
  const later = now + 60_000
  svc.write({ scope: 'clock', text: 'y', now: later })
  assert.equal(svc.read({ scope: 'clock' }).updatedAt, later)
})

// ── 9. stats / dispose ──────────────────────────────────────────────────────

test('stats：scope 数 / 总字节 / 写入次数与 lastWrite 可核对', (t) => {
  const { svc } = setup(t)
  svc.write({ scope: 'a', text: '12345', by: 'bot-x', now: 1_700_000_000_000 })
  svc.write({ scope: 'b', text: '中', by: 'bot-y', now: 1_700_000_001_000 })
  const s = svc.stats()
  assert.equal(s.scopes, 2)
  assert.equal(s.bytes, 5 + Buffer.byteLength('中', 'utf8'))
  assert.equal(s.maxBytes, MAX_BYTES)
  assert.equal(s.writes, 2)
  assert.equal(s.lastWrite.scope, 'b')
  assert.equal(s.lastWrite.by, 'bot-y')
  assert.equal(s.lastError, null)
})

test('dispose：之后所有方法抛 SCRATCH_DISPOSED，但文件不被删（用户资产）', (t) => {
  const { svc, scratchDir } = setup(t)
  svc.write({ scope: 'keep', text: '别删我' })
  const out = svc.dispose()
  assert.deepEqual(out, { disposed: true, scopes: 1 })
  assert.equal(existsSync(join(scratchDir, 'keep.md')), true)

  for (const fn of [
    () => svc.read({ scope: 'keep' }),
    () => svc.write({ scope: 'keep', text: 'x' }),
    () => svc.listScopes(),
    () => svc.stats(),
  ]) {
    assert.throws(fn, (error) => {
      assert.equal(error.code, 'SCRATCH_DISPOSED')
      return true
    })
  }
})
