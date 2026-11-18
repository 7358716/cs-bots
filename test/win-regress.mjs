#!/usr/bin/env node
/**
 * win-regress.mjs —— 双平台回归脚本（0.20.0）
 *
 * ## 为什么需要它
 *
 *   2026-11-18 Boss 的四个故障全部在 **Windows 桌面版**上出现，而 CI 只跑 Linux。
 *   「我这边好使」不能作为验收依据。这个脚本在**目标机器本机**跑，
 *   把「平台相关的那几件事」全部实测一遍，输出可粘贴的结果。
 *
 * ## 怎么用
 *
 *   node test/win-regress.mjs
 *
 *   在 Windows 上：`node test\win-regress.mjs`
 *   预期输出每条 `PASS` / `FAIL`，最后一行为 `RESULT: PASS (n/n)`。
 *
 * ## 为什么不用测试框架
 *
 *   目标机器上可能没装 node:test 需要的环境（也可能被企业策略限制），
 *   而「让人复制一段输出回来」是最低成本的证据。脚本只用 node 内置。
 *
 * ## 它验证什么（对应 Boss 的四个故障）
 *
 *   1. 路径显示：给人看的路径按本机分隔符输出（图 2 红圈）
 *   2. 路径比较：盘符大小写/分隔符混写视为同一目录（图 3 空文件夹的诱因）
 *   3. 目录名：汉字放行、Win 保留名拦截、结尾点拦截（Boss 第 1 条）
 *   4. 三级目录：主目录 / 部门 / Bot 真的建出来（三级要求）
 *   5. 导入落地：Bot 真的被创建，cwd 由本机主目录重算（图 3「没带入」）
 *   6. 导入文案：跨平台警告按本机分隔符显示（图 2）
 */

