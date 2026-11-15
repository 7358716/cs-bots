/**
 * 工作区整理：移除工作区**登记**（保留文件与会话）。
 *
 * 需求出处（Boss 2026-11-15）：
 *   「我希望在工作区这里能够只有一个 CS-bots，对工作区这里进行改动或者在上面直接新增一个，
 *     下级可以向下展开的」
 *
 * 官方语义（`dsh-api-workspace-controller/lib/types/index.d.ts:57`）：
 *   Remove one Workspace registration while **retaining files and Sessions**.
 *   ⇒ 只摘掉左侧栏分组，磁盘和会话都还在。这是「左侧栏太乱」的正确解法。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { removeWorkspaceByPath } from '../src/kernel.js'

function ctxWith({ registry, controller }) {
  return {
    get: (k) => {
      if (k === 'workspaceRegistry') return registry
      if (k === 'workspaceController') return controller
      return undefined
    },
  }
}

test('removeWorkspaceByPath：登记存在 ⇒ 调 controller.delete，返回 removed:true', async () => {
  const deleted = []
  const ctx = ctxWith({
    registry: { async resolveByPath(p) { return p === '/home/ubuntu/output/旧岗' ? { id: 'ws-1', path: p } : undefined } },
    controller: { async delete(req) { deleted.push(req.workspaceId); return { deleted: true } } },
  })
  const r = await removeWorkspaceByPath(ctx, '/home/ubuntu/output/旧岗')
  assert.equal(r.ok, true)
  assert.equal(r.removed, true)
  assert.deepEqual(deleted, ['ws-1'], '必须用 resolveByPath 拿到的 id 去删')
})

test('removeWorkspaceByPath：本来就没登记 ⇒ removed:false，不当成错误', async () => {
  const deleted = []
  const ctx = ctxWith({
    registry: { async resolveByPath() { return undefined } },
    controller: { async delete(req) { deleted.push(req.workspaceId) } },
  })
  const r = await removeWorkspaceByPath(ctx, '/home/ubuntu/不存在')
  assert.equal(r.ok, true)
  assert.equal(r.removed, false)
  assert.deepEqual(deleted, [], '没登记就不该调 delete')
})

test('removeWorkspaceByPath：缺 workspaceController ⇒ ok:false 带原因，绝不抛', async () => {
  const ctx = ctxWith({ registry: { async resolveByPath() { return { id: 'x' } } }, controller: undefined })
  const r = await removeWorkspaceByPath(ctx, '/home/ubuntu/cs-bots')
  assert.equal(r.ok, false)
  assert.match(r.reason, /workspaceController/)
})

test('removeWorkspaceByPath：缺 workspaceRegistry ⇒ ok:false 带原因', async () => {
  const ctx = ctxWith({ registry: undefined, controller: { async delete() {} } })
  const r = await removeWorkspaceByPath(ctx, '/home/ubuntu/cs-bots')
  assert.equal(r.ok, false)
  assert.match(r.reason, /workspaceRegistry/)
})

test('removeWorkspaceByPath：delete 抛错 ⇒ ok:false 且把原始原因带出来', async () => {
  const ctx = ctxWith({
    registry: { async resolveByPath() { return { id: 'x' } } },
    controller: { async delete() { throw new Error('not-found') } },
  })
  const r = await removeWorkspaceByPath(ctx, '/home/ubuntu/cs-bots')
  assert.equal(r.ok, false)
  assert.match(r.reason, /not-found/)
})

test('removeWorkspaceByPath：空路径 ⇒ 直接拒绝，不碰宿主服务', async () => {
  let called = false
  const ctx = ctxWith({
    registry: { async resolveByPath() { called = true } },
    controller: { async delete() { called = true } },
  })
  assert.equal((await removeWorkspaceByPath(ctx, '')).ok, false)
  assert.equal((await removeWorkspaceByPath(ctx, null)).ok, false)
  assert.equal(called, false)
})
