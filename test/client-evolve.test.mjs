/**
 * cs-bots / 前端改造06（CONTRACT-bots06 §3）测试 —— 无 jsdom / 无 react，纯静态装载。
 *
 * 背景（用户原话）：「完成的任务应该可以纠错或者优化或者更改或其他变更，变更成长任务」
 *                  「任务可以变更负责人」
 * 现状风险：用户看到已完成任务，以为不能改只能新建 —— 所以变更入口必须在
 * 已完成任务的详情里**默认展开**，且重开时「上一轮交付物」要明确告知已存档。
 *
 * 测什么（契约 §3 + 验收清单）：
 *   E1 源码级：三个按钮 / 变更说明必填 / 已完成标题 / 「上一轮交付物…已存档，重开不会丢证据」/
 *      「换负责人」/「已从 … 换到 …」文案都在
 *   E2 真调端点：postEvolve 三种 mode 的 body、postReassign 的 body（假 fetch 桩）
 *       且空 note / 缺 ownerId 必须**明确报错**（不静默）
 *   E3 TaskEvolvePanel 已完成任务首渲染不抛，三个按钮都在，默认展开
 *   E4 未完成任务默认收起（不打扰），但折叠条给出展开入口
 *   E5 EvolveHistory：`[时间] 动作 — 说明（by）` 格式 + 上一轮交付物 + 长任务阶段
 *   E6 evolveActionLabel / evolveChangeText 单位断言
 *   E7 TaskReassignModal 首渲染不抛；Bot 下拉排除 retired；无可用 Bot 时不静默
 *   E8 TaskAnchorPanel 里「换负责人」按钮存在且首渲染不抛；/tasks/changes 真的被请求
 *   E9 回归：resolveOwnerBot / gotoOwner 没被改动；没有相对 require
 *
 * 为什么不用 jsdom+react：jsdom/react 是 dev-only 依赖，干净环境里没有；
 * 本文件必须**零依赖**可跑（与 client.test.mjs / client-revive.test.mjs 同一口径）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(__dirname, '..', 'src', 'client.js')
const SOURCE = readFileSync(CLIENT_FILE, 'utf8')

// ── 假 React（与 client.test.mjs / client-anchor.test.mjs / client-revive.test.mjs 同一手法）

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
 * 用假 `__ModuleLoader__` 真实执行 client.js，返回 exports。
 * 注意：必须 `return { exports: captured }`（裸 return captured 会让所有用例假失败）。
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

/** 找 select 的 option（换负责人下拉）。 */
function findOptions(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) findOptions(n, out)
    return out
  }
  if (node.type === 'option') out.push(node)
  findOptions(node.children, out)
  for (const v of Object.values(node.props ?? {})) {
    if (Array.isArray(v)) findOptions(v, out)
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
    calls.push({ url: String(url), body })
    return { status: 200, json: async () => responder(String(url), body) }
  }
  let result
  try {
    result = await fn()
  } finally {
    globalThis.fetch = prev
  }
  return { calls, result }
}

// ── E1 源码级：文案 / 按钮齐全 ─────────────────────────────────────────────

