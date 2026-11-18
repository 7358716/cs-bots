/**
 * 0.20.1 缺陷回归 —— 全部来自 Boss 2026-11-18 在 Win 桌面版上的实测。
 *
 * ## 这一轮修的六件事（每条都对应一句用户原话）
 *
 *   1「点击插件发布管理员，选择有误」
 *      → 派活下拉的默认值取自 `dept.bots[0]`，跟你点的人无关；
 *        任务栏还写「负责人（自动）」，但空串根本不发后端 ⇒ 静默建无人任务。
 *   2「点击新建，管理部门弹窗点击保存」报「还有 14 个 Bot」
 *      → 「＋ 新建」把草稿重置成只剩一个空部门 ⇒ 保存 = 删掉全部部门。
 *   3「新增部门就是一个字段，字段名称作为目录名称」
 *   4「主管应该选择，也可以选择其他没有在其他部门的 bot」
 *       → 原为手填文本框，Bot 改名后静默失效。
 *   5「删除部门前要校验并给弹窗，而不是在之后的页面展示」
 *   6「管理部门是要管理部门人员，对 bot 的增删改查，同步 bot 档案」
 *       → 弹窗里根本没有人员。
 *
 * ## 为什么用源码断言而不是渲染断言
 *
 *   client.js 是浏览器 bundle，`require('react')` 在这里拿不到 React 实例，
 *   做完整渲染要造一整套 shim（项目既有测试也是这个口径，见 client-*.test.mjs）。
 *   本文件断言**关键实现存在且旧缺陷写法已消失**，运行期行为由 win-regress 与人工验收覆盖。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = readFileSync(join(HERE, '..', 'src', 'client.js'), 'utf8')
const API = readFileSync(join(HERE, '..', 'src', 'api.js'), 'utf8')

/** 取某个函数体（从签名到下一个同级函数定义）——用于「局部断言」。 */
function fnBody(src, signature) {
  const start = src.indexOf(signature)
  assert.ok(start >= 0, `找不到函数：${signature}`)
  const rest = src.slice(start + signature.length)
  const next = rest.search(/\n {4}(?:async )?function |\n {4}\/\*\*/)
  return next < 0 ? rest : rest.slice(0, next)
}

// ── 1. 派活执行者选择 ───────────────────────────────────────────────────────
test('★1 派活下拉：按部门分组，且能看出是哪个部门的人', () => {
  const body = fnBody(CLIENT, 'function BotPicker(')
  assert.match(body, /optgroup/, '要分组渲染')
  assert.match(body, /本部门「/, '本部门单独一组')
  assert.match(body, /未指定（不派）/, '空值文案必须是「未指定（不派）」')
  assert.match(body, /title: b\.cwd/, '每项要带 cwd 提示，重名才分得清')
})

test('★1 派活默认值：只认「你点进来的那个 Bot」，不再取队列第一个', () => {
  assert.ok(
    !/assignee:\s*dept\?\.bots\?\.\[0\]\?\.sessionId/.test(CLIENT),
    '不许再出现 dept.bots[0] 作为默认派活对象',
  )
  assert.match(CLIENT, /fromBotId: activeBot\.id/, 'Bot 卡片入口要记录来源 Bot')
  assert.match(CLIENT, /leadBotOf\(dept\)\?\.sessionId/, '群聊入口默认 = 本部门主管')
})

test('★1 虚假的「负责人（自动）」必须消失', () => {
  assert.ok(!/负责人（自动）/.test(CLIENT), '「自动」并不存在，不能继续显示')
  assert.match(CLIENT, /未指定（不派）/, '替换成真实语义')
})

test('★1 派活按钮文案必须与行为一致', () => {
  assert.match(CLIENT, /assignForm\.assignee \? '创建并派活' : '仅创建任务（不派）'/, '没选人就不能写「派活」')
})

test('★1 跨部门派活要显式提示', () => {
  assert.match(CLIENT, /不是本部门的 Bot/, '选到别的部门的人必须喊出来')
})

