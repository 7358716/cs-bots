# CONTRACT-升级09 · Boss 体验 / 任务可管理 / 升级接续

> 版本目标：**0.8.0**（有 UI 破坏性变更：删按钮、改文案口径）。
> 本契约是三个人并行改码的**唯一真相**。接口形状、字段名、文案口径以本文为准；
> 实现细节自由，契约不许各自发明。
>
> 三条铁律（全版本适用，违反即退回）：
> 1. **零第三方运行时依赖**（CI `test/ci-zero-dep.sh` 会拦）。
> 2. **不改既有 38 个工具契约的语义**（只许纯增量加新工具/新可选参数）。
> 3. **绝不静默失败**：任何「本该发生却没发生」都要有可见理由（返回值 + 落盘/UI）。

---

## 0. 术语口径（需求1）

Boss 在看界面时，人只有一个称呼：**Boss**。

- `HUMAN_LABEL = 'Boss'`，`HUMAN_SELF_LABEL = 'Boss（你）'` —— 已有，不改。
- 禁止第三同义词：`用户`、`你`（作为「用户」义）、`人`（作为「用户」义）、`派活方`、`人工`、`操作者`。
- 例外（允许保留）：`其他 Bot`、`智能体`、`管理员`（房间超管）、`执行者`、`负责人`。
- `（ui）` / `by: 'ui'` 这类**机器标识**可以保留在技术字段里，但**面向 Boss 的展示文案**要写 `Boss`。
  例：补充说明历史里的 `（ui）` → `（Boss）`。
- 判定方法：`grep` 出来的每一处在 UI 文案里（`h(...)` 的文本参数）都得改；
  注释、日志、README/CHANGELOG 不强制（注释里保留历史原话可以，那是证据）。

---

## 1. 任务栏（需求2）

- 顶层子页签**保留两个**：`任务栏`（原 `Boss的任务`）、`智能体任务`。
  - 左侧 `TABS` 里 `workspace.subs` 的 `board` 项 `label` 改为 **`任务栏`**。
- **删掉**页内的切换按钮对：`看全部Boss的任务` / `只看需要我管的`（client.js L2853-2854 一带）。
- **删掉** `attentionOnly` state 与 `q.set('attention','1')`。
- `任务栏` 页**默认全量**：请求 `GET /tasks` **不带** `attention`、**不带** `source`。
  ⇒ 显示全部任务（Boss 建的 + 智能体建/派发的 + Boss 介入过的）。
- `智能体任务` 页（`AiTasksTab`）仍然 `source=ai`。
- 页头 `desc` 改成一句人话：`全部任务都在这里：Boss 建的、智能体派发的、以及已经完成的。`（不再提「切回去」）。

---

## 2. 阶段产出物（需求3）

Boss 的原话：「点击去看产出物，看不到过程产物」。⇒ 任务详情里必须能按阶段看到每阶段交了什么东西，
**不需要去翻对话**。

### 2.1 存储（board 侧新增，C 负责）

`task-meta.jsonl` 新增一种行（与 `longrun` 同一份文件、同一套读写）：

```jsonc
{ "kind": "phase", "taskId": "t-36", "index": 0, "state": "doing|done|blocked",
  "artifacts": ["/path/a.md", "https://..."], "note": "一句话说明", "by": "bot-xxx|ui", "at": 1794... }
```

- 同一 `index` 有多行时，**最后一行胜**（append-only，不覆盖写）。
- `artifacts` 为空数组是合法的（表示「这一阶段没产出物」），要能在 UI 上说清。

### 2.2 读取端点（api 侧，B 负责）

`GET /tasks/phases?id=t-xx` →

```jsonc
{ "ok": true, "taskId": "t-36",
  "phases": [
    { "index": 0, "title": "范围与验收标准确认", "state": "done",
      "artifacts": ["docs/a.md"], "note": "确认完毕", "by": "bot-x", "at": 1794... }
  ],
  "currentIndex": 1,            // 第一个 state!=='done' 的下标；全 done ⇒ phases.length
  "totalArtifacts": 3,
  "isLongrun": true,
  "note": "非长任务时 phases 为空数组，isLongrun=false" }
```

- 阶段清单来自 `readLongrunMeta()`；没有 longrun 记录 ⇒ `phases: []`、`isLongrun: false`，**不是错误**。
- 非长任务但已有 `task.artifacts` 的，`GET /tasks/detail` 已有的 `artifacts` 字段不动（向后兼容）。

### 2.3 写入端点（api 侧，B 负责）

`POST /tasks/phase`（body：`{ id, index, state, artifacts?, note?, by? }`）