test('E1 变更区块三个按钮与关键文案齐全（源码级）', () => {
  // 契约 §3.1：三个变更动作
  assert.match(SOURCE, /'重开（纠错\/继续做）'/, '必须有「重开（纠错/继续做）」按钮')
  assert.match(SOURCE, /'派生优化单'/, '必须有「派生优化单」按钮')
  assert.match(SOURCE, /'转为长任务'/, '必须有「转为长任务」按钮')
  // 变更说明必填
  assert.match(SOURCE, /变更说明（必填）/, '必须有变更说明输入（必填）')
  assert.match(SOURCE, /没有说明的变更不许提交/, '必填要有说明，不能只有红字')
  // 契约 §3.3：已完成任务的入口显眼
  assert.match(SOURCE, /已完成 · 要纠错\/优化\/变更从这里开始/, '已完成任务的区块标题要改成行动指引')
  // 契约 §3.1：上一轮交付物存档提示
  assert.match(SOURCE, /上一轮交付物/, '要显示「上一轮交付物」')
  assert.match(SOURCE, /已存档，重开不会丢证据/, '要说明重开不会丢证据')
  assert.match(SOURCE, /已派生 \$\{/, '派生成功要显示「已派生 t-xx」')
  // 契约 §3.2：换负责人
  assert.match(SOURCE, /'换负责人'/, '负责人旁必须有「换负责人」按钮')
  assert.match(SOURCE, /已从 \$\{fromName\} 换到 \$\{toName\}/, '成功要显示「已从 A 换到 B」')
  assert.match(SOURCE, /TASK_COMPLETED/, '已完成任务被拦时要能识别 code')
})

test('E1b 三条通道都接到契约端点，且没退化成别处（源码级）', () => {
  assert.match(SOURCE, /call\(\s*'\/tasks\/evolve'/, '必须 POST /tasks/evolve')
  assert.match(SOURCE, /call\(\s*'\/tasks\/reassign'/, '必须 POST /tasks/reassign')
  assert.match(SOURCE, /\/tasks\/changes\?id=/, '必须 GET /tasks/changes?id=')
  // longrun 必须带 reopen:true（长任务一般要接着做）
  assert.match(SOURCE, /reopen: mode === 'longrun'/, '转长任务必须带 reopen:true')
  // 组件真的挂进 TaskDrawer，而不是只定义不接线
  assert.match(SOURCE, /h\(TaskEvolvePanel, \{ taskId: task\.id, task, onChange \}\)/, 'TaskEvolvePanel 必须挂进 TaskDrawer')
})

// ── E2 真调端点（假 fetch 桩）──────────────────────────────────────────────

test('E2 postEvolve：三种 mode 的请求体正确，note 会 trim', async () => {
  const { exports } = loadClient()
  const { calls } = await runWithFetch(() => ({ ok: true, task: { id: 't-99' } }), async () => {
    await exports.postEvolve({ id: 't-26', mode: 'reopen', note: '  第 3 条标准未满足  ' })
    await exports.postEvolve({ id: 't-26', mode: 'followup', note: '优化接口限流' })
    await exports.postEvolve({ id: 't-26', mode: 'longrun', note: '拆成三阶段', reopen: true })
  })
  assert.equal(calls.length, 3, '三个 mode 应各发一次请求')
  for (const c of calls) assert.match(c.url, /\/tasks\/evolve$/, '应调用 /tasks/evolve')
  assert.deepEqual(calls[0].body, { id: 't-26', mode: 'reopen', note: '第 3 条标准未满足' })
  assert.deepEqual(calls[1].body, { id: 't-26', mode: 'followup', note: '优化接口限流' })
  assert.deepEqual(calls[2].body, { id: 't-26', mode: 'longrun', note: '拆成三阶段', reopen: true })
})

test('E2b postReassign：{id, ownerId, expectedRev} 正确', async () => {
  const { exports } = loadClient()
  const { calls } = await runWithFetch(
    () => ({ ok: true, task: { id: 't-26' }, from: 'bot-a', to: 'bot-b', wake: { ok: true, result: 'sent' } }),
    async () => {
      await exports.postReassign({ id: 't-26', ownerId: 'bot-b', expectedRev: 7 })
    },
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/tasks\/reassign$/, '应调用 /tasks/reassign')
  assert.deepEqual(calls[0].body, { id: 't-26', ownerId: 'bot-b', expectedRev: 7 })
})

test('E2c 空变更说明 / 缺新负责人：前端先报错，绝不静默发请求', async () => {
  const { exports } = loadClient()
  await assert.rejects(
    () => exports.postEvolve({ id: 't-26', mode: 'reopen', note: '   ' }),
    /变更说明必填/,
    '没有理由的变更不许提交',
  )
  await assert.rejects(
    () => exports.postReassign({ id: 't-26' }),
    /请先选择新的负责人/,
    '缺 ownerId 必须明确报错',
  )
  const { calls } = await runWithFetch(() => ({ ok: true }), async () => {
    await assert.rejects(() => exports.postEvolve({ id: 't-26', mode: 'reopen', note: '' }))
  })
  assert.equal(calls.length, 0, '校验失败不应发出任何请求')
})

// ── E3 已完成任务：默认展开 + 三个按钮 ─────────────────────────────────────

test('E3 已完成任务的变更区默认展开：首渲染不抛，三个按钮都在', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.TaskEvolvePanel, 'function')
  const task = { id: 't-26', status: 'completed', rev: 7, ownerId: 'bot-a' }
  const tree = exports.TaskEvolvePanel({ taskId: 't-26', task, onChange: () => {} })
  assert.ok(tree && typeof tree === 'object', '首渲染应返回元素树')
  const text = allText(tree)
  assert.match(text, /变更说明（必填）/, '默认展开时输入框可见')
  assert.match(text, /变更 · 已完成的任务可以继续改/, '已完成任务的变更区标题要明确「可以继续改」')
  assert.equal(findButtons(tree, '重开（纠错/继续做）').length, 1)
  assert.equal(findButtons(tree, '派生优化单').length, 1)
  assert.equal(findButtons(tree, '转为长任务').length, 1)
  assert.equal(findButtons(tree, '收起变更面板').length, 1, '默认展开 → 按钮应是「收起」')
  // 三个按钮都要有 onClick（不是纯装饰）
  for (const label of ['重开（纠错/继续做）', '派生优化单', '转为长任务']) {
    assert.equal(typeof findButtons(tree, label)[0]?.props?.onClick, 'function', `${label} 必须有 onClick`)
  }
})

test('E4 未完成任务默认收起，但折叠条给出展开入口（不打扰、也不藏死）', () => {
  const { exports } = loadClient()
  const tree = exports.TaskEvolvePanel({
    taskId: 't-1',
    task: { id: 't-1', status: 'in_progress', rev: 3 },
    onChange: () => {},
  })
  const text = allText(tree)
  assert.match(text, /展开变更面板/, '未完成时默认收起')
  assert.match(text, /变更面板已收起/)
  assert.equal(findButtons(tree, '重开（纠错/继续做）').length, 0, '收起时按钮不在树里')
  assert.equal(findButtons(tree, '展开变更面板').length, 1, '必须有展开入口')
})

// ── E5 变更历史格式 / 上一轮交付物 / 长任务阶段 ─────────────────────────────

test('E5 EvolveHistory：逐条 [时间] 动作 — 说明（by），并显示存档与阶段', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.EvolveHistory, 'function')
  const changes = [
    { kind: 'snapshot', at: 1762000000000, before: { status: 'completed', artifacts: ['a.md', 'b.md'] } },
    { kind: 'reopen', at: 1762000001000, note: '第 3 条标准未满足', by: 'ui' },
    { kind: 'followup', at: 1762000002000, note: '补接口限流', by: 'bot-a', newTaskId: 't-31' },
  ]
  const tree = exports.EvolveHistory({
    changes,
    latestSnapshot: { status: 'completed', artifacts: ['a.md', 'b.md'] },
    longrun: { phases: ['范围与验收标准确认', '执行与自测', '交付与复盘'] },
    loading: false,
    error: null,
  })
  const text = allText(tree)
  assert.match(text, /上一轮交付物：a\.md、b\.md（已存档，重开不会丢证据）/)
  assert.match(text, /变更历史（3 条/)
  assert.match(text, /\] 重开 — 第 3 条标准未满足（ui）/, '格式必须是 [时间] 动作 — 说明（by）')
  assert.match(text, /\] 派生优化单 — 补接口限流（bot-a）/)
  assert.match(text, /\] 存档上一轮状态 — 上一轮交付物 2 项/, '快照没有 note 时不能空动作')
  assert.match(text, /长任务阶段：1\. 范围与验收标准确认；2\. 执行与自测；3\. 交付与复盘/)

  // 没有快照 / 阶段时不该硬造内容
  const bare = exports.EvolveHistory({ changes: [], latestSnapshot: null, longrun: null })
  assert.doesNotMatch(allText(bare), /上一轮交付物/)
  assert.doesNotMatch(allText(bare), /长任务阶段/)
  assert.match(allText(bare), /还没有变更记录/)
})

