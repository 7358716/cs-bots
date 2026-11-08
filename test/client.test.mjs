/**
 * cs-bots 客户端测试 —— 两层：
 *
 *  **A. 静态装载契约（无依赖，必跑）**：
 *      用假的 `window.__ModuleLoader__` 真实加载 `src/client.js`，断言：
 *      - 能装载、导出 `apply` / `inject`
 *      - `apply(ctx)` 注册了 `main` 与 `sidebar.panellist`，且 **main 在前**
 *      - key/id 一致（`selectPanel(id)` 依赖这点）
 *      - 无相对 require（浏览器端模块装载不支持相对路径）
 *      - 有 ErrorBoundary 且每个 Tab 单独包
 *
 *  **B. 真实 DOM 渲染（需 jsdom + react，缺则 SKIP）**：
 *      历史教训：`selftest.mjs` 只测宿主、不加载 client.js → 真机白屏。
 *      所以有 jsdom 时必须真的渲染一遍。
 *
 * 为什么分两层：jsdom/react 是 **dev-only** 依赖，不进插件运行时；
 * 在干净环境（无 node_modules）里也必须能跑通 A，否则 CI 会被环境卡死。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(__dirname, '..', 'src', 'client.js')
const SOURCE = readFileSync(CLIENT_FILE, 'utf8')

// ── A. 静态装载契约 ──────────────────────────────────────────────────────────

/** 在一个假模块环境里真实执行 client.js，返回它导出的模块。 */
function loadClient() {
  let loaded = null
  const fakeRequire = (spec) => {
    // 禁止相对路径（浏览器端模块装载不支持）
    if (spec.startsWith('.') || spec.startsWith('/')) {
      throw new Error(`客户端不得 require 相对路径: ${spec}`)
    }
    if (spec === 'react') return globalThis.__FAKE_REACT__
    throw new Error(`未注册的包: ${spec}`)
  }
  const fakeWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = { id, module: factory(fakeRequire) }
      },
    },
  }
  // 极简假 React：只需 createElement / Component / hooks 存在即可让装载通过
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
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
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  globalThis.__FAKE_REACT__ = fakeReact

  const prevWindow = globalThis.window
  globalThis.window = fakeWindow
  try {
    // 用动态 import 执行（client.js 依赖 window 全局）
    return { client: runClientWith(SOURCE, fakeWindow, fakeRequire), fakeReact }
  } finally {
    globalThis.window = prevWindow
  }
}

/** 用 new Function 执行 client.js 源码（模拟浏览器装载）。 */
function runClientWith(source, fakeWindow, fakeRequire) {
  let captured = null
  const w = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, exports: factory(fakeRequire) }
      },
    },
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', source)
  fn(w)
  if (!captured) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  return captured
}

test('A1 客户端能被 __ModuleLoader__ 装载，且 id 正确', () => {
  const c = loadClient().client
  assert.equal(c.id, 'cs-bots', '模块 id 必须是 cs-bots')
  assert.ok(c.exports, 'factory 应返回 exports')
})

test('A2 导出 apply 与 inject（官方客户端契约）', () => {
  const { exports } = loadClient().client
  assert.equal(typeof exports.apply, 'function', '必须导出 apply')
  assert.ok(Array.isArray(exports.inject), '必须导出 inject 数组')
  assert.ok(exports.inject.includes('slots'), 'inject 必须含 slots')
})

test('A3 apply() 注册 main 与 sidebar.panellist，且 **main 在前**', () => {
  const { exports } = loadClient().client
  const registrations = []
  const ctx = {
    slots: {
      inject: (name, fn) => {
        fn()
        return () => {}
      },
      register: (options, Component) => {
        registrations.push({ options, Component })
        return () => {}
      },
    },
    layout: {},
  }
  const dispose = exports.apply(ctx)

  const names = registrations.map((r) => r.options.name)
  // 顺序铁律：main 必须先于 panellist（selectPanel 校验 main 存在）
  assert.ok(names.includes('main'), `必须注册 main，实际=${names}`)
  assert.ok(names.includes('sidebar.panellist'), `必须注册 sidebar.panellist，实际=${names}`)
  assert.ok(
    names.indexOf('main') < names.indexOf('sidebar.panellist'),
    `main 必须在 panellist 之前，实际=${names}`,
  )
  // 允许（并且应该有）额外的 settings.section 注册
  assert.ok(names.includes('settings.section'), `应把设置页挂到官方 settings.section，实际=${names}`)
  assert.equal(typeof dispose, 'function', 'apply 应返回 disposer')
})

test('A4 key/id 一致（selectPanel(id) 依赖这点）', () => {
  const { exports } = loadClient().client
  const regs = []
  const ctx = {
    slots: { inject: (n, fn) => (fn(), () => {}), register: (o) => (regs.push(o), () => {}) },
    layout: {},
  }
  exports.apply(ctx)
  const main = regs.find((r) => r.name === 'main')
  const entry = regs.find((r) => r.name === 'sidebar.panellist')
  assert.ok(main?.key, 'main 必须有 key')
  assert.ok(entry?.id, '入口必须有 id')
  assert.equal(main.key, entry.id, `main.key(${main.key}) 必须等于入口 id(${entry.id})`)
})

