/**
 * cs-bots 存储层 —— append-only JSONL + 原子快照。
 *
 * 纪律（依据实测踩坑，见 `11-融合最终稿-v1.md`）：
 *   - **按文件性质分选写策略**（K3）：状态/快照类用 `tmp → rename` 原子替换；
 *     高频追加类**就地 append**（DS-BOT `resume.js:117-119` 原文：Windows 上
 *     rename 会撞读，且撕裂写只丢一次重启能捡回的东西）。
 *   - **单写者锁三段式**（照搬 DS-BOT 已验证做法）：认领失败降级 warn 不阻塞、
 *     易主检测转只读、写前校验归属。
 *   - **绝不静默失败**：任何丢弃都要能被调用方看见。
 *
 * 本文件不 import 任何 `@deepseek-ai/*`（零依赖 CI 检查 1 覆盖）。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, rmSync, statSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 确保目录存在。 */
export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 读 JSON（失败返回 fallback，不抛）。 */
export function readJson(file, fallback = undefined) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8').trim()
    if (!text) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 原子写 JSON：`<file>.tmp-<pid>` → rename。
 * 适用**状态/快照类**（半截 JSON 不可接受）。高频追加类请用 `appendJsonl`。
 * @returns {boolean} 是否成功
 */
export function writeJsonAtomic(file, value) {
  try {
    ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 就地在文件尾追加一行 JSON（**不是**原子重写）。
 * 适用高频追加类日志：`rooms/*.log.jsonl` / `board.jsonl` / `wakes.jsonl`。
 * @returns {boolean} 是否成功
 */
export function appendJsonl(file, value) {
  try {
    ensureDir(dirname(file))
    appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读 JSONL 全部行。坏行**不静默丢弃**：计入 `bad` 返回给调用方。
 * @param {string} file
 * @param {{ limit?: number }} [options] 只取最后 limit 行（limit 为 0/undefined 表示不限）
 * @returns {{ rows: object[], bad: number, total: number }}
 */
export function readJsonl(file, options = {}) {
  const result = { rows: [], bad: 0, total: 0 }
  try {
    if (!existsSync(file)) return result
    let lines = readFileSync(file, 'utf8').split('\n')
    // 末尾空行不算行
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    result.total = lines.length
    if (options.limit && options.limit > 0 && lines.length > options.limit) {
      lines = lines.slice(-options.limit)
    }
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        result.rows.push(JSON.parse(line))
      } catch {
        result.bad += 1
      }
    }
  } catch {
    result.bad += 1
  }
  return result
}

// ── 单写者锁（三段式，照搬 DS-BOT 已验证做法）────────────────────────────────

/** 锁判死阈值（ms）：超过则视为上一个持有者已死。 */
const LOCK_STALE_MS = 60_000
/** 心跳间隔（ms）。 */
const LOCK_HEARTBEAT_MS = 15_000

/**
 * 认领一个单写者锁。
 *
 * 三段式之一：**认领失败不阻塞**（DS-BOT `store.js:45-56` 原文
 * "An unusable lock must not stop the team"）→ 返回 `{ owns: false }`，
 * 调用方降级为只读并 warn，而不是拒绝启动。
 *
 * @param {string} lockFile
 * @returns {{ owns: boolean, token: string, reason?: string }}
 */
export function claimLock(lockFile) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  try {
    ensureDir(dirname(lockFile))
    if (existsSync(lockFile)) {
      const current = readJson(lockFile, null)
      if (current && typeof current.at === 'number' && Date.now() - current.at < LOCK_STALE_MS) {
        // 锁仍新 → 不抢（别人在写）
        return { owns: false, token, reason: 'held-by-other' }
      }
      // 锁已过期 → 视为上一个持有者已死，接管
    }
    writeJsonAtomic(lockFile, { token, at: Date.now(), pid: process.pid })
    return { owns: true, token }
  } catch (error) {
    return { owns: false, token, reason: `claim-failed:${error?.message ?? error}` }
  }
}

/**
 * 校验锁是否仍归本 token 所有（三段式之三：**写前校验，失败即抛错不静默写**）。
 * @param {string} lockFile
 * @param {string} token
 * @returns {boolean}
 */
export function ownsLock(lockFile, token) {
  const current = readJson(lockFile, null)
  return Boolean(current && current.token === token)
}

/**
 * 续期心跳（三段式之二的数据基础）。
 * @param {string} lockFile
 * @param {string} token
 * @returns {boolean}
 */
export function heartbeatLock(lockFile, token) {
  if (!ownsLock(lockFile, token)) return false
  return writeJsonAtomic(lockFile, { token, at: Date.now(), pid: process.pid })
}

/** 释放锁（仅当仍归本 token）。 */
export function releaseLock(lockFile, token) {
  try {
    if (!ownsLock(lockFile, token)) return false
    rmSync(lockFile, { force: true })
    return true
  } catch {
    return false
  }
}

// ── 幂等键 ──────────────────────────────────────────────────────────────────

/**
 * 幂等去重器（内存 + 可选落盘快照）。
 * 用于「同一逻辑消息重投不改语义」——避免二次副作用。
 */
export class IdempotencySet {
  /** @param {number} [max] 内存中保留的键上限（LRU 近似：超限丢最旧） */
  constructor(max = 10_000) {
    this.max = max
    /** @type {Set<string>} */
    this.keys = new Set()
  }

  /** @returns {boolean} true=首次见到（可执行）；false=重复（应跳过） */
  check(key) {
    if (!key) return true
    if (this.keys.has(key)) return false
    this.keys.add(key)
    if (this.keys.size > this.max) {
      const first = this.keys.values().next().value
      this.keys.delete(first)
    }
    return true
  }

  has(key) {
    return this.keys.has(key)
  }

  /** 从 JSONL 事件流重建（重启后去重仍然有效）。 */
  rebuildFrom(rows, keyField = 'dedupKey') {
    for (const row of rows ?? []) {
      const k = row?.[keyField]
      if (k) this.keys.add(k)
    }
    return this.keys.size
  }
}

// ── 单调序号 ────────────────────────────────────────────────────────────────

/**
 * 从 JSONL 文件取下一个单调序号（`seq`），用于房间消息保序与断点续传。
 * 空文件从 1 开始。
 * @param {string} file
 * @param {string} [field]
 * @returns {number}
 */
export function nextSeq(file, field = 'seq') {
  const { rows } = readJsonl(file)
  let max = 0
  for (const row of rows) {
    const v = row?.[field]
    if (typeof v === 'number' && v > max) max = v
  }
  return max + 1
}

/** 让 `statSync` 可被外部按需使用（避免调用方再 import node:fs）。 */
export function fileMtime(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

/** 拼平台状态目录下的路径。 */
export function statePath(dir, ...parts) {
  return join(dir, ...parts)
}

// ── Schema 版本 / 迁移 / 审计 / 备份（P0-A 数据基座）────────────────────────

/** 当前全局 schema 版本基线（各域可各自覆盖）。 */
export const SCHEMA_VERSION = 1

function _tsLabel() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 读取某域的 schema 版本（缺省 0）。 */
export function readSchemaVersion(dir, name) {
  const v = readJson(statePath(dir, `${name}.schema.json`), 0)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof v === 'object' && typeof v.version === 'number') return v.version
  return 0
}

/** 写入某域的 schema 版本（原子）。 */
export function writeSchemaVersion(dir, name, version) {
  if (!Number.isFinite(version)) return false
  return writeJsonAtomic(statePath(dir, `${name}.schema.json`), { version, at: Date.now() })
}

/**
 * 版本迁移：版本不符时调用 migrateFn(rows) 并原子写回；版本高于当前抛可读错误（不降级）。
 * @returns {{ ok: true, migrated: boolean, version: number }}
 */
export function migrate(stateDir, { name, from, to, migrateFn } = {}) {
  if (!name) throw new Error('migrate: name 必填')
  if (!Number.isFinite(to)) throw new Error('migrate: to 必须是有限数')
  const current = readSchemaVersion(stateDir, name)
  if (current > to) {
    throw new Error(`migrate: ${name} 当前版本 ${current} 高于目标 ${to}，拒绝降级`)
  }
  if (current === to) return { ok: true, migrated: false, version: current }
  if (from !== undefined && current !== from) {
    // 允许 from 未给；给了就必须匹配
    throw new Error(`migrate: ${name} 当前版本 ${current} 与 from=${from} 不符`)
  }
  if (typeof migrateFn !== 'function') throw new Error('migrate: migrateFn 必须是函数')
  const jsonlPath = statePath(stateDir, `${name}.jsonl`)
  const jsonPath = statePath(stateDir, `${name}.json`)
  // 形态记忆：JSONL 恒为数组；JSON 是「数组」还是「单个对象」由原文件决定，
  // 迁移后**按原形态写回**（否则调用方读到的结构会突然从对象变成数组，属于隐性破坏）。
  let rows = []
  let target = 'jsonl'
  let wasArray = true
  if (existsSync(jsonlPath)) {
    const parsed = readJsonl(jsonlPath)
    rows = parsed.rows
    target = 'jsonl'
    if (parsed.bad > 0) {
      // 不静默：坏行要让调用方看见
      throw new Error(`migrate: ${name}.jsonl 有 ${parsed.bad}/${parsed.total} 行无法解析，拒绝在不完整数据上迁移`)
    }
  } else if (existsSync(jsonPath)) {
    const raw = readJson(jsonPath, undefined)
    if (raw === undefined) throw new Error(`migrate: ${name}.json 无法解析，拒绝迁移`)
    wasArray = Array.isArray(raw)
    rows = wasArray ? raw : [raw]
    target = 'json'
  }
  const next = migrateFn(rows)
  if (next !== undefined && !Array.isArray(next)) {
    throw new Error('migrate: migrateFn 必须返回数组（拿到 ' + typeof next + '）')
  }
  const nextRows = next ?? rows
  ensureDir(stateDir)
  if (target === 'jsonl') {
    const tmp = `${jsonlPath}.tmp-${process.pid}`
    writeFileSync(tmp, nextRows.map((r) => JSON.stringify(r)).join('\n') + (nextRows.length ? '\n' : ''), 'utf8')
    renameSync(tmp, jsonlPath)
  } else if (existsSync(jsonPath) || nextRows.length > 0) {
    writeJsonAtomic(jsonPath, wasArray ? nextRows : nextRows[0])
  }
  writeSchemaVersion(stateDir, name, to)
  return { ok: true, migrated: true, version: to }
}

/** 追加审计记录到 audit.jsonl（append-only）。 */
export function appendAudit(stateDir, entry = {}) {
  try {
    if (!stateDir) return false
    if (!ensureDir(stateDir)) return false
    // 顺序：先铺默认值，再让 entry 覆盖 —— 保证 ts/actor/action/target 一定存在，
    // 同时保留调用方给的任意额外字段（before/after/diagnostics 等）。
    const rec = {
      ts: Date.now(),
      actor: 'unknown',
      action: 'unknown',
      target: null,
      ...(entry && typeof entry === 'object' ? entry : {}),
    }
    if (typeof rec.ts !== 'number') rec.ts = Date.now()
    return appendJsonl(statePath(stateDir, 'audit.jsonl'), rec)
  } catch {
    return false
  }
}

/** 递归备份状态目录。 */
export function backupState(stateDir, label = 'manual') {
  try {
    if (!stateDir || !existsSync(stateDir)) return { ok: false, reason: 'stateDir 不存在或为空' }
    const safeLabel = String(label || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_')
    const dest = `${stateDir}.bak-${_tsLabel()}-${safeLabel}`
    cpSync(stateDir, dest, { recursive: true, force: true })
    return { ok: true, path: dest }
  } catch (error) {
    return { ok: false, reason: `备份失败：${error?.message ?? error}` }
  }
}

/** 恢复状态目录。confirm!==true 时拒绝。 */
export function restoreState(stateDir, backupPath, { confirm } = {}) {
  if (confirm !== true) return { ok: false, reason: '需要 confirm:true' }
  try {
    if (!backupPath || !existsSync(backupPath)) return { ok: false, reason: 'backupPath 不存在' }
    // 先把当前目录改名
    if (existsSync(stateDir)) {
      const pre = `${stateDir}.pre-restore-${_tsLabel()}`
      renameSync(stateDir, pre)
    }
    cpSync(backupPath, stateDir, { recursive: true, force: true })
    return { ok: true, path: stateDir }
  } catch (error) {
    return { ok: false, reason: `恢复失败：${error?.message ?? error}` }
  }
}
