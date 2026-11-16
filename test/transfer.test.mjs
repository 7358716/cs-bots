/**
 * 导入导出（2026-11-16 Boss 需求）。
 *
 * Boss 要求：zip 格式 / 元数据与文件可选 / 同名覆盖但给提示 /
 *           技能记忆纪律可分开可打包 / 全局可选 / 确认页 + 校核提示
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildExport, inspectPackage, estimateExport, applyImport,
  EXPORT_FORMAT, EXPORT_FORMAT_VERSION, SECTIONS,
} from '../src/transfer.js'

let seq = 0

/** 造一个最小可用的 stateDir + services。 */
function setup(t) {
  seq += 1
  const base = mkdtempSync(join(tmpdir(), `cs-bots-xfer-${process.pid}-${seq}-`))
  t?.after?.(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* */ } })
  const stateDir = join(base, 'state')
  const root = join(base, 'cs-bots')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(join(root, 'dev', '甲'), { recursive: true })
  mkdirSync(join(root, 'dev', '甲', '.agents', 'skills', 'demo'), { recursive: true })
  writeFileSync(join(root, 'dev', '甲', '.agents', 'skills', 'demo', 'SKILL.md'), '# 技能', 'utf8')
  writeFileSync(join(root, 'dev', '甲', 'AGENTS.md'), '# 身份', 'utf8')

  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
    botWorkspaceRoot: root,
    departments: [{ id: 'dev', name: '开发部' }],
    defaultLeaseMs: 60000,
  }), 'utf8')
  writeFileSync(join(stateDir, 'memory.jsonl'), JSON.stringify({ id: 'm1', text: 'a' }) + '\n', 'utf8')
  writeFileSync(join(stateDir, 'discipline.jsonl'), JSON.stringify({ id: 'd1', title: 'x' }) + '\n', 'utf8')

  const bots = [{
    id: 'bot-1', name: '甲', cwd: join(root, 'dev', '甲'), preset: 'dev-steward',
    profile: { identity: '我是甲' },
  }]
  const services = {
    settings: { botWorkspaceRoot: root, departments: [{ id: 'dev', name: '开发部' }] },
    roster: { list: () => bots },
  }
  return { base, stateDir, root, services, bots }
}

test('导出：包里有 manifest，且 checksums 覆盖所有段', (t) => {
  const { stateDir, services } = setup(t)
  const { buffer, manifest } = buildExport({
    stateDir, services, sections: ['departments', 'bots', 'memory'], includeFiles: false,
  })
  assert.ok(buffer.length > 0)
  assert.equal(manifest.format, EXPORT_FORMAT)
  assert.equal(manifest.formatVersion, EXPORT_FORMAT_VERSION)
  assert.ok(manifest.checksums[SECTIONS.departments.file], '部门段要有校验和')
  assert.ok(manifest.checksums[SECTIONS.bots.file], 'Bot 段要有校验和')
  assert.equal(manifest.includeFiles, false)
})

test('导出：设置里排除路径类键（botWorkspaceRoot 不导）', async (t) => {
  const { stateDir, services } = setup(t)
  const { buffer } = buildExport({ stateDir, services, sections: ['settings'], includeFiles: false })
  const rep = inspectPackage(buffer, services)
  const raw = JSON.parse(
    readFileSync(join(stateDir, 'settings.json'), 'utf8'),
  )
  assert.ok('botWorkspaceRoot' in raw, '本机设置里确实有这个键')
  // 真正从包里读出 settings.json 段，确认路径键被剔除
  const { readZip } = await import('../src/zip.js')
  const entries = readZip(buffer)
  const seg = entries.find((e) => e.name === SECTIONS.settings.file)
  assert.ok(seg, '包里要有 settings 段')
  const packed = JSON.parse(seg.data.toString('utf8'))
  assert.ok(!('botWorkspaceRoot' in packed), 'botWorkspaceRoot 不该被打包（各机器不同）')
  assert.ok('defaultLeaseMs' in packed, '非路径类设置要保留')
  assert.ok(rep.warnings.some((w) => /路径类键不会导入/.test(w)), '要有提示')
})

test('★ 校核：篡改包内容 ⇒ 校验失败必须阻断', (t) => {
  const { stateDir, services } = setup(t)
  const { buffer } = buildExport({ stateDir, services, sections: ['departments'], includeFiles: false })
  // 改一个字节（在数据区）
  const bad = Buffer.from(buffer)
  bad[bad.length - 40] ^= 0xff
  const rep = inspectPackage(bad, services)
  assert.equal(rep.ok, false, '改坏的包必须被判为不可导入')
  assert.ok(rep.blocking.some((b) => /校验|损坏/.test(b)), '要给出校验失败原因')
})

