# cs-bots 设计架构（v0.2.0）

> 本文是**唯一架构真相源**。所有改动先对齐本文；与本文冲突的实现视为缺陷。
> 数字均为实测（`bash test/run-all.sh` + 代码扫描），不是估计值。

---

## 0. 一句话定位

**cs-bots = 装在 DSH 里的自足多智能体协作平台。** 装上它，你就有了：
跨会话任务板、可维护的 Bot 注册表（每个 Bot 独立工作目录）、房间群聊、
分层记忆与纪律、以及一套「AI 该怎么做事」的资产库。

**它不是**记忆进化的插件替代品，也不依赖任何其他插件。

---

## 1. 四层结构（严格分层，禁止跨层调用）

```
┌─ L4 模型面   src/tools.js        27 个 bot_* 工具（模型能调什么）
├─ L3 页面面   src/client.js       Web UI（7 页签 / 人话文案）
│              src/api.js          93 个 HTTP 端点（页面数据面）
├─ L2 领域面   board/roster/room/memory/discipline/todo/scratch/
│              prompts/suggest/reviewer/library/dispatcher（12 个服务）
└─ L1 内核面   kernel.js（宿主适配唯一出口） store.js（原子写/JSONL 回放）
               registry.js  settings.js  fence.js  compat.js
```

**分层铁律**
1. **L1 是唯一宿主耦合点**。`kernel.js` 是 `src/` 里唯一允许真实 import
   `@deepseek-ai/*` 的文件（CI 检查 1 机械强制）。
2. **L2 不知道 L3/L4 存在**。域服务是纯对象，不 import api/client/tools。
3. **L3 的 api 与 client 互不 import**。api 只产出 JSON；client 只消费 JSON。
4. **L4 不写业务逻辑**。工具层是薄适配：取服务 → 调方法 → 统一包装成
   `{ok:true,...}` / `{ok:false, reason, ...}`。

---

## 2. 三条不可协商的设计原则

### 原则 1 · 零第三方运行时依赖
- `package.json` 的 `dependencies` **必须不存在或为空**；
- 只允许 `node:*` 内置 + DSH 自带官方包（随 DSH 安装，不算第三方）；
- 生态里的任何插件（含 `dsh-memory-evolve`）**一律不许 import**；
- 由 `test/ci-zero-dep.sh` 5 项检查机械强制（禁依赖、禁插件 id、覆盖行必须列全 config、
  禁 `window.prompt/confirm`）。

**为什么**：新机器只装本插件就能跑。一旦 import 别的插件，安装顺序、版本、
对方重构都会变成你的故障源。

### 原则 2 · 绝不静默失败
- 写失败**必须抛错**并从内存回滚（不允许「只改内存不落盘」）；
- 快照写失败降级为 `warn` + 计数器，但**事件流必须已落盘**；
- 回放跳过坏行**必须计数并 warn**，不静默丢数据；
- 缺服务的工具返回**可读失败**（`memory-unavailable`），不抛崩、不假装成功。

**依据（真实事故）**：`my-free-model` 曾因 `costOfCall` 里 `catch { return 0 }`
把 ReferenceError 吞成 0 元，导致全站费用恒为 0 潜伏 4 天。

### 原则 3 · 事件流是真相源
```
写入：append(jsonl) → 更新内存 → 写快照（失败只 warn）
启动：读 jsonl 回放 → jsonl 为空才回落 snapshot → 都空 = 空态
```
- 快照是**派生缓存**，不是真相源；
- 回放只接受 `rev` 递增事件（同 rev 重放幂等，容忍重复投递）；
- **只追加，绝不改写历史**。彻底删除（`memory.purge`）也只在流里追加一条
  `after:null` 墓碑，而不是抹掉旧行 —— 否则「谁在什么时候删了什么」永久丢失。

---

## 3. 领域服务清单（12 个）

