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

// ══════════════════════════════════════════════════════════════════════════════
// §2.5 / §3.2 第 6 条：来源跳转（任务 → 回消息出处）前端测试
//
// 测什么（契约 §4.1 第 8、9 条）：
//   · `kind:'none'` 不渲染来源区块；`kind:'room'` 渲染可跳转按钮；
//     `unparsed` 只显示只读来源 + reason；
//   · 房间已删 → 按钮禁用 + 「来源房间已删除」；消息已清理 → 提示「消息 #N 已不在（可能被清理）」；
//   · 点击按钮真的调用 `onGoto('rooms', { roomId, seq })`；
//   · 既有 `onGoto('tasks')` 单参数调用行为**逐字不变**（回归）；
//   · RoomsTab 收到定位参数后给目标消息行加高亮 class 并 scrollIntoView。
//
// 手法：与 C7 相同（假 fetch 桩 + 静态装载），但 hooks 是**有状态**的 ——
// 否则 `useState` 的 setter 全是 no-op，点击按钮后界面不会变，测不到任何东西。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 有状态的假 React（同一文件里 C 层用的是 no-op 版本，这里要真的能重渲染）。
 *
 * 必须像真 React 一样（否则测试会假通过或死循环）：
 *   1. hooks 按调用顺序对齐（`useState`/`useEffect`/`useCallback` 同序出现）；
 *   2. `useState` 的 setter 做浅比较后 bailout —— 值没变就不重渲染，
 *      否则 `setShownCount((n) => Math.max(n, x))` 这种「不变」的更新会无限重渲染；
 *   3. `useEffect(fn, deps)` 做 deps 比较 —— 依赖没变就不重跑（否则每次渲染都
 *      重新发起 fetch，测试会变成「每次都新请求」的噪音源）；
 *   4. `useCallback` 按位置记忆 —— 返回稳定引用（否则 `reload` 每次都是新函数，
 *      `useEffect([reload, ...deps])` 会每次都重跑，形成 fetch 风暴）；
 *   5. `ref` 真的挂到节点上，并给节点补一个 `scrollIntoView` 桩 ——
 *      这样 RoomsTab 的「滚到目标消息」可以断言调用次数与参数（不只是源码里有这个词）。
 */
function makeStatefulReact(records) {
  const slots = []         // useState 的值槽（跨渲染保留）
  const callbacks = []     // useCallback 的记忆槽（跨渲染保留 → 引用稳定）
  const effectFns = []     // 本轮渲染登记的 effect
  const effectDeps = []    // 本轮渲染登记的 deps
  const ranDeps = []       // 上次真正执行时的 deps（用于比较）
  let hookIndex = -1
  let currentComp = null
  let currentProps = null
  let rendering = false
  let queued = false

  const runEffects = () => {
    if (rendering) { queued = true; return }
    rendering = true
    try {
      for (let i = 0; i < effectFns.length; i += 1) {
        const fn = effectFns[i]
        if (typeof fn !== 'function') continue
        const deps = effectDeps[i] ?? null
        const prev = ranDeps[i]
        const same = prev !== undefined && deps !== null
          && prev.length === deps.length
          && prev.every((v, j) => Object.is(v, deps[j]))
        if (same) continue
        try { fn() } catch (e) { records.errors.push(e) }
        ranDeps[i] = deps
      }
      effectFns.length = 0
      effectDeps.length = 0
    } finally {
      rendering = false
      if (queued) { queued = false; doRender() }
    }
  }

  const doRender = () => {
    if (!currentComp) return
    hookIndex = -1
    effectFns.length = 0
    effectDeps.length = 0
    let tree
    try {
      tree = currentComp(currentProps)
    } catch (e) {
      records.errors.push(e)
      return
    }
    records.renders.push(tree)
    runEffects()
  }

  const createElement = (type, props, ...children) => {
    const node = { type, props: props ?? {}, children }
    const ref = props?.ref
    if (ref && typeof ref === 'object') {
      node.scrollIntoView = (opts) => { records.scrolls.push({ id: node.props?.key ?? null, ...(opts ?? {}) }) }
      ref.current = node
    }
    return node
  }

  const fakeReact = {
    createElement,
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState(updater) {
        const next = typeof updater === 'function' ? updater(this.state) : updater
        if (Object.keys(next ?? {}).every((k) => this.state[k] === next[k])) return
        this.state = { ...this.state, ...next }
        doRender()
      }
    },
    useState: (initial) => {
      const i = hookIndex + 1
      hookIndex = i
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (u) => {
        // 与真 React 同语义：函数式更新拿上一个值，否则**整体替换**
        // （浅合并是错的：`setErr('x')` 会把字符串按索引合并进去）
        const next = typeof u === 'function' ? u(slot.value) : u
        if (Object.is(slot.value, next)) return
        slot.value = next
        doRender()
      }]
    },
    useEffect: (fn, deps) => {
      const i = hookIndex + 1
      hookIndex = i
      effectFns[i] = fn
      effectDeps[i] = deps ?? null
    },
    useCallback: (fn) => {
      const i = hookIndex + 1
      hookIndex = i
      if (!callbacks[i]) callbacks[i] = fn
      return callbacks[i]
    },
    useRef: (v) => ({ current: v ?? null }),
  }

  fakeReact.__setComponent = (comp, props) => { currentComp = comp; currentProps = props }
  fakeReact.__doRender = doRender
  return fakeReact
}

