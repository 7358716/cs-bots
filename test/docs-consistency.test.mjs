/**
 * 文档一致性校验 —— 让「文档随代码自动校验」（bots04 欠账3）。
 *
 * ## 为什么要有这个文件
 *
 * 实测：4 份文档写 `v0.7.3`（实际 0.8.0）、5 处写「1108 项测试」（实际 1263）。
 * 这些数字**没有任何机制兜底** —— 代码改了、文档不动，且**没人会收到告警**。
 * 读文档的人据此做决策，就是在读过期情报。
 *
 * ## 为什么做成测试而不是脚本
 *
 * 项目已有「测试即 CI 闸」的纪律（`test/ci-zero-dep.sh` 同样思路）。
 * 做成 `*.test.mjs` 会随 `bash test/run-all.sh` 自动跑，
 * 不会像独立脚本那样「忘了调用」而形同虚设。
 *
 * ## 校验什么
 *
 *   ① `package.json` 的 version 必须出现在「主文档」的版本声明里
 *   ② 文档里写的「NNN 项测试」必须等于实测套件规模
 *   ③ 文档里写的工具数必须等于 `TOOL_NAMES.length`
 *
 * ## 刻意不做的事
 *
 *   - **不改历史叙述**：`docs/01-架构文档.md` 里「0.7.3 已部署重启」是当时的事实记录，
 *     不该被改写成 0.8.0（那就是伪造历史）。所以只校验**版本声明行**，不全文 grep。
 *   - **不校验 CHANGELOG**：它本来就按版本分段记录历史，全文出现旧版本号是正常的。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 主文档：这些文件**声称描述当前状态**，所以必须与代码一致。 */
const CURRENT_DOCS = [
  'docs/01-架构文档.md',
  'docs/02-需求规格书.md',
  'docs/03-详细设计.md',
  'docs/04-操作手册.md',
]

/** 历史快照：文首已标注「勿引用 / 已过期」，刻意不校验。 */
const FROZEN_DOCS = [
  'docs/ARCHITECTURE.md', // v0.6 历史快照，文首写「勿引用」
]

function readDoc(rel) {
  const p = join(ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

test('文档一致性 ①：主文档的版本声明必须等于 package.json version', () => {
  const version = PKG.version
  assert.match(version, /^\d+\.\d+\.\d+$/, `package.json version 形状异常：${version}`)

  const problems = []
  for (const rel of CURRENT_DOCS) {
    const text = readDoc(rel)
    if (text === null) continue // 文件不存在不算失真（可能尚未创建）
    // 只认「版本声明」这种行：> 版本：vX.Y.Z 或 「当前实测（日期，vX.Y.Z）」
    const declared = [...text.matchAll(/^>\s*版本[：:]\s*v?(\d+\.\d+\.\d+)/gm)].map((m) => m[1])
    for (const v of declared) {
      if (v !== version) problems.push(`${rel} 声明 v${v}，实际 ${version}`)
    }
  }
  assert.deepEqual(problems, [], `文档版本声明与 package.json 不一致：\n${problems.join('\n')}`)
})

test('文档一致性 ②：文档里的「NNN 项测试」不得低于已知最低基线', () => {
  // ⚠️ 为什么用「下限」而不是「精确相等」：
  //    测试数会随开发增长，而文档不总是同步更新。用精确相等会让这条测试
  //    每加一个用例就红一次，最后被人 disable —— 那比没有还糟。
  //    用下限能抓住「文档写着旧数（1108）而实际已 1263」这类真失真，
  //    又不会因为新增 1 个用例就误报。
  //    下限取「本次改造开始时的规模」，只增不减。
  const FLOOR = 1263

  const problems = []
  for (const rel of CURRENT_DOCS) {
    const text = readDoc(rel)
    if (text === null) continue
    for (const m of text.matchAll(/(\d{3,5})\s*(?:项测试|\/\s*\d{3,5}\s*pass)/g)) {
      const n = Number(m[1])
      // 只校验「像当前规模」的数字（>=1000），避免误伤历史里程碑数字
      if (n >= 1000 && n < FLOOR) {
        problems.push(`${rel} 写 ${n} 项测试，低于当前基线 ${FLOOR}`)
      }
    }
  }
  assert.deepEqual(problems, [], `文档测试数与实测脱节：\n${problems.join('\n')}`)
})

test('文档一致性 ③：文档里的工具数必须等于 TOOL_NAMES.length', async () => {
  const { TOOL_NAMES } = await import('../src/tools.js')
  const actual = TOOL_NAMES.length

  const problems = []
  for (const rel of CURRENT_DOCS) {
    const text = readDoc(rel)
    if (text === null) continue
    // 只匹配「N 个 bot_* 工具」这种明确描述当前工具数的句子
    for (const m of text.matchAll(/(\d{2,3})\s*个\s*`?bot_\*`?\s*工具/g)) {
      const n = Number(m[1])
      if (n !== actual) problems.push(`${rel} 写 ${n} 个工具，实际 ${actual}`)
    }
  }
  assert.deepEqual(problems, [], `文档工具数与代码不一致：\n${problems.join('\n')}`)
})

test('文档一致性 ④：历史快照必须仍然带「勿引用 / 已过期」标记（防止有人当成现状）', () => {
  for (const rel of FROZEN_DOCS) {
    const text = readDoc(rel)
    if (text === null) continue
    const head = text.slice(0, 800)
    assert.match(
      head,
      /勿引用|已过期|历史快照/,
      `${rel} 是历史快照，文首必须保留「勿引用 / 已过期 / 历史快照」标记，否则读者会当成现状`,
    )
  }
})

test('文档一致性 ⑤：reports/ 下的方案报告必须存在（交付物不丢）', () => {
  const reports = readdirSync(join(ROOT, '..', 'reports'))
  const required = [
    'bots04-大团队语义与调度方案-20261111.md',
    'bots04-大团队完整设计与使用说明-20261111.md',
  ]
  for (const name of required) {
    assert.ok(reports.includes(name), `缺少交付报告：reports/${name}`)
  }
})