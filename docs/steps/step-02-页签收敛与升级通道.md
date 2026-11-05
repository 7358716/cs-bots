# Step 02 · 页签收敛（11 → 7）与「待办 → 任务」升级通道

## 1. 代码层实现（`src/client.js`）

### 页签结构改为「主页签 + 子视图」
```js
TABS = [
  { id:'tasks',  label:'任务', subs:[
      {id:'board',    label:'协作看板', Comp:TasksTab},
      {id:'todo',     label:'我的待办', Comp:TodoTab},
      {id:'scratch',  label:'便签',     Comp:ScratchTab} ] },
  { id:'bots',     label:'Bot' },
  { id:'rooms',    label:'房间' },
  { id:'memory',   label:'记忆', subs:[
      {id:'facts',    label:'事实与偏好', Comp:MemoryTab},
      {id:'rules',    label:'纪律与要求', Comp:DisciplineTab},
      {id:'prompts',  label:'提示词',     Comp:PromptsTab} ] },
  { id:'skills',   label:'技能库' },
  { id:'workflows',label:'工作流库' },
  { id:'settings', label:'设置' },
]
```
- `viewsOf(tab)`：单页页签返回 `[自身]`；`subs.length > 1` 才渲染子页签行。
- 切主页签时 `setView(null)`，避免「停在任务/便签，切到记忆还是便签」的串位 bug。
- ErrorBoundary 的 `tab` 名带上子视图（`记忆/纪律与要求`），出错时能定位到具体子页。

**结果：页签数 7，与 v0.1.1 原架构一致。**

## 2. 「待办 → 任务」升级通道（新增，不是搬位置）

原架构里没有这条通道，直接把待办塞进任务页只会是「换了个位置」。真正的关系是
**漏斗上下游**：便签（想到就记）→ 待办（决定要做）→ 任务（决定交给谁做）。
所以补了服务端一步：

`POST /todos/promote { id, expectedRev?, priority?, by? }`
1. 取待办 → 用第一行做任务标题、全文做描述、截止日转 `dueAt`；
2. `board.create({ sourceSeq: 'todo:<id>' })` —— **幂等**，连点两次只产生一个任务；
3. 待办状态 `pending → doing`（不再出现在「要关注」里被重复安排）；
4. 返回 `{ task, todo }`。

### 实测（真跑，非自述）
```
建待办: td-5fc328e7 状态= pending
升级#1: 200 | task= 把发布流程写成脚本 | 待办状态= doing
升级#2 幂等: 200 | 同一任务= true
任务总数: 1 （应为 1）
```

## 3. UI 文案（人话）
- 待办页标题「我的待办」，说明里点明「要交给 Bot 或别人做的，点「派下去」就会出现在「协作看板」里」；
- 按钮叫 **「派下去」** 而不是「升级为任务」——用户心智里这是"派活"，不是"改类型"。