| # | 服务 | 文件 | 一句话 | 持久化 |
|---|---|---|---|---|
| 1 | `board` 任务板 | `board.js` | 跨会话任务：依赖 DAG、CAS 状态机、验收 | `board.jsonl` + `.snap.json` |
| 2 | `roster` Bot 注册表 | `roster.js` | 持久 Bot，**独立 cwd = 写入边界**；档案/技能/记忆 | `roster.jsonl` + 档案文件 |
| 3 | `room` 房间 | `room.js` | 群聊消息流 + `seq` 游标 + 长正文旁路 + 角色/归档 | `rooms/<id>/log.jsonl` |
| 4 | `memory` 分层记忆 | `memory.js` | L0–L5、注入、FTS5 检索、按项目隔离、彻底删除 | `memory.jsonl` + FTS5 |
| 5 | `dispatcher` 唤醒桥 | `dispatcher.js` | 定向唤醒 + `dedupKey` 去重 + 节流 | `wakes.jsonl` |
| 6 | `library` 资产库 | `library.js` | 技能/工作流；来源分层、启停、导入导出、目录扫描 | `library.jsonl` |
| 7 | `discipline` 分级纪律 | `discipline.js` | 全局/工作区/房间/Bot 四级，合并去重 + 预算裁剪 | `discipline.jsonl` |
| 8 | `todo` 四轨待办 | `todo.js` | 生活/工作/项目/每日 + 四象限 + 智能视图 | `todo.jsonl` |
| 9 | `scratch` 便签 | `scratch.js` | 单文件随手记，原子写 | `scratch/<scope>.md` |
| 10 | `prompts` 提示词库 | `prompts.js` | 模板 CRUD + 注入轨（每 N 回合/次数/立即） | `prompts.jsonl` |
| 11 | `suggest` 建议确认队列 | `suggest.js` | 模型只能提议，人点采纳才落库 | `suggestions.jsonl` |
| 12 | `reviewer` 自审调度 | `reviewer.js` | 每 N 回合提醒模型做记忆自检（纯计数，不越权写库） | `reviewer.jsonl` |

### 「建议确认制」是记忆安全的核心机制
```
模型想记住 X  →  suggest.propose(kind, layer, payload, reason)   [只入队]
                        ↓
              人 在「记忆 → 事实与偏好」看到红条，点「采纳」
                        ↓
              api.applySuggestion()（同步）真正写入 memory/library/discipline
```
- `accept` 的 `apply` 回调**必须是同步的**：返回 Promise 会在真正落库前就标记
  accepted（假采纳），因此 `suggest.js` 显式拒绝异步 apply（`SUGGEST_ASYNC_APPLY`）。
- apply 抛错 → 该条**保持 pending** + 记 `lastError` 落盘 + 抛给调用方，可修复后重试。
- 这是模型修改长期记忆的**唯一合法途径**。

---

## 4. 页面层信息架构（7 页签，与原架构一致）

**判据（新增功能先过这一关）**
> 新能力若没有独立生命周期、不需要多人/多 Bot 共同引用、不产生可点进去的详情，
> **不许新开页签**，只能作为既有页签内的子视图。

| 主页签 | 子视图 | 一句人话 | 对应服务 |
|---|---|---|---|
| **任务** | 协作看板 / 我的待办 / 便签 | 要做的活 | board + todo + scratch |
| **Bot** | — | 谁来做 | roster |
| **房间** | — | 在哪商量 | room |
| **记忆** | 事实与偏好 / 纪律与要求 / 提示词 | AI 该知道什么 | memory + discipline + prompts |
| **技能库** | — | 怎么做 | library(skills) |
| **工作流库** | — | 按什么步骤做 | library(workflows) |
| **设置** | — | 平台怎么跑 | settings + reviewer + 诊断 |

**为什么这样分**（详见 `docs/adr/ADR-001`）：
- 页签只有两种：**协作对象**（多个、有生命周期、要点进去）与**配置资产**（配一次、多处引用）；
- 待办/便签/纪律/提示词都不是对象，是既有对象的**视图或属性** ⇒ 只能做子视图；
- 记忆是高频浏览的**对象**（要增删改查），所以放顶层而不是塞进设置。

**三种粒度是一条漏斗**：便签（想到就记）→ 待办（决定要做）→ 任务（决定交给谁做）。
待办条目上的「派下去」就是这个漏斗的收口（`POST /todos/promote`，幂等）。

### UI 文案纪律（人类视角，不是程序员视角）
| 禁止出现 | 改为 |
|---|---|
| `L0/L3`、`rev`、`cwd`、`CAS`、`jsonl` | 人格/项目记忆、第 N 版、工作目录、版本冲突、事件流 |
| 裸错误码 | 一句人话 + 怎么修 |
| 无引导的空列表 | 空态说明「这里是什么、下一步点什么」 |
| `window.confirm` | 站内 `ConfirmModal`（沙箱里 confirm 被静默屏蔽） |
| 破坏性操作无后果说明 | 明确写「会怎样、能不能恢复」 |

---

## 5. 权限与安全

### API 认证围栏（`fence.js`）
公网暴露的 API 必须有门。判定顺序：
1. `Origin` 与 `Host` 不同源 → **403**（防 CSRF）；
2. 宿主 `connection` 服务可用 → 交它做**真实会话校验**（401/403）；
3. 宿主校验缺失 → **拒绝一切经代理请求**（fail-closed），非代理直连/测试替身放行。

**为什么第 3 条不是一律拒绝**：测试用假 req/res 直接调 handler，没有 socket；
一律拒绝会逼人关掉围栏 —— 那才是真隐患。区分「经代理」与「非经代理」是准确边界。

