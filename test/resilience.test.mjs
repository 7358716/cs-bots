/**
 * cs-bots 韧性测试 —— **apply() 绝不允许把宿主启动搞崩**。
 *
 * 为什么这是全项目最重要的一份测试：
 *   社区/自建插件最常见的「重启 DSH 后报错、必须禁用插件才能打开」故障，
 *   根因都是 **apply() 抛错**（或模块装载期抛错）→ 宿主启动流程中断。
 *
 * 我们已在真实宿主上踩过同类的两个 bug：
 *   - `cannot set property "csBots" without provide`
 *   - `cannot get property "webServer" without inject`
 * 二者在 mock 单测里全绿，只有真实启动才暴露。
 *
 * 所以这里**主动构造各种恶劣宿主**，逐个断言 `apply()` 不抛。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { probeHost, formatReport } from '../src/compat.js'
import { getServices } from '../src/registry.js'

/** 造一个临时状态目录。 */
function tmp() {
  return mkdtempSync(join(tmpdir(), 'cs-bots-res-'))
}

// ── 恶劣宿主：apply 必须不抛 ─────────────────────────────────────────────────

test('apply(undefined) 不抛', () => {
  assert.doesNotThrow(() => apply(undefined, {}))
})

test('apply(null) 不抛', () => {
  assert.doesNotThrow(() => apply(null, {}))
})

test('apply(空对象) 不抛（无 logger / 无服务）', () => {
  assert.doesNotThrow(() => apply({}, {}))
})

test('宿主 ctx 每次属性访问都抛 —— apply 仍不抛', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('hostile host: property access denied')
      },
      set() {
        throw new Error('hostile host: property write denied')
      },
      has() {
        throw new Error('hostile host: has() denied')
      },
    },
  )
  const dir = tmp()
  try {
    assert.doesNotThrow(() => apply(hostile, { stateDir: dir }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('logger 本身会抛 —— apply 不抛', () => {
  const ctx = {
    logger: {
      info() {
        throw new Error('logger.info boom')
      },
      warn() {
        throw new Error('logger.warn boom')
      },
    },
    get: () => undefined,
    on: () => {},
    effect: () => {},
  }
  const dir = tmp()
  try {
    assert.doesNotThrow(() => apply(ctx, { stateDir: dir }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools.register 抛错 —— apply 不抛（工具层降级）', () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) =>
      key === 'tools'
        ? {
            register() {
              throw new Error('register boom')
            },
            guard() {
              throw new Error('guard boom')
            },
            schemas: () => [],
          }
        : undefined,
    on: () => {},
    effect: () => {},
  }
  const dir = tmp()
  try {
    assert.doesNotThrow(() => apply(ctx, { stateDir: dir }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('webServer.register 抛错 —— apply 不抛（API 层降级）', () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) =>
      key === 'webServer'
        ? {
            register() {
              throw new Error('route boom')
            },
          }
        : undefined,
    on: () => {},
    effect: () => {},
  }
  const dir = tmp()
  try {
    assert.doesNotThrow(() => apply(ctx, { stateDir: dir }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ctx.on 抛错 —— apply 不抛', () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    on() {
      throw new Error('on boom')
    },
    effect() {
      throw new Error('effect boom')
    },
  }
  const dir = tmp()
  try {
    assert.doesNotThrow(() => apply(ctx, { stateDir: dir }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('状态目录不可写 —— apply 不抛（各域降级但不崩）', () => {
  const ctx = { logger: { info: () => {}, warn: () => {} }, get: () => undefined, on: () => {}, effect: () => {} }
  // 用一个必然不可创建的路径（父级是文件而非目录时必然失败）
  assert.doesNotThrow(() => apply(ctx, { stateDir: '/dev/null/definitely-not-a-dir' }))
})

// ── 兼容性探测本身也不抛 ─────────────────────────────────────────────────────

test('probeHost 在恶劣宿主上不抛，且返回完整结构', () => {
  let report
  assert.doesNotThrow(() => {
    report = probeHost(new Proxy({}, { get: () => { throw new Error('boom') } }))
  })
  assert.ok(report, '应返回报告')
  assert.ok(report.available && typeof report.available === 'object', '应有 available')
  assert.ok(Array.isArray(report.missing), '应有 missing 数组')
  assert.equal(typeof report.node, 'string')
})

test('probeHost(undefined) 不抛，并报出缺失能力', () => {
  let report
  assert.doesNotThrow(() => {
    report = probeHost(undefined)
  })
  assert.ok(report.missing.length > 0, '空宿主应报缺失')
  assert.ok(report.missing.includes('tools.register'), '应报缺 tools.register')
})

test('formatReport 对不完整报告也不抛', () => {
  assert.doesNotThrow(() => formatReport({ available: {}, missing: [], notes: [], node: 'x' }))
  assert.equal(typeof formatReport({ available: {}, missing: [], notes: [], node: 'x' }), 'string')
})

// ── 正常宿主：探测结果与实际一致 ─────────────────────────────────────────────

test('probeHost 在"像样"的宿主上能正确识别能力', () => {
  const ctx = {
    reflect: { get: (name) => (name === 'tools' ? { register() {}, guard() {}, restrict() {}, schemas: () => [] } : undefined) },
    on: () => {},
    effect: () => {},
  }
  const report = probeHost(ctx)
  assert.equal(report.available['ctx.reflect.get'], true)
  assert.equal(report.available['tools.register'], true)
  assert.equal(report.available['ctx.on'], true)
  assert.equal(report.available['agents.create'], false, '未提供的服务应记为 false')
})

test('compat 报告会挂到 services（UI /status 可读）', () => {
  const ctx = { logger: { info: () => {}, warn: () => {} }, get: () => undefined, on: () => {}, effect: () => {} }
  const dir = tmp()
  try {
    apply(ctx, { stateDir: dir })
    const services = getServices(ctx)
    assert.ok(services.compat, 'services 应含 compat 报告')
    assert.ok(services.compat.available, 'compat 应含 available')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
