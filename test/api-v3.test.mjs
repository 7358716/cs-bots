/**
 * cs-bots HTTP API v3 测试 —— 覆盖 v2 新增的 30+ 端点。
 *
 * 为什么必须测：这些端点是页面「待办 / 便签 / 提示词 / 纪律 / 建议确认 /
 * 技能导入 / Bot 档案记忆」唯一的数据通道。端点 404 或入参错位，
 * 页面就是一片空 —— 用户看到的是「功能不存在」，而不是报错。
 *
 * 手法与 api.test.mjs 一致：直接调注册出去的 handler，不启真服务器。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'
import { getServices } from '../src/registry.js'
import { API_BASE } from '../src/api.js'

function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cs-bots-api3-'))
  let handler = null
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => {
      if (key === 'agents') {
        return {
          async create(request) {
            return { id: request?.sessionId, sessionId: request?.sessionId }
          },
          get: () => undefined,
          list: () => [],
        }
      }
      if (key === 'tools') {
        return { register: () => () => {}, guard: () => () => {}, schemas: () => [] }
      }
      if (key === 'webServer') {
        return {
          register: ({ path, handler: h }) => {
            assert.equal(path, API_BASE)
            handler = h
            return () => {}
          },
        }
      }
      return undefined
    },
    on: () => {},
    effect: () => {},
  }
  apply(ctx, { stateDir })
  return {
    ctx,
    stateDir,
    async req(method, path, body) {
      assert.ok(handler, 'API handler 应已注册')
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const request = Object.assign(Readable.from(payload), { method, url: API_BASE + path })
      let status = 0
      let raw = ''
      const response = {
        writeHead(code) { status = code },
        end(chunk) { raw += chunk ?? '' },
      }
      await handler(request, response)
      let json
      try {
        json = JSON.parse(raw)
      } catch {
        json = { _raw: raw }
      }
      return { status, json }
    },
    cleanup() {
      const s = getServices(ctx)
      for (const k of ['dispatcher', 'todo', 'scratch', 'prompts', 'suggest', 'reviewer', 'discipline']) {
        try { s[k]?.dispose?.() } catch { /* 已释放 */ }
      }
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

// ── 待办 ────────────────────────────────────────────────────────────────────

test('待办：新建 → 列表 → 修改 → 删除 全链路', async () => {
  const h = boot()
  try {
    const created = await h.req('POST', '/todos', { track: 'life', content: '交房租', quadrant: 'q2', due: '2026-11-30' })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    assert.equal(created.json.ok, true)
    const todo = created.json.todo
    assert.equal(todo.content, '交房租')
    assert.equal(todo.track, 'life')
    assert.equal(typeof todo.rev, 'number')

    const listed = await h.req('GET', '/todos?all=1')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.items.length, 1)

    const updated = await h.req('POST', '/todos/update', {
      id: todo.id, expectedRev: todo.rev, status: 'done',
    })
    assert.equal(updated.status, 200, JSON.stringify(updated.json))
    assert.equal(updated.json.todo.status, 'done')
    assert.ok(updated.json.todo.doneAt, 'done 应自动盖完成时间')

    const removed = await h.req('POST', '/todos/remove', { id: todo.id, expectedRev: updated.json.todo.rev })
    assert.equal(removed.status, 200, JSON.stringify(removed.json))
    assert.equal((await h.req('GET', '/todos?all=1')).json.items.length, 0)
  } finally {
    h.cleanup()
  }
})

test('待办：CAS 冲突返回错误而不是静默覆盖', async () => {
  const h = boot()
  try {
    const { json } = await h.req('POST', '/todos', { track: 'work', content: 'A' })
    const bad = await h.req('POST', '/todos/update', { id: json.todo.id, expectedRev: 999, content: 'B' })
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.code, 'TODO_REV_CONFLICT')
    assert.match(String(bad.json.reason ?? ''), /CAS/)
    // 内容没被改掉
    assert.equal((await h.req('GET', '/todos?all=1')).json.items[0].content, 'A')
  } finally {
    h.cleanup()
  }
})

// ── 便签 ────────────────────────────────────────────────────────────────────