实测：`curl -X POST /cs-bots/api/fs/mkdir`（无 cookie）→ **401**，目录未创建；
带浏览器同款会话 cookie → **200**。

### 超级管理员
`OWNER='user'` 在 api 层代表「人」。房间归档/删除/角色/踢人、Bot 档案写入、
记忆 L0 修改等，Bot 侧的 `byId` 永远不等于 `user`，因此天然无法自我提权。

### 受保护区
`dirbrowse.js` 有 `DIR_PROTECTED` 白名单：状态目录、`~/.ssh`、`~/.dsh` 等不可被
`fs/mkdir|rename` 触碰（实测 P0 曾可写入 `~/.dsh/cs-bots/PWN-PROOF`，已修）。

---

## 6. 关键实现模式（照抄即可，勿另起炉灶）

### 6.1 事件流 + 快照
```js
commit(id, action, by, at, before, after) {
  appendJsonl(file, event)        // 1. 真相源，失败即抛（不允许只改内存）
  entries.set(id, clone(after))   // 2. 内存
  events.push(event)              // 3. 审计
  indexUpsert(after)              // 4. 派生索引
  writeJsonAtomic(snap, snapshot()) // 5. 快照，失败只 warn + 计数
}
```
原子写：`tmp-<pid>-<rand>` → `fsync` → `rename` → `fsync(dir)`。

### 6.2 CAS 并发
所有可变对象带 `rev`；更新必须带 `expectedRev`，不匹配抛 `*_REV_CONFLICT`。
**绝不静默覆盖**。缺 `expectedRev` 时按模块契约：必填的抛 `MISSING_EXPECTED_REV`。

### 6.3 错误码
`<DOMAIN>_<KIND>`：`MEMORY_CAS_CONFLICT` / `TODO_CWD_REQUIRED` / `ROOM_NOT_EMPTY` /
`LIB_BAD_DIR` / `SUGGEST_ASYNC_APPLY` / `REVIEW_BAD_INTERVAL` …
错误对象同时带 `code`（机器读）与中文 `reason`（人读）。API 层把 `code` 一并返回。

### 6.4 降级
`apply()` 绝不抛：任一服务装配失败只 `warn` 并把 `services[key] = undefined`；
`GET /status` 如实上报 12 个服务的 `available`，缺哪个页面就显示降级，不假装正常。

---

## 7. 目录与数据布局

```
~/.dsh/cs-bots/
├── board.jsonl / board.snap.json
├── roster.jsonl / roster.snap.json
├── memory.jsonl / memory.snap.json / memory-fts.db
├── discipline.jsonl / discipline.snap.json
├── todo.jsonl / todo.snap.json
├── prompts.jsonl / prompts.snap.json
├── suggestions.jsonl / suggestions.snap.json
├── reviewer.jsonl
├── library.jsonl / library-skill-dirs.json
├── wakes.jsonl
├── scratch/<scope>.md
└── rooms/<roomId>/{log.jsonl,bodies/*.txt}
```

每条 Bot 的档案落在**它自己的 cwd**（写作边界）：
`<cwd>/AGENTS.md`（受管区块）+ `<cwd>/.agents/skills/*/SKILL.md`。

---

## 8. 接口规模（实测）

| 层 | 数量 | 说明 |
|---|---|---|
| HTTP 端点 | **93** | `src/api.js`，全部经围栏 |
| 模型工具 | **27** | 前缀 `bot_`，避免与其他插件撞名 |
| 域服务 | **12** | 见 §3 |
| 源文件 | **24** | `src/*.js`，合计 **24,736** 行 |
| 测试文件 | **30** | **656 用例全绿**，`ci-zero-dep.sh` CI PASS |

---

## 9. 开发与验收

```bash
bash test/run-all.sh      # 单入口：零依赖 CI + 全部单测；任一失败退出码非 0
bash test/ci-zero-dep.sh  # 只跑零依赖 CI（5 项）
bash install.sh --channel npm   # 装 + 自检（exit=2 表示装了但自检不过）
```

**交付验收口径**：只认证据 —— 文件存在、退出码、真实输出。不接受「我完成了」。

**已知环境坑**
1. `~/.dsh/profiles/web/node_modules/cs-bots` 是**真实拷贝**（不是 symlink）⇒
   改源码后必须 `rsync` + `sudo systemctl restart dsh-web.service` 才生效；
   而 `cs-guard`/`cs-myfree` 是 symlink，改完即生效。
2. 重启会杀掉当前会话的 cgroup ⇒ 重启+验证脚本必须用
   `sudo systemd-run --unit=... --collect` 独立单元运行，日志写独立文件。
3. bundle 层序：本插件必须排在 `agent-team-profile` **之后**，否则
   `maxMembers` 覆盖会在目标行不存在时被静默跳过（`install.sh` 会检测并重排）。
