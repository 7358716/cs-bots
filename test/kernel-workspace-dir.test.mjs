/**
 * ensureWorkspaceDir —— 把 Bot 主目录注册成 Workspace 分组（2026-11-15 左侧栏分层）。
 *
 * ## 为什么需要它
 *   宿主 `owningParentFolder()`（dsh-client-ui-workspace/lib/client.js:1234）会把
 *   「路径在某个已注册 Workspace 之下」的 Workspace 自动嵌套进父分组。
 *   ⇒ 注册 `<botsRoot>` 一条，它下面的 `<botsRoot>/dev/xxx` 就自动折进去，
 *   左侧栏从「N 个 Bot 各自一条」变成「1 个 cs-bots 可展开」。
 *
 * ## 为什么测试要钉住「不挂 session」
 *   2026-11-15 事故：启动时并发 attachSession 把同一路径注册两次，
 *   搞出 workspace domain inconsistent。本函数只建分组、不碰会话 —— 测试守住这条。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ensureWorkspaceDir } from '../src/kernel.js'

/** 造一个最小的 workspaceRegistry 替身，记录调用。 */
function fakeRegistry({ existing = [] } = {}) {
  const created = []
  let attachCalls = 0
  const map = new Map(existing.map((p) => [p, { path: p, attachSession() { attachCalls += 1 } }]))
  return {
    created,
    get attachCalls() { return attachCalls },
    registry: {
      async resolveByPath(p) { return map.get(p) },
      async create(p) {
        created.push(p)
        const ws = { path: p, attachSession() { attachCalls += 1 } }
        map.set(p, ws)
        return { workspace: ws, created: true }
      },
    },
  }
}

function ctxWith(registry) {
  return { get: (k) => (k === 'workspaceRegistry' ? registry : undefined) }
}

test('ensureWorkspaceDir：目录未注册 ⇒ 建一个，且**不挂任何 session**', async () => {
  const f = fakeRegistry()
  const r = await ensureWorkspaceDir(ctxWith(f.registry), '/home/ubuntu/cs-bots')
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.deepEqual(f.created, ['/home/ubuntu/cs-bots'])
  assert.equal(f.attachCalls, 0, '只建分组容器，绝不能顺手挂会话（那是 2026-11-15 事故的成因）')
})

test('ensureWorkspaceDir：已注册 ⇒ 复用，不重复建', async () => {
  const f = fakeRegistry({ existing: ['/home/ubuntu/cs-bots'] })
  const r = await ensureWorkspaceDir(ctxWith(f.registry), '/home/ubuntu/cs-bots')
  assert.equal(r.ok, true)
  assert.equal(r.created, false)
  assert.deepEqual(f.created, [], '已存在就不该再 create（重复注册会导致 domain inconsistent）')
})

test('ensureWorkspaceDir：host 没有 workspaceRegistry ⇒ 返回 ok:false，绝不抛', async () => {
  const r = await ensureWorkspaceDir(ctxWith(undefined), '/home/ubuntu/cs-bots')
  assert.equal(r.ok, false)
  assert.ok(r.reason, '要给可读原因，让调用方 warn 出来')
})

test('ensureWorkspaceDir：create 抛错 ⇒ 返回 ok:false 带原因，不冒泡', async () => {
  const registry = {
    async resolveByPath() { return undefined },
    async create() { throw new Error('domain is inconsistent') },
  }
  const r = await ensureWorkspaceDir(ctxWith(registry), '/home/ubuntu/cs-bots')
  assert.equal(r.ok, false)
  assert.match(r.reason, /domain is inconsistent/, '要把宿主的原始原因带出来，别吞掉')
})

test('ensureWorkspaceDir：dir 为空 ⇒ ok:false（不拿空路径去 create）', async () => {
  const f = fakeRegistry()
  assert.equal((await ensureWorkspaceDir(ctxWith(f.registry), '')).ok, false)
  assert.equal((await ensureWorkspaceDir(ctxWith(f.registry), null)).ok, false)
  assert.deepEqual(f.created, [])
})

// ── 2026-11-15 实测：workspaceRegistry 在 apply 时可能还没就绪 ─────────────
// 症状：重启后 workspace.json 的 mtime 停在重启前 —— 说明那次注册根本没成功写过。
// 调用方必须**有限次重试**，等宿主把 registry provide 出来。

test('ensureWorkspaceDir：registry 未就绪时返回可识别的 reason（调用方据此重试）', async () => {
  const r = await ensureWorkspaceDir(ctxWith(undefined), '/home/ubuntu/cs-bots')
  assert.equal(r.ok, false)
  assert.match(r.reason, /未提供 workspaceRegistry/, 'reason 必须可识别，否则调用方无从判断该不该重试')
})

test('ensureWorkspaceDir：先未就绪、后就绪 ⇒ 第二次调用成功（模拟重试）', async () => {
  let ready = false
  const f = fakeRegistry()
  const ctx = {
    get: (k) => (k === 'workspaceRegistry' && ready ? f.registry : undefined),
  }
  const first = await ensureWorkspaceDir(ctx, '/home/ubuntu/cs-bots')
  assert.equal(first.ok, false, '第一次 registry 还没就绪')

  ready = true
  const second = await ensureWorkspaceDir(ctx, '/home/ubuntu/cs-bots')
  assert.equal(second.ok, true, 'registry 就绪后重试必须成功')
  assert.equal(second.created, true)
  assert.deepEqual(f.created, ['/home/ubuntu/cs-bots'], '只建一次，不重复')
})