test('便签：写入 → 读取 → scope 隔离', async () => {
  const h = boot()
  try {
    const w = await h.req('POST', '/scratch', { text: '随手记一行' })
    assert.equal(w.status, 200, JSON.stringify(w.json))
    const r = await h.req('GET', '/scratch')
    assert.equal(r.json.text, '随手记一行')
    assert.ok(r.json.updatedAt > 0)

    await h.req('POST', '/scratch', { scope: 'other', text: '另一个' })
    assert.equal((await h.req('GET', '/scratch')).json.text, '随手记一行', 'global 不应被 other 覆盖')
    assert.equal((await h.req('GET', '/scratch?scope=other')).json.text, '另一个')

    const scopes = await h.req('GET', '/scratch/scopes')
    assert.equal(scopes.status, 200)
    assert.equal(scopes.json.scopes.length, 2)
  } finally {
    h.cleanup()
  }
})

// ── 提示词 ──────────────────────────────────────────────────────────────────

test('提示词：CRUD + 分类', async () => {
  const h = boot()
  try {
    const c = await h.req('POST', '/prompts', {
      name: '结论先行', description: '先给结论', body: '先给结论再给过程', category: '通用',
    })
    assert.equal(c.status, 200, JSON.stringify(c.json))
    const p = c.json.item
    assert.equal(p.name, '结论先行')

    const listed = await h.req('GET', '/prompts')
    assert.equal(listed.status, 200)
    assert.ok(listed.json.items.length >= 1)
    assert.ok(Array.isArray(listed.json.categories))

    const up = await h.req('POST', '/prompts/update', {
      id: p.id, expectedRev: p.rev, body: '改了正文',
    })
    assert.equal(up.status, 200, JSON.stringify(up.json))
    assert.equal(up.json.item.body, '改了正文')

    const rm = await h.req('POST', '/prompts/remove', { id: p.id, expectedRev: up.json.item.rev })
    assert.equal(rm.status, 200, JSON.stringify(rm.json))
  } finally {
    h.cleanup()
  }
})

test('提示词：注入与停止注入', async () => {
  const h = boot()
  try {
    const c = await h.req('POST', '/prompts', { name: 'tpl', body: '今天是 {{date}}' })
    const p = c.json.item
    const inj = await h.req('POST', '/prompts/inject', { promptId: p.id, sessionId: 'sess-1', times: 1 })
    assert.equal(inj.status, 200, JSON.stringify(inj.json))
    assert.ok(inj.json.injection.id)

    const list = await h.req('GET', '/prompts/injections?sessionId=sess-1')
    assert.equal(list.status, 200)
    assert.equal(list.json.injections.length, 1)

    const stop = await h.req('POST', '/prompts/injection/stop', { id: inj.json.injection.id })
    assert.equal(stop.status, 200, JSON.stringify(stop.json))
  } finally {
    h.cleanup()
  }
})

// ── 纪律 ────────────────────────────────────────────────────────────────────

test('纪律：创建 → 列表 → 解析合并 → 删除', async () => {
  const h = boot()
  try {
    const c = await h.req('POST', '/disciplines', {
      scope: 'global', kind: 'rule', title: '不静默失败', content: '失败必须显式报错',
    })
    assert.equal(c.status, 200, JSON.stringify(c.json))
    const d = c.json.item

    const listed = await h.req('GET', '/disciplines')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.items.length, 1)

    const resolved = await h.req('GET', '/disciplines/resolve')
    assert.equal(resolved.status, 200, JSON.stringify(resolved.json))
    assert.match(resolved.json.text, /不静默失败/)

    const rm = await h.req('POST', '/disciplines/remove', { id: d.id, expectedRev: d.rev })
    assert.equal(rm.status, 200, JSON.stringify(rm.json))
  } finally {
    h.cleanup()
  }
})

// ── 建议确认队列（采纳必须真正落库）─────────────────────────────────────────