- `index` 必须落在 `0..phases.length-1`，越界 400 且说明合法范围。
- `state` 缺省 `done`；`artifacts` 归一为字符串数组（去空、去重、最多 50 项、每项 ≤ 2000 字）。
- 必须写一条 `kind:'phase'` 到 task-meta.jsonl；写不进去 ⇒ 503（不许静默丢证据）。
- 返回 `{ ok, phase, phases }`（回填整份最新视图，省一次读）。

### 2.4 工具面（tools.js，C 负责）

新工具 `bot_task_phase`：让执行者**边做边交**阶段产出物。

```
参数：id(必填), expectedRev(可选), index(必填), state(enum doing|done|blocked, 默认 done),
      artifacts(string[]), note(string)
```
- 不改变既有工具的语义；只新增。
- 工具描述里明确一句：**「每完成一个阶段就调用一次，带上这一阶段交出的文件路径/链接」**。

### 2.5 UI（client.js，A 负责）

任务详情新增区块 `阶段产出物`（放在「产出物证据」**之前**），数据来自 `/tasks/phases`：

- 每阶段一行：`① 阶段名` + 状态徽标（`未开始` / `进行中` / `已完成` / `卡住`）+ 该阶段产出物列表。
- 产出物复用现有「产出物证据」那套渲染：路径可预览、URL 可打开。
- 空态：`执行者还没汇报这一阶段。`（长任务才有此区块；非长任务显示 Empty + 一句「这不是长任务，没有分阶段产物；总产出物见下方」）。

---

## 3. 建团队自动建房间（需求4）

`POST /teams` 建团队成功后，**同一个请求内**自动建一个房间并把团队负责人/成员拉进去。

- 房间名：`` `${team.name} · 议事厅` ``。
- 成员：`[leadId, ...team.members]`；`adminId = leadId`（负责人管这个房间）。
  **注意**：`adminId` 必须是房间成员之一，否则 room.js 会拒。
- 房间失败**不阻断建团队**（团队已建好），但必须回 `room.reason` 让 Boss 看见。
- 团队记录新增字段 `roomId`（字符串），通过 `teams.js` 新方法 `attachRoom({ id, roomId, by })` 落盘
  （新事件 action `attachRoom`，CAS 用 `expectedRev`；幂等：同 roomId 重复调用直接返回既有）。
- `POST /teams/add` 成功后，若团队有 `roomId` ⇒ 把新成员也加进房间（失败只 warn 到返回值，不阻断）。
- `POST /teams` 的返回体新增 `room?: { id, name }`、`roomError?: string`。
- UI（A 负责）：团队卡片显示 `房间：<名>` + `去房间` 按钮（走 `goTab('team','rooms')` 并选中该房间）。

---

## 4. Boss 直接动手（需求5）

Boss 勾选要能直接做的：**改优先级/截止/复杂度/是否付费、改目标与边界、换负责人/收回/重新派发、
阻塞/解阻塞/归档、编辑长任务阶段清单**。（不新增「改进度」入口——已有，见 §6。）

### 4.1 走既有端点（A 直接用，B 只需保证可用）

| Boss 动作 | 端点 | body |
|---|---|---|
| 改优先级/截止/复杂度/付费 | `POST /tasks/update` | `{ id, expectedRev, action:'edit', priority?, dueAt?, expectedComplexity?, requiresPaid? }` |
| 改目标/边界 | `POST /tasks/update` | `{ id, expectedRev, action:'edit', subject?, description?, writeScopes? }` |
| 收回任务 | `POST /tasks/update` | `{ id, expectedRev, action:'release' }` |
| 换负责人 / 重新派发 | `POST /tasks/reassign` | `{ id, ownerId, expectedRev, wake? }` |
| 阻塞 / 解阻塞 / 归档 | `POST /tasks/update` | `action:'block'`(+`reason`) / `'unblock'` / `'delete'` |

- `expectedComplexity: null` / `requiresPaid: null` 表示**清除**（board 已有该语义，别改）。

### 4.2 编辑阶段清单（新端点，B 负责）

`POST /tasks/phases`（body：`{ id, phases: string[], note?, expectedRev? }`）

- 复用 `normalizePhases()`（上限 12 项 / 单项 200 字 / 不许空白）。
- 追加一条 `kind:'longrun'` 记录（与 `/tasks/evolve mode:longrun` 同形），`note` **可空**，
  空则自动写 `Boss 调整阶段清单`。
- 明确一条：**已经汇报过的阶段产物不丢**（`kind:'phase'` 行不动）；新的 phases 变短时，
  `index >= phases.length` 的旧产物行保留但不再展示（读取端按 index 过滤）。

### 4.3 UI（A 负责）

