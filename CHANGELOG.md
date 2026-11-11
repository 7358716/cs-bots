# 变更日志

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

**记录口径**：每条不只写「改了什么」，必须写「**为什么改**」——
因为发布后回看时，文件名和函数名都能从代码里查到，
只有当时的判断依据（踩过的坑、否掉的方案、真实事故）查不到。

> **版本序列说明**：`v0.3.0` 这个 tag 在远端已被占用（指向 `036748b`，
> 当时的 `package.json` 仍是 `0.2.0`，且未维护 changelog）。从 0.4.0 起
> 版本号、tag、changelog 三者对齐：**tag 已存在就必须递增，不许复用**。

---

## [Unreleased] - bots04（第 1 批止血 + 第 2 批桥本体）

> 第 1 批 = 定向唤醒 / kind 字段 / attachRoom（止血）
> 第 2 批 = `bot_team_route` 跨团队路由 / 环路防护 / 指标埋点 / 文档校验（补欠账）

### Added · 第 2 批：跨团队桥本体 `bot_team_route`

**这是「大团队 = 跨团队桥」的第一块实体。** 此前 42 个工具里**没有任何一个**
能让 Bot 表达「我要找另一个团队」—— 桥是断的。

```js
bot_team_route({ fromTeam?, toTeam?, toBot?, taskId, text, hop? })
// 成功: { ok:true, decision:'delivered', to:{kind:'team',id,leadId,name}, hop, wake }
// 被拒: { ok:false, decision:'refused', reason:'ROUTE_HOP_EXCEEDED'|... }
```

三条设计约束：
1. **只唤醒对方 `leadId`**，不唤醒全部成员（测试断言 `delivered.length === 1`）
2. **先落 route 事件再投递**（intent-first）——「记了没投」可重试；「投了没记」会绕过环路统计
3. 失败一律返回可读 `refused + reason`，**绝不静默**

**为什么 `toBot` 在 cs-bots 团队里找，不去 DSH 原生 `agentTeam` 找**：
实测 `grep -n "agentTeam|TeamId" src/teams.js` → 除新代码外**零命中**。
`teams.jsonl` 存 `{id, name, leadId, type, kind, members}`，而原生 team 是 `teamId = root.id`——
**两套人模型无 id 交集**。混用恰恰是 Boss 这次要区分的那个错误。

### Added · 环路防护（两道闸）

1. `hop > 3` ⇒ `ROUTE_HOP_EXCEEDED`（实测 hop 0–3 放行，hop 4 拒绝）
2. **复用 dispatcher 的 `dedupKey`**（没另造一套）：键 = `route:<from>:<to>:<taskId>`，
   **刻意不含 hop** —— 这样 A→B(hop0) 与 A→B(hop2) 是同一个键，
   dispatcher 的 `IdempotencySet` 判 `dedup-hit`，第 3 跳自然被拦。

> 为什么不把 hop 放进键：放进去就"每一跳都是新消息"，去重永远命不中，环路防护形同虚设。

### Fixed · route 审计记录重启后全丢（真 bug）

`hydrate()` 里 `if (!ev || typeof ev.id !== 'string')` 把 route 事件当残缺数据跳过 ——
**但 route 事件本来就没有 `id`**（它不改团队实体，只是审计记录）。

后果：`listRoutes` 重启后返回 0 条，而**环路防护和成本核算都依赖这份历史** —— 等于失效。
修法：回放时对 `action === 'route'` 单独放行。

### Added · 指标埋点补全（欠账2）

**之前 256 条 metrics 全是 `turn_end`** —— 因为只有 `index.js` 在回合结束自动记，
认领/完成/验收这些**真正该测的动作从没被记过**。PDCA 页面因此看不到验收通过率。

修法：在 `commit()` 埋点（**所有状态变更的唯一出口**，埋这里才不会漏）：
| board 动作 | 指标 kind |
|---|---|
| `claim` | `task_claim` |
| `complete` | `task_complete` |
| `block` | `task_blocked` |
| `accept(pass)` | `accept_pass` |
| `accept(reject)` | `accept_reject` |

**装配顺序坑**：`index.js` 里 board 在 L130 装配、metrics 在 L276 装配。
若只接受实例，board 装配时 metrics 还是 undefined ⇒ 埋点永久静默失效。
⇒ 改成接受**取值函数** `metrics: () => services.metrics`，规避顺序耦合。

**纪律**：埋点全包在 `try{}catch{}` 里 —— 指标是旁路，**绝不能**让业务动作失败。

### Added · 文档一致性校验（欠账3）

`test/docs-consistency.test.mjs`（5 项，随 `run-all.sh` 自动跑）：
① 主文档版本声明 == `package.json` version
② 文档里的「NNN 项测试」不得低于基线
③ 文档里的工具数 == `TOOL_NAMES.length`
④ 历史快照必须保留「勿引用/已过期」标记
⑤ `reports/` 交付报告必须存在

**它上线当天就抓出真失真**：
```
docs/02-03-04 声明 v0.7.3，实际 0.8.0
5 处写 1108 项测试，实际 1263
```

**刻意不做的事**：
- 不改历史叙述（`01-架构文档.md` 里「0.7.3 已部署重启」是当时事实，改写就是伪造历史）
- 不校验 CHANGELOG（它本来就按版本分段记历史）
- 测试数用**下限**而非精确相等（否则每加一个用例就红一次，最后会被人 disable —— 比没有还糟）

---

## [Unreleased] - bots04 第 1 批「止血」

大团队语义澄清后的第一批落地。**核心是止血**：修掉一个已经在烧 token 的实测缺陷。

### Fixed · 唤醒风暴（实测已在烧钱）

**改造前实测**（`~/.dsh/cs-bots/wakes.jsonl`）：
```
room-msg:m-1:ui         → failed    ← 居然去唤醒 Boss 自己
room-msg:m-1:bot-6b65…  → failed
room-msg:m-1:bot-df1c…  → failed
```
一条房间消息 = 3 次唤醒尝试，**3 次全失败**。

**两个根因**：
1. `relay` 的 `targets` 缺省 = 「除发送者外全部成员」⇒ 一条消息 N 个成员 = N 次模型调用；
2. 人类身份（`ui`/`user`/`person`）被当成普通成员 ⇒ **去唤醒人**，这没有任何意义。

**修法**（`src/room.js`）：
- `DEFAULT_SETTINGS` 新增 `mentionOnly: true` —— **缺省安静**，要广播必须显式打开
- 新增 `HUMAN_IDS` + `isHumanId()`，**任何模式**下 human id 都不被唤醒
- `relay()` 重写为四档 `targetSource`：
  | 档 | 行为 |
  |---|---|
  | `explicit` | 显式 targets 原样；混入 human 剔除 + warn |
  | `mention` | @ 到谁只唤醒谁 |
  | `mention-only-no-target` | **没 @ ⇒ `relayed:0` 且不抛错**（止血核心） |
  | `broadcast` | `mentionOnly:false` 才回退全员，且仍排除 human |