import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  displayPath, pathsEqual, isInside, safeSegment, checkSegment, normPath,
} from '../src/paths-cross.js'
import { ensureBotHierarchy, planBotCwd } from '../src/ws-hierarchy.js'
import { buildExport, applyImport, inspectPackage } from '../src/transfer.js'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`) }
  else {
    fail += 1
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`FAIL  ${name}${detail ? `  ← ${detail}` : ''}`)
  }
}

console.log(`平台：${process.platform} ${process.arch}  分隔符：${JSON.stringify(sep)}`)
console.log(`node：${process.version}`)
console.log('')

// ── 1. 路径显示 ─────────────────────────────────────────────────────────────
{
  const winish = 'C:/Users/Song/.dsh/cs-bots/测试部门1/管家'
  const shown = displayPath(winish)
  if (process.platform === 'win32') {
    ok('路径显示：Win 上无残留正斜杠', !shown.includes('/'), shown)
    ok('路径显示：Win 上用反斜杠', shown.includes('\\'), shown)
  } else {
    ok('路径显示：非 Win 上无反斜杠', !shown.includes('\\'), shown)
  }
  ok('路径显示：中文段原样保留', shown.includes('测试部门1'), shown)
}

// ── 2. 路径比较 ─────────────────────────────────────────────────────────────
{
  const a = process.platform === 'win32' ? 'C:\\Users\\Song\\cs-bots' : '/Users/Song/cs-bots'
  const b = process.platform === 'win32' ? 'c:/users/song/cs-bots/dev/x' : '/Users/Song/cs-bots/dev/x'
  ok('路径比较：分隔符混写仍判定为子孙', isInside(a, b), `${a} ⊃? ${b}`)
  ok('路径比较：自己不算自己的子孙', !isInside(a, a))
  ok('路径比较：同名前缀不同目录不算子孙', !isInside('/a/b', '/a/bc'))
  const eq = pathsEqual(process.platform === 'win32' ? 'C:\\X\\Y' : '/X/Y', process.platform === 'win32' ? 'c:/x/y' : '/X/Y/')
  ok('路径比较：尾斜杠/大小写差异视为同一目录', eq)
  ok('路径比较：空值不相等', !pathsEqual('', ''))
  ok('normPath：空串不等于 .', normPath('') !== '.')
}

// ── 3. 目录名 ───────────────────────────────────────────────────────────────
{
  ok('目录名：汉字放行', safeSegment('测试部门1') === '测试部门1', safeSegment('测试部门1'))
  ok('目录名：Windows 保留名被改写', !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safeSegment('CON')), safeSegment('CON'))
  ok('目录名：结尾点被去掉', safeSegment('abc.') === 'abc', safeSegment('abc.'))
  ok('目录名：路径分隔符被去掉', !/[/\\]/.test(safeSegment('a/b\\c')), safeSegment('a/b\\c'))
  ok('目录名：NFC 归一（macOS NFD 兼容）', safeSegment('e\u0301') === safeSegment('\u00e9'))
  ok('目录名判定：尾随空格被拒', checkSegment('abc ').ok === false)
  ok('目录名判定：非法字符给可执行提示', /Windows 非法字符/.test(checkSegment('a:b').hint ?? ''))
  const p = planBotCwd({ root: process.platform === 'win32' ? 'C:\\cs-bots' : '/cs-bots', deptId: '测试部门1', botName: '管家' })
  ok('目录派生：汉字部门 + Bot 名可算出路径', p.ok, p.reason)
}

// ── 4. 三级目录 + 5. 导入落地 + 6. 文案 ────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), 'cs-bots-winreg-'))
try {
  // 4. 三级独立验（不走导入）
  {
    const root = join(base, 'hier')
    const created = []
    const map = new Map()
    const ctx = {
      get: (k) => (k === 'workspaceRegistry'
        ? {
            async resolveByPath(x) { return map.get(x) },
            async create(x) {
              created.push(x)
              const ws = { path: x, attachSession() {} }
              map.set(x, ws)
              return { workspace: ws, created: true }
            },
          }
        : undefined),
    }
    const r = await ensureBotHierarchy(ctx, {
      root, deptId: '测试部门1', deptName: '测试部门1', botCwd: join(root, '测试部门1', '管家'), botName: '管家',
    })
    ok('三级：三步都 OK', r.steps.length === 3 && r.steps.every((s) => s.ok), JSON.stringify(r.steps.map((s) => `${s.level}:${s.ok}`)))
    ok('三级：主目录真实存在', existsSync(root))
    ok('三级：部门目录真实存在', existsSync(join(root, '测试部门1')))
    ok('三级：Bot 目录真实存在', existsSync(join(root, '测试部门1', '管家')))
    ok('三级：三次分组登记（root/dept/bot）', created.length === 3, JSON.stringify(created.map(displayPath)))
  }

  // 5+6. 导入：源机 Linux → 本机
  {
    const srcBase = join(base, 'src')
    const srcState = join(srcBase, 'state')
    const srcRoot = join(srcBase, 'src-cs-bots')
    mkdirSync(srcState, { recursive: true })
    const depts = [{ id: '测试部门1', name: '测试部门1' }]
    mkdirSync(join(srcRoot, '测试部门1', '乙'), { recursive: true })
    writeFileSync(join(srcState, 'settings.json'), JSON.stringify({ botWorkspaceRoot: srcRoot, departments: depts }), 'utf8')
    const srcBots = [{ id: 'b1', name: '乙', cwd: join(srcRoot, '测试部门1', '乙'), preset: '', state: 'idle', profile: { identity: '我是乙' } }]
    const pkg = buildExport({
      stateDir: srcState,
      services: { settings: { botWorkspaceRoot: srcRoot, departments: depts }, roster: { list: () => srcBots } },
      sections: ['departments', 'bots'], includeFiles: false,
    }).buffer

    // 目标机
    const tgtState = join(base, 'tgt-state')
    const tgtRoot = join(base, 'tgt-cs-bots')
    mkdirSync(tgtState, { recursive: true })
    writeFileSync(join(tgtState, 'settings.json'), JSON.stringify({ botWorkspaceRoot: tgtRoot, departments: depts }), 'utf8')
    const tb = []
    const ctx = {
      get: (k) => (k === 'workspaceRegistry'
        ? { async resolveByPath() { return undefined }, async create(x) { return { workspace: { path: x }, created: true } } }
        : undefined),
    }
    const services = {
      settings: { botWorkspaceRoot: tgtRoot, departments: depts },
      roster: {
        list: () => tb,
        async create(input) {
          const cwd = join(tgtRoot, String(input.department), String(input.name))
          mkdirSync(cwd, { recursive: true })
          const bot = { id: `nb-${tb.length + 1}`, name: input.name, cwd, state: 'idle', rev: 1, profile: {} }
          tb.push(bot)
          return bot
        },
        async setProfile() { return null },
      },
    }

    // 6. 校核文案
    const rep = inspectPackage(pkg, services)
    const warn = (rep.warnings ?? []).find((w) => w.includes('导入后会改到'))
    ok('导入文案：有「导入后会改到」提示', Boolean(warn), JSON.stringify(rep.warnings))
    if (warn) {
      if (process.platform === 'win32') {
        ok('导入文案：Win 上示例路径无反斜杠混正斜杠', !/[A-Za-z]:[^]*\/</.test(warn), warn)
      } else {
        ok('导入文案：非 Win 上无反斜杠', !warn.includes('\\'), warn)
      }
    }
    ok('导入文案：本机落点已给出', Boolean(rep.info?.localRoot), JSON.stringify(rep.info?.localRoot))

    // 5. 落地
    const r = await applyImport(pkg, { stateDir: tgtState, services, ctx })
    ok('导入落地：没有错误', r.ok, JSON.stringify(r.errors))
    ok('导入落地：新增 1 个 Bot', r.applied?.bots?.added === 1, JSON.stringify(r.applied?.bots))
    ok('导入落地：registry 里真的多了', tb.length === 1, `registry=${tb.length}`)
    const bot = tb[0]
    ok('导入落地：cwd 在本机主目录下', bot ? bot.cwd.startsWith(tgtRoot) : false, bot?.cwd)
    ok('导入落地：Bot 目录真实存在', bot ? existsSync(bot.cwd) : false, bot?.cwd)
    ok('导入落地：档案带入', (r.applied?.bots?.failed ?? 1) === 0)
  }
} finally {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* */ }
}

console.log('')
if (fail === 0) {
  console.log(`RESULT: PASS (${pass}/${pass})`)
  process.exit(0)
}
console.log(`RESULT: FAIL (${pass} pass, ${fail} fail)`)
for (const f of failures) console.log(`  · ${f}`)
process.exit(1)