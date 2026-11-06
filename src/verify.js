/**
 * cs-bots VerifyService —— PDCA 检查面的证据自动化。
 *
 * 为什么需要它：`board.complete` 只要求 `artifacts` 非空，**没人检查产出是否真实**。
 * 「我完成了」不能当验收依据 —— 本模块让验收带上**机器证据**（文件存在 / 命令退出码 /
 * 测试套件结果），人点采纳时看到的是有出处的结果，而不是一句声明。
 *
 * 安全约束（本模块最重要的性质）：
 *   - **命令白名单**：`kind:'command'` 只允许固定命令名（bash/node/npm/pnpm/npx/git/ls/test/python3），
 *     不在白名单一律抛 `VERIFY_CMD_NOT_ALLOWED`；
 *   - **绝不用 shell**：一律 `execFile`（参数数组），杜绝命令注入；
 *   - **超时保护**：缺省 120s，超时返回 `{ok:false, evidence:{error:'timeout'}}`；
 *   - **任何执行异常都转成可读结果**，绝不抛出去让上层崩（参数校验错误除外）。
 *
 * 不变量：事件流真相源 / 只追加 / 绝不静默失败。
 * 依赖面：node 内置 + `./store.js` + `./kernel.js`。零第三方依赖。
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { appendJsonl, readJsonl, statePath, writeJsonAtomic } from './store.js'

let kernel = null
let kernelError = null
try {
  kernel = await import('./kernel.js')
} catch (error) {
  kernelError = error
}

/** 命令白名单（`kind:'command'` 的 cmd 第一段必须在此列）。 */
export const CMD_WHITELIST = Object.freeze([
  'bash', 'node', 'npm', 'pnpm', 'npx', 'git', 'ls', 'test', 'python3',
])

/** 检查种类。 */
export const CHECK_KINDS = Object.freeze(['file', 'command', 'test'])

/** 缺省超时（ms）。 */
const DEFAULT_TIMEOUT_MS = 120_000

/** 结构化错误。 */
export class VerifyError extends Error {
  constructor(message, code = 'VERIFY_ERROR', details) {
    super(message)
    this.name = 'VerifyError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeNow(now, where) {
  if (now === undefined || now === null) return Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new VerifyError(
      `verify.${where}：now 必须是有限数字，收到 ${JSON.stringify(now)}`,
      'VERIFY_BAD_FIELD', { where, field: 'now' },
    )
  }
  return now
}

