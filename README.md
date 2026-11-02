# cs-bots

**DSH 多智能体协作平台**——一个自足的插件：装上它，你就有了跨会话任务板、房间群聊、分层记忆、可独立工作目录的 Bot 注册表。

> **零第三方运行时依赖**：不依赖 `my-free-model` / `dsh-memory-evolve` / `cs-bot-bea` / `ds-bot` 等任何其他插件。
> 只依赖 DSH 本体自带的官方包（随 DSH 安装，不算第三方）。

---

## 安装

### 通道 1：npm（推荐，稳定）

```bash
dsh plugin --profile web add cs-bots
```

### 通道 2：git（github）

```bash
dsh plugin --profile web add github:7358716/cs-bots#v0.1.0
```

> ⚠️ **已知环境事实**：`github.com:443` 在某些网络下**间歇不可达**（DNS 正常、TCP 超时）。
> 若 git 通道失败：先重试一次，仍失败则改用 npm 通道。

### 一条命令装 + 自检（强烈建议）

```bash
bash install.sh --channel npm      # 或 --channel git
```

**自检为什么必要**：`link:` 断链或 bundle 未进 `dsh.profile.bundles` 时，DSH **只打一行
`skipping profile bundle` 就静默跳过**——页面照常 HTTP 200，功能全失效。
`install.sh` 用 `dsh --profile <p> --dump-config` 验证**装配树里真有本插件的行**，
并检查 `agent-team.maxMembers` 是否已解封、状态目录是否可写。

退出码：`0`=装好且自检通过；`1`=安装失败；**`2`=装了但自检不通过**（最危险，必须处理）。

---

## 装好后你得到什么

**17 个模型可见工具**（`bot_` 前缀，避免与其他插件撞名）：

### 任务板（跨会话）
| 工具 | 用途 |
|---|---|
| `bot_task_create` | 建任务（支持依赖 DAG、优先级、`sourceSeq` 幂等） |
| `bot_task_list` | 列任务 |
| `bot_task_ready` | **就绪任务**（依赖全完成的 pending），领活用 |
| `bot_task_update` | CAS 推进：`claim`/`heartbeat`/`release`/`complete`/`reopen`/`block`/`unblock`/`delete`/`set` |
| `bot_task_accept` | 验收（`pass`/`reject`）——官方**没有**这个动作 |

### 唤醒桥
| 工具 | 用途 |
|---|---|
| `bot_wake` | 定向唤醒会话（`dedupKey` 去重，防唤醒风暴） |

### Bot 注册表（**独立工作目录**）
| 工具 | 用途 |
|---|---|
| `bot_roster_create` | 建持久 Bot（`cwd` 独立，**cwd 同时是它的写入边界**） |
| `bot_roster_list` | 列出（可选含已退役） |
| `bot_roster_manage` | `rename`/`retire`/`setCwd`/`claim`/`release`/`heartbeat` |

### 房间群聊
| 工具 | 用途 |
|---|---|
| `bot_room_create` | 建房间 |
| `bot_room_post` | 发言（**确定性写入**：直接落盘，不经模型转手） |
| `bot_room_read` | 读消息（带 `seq` 游标，可断点续传） |
| `bot_room_body` | 取长正文全文（长消息自动落旁路文件） |

### 分层记忆
| 工具 | 用途 |
|---|---|
| `bot_memory_add` | 写入（L0–L5 六层；`explicit:true` 受保护） |
| `bot_memory_search` | 检索（FTS5 trigram，缺则退化字面匹配） |
| `bot_memory_context` | 取常驻注入文本（L0–L3） |

---

## 设计要点（为什么这样）

### 1. 为什么持久 Bot 不走官方 `spawn_teammate`

**实测硬事实**：官方 `SpawnTeammateRequest` 只有 6 个字段（`name`/`description`/`prompt`/`context`/`provider`/`signal`）——**没有 `cwd`**；
子会话由 `childSessionMeta()` 强制继承父会话 cwd；而 **cwd 同时就是 fs 写入边界**。
⇒ 一支官方 Team 的全体成员共享同一目录、会互相覆盖文件。

**本平台的解法**：持久 Bot 走 `ctx.agents.create({ meta: { cwd } })`（官方唯一能指定目录的路径），
拿独立写入边界；`spawnTeammate` 只用于同目录的轻量分工。

### 2. 为什么自建任务板

官方 Agent Teams 的任务板 **`TeamId = SessionId`**（每会话一块），且 roster 是 **flat immutable**
（无改名、无删除、名字永不复用）。⇒ 跨会话统一任务板与可维护的 Bot 注册表都必须自建。

### 3. 为什么禁 `ask_user_question`

在多智能体结构里，**同步等用户的提问工具会堵死整条投递链**
（依据：`ds-bot` 源码注释 —— *"every message from another Bot or a group round queues behind it"*）。
本平台对 Bot 会话双层移除：`tools.guard` 同步闸门 + `agent/created` 时 `restrict({deny})`。

---

## 开发

```bash
bash test/run-all.sh       # 单入口：零依赖 CI + 全部单测，任一失败退出码非 0
bash test/ci-zero-dep.sh   # 只跑零依赖 CI（4 项机械检查）
```

**零依赖 CI 四项检查**（防止依赖悄悄长回来）：
1. `src/` 下除 `kernel.js` 外，任何文件不得**真实 import** `@deepseek-ai/*`（注释里的字面量不算）
2. `package.json` 的 `dependencies` 必须不存在或为空
3. `cordis.patch.yml` 每个 `name` 只能是本包或官方包
4. 覆盖官方行时必须列全 `config` 字段（漏字段会让整个 profile 起不来）

---

## 状态目录

```
$DSH_HOME/cs-bots/
├── board.jsonl         任务板事件流（真相源）
├── board.snap.json     任务板快照
├── roster.jsonl        Bot 注册表事件流
├── roster.snap.json
├── wakes.jsonl         唤醒审计（终态记录）
├── rooms/<roomId>/log.jsonl     房间消息（不截断）
├── rooms/<roomId>/bodies/*.txt  长正文旁路
├── memory.jsonl        记忆事件流
├── memory.snap.json
└── memory-fts.db       FTS5 检索索引（派生缓存，可重建）
```

---

## 许可

MIT。设计上借鉴了 `ds-bot`（Apache-2.0）的 work 树/投递漏斗、`cs-bot-bea`（MIT）的惰性获取/
原子写/ErrorBoundary 等工程做法，均为**思路与模式借鉴**，未复制其运行时代码。