**为什么缺省是 `true` 而不是 `false`**：安全的默认值必须落在「少打扰」这一侧。
要广播是少数场景，让它多打一次字，比让每条消息都烧 N 次调用更划算。

### Added · 团队归属标识 `kind`

`teams.jsonl` 新增 `kind: 'human' | 'agent'`：
- `by ∈ {ui, user, person}` ⇒ **强制 `'human'`**
- 其他 ⇒ **强制 `'agent'`**
- 显式传入与推导矛盾 ⇒ **抛 `TEAM_KIND_MISMATCH`**

**为什么必须服务层强制推导、不信任入参**：`createdBy` 是可冒用的字符串。
Bot 传 `by:'ui'` 就能自称「Boss 建的团队」—— 那两个方向的伪造都得拦：
Bot 谎称 Boss 建（骗信任）、Boss 谎称 Bot 建（掩盖归属）。

**与 `type(big|small)` 的关系**：`type` 保留但**降级为规模提示**，不再承载「谁建的」语义。
历史数据缺 `kind` ⇒ 前端按 `createdBy` 兜底，不显示 undefined。

UI 徽标：**`👤 Boss建设`** / **`🤖 智能体建设`**。
> 文案纪律：**不用「人建」**（Boss：「不太好听」）。连注释里也不许出现。

### Fixed · 桥断了：`bot_teams_add` 不建房间

`attachRoom` 只在 API 层（`src/api.js:1555`）有，**工具层没有** ⇒
智能体用 `bot_teams_add` 加人后团队与房间脱钩，**跨团队消息发不出去**。
这是「大团队这座桥是断的」的直接原因。

**修法**（`src/tools.js`）：加成员后若 `team.roomId` 存在则自动 `room.join`；
失败**不阻断**团队编辑，返回 `{ok:true, team, roomError}` 留痕。

**过程教训**：初版在工具 `run` 里调 `warn(...)`，但 `warn` 只是 `installTools` 的**形参**、
不在工具闭包作用域内 ⇒ `ReferenceError: warn is not defined` 导致工具整体失败。
工具闭包里只能拿到 `ctx`，拿不到安装期的形参。

### Added · 测试（+22，基线 1241 → 1263）

| 文件 | 新增 |
|---|---|
| `test/room.test.mjs` | +6（mention 定向、无 @ 静默、human 排除、显式 targets 剔除、settings 白名单、回放持久） |
| `test/teams.test.mjs` | +5（Boss⇒human、Bot⇒agent、矛盾抛错、事件流持久、与 type 并存） |
| `test/tools.test.mjs` | +3（自动入房、无房间不报错、join 失败不阻断） |
| `test/client-t38.test.mjs` | 新增 7 项（徽标文案、不置灰、@ 提示） |

**变异验证**（确认断言不是摆设）：
| 变异 | 结果 |
|---|---|
| `mentionOnly: true` → `false` | 5 用例转红 |
| `derivedKind` 硬编码 `'agent'` | 4 用例转红 |
| 关掉 auto-attach 分支 | 2 用例转红 |

### 认知纠正（记录在案，避免后人重踩）

旧调研 `design/大团队-可行性调研-v1.md`（11-06）把大团队定位成「组织层 / 聚合视图」，
**这个定位错了**。Boss 2026-11-11 正式澄清：大团队是**跨团队沟通的桥梁**（路由层）。

> **小团队是「谁干活」，大团队是「谁跟谁说话」。**

另外调研里「小团队：Lead 自动 spawn，人不进去」也**不准确** ——
官方 `dsh-experimental-client-ui-agent-team/README.zh.md` L34/L91/L184 证实：
用户**能**点进 active teammate 会话发言，走 addressed-subagent 路径。
正确表述是「人可以进，只是不常进」。

### 已知限制

- 「Boss 发言同步给 DSH 原生团队 leader」**本批未做**。3 条硬限制：
  ① 官方无「Bot→Lead 发 peer 消息」公开工具；
  ② teammate 投递需 Lead-to-child edge 授权，sibling 消息不能伪装成 Lead；
  ③ cs-bots 当前无法读取 `agentTeam` 投影（只在 `compat.js:150` 探测服务存在）。
  ⇒ 需单独立项 2–3 天，硬做只能走「伪装成 Lead」，违反官方不变量。
- 跨团队定向请求（`bot_team_route`）未实现，属第 2 批。

---

## [0.8.0] - 2026-11-10

改造09「Boss 体验 + 任务可管理性 + 升级接续」。
一句话：**把「你」从界面里清干净，把准主权还给 Boss，把升级风险压到可回滚。**

测试：1191 → **1242 项**（新增 51 条：后端 40、前端 11），`bash test/run-all.sh` exit 0。

### Added · Boss 能直接动手（需求5）

- **`TaskBossActions`**（`src/client.js`）：任务详情内联五类操作 ——
  改优先级/截止/复杂度档位(T0–T3)/是否付费、改目标与边界(`description`/`writeScopes`)、
  换负责人/收回/重新派发、阻塞/解阻塞/关闭归档、编辑长任务阶段清单。
  **为什么**：此前这些只能靠 Bot/Lead 改，Boss 想看「这活卡住了」想自己挪一下都做不到。
  实测 48 条唤醒记录里 12 条失败，Boss 没有手边手段介入 —— 这是最直接的体验断裂。
- **`TaskPhasePanel`**（`src/client.js`）：任务详情直接列**每个阶段的产物**，
  四态徽标（已完成/卡住/进行中/未开始），路径可预览、URL 可打开。
  **为什么**：过程产物原本埋在 `task-meta.jsonl` 里，Boss 只能看到最终 `artifacts`。
  「活干到哪了」是长任务最常被问的问题，答案必须在一屏内。
- **`bot_task_phase`**（`src/tools.js`，工具数 41 → **42**）：智能体按阶段回报产出物。
  **为什么**：没有这个工具，阶段进度只能靠 Lead 手工转述 —— 转述即失真。
  新工具严格是**纯增量**，38 个既有工具契约一字未改。
- `progressBy` / `progressAt`（`src/board.js`）：进度写入者与时间。
  **为什么**：Boss 和队长都会改进度，页面必须能说清「这个百分比是谁填的」，
  否则 Boss 改完被队长估算覆盖，会以为自己的操作没生效。

### Changed · 一套口径 + 一个任务栏（需求1、2）

- **全站「Boss」单一口径**：`HUMAN_LABEL='Boss'` / `HUMAN_SELF_LABEL='Boss（你）'`，
  `humanizeBy()` 把 `ui`/`user`/`human`/`boss`/`anyone` 统一显示 `Boss`，历史 `（ui）` → `（Boss）`。
  **为什么**：此前「你 / 用户 / 派活方 / （ui）」四种叫法混用，Boss 原话是
  「界面里到处是『你』，我不知道说的是我还是别人」。机器标识（`by:'ui'`）保留在技术字段里，
  但凡**人眼可见**的字符串一律 `Boss`。
