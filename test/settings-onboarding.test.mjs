/**
 * 首次引导标记（2026-11-15 Boss 要求）。
 *
 * 「首次进入 cs-bots 协作管理页面提示选定工作区，选择完成后再进行下一步工作，
 *   默认 C:\Users\你\.dsh 的下级，目录名称也是 cs-bots」
 *
 * ## 判据为什么不能看默认值
 *   `botWorkspaceRoot` **永远有默认值**（非空），所以「值是否为空」判断不出
 *   「用户选过没有」。必须看**设置文件里有没有写这个键**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSettings, defaultBotWorkspaceRoot } from '../src/settings.js'

function withDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bots-onboard-'))
  t?.after?.(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })
  return dir
}

test('引导：没有设置文件 ⇒ needsOnboarding=true，并给出默认值', (t) => {
  const dir = withDir(t)
  mkdirSync(dir, { recursive: true })
  const { diagnostics } = loadSettings(dir)
  assert.equal(diagnostics.needsOnboarding, true, '从没配过，应要求引导')
  assert.equal(diagnostics.defaultRoot, defaultBotWorkspaceRoot())
})

test('引导：设置文件存在但**没写 botWorkspaceRoot** ⇒ 仍算未引导', (t) => {
  const dir = withDir(t)
  mkdirSync(dir, { recursive: true })
  // 用户改过别的设置，但没动主目录 —— 这种情况也必须引导
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultLeaseMs: 60000 }), 'utf8')
  const { diagnostics, values } = loadSettings(dir)
  assert.equal(diagnostics.needsOnboarding, true, '没写过 botWorkspaceRoot 就该引导')
  assert.equal(values.botWorkspaceRoot, defaultBotWorkspaceRoot(), '值仍取默认')
})

test('引导：设置文件里**写了** botWorkspaceRoot ⇒ needsOnboarding=false', (t) => {
  const dir = withDir(t)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ botWorkspaceRoot: '/opt/mine' }), 'utf8')
  const { diagnostics, values } = loadSettings(dir)
  assert.equal(diagnostics.needsOnboarding, false, '已显式选过，不该再拦')
  assert.equal(values.botWorkspaceRoot, '/opt/mine')
})

test('引导：写在 .dsh 下级也认（Boss 定的默认位置）', (t) => {
  const dir = withDir(t)
  mkdirSync(dir, { recursive: true })
  const inDsh = join(defaultBotWorkspaceRoot())
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ botWorkspaceRoot: inDsh }), 'utf8')
  const { diagnostics, values } = loadSettings(dir)
  assert.equal(diagnostics.needsOnboarding, false)
  assert.equal(values.botWorkspaceRoot, inDsh)
})

test('默认主目录：是 $DSH_HOME 的下级 cs-bots（不再用同级）', () => {
  const h = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/fake-dsh'
    assert.equal(defaultBotWorkspaceRoot(), '/tmp/fake-dsh/cs-bots')
  } finally {
    if (h === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = h
  }
})
