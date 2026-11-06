# 契约 · bots改造06：任务变更中心（纠错 / 优化 / 转长任务 / 换负责人）

> 状态：**已冻结**（2026-11-06）。改动需先改本文件。
> 用户原话：「完成的任务应该可以纠错或者优化或者更改或其他变更，变更成长任务」「任务可以变更负责人」。

---

## 0. 设计前提（先看这条，否则会做错）

任务板把「**承诺**」建模成：`subject + description`（目标锚，创建即冻结）+ 状态机
（pending / in_progress / completed / blocked / deleted）+ `artifacts`（交付证据）+ `acceptance`（验收）。

**已完成的任务一旦 `reopen`，`board.reopen` 会清掉 `artifacts` / `acceptance` / `completedAt`。**
这是内核行为，不能改（`board.js` 冻结）。但我们**不能因此丢掉证据** ——
上一轮交付了什么，是「纠错」和「优化」唯一的判据。

⇒ 本改造的解法：**变更前先把「当时的样子」快照进旁路文件**，再由人选择变更方式。

`task-meta.jsonl`（新增，append-only）记录「变更动作」，同时充当
① 上一轮证据的快照 ② 变更历史 ③ 长任务标记。

---

## 1. 写作用域

| 文件 | 归属 | 规则 |
|---|---|---|
| `src/api.js` | 后端 | 只新增端点/helper；不得改已有端点行为 |
| `src/client.js` | 前端 | 只新增/接线；`resolveOwnerBot` 已由 Lead 修好，不要动 |
| `test/api-evolve.test.mjs` | 后端 | 新建 |
| `test/client-evolve.test.mjs` | 前端 | 新建 |

**禁止改动**：`board.js`、`room.js`、`store.js`、`dispatcher.js`、`roster.js`、`index.js`、`kernel.js`、`client.js` 的 `resolveOwnerBot` 与 `gotoOwner`。

---

## 2. 后端

### 2.1 `POST /tasks/reassign` —— 变更负责人（用户诉求 #3）

请求体：
```json
{ "id": "t-27", "ownerId": "bot-xxx", "leaseMs": 300000, "wake": true, "byId": "ui" }
```

流程（**每一步都要能解释失败，不许静默跳过**）：
1. 任务不存在 → 404；`ownerId` 缺 → 400。
2. 任务已 `completed` → 400 `{ok:false,reason:"任务已完成，请先「重开」或「派生优化单」再换负责人",code:"TASK_COMPLETED"}`
   （与 `board.claim` 的 `BOARD_ALREADY_COMPLETED` 一致，别让用户撞底层报错）
3. 当前有**未过期租约且持有者不是新负责人** → 先以**原持有者身份** `release`
   （平台是操作者，代表原负责人交还；`board.release` 要求 `byId===lease.ownerId`，所以传原 ownerId）。
4. `claim`（`byId = 新 ownerId`，`force: true` 绕过 blockedBy 未完成）。
   - WIP 超限 → 把 `BOARD_WIP_LIMIT` 原样回传（附人话提示），不要吞。
5. `ensureLive(新 ownerId)` → `dispatcher.notify`（`reason: 'task-assigned'`,
   `dedupKey: 'task-reassign:<id>:<rev>'`, `text = 完整锚定文案`）。
6. 往 `task-meta.jsonl` 记一条 `{kind:'reassign', taskId, from, to, by, at}`。
7. 返回 `{ ok:true, task, from, to, revived, reviveReason?, wake }`。

### 2.2 `POST /tasks/evolve` —— 变更中心（用户诉求 #2）

请求体：
```json
{ "id": "t-26", "mode": "reopen|followup|longrun", "note": "第 3 条标准未满足", "byId": "ui", ... }
```

`note`（变更说明）在三种模式下都必填（trim 后 1–4000）——**没有理由的变更不许进历史**。

#### mode=`reopen`（纠错 / 继续做）
1. 快照当前状态进 `task-meta.jsonl`：`{kind:'snapshot', taskId, at, before:{status,artifacts,acceptance,completedAt,progress,ownerId}}`
2. `board.update({action:'reopen'})`（已 pending 且无租约时，`reopen` 会抛 `BOARD_NOTHING_TO_REOPEN`
   → 这种情况**视为成功**，直接进第 3 步，不要报错）
3. 记 `{kind:'reopen', taskId, note, by, at}`
4. 返回 `{ ok:true, task, snapshot, note:"已重开；上一轮交付物已存档，见 changes" }`

#### mode=`followup`（优化 / 修复单：原任务保持已完成）
1. 派生新任务：`board.create({ subject: '【<前缀>】<原 subject>', description: <原 description + 变更说明 + 来源>, sourceSeq: 'evolve:<原id>:<seq>' })`
   - 前缀规则：`note` 里含「错/缺陷/bug/修复」→ `【修复】`；含「优化/提升/改进」→ `【优化】`；否则 `【变更】`
   - `blockedBy` 默认不含原任务（原任务已完成，加了也不会卡）
   - `priority` 继承原任务；`assignee` 继承原任务 `assignee ?? ownerId`（若有）