- **工作区页签改名《任务栏》**，默认**全量**：请求 `GET /tasks` 不带 `attention`、不带 `source`；
  只有《智能体任务》子页签带 `source=ai`。
  **为什么**：原「只看我管的 / 看全部」开关是**替 Boss 决定他该看什么** ——
  默认藏任务是最糟的默认值。Boss 要的是打开就看到全部。
- **进度可编辑且标来源**：`当前完成度 N%（队长估算｜Boss 设定）`，
  `estimate` 单独一行「预估工作量 X（队长估的投入，跟完成度不是一回事）」。
  **为什么**：原先把「估的工时」和「完成百分比」挤在一句里，Boss 明确说过看不懂。

### Changed · 团队与房间打通（需求3）

- **建团队自动建议事厅**：`` `${team.name} · 议事厅` ``，成员 `[leadId, ...members]`，
  `adminId = leadId`，`teams.attachRoom()` 把 `roomId` 持久化到团队事件流。
  **为什么**：建完团队还要手工建房间、手工拉人，是纯粹的重复劳动；
  更糟的是 `attachRoom` 实现了却**没导出**，导致 `roomId` 永远不落盘 ——
  dsh-web 一重启房间关联就丢，这正是「历史会话不显示房间」的根因之一。

### Changed · 派活失败可见可救（需求6）

- **`GET /tasks/diagnose`**（`src/api.js`）+ **「诊断这个任务」**按钮（`src/client.js`）：
  一次性给出 verdict / advice / 会话是否在线 / 预设 / 最近唤醒记录。
  **为什么**：Boss 报的真实故障是「核实专员已多次指派，subagent 持续失败，无产出」——
  48 条唤醒记录里 12 条 `agent-not-live`，但界面上**什么原因都不显示**，
  Boss 只能反复重试。失败必须说人话。

### Changed · 租约退场（需求8）

- 删掉「高级：租约」Section 与「延长 5 分钟」按钮；`defaultLeaseMs` 文案改「任务占用默认时长」。
  **为什么**：Boss 原话「不用给我展示租约，我希望随时发送信息就可以激活，不需要点击」。
  改为**发消息即自动激活**（`/tasks/note`、`/tasks/wake` 内 `autoActivate`：
  进行中 ⇒ 心跳，待领 ⇒ 自动接活），失败不阻断唤醒、只把原因回给页面。

### Added · 升级接续（需求9）

- **`GET /upgrade/preflight`**：只读体检（一个字节都不写），给出 counts / willDo / risks / backupHint。
- **`POST /upgrade/migrate`**：幂等迁移 —— 补 `bossTouched`、为「已完成长任务但无 phase 行」按总产出物回填末阶段产物，
  既有 phase 行不动。**先备份**，备份失败则一个字节不动。
- **`docs/升级08-接续与回滚.md`**：怎么装 / 怎么验 / 怎么退回 0.7.5。

  **为什么必须「逐条合并」而不是重写整个 board 文件**：
  `board.jsonl` 是 CAS 幂等键与 `rev` 语义的真相源。整体覆盖重写只要漏一个字段，
  任务的 `rev` 就和前端手里的对不上 —— Boss 需求「任务原样存活」当场破功，
  而且**症状是隐性的**：页面照常打开，只是任务状态悄悄回退。

### Fixed · 三个真 bug（都是这轮改出来的，都带回归测试）

1. **任务抽屉白屏（P0）**：`TaskDrawer` 在组件体顶层读 `task.progressBy`，
   首渲染时 `data` 还没到、`task` 是 `undefined` ⇒ `TypeError`，**整个抽屉白屏**。
   改为 `task?.progressBy`。**为什么非改不可**：这不是测试问题，是任何任务点开就白屏的线上故障。
2. **同一秒内备份路径碰撞（数据风险）**：`backupState` 用秒级 `_tsLabel()` 拼目录名，
   同一次迁移里 `board.jsonl` 与 `task-meta.jsonl` 的备份若落在同一秒，
   `cpSync(force:true)` 会**互相覆盖 —— 回滚点丢一个**。
   修法：备份 tag 带上 `Date.now()`，保证同一秒内两次备份必不同名。
3. **`/tasks/wake` 幂等键漂移（R15 回归）**：§7.2 的 `autoActivate` 会 bump `rev`，
   若先激活再算 `task-wake:<id>:<rev>`，`force:false` 的重试键就会跟着漂，
   契约「同一任务同一 rev 的重试只唤醒一次」被破坏。
   修法：**先算 dedupKey（用激活前的 rev），再 autoActivate**；§7.2 自动心跳本身保留。

### Security / 稳健性

- **迁移绝不静默半残**：`store.migrate` 在 `current === to` 时不调 `migrateFn`，
  导致「首次迁移后新建的 Boss 任务永远补不上 `bossTouched`」。
  `src/api.js` 内绕过版本门控自行原子写回（`tmp → rename`），
  并在返回里**如实标注** `schema.bypassedVersionGate: true` —— 隐藏这个事实比绕行本身更危险。
- **产出物超限拒绝而非截断**：单条 > 2000 字直接报错。
  理由写在 `normalizePhaseArtifacts` 注释里：**产出物是证据，悄悄丢掉一条比拒绝写入更糟**。

### 已知限制（如实记录，别让后人误判）

- 「发消息激活 + 唤醒失败回滚」的**组合路径只有单测**，没有集成测试。
- 需求6 的派活失败**根因在宿主侧**（session 生命周期/懒加载），cs-bots 做的是
  「让失败可见 + 可诊断 + 不静默」，不是修复宿主。
- `docs/ARCHITECTURE.md` 是 v0.6 历史快照（文首标「勿引用」），本轮**故意不动**，
  现状以 `docs/01-架构文档.md` 实测为准。

---

## [0.7.5] - 2026-11-10

精简发布说明（≤50 字）。

---

## [0.7.4] - 2026-11-10

「修复 Bot 工具面 + 投递留痕 + 准入闸落地」版。v0.7.3 之后累计 14 个提交，
核心修的是两个会直接影响使用的问题：Bot 挂不上宿主工具面、唤醒投递静默失败。

### Fixed

- **Bot 工具面从未挂载**：`agents.create()` 从不传 `setup`，`composePresetSetup()`
  修好后 Bot 才真正拿到宿主能力（read/write/bash/web_fetch 等）。
- **消息 source.kind 用了 v4 废弃的 plugin 包装**：所有唤醒投递被拒收，改回正确的 kind。
- **投递回执看护补全**：补 superagent 的 `inputsRead` 层，并上报到 /status（否则装配失败也显示一切正常）。

### Added