function requireString(value, field, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VerifyError(
      `verify.${where}：${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
      'VERIFY_BAD_FIELD', { where, field },
    )
  }
  return value.trim()
}

function resolveStateDir(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim() !== '') return config.stateDir.trim()
  if (kernel && typeof kernel.stateDir === 'function') return kernel.stateDir()
  const reason = kernelError?.message ?? 'kernel.stateDir 不存在'
  throw new VerifyError(
    `verify.createVerify：既未提供 config.stateDir，也无法从 kernel.js 取得 stateDir（${reason}）。`,
    'VERIFY_NO_STATE_DIR',
  )
}

function splitArgs(ctx, config) {
  const cfgGiven = config && typeof config === 'object' && Object.keys(config).length > 0
  if (cfgGiven) return { context: ctx ?? {}, config }
  if (ctx && typeof ctx === 'object' && typeof ctx.stateDir === 'string') return { context: {}, config: ctx }
  return { context: ctx ?? {}, config: config ?? {} }
}

/**
 * 执行一条命令（白名单 + 无 shell + 超时）。
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, error?:string}>}
 */
function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    const file = String(cmd[0])
    if (!CMD_WHITELIST.includes(file)) {
      resolvePromise({ exitCode: -1, stdout: '', stderr: '', error: `command not allowed: ${file}` })
      return
    }
    const args = cmd.slice(1)
    let settled = false
    const done = (out) => { if (!settled) { settled = true; resolvePromise(out) } }
    try {
      execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false }, (error, stdout, stderr) => {
        if (error && (error.killed || error.signal === 'SIGTERM')) {
          done({ exitCode: -1, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: 'timeout' })
          return
        }
        done({ exitCode: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    } catch (e) {
      done({ exitCode: -1, stdout: '', stderr: '', error: String(e?.message ?? e) })
    }
  })
}

/**
 * 创建验收证据服务。
 * @param {{ logger?: { info?: Function, warn?: Function } }} [ctx]
 * @param {{ stateDir?: string, name?: string }} [config]
 * @returns {object} verify service
 */
export function createVerify(ctx, config = {}) {
  const { context, config: cfg } = splitArgs(ctx, config)
  const stateDir = resolveStateDir(cfg)

  const jsonlPath = statePath(stateDir, 'verify.jsonl')
  const snapPath = statePath(stateDir, 'verify.snap.json')

  const info = (...args) => { try { context?.logger?.info?.(...args) } catch { /* */ } }
  const warn = (...args) => { try { context?.logger?.warn?.(...args) } catch { /* */ } }

  const entries = new Map()
  const events = []
  let idCounter = 0
  let disposed = false

  const diagnostics = {
    stateDir, jsonlPath, snapPath,
    kernel: kernel ? 'loaded' : `load-failed:${kernelError?.name ?? 'unknown'}`,
    hydratedFrom: null, replayedEvents: 0, badLines: 0,
    snapshotWriteFailures: 0, lastReplayAt: undefined,
    checksRun: 0, checksFailed: 0,
  }

  function assertAlive(where) {
    if (disposed) {
      throw new VerifyError(
        `verify.${where}：实例已 dispose()，请重新 createVerify()（拒绝在已销毁实例上静默返回空数据）`,
        'VERIFY_DISPOSED', { where },
      )
    }
  }

  function snapshot() {
    return { version: 1, savedAt: Date.now(), entries: [...entries.values()] }
  }

  function commit(action, at, by, before, after) {
    if (!appendJsonl(jsonlPath, { id: after.id, rev: after.rev, action, by, at, before, after })) {
      throw new VerifyError(`verify.${action}：事件追加失败（${jsonlPath}）`, 'VERIFY_APPEND_FAILED', { action })
    }
    entries.set(after.id, clone(after))
    events.push({ id: after.id, rev: after.rev, action, by, at, before: before ? clone(before) : null, after: clone(after) })
    if (!writeJsonAtomic(snapPath, snapshot())) {
      diagnostics.snapshotWriteFailures += 1
      warn(`[cs-bots/verify] 快照写入失败（${snapPath}）——事件流已落盘，replay() 可恢复`)
    }
  }

  function hydrate() {
    entries.clear(); events.length = 0; idCounter = 0
    const { rows, bad } = readJsonl(jsonlPath)
    diagnostics.badLines = bad
    diagnostics.replayedEvents = rows.length
    if (bad > 0) warn(`[cs-bots/verify] ${jsonlPath} 有 ${bad} 行无法解析——已跳过，请核对`)
    if (rows.length === 0) { diagnostics.hydratedFrom = 'empty'; return }
    let skipped = 0
    for (const ev of rows) {
      if (!ev || typeof ev.id !== 'string' || !ev.after) { skipped += 1; continue }
      const current = entries.get(ev.id)
      if (current && Number.isFinite(ev.rev) && ev.rev <= current.rev) { skipped += 1; continue }
      entries.set(ev.id, clone(ev.after)); events.push(clone(ev))
      const m = /^v-(\d+)$/.exec(ev.id)
      if (m) idCounter = Math.max(idCounter, Number(m[1]))
    }
    if (skipped > 0) warn(`[cs-bots/verify] 回放跳过 ${skipped} 条非递增/残缺事件`)
    diagnostics.hydratedFrom = 'jsonl'
  }

  // ── 单条检查 ──────────────────────────────────────────────────────────────

  /**
   * 执行一条声明式检查。
   * @param {object} spec
   * @returns {Promise<object>}
   */
  async function check(spec = {}) {
    assertAlive('check')
    const started = Date.now()
    const kind = spec?.kind
    if (!CHECK_KINDS.includes(kind)) {
      throw new VerifyError(
        `verify.check：kind=${JSON.stringify(kind)} 非法（合法：${CHECK_KINDS.join(' | ')}）`,
        'VERIFY_BAD_KIND', { kind },
      )
    }
    const by = spec?.by ?? 'system'
    const at = normalizeNow(spec?.now, 'check')

    // ── 参数校验（这些是可以抛的）──
    let evidence
    if (kind === 'file') {
      const path = requireString(spec.path, 'path', 'check')
      const expected = spec.expected ?? 'exists'
      if (!['exists', 'absent', 'nonempty'].includes(expected)) {
        throw new VerifyError(`verify.check：expected 非法（${JSON.stringify(expected)}）`, 'VERIFY_BAD_FIELD', { field: 'expected' })
      }
      let exists = false
      let size = 0
      try {
        if (existsSync(resolve(path))) { exists = true; size = statSync(resolve(path)).size }
      } catch { exists = false }
      let ok
      if (expected === 'exists') ok = exists
      else if (expected === 'absent') ok = !exists
      else ok = exists && size > 0
      evidence = { path, expected, exists, size, ok }
    } else if (kind === 'command') {
      if (!Array.isArray(spec.cmd) || spec.cmd.length === 0 || typeof spec.cmd[0] !== 'string') {
        throw new VerifyError(`verify.check：cmd 必须是字符串数组（execFile 参数，禁用 shell）`, 'VERIFY_BAD_CMD', { field: 'cmd' })
      }
      if (!CMD_WHITELIST.includes(spec.cmd[0])) {
        throw new VerifyError(
          `verify.check：命令 ${JSON.stringify(spec.cmd[0])} 不在白名单（${CMD_WHITELIST.join('|')}）——拒绝执行`,
          'VERIFY_CMD_NOT_ALLOWED', { cmd: spec.cmd[0], whitelist: CMD_WHITELIST },
        )
      }
      const out = await runCommand(spec.cmd, spec.cwd ?? undefined, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      evidence = { cmd: spec.cmd, exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, error: out.error }
      // expectExit 指定时**替换**「必须 0 退出」的判定（否则「期望退出码 2」永远不可能成立）。
      let ok = out.error === 'timeout' ? false : out.exitCode === 0
      if (spec.expectExit !== undefined && spec.expectExit !== null) {
        ok = out.error === 'timeout' ? false : out.exitCode === spec.expectExit
      }
      if (spec.expectOutput !== undefined && spec.expectOutput !== null) ok = ok && out.stdout.includes(spec.expectOutput)
      evidence.ok = ok
    } else { // test
      if (!spec.cwd) {
        throw new VerifyError(`verify.check：kind='test' 必须显式提供 cwd（拒绝在任意目录跑测试）`, 'VERIFY_BAD_FIELD', { field: 'cwd' })
      }
      const suite = spec.suite ?? 'test/run-all.sh'
      // ⚠️ 不用 `bash -c <string>`：那等于给任意 shell 注入开口，
      // 与「禁用 shell」的安全约束直接冲突。`suite` 只允许**脚本路径**（`bash <path>`），
      // 参数不含代码 → 不存在注入面。要跑自定义命令请用 kind:'command'（走白名单 + execFile）。
      const out = await runCommand(['bash', suite], spec.cwd, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      evidence = { suite, cwd: spec.cwd, exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, error: out.error }
      evidence.ok = out.exitCode === 0
    }

    const durationMs = Date.now() - started
    idCounter += 1
    const id = `v-${idCounter}`
    const rec = { id, rev: 1, kind, spec: clone(spec), result: evidence, at, by, durationMs, createdAt: at, updatedAt: at }
    commit('check', at, by, null, rec)
    diagnostics.checksRun += 1
    if (!evidence.ok) diagnostics.checksFailed += 1
    return clone(rec)
  }

  // ── 批量 ──────────────────────────────────────────────────────────────────

  /** 对一组路径做存在性检查（同步，不执行命令）。 */
  function evaluate(artifacts, options = {}) {
    assertAlive('evaluate')
    const list = Array.isArray(artifacts) ? artifacts : []
    const results = list.map((p) => {
      const abs = resolve(String(p))
      let exists = false, size = 0
      try { if (existsSync(abs)) { exists = true; size = statSync(abs).size } } catch { exists = false }
      return { path: String(p), exists, size, ok: exists }
    })
    const passed = results.filter((r) => r.ok).length
    return { ok: passed === results.length && results.length > 0, results, passed, failed: results.length - passed }
  }

  /**
   * 校验一个任务的产出：artifacts 逐个存在 + writeScopes 存在性检查。
   * @param {{ id: string, artifacts?: string[], writeScopes?: string[] }} task
   */
  function verifyTask(task = {}, options = {}) {
    assertAlive('verifyTask')
    const by = options?.by ?? task?.by ?? 'system'
    const at = normalizeNow(options?.now, 'verifyTask')
    const artifactCheck = evaluate(task.artifacts ?? [], options)
    const scopes = Array.isArray(task.writeScopes) ? task.writeScopes : []
    const scopeCheck = scopes.map((s) => {
      const abs = resolve(String(s))
      let exists = false
      try { if (existsSync(abs)) exists = true } catch { exists = false }
      return { scope: String(s), exists, ok: exists }
    })
    const scopeOk = scopeCheck.every((r) => r.ok)
    const ok = artifactCheck.ok && (scopes.length === 0 || scopeOk)
    idCounter += 1
    const id = `v-${idCounter}`
    const rec = {
      id, rev: 1, kind: 'task', taskId: task.id ?? null,
      result: { ok, artifactCheck, scopeCheck }, at, by, durationMs: 0,
      createdAt: at, updatedAt: at,
    }
    commit('verifyTask', at, by, null, rec)
    diagnostics.checksRun += 1
    if (!ok) diagnostics.checksFailed += 1
    return clone(rec)
  }

  function history(limit = 50) {
    assertAlive('history')
    return clone([...entries.values()].sort((a, b) => b.at - a.at).slice(0, limit))
  }

  function stats() {
    const byKind = {}
    for (const r of entries.values()) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    return { total: entries.size, byKind, events: events.length, diagnostics: clone(diagnostics) }
  }

  function replay() { hydrate(); diagnostics.lastReplayAt = Date.now(); return { from: diagnostics.hydratedFrom, events: events.length, bad: diagnostics.badLines } }
  function dispose() { disposed = true }

  hydrate()

  return {
    name: cfg.name ?? 'verify',
    paths: Object.freeze({ stateDir, jsonl: jsonlPath, snapshot: snapPath }),
    check,
    evaluate,
    verifyTask,
    history,
    stats,
    replay,
    diagnostics: () => clone(diagnostics),
    dispose,
  }
}

export default createVerify
