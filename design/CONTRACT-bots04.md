# 契约 · bots改造04：协作平台「一站式工作台」

> 状态：**已冻结**（2026-11-06）。实现与测试只能按本文件，改动需先改本文件。
> 背景（用户原话）：「以后都从 bots 页创建任务、派活、补充发送、沟通，可以跳转定位到对话；
> 我准备都用协作平台页面开展工作，也能保证长任务的目标稳定不失真。」

---

## 0. 一句话设计

把「人 → Bot」的三条动作（**派活 / 补充 / 沟通**）都收进协作平台，
并且给每个任务一份**不可变的目标锚（objective anchor）**——
每次唤醒 Bot 都把这份原文完整带上，**补充说明只追加、永不覆盖**，
从根本上避免长任务在几十轮对话后「目标漂移」。

---

## 1. 允许改动的文件（写作用域，越界即驳回）

| 文件 | 归属 | 规则 |
|---|---|---|
| `src/api.js` | 后端 | **只允许新增**端点与私有 helper；不得改已有端点行为 |
| `src/client.js` | 前端 | 只允许新增组件/函数 + 在指定位置接线；不得重排已有 Tab |
| `test/api-anchor.test.mjs` | 后端 | 新建 |
| `test/client-anchor.test.mjs` | 前端 | 新建 |

**禁止改动**：`src/board.js`、`src/room.js`、`src/store.js`、`src/dispatcher.js`、`src/roster.js`、`src/index.js`、`src/kernel.js`。
这些文件的能力已足够（`board.update` 支持 `note`、`dispatcher.notify` 支持自定义 `text`、
`store.appendJsonl/readJsonl` 可写新文件）。**若确需改动，停下并在交付说明里写清理由。**

---

## 2. 后端端点

### 2.1 `GET /tasks/brief?id=<taskId>`

任务「目标锚」：返回**创建时冻结**的目标原文 + 一段可直接发给 Bot 的锚定文案。

**成功 200**
```json
{
  "ok": true,
  "taskId": "t-12",
  "anchor": {
    "subject": "实现登录接口",
    "description": "标准：\n- 密码错误 401\n- 成功 200 + token",
    "writeScopes": ["src/auth/"],
    "blockedBy": ["t-10"],
    "priority": 8,
    "status": "in_progress",
    "ownerId": "bot-a",
    "progress": 40,
    "artifacts": ["src/auth/login.js"],
    "createdAt": 1762300000000
  },
  "notes": [
    { "id": "n-1", "text": "别忘了限流", "by": "ui", "at": 1762300100000 }
  ],
  "text": "【任务目标·请勿改写】\n任务 t-12：实现登录接口\n……",
  "note": "目标锚来自任务创建时的原文；补充说明另存，不会覆盖目标"
}
```

- `404` 任务不存在 → `{ok:false, reason:"任务 t-99 不存在"}`
- `400` 缺 `id` → `{ok:false, reason:"id 必填"}`
- **只读**，不写任何文件。

**`text` 的固定格式**（前端只负责展示/复制，不得改写；测试按此断言结构）：
```
【任务目标 · 原文锚定，禁止改写】
任务 <id>：<subject>
目标：<description 原文；为空则写「（未填写）」>
边界：只改 <writeScopes 逗号拼接；为空则写「（未限定）」>
前置：<blockedBy 逗号拼接；为空则写「（无）」>
进度：<progress>%
已交付：<artifacts 逗号拼接；为空则写「（暂无）」>
补充说明（按时间，全部有效，不得忽略）：
- [<时间>] <text>
```

### 2.2 `POST /tasks/note`

**追加一条补充说明**（永不覆盖目标），并（默认）定向唤醒执行者。

请求体：
```json
{ "id": "t-12", "text": "别忘了限流", "by": "ui", "wake": true }
```

- `text` 必填，`trim` 后 1–4000 字符；超长 → `400 {ok:false, reason:"补充说明过长（最多 4000 字）"}`
- `by` 缺省 `"ui"`
- `wake` 缺省 `true`；任务无 owner 或 `wake:false` → 不唤醒，`wakes: []`

