/**
 * cs-bots v2「Bot 档案增强」测试（DESIGN-v2 特性 ③）。
 *
 * 覆盖：新字段校验 / 超长拒绝 / 未知字段拒绝 / AGENTS.md 渲染含新字段 /
 * 老档案向后兼容 / importMemoryToProfile 去重（含空白与大小写差异）/
 * addProfileMemory 落盘且 rev+1 / linkSkills 同步 skill 文件。
 *
 * 纪律（照 botprofile.test.mjs / roster.test.mjs 的验收口径）：**只认落盘产物**
 * ——读回 AGENTS.md 的受管区块、读回 SKILL.md、读回 roster.jsonl 事件，
 * 不接受「函数没抛错」这类弱断言。
 *
 * 运行：`node --test test/profile-rich.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  AGENTS_FILE,
  LIMITS,
  MARK_BEGIN,
  MARK_END,
  PROFILE_FIELDS,
  ProfileError,
  SKILLS_DIR,
  importMemoryToProfile,
  normalizeProfile,
  readAgentsFile,
  renderManagedSection,
  writeAgentsFile,
} from '../src/botprofile.js'
import { RosterError, createRoster } from '../src/roster.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

let counter = 0

/**
 * 造隔离环境：独立 stateDir + 独立 Bot 工作区 + 假宿主 ctx。
 *
 * 假 ctx 只需 `agents.create`（kernel.createSession 的唯一依赖，见 roster.test.mjs），
 * 故裸检出（无宿主包、无 node_modules）也能跑。
 */
function setup(t) {
  const base = process.env.ROSTER_TEST_TMPDIR || tmpdir()
  const root = mkdtempSync(join(base, `cs-bots-profile-rich-${process.pid}-${counter++}-`))
  t?.after?.(() => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  })
  const stateDir = join(root, 'state')
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })

  const ctx = {
    logger: { info() {}, warn() {} },
    get(key) {
      if (key !== 'agents') return undefined
      return {
        async create(request) {
          return { id: request.sessionId, sessionId: request.sessionId }
        },
        get: () => undefined,
        list: () => [],
      }
    },
  }
  const roster = createRoster(ctx, { stateDir, name: 'test-roster' })
  return { root, stateDir, ws, ctx, roster }
}

/** 建一个 Bot（cwd 必须先存在：档案落盘要求目录真实可写）。 */
async function seedBot(env, over = {}) {
  const n = counter++
  const cwd = join(env.ws, `bot-${n}`)
  mkdirSync(cwd, { recursive: true })
  return env.roster.create({ name: `bot-${n}`, cwd, byId: 'lead', ...over })
}