- **团队管理员权限边界**：`adminPolicy` 三档策略，服务端强制 + 403 语义。
- **团队「工作区」页签**（需求4）。
- **任务「长任务」** 一次到位（需求3）。
- **Bot 页「把会话挂进工作区」按钮**（存量 Bot 补挂）。
- **投递留痕合并写入与清除** + 重试唤醒按钮恒可用。

---

## [0.7.3] - 2026-11-09

「照 superagent 补齐自己缺的那一层」版。
对照官方 `deepseek-ai/dsh-superagent-prototype` 的架构逐层比对后，
cs-bots 的上层（任务板/团队/房间/PDCA/纪律/记忆）与它的执行层本就是两套东西，
真正缺的是**它那里的三件纪律**：阶段分类、授权留痕、准入闸。本版补齐。

### Fixed

- **执行阶段分类器原本是「结构性死件」（改造07 的 4/8 行从未可达）**
  `src/stage.js`（245 行）此前已在 `5809e7a` 落地，本轮**没有重写它** ——
  真正坏的是写侧：`board.js` 从不写 `latestReport`/`attention`，
  于是 `person/answer`、`person/blocked`、`person/failed`、`idle` 四行永远判不出来；
  `accept()` 只写 `acceptance` 不写 `accepted`，而分类器与 `needsAttention` 读的都是
  `accepted` ⇒ 「已验收 → idle」这条分支**在代码上不可达**（人永远看到「等你验收」）。

  修法不是再加字段，而是**让写侧去补分类器已经读的东西**：
  - `complete` / `block` 把 `outcome` 落成 `latestReport.state`（input 名，不新增顶层字段 ——
    否则 `latestReport` 就成了第二处真相源，与 `stage.js` 抢）；
  - `applyNewFields` 里 `outcome` 与 `humanAction` **各自独立**处理，
    且只删自己的子字段（原来会整份删掉 `latestReport`）；
  - `accepted` 与 `acceptance` **同生同灭** —— 这条必须守死，
    否则 `accepted` 又被写歪，死分支会第三次复活。

  另有两处「顺手做对更贵」的坑：
  - `complete` 拒绝携带 `humanAction`：`person/answer` 优先级高于 `person/review`，
    一个已完成还带着 attention 的任务会显示「等你回答」而不是「等你验收」；
  - `block` 拒绝把 `blockedReason`（诊断）冒充成 `attention.question`（问题）：
    两者混在一起，人会在「等我回答」里看到一句「端口被占用」而不知道该回什么。

### Added

- **任务授权留痕（借鉴 superagent Mandate）**
  `POST /tasks` 与 `bot_task_create` 统一接受扁平参数 `mandateBasis`
  （`explicit|inferred|task-board|room|cycle`）+ `mandateSender`，落到 `task.mandate`。
  参数名两边**同形**：同一概念出现两种形状，调用方就得记两套规则。
  写进 `board.js` 的 `MANDATE_BASES` 白名单，非法值 400。
  锚定文案在**有依据**时才渲染授权块，且必须写清「这是推断还是明确」、
  以及「超出此授权范围的新需求要重新要授权」 ——
  没有 `basis` 就不渲染（UI 随手建的任务记的是「谁建的」，渲染成「授权」等于编造授权）。

- **房间消息准入闸（借鉴 superagent 两段式准入 Gate + Assessment）**
  新增 `src/admission.js`（纯函数、零依赖）：判一条消息是
  `explicit`（明确要你，直接做）/ `inferred`（候选，要评估）/ `ignore`（不相关）。
  只有前两者进订阅上下文；`ignore` 的**连上下文都不记** —— 省 token、省打扰。
  逐格对齐官方准入表，四点反直觉但有出处的纪律：

  | | 点名 | 没点名 |
  |---|---|---|
  | 在名单上 | `explicit`（**不在表里**） | `inferred` |
  | 不在名单上 | **`ignore`**（缺省） | `ignore` |

  1. 不在名单上的人点名你 ⇒ 缺省 `ignore`。「明确」的前提是**在名单上**；
     放行等于绕过订阅权限。正确做法是让他订阅。
  2. `inferred` 是「候选」不是「放行」；`off` 下候选不成立（连候选都没有）。
  3. 未点名那两格**只对「收全部消息」的来源开放**；房间群聊缺省 `receivesEveryMessage=true`。
  4. **机器人永远不能造出 `explicit`**（即使表格该格设为 explicit）。

  实装时踩到一个自己的坑：`observe` 与 `auto` 的差别**不在 Gate**（两者都产出候选），
  而在评估之后。初版把 `observe` 做成「不评估」，那样「would accept」永远没有依据。
  另一个坑：Gate 阶段 `wouldAccept` 恒 `false` —— 它是评估阶段的记录，不能提前伪造。
  `fanout()` 已接入 Gate，唤醒条件改为 `shouldWake AND admission===explicit`。

- **并发槽位（借鉴 superagent WorkerSlots）**
  `board.claim` 新增 WIP 上限闸门：bot 在 `in_progress` 任务数达上限时拒绝再领。
  **人是 `+1` 的**（`effectiveWipLimit = wipLimitPerBot + (by==='person'?1:0)`），
  理由是官方那句 `New work therefore cannot prevent a person from continuing an existing Ticket` ——
  上限是对**自动化流量**的闸门，不是拒绝人的借口。
  错误报文带 `limit/baseLimit/personBonus/current`，便于排障。

### Changed

- **任务结论区补「当前阶段」行**：`GET /tasks/summary` 已返回 `stageInfo`，
  但结论区（人打开任务详情最先扫的那一屏）没渲染它。
  同时把渲染守卫的条件加入 `stageInfo`：阶段是**从任务状态实时推导**的、永远真实存在，
  只按 `currentProgress/nextStep` 判断会让「刚派下来还没写进度」的任务连阶段都看不到 ——
  而那正是人最想知道的时刻。

### 测试

`1108` 项全绿（`bash test/run-all.sh`，exit 0）。本轮新增 41 项：
`admission.test.mjs`（28，逐格锁死准入表）、`board.test.mjs`（5，含写入侧缺口与 WIP）、
`subscription.test.mjs`（8，Gate 真实路径）、`api.test.mjs`（10，含 HTTP 侧授权与房间扇出）。

## [0.7.0] - 2026-11-06

「任务可以改」版。一句话：**已完成不是终点**——可以纠错、优化、变更、换负责人，
还能把任务转成「长任务」（带阶段清单，每次唤醒都带上，防跑偏）。

### Added