落盘：**新文件** `statePath('task-notes.jsonl')`（append-only，一行一条）
```json
{"id":"n-1","taskId":"t-12","text":"别忘了限流","by":"ui","at":1762300100000}
```
编号：`n-<seq>`，`seq` 由 `store.nextSeq` 或已读行数+1 生成，**不得重复**。

唤醒（`services.dispatcher.notify`）：
```
target  = 任务 ownerId
reason  = 'task-assigned'        // 复用枚举，不改 dispatcher
dedupKey= `task-note:${taskId}:${note.id}`   // 每条补充只唤一次
text    = 【任务目标 · 原文锚定，禁止改写】…\n\n【新增补充说明】<text>
```
> `text` 必须包含 §2.1 的完整锚定文案，而不是只发一句「有新补充」——
> 这正是「长任务不失真」的落点：Bot 每次被唤醒看到的都是**全量目标原文**。

**成功 200**
```json
{ "ok": true, "note": {"id":"n-1","taskId":"t-12","text":"别忘了限流","by":"ui","at":1762300100000},
  "wake": {"ok":true,"result":"sent"} }
```
- `wake` 为 `null` 表示未请求唤醒；否则原样透出 `notify()` 返回值（含 `skipped/failed/pending` 与 `reason`）——**绝不隐藏唤醒失败**。
- 404 任务不存在；400 缺 id / text 为空。

### 2.3 `GET /tasks/notes?id=<taskId>`

```json
{ "ok": true, "taskId": "t-12", "notes": [ {"id":"n-1","text":"…","by":"ui","at":1762300100000} ] }
```
按 `at` 升序。任务不存在 → 404。**只读。**

### 2.4 `POST /bots/message`

从协作平台**直接给某个 Bot 的会话说话**（等价于人在该会话里发一条消息）。

请求体（二选一：`botId` 或 `sessionId`）：
```json
{ "botId": "b-3", "text": "先做登录接口", "taskId": "t-12", "dedupKey": "ui-…" }
```
- `text` 必填 1–4000
- `botId` → `roster.get(botId)` 取 `sessionId`；找不到 → 404
- `sessionId` 直接用；`roster.hasSession(sessionId)===false` 时**仍允许**（可能是主对话），但响应里 `knownBot:false`
- `taskId` 给了就前置完整锚定文案（§2.1 的 `text`），形成「在会话里也锚定目标」
- 唤醒：`dispatcher.notify({ target: sessionId, reason: 'room-message', dedupKey: dedupKey ?? 'ui-msg:'+hash, text })`
  - `dedupKey` 缺省由 `taskId+text` 的 sha1 前 16 位生成，保证幂等
- 成功：`{ ok:true, sessionId, knownBot, wake, text }`（`text` 为实际投递文案，便于审计）

### 2.5 `GET /tasks/source?id=<taskId>`

> **状态**：原标注「可选，若时间允许」，2026-11-07 收尾时判定为实现（它承载用户诉求里
> 「**跳转定位到对话**」的另一半：`§3.4` 只做了「消息 → 建任务」，没有「任务 → 回消息」）。
> 实现前先冻结本节，代码按本节字段名与状态码逐字对齐。

返回任务来源（`source`/`sourceSeq`），并把 `sourceSeq = "room:<roomId>:<seq>"`
解析成「可跳转的房间 + 消息序号」，供前端从任务详情**跳回消息出处**。

**成功 200**（`kind = "room"` 时）：
```json
{
  "ok": true,
  "taskId": "t-5",
  "source": "ai",
  "sourceSeq": "room:room-a1b2c3d4:7",
  "kind": "room",
  "reason": null,
  "room": {
    "roomId": "room-a1b2c3d4",
    "name": "研发协调",
    "seq": 7,
    "messageId": "m-7",
    "exists": true,
    "messageExists": true,
    "at": 1762300100000,
    "preview": "把登录接口拆成三个子任务"
  },
  "jump": { "roomId": "room-a1b2c3d4", "seq": 7 },
  "hint": "来源：房间消息 room-a1b2c3d4 #7"
}
```

**`kind` 的取值与判定顺序**（按 `sourceSeq` 前缀，不做模糊匹配）：

