/**
 * 启动时把 Bot 主目录登记成 Workspace 分组 —— 装配级测试。
 *
 * ## 为什么需要这个测试（三次实测失败的教训）
 *   `workspaceRegistry` 是宿主服务，cs-bots 的 `apply` 跑得早，拿不到它。
 *   失败尝试：
 *     ① 直接调一次 → undefined → 放弃（0.11.0）
 *     ② setTimeout 重试 10×500ms → 仍失败（0.11.1，靠定时器猜就绪时机不可靠）
 *     ③ 证据：workspace.json 的 mtime 一直停在重启前，说明从未写成
 *   **正确做法**：`ctx.inject(['workspaceRegistry'], cb)` —— 服务就绪才回调。
 *
 * 本测试模拟宿主：`inject` 在微任务后才把 registry 交出来，
 * 验证插件确实**等到了**它，并把主目录登记上。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

function boot() {
  const base = mkdtempSync(join(tmpdir(), 'cs-bots-wsreg-'))
  const dshHome = join(base, '.dsh')
  const botsRoot = join(base, 'cs-bots')
  mkdirSync(join(dshHome, 'cs-bots'), { recursive: true })
  mkdirSync(botsRoot, { recursive: true })
  writeFileSync(join(dshHome, 'cs-bots', 'settings.json'), JSON.stringify({
    botWorkspaceRoot: botsRoot, departments: [{ id: 'dev', name: '开发部' }],
  }))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const created = []
  // registry 一开始「没就绪」：get() 返回 undefined，只有 inject 的回调才能拿到
  const registry = {
    async resolveByPath() { return undefined },
    async create(p) { created.push(p); return { workspace: { id: `ws-${p}`, path: p }, created: true } },
  }
  const injectCallbacks = []
  const ctx = {
    logger: { info() {}, warn() {} },
    // ★ 故意让 get 拿不到 registry —— 只有 inject 能拿到，逼插件走正确路径
    get: (k) => {
      if (k === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      if (k === 'webServer') return { register: () => () => {} }
      return undefined
    },
    inject: (names, cb) => { injectCallbacks.push({ names, cb }); return { dispose() {} } },
    on() {}, effect() {}, off() {},
  }
  apply(ctx, { stateDir: join(dshHome, 'cs-bots') })

  return {
    botsRoot, created, injectCallbacks,
    /** 模拟宿主：等服务就绪后触发 inject 回调。 */
    async releaseServices() {
      for (const { names, cb } of injectCallbacks) {
        if (names.includes('workspaceRegistry')) {
          // 回调收到的 scoped ctx 里 get 能拿到 registry
          cb({ ...ctx, get: (k) => (k === 'workspaceRegistry' ? registry : ctx.get(k)) })
        }
      }
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setTimeout(r, 20))
    },
    cleanup() {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
    },
  }
}

/**
 * 第二个夹具：模拟「运行时探测」——`ctx.get('workspaceRegistry')` 直接可用，
 * 不走 inject 回调。这是 0.13.3 之后的真实模型。
 */
function boot2({ registryAvailable = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cs-bots-wsreg2-'))
  const dshHome = join(base, '.dsh')
  const botsRoot = join(base, 'cs-bots')
  mkdirSync(join(dshHome, 'cs-bots'), { recursive: true })
  mkdirSync(botsRoot, { recursive: true })
  writeFileSync(join(dshHome, 'cs-bots', 'settings.json'), JSON.stringify({
    botWorkspaceRoot: botsRoot, departments: [{ id: 'dev', name: '开发部' }],
  }))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const created = []
  const registry = {
    async resolveByPath() { return undefined },
    async create(p) { created.push(p); return { workspace: { id: `ws-${p}`, path: p }, created: true } },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (k) => {
      if (k === 'workspaceRegistry') return registryAvailable ? registry : undefined
      if (k === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      if (k === 'webServer') return { register: () => () => {} }
      return undefined
    },
    on() {}, effect() {}, off() {},
  }
  apply(ctx, { stateDir: join(dshHome, 'cs-bots') })

  return {
    botsRoot, created,
    cleanup() {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
    },
  }
}

test('装配：插件**不**声明 inject（声明会导致 pending，见 index.js 注释）', async () => {
  // 2026-11-15 三次失败的结论：用 inject 会让插件 pending
  //   `inject = { required: [], optional: [...] }` 被 Cordis 当成服务名
  //   ⇒ 永远 waiting for services: required, optional ⇒ 插件不启动 ⇒ API 全 404。
  // 正确做法是**运行时探测 + 有限次重试**，不阻塞启动。
  const mod = await import('../src/index.js')
  assert.equal(mod.inject, undefined, '不应导出 inject（会阻塞插件启动）')
})

test('装配：服务可用后会把 Bot 主目录登记成 Workspace 分组（运行时探测模型）', async () => {
  const h = boot2({ registryAvailable: true })
  try {
    // 轮询最多 10×500ms，这里等 1.2s 足够
    await new Promise((r) => setTimeout(r, 1200))
    assert.deepEqual(h.created, [h.botsRoot], `应正好登记主目录一条，实际 ${JSON.stringify(h.created)}`)
  } finally { h.cleanup() }
})

test('装配：没有 inject API 的老宿主 ⇒ 不崩，插件照常装配', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cs-bots-noinj-'))
  const dshHome = join(base, '.dsh')
  mkdirSync(join(dshHome, 'cs-bots'), { recursive: true })
  writeFileSync(join(dshHome, 'cs-bots', 'settings.json'), JSON.stringify({
    botWorkspaceRoot: join(base, 'cs-bots'), departments: [{ id: 'dev', name: '开发部' }],
  }))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const ctx = {
      logger: { info() {}, warn() {} },
      get: (k) => {
        if (k === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
        if (k === 'webServer') return { register: () => () => {} }
        return undefined
      },
      // 故意不提供 inject
      on() {}, effect() {}, off() {},
    }
    assert.doesNotThrow(() => apply(ctx, { stateDir: join(dshHome, 'cs-bots') }))
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
  }
})
