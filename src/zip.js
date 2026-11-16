/**
 * 最小 ZIP 读写器（**零第三方依赖**）。
 *
 * ## 为什么自己写
 *
 *   插件有一条硬约束：`dependencies: {}`（`ci-zero-dep.sh` 会检查）。
 *   导入导出要 zip 格式，但用不了 `adm-zip` / `jszip` 这类库。
 *   ⇒ 用 Node 内置的 `node:zlib` 自己拼 ZIP 结构。
 *
 * ## 支持范围（够用就好）
 *
 *   - 写：DEFLATE 压缩（`zlib.deflateRawSync`），或 STORE 不压缩（对已压缩内容更划算）
 *   - 读：DEFLATE / STORE 两种
 *   - 不支持：ZIP64（>4GB）、加密、分卷 —— 这些场景我们会显式报错，不静默出错
 *
 * ## 格式要点（写的时候容易踩的坑）
 *
 *   一个 ZIP 由三部分组成：
 *     ① 每个文件的 Local File Header + 数据
 *     ② 每个文件的 Central Directory Header
 *     ③ End of Central Directory（EOCD）
 *
 *   ⚠️ **CRC32 必须正确**，否则解压工具会报「文件损坏」。
 *   ⚠️ **UTF-8 文件名**要在 general purpose bit 11 置位，否则中文名会乱码。
 *   ⚠️ 偏移量（offset）都是相对文件开头的绝对值，算错就读不出来。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

// ── CRC32 ────────────────────────────────────────────────────────────────────

/** CRC32 查表（惰性构建，只建一次）。 */
let CRC_TABLE = null

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  CRC_TABLE = table
  return table
}

/**
 * 算 CRC32（ZIP 每个条目都必须带）。
 * @param {Buffer} buf
 * @returns {number} 无符号 32 位
 */
export function crc32(buf) {
  const table = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const FLAG_UTF8 = 0x0800   // general purpose bit 11：文件名为 UTF-8
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/**
 * 单个 ZIP 条目的大小上限（4GB − 1）。超过要 ZIP64，我们明确不支持。
 */
const MAX_ENTRY_SIZE = 0xfffffffe

// ── 写 ───────────────────────────────────────────────────────────────────────

/**
 * 打包成 ZIP。
 *
 * @param {Array<{name: string, data: Buffer|string, store?: boolean}>} entries
 *   `name` 用正斜杠分隔（ZIP 规范要求）；`store: true` 表示不压缩
 * @returns {Buffer}
 * @throws {Error} 条目过大（超 4GB）或重名
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('createZip：entries 不能为空')
  }
  const seen = new Set()
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const rawName = String(entry?.name ?? '').replace(/\\/g, '/')
    if (!rawName) throw new Error('createZip：条目缺少 name')
    if (seen.has(rawName)) throw new Error(`createZip：条目重名 ${rawName}`)
    seen.add(rawName)

    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8')
    if (data.length > MAX_ENTRY_SIZE) {
      throw new Error(`createZip：条目 ${rawName} 超过 4GB，不支持 ZIP64`)
    }

    const nameBuf = Buffer.from(rawName, 'utf8')
    const crc = crc32(data)

    // STORE 还是 DEFLATE：压缩反而变大时退回 STORE（小文件常见）
    let method = METHOD_STORE
    let payload = data
    if (!entry.store) {
      const compressed = deflateRawSync(data)
      if (compressed.length < data.length) {
        method = METHOD_DEFLATE
        payload = compressed
      }
    }

    // ① Local File Header（30 字节固定 + 文件名）
    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)              // version needed
    local.writeUInt16LE(FLAG_UTF8, 6)       // 中文名必须置 UTF-8 位
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)              // mod time
    local.writeUInt16LE(0x21, 12)           // mod date（1980-01-01，固定值，避免时区差异）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)              // extra len

    locals.push(local, nameBuf, payload)

    // ② Central Directory Header（46 字节固定 + 文件名）
    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4)            // version made by
    central.writeUInt16LE(20, 6)            // version needed
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)            // extra
    central.writeUInt16LE(0, 32)            // comment
    central.writeUInt16LE(0, 34)            // disk
    central.writeUInt16LE(0, 36)            // internal attrs
    central.writeUInt32LE(0, 38)            // external attrs
    central.writeUInt32LE(offset, 42)       // ← 指向本条 Local Header 的绝对偏移

    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(centrals)
  const centralOffset = offset

  // ③ End of Central Directory
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)                  // disk number
  eocd.writeUInt16LE(0, 6)                  // disk with CD
  eocd.writeUInt16LE(entries.length, 8)     // 本盘条目数
  eocd.writeUInt16LE(entries.length, 10)    // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(0, 20)                 // comment len

  return Buffer.concat([...locals, centralBuf, eocd])
}

// ── 读 ───────────────────────────────────────────────────────────────────────

/**
 * 解 ZIP。
 *
 * 策略：**从 EOCD 反查 Central Directory**，再按偏移读每条 Local Header。
 * 这样即使条目之间有额外数据（data descriptor）也能正确读。
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer}>}
 * @throws {Error} 不是合法 ZIP / 用了不支持的特性
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new Error('readZip：不是合法的 ZIP（太短）')
  }

  // ① 找 EOCD（从末尾往前扫，容忍尾部注释）
  let eocdAt = -1
  const scanFrom = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= scanFrom; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocdAt = i; break }
  }
  if (eocdAt < 0) throw new Error('readZip：找不到 End of Central Directory，不是合法 ZIP')

  const total = buf.readUInt16LE(eocdAt + 10)
  const cdSize = buf.readUInt32LE(eocdAt + 12)
  const cdOffset = buf.readUInt32LE(eocdAt + 16)

  if (cdOffset === 0xffffffff || total === 0xffff) {
    throw new Error('readZip：这是 ZIP64 包，当前不支持（请用标准 zip 工具另存为非 ZIP64）')
  }
  if (cdOffset + cdSize > buf.length) {
    throw new Error('readZip：Central Directory 越界，包可能已损坏')
  }

  // ② 遍历 Central Directory
  const out = []
  let p = cdOffset
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`readZip：第 ${n + 1} 个 Central Header 损坏`)
    }
    const method = buf.readUInt16LE(p + 10)
    const crcExpected = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')

    // ③ 从 Local Header 拿真正的数据起点
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`readZip：条目 ${name} 的 Local Header 损坏`)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const payload = buf.slice(dataStart, dataStart + compSize)

    let data
    if (method === METHOD_STORE) {
      data = payload
    } else if (method === METHOD_DEFLATE) {
      try {
        data = inflateRawSync(payload)
      } catch (error) {
        throw new Error(`readZip：条目 ${name} 解压失败（${error?.message ?? error}）`)
      }
    } else {
      throw new Error(`readZip：条目 ${name} 用了不支持的压缩方法 ${method}`)
    }

    if (data.length !== rawSize) {
      throw new Error(`readZip：条目 ${name} 大小不符（期望 ${rawSize}，实得 ${data.length}）`)
    }
    // CRC 校验：这是「包没被改坏」的硬证据
    const actual = crc32(data)
    if (actual !== crcExpected) {
      throw new Error(`readZip：条目 ${name} CRC 校验失败（包已损坏或被修改）`)
    }

    out.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}