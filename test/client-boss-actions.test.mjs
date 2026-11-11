/**
 * 契约 §2.5（阶段产出物）+ §4.3（Boss 直接动手）前端回归。
 *
 * ## 为什么单独一个文件
 *   `client-anchor.test.mjs` 已经很长（1300+ 行），再把这两块塞进去，
 *   下次谁改坏了都定位不到是哪儿红。一个契约小节一个文件，红的时候文件名就是答案。
 *
 * ## 断言策略
 *   · 结构类断言走**假 React 真执行**（与 client-anchor 同手法）——
 *     能拿到 `h()` 造出来的元素树，断言"渲染出了哪个按钮/哪句话"。
 *   · 文案类断言直接 grep SOURCE —— 便宜且不会被组件层级变化干扰。
 *   · 一律**不测真 fetch**：后端未就绪时前端必须降级成可读提示，这条也要测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT_FILE = new URL('../src/client.js', import.meta.url)
const SOURCE = readFileSync(CLIENT_FILE, 'utf8')

// ── 假 React（与 client-anchor.test.mjs 同手法，见那边的注释）──────────────

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
          /* 首渲染只关心「抛不抛」；effect 内的异常另测 */
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

// ── S1 · 契约 §2.5 阶段产出物：面板存在且排在总产出物之前 ───────────────────

test('S1 阶段产出物面板已挂进任务详情，且排在「产出物证据」之前', () => {
  assert.match(SOURCE, /function TaskPhasePanel\(\{ taskId, onPreview \}\)/, '必须有 TaskPhasePanel')
  assert.match(SOURCE, /\/tasks\/phases\?id=/, '必须读 GET /tasks/phases?id=')
  const iPhase = SOURCE.indexOf('h(TaskPhasePanel, { taskId: task.id')
  const iArtifacts = SOURCE.indexOf("title: '产出物证据'")
  assert.ok(iPhase > 0, 'TaskDrawer 里必须渲染 TaskPhasePanel')
  assert.ok(iArtifacts > 0, '必须有「产出物证据」区块')
  assert.ok(iPhase < iArtifacts, '契约 §2.5：阶段产出物必须排在总产出物证据**之前**')
})

test('S2 阶段产出物：非长任务显示空态而不是报错，且指向总产出物', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.TaskPhasePanel, 'function')
  // 首渲染（data 未到）不能抛 —— 白屏是 P0
  const tree = exports.TaskPhasePanel({ taskId: 't-1', onPreview: () => {} })
  assert.ok(tree && typeof tree === 'object', '首渲染应返回元素树')
  // 源码里明确写了非长任务的空态文案（契约 §2.5 的原句）
  assert.match(SOURCE, /这不是长任务，没有分阶段产物/, '非长任务空态标题')
  assert.match(SOURCE, /总产出物见下方「产出物证据」。/, '空态必须指向总产出物')
})

test('S3 阶段产出物：四个状态徽标齐全，读不到时给重试而不是静默', () => {
  // 未开始 / 进行中 / 已完成 / 卡住 —— 契约 §2.5 要求四种状态
  assert.match(SOURCE, /'已完成' : st === 'blocked' \? '卡住'/, '必须有已完成/卡住')
  assert.match(SOURCE, /st === 'doing' \? '进行中' : '未开始'/, '必须有进行中/未开始')
  assert.match(SOURCE, /阶段产出物读不到：/, '读取失败必须说人话')
  assert.match(SOURCE, /onClick: \(\) => phasesQ\.reload\(\)/, '失败要给重试入口')
  assert.match(SOURCE, /执行者还没汇报这一阶段。/, '空态要说清「谁还没汇报」')
})

test('S4 阶段产出物：路径可预览、URL 可打开（不是死文本）', () => {
  assert.match(SOURCE, /onClick: \(\) => onPreview\?\.\(a\)/, '文件路径必须能点开预览')
  assert.match(SOURCE, /window\.open\(a, '_blank', 'noopener'\)/, 'http(s) 链接必须能打开')
})

// ── S5 · 契约 §4.3 五条 Boss 直接动手路径 ──────────────────────────────────

