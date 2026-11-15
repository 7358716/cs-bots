/**
 * cs-bots 改造06 §2.4 · CS-BOTS 工作区端点测试（GET /workspace）
 * 外加：settings.js 的 botWorkspaceRoot 项 + validateSetting 校验，
 *      以及 POST /roster 的 cwd 兜底。
 *
 * 手法与 `test/api-anchor.test.mjs` 一致：直接调注册出去的 handler（boot() 假 ctx + req()）。
 *
 * 为什么必须测：
 *   - `POST /roster` 的 cwd 兜底是「新建 Bot 默认落盘目录」的唯一入口：
 *     兜底失效 → 建 Bot 直接 400（用户体验上是「没法建 Bot」）；
 *   - settings 校验必须拦住「工作区落在 $DSH_HOME 内」——那是宿主数据/凭据目录，
 *     Bot 写进去就是数据污染（与 roster.js 的 cwd 校验同口径）；
 *   - `/workspace` 是只读诊断：root 为空/目录不存在时必须如实上报，不能抛。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'
import { SETTING_SPECS, defaultSettings, validateSetting, loadSettings, saveSettings } from '../src/settings.js'

function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-workspace-'))
  let handler = null
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') {
        return {
          async create(request) { return { id: request?.sessionId, sessionId: request?.sessionId } },
          get: () => undefined,
          list: () => [],
        }
      }
      if (key === 'tools') return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      if (key === 'webServer') {
        return {
          register: ({ path, handler: h }) => {
            assert.equal(path, API_BASE)
            handler = h
            return () => {}
          },
        }
      }
      return undefined
    },
    on: () => {},
    effect: () => {},
  }
  apply(ctx, { stateDir })
  const services = getServices(ctx)
  const realDispatcher = services.dispatcher
  const h = {
    ctx,
    stateDir,
    services,
    async req(method, path, body) {
      assert.ok(handler, 'API handler 应已注册')
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0
      let raw = ''
      const response = {
        writeHead(code) { status = code },
        end(chunk) { raw += chunk ?? '' },
      }
      await handler(request, response)
      let json
      try { json = JSON.parse(raw) } catch { json = { _raw: raw } }
      return { status, json }
    },
    cleanup() {
      try { realDispatcher?.dispose?.() } catch { /* 已释放 */ }
      for (const k of ['dispatcher', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { getServices(ctx)[k]?.dispose?.() } catch { /* 已释放 */ }
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
  return h
}

// ── GET /workspace ──────────────────────────────────────────────────────────

test('GET /workspace：200，字段齐全；dshHome 解析正确', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())

  const r = await h.req('GET', '/workspace')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.ok(typeof r.json.root === 'string' || r.json.root === null)
  assert.equal(typeof r.json.exists, 'boolean')
  assert.equal(typeof r.json.dshHome, 'string')
  assert.equal(r.json.note, 'CS-BOTS 所有会话的默认工作区：shared/ 放交付物，scratch/ 放草稿，archive/ 放归档')
  assert.ok(r.json.dshHome.startsWith('/'))
})

test('GET /workspace：root 指向真实目录时 exists=true', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const dir = mkdtempSync(join(tmpdir(), 'cs-bots-ws-root-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 直接改内存副本（端点只读内存值），不写磁盘
  h.services.settings = { ...h.services.settings, botWorkspaceRoot: dir }

  const r = await h.req('GET', '/workspace')
  assert.equal(r.status, 200)
  assert.equal(r.json.root, dir)
  assert.equal(r.json.exists, true)
})

test('GET /workspace：root 不存在时 exists=false（不抛）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const missing = join(tmpdir(), `cs-bots-missing-${Date.now()}`)
  h.services.settings = { ...h.services.settings, botWorkspaceRoot: missing }

  const r = await h.req('GET', '/workspace')
  assert.equal(r.status, 200, 'root 不存在必须如实上报而不是 500')
  assert.equal(r.json.root, missing)
  assert.equal(r.json.exists, false)
})

test('GET /workspace：root 指向文件（非目录）时 exists=false', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const file = join(tmpdir(), `cs-bots-ws-file-${Date.now()}.txt`)
  writeFileSync(file, 'x', 'utf8')
  t.after(() => rmSync(file, { force: true }))
  h.services.settings = { ...h.services.settings, botWorkspaceRoot: file }

  const r = await h.req('GET', '/workspace')
  assert.equal(r.status, 200)
  assert.equal(r.json.exists, false)
})

// ── settings.js：botWorkspaceRoot 规格与校验 ───────────────────────────────

test('settings：botWorkspaceRoot 规格存在，默认值是合法绝对路径', () => {
  assert.ok(SETTING_SPECS.botWorkspaceRoot, '必须存在 botWorkspaceRoot 规格')
  const def = defaultSettings().botWorkspaceRoot
  assert.equal(typeof def, 'string')
  assert.ok(resolve(def) === def, `默认值应是绝对路径，实际 ${def}`)
})

test('settings：validateSetting(botWorkspaceRoot) 合法/非法边界', () => {
  const okAbs = validateSetting('botWorkspaceRoot', '/home/ubuntu/CS-BOTS')
  assert.equal(okAbs.ok, true)
  assert.equal(okAbs.value, '/home/ubuntu/CS-BOTS')

  const rel = validateSetting('botWorkspaceRoot', 'relative/dir')
  assert.equal(rel.ok, false)

  const empty = validateSetting('botWorkspaceRoot', '   ')
  assert.equal(empty.ok, false)

  const nonString = validateSetting('botWorkspaceRoot', 123)
  assert.equal(nonString.ok, false)
})

