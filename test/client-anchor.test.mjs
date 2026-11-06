/**
 * cs-bots / 前端改造04（CONTRACT-bots04 §3）测试 —— 无 jsdom / 无 react，纯静态装载。
 *
 * 测什么（契约 §3 + 验收清单）：
 *   1. 新增文案/按钮存在（源码级）：派任务 / 发消息 / ⇢ 建任务 / 目标锚 / 补充说明 /
 *      补充历史 / 去对话 / 复制派发文案 / 「目标来自创建时原文 · 补充说明只追加不覆盖」。
 *   2. 新组件通过 `window.__ModuleLoader__` 静态装载后**首渲染不抛**，且渲染出关键文案。
 *   3. 新组件真的调用契约端点：/tasks/brief、/tasks/note、/tasks/notes、/bots/message、/tasks/assign
 *      （brief / notes 用假 fetch 桩做**运行时**断言；其余做源码级调用断言）。
 *   4. wake 结果映射：sent / skipped / failed 都要有字，失败带 reason（不许静默）。
 *   5. 幂等：房间建任务带 `sourceSeq = "room:<roomId>:<seq>"`。
 *
 * 为什么不用 jsdom+react：jsdom/react 是 dev-only 依赖，干净环境里没有；
 * 本文件必须**零依赖**可跑（与 test/client.test.mjs 的 A 层同一口径）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(__dirname, '..', 'src', 'client.js')
const SOURCE = readFileSync(CLIENT_FILE, 'utf8')

// ── 假 React：createElement / Component / 四个 hook ─────────────────────────
//
// `execEffects` 为 true 时**同步执行 useEffect**：这样 useApi 的加载副作用
// 会在首渲染时真的发起 fetch，我们就能用假 fetch 桩断言「确实调了哪个端点」。

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
          /* 首渲染测试只关心「抛不抛」，effect 内部异常不在此断言 */
        }
      }
    },
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v ?? null }),
  }
}

/**
 * 用假 `__ModuleLoader__` 真实执行 client.js（与 test/client.test.mjs 同手法）。
 * 返回 client.js 的 exports。
 */
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

/**
 * 把（假）元素树里的文本拍平，用于断言「渲染出了这句话」。
 * 除了 children 文本，也收 title/desc/value 等字符串 props —— 因为
 * `h(Section, { title, desc })` 这类组件的文案在 props 里（我们不做真实渲染）。
 */
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
    // 弹窗 footer 是 props 上的元素数组（不是 children），也要拍平
    for (const v of Object.values(props)) {
      if (Array.isArray(v)) textOf(v, out)
    }
    textOf(node.children, out)
  }
  return out
}

const allText = (tree) => textOf(tree).join(' ')

// ── 1. 文案 / 按钮存在（源码级）────────────────────────────────────────────

test('C1 Bot 页新增「派任务」「发消息」按钮与弹窗文案', () => {
  assert.match(SOURCE, /'派任务'/, 'BotTab 卡片应有「派任务」按钮')
  assert.match(SOURCE, /'发消息'/, 'BotTab 卡片应有「发消息」按钮')
  assert.match(SOURCE, /派任务给「/, '应有「派任务给 <Bot>」弹窗')
  assert.match(SOURCE, /给「[^」]*」发消息/, '应有「给 <Bot> 发消息」弹窗')
  assert.match(SOURCE, /'创建并派活'/, '派任务弹窗应有「创建并派活」')
  assert.match(SOURCE, /等价于你在这个 Bot 的会话里发一条消息/, '发消息弹窗应解释语义')
})

test('C2 TaskDrawer 新增目标锚 / 补充说明 / 补充历史 / 去对话 / 复制派发文案', () => {
  assert.match(SOURCE, /目标来自创建时原文 · 补充说明只追加不覆盖/, '目标锚顶部必须有该小字（契约原句）')
  assert.match(SOURCE, /'目标锚（只读）'/, '应有「目标锚（只读）」区块')
  assert.match(SOURCE, /'补充说明'/, '应有「补充说明」区块')
  assert.match(SOURCE, /'补充历史'/, '应有「补充历史」区块')
  assert.match(SOURCE, /'发送给执行者'/, '有 owner 时按钮文案')
  assert.match(SOURCE, /'保存补充（未派活，暂不唤醒）'/, '无 owner 时按钮文案必须切换')
  assert.match(SOURCE, /'去对话'/, '应有「去对话」')
  assert.match(SOURCE, /'复制派发文案'/, '应有「复制派发文案」')
  assert.match(SOURCE, /该负责人不是本平台的 Bot，无法跳转/, '找不到 Bot 时必须给出可读提示')
  assert.match(SOURCE, /\[\$\{fmt\(n\.at\)\}\]/, '补充历史逐条显示 [时间] 内容（by）')
})

