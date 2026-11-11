// 契约 升级09 第2批 前端测试
// 前端改动：跨团队协作请求 + 唤醒计数展示
// 作者：frontend-a

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(__dirname, '../src/client.js')

const src = readFileSync(SRC, 'utf8')

const tests = [
  // ① 跨团队协作请求：按钮存在
  {
    name: 'T4-① 团队卡片有「发协作请求」按钮',
    run: () => {
      assert.match(src, /发协作请求/)
    },
  },
  // ① Modal 标题
  {
    name: 'T4-① 弹窗标题正确',
    run: () => {
      assert.match(src, /发协作请求给另一个团队/)
    },
  },
  // ① POST /teams/route
  {
    name: 'T4-① 调用 /teams/route 端点',
    run: () => {
      assert.match(src, /act\('\/teams\/route'/)
    },
  },
  // ① 携带 fromTeam / toTeam
  {
    name: 'T4-① 请求体带 fromTeam 和 toTeam',
    run: () => {
      assert.match(src, /fromTeam:/)
      assert.match(src, /toTeam:/)
    },
  },
  // ① 成功提示文案
  {
    name: 'T4-① 成功文案包含「已送达」',
    run: () => {
      assert.match(src, /已送达.*负责人/)
      assert.match(src, /唤醒 1 次/)
    },
  },
  // ① 排除自己（目标下拉不包含当前团队）
  {
    name: 'T4-① 目标团队选择排除自己',
    run: () => {
      assert.match(src, /x\.id !== routeOpen/)
    },
  },
  // ① 排除已关闭团队
  {
    name: 'T4-① 目标团队选择排除已关闭',
    run: () => {
      assert.match(src, /x\.status !== 'closed'/)
    },
  },
  // ① ROUTE_HOP_EXCEEDED 错误映射
  {
    name: 'T4-① ROUTE_HOP_EXCEEDED 映射「跳数超限」',
    run: () => {
      assert.match(src, /ROUTE_HOP_EXCEEDED:/)
      assert.match(src, /跳数超限/)
    },
  },
  // ① 失败结果展示 reason
  {
    name: 'T4-① 失败时展示 humanizeError 结果',
    run: () => {
      assert.match(src, /humanizeError\(/)
    },
  },
  // ③ 今日唤醒计数展示
  {
    name: 'T4-③ 团队卡片显示「今日唤醒 N 次」',
    run: () => {
      assert.match(src, /今日唤醒 \$\{t\.wakeCountToday\} 次/)
    },
  },
  // ③ wakeCountToday 可选（不展示时为 undefined）
  {
    name: 'T4-③ wakeCountToday 为 undefined 时不展示',
    run: () => {
      assert.match(src, /t\.wakeCountToday !== undefined/)
    },
  },
]

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

describe('契约 升级09 第2批 前端测试', () => {
  for (const t of tests) {
    test(t.name, t.run)
  }
})
