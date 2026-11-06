# 契约 · bots改造05：唤醒前自动复活会话（修「派活报 agent-not-live」）

> 状态：**已冻结**（2026-11-06）。改动需先改本文件。
> 触发问题（用户原话）：「创建任务指派 bots 时报错，请排查」

---

## 0. 根因（已定位，有证据）

1. 用户在任务页创建任务并选负责人 → 任务**建成了**（`t-26`），也**指派成功了**（`board` 里 `claim` → `rev` 2 → `in_progress`）；
2. 但紧接着的唤醒失败了，`wakes.jsonl` 有记录：
   ```json
   {"target":"bot-6b654c19-…","reason":"task-assigned","result":"failed",
    "dedupKey":"task-assigned:t-26:2","detail":"agent-not-live"}
   ```
3. `agent-not-live` 来自 `kernel.followup` → `kernel.getAgent(ctx, sessionId)` 返回 `undefined`，
   即**该 Bot 的会话不在宿主 live 注册表里**；
4. 原因是 **11:38 那次 dsh-web 重启**：进程重启后宿主不会自动把旧会话加载进 `agents` 注册表（懒加载），
   而 cs-bots 侧 `roster.hydrate()` 只回放注册表数据、**从不复活会话**；
   证据：`grep -rn resumeSession src/` → 只有 `kernel.js` 定义（第 336 行），**全项目零调用**。
5. 会话本身是**存在**的（`~/.dsh/sessions/--home-ubuntu-output-…--/bot-6b654c19-…`），
   所以 `agents.resume({resumeSessionId})` 可以救回来。

**结论**：不是任务板/指派逻辑的 bug，是「重启后会话未复活 → 投递必然 agent-not-live」。
指派本身成功，用户看到的「报错」其实是唤醒失败提示。

---

## 1. 写作用域

| 文件 | 归属 | 规则 |
|---|---|---|
| `src/api.js` | 后端 | **只新增**：helper + 3 个端点 + 在既有 3 个投递点前插入 revive；不得改已有响应字段含义 |
| `src/client.js` | 前端 | 只新增/接线；`wakeLabel` 可改文案；不得重排 Tab |
| `test/api-revive.test.mjs` | 后端 | 新建 |
| `test/client-revive.test.mjs` | 前端 | 新建 |

**禁止改动**：`board.js`、`room.js`、`store.js`、`dispatcher.js`、`roster.js`、`index.js`、`kernel.js`。
`kernel.js` 已有 `getAgent(ctx,id)` 与 `resumeSession(ctx,{resumeSessionId})`，够用（**不要改 kernel.js**）。

---

## 2. 后端

### 2.1 私有 helper `ensureLive(ctx, sessionId)`

```
async function ensureLive(ctx, sessionId)
```
- `sessionId` 不是非空字符串 → `{ ok:false, live:false, revived:false, reason:'missing-session' }`
- `kernel.getAgent(ctx, sessionId)` 有值 → `{ ok:true, live:true, revived:false }`
- 否则 `await kernel.resumeSession(ctx, { resumeSessionId: sessionId })`：
  - 成功 → `{ ok:true, live:true, revived:true }`
  - 抛错 → `{ ok:false, live:false, revived:false, reason:'resume-failed:<message>' }`
- **本函数绝不抛错**（复活失败必须让上层拿到 reason，再由上层决定是继续投递还是明确报失败）。

### 2.2 `POST /bots/revive`

请求体三选一：
```json
{ "botId": "bot-…" }
{ "sessionId": "bot-…" }
{ "all": true }
```
- 单个：`roster.get(botId)` 取 `sessionId`（找不到 → 404 `{ok:false,reason:"Bot <id> 不存在"}`）；
  `ensureLive` 后返回 `{ ok:true, sessionId, live, revived, reason? }`
  - **注意**：`ok:true` 表示「请求已处理」，是否复活成功看 `live`；复活失败也要 `ok:true` + `live:false` + `reason`（不是 500）
- `all:true`：遍历 `roster.list()` 中 `state !== 'retired'` 的 Bot，**串行** `ensureLive`（最多 50 个），
  返回 `{ ok:true, total, revived:[sessionId…], live:[sessionId…], failed:[{sessionId,reason}…] }`
- `revived` 里只放**本次真的 resume 成功**的；`live` 放全部当前 live 的（含原本就 live）。

### 2.3 在既有投递点前自动复活（关键修复）

以下三处，在 `dispatcher.notify(...)` **之前**插入 `await ensureLive(ctx, target)`，
并把结果放进响应新增字段 `revived`（true/false）：