test('S5 Boss 直接动手：五类动作全部有入口（不跳页、不靠 prompt）', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.TaskBossActions, 'function', '必须有 TaskBossActions')
  const tree = exports.TaskBossActions({
    task: { id: 't-1', rev: 3, status: 'in_progress', subject: 'x', writeScopes: ['src/a.js'] },
    bots: [],
    onChange: () => {},
    onReassign: () => {},
  })
  assert.ok(tree && typeof tree === 'object', '首渲染应返回元素树')
  const txt = allText(tree)
  assert.match(txt, /改优先级 \/ 截止 \/ 复杂度 \/ 付费/, '(a) 排期与路由')
  assert.match(txt, /改目标与边界/, '(b) 目标与边界')
  assert.match(txt, /换负责人 \/ 重新派发/, '(c) 换负责人')
  assert.match(txt, /收回任务/, '(c) 收回')
  assert.match(txt, /阻塞任务/, '(d) 阻塞')
  assert.match(txt, /归档/, '(d) 关闭归档')
  assert.match(txt, /编辑长任务阶段清单/, '(e) 阶段清单')
})

test('S6 Boss 直接动手：所有写都带 expectedRev（CAS），且没有 window.prompt', () => {
  const body = SOURCE.slice(SOURCE.indexOf('function TaskBossActions'), SOURCE.indexOf('function toDateInput'))
  assert.ok(body.length > 1000, '应能切出 TaskBossActions 函数体')
  const writes = body.match(/call\('\/tasks\/[a-z]+',/g) ?? []
  assert.ok(writes.length >= 5, `至少 5 处写操作，实际 ${writes.length}`)
  // 每一处调用都要带 expectedRev（同一行内）
  for (const line of body.split('\n')) {
    if (!/call\('\/tasks\//.test(line)) continue
    const around = body.slice(body.indexOf(line), body.indexOf(line) + line.length + 200)
    assert.match(around, /expectedRev: task\.rev/, `写操作必须带 CAS：${line.trim()}`)
  }
  // 与 CI 检查 5 同一口径：必须带调用括号才算违规（注释里提「不许用 window.prompt」不算）
  assert.doesNotMatch(SOURCE, /window\.(prompt|confirm|alert)\(/, '客户端禁用原生 prompt/confirm/alert')
})

test('S7 Boss 直接动手：失败必须带后端理由，成功也要如实提示', () => {
  assert.match(SOURCE, /humanizeError\(e, \{\}, `\$\{label\}失败：`\)/, '失败走 humanizeError 带原因')
  assert.match(SOURCE, /h\(Notice, \{ kind: 'ok', onClose: \(\) => setDone\(null\) \}, done\)/, '成功给 toast')
})

test('S8 换负责人弹窗在 TaskDrawer 内可打开（契约 §4.3(c) 内联，不跳页）', () => {
  assert.match(SOURCE, /onReassign: \(\) => setReassignOpen\(true\)/, '任务详情里要能打开换负责人')
  assert.match(SOURCE, /reassignOpen\s*\? h\(TaskReassignModal, \{ task, bots, onClose/, '弹窗就地渲染')
})

// ── S9 · 日期输入辅助（排期可编辑的前提）──────────────────────────────────

test('S9 toDateInput / dateInputToMs 双向可用，坏值不炸', () => {
  const { exports } = loadClient()
  assert.equal(exports.toDateInput(null), '', 'null 不炸')
  assert.equal(exports.toDateInput('不是时间'), '', '坏值不炸')
  assert.equal(exports.toDateInput(new Date(2026, 10, 10, 12).getTime()), '2026-11-10')
  assert.equal(exports.dateInputToMs(''), null)
  assert.equal(exports.dateInputToMs('乱写'), null)
  const ms = exports.dateInputToMs('2026-11-10')
  const d = new Date(ms)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 10)
  assert.equal(d.getDate(), 10)
  assert.equal(d.getHours(), 23, '截止＝当天结束前都算没超')
})

// ── S10 · §7.1 租约彻底消失（Boss 明确不要看）─────────────────────────────

test('S10 页面上不许出现「租约 / 延长 / 占用到」相关 UI 文案', () => {
  assert.doesNotMatch(SOURCE, /高级：租约/, '整个「高级：租约」Section 必须删掉')
  assert.doesNotMatch(SOURCE, /延长 5 分钟/, '不许给「延长 5 分钟」按钮')
  assert.doesNotMatch(SOURCE, /当前占用到/, '不许展示占用时间')
  assert.doesNotMatch(SOURCE, /当前没有租约/, '不许出现租约字样')
})

// ── S11 · 新导出的语义辅助 ────────────────────────────────────────────────

test('S11 humanizeBy：Boss 的机器标识显示为 Boss，别人的身份不美化', () => {
  const { exports } = loadClient()
  assert.equal(exports.humanizeBy('ui'), 'Boss')
  assert.equal(exports.humanizeBy(undefined), 'Boss', '缺省视为 Boss 提交')
  assert.equal(exports.humanizeBy('bot-a'), 'bot-a', '非 Boss 保持原文')
})