/**
 * store.js / settings.js 数据基座测试（P0-A）。
 *
 * 只碰 node 内置：node:test / node:assert / node:fs / node:os / node:path。
 * 每条断言都落到**实际磁盘产物**上（读回 audit.jsonl / 备份目录 / schema 文件），
 * 不接受「函数没抛错」这种弱证据。
 *
 * 运行：`node --test test/store-foundation.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import * as store from '../src/store.js'
import {
  SCHEMA_VERSION,
  readSchemaVersion,
  writeSchemaVersion,
  migrate,
  appendAudit,
  backupState,
  restoreState,
  ensureDir,
  statePath,
  writeJsonAtomic,
  readJson,
} from '../src/store.js'
import { validateSetting, SETTING_SPECS, defaultSettings } from '../src/settings.js'

let counter = 0
const baseName = (p) => p.split(/[\\/]/).pop()

/** 每个用例一个独立状态目录（互不污染；沙箱受限时可用 BOARD_TEST_TMPDIR 指定）。 */
function setup(t) {
  const base = process.env.BOARD_TEST_TMPDIR || tmpdir()
  const dir = mkdtempSync(join(base, `cs-bots-store-${process.pid}-${counter++}-`))
  t?.after?.(() => {
    // 连同备份/恢复产生的兄弟目录一起清掉（否则临时目录里会越堆越多）
    try {
      const parent = dirname(dir)
      const prefix = baseName(dir)
      for (const name of readdirSync(parent)) {
        if (name === prefix || name.startsWith(`${prefix}.bak-`) || name.startsWith(`${prefix}.pre-restore-`)) {
          try { rmSync(join(parent, name), { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ }
        }
      }
    } catch { /* 清理失败不影响判定 */ }
  })
  return dir
}

/** 该状态目录派生出的兄弟路径（备份 / pre-restore）。 */
function siblingsOf(dir) {
  const parent = dirname(dir)
  const prefix = baseName(dir)
  return readdirSync(parent).filter((n) => n.startsWith(`${prefix}.`))
}

// ── schema 版本 ─────────────────────────────────────────────────────────────

test('SCHEMA_VERSION 是一个正整数常量', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number')
  assert.ok(Number.isInteger(SCHEMA_VERSION))
  assert.ok(SCHEMA_VERSION >= 1)
})

test('readSchemaVersion 缺文件时为 0；writeSchemaVersion 落盘后可读回', (t) => {
  const dir = setup(t)
  assert.equal(readSchemaVersion(dir, 'board'), 0)
  assert.equal(writeSchemaVersion(dir, 'board', 3), true)
  assert.equal(readSchemaVersion(dir, 'board'), 3)
  // 磁盘证据
  assert.equal(readJson(statePath(dir, 'board.schema.json')).version, 3)
})

test('writeSchemaVersion 拒绝非有限数（不静默写坏值）', (t) => {
  const dir = setup(t)
  assert.equal(writeSchemaVersion(dir, 'board', Number.NaN), false)
  assert.equal(writeSchemaVersion(dir, 'board', '2'), false)
  assert.equal(readSchemaVersion(dir, 'board'), 0)
})

// ── 迁移 ───────────────────────────────────────────────────────────────────

test('migrate：版本已等于目标 → migrated=false，不调 migrateFn', (t) => {
  const dir = setup(t)
  writeSchemaVersion(dir, 'board', 2)
  const r = migrate(dir, { name: 'board', from: 2, to: 2, migrateFn: () => assert.fail('不应调用 migrateFn') })
  assert.equal(r.ok, true)
  assert.equal(r.migrated, false)
  assert.equal(r.version, 2)
})

test('migrate：当前版本高于目标 → 抛可读错误（不降级）', (t) => {
  const dir = setup(t)
  writeSchemaVersion(dir, 'board', 5)
  assert.throws(
    () => migrate(dir, { name: 'board', from: 5, to: 2, migrateFn: (rows) => rows }),
    (err) => {
      assert.match(err.message, /board/)
      assert.match(err.message, /5/)
      assert.match(err.message, /2/)
      assert.match(err.message, /拒绝降级/)
      return true
    },
  )
})

test('migrate：调用 migrateFn 并原子写回 JSONL + 更新版本号', (t) => {
  const dir = setup(t)
  ensureDir(dir)
  const file = statePath(dir, 'board.jsonl')
  writeFileSync(file, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n`, 'utf8')
  writeSchemaVersion(dir, 'board', 1)

  let seen = null
  const r = migrate(dir, {
    name: 'board',
    from: 1,
    to: 2,
    migrateFn: (rows) => {
      seen = rows.length
      return rows.map((row) => ({ ...row, schema: 2 }))
    },
  })

  assert.equal(seen, 2, 'migrateFn 应拿到既有 2 行')
  assert.equal(r.migrated, true)
  assert.equal(r.version, 2)
  assert.equal(readSchemaVersion(dir, 'board'), 2)

  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  assert.equal(lines.length, 2)
  for (const line of lines) assert.equal(JSON.parse(line).schema, 2)

  // 原子写不留 tmp 残渣（tmp→rename 语义未被破坏）
  assert.equal(existsSync(`${file}.tmp-${process.pid}`), false)
})

test('migrate：JSON 单对象快照按**原形态**写回（不静默变成数组）', (t) => {
  const dir = setup(t)
  ensureDir(dir)
  writeJsonAtomic(statePath(dir, 'todo.json'), { id: 'a' })
  writeSchemaVersion(dir, 'todo', 1)
  const r = migrate(dir, {
    name: 'todo',
    to: 2,
    migrateFn: (rows) => rows.map((x) => ({ ...x, v: 2 })),
  })
  assert.equal(r.migrated, true)
  // 原文件是单对象 → 迁完仍是单对象（不能悄悄变成数组）
  assert.equal(readJson(statePath(dir, 'todo.json')).v, 2)
  assert.ok(!Array.isArray(readJson(statePath(dir, 'todo.json'))))
})

test('migrate：JSON 数组快照迁完仍是数组', (t) => {
  const dir = setup(t)
  ensureDir(dir)
  writeJsonAtomic(statePath(dir, 'todo.json'), [{ id: 'a' }, { id: 'b' }])
  writeSchemaVersion(dir, 'todo', 1)
  const r = migrate(dir, {
    name: 'todo',
    to: 2,
    migrateFn: (rows) => rows.map((x) => ({ ...x, v: 2 })),
  })
  assert.equal(r.migrated, true)
  const next = readJson(statePath(dir, 'todo.json'))
  assert.ok(Array.isArray(next), '数组形态必须保持')
  assert.deepEqual(next, [{ id: 'a', v: 2 }, { id: 'b', v: 2 }])
})

test('migrate：坏 JSONL 行数 >0 → 抛错不迁（不静默丢数据）', (t) => {
  const dir = setup(t)
  ensureDir(dir)
  writeFileSync(statePath(dir, 'board.jsonl'), '{"id":"a"}\n{bad json}\n', 'utf8')
  writeSchemaVersion(dir, 'board', 1)
  assert.throws(
    () => migrate(dir, { name: 'board', to: 2, migrateFn: (rows) => rows }),
    /无法解析/,
  )
  assert.equal(readSchemaVersion(dir, 'board'), 1, '迁移失败不得推进版本号')
})

test('migrate：migrateFn 返回非数组 → 抛错', (t) => {
  const dir = setup(t)
  ensureDir(dir)
  writeFileSync(statePath(dir, 'board.jsonl'), '{"id":"a"}\n', 'utf8')
  writeSchemaVersion(dir, 'board', 1)
  assert.throws(
    () => migrate(dir, { name: 'board', to: 2, migrateFn: () => ({ id: 'x' }) }),
    /必须返回数组/,
  )
})

test('migrate：from 不匹配 → 抛错', (t) => {
  const dir = setup(t)
  writeSchemaVersion(dir, 'board', 3)
  assert.throws(() => migrate(dir, { name: 'board', from: 1, to: 4, migrateFn: (r) => r }), /from=1/)
})

test('migrate：缺 name / to / migrateFn → 抛可读错误', (t) => {
  const dir = setup(t)
  assert.throws(() => migrate(dir, { to: 2, migrateFn: (r) => r }), /name/)
  assert.throws(() => migrate(dir, { name: 'board', migrateFn: (r) => r }), /to/)
  assert.throws(() => migrate(dir, { name: 'board', to: 2 }), /migrateFn/)
})

// ── 审计 ───────────────────────────────────────────────────────────────────

test('appendAudit 写入 audit.jsonl，含 ts/actor/action/target', (t) => {
  const dir = setup(t)
  assert.equal(appendAudit(dir, { ts: 1762300000000, actor: 'bot-a', action: 'claim', target: 'task-1' }), true)

  const lines = readFileSync(statePath(dir, 'audit.jsonl'), 'utf8').split('\n').filter((l) => l.trim())
  assert.equal(lines.length, 1)
  const rec = JSON.parse(lines[0])
  assert.equal(rec.ts, 1762300000000)
  assert.equal(rec.actor, 'bot-a')
  assert.equal(rec.action, 'claim')
  assert.equal(rec.target, 'task-1')
})

test('appendAudit 缺字段时补默认 ts 与 unknown，且保留额外字段', (t) => {
  const dir = setup(t)
  assert.equal(appendAudit(dir, { action: 'noop', extra: { a: 1 } }), true)
  const rec = JSON.parse(readFileSync(statePath(dir, 'audit.jsonl'), 'utf8').trim())
  assert.equal(typeof rec.ts, 'number')
  assert.ok(rec.ts > 0)
  assert.equal(rec.actor, 'unknown')
  assert.equal(rec.action, 'noop')
  assert.equal(rec.target, null)
  assert.deepEqual(rec.extra, { a: 1 })
})

test('appendAudit 是追加不是覆盖（三条 → 三行，顺序保持）', (t) => {
  const dir = setup(t)
  appendAudit(dir, { actor: 'a', action: 'x', target: 1 })
  appendAudit(dir, { actor: 'a', action: 'y', target: 2 })
  appendAudit(dir, { actor: 'b', action: 'z', target: 3 })
  const lines = readFileSync(statePath(dir, 'audit.jsonl'), 'utf8').split('\n').filter((l) => l.trim())
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map((l) => JSON.parse(l).target), [1, 2, 3])
})

test('appendAudit 不抛：坏 stateDir 返回 false（可被调用方看见）', () => {
  assert.equal(appendAudit('', { action: 'x' }), false)
  assert.equal(appendAudit(undefined, { action: 'x' }), false)
})

// ── 备份 ───────────────────────────────────────────────────────────────────

test('backupState 递归复制并返回 {ok,path}，目录名含 .bak-<ts>-<label>', (t) => {
  const dir = setup(t)
  ensureDir(statePath(dir, 'rooms'))
  writeJsonAtomic(statePath(dir, 'board.snap.json'), { tasks: [{ id: 'a' }] })
  writeFileSync(statePath(dir, 'rooms', 'r1.log.jsonl'), '{"seq":1}\n', 'utf8')

  const r = backupState(dir, 'snap')
  assert.equal(r.ok, true)
  assert.equal(typeof r.path, 'string')
  assert.match(r.path, /\.bak-\d{8}-\d{6}-snap$/)
  assert.ok(existsSync(r.path))
  // 递归内容真的在（不是空壳目录）
  assert.deepEqual(readJson(join(r.path, 'board.snap.json')), { tasks: [{ id: 'a' }] })
  assert.equal(readFileSync(join(r.path, 'rooms', 'r1.log.jsonl'), 'utf8'), '{"seq":1}\n')
  // 落在状态目录的兄弟路径上
  assert.ok(siblingsOf(dir).some((n) => n.endsWith('-snap')))
})

test('backupState label 里的非法字符被安全化（不逃出父目录）', (t) => {
  const dir = setup(t)
  const r = backupState(dir, '../evil label')
  assert.equal(r.ok, true)
  assert.equal(dirname(r.path), dirname(dir))
})

test('backupState 失败返回 {ok:false,reason} 不抛', () => {
  const r = backupState('/nonexistent-cs-bots-dir-xyz', 'snap')
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
  assert.ok(r.reason.length > 0)
})

// ── 恢复 ───────────────────────────────────────────────────────────────────

test('restoreState 缺 confirm / confirm 非 true → {ok:false,reason:"需要 confirm:true"}', (t) => {
  const dir = setup(t)
  for (const opts of [undefined, {}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }]) {
    const r = restoreState(dir, '/tmp/whatever', opts)
    assert.equal(r.ok, false)
    assert.equal(r.reason, '需要 confirm:true')
  }
})

test('restoreState confirm:true 时先改名 .pre-restore-<ts>，再还原备份内容', (t) => {
  const dir = setup(t)
  ensureDir(dir)
  writeJsonAtomic(statePath(dir, 'board.snap.json'), { n: 1 })
  const b = backupState(dir, 'snap')
  assert.equal(b.ok, true)

  // 破坏当前状态，并留一个只在"坏状态"里存在的文件作为反证
  writeJsonAtomic(statePath(dir, 'board.snap.json'), { n: 999 })
  writeFileSync(statePath(dir, 'junk.txt'), 'junk', 'utf8')

  const r = restoreState(dir, b.path, { confirm: true })
  assert.equal(r.ok, true)
  assert.deepEqual(readJson(statePath(dir, 'board.snap.json')), { n: 1 })
  assert.equal(existsSync(statePath(dir, 'junk.txt')), false, '坏状态的产物不应出现在恢复后的目录')
  assert.ok(
    siblingsOf(dir).some((n) => /\.pre-restore-\d{8}-\d{6}$/.test(n)),
    `无 pre-restore-<ts> 目录可回溯：${siblingsOf(dir).join(',')}`,
  )
})

test('restoreState 备份路径不存在 → {ok:false,reason}', (t) => {
  const dir = setup(t)
  const r = restoreState(dir, join(dirname(dir), 'no-such-backup-xyz'), { confirm: true })
  assert.equal(r.ok, false)
  assert.match(r.reason, /不存在/)
})

// ── 向后兼容：既有导出一个都不能少 ─────────────────────────────────────────

test('store.js 既有导出仍在（不破坏现有调用方）', () => {
  const fns = ['ensureDir', 'readJson', 'writeJsonAtomic', 'appendJsonl', 'readJsonl',
    'claimLock', 'ownsLock', 'heartbeatLock', 'releaseLock', 'nextSeq', 'fileMtime', 'statePath']
  for (const name of fns) assert.equal(typeof store[name], 'function', `缺导出：${name}`)
  assert.equal(typeof store.IdempotencySet, 'function')
  assert.equal(typeof store.IdempotencySet.prototype.check, 'function')
})

test('store.js 新增导出齐全', () => {
  const fns = ['readSchemaVersion', 'writeSchemaVersion', 'migrate', 'appendAudit', 'backupState', 'restoreState']
  for (const name of fns) assert.equal(typeof store[name], 'function', `缺导出：${name}`)
})

// ── settings 规格 ──────────────────────────────────────────────────────────

test('SETTING_SPECS.wipLimitPerBot：def 2 / min 1 / max 10', () => {
  const spec = SETTING_SPECS.wipLimitPerBot
  assert.ok(spec, '缺 wipLimitPerBot 规格')
  assert.equal(spec.def, 2)
  assert.equal(spec.min, 1)
  assert.equal(spec.max, 10)
})

test('validateSetting(wipLimitPerBot) 边界与越界', () => {
  assert.deepEqual(validateSetting('wipLimitPerBot', 2), { ok: true, value: 2 })
  assert.equal(validateSetting('wipLimitPerBot', 1).ok, true)
  assert.equal(validateSetting('wipLimitPerBot', 10).ok, true)
  assert.equal(validateSetting('wipLimitPerBot', 0).ok, false)
  assert.equal(validateSetting('wipLimitPerBot', 11).ok, false)
  const r = validateSetting('wipLimitPerBot', 11)
  assert.match(r.reason, /越界/)
})

test('validateSetting(featureFlags)：plain object 且 value 全为 boolean 才通过', () => {
  const ok = validateSetting('featureFlags', { a: true, b: false })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, { a: true, b: false })
  // 返回的是副本：改动副本不影响入参语义
  ok.value.a = false
  assert.deepEqual(validateSetting('featureFlags', { a: true, b: false }).value, { a: true, b: false })

  const bad = [
    ['字符串', 'x'],
    ['数字', 1],
    ['null', null],
    ['数组', [true]],
    ['value 非 boolean', { a: 1 }],
    ['value 是字符串', { a: 'true' }],
    ['Object.create(null) 允许', __proto_null_object()],
  ]
  for (const [label, raw] of bad.slice(0, 6)) {
    const r = validateSetting('featureFlags', raw)
    assert.equal(r.ok, false, `${label} 应被拒`)
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.reason.includes('featureFlags'), `${label} 的 reason 应点名键：${r.reason}`)
  }
})

function __proto_null_object() {
  return Object.assign(Object.create(null), { a: true })
}

test('validateSetting(featureFlags)：Object.create(null) 的空原型对象也算 plain object', () => {
  const r = validateSetting('featureFlags', __proto_null_object())
  assert.equal(r.ok, true)
  assert.deepEqual({ ...r.value }, { a: true })
})

test('defaultSettings 含 wipLimitPerBot=2 与 featureFlags={}', () => {
  const d = defaultSettings()
  assert.equal(d.wipLimitPerBot, 2)
  assert.deepEqual(d.featureFlags, {})
  // 默认值必须自身能通过校验（防"默认值就非法"这种低级坑）
  for (const [key, def] of Object.entries(d)) {
    const r = validateSetting(key, def)
    assert.equal(r.ok, true, `默认值 ${key}=${JSON.stringify(def)} 未通过自身校验：${r.reason ?? ''}`)
  }
})

test('settings 既有规格一项都没丢（向后兼容）', () => {
  for (const key of ['defaultLeaseMs', 'throttleMs', 'maxWakesPerTarget', 'memoryEntryMax',
    'memorySplitOnOverflow', 'k1Enabled', 'reviewEnabled', 'reviewInterval', 'reviewMode',
    'keyProgressiveDisclosure', 'perTurnWrites']) {
    assert.ok(SETTING_SPECS[key], `缺既有规格：${key}`)
  }
})