test('C3 房间消息气泡新增「⇢ 建任务」，且 sourceSeq 幂等格式正确', () => {
  assert.match(SOURCE, /'⇢ 建任务'/, '消息气泡应有「⇢ 建任务」按钮')
  assert.match(SOURCE, /sourceSeq/, '建任务必须带 sourceSeq')
  assert.match(
    SOURCE,
    /sourceSeq\s*=\s*`room:\$\{roomId\}:\$\{seq\}`/,
    'sourceSeq 必须是 `room:<roomId>:<seq>`（契约 §3.4 幂等键）',
  )
  assert.match(SOURCE, /slice\(0,\s*80\)/, 'subject 应截首行 80 字')
  assert.match(SOURCE, /出处：房间/, 'description 应带出处')
})

test('C4 TasksTab 创建时填了负责人 → 自动 POST /tasks/assign（失败不静默）', () => {
  assert.match(SOURCE, /任务已建，但派活失败：/, '派活失败必须显示「任务已建，但派活失败：<原因>」（契约 §3.3 原句）')
  // /tasks/assign 至少被两处调用：Bot 页派任务 + 任务创建表单一步派活
  const assignCalls = [...SOURCE.matchAll(/call\(\s*['"`]\/tasks\/assign['"`]/g)]
  assert.ok(assignCalls.length >= 2, `应有 >=2 处调用 /tasks/assign，实际=${assignCalls.length}`)
})

test('C5 wake 结果映射：sent / skipped / failed 都有字，失败带 reason', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.wakeLabel, 'function', '应导出 wakeLabel 便于复用/测试')
  assert.match(exports.wakeLabel({ ok: true, result: 'sent' }), /已唤醒执行者/)
  assert.match(exports.wakeLabel({ ok: true, result: 'skipped', reason: 'dedup-hit' }), /未重复唤醒/)
  assert.match(exports.wakeLabel({ ok: false, result: 'failed', reason: 'backpressure' }), /唤醒失败/)
  assert.match(exports.wakeLabel({ ok: false, result: 'failed', reason: 'backpressure' }), /backpressure/, '失败必须带原因')
  assert.match(exports.wakeLabel({ ok: true, result: 'pending' }), /排队/)
  assert.equal(exports.wakeLabel(null), '未请求唤醒')
})

// ── 2. 契约端点调用（源码级 + brief/notes 运行时）───────────────────────────

test('C6 新功能调用了契约端点：brief / note / notes / bots/message / assign', () => {
  const patterns = {
    '/tasks/brief': /call\(\s*['"`]\/tasks\/brief\?id=/,
    '/tasks/note': /call\(\s*['"`]\/tasks\/note['"`]/,
    '/tasks/notes': /useApi\(\s*`\/tasks\/notes\?id=/,
    '/bots/message': /call\(\s*['"`]\/bots\/message['"`]/,
    '/tasks/assign': /call\(\s*['"`]\/tasks\/assign['"`]/,
  }
  for (const [label, re] of Object.entries(patterns)) {
    assert.match(SOURCE, re, `必须调用 ${label}`)
  }
})

test('C7 TaskAnchorPanel 首渲染不抛，且运行时真的请求 /tasks/brief 与 /tasks/notes', () => {
  const { exports } = loadClient({ execEffects: true })
  assert.equal(typeof exports.TaskAnchorPanel, 'function', '应导出 TaskAnchorPanel')

  const fetchCalls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url))
    return { status: 200, json: async () => ({ ok: true, anchor: {}, notes: [], bots: [], tasks: [] }) }
  }
  let tree
  try {
    tree = exports.TaskAnchorPanel({
      taskId: 't-1',
      task: { id: 't-1', rev: 1, subject: '实现登录接口', description: '标准：密码错误 401', ownerId: 's-1' },
      onChange: () => {},
    })
  } finally {
    globalThis.fetch = prevFetch
  }
  assert.ok(tree && typeof tree === 'object', '首渲染应返回元素树')
  const text = allText(tree)
  assert.match(text, /目标锚/, '应渲染出目标锚区块')
  assert.match(text, /目标来自创建时原文 · 补充说明只追加不覆盖/, '应渲染出契约原句')
  assert.match(text, /补充历史/, '应渲染出补充历史区块')
  assert.match(text, /发送给执行者/, '有 owner 时按钮为「发送给执行者」')
  const urls = fetchCalls.join('\n')
  assert.match(urls, /\/tasks\/brief\?id=t-1/, '运行时必须请求 /tasks/brief')
  assert.match(urls, /\/tasks\/notes\?id=t-1/, '运行时必须请求 /tasks/notes')
  assert.match(urls, /\/roster/, '运行时必须请求 /roster（去对话需要 ownerId → sessionId）')
})

test('C8 无 owner 时补充按钮文案切换为「保存补充（未派活，暂不唤醒）」', () => {
  const { exports } = loadClient()
  const tree = exports.TaskAnchorPanel({
    taskId: 't-2',
    task: { id: 't-2', rev: 1, subject: '无主任务', progress: 0 },
    onChange: () => {},
  })
  const text = allText(tree)
  assert.match(text, /保存补充（未派活，暂不唤醒）/)
})

// ── 3. 新组件首渲染不抛（Bots / 房间）──────────────────────────────────────

test('C9 BotAssignModal / BotMessageModal 首渲染不抛且文案正确', () => {
  const { exports } = loadClient()
  const bot = { id: 'b-1', name: '后端', sessionId: 's-1', rev: 1, cwd: '/tmp/x' }

  assert.equal(typeof exports.BotAssignModal, 'function')
  const assignTree = exports.BotAssignModal({ bot, onClose: () => {} })
  assert.ok(assignTree && typeof assignTree === 'object', 'BotAssignModal 首渲染应返回元素树')
  const assignText = allText(assignTree)
  assert.match(assignText, /派任务给「后端」/)
  assert.match(assignText, /创建并派活/)
  assert.match(assignText, /sent \/ skipped \/ failed/, '必须告知唤醒结果会显示')

  assert.equal(typeof exports.BotMessageModal, 'function')
  const msgTree = exports.BotMessageModal({ bot, onClose: () => {} })
  assert.ok(msgTree && typeof msgTree === 'object', 'BotMessageModal 首渲染应返回元素树')
  const msgText = allText(msgTree)
  assert.match(msgText, /给「后端」发消息/)
  assert.match(msgText, /等价于你在这个 Bot 的会话里发一条消息/)
})

test('C10 RoomTaskCreateModal 首渲染不抛：subject=首行截 80、description=全文+出处', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.RoomTaskCreateModal, 'function')
  const body = '第一行任务标题很长'.repeat(12) + '\n第二行细节'
  const tree = exports.RoomTaskCreateModal({
    roomId: 'r-1',
    msg: { id: 'm-1', seq: 7, body },
    onClose: () => {},
  })
  assert.ok(tree && typeof tree === 'object', 'RoomTaskCreateModal 首渲染应返回元素树')
  // 从元素树里取标题 input 的 value（首行截 80）
  let subjectVal = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props && node.props.className === 'csb-in' && node.props.value !== undefined) subjectVal = node.props.value
    walk(node.children)
  }
  walk(tree)
  assert.ok(subjectVal, '应有标题输入框')
  assert.ok(subjectVal.length <= 80, `subject 应截 80 字，实际 ${subjectVal.length}`)
  assert.match(subjectVal, /^第一行任务标题/, 'subject 应取消息正文首行')
  const text = allText(tree)
  assert.match(text, /出处：房间 r-1 · 消息 #7/, 'description 应带出处')
  assert.match(text, /幂等键/, '应说明幂等语义')
  assert.match(text, /room:r-1:7/, '应显示幂等键 room:<roomId>:<seq>')
})

// ── 4. 不回归：无相对 require ───────────────────────────────────────────────

test('C11 新增代码没有引入相对 require', () => {
  const matches = [...SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const relative = matches.filter((s) => s.startsWith('.') || s.startsWith('/'))
  assert.deepEqual(relative, [], `不得 require 相对路径，实际=${relative}`)
})