/** 读事件流（审计真相源）。 */
function events(stateDir) {
  const file = join(stateDir, 'roster.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** 读 Bot 的 AGENTS.md 受管区块全文（落盘证据）。 */
function managedText(cwd) {
  return readAgentsFile(cwd).managed ?? ''
}

// ── 1. LIMITS 与字段清单 ────────────────────────────────────────────────────

test('LIMITS 增加 title/persona/boundaries/disciplineIds，且数值符合契约', () => {
  assert.equal(LIMITS.title, 120)
  assert.equal(LIMITS.persona, 2000)
  assert.equal(LIMITS.boundaries, 2000)
  assert.equal(LIMITS.disciplineIds, 50)
})

test('PROFILE_FIELDS 是唯一清单：老五字段 + 新四字段', () => {
  assert.deepEqual([...PROFILE_FIELDS].sort(), [
    'boundaries',
    'disciplineIds',
    'experience',
    'identity',
    'memory',
    'persona',
    'skills',
    'title',
    'workflows',
  ])
})

// ── 2. normalizeProfile：新字段校验 / 超长拒绝 / 未知字段 ─────────────────────

test('normalizeProfile 透传新字段（title/persona/boundaries/disciplineIds）', () => {
  const out = normalizeProfile({
    title: '后端负责人',
    persona: '冷静、先证据后结论',
    boundaries: '不碰生产库写操作',
    disciplineIds: ['d-1', 'd-2'],
  })
  assert.deepEqual(out, {
    title: '后端负责人',
    persona: '冷静、先证据后结论',
    boundaries: '不碰生产库写操作',
    disciplineIds: ['d-1', 'd-2'],
  })
})

test('新字段超长必须抛错（带 field detail，不静默截断）', () => {
  const cases = [
    ['title', LIMITS.title],
    ['persona', LIMITS.persona],
    ['boundaries', LIMITS.boundaries],
  ]
  for (const [field, max] of cases) {
    assert.throws(
      () => normalizeProfile({ [field]: 'x'.repeat(max + 1) }),
      (e) => e instanceof ProfileError && e.code === 'PROFILE_TOO_LONG' && e.detail?.field === field,
      `${field} 超长必须抛 PROFILE_TOO_LONG`,
    )
  }
})

test('disciplineIds 非法类型 / 条目过多 / 单项超长都抛错', () => {
  assert.throws(
    () => normalizeProfile({ disciplineIds: 'd-1' }),
    (e) => e.code === 'PROFILE_BAD_FIELD' && e.detail?.field === 'disciplineIds',
  )
  assert.throws(
    () => normalizeProfile({ disciplineIds: Array.from({ length: LIMITS.disciplineIds + 1 }, (_, i) => `d-${i}`) }),
    (e) => e.code === 'PROFILE_TOO_MANY' && e.detail?.field === 'disciplineIds',
  )
  assert.throws(
    () => normalizeProfile({ disciplineIds: ['x'.repeat(65)] }),
    (e) => e.code === 'PROFILE_TOO_LONG',
  )
})

test('★ 未知字段：默认忽略（向后兼容既有调用方与既有测试），strict 模式拒绝', () => {
  // 默认口径 = 本仓历史契约（test/botprofile.test.mjs 断言 junk 被丢弃）
  assert.deepEqual(normalizeProfile({ identity: 'a', junk: 1 }), { identity: 'a' })

  // strict 给新入口按需收紧：出现未知字段即抛错（不含「静默忽略」）
  assert.throws(
    () => normalizeProfile({ identity: 'a', junk: 1 }, { strict: true }),
    (e) => e instanceof ProfileError && e.code === 'PROFILE_UNKNOWN_FIELD' && e.detail?.field === 'junk',
  )
  // strict 下合法字段照常通过
  const ok = normalizeProfile({ title: 't', persona: 'p', boundaries: 'b', disciplineIds: ['d'] }, { strict: true })
  assert.equal(ok.title, 't')
})

// ── 3. renderManagedSection：新字段进 AGENTS.md 受管区块 ───────────────────────

test('renderManagedSection 渲染 title（小标题）/ persona / boundaries / 关联纪律', () => {
  const md = renderManagedSection({
    botName: '后端一号',
    title: '后端负责人',
    persona: '说话简短，先给结论',
    boundaries: '绝不直接改生产数据',
    disciplineIds: ['d-alpha', 'd-beta'],
    identity: '我是后端',
  })
  assert.ok(md.startsWith(MARK_BEGIN), '受管区块必须以 begin 标记开头')
  assert.ok(md.trimEnd().endsWith(MARK_END), '受管区块必须以 end 标记结尾')
  assert.match(md, /^## 后端负责人$/m, 'title 必须当二级小标题')
  assert.match(md, /^## 人格设定$/m)
  assert.match(md, /说话简短，先给结论/)
  assert.match(md, /^## 边界与红线$/m)
  assert.match(md, /绝不直接改生产数据/)
  assert.match(md, /^## 关联纪律$/m)
  assert.match(md, /`d-alpha`/)
  assert.match(md, /`d-beta`/)
})

test('向后兼容：老档案（无新字段）不渲染新节，输出结构保持旧样', () => {
  const md = renderManagedSection({ botName: '老 Bot', identity: '我是老档案', experience: '老规矩' })
  assert.ok(!md.includes('## 人格设定'), '没有 persona 就不该出现空节')
  assert.ok(!md.includes('## 边界与红线'))
  assert.ok(!md.includes('## 关联纪律'))
  assert.ok(!md.includes('## 岗位'), '没有 title 就不该出现岗位小标题')
  assert.match(md, /我是老档案/)
  assert.match(md, /老规矩/)
})

// ── 4. 落盘：AGENTS.md 里真的有新字段，且段外内容不丢 ─────────────────────────

test('writeAgentsFile 把新字段写进受管区块，段外用户内容原样保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bots-rich-fs-'))
  try {
    const file = join(dir, AGENTS_FILE)
    writeFileSync(file, '# 用户手写\n\n这段不能被覆盖。\n', 'utf8')

    const written = writeAgentsFile(dir, {
      botName: 'b1',
      title: '前端负责人',
      persona: '爱较真',
      boundaries: '不动别人的分支',
      disciplineIds: ['d-9'],
      identity: '我是前端',
    })
    assert.equal(written.path, file)

    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /这段不能被覆盖。/, '用户段外内容必须还在')
    assert.match(raw, /## 前端负责人/)
    assert.match(raw, /爱较真/)
    assert.match(raw, /不动别人的分支/)
    assert.match(raw, /d-9/)

    // 读回受管段：新字段在 managed 里，且不在 outside 里
    const read = readAgentsFile(dir)
    assert.match(read.managed, /## 前端负责人/)
    assert.match(read.managed, /## 人格设定/)
    assert.ok(!(read.outside ?? '').includes('前端负责人'), '段外不该含受管内容')

    // 二次写入：受管段只有一份，旧值被替换
    writeAgentsFile(dir, { botName: 'b1', title: '前端负责人（改）' })
    const raw2 = readFileSync(file, 'utf8')
    assert.equal(raw2.split(MARK_BEGIN).length - 1, 1, '受管区块必须只有一份')
    assert.ok(!raw2.includes('爱较真'), '旧受管内容应被替换')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 5. importMemoryToProfile 纯函数 ─────────────────────────────────────────

test('importMemoryToProfile 追加重合内容：计数正确且顺序稳定', () => {
  const r = importMemoryToProfile({
    existing: ['生产库只读', '先写测试'],
    entries: ['先写测试', '新记忆 A', '新记忆 B'],
  })
  assert.deepEqual(r.memory, ['生产库只读', '先写测试', '新记忆 A', '新记忆 B'])
  assert.equal(r.added, 2)
  assert.equal(r.skipped, 1)
})

test('★ 去重口径：trim + 压缩连续空白 + 大小写不敏感', () => {
  const r = importMemoryToProfile({
    existing: ['  Production   DB  is  read-only  '],
    entries: [
      'production db is READ-ONLY', // 大小写不同
      'Production  DB is read-only', // 连续空白不同
      'Production DB is read-only', // 完全一致
      'Production DB is read-only!!', // 内容确实不同 → 应保留
    ],
  })
  assert.equal(r.added, 1, '前三条归一后与既有条目相同，只应加进来真正不同的那一条')
  assert.equal(r.skipped, 3)
  assert.equal(r.memory.length, 2)
  assert.equal(r.memory[1], 'Production DB is read-only!!')
})

test('dedup=false：只跳过空白条目，重复内容原样保留', () => {
  const r = importMemoryToProfile({ existing: ['A'], entries: ['A', '  ', 'A'], dedup: false })
  assert.deepEqual(r.memory, ['A', 'A', 'A'])
  assert.equal(r.added, 2)
  assert.equal(r.skipped, 1)
})

test('空白条目计入 skipped（不留空 bullet）', () => {
  const r = importMemoryToProfile({ existing: [], entries: ['', '   ', '\n\t', '有效'] })
  assert.deepEqual(r.memory, ['有效'])
  assert.equal(r.added, 1)
  assert.equal(r.skipped, 3)
})

test('importMemoryToProfile 超长/超量抛错，不静默截断', () => {
  assert.throws(
    () => importMemoryToProfile({ existing: [], entries: ['x'.repeat(LIMITS.memoryEach + 1)] }),
    (e) => e.code === 'PROFILE_TOO_LONG',
  )
  assert.throws(
    () => importMemoryToProfile({
      existing: Array.from({ length: LIMITS.memoryCount }, (_, i) => `m-${i}`),
      entries: ['追加一条就超了'],
    }),
    (e) => e.code === 'PROFILE_TOO_MANY' && e.detail?.field === 'memory',
  )
  assert.throws(() => importMemoryToProfile({ existing: 'not-array' }), (e) => e.code === 'PROFILE_BAD_FIELD')
  assert.throws(() => importMemoryToProfile({ entries: 42 }), (e) => e.code === 'PROFILE_BAD_FIELD')
})

test('importMemoryToProfile 是纯函数：不写任何文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bots-rich-pure-'))
  try {
    const before = readdirSync(dir).sort().join(',')
    importMemoryToProfile({ existing: ['a'], entries: ['b'] })
    assert.equal(readdirSync(dir).sort().join(','), before, '纯函数不得产生副作用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 6. setProfile：新字段透传并落盘 ──────────────────────────────────────────

test('setProfile 透传新字段：记录 + AGENTS.md 都要变，rev+1', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env, { profile: { identity: '我是后端', experience: '先写迁移' } })
  assert.equal(bot.rev, 1)

  const updated = env.roster.setProfile({
    id: bot.id,
    expectedRev: 1,
    byId: 'ui',
    profile: {
      title: '后端负责人',
      persona: '冷静克制',
      boundaries: '不碰生产写操作',
      disciplineIds: ['d-1'],
    },
  })

  assert.equal(updated.rev, 2, 'CAS 成功应 rev+1')
  assert.equal(updated.profile.title, '后端负责人')
  assert.equal(updated.profile.persona, '冷静克制')
  assert.equal(updated.profile.boundaries, '不碰生产写操作')
  assert.deepEqual(updated.profile.disciplineIds, ['d-1'])
  // 浅合并语义：老字段不能被新字段写丢
  assert.equal(updated.profile.identity, '我是后端')
  assert.equal(updated.profile.experience, '先写迁移')

  const md = managedText(bot.cwd)
  assert.match(md, /## 后端负责人/)
  assert.match(md, /冷静克制/)
  assert.match(md, /不碰生产写操作/)
  assert.match(md, /`d-1`/)

  // 事件流也要有证据
  const rows = events(env.stateDir)
  const last = rows[rows.length - 1]
  assert.equal(last.action, 'profile_updated')
  assert.equal(last.rev, 2)
  assert.equal(last.after.profile.title, '后端负责人')
})

test('setProfile CAS 不匹配必须抛错（绝不静默覆盖）', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env, { profile: { identity: 'a' } })
  assert.throws(
    () => env.roster.setProfile({ id: bot.id, profile: { title: 'x' }, byId: 'ui', expectedRev: 999 }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_REV_CONFLICT',
  )
  // 拒绝之后磁盘上的档案不得被改：rev 仍是 1，title 仍不存在
  const got = env.roster.getProfile(bot.id)
  assert.equal(got.bot.rev, 1)
  assert.equal(got.bot.profile.title, undefined)
})

// ── 7. addProfileMemory ─────────────────────────────────────────────────────

test('addProfileMemory：落盘 + rev+1 + 去重计数正确', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env, { profile: { identity: '我是后端', memory: ['生产库只读'] } })
  assert.equal(bot.rev, 1)

  const r = env.roster.addProfileMemory({
    id: bot.id,
    expectedRev: 1,
    byId: 'ui',
    // 归一化口径是「trim + 压缩连续空白 + 大小写不敏感」，故这里用首尾空白做重复项；
    // 注意「生产库  只读」（中间两个空格）压缩后是「生产库 只读」，与「生产库只读」**不是**同一条，
    // 那是内容差异，不是空白差异（纯函数测试已单独覆盖连续空白压缩）。
    entries: ['  生产库只读  ', '新增：部署窗口只开 10 分钟'],
  })

  assert.equal(r.added, 1)
  assert.equal(r.skipped, 1, '空白差异/大小写差异的那条应被跳过')
  assert.equal(r.bot.rev, 2, '有新增就必须 rev+1')
  assert.deepEqual(r.bot.profile.memory, ['生产库只读', '新增：部署窗口只开 10 分钟'])
  // 其他档案字段不能被记忆操作写丢
  assert.equal(r.bot.profile.identity, '我是后端')

  // 落盘证据：AGENTS.md 的预制记忆节里真的有新条目
  const md = managedText(bot.cwd)
  assert.match(md, /## 预制记忆/)
  assert.match(md, /部署窗口只开 10 分钟/)

  // 事件动作可审计
  const rows = events(env.stateDir)
  const last = rows[rows.length - 1]
  assert.equal(last.action, 'profile_memory_added')
  assert.equal(last.after.rev, 2)
})

test('addProfileMemory：全是重复 → added=0 且不 bump rev、不写事件', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env, { profile: { memory: ['生产库只读'] } })
  const before = events(env.stateDir).length

  const r = env.roster.addProfileMemory({
    id: bot.id,
    expectedRev: 1,
    byId: 'ui',
    entries: [' 生产库只读 ', '生产库只读'.toUpperCase()],
  })

  assert.equal(r.added, 0)
  assert.equal(r.skipped, 2)
  assert.equal(r.bot.rev, 1, '无变更不应 bump rev（审计流不该有「什么都没改」的记录）')
  assert.equal(events(env.stateDir).length, before, '无变更不应写事件')
})

test('addProfileMemory：CAS 冲突 / 缺 expectedRev / 退役 Bot 都抛带 code 的错', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env, { profile: { memory: [] } })

  assert.throws(
    () => env.roster.addProfileMemory({ id: bot.id, entries: ['x'], byId: 'ui', expectedRev: 2 }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_REV_CONFLICT',
  )
  assert.throws(
    () => env.roster.addProfileMemory({ id: bot.id, entries: ['x'], byId: 'ui' }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_MISSING_EXPECTED_REV',
  )

  const retired = env.roster.retire({ id: bot.id, byId: 'lead' })
  assert.throws(
    () => env.roster.addProfileMemory({ id: retired.id, entries: ['x'], byId: 'ui', expectedRev: retired.rev }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_BOT_RETIRED',
  )
})

test('addProfileMemory：条目超长抛 ProfileError（不静默截断）', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env, { profile: {} })
  assert.throws(
    () => env.roster.addProfileMemory({
      id: bot.id,
      expectedRev: 1,
      byId: 'ui',
      entries: ['x'.repeat(LIMITS.memoryEach + 1)],
    }),
    (e) => e instanceof ProfileError && e.code === 'PROFILE_TOO_LONG',
  )
  // 失败后档案不得被改动
  assert.equal(env.roster.get(bot.id).rev, 1)
})

// ── 8. linkSkills ───────────────────────────────────────────────────────────

test('linkSkills：写进 profile.skills 且 SKILL.md 真的落盘，rev+1', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env) // 不带档案
  assert.equal(bot.rev, 1)
  assert.equal(bot.profile, undefined)

  const linked = env.roster.linkSkills({
    id: bot.id,
    expectedRev: 1,
    byId: 'ui',
    skills: ['code-review', 'tdd'],
  })

  assert.equal(linked.rev, 2)
  assert.deepEqual(linked.profile.skills, ['code-review', 'tdd'])

  // 落盘证据 1：技能文件确实存在且是官方约定的 frontmatter
  for (const name of ['code-review', 'tdd']) {
    const file = join(bot.cwd, SKILLS_DIR, name, 'SKILL.md')
    assert.ok(existsSync(file), `${name}/SKILL.md 必须存在`)
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^---/)
    assert.match(text, new RegExp(`name: ${name}`))
  }

  // 落盘证据 2：AGENTS.md 可用技能节含技能名
  const md = managedText(bot.cwd)
  assert.match(md, /## 可用技能/)
  assert.match(md, /`code-review`/)
  assert.match(md, /`tdd`/)

  // 事件动作
  const rows = events(env.stateDir)
  const last = rows[rows.length - 1]
  assert.equal(last.action, 'profile_skills_linked')
  assert.deepEqual(last.after.profile.skills, ['code-review', 'tdd'])
})

test('linkSkills 是并集语义：追加关联，不清掉已有关联', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env, { profile: { skills: ['review'], identity: '我是 reviewer' } })
  const linked = env.roster.linkSkills({ id: bot.id, expectedRev: 1, byId: 'ui', skills: ['deploy'] })
  assert.deepEqual(linked.profile.skills, ['review', 'deploy'])
  assert.equal(linked.profile.identity, '我是 reviewer')
  assert.ok(existsSync(join(bot.cwd, SKILLS_DIR, 'deploy', 'SKILL.md')))
})