/**
 * 有状态装载 client.js。
 * @returns {{ exports, render(props): tree, flush(): Promise<void>, restore(): void, records, setResponder }}
 */
function loadClientStateful() {
  const records = { errors: [], scrolls: [], fetches: [], renders: [], responder: () => ({ ok: true }) }
  const fakeReact = makeStatefulReact(records)
  let captured = null
  const fakeRequire = (spec) => {
    if (spec.startsWith('.') || spec.startsWith('/')) throw new Error(`客户端不得 require 相对路径: ${spec}`)
    if (spec === 'react') return fakeReact
    throw new Error(`未注册的包: ${spec}`)
  }
  const fakeWindow = { __ModuleLoader__: { load({ factory }) { captured = factory(fakeRequire) } } }
  const prevWindow = globalThis.window
  const prevFetch = globalThis.fetch
  globalThis.window = fakeWindow
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', SOURCE)(fakeWindow)
  } finally {
    globalThis.window = prevWindow
  }
  if (!captured) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')

  // 假 fetch：同一 URL 复用同一个响应对象（避免「每次都是新对象」触发无意义重渲染）
  const seen = new Map()
  globalThis.fetch = async (url) => {
    const key = String(url)
    records.fetches.push(key)
    if (!seen.has(key)) {
      seen.set(key, { status: 200, json: async () => records.responder(key) })
    }
    return seen.get(key)
  }

  const render = (props) => {
    fakeReact.__setComponent(props.Comp, props.props)
    fakeReact.__doRender()
    return records.renders.at(-1)
  }
  // 等所有「setState → 重渲染 → effect → 再 setState」的链跑完
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve()
      fakeReact.__doRender()
    }
  }
  return {
    exports: captured,
    records,
    render,
    flush,
    restore: () => { globalThis.fetch = prevFetch },
    setResponder: (fn) => { records.responder = fn },
  }
}

/** 找一个元素树里所有匹配文本的按钮节点。 */
function findButtonsByText(node, label, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findButtonsByText(n, label, out); return out }
  if (node.type === 'button' && allText(node).includes(label)) out.push(node)
  findButtonsByText(node.children, label, out)
  for (const v of Object.values(node.props ?? {})) {
    if (Array.isArray(v)) findButtonsByText(v, label, out)
  }
  return out
}

/** 找 className 含某个片段的元素节点。 */
function findByClass(node, part, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findByClass(n, part, out); return out }
  if (typeof node.props?.className === 'string' && node.props.className.includes(part)) out.push(node)
  findByClass(node.children, part, out)
  for (const v of Object.values(node.props ?? {})) {
    if (Array.isArray(v)) findByClass(v, part, out)
  }
  return out
}

/** 默认应答器：任何端点都返回 ok:true + 空数据（测试按需覆盖）。 */
const EMPTY_RESPONSE = () => ({ ok: true })

// ── S1 来源区块真的请求 GET /tasks/source ─────────────────────────────────────