- 「可以做什么」区块按 Boss 视角重写，把上面 5 类动作做成**内联表单/弹窗**，不跳页。
- 每个写操作都要 toast 出真实结果（成功/失败理由），不许「点了没反应」。
- 文案不许出现「不由你操作」这种把 Boss 排除在外的句子——现在那行要改。

---

## 5. 派活失败必须可见且可救（需求6）

Boss 报的故障原文：`调研专家《调研专家测试001》已多次指派，subagent 持续失败，无产出。`

已掌握的硬证据（B 必须复核并写进诊断报告）：

- `~/.dsh/cs-bots/wakes.jsonl` 里 12 条 `result:'failed'`，`detail:'agent-not-live'`。
- `t-36` 任务上有 `delivery: { error:'agent-not-live', at:1794294124827 }`。
- roster 里 `myfree调研员`（`bot-87b3…`）**preset 为 None** ⇒ 走宿主默认预设，工具面不保证。
- 一次派活的完整链路：`prepare → claim → ensureLive → assertDeliverable → baseline → notify → armDeliveryWatch`。

### 5.1 必须做的事（B 负责 api.js）

1. **诊断脚本/端点**：`GET /tasks/diagnose?id=t-xx` → 一次性给出这个人能不能干活：
   ```jsonc
   { ok:true, taskId, ownerId, bot:{ name, hasSession, preset, presetResolved, hasModelRoute },
     live:{ ok, reason }, deliverable:{ ok, reason },
     wakes:[{ at, result, reason }],
     verdict:'ok'|'blocked', advice:'一句人话 + 下一步点哪个按钮' }
   ```
   判定逻辑不许猜：每项都从现有服务读（roster / kernel.sessionMeta / dispatcher.list / board）。
2. **失败原因中文化**：`agent-not-live` / `undeliverable:*` / `followup-failed` 等
   统一映射成一句人话 + 一句下一步（如「去 Bot 档案确认能跑起来，再点重试唤醒」）。
3. **杜绝「静默卡住」**：`armDeliveryWatch` 超时未兑现的落点必须能在任务详情看到（已有 `delivery` 字段，UI 要展示，A 负责）。
4. 修完要能**自证**：写一个真实回归测试 `test/api-diagnose.test.mjs`，用假 services 覆盖
   「会话不在线 / 无模型路由 / 无工具面」三种，断言 `verdict==='blocked'` 且 `advice` 非空。

> 需求6 的验收口径（Boss 已明确）：**不阻塞阶段 1 核心确认**；阶段 2 可按已有源码梳理直接实施；
> 调研可后续重发。⇒ 本条的 DoD 是「失败可见 + 有可执行下一步 + 不再重复空派」，不是「保证 subagent 一定成功」。

---

## 6. 进度：队长填、Boss 可改（需求7）

- 保持 `progress` 0–100。**队长（Lead/Bot）按 estimate 自估自填**；Boss 随时可改。
- board 侧（C）新增两个**只读派生**字段（不参与 CAS 白名单写入）：无。
  改为：`progressBy`（string，最后一次写进度的 `byId`）+ `progressAt`（number）。
  在 `edit`/`set` 写 `progress` 时**自动**同写这两个字段（不需要调用方传）。
- UI（A）：`更新进度` 区块标题旁显示来源——`当前 40%（队长估算）` / `当前 40%（Boss 设定）`；
  并把 `estimate`（预估工作量）与 `progress` 分两行显示，别混成一个数。
- 进度输入框**保留**，且保存后必须刷新出新的 `rev`（CAS）。

---

## 7. 租约不出现、随时发消息就激活（需求8）

Boss 原话：「每次点击太麻烦…不用给我展示租约，我希望随时发送信息就可以激活，不需要点击」。

### 7.1 UI（A 负责）

- **删除整个「高级：租约」Section**（client.js L1128-1134）：不显示 `当前占用到 …`、不显示「延长 5 分钟」。
- 任务详情里任何 `租约` / `延长` / `占用到` 字样一律不再出现。
  唯一例外：错误提示里必须解释冲突时可以说「这个任务正被另一个 Bot 占着」（不说租约、不给点延长）。

### 7.2 服务端：发消息即自动续租/激活（B 负责 api.js）

- `POST /tasks/note`（Boss 发消息）成功后，在**同一次请求内**自动把任务「激活」：
  1. 有 `ownerId` 且在 `in_progress` ⇒ 自动 `heartbeat`（续租）。失败忽略（不影响消息已落盘）。
  2. `status === 'pending'` 且 Boss 指定/已有执行者 ⇒ 自动 `claim` 后唤醒。
  3. `status === 'blocked'` ⇒ **不自动重开**（那会掩盖「等 Boss 拍板」），但返回里明说
     `需要先解除阻塞：点「解除阻塞」`。