test('linkSkills 幂等：同一批技能再关联不 bump rev、不写事件', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env)
  const first = env.roster.linkSkills({ id: bot.id, expectedRev: 1, byId: 'ui', skills: ['review'] })
  const countAfterFirst = events(env.stateDir).length

  const second = env.roster.linkSkills({ id: bot.id, expectedRev: first.rev, byId: 'ui', skills: ['review'] })
  assert.equal(second.rev, first.rev, '无变化不应 bump rev')
  assert.equal(events(env.stateDir).length, countAfterFirst, '无变化不应写事件')
})

test('★ linkSkills 不覆盖已存在的 SKILL.md 正文（避免静默删除内容）', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env)
  const dir = join(bot.cwd, SKILLS_DIR, 'handwritten')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, '---\nname: handwritten\ndescription: 人写的\n---\n\n# 我自己写的正文，别动\n', 'utf8')

  env.roster.linkSkills({ id: bot.id, expectedRev: 1, byId: 'ui', skills: ['handwritten'] })
  const text = readFileSync(file, 'utf8')
  assert.match(text, /我自己写的正文，别动/, '已存在的技能正文必须原样保留')
  assert.match(text, /description: 人写的/)
})

test('linkSkills：非法技能名 / 空数组 / CAS 冲突都抛带 code 的错', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env)

  assert.throws(
    () => env.roster.linkSkills({ id: bot.id, expectedRev: 1, byId: 'ui', skills: ['../evil'] }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_BAD_SKILL_NAME',
  )
  assert.throws(
    () => env.roster.linkSkills({ id: bot.id, expectedRev: 1, byId: 'ui', skills: [] }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_BAD_FIELD',
  )
  assert.throws(
    () => env.roster.linkSkills({ id: bot.id, expectedRev: 9, byId: 'ui', skills: ['ok'] }),
    (e) => e instanceof RosterError && e.code === 'ROSTER_REV_CONFLICT',
  )
  // 失败后档案未被改动（坏技能名不能留下半个关联）
  assert.equal(env.roster.get(bot.id).rev, 1)
  assert.equal(env.roster.get(bot.id).profile, undefined)
})