// ── 2. 「＋ 新建」不再清空列表 ───────────────────────────────────────────────
test('★2 「＋ 新增部门」是追加，不是重置（原来点击新建会误判为删全部部门）', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /setDraft\(\[\.\.\.draft, \{ id: '', name: '' \}\]\)/, '必须基于现有 draft 追加')
  // 空状态（depts.length===0）下重置成一行空行是正确行为；只禁止「已有部门时」重置
  const resetAt = [...CLIENT.matchAll(/setDeptDraft\(\[\{ id: '', name: '' \}\]\)/g)].length
  const withDepts = [...CLIENT.matchAll(/setDeptDraft\(\[\.\.\.depts\.map/g)].length
  assert.equal(resetAt, 1, `「只有一个空行」的写法只允许出现在空状态，实际 ${resetAt} 处`)
  assert.ok(withDepts >= 1, '有部门时必须带上现有部门')
})

// ── 3. 单字段即目录名 ───────────────────────────────────────────────────────
test('★3 新增部门只有一个字段，名字即目录名', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /部门名（就是目录名/, '要明说名字即目录名')
  assert.ok(!/placeholder: 'id（英文）'/.test(body), '不再有独立的 id 输入框')
})

// ── 4. 主管改为下拉 ─────────────────────────────────────────────────────────
test('★4 主管是下拉选择，且候选含「未归属部门的 Bot」', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /leadBotName/, '字段仍是 leadBotName（后端契约不变）')
  assert.match(body, /未归属部门的 Bot/, 'Boss 明确要求能选不在其他部门的 Bot')
  assert.match(body, /没有主管，说话唤醒全部/, '留空的含义要写清楚')
  assert.ok(!/placeholder: '填这个部门当主管/.test(body), '不再是手填')
})

test('★4 主管按名字找不到时降级为空，绝不静默挑第一个', () => {
  const body = fnBody(CLIENT, 'const leadBotOf = ')
  assert.match(body, /return null/, '找不到就返回 null')
  assert.ok(!/bots\?\.\[0\]/.test(body), '不许拿第一个 Bot 顶替主管')
})