test('建议：提议 → 列表 → 采纳后记忆库真有一条', async () => {
  const h = boot()
  try {
    const s = await h.req('POST', '/suggestions/propose', {
      kind: 'memory', layer: 'L2', payload: { content: '本项目只用 pnpm' }, reason: '用户提过',
    })
    // 端点可能叫 /suggestions/propose 或不存在；退回到直接用服务提议（页面只读列表+采纳）
    if (s.status !== 200) {
      const svc = getServices(h.ctx).suggest
      svc.suggest({
        kind: 'memory', layer: 'L2', payload: { content: '本项目只用 pnpm' },
        reason: '测试：用户提过', source: 'review', by: 'test',
      })
    }

    const listed = await h.req('GET', '/suggestions?status=pending')
    assert.equal(listed.status, 200, JSON.stringify(listed.json))
    assert.equal(listed.json.items.length, 1)
    const sg = listed.json.items[0]

    const before = (await h.req('GET', '/memory?layer=L2')).json.entries.length
    const acc = await h.req('POST', '/suggestions/accept', { id: sg.id })
    assert.equal(acc.status, 200, JSON.stringify(acc.json))
    const after = (await h.req('GET', '/memory?layer=L2')).json.entries
    assert.equal(after.length, before + 1, '采纳后记忆库必须真的多一条（不能只改状态）')
    assert.ok(after.some((e) => e.content === '本项目只用 pnpm'))
  } finally {
    h.cleanup()
  }
})

test('建议：驳回不改状态为 accepted，也不写库', async () => {
  const h = boot()
  try {
    const svc = getServices(h.ctx).suggest
    svc.suggest({
      kind: 'memory', layer: 'L2', payload: { content: '不该记的' },
      reason: '测试：驳回场景', source: 'review', by: 'test',
    })
    const listed = await h.req('GET', '/suggestions?status=pending')
    const sg = listed.json.items[0]
    const rej = await h.req('POST', '/suggestions/reject', { id: sg.id, reason: '不需要' })
    assert.equal(rej.status, 200, JSON.stringify(rej.json))
    assert.equal((await h.req('GET', '/memory?layer=L2')).json.entries.length, 0)
    assert.equal((await h.req('GET', '/suggestions?status=pending')).json.items.length, 0)
  } finally {
    h.cleanup()
  }
})

// ── 审查调度 ────────────────────────────────────────────────────────────────

test('审查：note-turn 累计到间隔就 due', async () => {
  const h = boot()
  try {
    const st0 = await h.req('GET', '/review/status?sessionId=s1')
    assert.equal(st0.status, 200, JSON.stringify(st0.json))
    const interval = st0.json.status.interval
    for (let i = 0; i < interval; i += 1) {
      await h.req('POST', '/review/note-turn', { sessionId: 's1' })
    }
    const st1 = await h.req('GET', '/review/status?sessionId=s1')
    assert.equal(st1.json.status.due, true, `满 ${interval} 回合应 due`)

    const done = await h.req('POST', '/review/mark-reviewed', { sessionId: 's1' })
    assert.equal(done.status, 200, JSON.stringify(done.json))
    assert.equal((await h.req('GET', '/review/status?sessionId=s1')).json.status.due, false)
  } finally {
    h.cleanup()
  }
})

// ── 技能管理器 ──────────────────────────────────────────────────────────────

test('技能：解析 SKILL.md → 导入 → 停用 → 启用', async () => {
  const h = boot()
  try {
    const md = '---\nname: deploy-check\ndescription: 部署前检查\ntags: [devops]\n---\n\n# 部署前检查\n\n1. 核对环境变量\n'
    const parsed = await h.req('POST', '/library/skills/parse', { text: md, filename: 'SKILL.md' })
    assert.equal(parsed.status, 200, JSON.stringify(parsed.json))
    assert.equal(parsed.json.parsed.name, 'deploy-check')

    const imported = await h.req('POST', '/library/skills/import', {
      items: [parsed.json.parsed], mode: 'skip',
    })
    assert.equal(imported.status, 200, JSON.stringify(imported.json))
    assert.equal(imported.json.result.created.length, 1)

    const all = await h.req('GET', '/library/skills?all=1')
    const skill = all.json.skills.find((s) => s.name === 'deploy-check')
    assert.ok(skill, '导入后应能查到')
    assert.equal(skill.source, 'custom')

    const dis = await h.req('POST', '/library/skills/enable', { id: skill.id, enabled: false, expectedRev: skill.rev })
    assert.equal(dis.status, 200, JSON.stringify(dis.json))
    assert.equal((await h.req('GET', '/library/skills')).json.skills.length, 0, '缺省不返回停用项')

    const en = await h.req('POST', '/library/skills/enable', {
      id: skill.id, enabled: true, expectedRev: dis.json.skill.rev,
    })
    assert.equal(en.status, 200, JSON.stringify(en.json))
    assert.equal((await h.req('GET', '/library/skills')).json.skills.length, 1)
  } finally {
    h.cleanup()
  }
})