- **任务变更中心（`POST /tasks/evolve` + `GET /tasks/changes`）**
  三种变更方式，都要求填「变更说明」（**没有理由的变更不许进历史**）：

  | 模式 | 语义 | 关键设计 |
  |---|---|---|
  | `reopen` | 纠错 / 继续做 | **重开前先把「当时的样子」快照进 `task-meta.jsonl`** |
  | `followup` | 优化 / 修复单（原任务保持已完成） | 幂等键 `evolve:<id>:<note的sha1>` |
  | `longrun` | 转成长任务（可带阶段 + 可选重开） | 阶段清单注入锚定文案 |

  为什么必须快照：内核 `board.reopen` 会**清掉 `artifacts`/`acceptance`/`completedAt`**。
  这是内核行为（`board.js` 冻结不能改），但「上一轮交付了什么」是纠错和优化的唯一判据，
  所以变更前先存档，`GET /tasks/changes` 返回 `latestSnapshot` 给页面显示
  「上一轮交付物：…（已存档，重开不会丢证据）」。

  为什么 followup 幂等键用 note 的 sha1 而不是 `task.rev`：同一个理由连点两次应该只建一张；
  但**不同**理由是不同的诉求，必须各建一张 —— 用 rev 会让第二次派生静默命中第一张，
  用户看不到自己新写的理由。

- **换负责人（`POST /tasks/reassign`）**
  为什么不能复用 `/tasks/assign`：`board.claim` 会拦三种情况——租约被他人持有、
  任务已完成、WIP 超限。换负责人必须**先以原持有者身份 release** 再 claim。
  已完成的换人会返回 `code:"TASK_COMPLETED"` 并提示「先重开或派生优化单」，
  而不是把 `BOARD_ALREADY_COMPLETED` 原样丢给用户。

- **长任务阶段清单进锚定文案**
  `buildTaskAnchorText` 在有 `longrun` 记录时插入：
  ```
  阶段（长任务，按序推进，不得跳步）：
  1. <phase1>
  2. <phase2>
  ```
  没有 longrun 记录时输出**逐字不变**（既有逐行文案断言继续通过）。
  这样「转长任务」不是贴个标签，而是**真的改变了每次唤醒带给 Bot 的内容**。

### Fixed

- **「去对话」报「该负责人不是本平台的 Bot…定位 ui」**
  `ownerId` 是**租约持有者**（人会自己 claim 成 `ui`，验收时也会被覆盖），
  「这活原本派给谁」记在 `assignee`。旧实现只看 `ownerId` → 拿 `ui` 去 roster 找 →
  必然找不到 → 报一句无解的错误，让用户以为任务没派出去。
  现在按 `assignee → ownerId → task.ownerId` 解析，并过滤 `ui/user/anyone/system`
  这类平台伪身份；找不到时也只说「可能已退役/外部会话」，不再糊一句无解。

### Tests

- `test/api-evolve.test.mjs`（15）：三模式 + 快照 + followup 幂等 + 前缀规则 +
  reassign 的已完成/WIP/租约交还 + longrun 文案（有/无的差异）
- `test/client-evolve.test.mjs`（16）：变更区三按钮与历史、换负责人弹窗、完成态默认展开
- `test/client-goto.test.mjs`（8）：负责人解析回归（含用户实测的 `ownerId=ui` + `assignee=bot` 场景）
- 基线：786 → **825**，全部通过（exit 0）；ci-zero-dep PASS

### Docs

- `design/CONTRACT-bots06.md`（任务变更中心契约）
- `design/大团队-可行性调研-v1.md`（多 Lead 组织层调研：结论是做成「组织层」而不是「引擎」，
  三档方案 + 两个必须先解决的风险）

---

## [0.6.1] - 2026-11-06

修「创建任务指派 Bot 报错」。一句话：**不是派活逻辑坏了，是重启后 Bot 会话没被加载**，
现在投递前自动复活会话，并把 `agent-not-live` 从「红色报错」变成「可点的两个按钮」。

### Fixed

- **派活/发言/补充说明全部报 `agent-not-live`**
  真实链路（有证据，不是推测）：任务建成了 → `board` 里 `claim` 成功（`rev 2 → in_progress`）→
  但 `wakes.jsonl` 记录 `{"reason":"task-assigned","result":"failed","detail":"agent-not-live"}`。
  根因：11:38 重启 dsh-web 后，宿主**不会**把旧会话自动加载进 `agents` live 注册表（懒加载），
  而 cs-bots 侧的 `kernel.resumeSession` **全项目零调用**（只有定义）。
  会话文件其实都在磁盘上（`~/.dsh/sessions/…/bot-…`），所以 resume 能救回来。
  为什么这个 bug 危险：界面上它长成「派活报错」，会让人误以为任务没派出去，
  而实际上任务已经派了、只是执行者不知道 —— 沉默的任务比报错更贵。

- **房间发言的唤醒也全挂**（同一个根因）：`wakes.jsonl` 里 `room-message` 三条全 failed。

### Added

- **`ensureLive(ctx, sessionId)`**：已 live 直接返回（**零副作用**）；未 live 才 `agents.resume`；
  resume 抛错只返回 `reason`，**绝不抛**（否则用户看到的会是 500 而不是原因）。
- **投递前自动复活**：`/tasks/assign`、`/tasks/note`、`/bots/message` 三处在 `dispatcher.notify`
  之前插入 `ensureLive`，响应新增 `revived` / `reviveReason`。原本就在线时行为**完全不变**。
- **`POST /bots/revive`**：`{botId}` / `{sessionId}` / `{all:true}`。`all` 串行复活全部未退役 Bot，
  返回 `{total, revived, live, failed:[{sessionId,reason}]}` —— 这是「重启后一键救场」。
- **`POST /tasks/wake`**：手动重试唤醒。为什么必须单独一个端点：
  `/tasks/assign` 的 dedupKey 是 `task-assigned:<id>:<rev>`，重试时 rev 没变 ⇒ 命中幂等 ⇒ 返回
  `skipped`，人点「重试」看起来像没反应。`force`（缺省 true）换成 `task-wake:<id>:<timestamp>` 才真的再唤一次。
- **前端**：`agent-not-live` → 「该 Bot 会话当时没在运行」（不再直译后端 reason）；
  唤醒失败时给「启动该 Bot 会话」「重试唤醒」两个按钮；Bot 卡片加「启动会话」；
  Bot 页头加「全部启动」（重启后一键拉起全部会话）；后端自动复活成功时提示「（已自动启动该 Bot 会话）」。

### Tests

- `test/api-revive.test.mjs`（16）：ensureLive 三态（已 live 绝不 resume / 未 live 会 resume /
  resume 抛错不抛且有 reason）、三处投递点自动复活、原本在线行为不变、`{all:true}` 批量与部分失败、
  `/tasks/wake` 的 400/404/force 换键/force:false 幂等。
  测试里刻意把 Bot 从 live 集合里摘掉来**精确模拟重启后的冷会话**。
- `test/client-revive.test.mjs`（11）：文案翻译、两个按钮存在且真的 POST 对应端点、Bot 页「全部启动」。
- 基线：759 → **786**，全部通过（exit 0）；ci-zero-dep PASS。

---