test('E6 evolveActionLabel / evolveChangeText 单位断言', () => {
  const { exports } = loadClient()
  assert.equal(exports.evolveActionLabel('reopen'), '重开')
  assert.equal(exports.evolveActionLabel('followup'), '派生优化单')
  assert.equal(exports.evolveActionLabel('longrun'), '转为长任务')
  assert.equal(exports.evolveActionLabel('reassign'), '换负责人')
  assert.equal(exports.evolveActionLabel('snapshot'), '存档上一轮状态')
  assert.equal(exports.evolveActionLabel('weird'), 'weird', '未知 kind 保持原文，不猜')
  assert.match(
    exports.evolveChangeText({ kind: 'reopen', at: 1762000001000, note: '第 3 条标准未满足', by: 'ui' }),
    /^\[.+\] 重开 — 第 3 条标准未满足（ui）$/,
  )
  assert.match(
    exports.evolveChangeText({ kind: 'reassign', at: 1762000001000, from: 'bot-a', to: 'bot-b' }),
    /换负责人 — bot-a → bot-b/,
  )
  assert.match(
    exports.evolveChangeText({ kind: 'snapshot', at: 1762000001000, before: { artifacts: ['x'] } }),
    /存档上一轮状态 — 上一轮交付物 1 项/,
  )
})