| 端点 | target | 响应新增 |
|---|---|---|
| `POST /tasks/assign` | `body.ownerId` | `revived:boolean`（以及保留既有 `wake`） |
| `POST /tasks/note` | `task.ownerId` | `revived:boolean` |
| `POST /bots/message` | 解析出的 `sessionId` | `revived:boolean` |

- 若 `ensureLive` 返回 `live:false` → **仍然照原样调用 notify**（保持既有行为：不静默吞掉失败，wake 里会有 reason），
  但要额外回传 `reviveReason`（字符串），让前端能说清「为什么没唤成」。
- 若原本就 live（`revived:false`）→ 行为与现在**完全一致**，不得多出任何副作用。

### 2.4 `POST /tasks/wake`（手动重试唤醒）

为什么要单独一个端点：`/tasks/assign` 的 dedupKey 是 `task-assigned:<id>:<rev>`，
重试时 rev 没变 ⇒ 命中去重 ⇒ 返回 `skipped`，人点「重试」看起来像没反应。

请求体：
```json
{ "id": "t-26", "dedupKey": "可选", "force": false }
```
- `id` 必填（400）；任务不存在 404；任务无 `ownerId` → 400 `{ok:false,reason:"任务没有负责人，无法唤醒"}`
- `force` 缺省 true（人主动点的重试，就应该真的再唤一次）；`force:false` 时用默认键 `task-wake:<id>:<rev>` 走幂等
- 流程：`ensureLive(ownerId)` → `dispatcher.notify({ target, reason:'task-assigned', dedupKey: force ? 'task-wake:<id>:<Date.now()>' : 'task-wake:<id>:<rev>', text: 完整锚定文案 })`
- 返回 `{ ok:true, taskId, ownerId, live, revived, reviveReason?, wake }`

### 2.5 房间发言的补投（可选但推荐）

`POST /rooms/post` 既有行为不动（room.js 内部已 notify 且会占键失败）。
在 handler 末尾追加一段「**补投**」：读该房间成员，对每个 target 做 `ensureLive`，
`live:true` 的用**新 dedupKey** `room-msg-retry:<messageId>:<target>` 再 notify 一次。
响应新增 `revives` 字段（数组），失败不影响消息已落盘的既有语义。
若这一步实现风险大（要读 room 内部结构），**可以选择不做**，但要在交付说明里写清。

---

## 3. 前端

### 3.1 文案：把 `agent-not-live` 翻成人话

`wakeLabel(wake)` 增加映射：
- `agent-not-live` → `该 Bot 会话当时没在运行`
- `resume-failed:*` → `该 Bot 会话启动失败`
其余保持。

### 3.2 失败后的可操作按钮

在 `WakeNotice`（或各调用处）当 `wake.result === 'failed'` 且 `reason` 以 `agent-not-live` 开头时，
显示两个按钮：
- **「启动该 Bot 会话」** → `POST /bots/revive`（`botId` 或 `sessionId`）
- **「重试唤醒」** → `POST /tasks/wake`（`{id}`），成功显示新 wake

### 3.3 Bot 页

- 卡片新增 **「启动会话」** 按钮（`POST /bots/revive`，`botId`），结果显示 `live/revived/reason`
- 页头新增 **「全部启动」** 按钮（`POST /bots/revive` `{all:true}`），显示 `复活 N 个 / 已在线 M 个 / 失败 K 个`
  - 用途：重启 dsh-web 之后一键把所有 Bot 会话拉起来

### 3.4 成功时的静默说明

当响应 `revived === true`（后端自动复活成功）→ 在成功提示后追加「（已自动启动该 Bot 会话）」。
`revived === false` 且 `wake.result === 'sent'` → 不提。

---

## 4. 验收清单

- [ ] `bash test/run-all.sh` exit 0，测试数 ≥ 759
- [ ] `bash test/ci-zero-dep.sh` exit 0
- [ ] `node --check src/api.js && node --check src/client.js`
- [ ] `ensureLive`：已 live 不 resume；未 live 会 resume；resume 抛错返回 reason 且**不抛**
- [ ] `/tasks/assign` 在 target 未 live 时**先 resume 再 notify**，响应含 `revived:true`
- [ ] `/tasks/assign` 在 resume 失败时仍然 notify（wake 里是 failed + reason），响应含 `reviveReason`
- [ ] `/tasks/note`、`/bots/message` 同上
- [ ] `/bots/revive` 单个 404/成功/失败语义正确；`all:true` 串行且返回三个清单
- [ ] `/tasks/wake`：无 owner 400、任务不存在 404、`force` 时 dedupKey 含时间戳因而不 skipped
- [ ] 前端：`agent-not-live` 文案已翻译；失败时有「启动该 Bot 会话」「重试唤醒」两个按钮；Bot 页有「启动会话」「全部启动」
- [ ] 既有 759 个测试零回归
