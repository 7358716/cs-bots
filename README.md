# cs-bots

**DSH 多智能体协作平台**——一个自足的插件：装上它，你就有了跨会话任务板、房间群聊、
分层记忆与纪律、可独立工作目录的 Bot 注册表，以及待办/便签/提示词/AI 自审一整套协作设施。

> 设计文档：**[架构总览](docs/ARCHITECTURE.md)** · [页签结构决策 ADR-001](docs/adr/ADR-001-页签结构回到七页.md)

> **零第三方运行时依赖**：不依赖 `my-free-model` / `dsh-memory-evolve` / `cs-bot-bea` / `ds-bot` 等任何其他插件。
> 只依赖 DSH 本体自带的官方包（随 DSH 安装，不算第三方）。

---

## 安装

### 通道 1：git（github，**0.4.0 的推荐通道**）

```bash
dsh plugin --profile web add github:7358716/cs-bots#v0.4.0
```

> ⚠️ **为什么这版不推荐 npm**：npm registry 上的 `cs-bots` 仍停在 **0.1.1**，
> 本轮**没有 npm 发布凭据**（`npm whoami` → ENEEDAUTH），npm 不是 0.4.0 的发布通道。
> 用 `dsh plugin --profile web add cs-bots` 会装到旧版。

### 通道 2：离线包（github 不可达时的兜底）

```bash
# 先拿到 cs-bots-0.4.0.tgz（发布产物 / 主管本机），再：
dsh plugin --profile web add ./cs-bots-0.4.0.tgz
```

> ⚠️ **已知环境事实**：`github.com:443` 在某些网络下**间歇不可达**（DNS 正常、TCP 超时）。
> 若 git 通道失败：先重试一次，仍失败则改用离线包通道。

### 一条命令装 + 自检（强烈建议）

```bash
bash install.sh --channel git --ref v0.4.0   # git 通道（install.sh 支持 npm|git）
```

**自检为什么必要**：`link:` 断链或 bundle 未进 `dsh.profile.bundles` 时，DSH **只打一行
`skipping profile bundle` 就静默跳过**——页面照常 HTTP 200，功能全失效。
`install.sh` 用 `dsh --profile <p> --dump-config` 验证**装配树里真有本插件的行**，
并检查 `agent-team.maxMembers` 是否已解封、状态目录是否可写。

退出码：`0`=装好且自检通过；`1`=安装失败；**`2`=装了但自检不通过**（最危险，必须处理）。

#### ⚠️ 一个必踩的坑：**bundle 层序**

`dsh plugin add` 只往 `dsh.profile.bundles` **末尾追加**。而 bundle patch 按 **bundles 顺序**依次应用，
之后才是 profile 自己的 patch。

⇒ **本插件必须排在 `@deepseek-ai/dsh-experimental-agent-team-profile` 之后**，
否则我们对 `agent-team.maxMembers` 的**覆盖会在目标行还不存在时执行 → 被静默跳过**（`entry not found`）。

**实测复现**（2026-11-02）：先装 `cs-bots`、后装 `agent-team-profile` → `maxMembers` 仍是 `8`。

`install.sh` 会**检测并自动重排**（备份为 `package.json.bak-cs-bots-order`），
然后以 **exit=2** 提示「需重启 DSH 后重跑自检」。

手动安装时请**先启用 agent-team，再装本插件**；或装完跑一次 `install.sh --check-only` 让它修正。

#### 另一个坑：**不要用 npm 装 agent-team-profile**

`dsh plugin add @deepseek-ai/dsh-experimental-agent-team-profile` 会从 registry 拉到**另一个版本**
（实测拉到 `0.1.5-alpha.2`，而 dsh 自带的是 `0.2.1-rc.2`）。
正确做法：**只在 `dsh.profile.bundles` 里按名引用**（不装包），它会从 dsh 安装目录解析，版本天然对齐。

---

## 装好后你得到什么

**27 个模型可见工具**（`bot_` 前缀，避免与其他插件撞名）：

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
| `bot_memory_context` | 取常驻注入文本（L0–L3，可按 `cwd` 取当前项目口径） |

### 待办 / 便签 / 提示词
| 工具 | 用途 |
|---|---|
| `bot_todo_add` / `bot_todo_list` / `bot_todo_update` | 四轨待办（生活/工作/项目/每日）+ 四象限 + 智能视图 |
| `bot_scratch_read` / `bot_scratch_write` | 便签（随手记，单文件原子写） |
| `bot_prompt_list` / `bot_prompt_get` | 提示词库（模板含 `{{date}}`/`{{time}}`） |

### 纪律 / 建议确认
| 工具 | 用途 |
|---|---|
| `bot_discipline_list` / `bot_discipline_resolve` | 分级纪律（全局/工作区/房间/Bot），`resolve` 取「我实际要遵守哪些」 |
| `bot_suggestion_propose` / `bot_suggestion_list` | **建议确认制**：模型只能提议，人点采纳才真正落库 |

---

## 页面结构（7 个页签，与原架构一致）

| 页签 | 子视图 | 管什么 |
|---|---|---|
| **任务** | 协作看板 / 我的待办 / 便签 | 要做的活（三者是一条漏斗：想到就记 → 决定要做 → 交给谁做） |
| **Bot** | — | 谁来做（档案：人格/边界/纪律/技能/预制记忆） |
| **房间** | — | 在哪商量（群聊、长消息全文、归档、角色） |
| **记忆** | 事实与偏好 / 纪律与要求 / 提示词 | AI 该知道什么 |
| **技能库** | — | 怎么做（自建/用户级/项目级/系统自带，可导入目录） |
| **工作流库** | — | 按什么步骤做 |
| **设置** | — | 平台怎么跑（记忆自审间隔、系统体检） |

> **为什么不多开页签**：新增能力若没有独立生命周期、不需要多方引用、没有可点进去的详情，
> 就只能做子视图。判据与背景见 [ADR-001](docs/adr/ADR-001-页签结构回到七页.md)。

---

## 安全

- **API 鉴权围栏**：公网路径必须带有效会话（无 cookie 的 `curl` 直接 401），
  另有同源校验防 CSRF；关掉宿主校验时对**经代理**请求 fail-closed。
- **受保护区**：状态目录、`~/.ssh`、`~/.dsh` 等不可被 `fs/mkdir|rename` 触碰。
- **建议确认制**：模型改不了长期记忆，只能提建议，人采纳才落库。

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
├── memory-fts.db       FTS5 检索索引（派生缓存，可重建）
├── discipline.jsonl    分级纪律事件流
├── todo.jsonl          待办事件流
├── prompts.jsonl       提示词库事件流
├── suggestions.jsonl   建议确认队列
├── reviewer.jsonl      自审调度
├── scratch/<scope>.md  便签
└── library-skill-dirs.json  登记的技能来源目录
```

---

## 许可

MIT。设计上借鉴了 `ds-bot`（Apache-2.0）的 work 树/投递漏斗、`cs-bot-bea`（MIT）的惰性获取/
原子写/ErrorBoundary 等工程做法，均为**思路与模式借鉴**，未复制其运行时代码。
