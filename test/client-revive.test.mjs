/**
 * cs-bots / 前端改造05（CONTRACT-bots05 §3）测试 —— 无 jsdom / 无 react，纯静态装载。
 *
 * 背景：用户「创建任务指派 bots 报错」。真相是任务建成了、也指派成功了，
 * 但 dsh-web 重启后 Bot 会话没被加载进宿主 live 注册表 → 唤醒投递返回
 * `agent-not-live`，前端把原始 reason 直接显示成红色「唤醒失败（原因：agent-not-live）」，
 * 看起来就像派活失败。改造05 要做的是：**把原因翻成人话 + 给可操作按钮**。
 *
 * 测什么（契约 §3）：
 *   R1 wakeLabel 翻译 agent-not-live / resume-failed:*，其余原因保持原样
 *   R2 新增文案/按钮存在（源码级）：启动该 Bot 会话 / 重试唤醒 / 启动会话 / 全部启动 /
 *      「已自动启动该 Bot 会话」
 *   R3 WakeNotice 首渲染不抛，agent-not-live 时两个按钮都在
 *   R4 点「启动该 Bot 会话」→ 真的 POST /bots/revive（botId / sessionId 两种）
 *   R5 点「重试唤醒」→ 真的 POST /tasks/wake {id}
 *   R6 revived===true → 成功提示追加「（已自动启动该 Bot 会话）」
 *   R7 reviveResultText / reviveAllText：live/revived/reason 显式显示
 *   R8 reviveSession 请求体：{botId} / {sessionId} / {all:true}
 *   R9/R10 Bot 页首渲染有「全部启动」；点击 → POST /bots/revive {all:true}
 *   R11 没引入相对 require
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(__dirname, '..', 'src', 'client.js')
const SOURCE = readFileSync(CLIENT_FILE, 'utf8')

// ── 假 React（与 client.test.mjs / client-anchor.test.mjs 同一手法）──────────

function makeFakeReact(execEffects) {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(s) {
        this.state = { ...this.state, ...(typeof s === 'function' ? s(this.state) : s) }
      }
    },
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: (fn) => {
      if (execEffects) {
        try {
          fn()
        } catch {
          /* 首渲染只关心抛不抛 */
        }
      }
    },
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v ?? null }),
  }
}

function loadClient({ execEffects = false } = {}) {
  const fakeReact = makeFakeReact(execEffects)
  let captured = null
  const fakeRequire = (spec) => {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      throw new Error(`客户端不得 require 相对路径: ${spec}`)
    }
    if (spec === 'react') return fakeReact
    throw new Error(`未注册的包: ${spec}`)
  }
  const fakeWindow = { __ModuleLoader__: { load({ factory }) { captured = factory(fakeRequire) } } }
  const prevWindow = globalThis.window
  globalThis.window = fakeWindow
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', SOURCE)(fakeWindow)
  } finally {
    globalThis.window = prevWindow
  }
  if (!captured) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  return { exports: captured }
}

const TEXT_PROPS = ['title', 'desc', 'text', 'label', 'placeholder', 'hint', 'message', 'value']
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out)
    return out
  }
  if (typeof node === 'object') {
    const props = node.props ?? {}
    for (const k of TEXT_PROPS) {
      if (typeof props[k] === 'string' && props[k]) out.push(props[k])
    }
    for (const v of Object.values(props)) {
      if (Array.isArray(v)) textOf(v, out)
    }
    textOf(node.children, out)
  }
  return out
}
const allText = (tree) => textOf(tree).join(' ')

/** 在（假）元素树里找按钮：文案包含 label。 */
function findButtons(node, label, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) findButtons(n, label, out)
    return out
  }
  if (node.type === 'button' && allText(node).includes(label)) out.push(node)
  findButtons(node.children, label, out)
  for (const v of Object.values(node.props ?? {})) {
    if (Array.isArray(v)) findButtons(v, label, out)
  }
  return out
}

/** 假 fetch：记录 URL + 解析后的 body，返回 responder 造出来的 JSON。 */
async function runWithFetch(responder, fn) {
  const calls = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    let body = null
    if (options?.body) {
      try {
        body = JSON.parse(options.body)
      } catch {
        body = options.body
      }
    }
    const u = String(url)
    calls.push({ url: u, body })
    return { status: 200, json: async () => responder(u, body) }
  }
  let result
  try {
    result = await fn()
  } finally {
    globalThis.fetch = prev
  }
  return { calls, result }
}

// ── R1 文案翻译 ────────────────────────────────────────────────────────────