2. 记 `{kind:'followup', taskId: 原id, newTaskId, note, by, at}`
3. 返回 `{ ok:true, task: 新任务, origin: 原id, prefix, note:"已派生 <newId>（幂等键 evolve:<原id>:<seq>，重复点不会建两个）" }`

#### mode=`longrun`（转成长任务）
1. `phases` 可选：字符串数组（每项 1–200 字，最多 12 项）。没给就按默认三阶段：
   `['范围与验收标准确认', '执行与自测', '交付与复盘']`
2. 记 `{kind:'longrun', taskId, phases, note, by, at}`（**不动任务本体**，除非 `reopen:true`）
3. `reopen:true` 时按 reopen 流程重开（保留 snapshot）
4. 记一条补充说明（走 `task-notes.jsonl` 同款逻辑或直接 append），内容 = `【转长任务】` + note + 阶段清单
5. 返回 `{ ok:true, task, phases, note:"已标记为长任务；后续每次唤醒都会带上阶段清单" }`

### 2.3 `GET /tasks/changes?id=<taskId>`

```json
{ "ok": true, "taskId": "t-26",
  "changes": [ {"kind":"snapshot","at":1762…,"before":{…}},
               {"kind":"reopen","at":…,"note":"…","by":"ui"} ],
  "longrun": { "phases": ["…"], "at": 1762… } | null,
  "latestSnapshot": { … } | null }
```
- 按 `at` 升序；任务不存在 404；只读。
- `latestSnapshot` = 最近一条 `kind:'snapshot'` 的 `before`，前端用它显示「上一轮交付物」。

### 2.4 长任务标记的读取点

`buildTaskAnchorText()` 要加一段（**只加，不改已有行**）：如果该任务在 `task-meta.jsonl` 里
有 `kind:'longrun'` 记录，就在「补充说明」**之前**插入：
```
阶段（长任务，按序推进，不得跳步）：
1. <phase1>
2. <phase2>
```
没有 longrun 记录则**完全不变**（既有测试里对文案的断言必须继续通过）。

---

## 3. 前端

### 3.1 任务详情新增「变更」区块（`TaskDrawer`）

放在「可以做什么」之后，包含：
- 变更说明输入框（多行，必填）
- 三个按钮：**重开（纠错/继续做）** / **派生优化单** / **转为长任务**
  - `重开`：`POST /tasks/evolve {id, mode:'reopen', note}`
  - `派生优化单`：`POST /tasks/evolve {id, mode:'followup', note}` → 成功后显示「已派生 t-xx」
  - `转为长任务`：`POST /tasks/evolve {id, mode:'longrun', note, reopen:true}`（长任务一般要接着做）
- **变更历史**：`GET /tasks/changes?id=`，逐条 `[时间] 动作 — 说明（by）`
- 若有 `latestSnapshot`：显示「上一轮交付物：…（已存档）」——让用户知道重开后证据没丢

### 3.2 换负责人

在「目标锚」区块的负责人一行旁边加「**换负责人**」按钮：
- 弹出 Bot 下拉（`GET /roster`，排除 retired）
- 确认 → `POST /tasks/reassign {id, ownerId, expectedRev: task.rev}`
- 成功显示 `已从 <旧> 换到 <新>` + wake 结果；失败显示后端 `reason`（已完成任务会被拦，提示改走「重开」）

### 3.3 完成任务的入口要显眼

`TaskDrawer` 在 `status === 'completed'` 时，「可以做什么」区的标题改成
「已完成 · 要纠错/优化/变更从这里开始」，并**默认展开**变更区块。
（现状风险：用户看到已完成任务，以为不能改，只能新建 —— 这正是用户这次提的问题。）

---

## 4. 验收清单

- [ ] `bash test/run-all.sh` exit 0，测试数 ≥ 786
- [ ] `bash test/ci-zero-dep.sh` exit 0；`node --check` 双文件通过
- [ ] `/tasks/reassign`：换成功、原租约持有者不是新人时能成功（先 release）
- [ ] `/tasks/reassign`：已完成任务 → 400 且 `code:"TASK_COMPLETED"`、`reason` 可读
- [ ] `/tasks/reassign`：WIP 超限 → 原样回传错误码（不吞）
- [ ] `/tasks/evolve reopen`：重开后 `artifacts` 被内核清空，但 `changes` 里 `latestSnapshot` 有存档
- [ ] `/tasks/evolve reopen`：任务本就 pending 无租约时不报错（视为成功）
- [ ] `/tasks/evolve followup`：派生新任务、`sourceSeq` 幂等（连点两次只建一个）
- [ ] `/tasks/evolve followup`：前缀按 note 关键词选择（修复/优化/变更）
- [ ] `/tasks/evolve longrun`：写 `task-meta.jsonl`，`GET /tasks/changes` 能读到 `longrun.phases`
- [ ] `buildTaskAnchorText`：有 longrun 时含「阶段（长任务…）」，无 longrun 时**与改造05 完全一致**
- [ ] 前端：变更区块三个按钮都在、调对端点；「换负责人」能选 Bot 并调 `/tasks/reassign`
- [ ] 已完成任务的详情默认展开变更区
- [ ] 既有 786 个测试零回归
