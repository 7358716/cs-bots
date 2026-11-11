# cs-bots

DSH 多智能体协作平台：跨会话任务板、房间群聊、分层记忆/纪律、Bot 注册表、待办/便签/提示词/AI 自审。

**零第三方依赖**：仅依赖 DSH 本体官方包。

---

## 安装

```bash
# 推荐：git 通道（npm 版本可能滞后）
dsh plugin --profile web add github:7358716/cs-bots#v0.8.0

# 或离线包
dsh plugin --profile web add ./cs-bots-0.8.0.tgz

# 自检（强烈建议）
bash install.sh --channel git --ref v0.8.0
```

> ⚠️ **bundle 层序**：本插件需排在 `@deepseek-ai/dsh-experimental-agent-team-profile` 之后，否则 `maxMembers` 覆盖失效。`install.sh` 会自动检测并重排。

---

## 核心能力

**28 个模型可见工具**（`bot_` 前缀）：

### 任务板（跨会话）
| 工具 | 用途 |
|---|---|
| `bot_task_create` | 建任务（依赖 DAG、优先级、`sourceSeq` 幂等） |
| `bot_task_list` | 列任务 |
| `bot_task_ready` | **就绪任务**（依赖全完成的 pending） |
| `bot_task_get` | 读任务详情 |
| `bot_task_update` | 改任务（CAS） |
| `bot_task_phase` | 边做边交阶段产物 |
| `bot_task_accept` | 验收（pass/reject） |
| `bot_task_subscribe` | 任务订阅房间消息 |

### 团队与房间
| 工具 | 用途 |
|---|---|
| `bot_teams_create` | 建团队（big/small） |
| `bot_teams_list` | 列团队 |
| `bot_teams_add` | 加成员 |
| `bot_room_create` | 建房间 |
| `bot_room_post` | 发言 |
| `bot_room_read` | 读消息 |

### Bot 注册表
| 工具 | 用途 |
|---|---|
| `bot_roster_create` | 注册 Bot（指定 cwd、preset） |
| `bot_roster_list` | 列 Bot |
| `bot_roster_manage` | claim/release/心跳/退役 |

### 记忆与纪律
| 工具 | 用途 |
|---|---|
| `bot_memory_add/context/search` | 分层记忆 |
| `bot_discipline_list/resolve` | 合并纪律 |
| `bot_suggestion_list/propose` | 建议确认队列 |

### 待办与 PDCA
| 工具 | 用途 |
|---|---|
| `bot_todo_add/list/update` | 四象限待办 |
| `bot_cycle_start/advance/check/review` | PDCA 复盘 |

### 度量
| 工具 | 用途 |
|---|---|
| `bot_metrics_record/aggregate` | 指标记录/聚合 |

---

## 文档

- [架构总览](docs/ARCHITECTURE.md)
- [页签结构 ADR-001](docs/adr/ADR-001-页签结构回到七页.md)
- [改造08-Boss 决策留痕](docs/改造08-Boss决策留痕与Mandate授权机制.md)
- [改造09-Boss 体验](docs/CONTRACT-改造09-Boss体验与任务管控.md)
- [交付说明](docs/交付说明.md)

---

## 测试

```bash
bash test/run-all.sh   # 1242 项（v0.8.0），exit 0 才通过
```