test('R1 wakeLabel / wakeReasonText：agent-not-live 与 resume-failed 翻成人话，其余不动', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.wakeLabel, 'function')
  assert.equal(typeof exports.wakeReasonText, 'function')

  // agent-not-live → 「该 Bot 会话当时没在运行」
  const notLive = exports.wakeLabel({ ok: false, result: 'failed', reason: 'agent-not-live' })
  assert.match(notLive, /唤醒失败/)
  assert.match(notLive, /该 Bot 会话当时没在运行/)
  assert.doesNotMatch(notLive, /agent-not-live/, '原始 reason 不应再直接砸给用户')

  // 带后缀的 agent-not-live:* 也要翻译
  assert.match(
    exports.wakeLabel({ ok: false, result: 'failed', reason: 'agent-not-live:session' }),
    /该 Bot 会话当时没在运行/,
  )

  // resume-failed:* → 「该 Bot 会话启动失败」
  assert.match(
    exports.wakeLabel({ ok: false, result: 'failed', reason: 'resume-failed:session not found' }),
    /该 Bot 会话启动失败/,
  )

  // 其余原因保持后端原文（不猜测、不隐藏）
  assert.match(
    exports.wakeLabel({ ok: true, result: 'skipped', reason: 'dedup-hit' }),
    /dedup-hit/,
    '未映射的原因必须保持原样',
  )

  // 源码级确认两个映射文案都在
  assert.match(SOURCE, /该 Bot 会话当时没在运行/)
  assert.match(SOURCE, /该 Bot 会话启动失败/)
})

// ── R2 文案 / 按钮存在（源码级）────────────────────────────────────────────