test('S1 来源跳转：TaskAnchorPanel 挂载即请求 GET /tasks/source?id=', async () => {
  const h = loadClientStateful()
  h.setResponder((url) => {
    if (url.includes('/tasks/source')) {
      return {
        ok: true, taskId: 't-5', source: 'ai', sourceSeq: 'room:room-a1b2c3d4:7', kind: 'room',
        reason: null,
        room: {
          roomId: 'room-a1b2c3d4', name: '研发协调', seq: 7, messageId: 'm-7',
          exists: true, messageExists: true, at: 1762300100000, preview: '把登录接口拆成三个子任务',
        },
        jump: { roomId: 'room-a1b2c3d4', seq: 7 },
        hint: '来源：房间消息 room-a1b2c3d4 #7',
      }
    }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({
      Comp: h.exports.TaskAnchorPanel,
      props: { taskId: 't-5', task: { id: 't-5', rev: 1, subject: '拆登录接口' }, onChange: () => {} },
    })
    await h.flush()
    assert.match(
      h.records.fetches.join('\n'),
      /\/tasks\/source\?id=t-5/,
      '来源区块必须请求 /tasks/source（契约 §2.5 的落地入口）',
    )
  } finally {
    h.restore()
  }
})

// ── S2 kind === 'none' → 不渲染任何来源区块 ───────────────────────────────────

test('S2 来源跳转：kind:"none" 不渲染来源区块（人建的任务不占位）', async () => {
  const h = loadClientStateful()
  h.setResponder((url) => {
    if (url.includes('/tasks/source')) return { ok: true, taskId: 't-1', kind: 'none', sourceSeq: null, room: null, jump: null, reason: null }
    return EMPTY_RESPONSE()
  })
  try {
    const tree = h.render({
      Comp: h.exports.TaskAnchorPanel,
      props: { taskId: 't-1', task: { id: 't-1', rev: 1, subject: '人建的任务' }, onChange: () => {} },
    })
    await h.flush()
    const text = allText(h.records.renders.at(-1))
    assert.ok(!text.includes('回到消息出处'), 'kind:none 绝不能渲染跳转按钮')
    assert.ok(!text.includes('来源：'), 'kind:none 不渲染来源区块（契约 §3.2 第 6 条）')
    assert.equal(findButtonsByText(h.records.renders.at(-1), '回到消息出处').length, 0)
  } finally {
    h.restore()
  }
})

// ── S3 kind === 'room' 且消息存在 → 可跳转按钮 + 真的调 onGoto ───────────────

test('S3 来源跳转：kind:"room" 渲染「回到消息出处（房间名 #7）」，点击调 onGoto("rooms",{roomId,seq})', async () => {
  const h = loadClientStateful()
  const gotos = []
  h.setResponder((url) => {
    if (url.includes('/tasks/source')) {
      return {
        ok: true, taskId: 't-5', source: 'ai', sourceSeq: 'room:room-a1b2c3d4:7', kind: 'room', reason: null,
        room: {
          roomId: 'room-a1b2c3d4', name: '研发协调', seq: 7, messageId: 'm-7',
          exists: true, messageExists: true, at: 1762300100000, preview: '把登录接口拆成三个子任务',
        },
        jump: { roomId: 'room-a1b2c3d4', seq: 7 }, hint: '来源：房间消息 room-a1b2c3d4 #7',
      }
    }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({
      Comp: h.exports.TaskAnchorPanel,
      props: {
        taskId: 't-5',
        task: { id: 't-5', rev: 1, subject: '拆登录接口' },
        onChange: () => {},
        onGotoSource: (...args) => gotos.push(args),
      },
    })
    await h.flush()
    const tree = h.records.renders.at(-1)
    const text = allText(tree)
    assert.match(text, /回到消息出处（研发协调 #7）/, '按钮文案必须是「回到消息出处（房间名 #N）」')
    assert.match(text, /把登录接口拆成三个子任务/, '应显示来源消息预览')
    assert.ok(!text.includes('已不在'), '消息存在时不得显示「已不在」')
    assert.ok(!text.includes('来源房间已删除'), '房间存在时不得显示「已删除」')

    const btn = findButtonsByText(tree, '回到消息出处')[0]
    assert.ok(btn, '必须有「回到消息出处」按钮')
    assert.notEqual(btn.props.disabled, true, '可跳时按钮不得禁用')
    assert.equal(typeof btn.props.onClick, 'function')
    await btn.props.onClick()
    assert.deepEqual(gotos, [['rooms', { roomId: 'room-a1b2c3d4', seq: 7 }]], '必须调 onGoto("rooms", {roomId, seq})')
  } finally {
    h.restore()
  }
})

// ── S4 消息已不在 → 仍可切房间，但提示「消息 #7 已不在（可能被清理）」 ────────

test('S4 来源跳转：messageExists:false → 提示「消息 #7 已不在（可能被清理）」，不假装跳成功', async () => {
  const h = loadClientStateful()
  const gotos = []
  h.setResponder((url) => {
    if (url.includes('/tasks/source')) {
      return {
        ok: true, taskId: 't-6', sourceSeq: 'room:room-a1b2c3d4:7', kind: 'room', reason: null,
        room: {
          roomId: 'room-a1b2c3d4', name: '研发协调', seq: 7, messageId: 'm-7',
          exists: true, messageExists: false, at: null, preview: null,
        },
        jump: { roomId: 'room-a1b2c3d4', seq: 7 }, hint: '来源：房间消息 room-a1b2c3d4 #7',
      }
    }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({
      Comp: h.exports.TaskAnchorPanel,
      props: {
        taskId: 't-6', task: { id: 't-6', rev: 1, subject: '清理过的消息' },
        onChange: () => {},
        onGotoSource: (...args) => gotos.push(args),
      },
    })
    await h.flush()
    const tree = h.records.renders.at(-1)
    assert.match(allText(tree), /消息 #7 已不在（可能被清理）/, '就地提示必须写清「消息已不在」')

    const btn = findButtonsByText(tree, '回到消息出处')[0]
    assert.ok(btn, '消息不在但房间还在 → 仍可切房间')
    assert.notEqual(btn.props.disabled, true, '消息不在时按钮仍可用（能切到房间）')
    await btn.props.onClick()
    assert.deepEqual(gotos, [['rooms', { roomId: 'room-a1b2c3d4', seq: 7 }]], '仍要切到房间页签')
  } finally {
    h.restore()
  }
})

// ── S5 房间已删 → 按钮禁用 + 「来源房间已删除」，点击不跳 ────────────────────

test('S5 来源跳转：room.exists:false → 按钮禁用 + 「来源房间已删除」，点击不调 onGoto', async () => {
  const h = loadClientStateful()
  const gotos = []
  h.setResponder((url) => {
    if (url.includes('/tasks/source')) {
      return {
        ok: true, taskId: 't-7', sourceSeq: 'room:room-gone12:3', kind: 'room', reason: null,
        room: {
          roomId: 'room-gone12', name: null, seq: 3, messageId: 'm-3',
          exists: false, messageExists: null, at: null, preview: null,
        },
        jump: { roomId: 'room-gone12', seq: 3 }, hint: '来源：房间消息 room-gone12 #3',
      }
    }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({
      Comp: h.exports.TaskAnchorPanel,
      props: {
        taskId: 't-7', task: { id: 't-7', rev: 1, subject: '房间没了' },
        onChange: () => {},
        onGotoSource: (...args) => gotos.push(args),
      },
    })
    await h.flush()
    const tree = h.records.renders.at(-1)
    const text = allText(tree)
    assert.match(text, /来源房间已删除/, '必须提示「来源房间已删除」')
    const btn = findButtonsByText(tree, '回到消息出处')[0]
    assert.ok(btn, '契约：房间已删 → 按钮禁用（不是不渲染）')
    assert.equal(btn.props.disabled, true, '房间已删时按钮必须禁用')
    await btn.props.onClick()
    assert.deepEqual(gotos, [], '房间已删时点击不得假装跳转')
  } finally {
    h.restore()
  }
})

// ── S6 unparsed → 只读一行 + reason，绝不渲染跳不动的按钮 ────────────────────

test('S6 来源跳转：kind:"unparsed" 只显示只读来源 + 后端 reason（无按钮）', async () => {
  const h = loadClientStateful()
  const reason = '无法解析来源标记 "weird-marker-9"（不是 room:/todo:/evolve: 前缀）'
  h.setResponder((url) => {
    if (url.includes('/tasks/source')) {
      return { ok: true, taskId: 't-8', sourceSeq: 'weird-marker-9', kind: 'unparsed', reason, room: null, jump: null }
    }
    return EMPTY_RESPONSE()
  })
  try {
    const tree = h.render({
      Comp: h.exports.TaskAnchorPanel,
      props: { taskId: 't-8', task: { id: 't-8', rev: 1, subject: '来源坏了' }, onChange: () => {} },
    })
    await h.flush()
    const shown = h.records.renders.at(-1)
    const text = allText(shown)
    assert.match(text, /来源：weird-marker-9/, '必须显示只读一行「来源：<sourceSeq>」')
    assert.match(text, /无法解析来源标记/, '必须显示后端 reason（契约 §3.2 第 6 条）')
    assert.equal(findButtonsByText(shown, '回到消息出处').length, 0, 'unparsed 绝不渲染跳转按钮')
    assert.ok(!text.includes('回到消息出处'))
  } finally {
    h.restore()
  }
})

// ── S7 todo / evolve → 只读一行，无按钮 ───────────────────────────────────────

test('S7 来源跳转：kind:"todo"/"evolve" 只显示只读一行（无按钮）', async () => {
  // 每种 kind 用一份**全新装载**的客户端：hooks 是有状态的，
  // 同一个组件实例换 taskId 重渲染会串味（useApi 的槽位不会跟着换任务）。
  const cases = [
    ['todo', 'todo:t-12', 't-9'],
    ['evolve', 'evolve:t-9:abc123def456', 't-10'],
  ]
  for (const [kind, marker, id] of cases) {
    const h = loadClientStateful()
    h.setResponder((url) => {
      if (url.includes('/tasks/source')) {
        return { ok: true, taskId: id, sourceSeq: marker, kind, room: null, jump: null, reason: null }
      }
      return EMPTY_RESPONSE()
    })
    try {
      h.render({
        Comp: h.exports.TaskAnchorPanel,
        props: { taskId: id, task: { id, rev: 1, subject: '来自待办' }, onChange: () => {} },
      })
      await h.flush()
      const shown = h.records.renders.at(-1)
      const text = allText(shown)
      assert.match(text, new RegExp(`来源：${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${marker} 应显示只读一行`)
      assert.equal(findButtonsByText(shown, '回到消息出处').length, 0, `${marker} 绝不渲染跳转按钮`)
    } finally {
      h.restore()
    }
  }
})

// ── S8 既有 onGoto('tasks') 单参数调用行为逐字不变（回归） ────────────────────

test('S8 回归：既有 onGoto("tasks") 单参数调用逐字不变（ArtifactsTab/页签按钮）', () => {
  // 页签按钮：仍是单参数 `goTab(t.id)`
  assert.match(SOURCE, /onClick:\s*\(\) => goTab\(t\.id\)/, '页签按钮仍是 goTab(t.id) 单参数')
  // 成果页空态：仍是单参数 `onGoto('tasks')`
  assert.match(SOURCE, /onClick:\s*\(\) => onGoto\('tasks'\)/, 'ArtifactsTab 仍是 onGoto(\'tasks\') 单参数')
  // goTab 的第二参数必须是可选的（单参数时不产生任何定位副作用）
  assert.match(SOURCE, /const goTab = \(id, opts\) => \{/, 'goTab 必须支持可选第二参数 opts')
  assert.match(SOURCE, /setLocate\(opts && typeof opts === 'object' && opts\.roomId \? opts : null\)/,
    '单参数调用时 locate 必须落回 null（行为逐字不变）')
  assert.match(SOURCE, /id:\s*'tasks',\s*label:\s*'任务'/, '任务页签定义未被改动')
})

test('S8b 回归：单参数 onGoto 时 RoomsTab 不产生任何定位副作用（不发 /rooms/messages 定位请求）', async () => {
  const h = loadClientStateful()
  const calls = []
  h.setResponder((url) => { calls.push(url); return EMPTY_RESPONSE() })
  try {
    h.render({ Comp: h.exports.RoomsTab, props: {} })
    await h.flush()
    const text = allText(h.records.renders.at(-1))
    assert.ok(!text.includes('回到消息出处'))
    // 没有任何定位：不渲染高亮行，也没有「滚到目标」的滚动
    assert.equal(findByClass(h.records.renders.at(-1), 'csb-msg-focus').length, 0, '无定位参数时不得高亮任何消息行')
    assert.equal(h.records.scrolls.filter((s) => s.block === 'center').length, 0, '无定位参数时不得滚到中心')
  } finally {
    h.restore()
  }
})

// ── S9 Workbench：goTab 双参数 + locate 传给 RoomsTab ────────────────────────

test('S9 Workbench：onGoto("rooms", {roomId,seq}) 会把定位参数传给 RoomsTab', () => {
  assert.match(
    SOURCE,
    /locate:\s*current\.id === 'rooms' \? locate : undefined/,
    '只有房间页签接收 locate 定位参数',
  )
  assert.match(SOURCE, /goTab,\s*$/m, '页签组件仍拿到 onGoto=goTab')
  assert.match(SOURCE, /const \[locate, setLocate\] = useState\(null\)/, 'Workbench 持有 locate 状态')
})

test('S9b TasksTab 把 onGoto 透传给 TaskDrawer（来源跳转的跨页签路径）', () => {
  assert.match(SOURCE, /function TasksTab\(\{ onGoto \}\)/, 'TasksTab 必须接 onGoto')
  assert.match(
    SOURCE,
    /openId \? h\(TaskDrawer, \{\s*id: openId, bots, workflows,\s*onClose: \(\) => setOpenId\(null\),\s*onChange: reload,\s*onGotoSource: onGoto,/,
    'TasksTab 必须把 onGoto 作为 onGotoSource 传给 TaskDrawer',
  )
})

// ── S10 RoomsTab 收到定位参数 → 高亮目标消息行 + scrollIntoView ───────────────

test('S10 RoomsTab：收到 locate → 选中房间、目标消息行高亮并滚到可见', async () => {
  const h = loadClientStateful()
  const callLog = []
  const msgs = [
    { id: 'm-1', seq: 1, from: 'user', text: '第一条' },
    { id: 'm-2', seq: 2, from: 'user', text: '第二条' },
    { id: 'm-3', seq: 3, from: 'user', text: '第三条：来源应该是它' },
  ]
  h.setResponder((url) => {
    callLog.push(url)
    if (url.includes('/rooms/messages')) return { ok: true, messages: msgs }
    if (url.includes('/rooms')) {
      return { ok: true, rooms: [{ id: 'room-a1b2c3d4', name: '研发协调', members: ['user'], mode: 'everyone', seq: 3 }] }
    }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({
      Comp: h.exports.RoomsTab,
      props: { locate: { roomId: 'room-a1b2c3d4', seq: 3 } },
    })
    await h.flush()
    const tree = h.records.renders.at(-1)

    // 1) 选中了目标房间
    const focused = findByClass(tree, 'csb-msg-focus')
    assert.equal(focused.length, 1, '目标消息行必须带高亮 class')
    assert.match(focused[0].props.className, /csb-msg-focus/)
    assert.match(allText(focused[0]), /第三条：来源应该是它/, '高亮的正是 seq=3 那条')

    // 2) 加载了目标房间的消息（定位的前提是消息真的被取回来）
    assert.ok(
      callLog.some((u) => u.includes('/rooms/messages') && u.includes('room-a1b2c3d4')),
      `必须加载目标房间的消息，实际请求：${callLog.join(' | ')}`,
    )

    // 3) 滚到了目标消息（不是滚到底）
    assert.ok(
      h.records.scrolls.some((s) => s.block === 'center'),
      '定位时必须 scrollIntoView({block:"center"})，实际：' + JSON.stringify(h.records.scrolls),
    )
  } finally {
    h.restore()
  }
})

test('S10b RoomsTab：定位目标不在消息列表里（已被清理）→ 不崩、不高亮、滚到底', async () => {
  const h = loadClientStateful()
  const msgs = [{ id: 'm-1', seq: 1, from: 'user', text: '第一条' }]
  h.setResponder((url) => {
    if (url.includes('/rooms/messages')) return { ok: true, messages: msgs }
    if (url.includes('/rooms')) {
      return { ok: true, rooms: [{ id: 'room-a1b2c3d4', name: '研发协调', members: ['user'], mode: 'everyone', seq: 1 }] }
    }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({ Comp: h.exports.RoomsTab, props: { locate: { roomId: 'room-a1b2c3d4', seq: 99 } } })
    await h.flush()
    const tree = h.records.renders.at(-1)
    assert.equal(findByClass(tree, 'csb-msg-focus').length, 0, '消息不在了就不该高亮任何一行')
    assert.ok(
      h.records.scrolls.some((s) => s.block === 'end'),
      '消息已不在时应滚到底（让人看到最新状态）',
    )
    assert.equal(h.records.errors.length, 0, '定位到不存在的消息不得抛错：' + JSON.stringify(h.records.errors))
  } finally {
    h.restore()
  }
})

// ── N1 任务结论区（需求4）：TaskAnchorPanel 渲染 /tasks/summary 摘要 ─────────

test('N1 任务结论区：挂载即请求 GET /tasks/summary?id=，并渲染进度/结论/下一步', async () => {
  const h = loadClientStateful()
  h.setResponder((url) => {
    if (url.includes('/tasks/summary')) {
      return {
        ok: true, taskId: 't-7',
        currentProgress: { status: 'in_progress', progress: 40, progressText: '40% · 进行中', lastNote: '已完成接口定义' },
        stepConclusions: [{ at: 1762300100000, result: 'sent', excerpt: '登录接口已拆分' }],
        nextStep: '下一步：实现限流', note: '结论由唤醒记录与 L4 任务笔记提炼',
      }
    }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({
      Comp: h.exports.TaskAnchorPanel,
      props: { taskId: 't-7', task: { id: 't-7', rev: 1, subject: '鉴权模块' }, onChange: () => {} },
    })
    await h.flush()
    assert.match(
      h.records.fetches.join('\n'),
      /\/tasks\/summary\?id=t-7/,
      '任务结论区必须请求 /tasks/summary（需求4 的入口）',
    )
    const text = allText(h.records.renders.at(-1))
    assert.match(text, /任务结论/, '应有「任务结论」区块')
    assert.match(text, /当前进度/, '应有「当前进度」')
    assert.match(text, /40% · 进行中/, '应渲染进度文案')
    assert.match(text, /每步结论/, '应有「每步结论」')
    assert.match(text, /下一步方向/, '应有「下一步方向」')
    assert.match(text, /下一步：实现限流/, '应渲染后端提取的下一步')
  } finally {
    h.restore()
  }
})

test('N1b 任务结论区：无摘要数据时不渲染区块（空区块比没有更烦人）', async () => {
  const h = loadClientStateful()
  h.setResponder((url) => (url.includes('/tasks/summary') ? { ok: true } : EMPTY_RESPONSE()))
  try {
    const tree = h.render({
      Comp: h.exports.TaskAnchorPanel,
      props: { taskId: 't-8', task: { id: 't-8', rev: 1, subject: '空结论' }, onChange: () => {} },
    })
    await h.flush()
    const text = allText(h.records.renders.at(-1))
    assert.ok(!text.includes('任务结论'), '没有 summary 数据时不应渲染「任务结论」区块')
  } finally {
    h.restore()
  }
})

// ── N2 交付物预览（需求3）：TaskDrawer 渲染预览按钮 + FilePreviewModal ──────

test('N2 交付物预览：本地文件渲染「预览文件」按钮，点击打开 FilePreviewModal', async () => {
  const h = loadClientStateful()
  h.setResponder((url) => {
    if (url.includes('/tasks/detail')) {
      return { ok: true, task: { id: 't-9', rev: 1, subject: '改造', artifacts: ['shared/report.md'] }, history: [] }
    }
    if (url.includes('/data/file')) return { ok: true, path: 'shared/report.md', content: '# 交付报告', bytes: 12, truncated: false }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({
      Comp: h.exports.TaskDrawer,
      props: {
        id: 't-9', bots: [], workflows: [], onClose: () => {}, onChange: () => {},
        task: { id: 't-9', rev: 1, subject: '改造', artifacts: ['shared/report.md'] },
      },
    })
    await h.flush()
    // TaskDrawer 的 artifacts 来自异步 /tasks/detail，所以必须断言 flush 后的树
    const tree = h.records.renders.at(-1)
    const btns = findButtonsByText(tree, '预览文件')
    assert.ok(btns.length >= 1, '本地路径交付物应有「预览文件」按钮')
    // 点击预览 → 弹窗组件出现并请求 /data/file
    btns[0].props.onClick?.()
    await h.flush()
    assert.match(
      h.records.fetches.join('\n'),
      /\/data\/file\?path=shared%2Freport\.md/,
      '预览必须请求 /data/file 拿只读内容',
    )
  } finally {
    h.restore()
  }
})

test('N2b 交付物预览：http(s) 链接渲染「打开链接」，不渲染预览按钮', async () => {
  const h = loadClientStateful()
  h.setResponder((url) => {
    if (url.includes('/tasks/detail')) {
      return { ok: true, task: { id: 't-10', rev: 1, subject: '有链接', artifacts: ['https://example.com/r'] }, history: [] }
    }
    return EMPTY_RESPONSE()
  })
  try {
    h.render({
      Comp: h.exports.TaskDrawer,
      props: {
        id: 't-10', bots: [], workflows: [], onClose: () => {}, onChange: () => {},
        task: { id: 't-10', rev: 1, subject: '有链接', artifacts: ['https://example.com/r'] },
      },
    })
    await h.flush()
    const tree = h.records.renders.at(-1)
    const open = findButtonsByText(tree, '打开链接')
    assert.ok(open.length >= 1, 'URL 交付物应有「打开链接」按钮')
    assert.equal(findButtonsByText(tree, '预览文件').length, 0, 'URL 不该有「预览文件」按钮')
  } finally {
    h.restore()
  }
})

// ── N3 大团队 leadId 选择器（需求1）：源码级断言 ─────────────────────────────

test('N3 团队页：大团队 leadId 是下拉选择器，从 roster 选，且无队长时禁用创建', () => {
  // TeamsTab 未导出，按源码级断言（客户端静态装载测试同口径）
  assert.match(SOURCE, /rosterQ = useApi\('\/roster'\)/, 'TeamsTab 必须从 /roster 读队长候选')
  assert.match(SOURCE, /function TeamsTab\(\{ onGoto \}\)/, 'TeamsTab 应接收 onGoto')
  assert.match(SOURCE, /bots\.map\(\(b\) => h\('option'/, '队长选择器应列出每个 Bot 作为选项')
  assert.match(SOURCE, /\$\{b\.name\}（\$\{b\.sessionId\}）/, '选项文案应是「名字（sessionId）」')
  assert.match(SOURCE, /leadMissing/, '应计算「大团队缺队长」状态')
  assert.match(SOURCE, /disabled: leadMissing/, '缺队长时创建按钮必须禁用')
  assert.match(SOURCE, /大团队必须指定负责人/, '缺队长时应给出可读提示')
  assert.match(SOURCE, /onGoto\?\.\('bots'\)/, '应提供「新建 Bot」跳转')
  assert.match(SOURCE, /botName\(rosterQ\.data\?\.bots \?\? \[\], t\.leadId\)/, '团队卡片应显示队长名字而非裸 ID')
})

// ── S11 新增代码没有引入相对 require（沿用 C11 的口径，覆盖本文件全部新增） ──

test('S11 来源跳转新增代码没有引入相对 require', () => {
  const matches = [...SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const relative = matches.filter((s) => s.startsWith('.') || s.startsWith('/'))
  assert.deepEqual(relative, [], `不得 require 相对路径，实际=${relative}`)
  // 客户端不得使用 window.prompt/confirm/alert（CI 机械禁止）
  assert.equal([...SOURCE.matchAll(/window\.(prompt|confirm|alert)\(/g)].length, 0, '客户端不得用 prompt/confirm/alert')
})
