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

/**
 * 生成一个「磁盘上肯定不存在」的临时路径。
 *
 * ⚠️ 为什么需要：2026-11-16 给 `ensureWorkspaceDir` 加了**磁盘查重**
 *   （先读 `workspace.json` 看这条路径是否已登记）。用固定的
 *   `/home/ubuntu/cs-bots` 会命中本机真实记录 ⇒ 直接返回 alreadyInFile ⇒ 测试假失败。
 */
let tmpSeq = 0
function freshPath() {
  tmpSeq += 1
  return `/tmp/cs-bots-wstest-${process.pid}-${Date.now()}-${tmpSeq}`
}

function ctxWith(registry) {
  return { get: (k) => (k === 'workspaceRegistry' ? registry : undefined) }
}

test('ensureWorkspaceDir：目录未注册 ⇒ 建一个，且**不挂任何 session**', async () => {
  const f = fakeRegistry()
  const p = freshPath()
  const r = await ensureWorkspaceDir(ctxWith(f.registry), p)
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.deepEqual(f.created, [p])
  assert.equal(f.attachCalls, 0, '只建分组容器，绝不能顺手挂会话（那是 2026-11-15 事故的成因）')
})

test('ensureWorkspaceDir：已注册 ⇒ 复用，不重复建', async () => {
  const __p = freshPath()
  const f = fakeRegistry({ existing: [__p] })
  const r = await ensureWorkspaceDir(ctxWith(f.registry), __p)
  assert.equal(r.ok, true)
  assert.equal(r.created, false)
  assert.deepEqual(f.created, [], '已存在就不该再 create（重复注册会导致 domain inconsistent）')
})

test('ensureWorkspaceDir：host 没有 workspaceRegistry ⇒ 返回 ok:false，绝不抛', async () => {
  const r = await ensureWorkspaceDir(ctxWith(undefined), freshPath())
  assert.equal(r.ok, false)
  assert.ok(r.reason, '要给可读原因，让调用方 warn 出来')
})

test('ensureWorkspaceDir：create 抛错 ⇒ 返回 ok:false 带原因，不冒泡', async () => {
  const registry = {
    async resolveByPath() { return undefined },
    async create() { throw new Error('domain is inconsistent') },
  }
  const r = await ensureWorkspaceDir(ctxWith(registry), freshPath())
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
  const r = await ensureWorkspaceDir(ctxWith(undefined), freshPath())
  assert.equal(r.ok, false)
  assert.match(r.reason, /未提供 workspaceRegistry/, 'reason 必须可识别，否则调用方无从判断该不该重试')
})

test('ensureWorkspaceDir：先未就绪、后就绪 ⇒ 第二次调用成功（模拟重试）', async () => {
  const __p = freshPath()
  let ready = false
  const f = fakeRegistry()
  const ctx = {
    get: (k) => (k === 'workspaceRegistry' && ready ? f.registry : undefined),
  }
  // 两次必须用**同一个路径**，否则测不出「重试成功」
  const first = await ensureWorkspaceDir(ctx, __p)
  assert.equal(first.ok, false, '第一次 registry 还没就绪')

  ready = true
  const second = await ensureWorkspaceDir(ctx, __p)
  assert.equal(second.ok, true, 'registry 就绪后重试必须成功')
  assert.equal(second.created, true)
  assert.deepEqual(f.created, [__p], '只建一次，不重复')
})

// ── 2026-11-15 Windows 实测：目录不存在时 registry.create 会抛 ──────────────
// 宿主 create 第一行是 realpathNormalize(path)，目录不存在直接抛。
// Linux 上没暴露是因为 /home/ubuntu/cs-bots 早就建好了；
// Windows 首次安装时 C:\Users\<你>\cs-bots 根本不存在 ⇒ 登记必失败 ⇒ 看不到分组。

test('★ ensureWorkspaceDir：目录不存在时必须先 mkdir（否则 Win 首次安装看不到分组）', async () => {
  const { mkdtempSync, rmSync, existsSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const base = mkdtempSync(join(tmpdir(), 'cs-bots-mkdir-'))
  const target = join(base, 'not-exist-yet', 'cs-bots')
  try {
    assert.equal(existsSync(target), false, '前提：目录确实不存在')

    // 模拟宿主的严格 create：目录不存在就抛（与 dsh-workspace/lib/index.js:408 同口径）
    const created = []
    const registry = {
      async resolveByPath() { return undefined },
      async create(p) {
        if (!existsSync(p)) throw new Error(`cannot create a workspace at '${p}': ENOENT`)
        created.push(p)
        return { workspace: { id: `ws-${p}`, path: p }, created: true }
      },
    }
    const r = await ensureWorkspaceDir(ctxWith(registry), target)
    assert.equal(r.ok, true, `应成功，实际：${r.reason}`)
    assert.equal(r.created, true)
    assert.deepEqual(created, [target])
    assert.equal(existsSync(target), true, '目录应被创建出来')
  } finally {
    try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
  }
})

test('★ ensureWorkspaceDir：mkd 失败时返回可读原因，不冒泡', async () => {
  // 拿一个「不可能建成的路径」：把文件当目录用
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'cs-bots-mkdirfail-'))
  const asFile = join(base, 'iam-a-file')
  writeFileSync(asFile, 'x')
  try {
    const registry = { async resolveByPath() { return undefined }, async create() { throw new Error('should not reach') } }
    const r = await ensureWorkspaceDir(ctxWith(registry), join(asFile, 'sub'))
    assert.equal(r.ok, false)
    assert.match(r.reason, /建目录失败|建 Workspace 失败/, `原因应可读：${r.reason}`)
  } finally {
    try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
  }
})
