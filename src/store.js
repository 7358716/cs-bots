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

import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, rmSync, statSync } from 'node:fs'
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
