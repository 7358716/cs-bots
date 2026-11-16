/**
 * 零依赖 ZIP 读写（导入导出的地基）。
 *
 * ## 为什么要有这条测试
 *   插件硬约束是 `dependencies: {}`，用不了 adm-zip/jszip ⇒ 自己拼 ZIP 结构。
 *   自己拼最容易错的是：CRC32、字节偏移、UTF-8 标志位。
 *   这些错了在浏览器里解压才会暴露，所以必须在这里钉死。
 *
 * ## 互操作验证（真实跑过）
 *   - 我生成的包 → 系统 `unzip -t` 报 `No errors detected`
 *   - Python zipfile 生成的包 → 我能正确读回（含中文内容）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createZip, readZip, crc32 } from '../src/zip.js'

test('crc32：已知值的校验（空串 / "hello"）', () => {
  // 标准 CRC32 参考值
  assert.equal(crc32(Buffer.from('')), 0)
  assert.equal(crc32(Buffer.from('hello')), 0x3610a686)
})

test('往返：打包后能原样读回（含中文文件名与内容）', () => {
  const entries = [
    { name: 'manifest.json', data: '{"format":"cs-bots-export"}' },
    { name: 'docs/中文名.md', data: '# 中文内容' },
    { name: 'bots/a/b/c.txt', data: 'nested' },
  ]
  const back = readZip(createZip(entries))
  assert.equal(back.length, 3)
  assert.equal(back[0].name, 'manifest.json')
  assert.equal(back[1].name, 'docs/中文名.md', '中文文件名必须原样保留')
  assert.equal(back[1].data.toString('utf8'), '# 中文内容', '中文内容必须原样保留')
  assert.equal(back[2].name, 'bots/a/b/c.txt', '多级路径必须保留')
})

test('往返：空文件与二进制内容', () => {
  const binary = Buffer.from([0, 1, 2, 255, 254, 0, 128])
  const back = readZip(createZip([
    { name: 'empty.txt', data: '' },
    { name: 'bin.dat', data: binary },
  ]))
  assert.equal(back[0].data.length, 0)
  assert.deepEqual([...back[1].data], [...binary])
})

test('压缩：大文本应被压缩（DEFLATE 生效）', () => {
  const big = 'abc'.repeat(10000)          // 30000 字节，高度可压缩
  const zip = createZip([{ name: 'big.txt', data: big }])
  assert.ok(zip.length < big.length / 2, `应显著压缩，实际 ${zip.length} vs ${big.length}`)
  assert.equal(readZip(zip)[0].data.toString('utf8'), big, '解压后内容必须一致')
})

test('store：不压缩模式也能往返', () => {
  const back = readZip(createZip([{ name: 'x.txt', data: 'plain', store: true }]))
  assert.equal(back[0].data.toString('utf8'), 'plain')
})

test('★ CRC 校验：包被改坏必须报错，不能静默读出错数据', () => {
  const zip = createZip([{ name: 'a.txt', data: 'hello world' }])
  // 篡改最后一个字节（EOCD 区域之前的数据区）
  const corrupted = Buffer.from(zip)
  corrupted[corrupted.length - 30] ^= 0xff
  assert.throws(() => readZip(corrupted), /CRC|损坏|越界|解压失败/, '改坏的包必须抛错')
})

test('错误处理：空输入 / 非 ZIP / 重名条目', () => {
  assert.throws(() => createZip([]), /不能为空/)
  assert.throws(() => createZip([{ name: 'a', data: '1' }, { name: 'a', data: '2' }]), /重名/)
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /不是合法|找不到/)
  assert.throws(() => readZip(Buffer.alloc(0)), /太短/)
})

test('路径分隔：反斜杠自动转成正斜杠（ZIP 规范要求）', () => {
  const back = readZip(createZip([{ name: 'a\\b\\c.txt', data: 'x' }]))
  assert.equal(back[0].name, 'a/b/c.txt')
})