- `POST /tasks/wake`（重试唤醒）同样自动 heartbeat。
- 返回值补 `activated: { claimed?: boolean, heartbeat?: boolean, reason?: string }`（失败也要有理由）。
- 租约本身**保留**（它是防抢机制），只是：① 不给 Boss 看；② Boss 的任何动作都自动续上。
- 顺带：`defaultLeaseMs` 的设置项 help 文案（settings.js 由 A 改 UI 文案部分；settings.js 是 A 的文件？
  → `src/settings.js` 归 **A**，见 §9 文件分区）改成 Boss 口径。

---

## 8. 升级后原有任务接续（需求9）

硬要求：**升级不丢任何既有任务、证据、阶段、历史**。

### 8.1 兼容读（全员）

- `board.jsonl` / `board.snap.json` / `task-meta.jsonl` / `task-notes.jsonl` / `wakes.jsonl` 的
  **既有行格式一律不改**；新字段一律「读时给默认值」。
- `progress`、`bossTouched`、`roomId`、`phase` 行在旧数据里不存在 ⇒ 视为 `0` / `false` / 无 / 无。

### 8.2 升级预检与迁移（B 负责）

- `GET /upgrade/preflight` → 只读体检：
  ```jsonc
  { ok:true, stateDir, counts:{tasks, longrun, phaseRows, notes, wakes},
    willDo:[ '为 N 个任务补 bossTouched', ... ], risks:[...], backupHint:'...' }
  ```
- `POST /upgrade/migrate` → 幂等迁移（写前先 `backupState()`）：
  1. 旧任务补 `bossTouched`（凡 `createdBy`/`mandate.sender`/历史 `byId` 是 Boss ⇒ true）。
  2. 有 `longrun` 但**没有任何 `phase` 行**的任务 ⇒ 按 `task.artifacts` 生成一条
     `{ kind:'phase', index: phases.length-1, state:'done' }`，让「已完成的长任务」也有阶段产物可看。
     这是**唯一的「推断写入」**，必须在 `note` 里写明 `升级迁移：按总产出物回填`。
  3. 已存在的 `phase` 行不动。
- 迁移失败 ⇒ 非 0 结果 + 明确理由，绝不半途而废地写一半（先备份，失败可从备份恢复）。

### 8.3 部署与回滚（Lead 负责）

- 交付物：`docs/升级08-接续与回滚.md`（怎么装、怎么验、怎么回滚到 0.7.5）。
- 部署脚本沿用 `install.sh`；升级前 `backupState()` 目录已存在 ⇒ 直接复用。

---

## 9. 文件分区（并行改码，**越界即冲突**）

| 人 | 独占写入 | 需求 |
|---|---|---|
| **A（前端）** | `src/client.js`、`src/settings.js`、`test/client-*.test.mjs` | 1, 2, 3(UI), 4(UI), 5(UI), 6(UI 展示), 7(UI), 8(UI) |
| **B（服务端）** | `src/api.js`、`src/teams.js`、`src/room.js`、`test/api-*.test.mjs`、`test/teams*.test.mjs`、`test/room*.test.mjs` | 3(数据), 4, 5(端点), 6, 8(服务端), 9 |
| **C（任务板/工具）** | `src/board.js`、`src/tools.js`、`test/board*.test.mjs`、`test/tools.test.mjs` | 3(存储), 5(字段), 7(progressBy), 9(兼容读), 新工具 |
| **Lead** | `package.json`、`CHANGELOG.md`、`docs/**`、`test/run-all.sh` | 版本号、变更记录、验收、部署 |

不许碰别人的文件。需要别人配合 ⇒ 在任务板**补一条任务/留言**，不要自己动手。

---

## 10. 总验收（Lead 执行，任何一条不过即退回）

1. `bash test/run-all.sh` 退出码 **0**，且用例总数 ≥ 1178 + 新增。
2. `bash test/ci-zero-dep.sh` 退出码 0（无第三方依赖）。
3. `grep -n "只看需要我管的\|看全部Boss的任务\|高级：租约\|延长 5 分钟" src/client.js` **无输出**。
4. `grep -n "需要你管的\|不由你操作\|别人别抢" src/client.js` **无输出**。
5. `node -e` 静态装载 `src/client.js` 通过（`test/client.test.mjs` 的 A 层必过）。
6. 需求 1–9 每条都有：① 代码落点 ② 对应测试 ③ 人话证据（命令 + 真实输出）。
7. 版本号 0.8.0 + CHANGELOG 写**为什么**，不只写做了什么。