test('settings：botWorkspaceRoot 允许落在 $DSH_HOME 内（2026-11-15 Boss 改规则）', () => {
  // Boss 定：默认值就是 `<DSH_HOME>/cs-bots`，所以必须允许 .dsh 子树，
  // 否则「默认值自己不合法」。旧限制（不得在 $DSH_HOME 内）已取消。
  const dshHome = resolve(process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`)

  const sub = validateSetting('botWorkspaceRoot', join(dshHome, 'cs-bots'))
  assert.equal(sub.ok, true, `.dsh 的下级应合法：${join(dshHome, 'cs-bots')}`)
  assert.equal(sub.value, join(dshHome, 'cs-bots'))

  const deeper = validateSetting('botWorkspaceRoot', join(dshHome, 'cs-bots', 'x'))
  assert.equal(deeper.ok, true, '.dsh 的更深子树也应合法')

  // 平级目录仍合法
  const sibling = resolve(dshHome, '..', 'CS-BOTS')
  assert.equal(validateSetting('botWorkspaceRoot', sibling).ok, true, `平级目录应合法：${sibling}`)

  // **仍然必须**是绝对路径 + 非空
  assert.equal(validateSetting('botWorkspaceRoot', '').ok, false)
  assert.equal(validateSetting('botWorkspaceRoot', 'relative/path').ok, false)
})

test('settings：loadSettings 对非法值退回默认且记入 badKeys；不静默', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-settings-'))
  try {
    const dshHome = resolve(process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`)
    writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
      botWorkspaceRoot: 'not-an-absolute-path',   // 真正非法：相对路径（.dsh 子树现在合法了）
      wipLimitPerBot: 99,
    }), 'utf8')
    const { values, diagnostics } = loadSettings(stateDir)
    assert.equal(values.botWorkspaceRoot, SETTING_SPECS.botWorkspaceRoot.def, '非法值退回默认')
    assert.equal(values.wipLimitPerBot, SETTING_SPECS.wipLimitPerBot.def, '越界值退回默认')
    assert.ok(diagnostics.badKeys.some((k) => k.key === 'botWorkspaceRoot'))
    assert.ok(diagnostics.badKeys.some((k) => k.key === 'wipLimitPerBot'))
    assert.equal(diagnostics.source, 'file')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('settings：saveSettings 拒绝相对路径（不写半坏配置）；.dsh 子树现在允许', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-settings-save-'))
  try {
    const dshHome = resolve(process.env.DSH_HOME || `${process.env.HOME ?? '.'}/.dsh`)

    // ① 相对路径仍必须拒绝
    const bad = saveSettings(stateDir, { botWorkspaceRoot: 'relative/path' })
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /绝对路径/)
    // 拒绝后不应落盘该键
    const { values } = loadSettings(stateDir)
    assert.equal(values.botWorkspaceRoot, SETTING_SPECS.botWorkspaceRoot.def)

    // ② .dsh 的下级**现在允许**（2026-11-15 Boss 改规则，默认值就在这儿）
    const inDsh = join(dshHome, 'cs-bots')
    const okInDsh = saveSettings(stateDir, { botWorkspaceRoot: inDsh })
    assert.equal(okInDsh.ok, true, `.dsh 的下级应可保存：${inDsh}`)
    assert.equal(loadSettings(stateDir).values.botWorkspaceRoot, inDsh)

    const dir = mkdtempSync(join(tmpdir(), 'cs-bots-ws-ok-'))
    try {
      const okRes = saveSettings(stateDir, { botWorkspaceRoot: dir })
      assert.equal(okRes.ok, true)
      assert.equal(okRes.values.botWorkspaceRoot, dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ── POST /roster 的 cwd 兜底 ─────────────────────────────────────────────────

test('POST /roster：body.cwd 空白时用 settings.botWorkspaceRoot 兜底', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const dir = mkdtempSync(join(tmpdir(), 'cs-bots-roster-cwd-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  h.services.settings = { ...h.services.settings, botWorkspaceRoot: dir }

  const r = await h.req('POST', '/roster', { name: 'ws-bot-1' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.bot.cwd, dir, 'cwd 应为 settings.botWorkspaceRoot 兜底值')
})

test('POST /roster：显式 cwd 优先，不覆盖', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const fallback = mkdtempSync(join(tmpdir(), 'cs-bots-roster-fb-'))
  const explicit = mkdtempSync(join(tmpdir(), 'cs-bots-roster-ex-'))
  t.after(() => {
    rmSync(fallback, { recursive: true, force: true })
    rmSync(explicit, { recursive: true, force: true })
  })
  h.services.settings = { ...h.services.settings, botWorkspaceRoot: fallback }

  const r = await h.req('POST', '/roster', { name: 'ws-bot-2', cwd: explicit })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.bot.cwd, explicit)
})

test('POST /roster：cwd 与兜底都空时保持原行为（400，不静默建 Bot）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  h.services.settings = { ...h.services.settings, botWorkspaceRoot: undefined }

  const r = await h.req('POST', '/roster', { name: 'ws-bot-3' })
  assert.equal(r.status, 400, '缺 cwd 必须 400（与 roster 的必填校验同口径）')
  assert.equal(r.json.ok, false)
  assert.ok(r.json.reason.length > 0)
})

test('POST /roster：兜底目录会被真实使用（建目录 + Bot 落注册表）', async (t) => {
  const h = boot()
  t.after(() => h.cleanup())
  const dir = mkdtempSync(join(tmpdir(), 'cs-bots-roster-real-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  h.services.settings = { ...h.services.settings, botWorkspaceRoot: dir }

  const r = await h.req('POST', '/roster', { name: 'ws-bot-4' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.ok(existsSync(dir), '兜底目录应被创建')
  assert.equal(statSync(dir).isDirectory(), true)
  mkdirSync(join(dir, 'shared'), { recursive: true })
})
