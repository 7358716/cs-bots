/**
 * VerifyService 测试 —— PDCA 检查面的证据自动化。
 *
 * 重点验证安全约束：命令白名单 + 无 shell 注入 + 超时保护。
 * 运行：`node --test test/verify.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import createVerify, { VerifyError, CMD_WHITELIST } from '../src/verify.js'

let counter = 0
function setup(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), `cs-bots-verify-${process.pid}-${counter++}-`))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  const svc = createVerify({ logger: { info() {}, warn() {} } }, { stateDir: dir, ...config })
  return { dir, svc }
}

function readEvents(dir) {
  const f = join(dir, 'verify.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('file exists → ok:true', async (t) => {
  const { dir, svc } = setup(t)
  writeFileSync(join(dir, 'a.txt'), 'hello')
  const r = await svc.check({ kind: 'file', path: join(dir, 'a.txt'), by: 'test' })
  assert.equal(r.result.ok, true)
  assert.equal(r.result.exists, true)
  assert.equal(r.result.size, 5)
})

test('file absent → ok:false', async (t) => {
  const { dir, svc } = setup(t)
  const r = await svc.check({ kind: 'file', path: join(dir, 'nope.txt'), by: 'test' })
  assert.equal(r.result.ok, false)
  assert.equal(r.result.exists, false)
})

test('file nonempty / empty 断言', async (t) => {
  const { dir, svc } = setup(t)
  writeFileSync(join(dir, 'empty.txt'), '')
  writeFileSync(join(dir, 'full.txt'), 'x')
  const emptyOk = await svc.check({ kind: 'file', path: join(dir, 'empty.txt'), expected: 'nonempty', by: 'test' })
  assert.equal(emptyOk.result.ok, false)
  const fullOk = await svc.check({ kind: 'file', path: join(dir, 'full.txt'), expected: 'nonempty', by: 'test' })
  assert.equal(fullOk.result.ok, true)
  const absentOk = await svc.check({ kind: 'file', path: join(dir, 'gone.txt'), expected: 'absent', by: 'test' })
  assert.equal(absentOk.result.ok, true)
})

test('非法 kind 抛 VERIFY_BAD_KIND', async (t) => {
  const { svc } = setup(t)
  await assert.rejects(() => svc.check({ kind: 'bad', by: 'x' }), (e) => e instanceof VerifyError && e.code === 'VERIFY_BAD_KIND')
})

test('command 白名单外抛 VERIFY_CMD_NOT_ALLOWED', async (t) => {
  const { svc } = setup(t)
  await assert.rejects(
    () => svc.check({ kind: 'command', cmd: ['rm', '-rf', '/'], by: 'x' }),
    (e) => e.code === 'VERIFY_CMD_NOT_ALLOWED',
  )
})

test('command 执行成功', async (t) => {
  const { svc } = setup(t)
  const r = await svc.check({ kind: 'command', cmd: ['node', '-e', 'console.log(1)'], by: 'test' })
  assert.equal(r.result.ok, true)
  assert.equal(r.result.exitCode, 0)
  assert.match(r.result.stdout, /1/)
})

test('command 执行失败（非零退出码）', async (t) => {
  const { svc } = setup(t)
  const r = await svc.check({ kind: 'command', cmd: ['node', '-e', 'process.exit(3)'], by: 'test' })
  assert.equal(r.result.ok, false)
  assert.equal(r.result.exitCode, 3)
})

test('command expectExit 断言', async (t) => {
  const { svc } = setup(t)
  const r = await svc.check({ kind: 'command', cmd: ['node', '-e', 'process.exit(2)'], expectExit: 2, by: 'test' })
  assert.equal(r.result.ok, true)
})

test('command expectOutput 断言', async (t) => {
  const { svc } = setup(t)
  const r = await svc.check({ kind: 'command', cmd: ['node', '-e', 'console.log("hello")'], expectOutput: 'hello', by: 'test' })
  assert.equal(r.result.ok, true)
})

test('command 超时保护', async (t) => {
  const { svc } = setup(t)
  const r = await svc.check({ kind: 'command', cmd: ['node', '-e', 'setTimeout(()=>{},5000)'], timeoutMs: 300, by: 'test' })
  assert.equal(r.result.ok, false)
  assert.equal(r.result.error, 'timeout')
})

test('command 参数非数组抛 VERIFY_BAD_CMD', async (t) => {
  const { svc } = setup(t)
  await assert.rejects(() => svc.check({ kind: 'command', cmd: 'rm -rf /', by: 'x' }), (e) => e.code === 'VERIFY_BAD_CMD')
})

test('evaluate 汇总 passed/failed', (t) => {
  const { dir, svc } = setup(t)
  writeFileSync(join(dir, 'a.txt'), 'x')
  const r = svc.evaluate([join(dir, 'a.txt'), join(dir, 'missing.txt')])
  assert.equal(r.ok, false)
  assert.equal(r.passed, 1)
  assert.equal(r.failed, 1)
  assert.equal(r.results.length, 2)
})

test('verifyTask 对 artifacts + writeScopes 检查', (t) => {
  const { dir, svc } = setup(t)
  writeFileSync(join(dir, 'out.js'), 'x')
  const ok = svc.verifyTask({ id: 't-1', artifacts: [join(dir, 'out.js')], writeScopes: [dir] }, { by: 'test' })
  assert.equal(ok.result.ok, true)
  const bad = svc.verifyTask({ id: 't-2', artifacts: [join(dir, 'gone.js')], writeScopes: [] }, { by: 'test' })
  assert.equal(bad.result.ok, false)
})

test('test 种类必须提供 cwd', async (t) => {
  const { svc } = setup(t)
  await assert.rejects(() => svc.check({ kind: 'test', by: 'x' }), (e) => e.code === 'VERIFY_BAD_FIELD')
})

test('test 种类跑脚本成功', async (t) => {
  const { dir, svc } = setup(t)
  // 写一个永远成功的小脚本（用 suite 参数走 bash <path>，不经过 shell 注入面）
  const script = join(dir, 'ok.sh')
  writeFileSync(script, '#!/bin/bash\nexit 0\n')
  const r = await svc.check({ kind: 'test', suite: script, cwd: dir, by: 'test' })
  assert.equal(r.result.ok, true)
  assert.equal(r.result.exitCode, 0)
})

test('replay 从 jsonl 重建', (t) => {
  const { dir, svc } = setup(t)
  svc.verifyTask({ id: 't-1', artifacts: [], writeScopes: [dir] }, { by: 'test' })
  const fresh = createVerify({ logger: { info() {}, warn() {} } }, { stateDir: dir })
  assert.equal(fresh.stats().total, 1)
  assert.equal(fresh.replay().from, 'jsonl')
})

test('坏行不静默', (t) => {
  const { dir, svc } = setup(t)
  
  appendFileSync(join(dir, 'verify.jsonl'), 'not json\n')
  const rep = createVerify({ logger: { info() {}, warn() {} } }, { stateDir: dir }).replay()
  assert.equal(rep.bad, 1)
})

test('dispose 后抛 VERIFY_DISPOSED', (t) => {
  const { svc } = setup(t)
  svc.dispose()
  assert.throws(() => svc.evaluate([]), (e) => e.code === 'VERIFY_DISPOSED')
})

test('CMD_WHITELIST 是冻结白名单（含 bash/node，不含危险命令）', () => {
  assert.ok(CMD_WHITELIST.includes('bash'))
  assert.ok(CMD_WHITELIST.includes('node'))
  assert.ok(!CMD_WHITELIST.includes('rm'))
  assert.ok(!CMD_WHITELIST.includes('curl'))
})
