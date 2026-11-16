/**
 * 部门树 UI 契约（2026-11-16 Boss：「先做个 UI 页面出来，尽量完整让我验证」）。
 *
 * ## 必须守住的行为
 *   1. **初始为空时不造假层级** —— Boss：「初始不需要 cs-bots」
 *   2. 有部门时画树：部门行 + 可折叠 + Bot 子节点
 *   3. 点部门能进群聊，点 Bot 能看详情 / 派活
 *   4. 建部门/改/删有独立弹窗
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')

/** 把 DeptTab 函数体切出来。 */
function body(name) {
  const start = SRC.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} 应存在`)
  // 从 `function name(` 往下找到配对的收尾：用「下一个同级 function」作边界
  const re = /^    function [A-Z][A-Za-z0-9_]*\(/gm
  re.lastIndex = start + 10
  const m = re.exec(SRC)
  return SRC.slice(start, m ? m.index : SRC.length)
}

const DEPT = body('DeptTab')
const MANAGE = body('DeptManageModal')

test('★ 空状态：没有部门时**不造假层级**，只给引导', () => {
  assert.match(DEPT, /还没任何部门|还没有任何部门/, '要有空状态文案')
  assert.match(DEPT, /if \(depts\.length === 0\)/, '要有空状态分支')
  assert.match(DEPT, /＋ 新建第一个部门|新建第一个部门/, '空状态要给创建入口')
})

test('树：部门行可折叠，0 个 Bot 时不显示可折叠箭头', () => {
  assert.match(DEPT, /collapsed\[d\.id\]/, '要有折叠状态')
  assert.match(DEPT, /d\.bots\.length \? \(isCollapsed \? '▶' : '▼'\) : '·'/, '0 个 Bot 显示占位点而不是箭头')
})

test('树：Bot 是部门的子节点（缩进显示）', () => {
  assert.match(DEPT, /marginLeft: 22/, 'Bot 子节点要缩进')
  assert.match(DEPT, /d\.bots\.map\(/, '要遍历该部门的 Bot')
})

test('树：显示每个部门的 Bot 数量', () => {
  assert.match(DEPT, /\$\{d\.bots\.length\}/, '部门行要显示 Bot 数')
})

test('交互：点部门选中并清空旧群聊，点 Bot 看详情', () => {
  assert.match(DEPT, /setSelected\(\{ type: 'dept', id: d\.id \}\)/, '点部门要选中')
  assert.match(DEPT, /setSelected\(\{ type: 'bot', id: b\.id \}\)/, '点 Bot 要选中')
})

test('群聊：能打开、能发言、能安排工作', () => {
  assert.match(DEPT, /\/departments\/ensure/, '要有打开群聊的动作')
  assert.match(DEPT, /\/rooms\/messages/, '读消息用正确端点（不是 /rooms/read）')
  assert.match(DEPT, /\/rooms\/post/, '要能发言')
  assert.match(DEPT, /＋ 安排工作/, '要有安排工作入口')
})

test('部门管理：新建/改名/删除都在独立弹窗里', () => {
  assert.match(DEPT, /DeptManageModal/, '要复用 DeptManageModal')
  assert.match(MANAGE, /id（英文）/, '要能填目录名')
  assert.match(MANAGE, /显示名/, '要能填显示名')
  assert.match(MANAGE, /＋ 新增/, '要有新增按钮')
  assert.match(MANAGE, /删除部门前要先把它下面的 Bot 迁走/, '要提示删除约束')
})

test('部门管理：保存走 /departments/save（有 Bot 不许删的保护在后端）', () => {
  assert.match(DEPT, /\/departments\/save/, '保存端点')
  assert.match(DEPT, /r\.warnings/, '要展示后端返回的警告')
})

// ── 拖拽与批量换部门（2026-11-16 Boss：「加拖拽和批量」）─────────────────────

test('★ 换部门：路径由后端 join 拼，前端不手拼（跨平台纪律）', async () => {
  const api = (await import('node:fs')).readFileSync(
    join(HERE, '..', 'src', 'api.js'), 'utf8',
  )
  assert.match(api, /case 'moveToDept'/, '后端要有 moveToDept')
  assert.match(api, /const nextCwd = join\(root, deptId, leaf\)/, '必须用 join')
  // 前端不该再出现手拼 root/deptId/leaf
  assert.ok(
    !/\$\{root\}\/\$\{deptId\}\/\$\{leaf\}/.test(SRC),
    '前端不该手拼路径（Windows 上会得到混合分隔符）',
  )
})

test('拖拽：Bot 可拖，部门行可接，悬停有高亮', () => {
  assert.match(DEPT, /draggable: true/, 'Bot 行要可拖')
  assert.match(DEPT, /onDragStart/, '要有 dragstart')
  assert.match(DEPT, /onDragOver/, '部门行要能接收')
  assert.match(DEPT, /onDrop/, '要有 drop 处理')
  assert.match(DEPT, /preventDefault\(\)/, 'dragover 必须 preventDefault 否则浏览器不允许 drop')
  assert.match(DEPT, /dragOver === d\.id/, '悬停高亮')
})

test('批量：Bot 行有复选框，勾选不触发选中', () => {
  assert.match(DEPT, /type: 'checkbox'/, '要有复选框')
  assert.match(DEPT, /e\.stopPropagation\(\)/, '点复选框不该触发选中')
  assert.match(DEPT, /checked\[b\.id\]/, '勾选状态按 botId 记')
})

test('批量：有勾选时出现操作条，能选目标部门', () => {
  assert.match(DEPT, /checkedIds\.length > 0/, '有勾选才显示')
  assert.match(DEPT, /已选 \$\{checkedIds\.length\} 个/, '显示已选数量')
  assert.match(DEPT, /移到部门…/, '有目标部门下拉')
  assert.match(DEPT, /moveBots\(checkedIds, target\)/, '批量移动')
})

test('批量：串行执行并逐个上报失败（不许一个失败全中断）', () => {
  assert.match(DEPT, /const failed = \[\]/, '要收集失败')
  assert.match(DEPT, /for \(const id of botIds\)/, '逐个移动')
  assert.match(DEPT, /失败 \$\{failed\.length\} 个/, '失败要报出来')
})

// ── 历史部门提示（2026-11-16 Boss 方案B：保留 + 给提示）────────────────────

test('历史部门：有 /departments/legacy 端点，只识别旧内置 id', async () => {
  const api = (await import('node:fs')).readFileSync(join(HERE, '..', 'src', 'api.js'), 'utf8')
  assert.ok(api.includes("path === '/departments/legacy'"), '端点要存在')
  assert.match(api, /LEGACY_IDS = \['dev', 'qa', 'ops', 'misc'\]/, '只认这 4 个旧 id')
})

test('历史部门：不清空，只提示；有 Bot 时禁止清空', async () => {
  const api = (await import('node:fs')).readFileSync(join(HERE, '..', 'src', 'api.js'), 'utf8')
  assert.match(api, /canClear: detail\.every\(\(x\) => x\.botCount === 0\)/, '有 Bot 就不许清')
  assert.match(api, /这些部门里还有 Bot，清空前要先把 Bot 移到别处/, '要给出可操作的原因')
})

test('历史部门 UI：默认保留，清空是显式动作', () => {
  assert.match(DEPT, /历史部门/, 'UI 要有提示')
  assert.match(DEPT, /知道了，保留/, '默认动作是保留')
  assert.match(DEPT, /全部清空/, '清空是另一个显式按钮')
  assert.match(DEPT, /还有 Bot，不能清空/, '有 Bot 时按钮禁用并说明原因')
})

// ── 部门主管（2026-11-16 Boss：必须人工设置）───────────────────────────────

test('★ 主管：管理部门弹窗里能人工填主管名字', () => {
  assert.match(MANAGE, /主管/, '要有主管字段')
  assert.match(MANAGE, /leadBotName/, '字段名 leadBotName')
  assert.match(MANAGE, /留空=没有主管，说话唤醒全部/, '要说明留空的含义')
  assert.match(MANAGE, /填 Bot 的名字（不是 id）/, '要说清填名字不是 id')
})

test('★ 主管：后端不自动取第一个 Bot', async () => {
  const dt = (await import('node:fs')).readFileSync(join(HERE, '..', 'src', 'depttree.js'), 'utf8')
  assert.ok(!/inDept\[0\]/.test(dt), '不许出现 inDept[0]（自动取第一个）')
  assert.match(dt, /wantedLead/, '要按 leadBotName 查')
})

test('★ 唤醒规则：部门群聊带 deptId，主管优先于广播', async () => {
  const room = (await import('node:fs')).readFileSync(join(HERE, '..', 'src', 'room.js'), 'utf8')
  assert.match(room, /if \(settings\.deptId\)/, '部门群聊走专用分支')
  assert.match(room, /source: 'dept-lead'/, '有主管只唤醒主管')
  assert.match(room, /source: 'dept-broadcast'/, '没主管广播')
  assert.match(room, /deptId: null/, 'DEFAULT_SETTINGS 要有 deptId')
})