// ── E7 换负责人弹窗 ────────────────────────────────────────────────────────

test('E7 TaskReassignModal：首渲染不抛，Bot 下拉排除 retired', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.TaskReassignModal, 'function')
  const bots = [
    { id: 'b-1', name: '阿尔法', sessionId: 's-1', state: 'idle' },
    { id: 'b-2', name: '退役兵', sessionId: 's-2', state: 'retired' },
    { id: 'b-3', name: '贝塔', sessionId: 's-3', state: 'running' },
  ]
  const tree = exports.TaskReassignModal({
    task: { id: 't-26', rev: 7, ownerId: 's-1' },
    bots,
    onClose: () => {},
    onChange: () => {},
  })
  const text = allText(tree)
  assert.match(text, /换负责人/, '弹窗标题是「换负责人」')
  assert.match(text, /当前负责人：阿尔法/)
  assert.match(text, /确认换人/)
  const opts = findOptions(tree).map((o) => allText(o))
  assert.ok(opts.some((t) => t.includes('阿尔法')), `应列出未退役 Bot，实际=${opts.join('|')}`)
  assert.ok(opts.some((t) => t.includes('贝塔')), `应列出未退役 Bot，实际=${opts.join('|')}`)
  assert.equal(findOptions(tree).length, 3, '占位项 + 2 个未退役 Bot')
  assert.ok(!opts.some((t) => t.includes('退役兵')), '退役 Bot 不得出现在下拉里')
})

test('E7b 没有可用 Bot 时明确提示，而不是给个空下拉', () => {
  const { exports } = loadClient()
  const tree = exports.TaskReassignModal({
    task: { id: 't-1', rev: 1 },
    bots: [{ id: 'b-9', name: '已退役', sessionId: 's-9', state: 'retired' }],
    onClose: () => {},
    onChange: () => {},
  })
  const text = allText(tree)
  assert.match(text, /还没有可指派的 Bot/, '没有可选 Bot 要说清楚下一步')
  assert.match(text, /退役的不算/)
  assert.equal(findOptions(tree).length, 0)
})