test('A5 无相对 require（浏览器端不支持）', () => {
  // 静态扫描：require('...') 里不得出现相对路径
  const matches = [...SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const relative = matches.filter((s) => s.startsWith('.') || s.startsWith('/'))
  assert.deepEqual(relative, [], `不得 require 相对路径，实际=${relative}`)
})

test('A6 有 ErrorBoundary，且实现 getDerivedStateFromError + componentDidCatch', () => {
  assert.match(SOURCE, /getDerivedStateFromError/, '必须有 getDerivedStateFromError')
  assert.match(SOURCE, /componentDidCatch/, '必须有 componentDidCatch')
})

test('A7 四个 Tab 都存在，且每个 Tab 被 Boundary 单独包裹', () => {
  const { exports } = loadClient().client
  for (const name of ['TasksTab', 'RoomsTab', 'MemoryTab', 'BotsTab']) {
    assert.equal(typeof exports[name], 'function', `应导出 ${name}`)
  }
  // 源码层面确认 Workbench 里用 Boundary 包了当前 Tab
  assert.match(SOURCE, /h\(Boundary,\s*\{\s*tab:/, 'Workbench 必须用 Boundary 包裹当前 Tab')
})

test('A8 样式注入带 data-plugin 标记（可清理、不污染全局）', () => {
  assert.match(SOURCE, /dataset\.plugin\s*=/, '样式标签必须带 data-plugin')
  assert.match(SOURCE, /data-plugin-css/, '样式标签必须带 data-plugin-css（幂等判据）')
})

test('A9 API 前缀与宿主一致（/cs-bots/api）', () => {
  const { exports } = loadClient().client
  assert.equal(exports.API, '/cs-bots/api', '客户端 API 前缀必须与 src/api.js 一致')
})

test('A10 新增页签「成果」「数据」已导出并入 TABS（改造03）', () => {
  const { exports } = loadClient().client
  for (const name of ['ArtifactsTab', 'DataTab']) {
    assert.equal(typeof exports[name], 'function', `应导出 ${name}`)
  }
  // TABS 里必须真的有这两个页签，否则组件导出了也没人渲染（就是「功能不存在」）
  assert.match(SOURCE, /id:\s*'artifacts',\s*label:\s*'成果'/, 'TABS 应含「成果」页签')
  assert.match(SOURCE, /id:\s*'data',\s*label:\s*'数据'/, 'TABS 应含「数据」页签')
})

test('A11 改造03 新端点在客户端被调用（/artifacts、/data/files、/tasks/graph）', () => {
  // 前后端契约要对得上：客户端调用的路径必须与 design/CONTRACT-bots03.md 一致
  assert.match(SOURCE, /['"`]\/artifacts/, 'ArtifactsTab 必须调用 /artifacts')
  assert.match(SOURCE, /\/data\/files/, 'DataTab 必须调用 /data/files')
  assert.match(SOURCE, /\/data\/rows/, 'DataTab 必须调用 /data/rows')
  assert.match(SOURCE, /\/tasks\/graph/, 'TaskDrawer 必须调用 /tasks/graph')
})

test('A12 新页签首次渲染不抛（无网络时只出空态/加载态，不白屏）', () => {
  const { exports } = loadClient().client
  for (const name of ['ArtifactsTab', 'DataTab']) {
    const tree = exports[name]({ onGoto: () => {} })
    assert.ok(tree && typeof tree === 'object', `${name} 首渲染应返回元素树`)
  }
})

// ── B. 真实 DOM 渲染（需 jsdom + react）──────────────────────────────────────

test('B1 真实渲染 Workbench（需 jsdom+react，缺则 SKIP）', async (t) => {
  let JSDOM, React, ReactDOMClient
  try {
    ;({ JSDOM } = await import('jsdom'))
    React = await import('react')
    ReactDOMClient = await import('react-dom/client')
  } catch {
    t.skip('jsdom/react 不可用（dev-only 依赖），跳过真实渲染')
    return
  }

  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
  })
  const prevWindow = globalThis.window
  const prevDocument = globalThis.document
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  // 让 fetch 可控：直接失败也无所谓，Tab 应显示错误而不是白屏
  dom.window.fetch = () => Promise.reject(new Error('no-network-in-test'))
  globalThis.fetch = dom.window.fetch

  let captured = null
  const fakeRequire = (spec) => {
    if (spec === 'react') return React
    if (spec.startsWith('.')) throw new Error(`relative require: ${spec}`)
    throw new Error(`未注册: ${spec}`)
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', SOURCE)({
      __ModuleLoader__: {
        load({ factory }) {
          captured = factory(fakeRequire)
        },
      },
    })
    assert.ok(captured, 'client.js 应完成装载')

    const root = ReactDOMClient.createRoot(dom.window.document.getElementById('app'))
    const { act } = await import('react-dom/test-utils').catch(() => ({}))
    const render = async () => {
      if (act) await act(async () => {
        root.render(React.createElement(captured.Workbench))
      })
      else root.render(React.createElement(captured.Workbench))
    }
    await render()

    // 关键断言：**没有白屏**，改造07 的 6 个上层页签按钮都在
    const text = dom.window.document.body.textContent ?? ''
    assert.match(text, /工作台/, '应渲染出「工作台」Tab（改造07）')
    assert.match(text, /团队/, '应渲染出「团队」Tab（改造07）')
    assert.match(text, /记忆/, '应渲染出「记忆」Tab')
    assert.match(text, /技能库/, '应渲染出「技能库」Tab')
    assert.match(text, /数据/, '应渲染出「数据」Tab')
    assert.match(text, /穿透/, '应有「穿透」入口（下层工具）')

    root.unmount()
  } finally {
    globalThis.window = prevWindow
    globalThis.document = prevDocument
    dom.window.close()
  }
})