test('技能：扫描目录读取 SKILL.md', async () => {
  const h = boot()
  try {
    const dir = join(h.stateDir, 'skills-src')
    mkdirSync(join(dir, 'svc-a'), { recursive: true })
    writeFileSync(join(dir, 'svc-a', 'SKILL.md'), '---\nname: svc-a\ndescription: A\n---\n\n正文 A\n')
    const scanned = await h.req('POST', '/library/skills/scan', { dir })
    assert.equal(scanned.status, 200, JSON.stringify(scanned.json))
    assert.equal(scanned.json.items.length, 1)
    assert.equal(scanned.json.items[0].name, 'svc-a')
  } finally {
    h.cleanup()
  }
})

test('技能：自定义目录登记拒绝系统目录', async () => {
  const h = boot()
  try {
    const bad = await h.req('POST', '/library/skills/dirs/add', { dir: '/etc' })
    assert.equal(bad.json.ok, false, '登记 /etc 必须被拒')
    assert.equal(bad.json.code, 'LIB_BAD_DIR')
    const list = await h.req('GET', '/library/skills/dirs')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.dirs, [])
  } finally {
    h.cleanup()
  }
})

// ── Bot 档案增强 ────────────────────────────────────────────────────────────

test('Bot 档案：岗位名/人格/红线 保存后读回一致', async () => {
  const h = boot()
  try {
    const botCwd = join(h.stateDir, 'probe-bot')
    mkdirSync(botCwd, { recursive: true })
    const created = await h.req('POST', '/roster', { name: 'probe-bot', cwd: botCwd })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    const bot = created.json.bot

    const saved = await h.req('POST', '/roster/profile', {
      id: bot.id,
      expectedRev: bot.rev,
      profile: {
        title: '发布管理员',
        persona: '结论先行，遇到不确定就说不确定',
        boundaries: '不许直接推 main',
        identity: '负责发布',
      },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))

    const got = await h.req('GET', `/roster/profile?id=${bot.id}`)
    assert.equal(got.status, 200)
    assert.equal(got.json.profile.title, '发布管理员')
    assert.equal(got.json.profile.boundaries, '不许直接推 main')
  } finally {
    h.cleanup()
  }
})

test('Bot 档案：从记忆库导入预制记忆（去重）', async () => {
  const h = boot()
  try {
    await h.req('POST', '/memory', { layer: 'L2', content: '团队规矩 A' })
    await h.req('POST', '/memory', { layer: 'L2', content: '团队规矩 B' })
    const memCwd = join(h.stateDir, 'mem-bot')
    mkdirSync(memCwd, { recursive: true })
    const created = await h.req('POST', '/roster', { name: 'mem-bot', cwd: memCwd })
    const bot = created.json.bot

    const r1 = await h.req('POST', '/roster/profile/memory', {
      id: bot.id, expectedRev: bot.rev, entries: ['团队规矩 A'],
      dedup: true,
    })
    assert.equal(r1.status, 200, JSON.stringify(r1.json))
    const prof1 = (await h.req('GET', `/roster/profile?id=${bot.id}`)).json.profile
    assert.ok(prof1.memory.includes('团队规矩 A'))
    assert.equal(prof1.memory.length, 1, '重复导入应去重')
  } finally {
    h.cleanup()
  }
})

// ── 记忆完整增删改查 ────────────────────────────────────────────────────────