## [0.6.0] - 2026-11-06

「一站式工作台」版。一句话：把**派活 / 补充 / 沟通 / 跳转**四件事全收进协作平台页面，
并给每个任务一份**不可变的目标锚**，从机制上防住长任务的目标漂移。

### Added

- **目标锚（`GET /tasks/brief`）**
  为什么：长任务最常见的失败不是做错，而是**做着做着目标漂了**——几十轮对话后
  Bot 记住的是「最近一条消息」，不是「当初要什么」。所以把创建时的
  `subject + description + writeScopes + blockedBy` 冻成**目标锚原文**，
  `brief` 永远返回这份原文 + 一段可直接投递的锚定文案（字段恒定、格式固定，测试按行断言）。
  `anchor` 里的 `status/ownerId/progress/artifacts` 是**当前快照**，不是冻结值——
  冻结的只有「目标与边界」，状态本来就该变。

- **补充说明（`POST /tasks/note` + `GET /tasks/notes`）**
  为什么：人的补充天然是「追加」而不是「改写」。落**新文件** `task-notes.jsonl`
  （append-only，不改 board 事件流、不动 `board.js`），编号 `n-<seq>` 不复用。
  每条补充都触发一次定向唤醒，且**投递文案 = 全量锚定文案 + 这条补充**——
  这是「不失真」真正落地的地方：Bot 每次被唤醒看到的都是完整目标，而不是增量碎片。
  去重键 `task-note:<taskId>:<noteId>`，同一条补充只唤一次。
  `wake:false`（或任务没 owner）时只存档不唤醒，且 `wake` 返回 `null` 而不是假装 sent。

- **直发消息（`POST /bots/message`）**
  为什么：以前从平台跟 Bot 说话必须先去会话列表找到它。现在 Bot 卡片上「发消息」
  直接 `dispatcher.notify(reason='room-message')`，带 `botId` 或 `sessionId`，
  给了 `taskId` 就自动前置完整锚定文案。缺省 dedupKey 用 `sha1(taskId+text)` 前 16 位，
  重复点发送不会唤醒两次。未知 sessionId 仍允许（可能是主对话），但响应里 `knownBot:false` 明说。

- **前端：Bot 页「派任务」「发消息」**
  「派任务」= 建任务 → 立即 assign → 唤醒，一步完成；唤醒结果 `sent/skipped/failed(reason)`
  必然显示；「任务已建但派活失败」会直说，不假装成功。

- **前端：任务详情「目标锚 / 补充说明 / 去对话 / 复制派发文案」**
  锚区块只读并标注「补充说明只追加不覆盖」；补充说明无 owner 时按钮改成
  「保存补充（未派活，暂不唤醒）」；「去对话」用 `uiWorkspace.openSession` 直接跳，
  不是本平台 Bot 时提示 + 给复制 ID 兜底；没有 `brief` 接口时用任务当前内容兜底展示，不白屏。

- **前端：房间消息 → 建任务**
  hover 出现「⇢ 建任务」，标题取正文首行截 80、描述带全文与出处，
  `sourceSeq = room:<roomId>:<seq>` 走 board 既有幂等索引——同一条消息重复点不会建出第二个任务。

### Changed

- 版本号 0.5.0 → 0.6.0；`docs/操作手册-v1.md` 升级到 0.6.0（新增 §1.9 派活 / §1.10 目标锚 / §1.11 跳转 / §3.6 房间与任务的关系）。

### Tests

- 新增 `test/api-anchor.test.mjs`（12）：brief 文案逐行结构、notes 空/连加两条不覆盖/at 升序、
  note `wake:false` 不调 dispatcher、note 唤醒文案含全量锚定、bots/message 的 400/404/超长/幂等键。
- 新增 `test/client-anchor.test.mjs`（11）：新按钮/文案存在、五个新端点被调用、首渲染不抛、幂等键格式。
- 基线：736 → **759** 个测试，全部通过（exit 0），零第三方依赖（CI PASS）。

---

## [0.5.0] - 2026-11-06

「看得见、管得动」版。一句话：把用户抱怨的三件事——**没有数据库页、没有成果页、
任务发布不明确、房间看不到历史对话**——逐个补上，并且**不引入任何第三方依赖**。

### Added

- **成果库（`GET /artifacts` + 「成果」页签）**
  为什么：`artifacts` 原本只在任务详情里作为一行文本出现，「最近交了哪些东西」
  只能一个个任务点开。现在按任务聚合，支持关键词/负责人/状态筛选，点卡片回任务详情。
  `items` 统一归一成字符串数组（对象用单行 JSON），前端不用判类型。

- **数据只读浏览（`GET /data/files`、`GET /data/rows` + 「数据」页签）**
  为什么：用户明确说「没看到数据库」。cs-bots 在零依赖约束下**不能装 SQLite**，
  存储是事件流 jsonl + 快照 json。与其引入依赖，不如把已有存储**摊开给人看**。
  安全红线：文件名/子目录走后端白名单（`^[A-Za-z0-9._-]+$`，拒绝 `..`），
  非法输入一律 400 —— 这页能读文件系统，穿越漏洞等于把整台机器交出去。
  **只读**：不提供任何写接口，写入仍走域服务 + CAS。

- **任务依赖图（`GET /tasks/graph`）**
  为什么：「点击任务能看到主任务流程进度」需要的是**上下游关系**，不只是
  `blockedBy` 一行 id。带 `id` 时返回传递闭包（上游递归 + 下游 dependents），
  前端据此画依赖链；节点字段恒定出现（缺省 ownerId=null / priority=0），
  避免前端到处判 undefined。

- **任务看板视图（Kanban）+ 筛选增强**
  4 列（待办/进行中/已完成/已终止），卡片显示负责人、进度条、优先级、前置数。
  新增负责人下拉 + 关键词本地过滤（不改后端 query，避免每次输入都打接口）。

- **任务进度可编辑**
  详情里直接填 0–100 保存，走 `action:'edit'`，带 `expectedRev`——冲突照旧会抛，
  不会静默覆盖。

- **房间历史分页 + @提及高亮**
  为什么分页用前端切片而不是后端 `sinceSeq`：`sinceSeq` 的语义是「取 seq 之后」，
  是**向后**取；「加载更早」需要**向前**。为不改后端契约，前端先拿全量再只渲染末尾 N 条，
  「加载更早」每次 +50。@提及只做文本节点拆分高亮，**不用 dangerouslySetInnerHTML**。

### Changed

- 版本号 0.4.0 → 0.5.0。
- 页签从 7 个扩到 9 个：新增「成果」「数据」（顺序：任务 · Bot · 房间 · 成果 · 记忆 · 技能 · 工作流 · 数据 · 设置）。

### Fixed

- `useApi(path=null)` 之前会请求 `/null`；现在 null/falsey 直接空转，不请求。
  为什么：数据页没选文件时不该产生一个必然 404 的请求，那会污染错误提示。