test('E7c 换负责人失败要带后端 reason，已完成任务要指向「重开」', () => {
  assert.match(SOURCE, /换负责人失败：\$\{e\.message\}/, '失败必须显示后端 reason')
  assert.match(SOURCE, /请先用下方「变更」区的「重开（纠错\/继续做）」或「派生优化单」/, '已完成任务要指向重开/派生')
  assert.match(SOURCE, /reassignWakeText/, '成功要带唤醒结果')
})

// ── E8 目标锚区接线 + /tasks/changes 真的被请求 ────────────────────────────

test('E8 TaskAnchorPanel：负责人旁有「换负责人」按钮，首渲染不抛', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.TaskAnchorPanel, 'function')
  const tree = exports.TaskAnchorPanel({
    taskId: 't-26',
    task: { id: 't-26', status: 'completed', rev: 7, ownerId: 's-1' },
    onChange: () => {},
  })
  const text = allText(tree)
  assert.match(text, /执行者：/)
  assert.equal(findButtons(tree, '换负责人').length, 1, '负责人旁必须有「换负责人」')
  assert.equal(typeof findButtons(tree, '换负责人')[0]?.props?.onClick, 'function')
})

test('E8b TaskEvolvePanel 挂载即请求 GET /tasks/changes?id=', async () => {
  const { exports } = loadClient({ execEffects: true })
  const { calls } = await runWithFetch(
    () => ({ ok: true, taskId: 't-26', changes: [], longrun: null, latestSnapshot: null }),
    async () => {
      exports.TaskEvolvePanel({ taskId: 't-26', task: { id: 't-26', status: 'completed' }, onChange: () => {} })
    },
  )
  const hit = calls.find((c) => c.url.includes('/tasks/changes'))
  assert.ok(hit, '变更区必须请求 /tasks/changes')
  assert.match(hit.url, /\/tasks\/changes\?id=t-26$/)
})

// ── E9 回归护栏 ────────────────────────────────────────────────────────────

test('E9 resolveOwnerBot / gotoOwner 未被破坏（Lead 的修复必须保留）', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.resolveOwnerBot, 'function')
  assert.match(SOURCE, /const gotoOwner = async/, 'gotoOwner 必须还在（Lead 修好的去对话逻辑）')
  assert.match(SOURCE, /function resolveOwnerBot/, 'resolveOwnerBot 必须还在')

  // 平台伪身份不算 Bot：assignee='ui' + 无 ownerId → 无 bot、纯平台身份
  const platformOnly = exports.resolveOwnerBot({
    task: { assignee: 'ui' },
    bots: [{ id: 'b-1', sessionId: 's-1', name: 'x' }],
  })
  assert.equal(platformOnly.bot, null)
  assert.equal(platformOnly.onlyPlatform, true)

  // assignee 优先于 ownerId（改造05 的修复点：ownerId 可能被人 claim 成 ui）
  const byAssignee = exports.resolveOwnerBot({
    task: { assignee: 's-1' },
    ownerId: 'ui',
    bots: [{ id: 'b-1', sessionId: 's-1', name: 'x' }],
  })
  assert.equal(byAssignee.bot?.id, 'b-1')
  assert.equal(byAssignee.onlyPlatform, false)
})

test('E10 新增代码没有引入相对 require', () => {
  const matches = [...SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const relative = matches.filter((s) => s.startsWith('.') || s.startsWith('/'))
  assert.deepEqual(relative, [], `不得 require 相对路径，实际=${relative}`)
  // 无 JSX：这个文件不能用 React 的 JSX 语法（历史上拼错括号会让整批插件加载失败）
  assert.doesNotMatch(SOURCE, /<[A-Z][A-Za-z0-9]*[\s>]/, '不得出现 JSX 组件标签')
})