// ── 5. 删部门前置校验 ───────────────────────────────────────────────────────
test('★5 删除部门：先校验再弹窗，不在保存后才报错', () => {
  // 0.20.3：拦截/确认弹窗上提到 DeptTab，断言改为「两处各司其职」
  const modal = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(modal, /onRequestDelete/, '部门弹窗把删除请求交给上层判断')
  assert.ok(!/直接 setDraft\(draft\.filter/.test(modal), '部门弹窗不得自己直接删（必须经过校验）')
  assert.match(CLIENT, /不能删除「\$\{delBlock\.name\}」/, '有 Bot 时前置拦截')
  assert.match(CLIENT, /去迁移这些 Bot/, '拦截后给出迁移入口')
  assert.match(CLIENT, /确认删除部门/, '无 Bot 时二次确认')
  assert.match(CLIENT, /磁盘上的目录文件不会删/, '必须说清目录不删')
})

test('★5 后端：保存时仍自校验一遍，并回报「这次删了谁」', () => {
  assert.match(API, /removed: removedNames/, '响应里要明确列出被删部门')
  const body = API.slice(API.indexOf("path === '/departments/save'"))
  assert.match(body.slice(0, 6000), /DEPT_HAS_BOTS/, '有 Bot 仍要拒绝（多端并发兜底）')
})

test('★5 部门改名要全盘联动，且不偷偷改磁盘目录', () => {
  const body = API.slice(API.indexOf("path === '/departments/save'")).slice(0, 14000)
  assert.match(body, /services\.room\.update/, '群聊改名走 room.update')
  assert.match(body, /磁盘目录没有改名/, '磁盘目录不重命名，必须如实告知')
})

// ── 6. 部门人员管理 ─────────────────────────────────────────────────────────
test('★6 部门弹窗里能管理人员：列 Bot / 改档案 / 移出 / 退役 / 新建', () => {
  assert.match(CLIENT, /renderDeptMembers/, '要有人员管理渲染')
  const body = fnBody(CLIENT, 'const renderDeptMembers = ')
  assert.match(body, /'档案'/, '能打开档案')
  assert.match(body, /'退役'/, '能退役')
  assert.match(body, /移到部门…/, '能迁出本部门')
  assert.match(body, /在本部门新建 Bot/, '能在本部门新建')
})

test('★6 改档案复用同一个抽屉 —— 规则只有一份，不存在两套表单', () => {
  assert.match(CLIENT, /h\(BotProfileDrawer, \{\s*\n\s*bot,/, '人员管理里直接挂 BotProfileDrawer')
  // 全文件只允许一个档案编辑组件定义
  const defs = CLIENT.match(/function BotProfileDrawer\(/g) ?? []
  assert.equal(defs.length, 1, `档案编辑组件必须唯一，实际 ${defs.length} 个`)
  // 保存都走同一个端点
  const saveSites = CLIENT.match(/call\('\/roster\/profile'/g) ?? []
  assert.ok(saveSites.length >= 1, '档案保存走 POST /roster/profile')
})

test('★6 退役是二次确认，且说明「目录与档案保留」', () => {
  assert.match(CLIENT, /退役 ≠ 删除/, '要说明语义')
  assert.match(CLIENT, /确认退役/, '要二次确认')
})

// ── 组装口径唯一 ────────────────────────────────────────────────────────────
test('Bot 按部门归类的组装只有一个函数（口径唯一）', () => {
  const defs = CLIENT.match(/function groupBotsByDept\(/g) ?? []
  assert.equal(defs.length, 1, '只允许一个组装函数')
  const body = fnBody(CLIENT, 'function groupBotsByDept(')
  assert.ok(!/startsWith\(`\$\{root\}\/`\)/.test(body), '不能写死正斜杠前缀（Win 会错）')
  // 目标行：const norm = (x) => String(x ?? '').replace(/\\/g, '/') …
  assert.ok(body.includes(".replace(/\\\\/g, '/')"), '要先归一分隔符再比（Win 的反斜杠）')
})
// ── 0.20.3 回归：Modal 不许嵌套（0.20.2 卡死的根因）─────────────────────────
test('★0.20.3 部门管理弹窗里不许再出现第二个 Modal（会导致弹窗套弹窗卡死）', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  const modals = body.match(/h\(Modal/g) ?? []
  assert.equal(modals.length, 1, `DeptManageModal 必须只返回一个 Modal，实际 ${modals.length} 个`)
  // 不允许把子框当 children 传进去（原写法：h(Modal, {...}, 内容, 确认框, 拦截框)）
  assert.ok(!/onMigrate|blockDel|confirmDel/.test(body), '删除拦截/确认框已上提到 DeptTab，不该留在子组件')
})

test('★0.20.3 删除拦截 / 删除确认 / 部门人员都由 DeptTab 各自渲染为顶层 Modal', () => {
  for (const [name, sig] of [
    ['delBlock', 'delBlock'],
    ['delConfirm', 'delConfirm'],
    ['membersFor', 'membersFor'],
  ]) {
    assert.ok(CLIENT.includes(`const [${name}, set`), `${name} 状态要挂在 DeptTab`)
  }
  assert.match(CLIENT, /不能删除「\$\{delBlock\.name\}」/, '拦截弹窗文案在 DeptTab 里')
  assert.match(CLIENT, /确认删除部门「\$\{delConfirm\.name\}」/, '确认弹窗文案在 DeptTab 里')
  assert.match(CLIENT, /部门人员 · \$\{depts\.find/, '人员弹窗标题在 DeptTab 里')
})

test('★0.20.3 管理部门弹窗必须有可用的关闭路径（取消按钮 + onClose）', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /onClose,/, '必须接 onClose')
  assert.match(body, /'取消'/, '必须有取消按钮')
  assert.match(body, /'保存'/, '必须有保存按钮')
})

// ── 0.20.5 回归：弹窗必须挂到 body、ESC 稳定、保存结果在弹窗里 ────────────────
test('★0.20.5 弹窗用 createPortal 挂到 body（祖先带 transform/overflow 也不会点不到）', () => {
  const body = fnBody(CLIENT, 'function Modal(')
  assert.match(body, /ReactDOM\.createPortal/, '必须 portal 到 body')
  assert.match(body, /document\.body/, '容器是 document.body')
  assert.match(CLIENT, /require\('react-dom'\)/, 'react-dom 由宿主模块表提供（已核实）')
})

test('★0.20.5 弹窗 ESC 监听只绑一次，通过 ref 调最新回调', () => {
  const body = fnBody(CLIENT, 'function Modal(')
  assert.match(body, /closeRef\.current = onClose/, '回调存 ref')
  assert.match(body, /\[\]\)/, 'ESC 监听的依赖是空数组（只绑一次）')
  // 同步 ref 的那个 effect 用 [onClose] 是对的；错的是把 ESC 监听依赖写成 [onClose]
  const esc = body.slice(body.indexOf("window.addEventListener('keydown'"))
  assert.ok(!/\}, \[onClose\]\)/.test(esc), 'ESC 监听的依赖不能是 [onClose]')
})

test('★0.20.5 遮罩只在点遮罩本身时关闭', () => {
  // 0.20.6 起改成原生监听：判据从 e.currentTarget 换成 e.target === 遮罩元素本身
  const body = fnBody(CLIENT, 'function Modal(')
  assert.match(body, /e\.target === el/, '只认点在遮罩本身（不是里面的卡片）')
})

test('★0.20.5 保存结果渲染在弹窗内部，不在被遮住的页面上', () => {
  const body = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(body, /\bmsg\b/, '弹窗要接 msg')
  assert.match(body, /h\(Notice, \{ kind: msg\.kind/, '在弹窗顶部渲染结果')
  // 原来 catch 里写 setMsg(...) 会把错误送去页面
  const save = fnBody(CLIENT, 'const saveDepts = async')
  assert.match(save, /setManageMsg\(\{ kind: 'err'/, '错误要进弹窗状态')
  assert.ok(!/catch \(e\) \{\s*setMsg\(\{ kind: 'err', text: `保存部门失败/.test(save), '不许再把保存错误写到页面')
})

test('★0.20.5 保存前做前端自查（空名/分隔符/重名）', () => {
  const save = fnBody(CLIENT, 'const saveDepts = async')
  assert.match(save, /含路径分隔符|名字是空的|重复了/, '本地先拦常见错误')
})

// ── 0.20.6：宿主捕获阶段拦截时，弹窗仍必须关得掉 ────────────────────────────
test('★0.20.6 弹窗关闭走原生监听（不受宿主根容器事件委托影响）', () => {
  const body = fnBody(CLIENT, 'function Modal(')
  assert.match(body, /addEventListener\('mousedown'/, '遮罩用原生 mousedown 兜底')
  // 0.20.8 起不再用 click（宿主下 click 命中会漂移），改成 mousedown 记住 + mouseup 执行
  assert.match(body, /data-csb-close/, '关闭标记保留')
  assert.match(body, /removeEventListener\('mousedown'/, '必须清理监听')
  assert.match(body, /data-csb-close/, '× 按钮带原生监听可识别的标记')
  assert.match(body, /ref: maskRef/, '遮罩要有 ref 供原生绑定')
})

// ── 0.20.7：Esc 也关不掉 ⇒ 上探针 + 捕获阶段监听 ────────────────────────────
test('★0.20.7 ESC 监听必须在捕获阶段（宿主在冒泡阶段前拦截时仍能收到）', () => {
  const body = fnBody(CLIENT, 'function Modal(')
  assert.match(body, /document\.addEventListener\('keydown', onKey, true\)/, 'document 捕获监听')
  assert.match(body, /window\.addEventListener\('keydown', onKey, true\)/, 'window 捕获监听')
  assert.match(body, /__csbModalDiag/, '记录是否真的收到 ESC，便于一次定位')
})

test('★0.20.7 装了底层事件探针（区分「事件没到」还是「回调没跑」）', () => {
  assert.match(CLIENT, /function installDiagProbe/, '要有探针函数')
  const body = fnBody(CLIENT, 'function installDiagProbe(')
  for (const k of ['pointerdown', 'mousedown', 'click', 'keydown']) {
    assert.ok(body.includes(`'${k}'`), `要监听 ${k}`)
  }
  assert.match(body, /__csbModalDiag/, '结果挂到 window.__csbModalDiag')
  assert.match(CLIENT, /installDiagProbe\(\)/, 'apply 里要真正装上')
})

// ── 0.20.8：click 命中漂移 ⇒ 按下记住、抬起执行 ────────────────────────────
test('★0.20.8 关闭按钮在 mousedown 记住、mouseup 执行（不依赖 click 命中）', () => {
  const body = fnBody(CLIENT, 'function Modal(')
  assert.match(body, /document\.addEventListener\('mousedown', onDown, true\)/, 'mousedown 需要记录')
  assert.match(body, /document\.addEventListener\('mouseup', onUp, true\)/, 'mouseup 执行')
  assert.match(body, /armed = pick\(e\.target\)/, '按下时记住命中的关闭元素')
  assert.match(body, /const hit = pick\(e\.target\) \?\? armed/, '抬起时优先用记录值')
  assert.ok(!/el\.addEventListener\('click'/.test(body), '不再只依赖 click')
})

test('★0.20.8 弹窗主按钮（取消/保存等）走 data-csb-act 原生兜底', () => {
  const body = fnBody(CLIENT, 'function Modal(')
  assert.match(body, /data-csb-act/, '识别动作标记')
  assert.match(body, /actions\[name\]/, '按名字调用调用方给的动作')
  const dept = fnBody(CLIENT, 'function DeptManageModal(')
  assert.match(dept, /'data-csb-act': 'cancel'/, '取消按钮带标记')
  assert.match(dept, /'data-csb-act': 'save'/, '保存按钮带标记')
  assert.match(dept, /actions: \{ cancel: onClose, save: onSave \}/, '要把动作表交给 Modal')
})

// ── 0.20.9：文档级原生触发（不依赖弹窗自身 effect 与 React onClick）──────────
test('★0.20.9 关闭/动作元素挂载可直接调用的函数引用', () => {
  const body = fnBody(CLIENT, 'function Modal(')
  assert.match(body, /__csbClose/, '关闭元素挂 __csbClose')
  assert.match(body, /__csbAct/, '动作元素挂 __csbAct')
  assert.match(body, /data-csb-modal/, '卡片带标记便于定位')
})

test('★0.20.9 文档级处理器三阶段兜底（mousedown/mouseup/click 全捕获）', () => {
  assert.match(CLIENT, /function installNativeTrigger/, '要有文档级处理器')
  const body = fnBody(CLIENT, 'function installNativeTrigger(')
  for (const k of ['mousedown', 'mouseup', 'click']) {
    assert.ok(body.includes(`'${k}'`), `要监听 ${k}`)
  }
  assert.match(body, /capture|, true\)/, '必须捕获阶段')
  assert.match(body, /__csbLastFire/, '同一次点击只执行一次（去重）')
  assert.match(CLIENT, /installNativeTrigger\(\)/, 'apply 里要装上')
})

// ── 0.20.9：空状态下也要能导入/导出（新机器唯一救回路径）──────────────────
test('★0.20.9 空状态（还没有部门）也要有导入/导出入口', () => {
  const empty = CLIENT.slice(
    CLIENT.indexOf("if (depts.length === 0) {"),
    CLIENT.indexOf('// ── 正常：左侧树 + 右侧详情'),
  )
  assert.match(empty, /'⬆ 导入'/, '空状态要有导入按钮')
  assert.match(empty, /'⬇ 导出'/, '空状态要有导出按钮')
  assert.match(empty, /setImportOpen\(true\)/, '按钮要真的打开导入弹窗')
  assert.match(empty, /h\(TransferImportModal/, '空状态要渲染导入弹窗')
  assert.match(empty, /h\(TransferExportModal/, '空状态要渲染导出弹窗')
})
