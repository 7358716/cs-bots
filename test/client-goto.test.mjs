/**
 * cs-bots · 「去对话」负责人解析回归测试（修 2026-11-06 用户实测报错）
 *
 * 用户原话：「任务页面点击去对话显示错误：该负责人不是本平台的 Bot，无法跳转…
 *            可以复制 ID 到左侧会话列表里手动定位 ui」
 *
 * 根因（数据可证）：
 *   任务 t-26 的 `ownerId` 是 `"ui"`（人自己领了/验收时被覆盖），
 *   而真正派给谁记在 `assignee`（`bot-6b654c19-…`）。
 *   旧实现只看 `ownerId` → 拿 `ui` 去 roster 里找 → 找不到 → 报一句无解的错误。
 *
 * 修法：按 **assignee → ownerId → task.ownerId** 顺序解析，并过滤平台伪身份
 *      （`ui`/`user`/`anyone`/`system` 永远不可能是 Bot 会话 id）。
 *
 * 为什么必须固化：这是「派活成功了但人以为没派」的直接入口，错一次就让人
 * 对整个任务板失去信任。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(__dirname, '..', 'src', 'client.js'), 'utf8')

function loadClient() {
  let captured = null
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState() {}
    },
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v ?? null }),
  }
  const fakeRequire = (spec) => {
    if (spec.startsWith('.') || spec.startsWith('/')) throw new Error(`不得 require 相对路径: ${spec}`)
    if (spec === 'react') return fakeReact
    throw new Error(`未注册的包: ${spec}`)
  }
  const fakeWindow = { __ModuleLoader__: { load({ factory }) { captured = factory(fakeRequire) } } }
  const prev = globalThis.window
  globalThis.window = fakeWindow
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', SOURCE)(fakeWindow)
  } finally {
    globalThis.window = prev
  }
  if (!captured) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  return { exports: captured }
}

const BOTS = [
  { id: 'bot-a', sessionId: 'bot-a', name: '后端' },
  { id: 'bot-b', sessionId: 'bot-b', name: '测试' },
]

test('G1 ownerId=ui 但 assignee 是 Bot：应解析到 assignee 的 Bot（用户实测的那个 bug）', () => {
  const { exports } = loadClient()
  const r = exports.resolveOwnerBot({
    task: { id: 't-26', ownerId: 'ui', assignee: 'bot-a' },
    ownerId: 'ui',
    bots: BOTS,
  })
  assert.ok(r.bot, '必须能解析出 Bot —— 否则就是用户看到的那条错误')
  assert.equal(r.bot.sessionId, 'bot-a')
  assert.equal(r.onlyPlatform, false)
  assert.deepEqual(r.candidates, ['bot-a', 'ui'], '候选顺序：assignee 优先，其次 ownerId')
})

test('G2 只有 ownerId 且是真 Bot：仍能解析（旧行为不回退）', () => {
  const { exports } = loadClient()
  const r = exports.resolveOwnerBot({
    task: { id: 't-27', ownerId: 'bot-b' },
    ownerId: 'bot-b',
    bots: BOTS,
  })
  assert.equal(r.bot.sessionId, 'bot-b')
})

test('G3 负责人全是平台伪身份：onlyPlatform=true（提示要说人话，不是无解）', () => {
  const { exports } = loadClient()
  for (const pseudo of ['ui', 'user', 'anyone', 'system', 'UI']) {
    const r = exports.resolveOwnerBot({
      task: { id: 't-1', ownerId: pseudo },
      ownerId: pseudo,
      bots: BOTS,
    })
    assert.equal(r.bot, null, `${pseudo} 不应被当成 Bot 会话`)
    assert.equal(r.onlyPlatform, true)
    assert.deepEqual(r.tried, [], `${pseudo} 应被过滤掉，不拿去找 roster`)
  }
})

test('G4 有非平台 id 但 roster 里没有：onlyPlatform=false（提示可能是退役/外部会话）', () => {
  const { exports } = loadClient()
  const r = exports.resolveOwnerBot({
    task: { id: 't-2', ownerId: 'bot-gone' },
    ownerId: 'bot-gone',
    bots: BOTS,
  })
  assert.equal(r.bot, null)
  assert.equal(r.onlyPlatform, false)
  assert.deepEqual(r.tried, ['bot-gone'])
})

test('G5 候选去重 + 空值过滤：不重复尝试同一个 id', () => {
  const { exports } = loadClient()
  const r = exports.resolveOwnerBot({
    task: { id: 't-3', ownerId: 'bot-a', assignee: 'bot-a' },
    ownerId: 'bot-a',
    bots: BOTS,
  })
  assert.deepEqual(r.candidates, ['bot-a'], '同一个 id 不应出现两次')
})

test('G6 没有任何负责人字段：candidates 为空（调用方据此提示「先派活」）', () => {
  const { exports } = loadClient()
  const r = exports.resolveOwnerBot({ task: { id: 't-4' }, ownerId: null, bots: BOTS })
  assert.deepEqual(r.candidates, [])
  assert.equal(r.bot, null)
  assert.equal(r.onlyPlatform, true)
})

test('G7 roster 未加载（bots 非数组）时不得抛错', () => {
  const { exports } = loadClient()
  for (const bots of [undefined, null, 'x', {}]) {
    const r = exports.resolveOwnerBot({ task: { id: 't-5', ownerId: 'bot-a' }, ownerId: 'bot-a', bots })
    assert.equal(r.bot, null, `bots=${String(bots)} 时应安全返回 null`)
  }
})

test('G8 源码层面：gotoOwner 必须走 resolveOwnerBot（防有人改回只看 ownerId）', () => {
  const start = SOURCE.indexOf('const gotoOwner = async () => {')
  assert.ok(start > 0, '必须存在 gotoOwner')
  const body = SOURCE.slice(start, start + 400)
  assert.ok(body.includes('resolveOwnerBot('), 'gotoOwner 必须调用 resolveOwnerBot（不能只看 ownerId）')
  assert.match(SOURCE, /PLATFORM_OWNER_IDS\s*=\s*\[[^\]]*'ui'/, '必须定义平台伪身份名单')
})