| `kind` | 条件 | `room` / `jump` |
|---|---|---|
| `room` | `room:<roomId>:<seq>`，且 `roomId` 非空、`seq` 为正整数 | 有（见下） |
| `todo` | `todo:<id>` | `null` / `null` |
| `evolve` | `evolve:<id>:<seq>` | `null` / `null` |
| `none` | 任务没有 `sourceSeq` | `null` / `null` |
| `unparsed` | `sourceSeq` 存在但**不匹配任何已知前缀**，或格式残缺 | `null` / `null` |

**绝不猜测**：`kind = "unparsed"` 时 `reason` 写明
`无法解析来源标记 "<sourceSeq>"（不是 room:/todo:/evolve: 前缀）`，
前端据此提示用户「来源已失效，可手动在房间里找」，而不是渲染一个跳不动的按钮。
`kind = "room"` 但 `room.exists = false`（房间已删）时 `jump` 仍返回，
由前端判断——**数据要如实给出，是否可跳由前端决定**。

`room.preview`：来源消息正文首行截 80 字（与 §3.4 建任务时取标题的口径一致）。
`room.messageExists`：读房间消息日志确认该 `seq` 真实存在；取不到时 `null` + 不静默。

**错误**：`400` 缺 `id` → `{ok:false, reason:"id 必填"}`；`404` 任务不存在 →
`{ok:false, reason:"任务 t-99 不存在"}`（与 §2.1/§2.3 逐字一致）。**只读。**

> 房间 id 恒为 `room-<uuid8>`（`src/room.js:1032`），**内部不含冒号**，
> 故 `sourceSeq.split(':')` 的三段切分是安全的；这一点写进测试断言以防将来改 id 规则时被误判。

---

## 3. 前端改动（`src/client.js`）

### 3.1 Bot 页（`BotsTab`）卡片新增两个按钮

| 按钮 | 行为 |
|---|---|
| **派任务** | 打开任务创建弹窗，`assignee` 预填该 bot 的 sessionId；创建成功后**立即** `POST /tasks/assign`（`id` + `ownerId` = sessionId + `expectedRev`），并显示唤醒结果（`sent/skipped/failed` 都要显示，失败给原因） |
| **发消息** | 弹出输入框（多行）→ `POST /bots/message`（带 `botId`）→ 成功提示「已送达」；失败显示后端 `reason` |

> 「去对话」按钮已存在（`openSession`），本次不动，但要在任务侧复用同样能力。

### 3.2 任务详情（`TaskDrawer`）新增区块

1. **目标锚（只读）**：subject（大字）、description（等宽、可折叠）、边界 writeScopes、前置 blockedBy。
   顶部一行小字：「目标来自创建时原文 · 补充说明只追加不覆盖」。
2. **补充说明**：多行输入 + 「发送给执行者」按钮 → `POST /tasks/note`
   - 成功后清空输入、刷新补充历史、显示唤醒结果
   - 无 owner 时按钮文案改为「保存补充（未派活，暂不唤醒）」
3. **补充历史**：`GET /tasks/notes`，逐条显示 `[时间] 内容（by）`
4. **去对话**：有 ownerId → 从 `GET /roster` 找 `sessionId` → `hostUiWorkspace.openSession({sessionId})`；
   找不到 → 提示「该负责人不是本平台的 Bot，无法跳转」+ 复制 ID
5. **复制派发文案**：调 `GET /tasks/brief` 复制 `text`（用于手工粘贴给任意会话）
6. **来源跳转（§2.5 落地，2026-11-07 补）**：调 `GET /tasks/source`
   - `kind === 'room'` 且 `room.exists !== false` → 按钮「回到消息出处（房间名 #7）」
     → 切到「房间」页签并选中该房间、滚到该 `seq` 的消息；`messageExists === false` 时
     仍可切房间，但要在提示里写明「消息 #7 已不在（可能被清理）」，不许假装跳成功。
   - `room.exists === false` → 按钮禁用 + 提示「来源房间已删除」。
   - `kind === 'none'` → **不渲染任何来源区块**（人建的任务没有来源，不占位）。
   - `kind === 'todo' / 'evolve' / 'unparsed'` → 显示只读一行 `「来源：<sourceSeq>」`
     并附后端 `reason`（`unparsed` 时）——**绝不渲染跳不动的按钮**。