test('R2 新增按钮与提示文案齐全，且调用了 /bots/revive 与 /tasks/wake', () => {
  assert.match(SOURCE, /'启动该 Bot 会话'/, '唤醒失败条应有「启动该 Bot 会话」')
  assert.match(SOURCE, /'重试唤醒'/, '唤醒失败条应有「重试唤醒」')
  assert.match(SOURCE, /'启动会话'/, 'Bot 卡片应有「启动会话」')
  assert.match(SOURCE, /'全部启动'/, 'Bot 页头应有「全部启动」')
  assert.match(SOURCE, /已自动启动该 Bot 会话/, 'revived:true 时成功提示要说明')
  assert.match(SOURCE, /call\(\s*['"`]\/bots\/revive['"`]/, '必须调用 POST /bots/revive')
  assert.match(SOURCE, /call\(\s*['"`]\/tasks\/wake['"`]/, '必须调用 POST /tasks/wake')
  assert.match(SOURCE, /all:\s*true/, '全部启动必须带 {all:true}')
})

// ── R3 WakeNotice 首渲染 ───────────────────────────────────────────────────

test('R3 agent-not-live 唤醒失败：WakeNotice 首渲染不抛，两个按钮都在', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.WakeNotice, 'function')
  const tree = exports.WakeNotice({
    wake: { ok: false, result: 'failed', reason: 'agent-not-live' },
    botId: 'b-1',
    sessionId: 's-1',
    taskId: 't-1',
  })
  assert.ok(tree && typeof tree === 'object', '首渲染应返回元素树')
  const text = allText(tree)
  assert.match(text, /唤醒失败/)
  assert.match(text, /该 Bot 会话当时没在运行/)
  assert.match(text, /启动该 Bot 会话/)
  assert.match(text, /重试唤醒/)
  assert.equal(findButtons(tree, '启动该 Bot 会话').length, 1)
  assert.equal(findButtons(tree, '重试唤醒').length, 1)
})

test('R3b 非 agent-not-live 失败不显示操作按钮；成功且 revived 时提示已自动启动', () => {
  const { exports } = loadClient()

  const other = exports.WakeNotice({ wake: { ok: false, result: 'failed', reason: 'backpressure' }, taskId: 't-1' })
  assert.equal(findButtons(other, '启动该 Bot 会话').length, 0, '其他失败原因不该出现启动按钮')
  assert.match(allText(other), /backpressure/)

  const revived = exports.WakeNotice({ wake: { ok: true, result: 'sent' }, revived: true })
  assert.match(allText(revived), /已自动启动该 Bot 会话/)
  assert.equal(findButtons(revived, '重试唤醒').length, 0, '成功时不需要重试按钮')

  const plainSent = exports.WakeNotice({ wake: { ok: true, result: 'sent' }, revived: false })
  assert.doesNotMatch(allText(plainSent), /已自动启动该 Bot 会话/, 'revived=false 时不能多话')
})

// ── R4 / R5 失败后的两个可操作按钮 ─────────────────────────────────────────

test('R4 点「启动该 Bot 会话」→ POST /bots/revive（优先 botId，其次 sessionId）', async () => {
  const { exports } = loadClient()

  const byBot = await runWithFetch(
    () => ({ ok: true, live: true, revived: true, sessionId: 's-1' }),
    async () => {
      const tree = exports.WakeNotice({
        wake: { ok: false, result: 'failed', reason: 'agent-not-live' },
        botId: 'b-1',
        sessionId: 's-1',
        taskId: 't-1',
      })
      const btn = findButtons(tree, '启动该 Bot 会话')[0]
      assert.ok(btn?.props?.onClick, '按钮必须有 onClick')
      await btn.props.onClick()
    },
  )
  const reviveCall = byBot.calls.find((c) => c.url.includes('/bots/revive'))
  assert.ok(reviveCall, '应调用 /bots/revive')
  assert.deepEqual(reviveCall.body, { botId: 'b-1' }, '有 botId 时优先用 botId')

  const bySession = await runWithFetch(
    () => ({ ok: true, live: true, revived: false }),
    async () => {
      const tree = exports.WakeNotice({
        wake: { ok: false, result: 'failed', reason: 'agent-not-live' },
        sessionId: 's-9',
        taskId: 't-1',
      })
      await findButtons(tree, '启动该 Bot 会话')[0].props.onClick()
    },
  )
  const call2 = bySession.calls.find((c) => c.url.includes('/bots/revive'))
  assert.deepEqual(call2?.body, { sessionId: 's-9' }, '没有 botId 时用 sessionId')
})

test('R5 点「重试唤醒」→ POST /tasks/wake {id}', async () => {
  const { exports } = loadClient()
  const { calls } = await runWithFetch(
    () => ({ ok: true, wake: { ok: true, result: 'sent' }, revived: false }),
    async () => {
      const tree = exports.WakeNotice({
        wake: { ok: false, result: 'failed', reason: 'agent-not-live' },
        botId: 'b-1',
        taskId: 't-26',
      })
      await findButtons(tree, '重试唤醒')[0].props.onClick()
    },
  )
  const wakeCall = calls.find((c) => c.url.includes('/tasks/wake'))
  assert.ok(wakeCall, '应调用 /tasks/wake')
  assert.deepEqual(wakeCall.body, { id: 't-26' })
})

// ── R6 / R7 结果文案 ───────────────────────────────────────────────────────

test('R7 reviveResultText / reviveAllText：live / revived / reason 显式显示', () => {
  const { exports } = loadClient()
  assert.equal(exports.reviveResultText({ ok: true, live: true, revived: true }), '该 Bot 会话已启动')
  assert.equal(exports.reviveResultText({ ok: true, live: true, revived: false }), '该 Bot 会话已在线')
  assert.match(
    exports.reviveResultText({ ok: true, live: false, revived: false, reason: 'resume-failed:no such session' }),
    /启动失败.*resume-failed:no such session/,
    '启动失败必须带后端 reason',
  )

  const allText2 = exports.reviveAllText({
    ok: true,
    total: 6,
    revived: ['s-1', 's-2'],
    live: ['s-1', 's-2', 's-3'],
    failed: [{ sessionId: 's-9', reason: 'resume-failed:boom' }],
  })
  assert.match(allText2, /复活 2 个/)
  assert.match(allText2, /已在线 3 个/)
  assert.match(allText2, /失败 1 个/)
  assert.match(allText2, /s-9: resume-failed:boom/, '失败必须带原因清单')
})

// ── R8 reviveSession 请求体 ────────────────────────────────────────────────

test('R8 reviveSession：{botId} / {sessionId} / {all:true} 三种形态', async () => {
  const { exports } = loadClient()
  const { calls } = await runWithFetch(
    () => ({ ok: true, live: true, revived: true, total: 0, revivedList: [], liveList: [], failed: [] }),
    async () => {
      await exports.reviveSession({ botId: 'b-1' })
      await exports.reviveSession({ sessionId: 's-1' })
      await exports.reviveSession({ all: true })
    },
  )
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].body, { botId: 'b-1' })
  assert.deepEqual(calls[1].body, { sessionId: 's-1' })
  assert.deepEqual(calls[2].body, { all: true })
  for (const c of calls) assert.match(c.url, /\/bots\/revive$/)

  const { exports: ex2 } = loadClient()
  await assert.rejects(() => ex2.reviveSession({}), /缺少 Bot 标识/, '没有目标时必须明确报错，不能静默')
})

// ── R9 / R10 Bot 页 ────────────────────────────────────────────────────────

test('R9 Bot 页首渲染不抛，页头有「全部启动」按钮', () => {
  const { exports } = loadClient()
  const tree = exports.BotsTab({ onGoto: () => {} })
  assert.ok(tree && typeof tree === 'object')
  const text = allText(tree)
  assert.match(text, /全部启动/)
  assert.match(text, /重启 dsh-web 后点这里/, '按钮旁要有用途说明')
})

test('R10 点 Bot 页「全部启动」→ POST /bots/revive {all:true}，并显示三清单', async () => {
  const { exports } = loadClient({ execEffects: true })
  const { calls } = await runWithFetch(
    () => ({
      ok: true,
      total: 3,
      revived: ['s-1'],
      live: ['s-1', 's-2'],
      failed: [{ sessionId: 's-3', reason: 'resume-failed:boom' }],
    }),
    async () => {
      const tree = exports.BotsTab({ onGoto: () => {} })
      const btn = findButtons(tree, '全部启动')[0]
      assert.ok(btn?.props?.onClick, '「全部启动」必须有 onClick')
      await btn.props.onClick()
    },
  )
  const call = calls.find((c) => c.url.includes('/bots/revive'))
  assert.ok(call, '应调用 /bots/revive')
  assert.deepEqual(call.body, { all: true })
})

test('R11 新增代码没有引入相对 require', () => {
  const matches = [...SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const relative = matches.filter((s) => s.startsWith('.') || s.startsWith('/'))
  assert.deepEqual(relative, [], `不得 require 相对路径，实际=${relative}`)
})
