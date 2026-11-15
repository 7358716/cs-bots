/**
 * 跨平台主目录推导（2026-11-15 Boss 报「Win 版没有左侧栏 CS-BOTS」）。
 *
 * ## 根因候选（已修）
 *   `defaultBotWorkspaceRoot` 原来用 `process.env.HOME` 找 DSH_HOME。
 *   **Windows 没有 HOME**（用 USERPROFILE）⇒ 退化成 `'.'`
 *   ⇒ `resolve('.', '.dsh')` = 当前工作目录下的 .dsh
 *   ⇒ 默认主目录跟着启动目录乱跑 ⇒ 左侧栏分组登记到不确定的位置。
 *
 * 本测试在**子进程**里改环境变量（不能污染本进程，否则其他测试的默认值会变）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'settings.js')

/** 在干净环境里跑一次 defaultBotWorkspaceRoot，返回结果。 */
function computeWith(env) {
  const code = `import('${SRC.replace(/\\/g, '/')}').then(m => process.stdout.write(m.defaultBotWorkspaceRoot()))`
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  }).trim()
}

test('默认主目录：DSH_HOME 显式设置时取它的**下级** cs-bots（2026-11-15 Boss 定）', () => {
  const out = computeWith({ DSH_HOME: '/opt/mydsh' })
  assert.equal(out, '/opt/mydsh/cs-bots', '不再用同级目录，改为 .dsh 的下级')
})

test('★ Windows：没有 HOME 但有 USERPROFILE 时，不能退化成 "."', () => {
  const out = computeWith({ USERPROFILE: '/fake/winhome' })
  assert.ok(
    out.startsWith('/fake/winhome/') || out.includes('winhome'),
    `应基于 USERPROFILE 推导，实际得到 ${out} —— 退化成 "." 会导致主目录跟着启动目录乱跑`,
  )
  assert.ok(!/^\/cs-bots$/.test(out), '绝不能算成根下的 /cs-bots（那就是 "." 退化的结果）')
})

test('Linux/macOS：有 HOME 时取 .dsh 的下级', () => {
  const out = computeWith({ HOME: '/home/alice' })
  assert.equal(out, '/home/alice/.dsh/cs-bots', '.dsh 的下级，名字仍叫 cs-bots')
})

test('DSH_HOME 优先级最高（即使同时有 USERPROFILE/HOME）', () => {
  const out = computeWith({ DSH_HOME: '/explicit/dsh', USERPROFILE: '/fake/win', HOME: '/home/alice' })
  assert.equal(out, '/explicit/dsh/cs-bots')
})