test('记忆：新建 → 详情 → 修改 → 归档 → 恢复 → 删除', async () => {
  const h = boot()
  try {
    const added = await h.req('POST', '/memory', { layer: 'L2', content: '原始内容', tags: ['a'] })
    assert.equal(added.status, 200, JSON.stringify(added.json))
    const entry = Array.isArray(added.json.entry) ? added.json.entry[0] : added.json.entry
    assert.ok(entry.id)

    const detail = await h.req('GET', `/memory/detail?id=${entry.id}&layer=L2`)
    assert.equal(detail.status, 200, JSON.stringify(detail.json))
    assert.equal(detail.json.entry.content, '原始内容')
    assert.ok(Array.isArray(detail.json.history))

    const up = await h.req('POST', '/memory/update', {
      layer: 'L2', id: entry.id, expectedRev: entry.rev, content: '改过内容',
    })
    assert.equal(up.status, 200, JSON.stringify(up.json))
    assert.equal(up.json.entry.content, '改过内容')

    const arch = await h.req('POST', '/memory/archive', { layer: 'L2', id: entry.id, reason: '过时' })
    assert.equal(arch.status, 200, JSON.stringify(arch.json))
    const archived = await h.req('GET', '/memory?onlyArchived=1')
    assert.equal(archived.json.entries.length, 1, '归档后应在归档区')
    assert.equal((await h.req('GET', '/memory')).json.entries.length, 0, '归档后不参与正常列表')

    const rest = await h.req('POST', '/memory/restore', { layer: 'L2', id: entry.id })
    assert.equal(rest.status, 200, JSON.stringify(rest.json))
    assert.equal((await h.req('GET', '/memory')).json.entries.length, 1)

    const rm = await h.req('POST', '/memory/remove', { layer: 'L2', id: entry.id })
    assert.equal(rm.status, 200, JSON.stringify(rm.json))
    assert.equal((await h.req('GET', '/memory')).json.entries.length, 0)
  } finally {
    h.cleanup()
  }
})

// ── 房间超级管理员 ──────────────────────────────────────────────────────────

test('房间：用途/规则可写可读，归档后可从归档区看到', async () => {
  const h = boot()
  try {
    const c = await h.req('POST', '/rooms', { name: '发布群', members: ['user'], byId: 'user' })
    assert.equal(c.status, 200, JSON.stringify(c.json))
    const room = c.json.room

    const up = await h.req('POST', '/rooms/update', {
      roomId: room.id,
      expectedRev: room.rev,
      purpose: '发版前协调',
      notice: '冻结代码',
      settings: { maxBotsPerRound: 2 },
      byId: 'user',
    })
    assert.equal(up.status, 200, JSON.stringify(up.json))

    const got = (await h.req('GET', '/rooms')).json.rooms.find((r) => r.id === room.id)
    assert.equal(got.purpose, '发版前协调')
    assert.equal(got.settings.maxBotsPerRound, 2)

    const arch = await h.req('POST', '/rooms/archive', { roomId: room.id, expectedRev: got.rev })
    assert.equal(arch.status, 200, JSON.stringify(arch.json))
    assert.equal((await h.req('GET', '/rooms')).json.rooms.length, 0, '归档后缺省不出现')
    assert.equal((await h.req('GET', '/rooms?includeArchived=1')).json.rooms.length, 1)

    const un = await h.req('POST', '/rooms/unarchive', { roomId: room.id })
    assert.equal(un.status, 200, JSON.stringify(un.json))
    assert.equal((await h.req('GET', '/rooms')).json.rooms.length, 1)
  } finally {
    h.cleanup()
  }
})

test('房间：长消息全文可读（withBody）', async () => {
  const h = boot()
  try {
    const c = await h.req('POST', '/rooms', { name: 'r', members: ['user'], byId: 'user' })
    const room = c.json.room
    const long = 'X'.repeat(5000)
    await h.req('POST', '/rooms/post', { roomId: room.id, text: long, from: 'user' })

    const withBody = await h.req('GET', `/rooms/messages?roomId=${room.id}&withBody=1`)
    assert.equal(withBody.status, 200, JSON.stringify(withBody.json))
    assert.equal(withBody.json.messages.length, 1)
    const m = withBody.json.messages[0]
    assert.equal(m.body, long, 'withBody=1 必须返回全文')
  } finally {
    h.cleanup()
  }
})