// ── 9. 老档案向后兼容（读旧数据不报错、写新字段不丢旧字段）──────────────────

test('老档案向后兼容：只有旧五字段的 profile 读写都正常，无新节', async (t) => {
  const env = setup(t)
  const legacy = {
    identity: '我是 2026 年的老 Bot',
    experience: '老规矩',
    skills: ['review'],
    workflows: ['w1'],
    memory: ['老记忆'],
  }
  const bot = await seedBot(env, { profile: legacy })

  const got = env.roster.getProfile(bot.id)
  assert.equal(got.bot.profile.identity, legacy.identity)
  assert.equal(got.bot.profile.title, undefined, '老档案不该凭空长出 title')
  assert.match(got.managedText, /我是 2026 年的老 Bot/)
  assert.ok(!got.managedText.includes('## 人格设定'), '老档案的 AGENTS.md 不该多出空节')

  // 老档案上加新字段：旧字段必须原样保留
  const updated = env.roster.setProfile({
    id: bot.id,
    expectedRev: bot.rev,
    byId: 'ui',
    profile: { persona: '新增人格', disciplineIds: ['d-legacy'] },
  })
  assert.equal(updated.profile.identity, legacy.identity)
  assert.equal(updated.profile.persona, '新增人格')
  assert.deepEqual(updated.profile.memory, ['老记忆'])
  const md = managedText(bot.cwd)
  assert.match(md, /## 人格设定/)
  assert.match(md, /`d-legacy`/)
  assert.match(md, /我是 2026 年的老 Bot/)
})

test('手写的旧式受管区块（无新字段渲染）可读回，不报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-bots-rich-legacy-'))
  try {
    const file = join(dir, AGENTS_FILE)
    const legacyManaged = `${MARK_BEGIN}\n\n# 你的身份（由 cs-bots 维护）\n\n- 角色名：**老 Bot**\n\n我是老身份\n\n${MARK_END}\n`
    writeFileSync(file, `用户前置说明\n\n${legacyManaged}`, 'utf8')

    const read = readAgentsFile(dir)
    assert.equal(read.exists, true)
    assert.match(read.managed, /我是老身份/)
    assert.match(read.outside, /用户前置说明/)

    // 用新渲染器覆盖旧受管区块：用户段外内容保留，且新字段进来
    writeAgentsFile(dir, { botName: '老 Bot', title: '新岗位', identity: '我是老身份' })
    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /用户前置说明/)
    assert.match(raw, /## 新岗位/)
    assert.equal(raw.split(MARK_BEGIN).length - 1, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cwd 归一化：getProfile 返回绝对路径的 AGENTS.md 位置', async (t) => {
  const env = setup(t)
  const bot = await seedBot(env, { profile: { identity: 'x' } })
  const got = env.roster.getProfile(bot.id)
  assert.equal(got.profilePath, join(resolve(bot.cwd), AGENTS_FILE))
})