> 跨页签定位的最小机制（不引入路由库、不重排页签）：
> `Workbench` 持有 `tab` 状态并已把 `onGoto` 传给页签（`ArtifactsTab` 已用同一手法）。
> §2.5 的跳转**复用 `onGoto`**，追加一个可选的「目标定位」参数
> `onGoto('rooms', { roomId, seq })`；`RoomsTab` 收到后设置 `active` 并记 `focusSeq`，
> 渲染时给该 `seq` 的消息行加高亮 class 并 `scrollIntoView`。
> 向后兼容：`onGoto('tasks')` 等既有调用（单参数）行为**逐字不变**。

### 3.3 任务创建表单：选负责人 = 一步派活

`TasksTab` 创建时若填了负责人（`assignee`），创建成功后自动 `POST /tasks/assign`，
并把 `wake` 结果 toast 出来。失败不静默：显示「任务已建，但派活失败：<原因>」。

### 3.4 房间消息 → 建任务

房间消息气泡 hover 出现「⇢ 建任务」：
- 打开任务创建弹窗，`subject` = 消息正文首行（截 80 字），`description` = 全文 + 出处
- 创建时带 `sourceSeq = "room:<roomId>:<seq>"`，实现幂等（重复点不会建两个）

---

## 4. 验收清单（缺一条即不通过）

- [ ] `bash test/run-all.sh` exit 0，测试数 **≥ 736 + 新增数**
- [ ] `bash test/ci-zero-dep.sh` exit 0（`src/api.js`、`src/client.js` 仍零第三方依赖、零相对 require）
- [ ] `node --check src/api.js && node --check src/client.js` 通过
- [ ] `GET /tasks/brief` 返回 `anchor` + `notes` + `text`，`text` 含「原文锚定，禁止改写」与全部字段
- [ ] `POST /tasks/note` 落 `task-notes.jsonl` 一行；重复调用产生**两条**（不是覆盖）
- [ ] `POST /tasks/note` 在 `wake:false` 时 `wake === null` 且不调用 dispatcher
- [ ] `POST /tasks/note` 唤醒文案 = 完整锚定文案 + 补充说明
- [ ] `POST /bots/message` 缺 `botId/sessionId` → 400；未知 botId → 404
- [ ] 所有新端点都有鉴权（走既有 `createFence` 前置，不新增绕过）
- [ ] 路径穿越/超长/空文本 均有 400 与可读 `reason`
- [ ] 前端 `client.js` 通过 `__ModuleLoader__` 静态装载测试（既有 A1–A12 不回归）
- [ ] 新增测试覆盖：brief 文案结构、note 追加语义、note 唤醒 dedupKey、bots/message 404/400

### 4.1 §2.5 来源跳转的追加验收（2026-11-07 补）

- [ ] `GET /tasks/source`：缺 id → 400（`id 必填`）；任务不存在 → 404（`任务 t-99 不存在`）
- [ ] 无 `sourceSeq` 的任务 → `kind:"none"`，`room`/`jump` 均为 `null`
- [ ] `room:<roomId>:<seq>` → `kind:"room"`，`jump` 与 `room` 字段齐全，`roomId`/`seq` 与 `sourceSeq` 逐字一致
- [ ] 来源消息真实存在 → `room.messageExists === true`；不存在 → `false` 且**不静默**
- [ ] `todo:` / `evolve:` 前缀 → `kind` 正确、`room`/`jump` 为 `null`
- [ ] 无法解析的 `sourceSeq` → `kind:"unparsed"` 且 `reason` 指明原因
- [ ] 房间已删除 → `room.exists === false`，`jump` 仍如实返回（数据不丢）
- [ ] 前端：`kind:"none"` 不渲染来源区块；`kind:"room"` 渲染可跳转按钮；`unparsed` 只显示只读来源 + reason
- [ ] 前端：既有 `onGoto('tasks')` 单参数调用行为**逐字不变**（回归）