### Tests

- 新增 `test/api-artifacts.test.mjs`（13 个）：成果聚合（空库/过滤/对象归一/limit 夹取）、
  数据文件列表（只扫直属、扩展名过滤、行数）、行分页、坏 JSON 不崩、
  **目录穿越被 400 拒绝**、依赖图全量/闭包/404/删除任务不进图。
- 基线：720 → **733** 个测试，全部通过（exit 0）。

---

## [0.4.0] - 2026-11-05

v2 能力交付版。一句话：把「AI 该怎么协作」从散落的约定，
变成**有页面、有 API、有门禁、可回放**的一等公民；
同时把上一轮为了塞能力而膨胀到 11 个的页签**收敛回 7 个**。

### Added

- **待办 → 任务的升级通道（`POST /todos/promote`，幂等）**
  为什么：待办是「我决定要做」，任务是「决定交给谁做」，两者是同一条漏斗的上下游。
  以前只能靠人复制粘贴，升级动作一多就必然漏字段、丢上下文。
  幂等靠任务板的 `sourceSeq = todo:<id>`：连点两次「派下去」只会产生**一个**任务，
  不会因为手抖多出一条重复任务；升级后原待办自动置为 `doing`，
  避免它继续出现在「要关注」里被重复安排。CAS 冲突返回 `TODO_REV_CONFLICT`。

- **分级纪律体系（`src/discipline.js`）**
  为什么：同一条规矩，写死在某个 Bot 里就复制 N 份，改一次要改 N 处；
  全塞进全局又会让「本项目的特殊要求」污染所有项目。
  所以按 `global → workspace(cwd) → room → bot` 四级分层，越具体越优先；
  支持 `rule / requirement / principle / style` 四类与 `priority`；
  合并时按标题去重（具体层覆盖宽泛层），并按 token 预算裁剪，
  超预算时**明确告知**「已省略 N 条」，不静默截断。

- **四轨待办（`src/todo.js` + 「任务 → 我的待办」子视图）**
  为什么：人的待办天然分轨——生活 / 工作 / 项目 / 每日。
  混在一个列表里，结果就是「想做的」把「必须做的」淹掉。
  另配四象限与智能视图（今天该做什么、什么过期了），
  项目轨强制要求 `cwd`（`TODO_CWD_REQUIRED`）：项目待办不属于任何项目就失去意义。

- **便签（`src/scratch.js` + 「任务 → 便签」子视图）**
  为什么：思考时最先产生的是「半句话」，不是一条结构化待办。
  没有低成本入口，人就会在脑子里记，然后忘掉。
  便签按 scope 单文件存储、原子写（tmp → fsync → rename），
  用完即弃、不进任务板，也不参与任何统计口径。

- **提示词库（`src/prompts.js` + 「记忆 → 提示词」子视图）**
  为什么：好用的提示词是在使用中长出来的，散在聊天记录里等于没有。
  入库后支持分类、`{{date}}`/`{{time}}` 模板变量与使用次数统计；
  注入轨按**回合数**控制（`every`：1=每回合、N=每 N 回合、0=只注入一次），
  因为「每隔多久提醒一次」是人的偏好，不该写死在代码里。

- **建议确认制（`src/suggest.js`）**
  为什么：让模型直接写长期记忆，等于把「什么该被永久记住」的裁决权交给模型——
  一次误判就会长期污染上下文，而且很难被发现。
  现在模型只能 `propose`（带 `reason` 入队），人在页面上看到红条、
  点「采纳」才真正落库。`apply` 失败时该条**保持 pending** 并记 `lastError`，
  绝不假装采纳；`apply` 返回 Promise 而未 await 会被显式拒绝（`SUGGEST_ASYNC_APPLY`），
  因为那正是「标记了已采纳、实际没写进去」的假采纳。

- **记忆自审（`src/reviewer.js` + 设置页开关）**
  为什么：「每 N 回合该自检一次」听起来简单，但纯内存计数在每次重启后归零，
  审查就**永远到不了期**，而且没有任何报错——属于最难查的一类失效。
  因此每个回合都追加一行 `reviewer.jsonl`，重启后从事件流重建计数；
  它只做被动记账，不自己起定时器（宿主生命周期不可控，定时器会泄漏）。

- **API 鉴权围栏（`src/fence.js`）**
  为什么：修复前 cs-bots 的 HTTP 面**完全没有鉴权**——
  `curl -X POST /cs-bots/api/tasks -d '{"subject":"x"}'` 直接 200，
  任何知道地址的人都能建任务、改记忆、写房间，甚至绕过「受保护区写闸门」
  往事件流里塞条目。现在判定顺序固定为：
  ① `Origin` 与 `Host` 不同源 → 403（防 CSRF）；
  ② 宿主 `connection` 服务可用 → 交它做真实会话校验（401/403）；
  ③ 宿主校验能力缺失 → **拒绝一切经代理请求**（fail-closed）。
  第③条不一律拒绝，是因为测试替身没有 socket，一律拒绝会逼人关掉围栏——
  那才是真隐患；区分「经代理」与「非经代理」才是准确边界。

- **`GET /status` 上报 12 个域服务**
  为什么：某个域装配失败时，如果状态页只说「正常」，用户会以为功能坏了是玄学。
  现在逐个上报 `roster / board / dispatcher / room / memory / library /
  discipline / todo / scratch / prompts / suggest / reviewer` 的
  `available`、`stats`、`stateDir`；缺哪个，页面就显示哪个降级，不假装正常。

- **技能导入与来源目录（`src/library.js`）**
  为什么：技能的生命周期不一样——系统自带（bundled）随版本走、
  用户级（user）跨项目复用、项目级（project）换项目就该消失、
  导入/粘贴的（custom）来源不明。混成一堆后，人不敢删也不敢改。
  现在来源分层显式可见；「扫描目录」只返回**可导入条目**，是否入库由人决定；
  批量导入时单条非法只进 `errors`，**绝不中断整批**
  （外部技能文件格式千奇百怪，一条坏文件不该让整次导入白做）。

- **Bot 档案增强（`src/botprofile.js` + `src/roster.js`）**
  为什么：Bot 不是「一个 prompt + 一个目录」。它需要人格（persona）、
  边界（boundaries）、技能、工作流、纪律引用（disciplineIds）与预制记忆。
  这些字段有长度与条数上限（人格/边界各 2000 字符，因为它们是**每次请求都注入**
  的常驻上下文，不限长会悄悄吃掉预算）。预制记忆在建 Bot / 改档案时
  同步进记忆服务（带 `botId`），否则会出现「AGENTS.md 里有、记忆库里没有」的不一致。