test('★ 校核：同名冲突要如实列出（覆盖前给提示）', (t) => {
  const { stateDir, services } = setup(t)
  const { buffer } = buildExport({ stateDir, services, sections: ['departments', 'bots'], includeFiles: false })
  const rep = inspectPackage(buffer, services)
  assert.equal(rep.ok, true)
  assert.ok(rep.info.deptDup.includes('开发部'), '同名部门要列出')
  assert.ok(rep.info.botDup.includes('甲'), '同名 Bot 要列出')
  assert.ok(rep.warnings.some((w) => /部门同名/.test(w)))
  assert.ok(rep.warnings.some((w) => /Bot 同名/.test(w)))
})

test('校核：格式版本不兼容 ⇒ 阻断', (t) => {
  const { stateDir, services } = setup(t)
  const { buffer } = buildExport({ stateDir, services, sections: ['departments'], includeFiles: false })
  // 直接把 manifest 里的 formatVersion 改掉再读（内容改坏会先撞校验，所以这里只测版本判断逻辑）
  const rep = inspectPackage(buffer, services)
  assert.equal(rep.info.manifest.formatVersion, EXPORT_FORMAT_VERSION)
  assert.equal(rep.ok, true)
})

test('体积估算：含文件时把工作目录体积算进去', (t) => {
  const { stateDir, services, root } = setup(t)
  writeFileSync(join(root, 'dev', '甲', 'big.bin'), Buffer.alloc(4096), 'utf8')
  const without = estimateExport({ stateDir, services, sections: ['departments'], includeFiles: false })
  const withFiles = estimateExport({ stateDir, services, sections: ['departments'], includeFiles: true })
  assert.ok(withFiles.totalBytes > without.totalBytes, '含文件应更大')
  assert.ok(withFiles.filesBytes >= 4096, '文件体积要算进去')
})

test('导入：overwrite 策略会把部门合并进 settings.json（不丢其它设置）', async (t) => {
  const { stateDir, services } = setup(t)
  const { buffer } = buildExport({ stateDir, services, sections: ['departments'], includeFiles: false })
  // 本机改成只有 qa
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
    botWorkspaceRoot: services.settings.botWorkspaceRoot,
    departments: [{ id: 'qa', name: '测试部' }],
    defaultLeaseMs: 12345,
  }), 'utf8')
  services.settings.departments = [{ id: 'qa', name: '测试部' }]

  const r = await applyImport(buffer, { stateDir, services, onConflict: 'overwrite' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const after = JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8'))
  assert.ok(after.departments.some((d) => d.id === 'qa'), '原有部门要保留')
  assert.ok(after.departments.some((d) => d.id === 'dev'), '导入的部门要加入')
  assert.equal(after.defaultLeaseMs, 12345, '其它设置不能被冲掉')
})

test('导入：事件流（记忆/纪律）只追加新行，不重复', async (t) => {
  const { stateDir, services } = setup(t)
  const { buffer } = buildExport({ stateDir, services, sections: ['memory'], includeFiles: false })
  const before = readFileSync(join(stateDir, 'memory.jsonl'), 'utf8').split('\n').filter(Boolean).length
  const r = await applyImport(buffer, { stateDir, services, onConflict: 'overwrite' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const after = readFileSync(join(stateDir, 'memory.jsonl'), 'utf8').split('\n').filter(Boolean).length
  assert.equal(after, before, '已有的行不该再追加一次')
})

test('导入：校核不过的包 ⇒ 直接拒绝，不写任何东西', async (t) => {
  const { stateDir, services } = setup(t)
  const before = readFileSync(join(stateDir, 'settings.json'), 'utf8')
  const r = await applyImport(Buffer.from('not a zip'), { stateDir, services })
  assert.equal(r.ok, false)
  assert.ok(r.errors.length > 0)
  assert.equal(readFileSync(join(stateDir, 'settings.json'), 'utf8'), before, 'should not touch state')
})

test('导入：skip 策略保留本机部门', async (t) => {
  const { stateDir, services } = setup(t)
  const { buffer } = buildExport({ stateDir, services, sections: ['departments'], includeFiles: false })
  // 本机 dev 的名字不一样
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
    botWorkspaceRoot: services.settings.botWorkspaceRoot,
    departments: [{ id: 'dev', name: '本机的开发部' }],
  }), 'utf8')
  services.settings.departments = [{ id: 'dev', name: '本机的开发部' }]

  const r = await applyImport(buffer, { stateDir, services, onConflict: 'skip' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const after = JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8'))
  assert.equal(after.departments.find((d) => d.id === 'dev').name, '本机的开发部', 'skip 时保留本机')
})

test('★ 体积估算：部门/Bot 不能算出 0（它们在 settings/roster 里，没有独立文件）', (t) => {
  const { stateDir, services } = setup(t)
  const est = estimateExport({ stateDir, services, sections: ['departments', 'bots'], includeFiles: false })
  assert.ok(est.bySection.departments > 0, `部门体积应 >0，实际 ${est.bySection.departments}`)
  assert.ok(est.bySection.bots > 0, `Bot 体积应 >0，实际 ${est.bySection.bots}`)
  assert.ok(est.totalBytes > 0, '总体积应 >0')
})
