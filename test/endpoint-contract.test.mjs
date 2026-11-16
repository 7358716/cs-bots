/**
 * 前后端端点契约测试（2026-11-16 Boss 定纪律后新增）。
 *
 * ## 为什么需要它
 *   我连续两次凭印象写端点：
 *     · 前端调 `GET /rooms/read` —— 实际是 `/rooms/messages` ⇒ 部门群聊直接报「未知端点」
 *     · 前端调 `POST /roster/set-cwd` —— 实际是 `/roster/manage` + `action:'setCwd'`
 *   还有一次更严重：**部门端点被我的编辑误删**，前端还在调 ⇒ 又是「未知端点」。
 *
 *   这些都是纯静态可查的，不该靠运行时才发现。
 *
 * ## 检查什么
 *   把 `client.js` 里所有 `call('/xxx')` 提取出来，逐个断言 `api.js` 里有对应
 *   `path === '/xxx'`。反之亦然（后端有但前端没调的不管，那是预留）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')
const API = readFileSync(join(HERE, '..', 'src', 'api.js'), 'utf8')

/** 前端所有字面量端（模板字符串拼的不算，那种要单独测）。 */
function frontendEndpoints() {
  const out = new Set()
  const re = /\bcall\(\s*['"`]\/([a-z0-9/_-]+)['"`]/gi
  let m
  while ((m = re.exec(CLIENT)) !== null) out.add('/' + m[1])
  return out
}

/** 后端所有端点。 */
function backendEndpoints() {
  const out = new Set()
  const re = /path === '(\/[a-z0-9/_-]+)'/gi
  let m
  while ((m = re.exec(API)) !== null) out.add(m[1])
  return out
}

const FRONT = frontendEndpoints()
const BACK = backendEndpoints()

test('端点契约：前端调用的每个端点，后端都必须存在', () => {
  assert.ok(FRONT.size > 20, `前端端点数量异常（${FRONT.size}），可能正则失效`)
  const missing = [...FRONT].filter((p) => !BACK.has(p)).sort()
  assert.deepEqual(
    missing,
    [],
    `以下端点前端在调、后端不存在（会运行时报「未知端点」）：\n  ${missing.join('\n  ')}`,
  )
})

test('端点契约：★ 部门相关端点必须齐全（曾被误删导致整页报错）', () => {
  for (const p of ['/departments/tree', '/departments/ensure', '/departments/save']) {
    assert.ok(BACK.has(p), `${p} 必须在 api.js 里注册（前端在用）`)
  }
})

test('端点契约：房间相关端点用正确名字（/rooms/messages 不是 /rooms/read）', () => {
  assert.ok(BACK.has('/rooms/messages'), '实际的读消息端点是 /rooms/messages')
  assert.ok(!CLIENT.includes("call('/rooms/read"), '不该再调 /rooms/read（它不存在）')
})

test('端点契约：改工作目录走 /roster/manage + action，没有 /roster/set-cwd', () => {
  assert.ok(BACK.has('/roster/manage'), '/roster/manage 是实际端点')
  assert.ok(!CLIENT.includes("call('/roster/set-cwd"), '不该再调 /roster/set-cwd（它不存在）')
  assert.match(CLIENT, /action: 'setCwd'/, '应通过 action:setCwd 改目录')
})