- **记忆按项目隔离（`src/memory.js`）**
  为什么：项目 A 的构建命令对项目 B 是**错误知识**，不是无用知识。
  因此 L3 项目 key / L4 任务笔记 / L5 日札带 `cwd` 归属，
  L0–L2 保持全局；`list / search / contextFor` 缺省不过滤（兼容既有调用方），
  `cwd:'*'` 表示显式跨项目视图。改造前写入的老条目没有 `cwd`，
  按具体项目过滤时**故意不出现**（宁可少显示，也不把 A 项目的经验喂给 B 项目）。

- **记忆彻底删除 `purge`（`POST /memory/purge`）**
  为什么：`remove` 是**软删除**（进归档区、可恢复），`purge` 是**真删**
  （从内存与快照移除、不可恢复）。两者必须都有：
  只给 `remove`，用户会遇到「删了还在归档区躺着」；
  只给 `purge`，一次误删就无从挽回。
  `purge` 在事件流里**只追加一条 `after:null` 墓碑**，而不是抹掉旧行——
  否则「谁在什么时候删了什么」会永久丢失，审计就断了。

### Changed

- **页面信息架构：11 个页签 → 7 个页签（含子视图）**
  为什么：v2 补能力时把「能力对等」误当成「页面也对等」——
  memory-evolve 有独立页面，这边就也各开一个，于是涨到 11 个。
  但页签只有两种：**协作对象**（任务 / Bot / 房间）与**配置资产**
  （技能库 / 工作流库 / 设置）。待办、便签、纪律、提示词两类都不属于，
  它们是既有对象的视图或属性。收敛后：
  任务（协作看板 / 我的待办 / 便签）、记忆（事实与偏好 / 纪律与要求 / 提示词）。
  判据写进 `docs/ARCHITECTURE.md` §4 与 ADR-001：新增能力没有独立生命周期、
  不需要多方引用、没有可点进去的详情，就不许新开页签。

- **页面破坏性操作改用站内 `ConfirmModal`，不再用 `window.confirm/prompt`**
  为什么：DSH 沙箱里原生 `confirm` 被静默屏蔽，点「删除」没反应、
  用户以为按钮坏了。改用站内模态后，`ci-zero-dep.sh` 机械禁止再出现
  `window.prompt/confirm/alert`，防止有人图省事退回去。

- **`package.json` 的 `files` 纳入 `docs/` 与 `CHANGELOG.md`**
  为什么：架构决策（ADR-001）、四层分层与「为什么不这样做」是最需要跟包走的资料；
  只放在仓库里，装了包的人看不到，就会重新提出已经被否掉的方案。

- **版本号对齐：`0.2.0` → `0.4.0`**
  为什么：远端 `v0.3.0` 已被占用（指向 `036748b`），按「tag 已存在必须递增」
  规则取 `0.4.0`。此前 `package.json` 停在 `0.2.0` 而 tag 已到 `v0.3.0`，
  版本与 tag 脱节，安装方无法从包内判断自己装的是哪一版。

- **README 安装通道：0.4.0 以 git 为主，npm 明确标注为旧版**
  为什么：npm registry 上的 `cs-bots` 仍是 `0.1.1`，本轮没有 npm 凭据
  （`npm whoami` → ENEEDAUTH）。若 README 继续把 `dsh plugin add cs-bots`
  写成推荐通道，主管按文档装到的会是**没有 v2 能力的旧版**，且现象是「文档说的功能都没有」。
  README 同时补了离线包通道（`dsh plugin add ./cs-bots-0.4.0.tgz`）。

### Removed

- **移除顶层「待办 / 便签 / 纪律 / 提示词」四个页签**
  为什么：见上「11 → 7」。能力没少，只是回到正确的层级：
  它们不是独立对象，不该占一个顶层导航位。

- **移除客户端对 `window.prompt/confirm/alert` 的全部依赖**
  为什么：沙箱里被静默屏蔽，失败方式无声无息；CI 检查 5 会拦住回退。

### Fixed

- **P0 · API 完全无鉴权（`src/fence.js`）**
  修复前任何公网请求都能改数据。现在无 cookie 的 `curl -X POST /fs/mkdir` → 401，
  目录未创建；带浏览器会话 → 200。

- **P0 · 受保护区可被写入（`src/dirbrowse.js`）**
  修复前写闸门只校验「家目录 ∪ cwd ∪ config.roots」，
  而 DSH 家目录 / `~/.agents` / cs-bots 状态目录只在另一个校验函数里生效——
  校验说「不行」、写入却说「可以」（实测可写入 `~/.dsh/cs-bots/PWN-PROOF`）。
  现在两处共用同一组受保护区，统一返回 `DIR_PROTECTED`。

- **P1 · `board.accept('pass')` 可绕过状态机**
  修复前任何状态的任务都能被直接置为 completed，绕过 `complete()` 的
  `blockedBy` / lease / artifacts 校验，依赖图收敛形同虚设。
  现在 `pass` 只接受已 `completed` 的任务，`reject` 才允许从 completed 打回 pending。

- **P1 · 记忆 `list/search` 不按 `botId` 过滤**
  修复前 Bot 私有记忆对任何 API 调用者可见，与「只在那个 Bot 的 contextFor 里出现」
  的注释自相矛盾。现在传 `botId` 只见该 Bot 私有，不传只见非私有。

- **P1 · `expireLeases` 无任何调用者**
  修复前 owner 崩溃/失联后任务永久停在 `in_progress`。
  现在通过 `POST /tasks/expire-leases` 暴露回收能力，并在装配时兜底调用。

- **P1 · 房间 `mode='everyone'` 时更新不校验成员**
  修复前任意人可改房间名/公告（实测 `byId:'attacker-not-a-member'` 改名成功）。
  现在与 `post()` 同口径：非 USER 调用者必须是成员。

- **P2 · 各域缺 `stats()` 导致页面概览恒显示 `—`**
  修复前 UI 读 `stats.total` 拿不到值，看起来像「没有数据」而不是「没实现」。
  现在 board / room / memory 等域统一提供 `stats()`，`/status` 直接透出。

- **P2 · 设置页「保存后立刻 GET 却看不到新值」**
  修复前 GET 只返回启动时的内存副本（磁盘其实已写对），造成假象。
  现在 `saved` 永远来自磁盘（真相源），`effective` 才是运行时值，UI 可如实标注。

---

## 历史版本

- `v0.3.0`（`036748b`）：页面全面重做（零 prompt/confirm、目录浏览器、
  技能库/工作流库、房间编辑、档案五分区）。**未维护 changelog**。
- `v0.2.0`（`ada4d88`）：Bot 档案（身份/经验/技能/预制记忆）+ UI 重做 + 设置页。
- `v0.1.2`（`29bd045`）：agent-team 覆盖拆为可选 + dsh 版本探测。
- `v0.1.1`（`a583dd7`）：版本对齐 npm。
- `v0.1.0`（`dfcd133`）：设置层（真正生效）+ 管理动作（指派/终止/穿透/成员/归档）+ API 测试 16 项。
