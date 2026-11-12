---
name: restart-flow
description: "dsh-web 安全重启标准流程：受理申请 → 现状核对 → 预检 → 风险评估 → 执行 → 校验 → 报告。含 dsh-plugins 全部命令与结果判读。"
---
# dsh-web 安全重启标准流程

## 何时用

- 用户说「重启」
- 任何会话/Bot 提出重启申请（改了插件、配置需重载）
- 服务异常需要救回来（先看 rollback-and-diagnose 技能）

## 第 0 步：受理申请，问清四件事

必须拿到（缺一项就问，不要自己猜）：

1. **为什么重启**（改了哪个插件/配置？是否必须重启才能生效？）
2. **改了哪些文件**（diff 范围，确认只影响申请方）
3. **影响面**（谁会受影响）
4. **替代方案是否试过**（有些改动只需热加载 config，不用重启）

> 改 `cordis.patch.yml` 的 **config** 可热加载，不必重启；改 `src/*.js` / `core/*.js` 才必须完全重启（ESM 模块缓存不热更）。

## 第 1 步：看现状

```bash
dsh-plugins status      # 配置里的开关 + 运行中实例实际加载了哪些
dsh-plugins result      # 上一次 restart 的结果
dsh-plugins logs 60     # 最近日志
```

**判读 `status`**：确认「配置中启用」与「运行中实际加载」是否一致。不一致往往就是需要重启的原因。

## 第 2 步：预检（不可跳过）

```bash
dsh-plugins precheck
```

**这一步只检查「client bundle 能否执行并注册」，不重启、不影响页面。**

### 预检失败怎么办

**绝不重启。** 直接告诉申请方：

> 预检失败：有插件 client bundle 无法执行/注册，现在重启会导致全站白屏。
> 需要先修复 `<插件>客户端 bundle`。我可以继续做只读诊断，但不会重启。

### 为什么这条是硬红线

2026-11-05 的真实事故：重启撞上半成品 `client.js`，坏 bundle 被读进启动快照，之后**每次开页面都整批解析失败 → 全站白屏**，回退单文件也一样坏。

## 第 3 步：风险评估（先说，再动）

给申请方/Boss 一句话：

> 会影响：<谁>。预计中断 <时长>。**3 分钟起不来怎么救**：`dsh-plugins rollback` 回滚到 last-working.yml。

**没有回滚路径就不动手。**

## 第 4 步：执行

### 标准

```bash
dsh-plugins restart
```

### 申请方还在回复中（推荐）

```bash
dsh-plugins restart --in=60      # 60 秒后再执行，给它收尾时间
```

> 重启会掐断正在跑的会话。快照+唤醒机制能续上，但**发起方当前那条回复会丢**，所以对方还在说话时用 `--in=SEC`。

### 只校验不重启（自测用）

```bash
dsh-plugins restart --dry-run
```

## 第 5 步：校验（restart 内部已自动做完，你要会读结果）

`restart` 内部 8 步，你不用手动跑：

1. 预检 client bundle 注册 → 失败则 `PRECHECK_FAIL` 并回滚，不重启
2. 快照运行中会话（重启后自动唤醒）
3. `systemctl restart` → 等就绪：active + PID 变化 + http=200，**最多 180s**
4. 稳定检查：连续 3 次 http=200
5. 启动日志告警：只查**本次新增**日志，抓 `did not activate` / `skipping profile bundle`
6. 端到端校验 `verify-boot.mjs`：boot 清单 + 每个 bundle 是否注册
7. 失败 → 回滚 `last-working.yml`
8. 唤醒重启前会话（`session-resume.mjs resume`）

### 结果判读

```bash
dsh-plugins result
```

| 输出 | 含义 | 下一步 |
|---|---|---|
| `PASS <时间>` | 重启成功且校验通过 | 报告成功 + 被唤醒会话清单 |
| `PRECHECK_FAIL <时间>` | 预检不过，**没重启**，配置已回滚 | 报失败，说明坏在哪，交回申请方修 |
| FAIL / 无结果 | 重启后校验失败或超时 | 转 rollback-and-diagnose 技能 |

再看日志确认：

```bash
dsh-plugins logs 100
```

**必须核对的两行**：
- `✅ 本次启动日志无 did not activate / skipping`
- `✅ 校验通过：插件状态与磁盘配置一致`

## 第 6 步：报告（三段式）

```
【结果】PASS / FAIL（贴 dsh-plugins result 原文）
【证据】就绪耗时 Ns · MainPID old→new · 启动日志无告警 · boot 校验通过
【影响】唤醒会话 M 个：<清单>；未恢复 N 个：<清单及原因>
```

**只贴证据，不写「应该好了」。**

## 检查清单

- [ ] 四件事（为什么/改了什么/影响面/替代方案）都问清了
- [ ] 跑了 `dsh-plugins status`，知道现状
- [ ] **跑了 `dsh-plugins precheck`，且通过**
- [ ] 把「3 分钟起不来怎么救」说明白了
- [ ] 申请方在回复中时用了 `--in=SEC`
- [ ] 看了 `dsh-plugins result` 的实际内容
- [ ] 看了启动日志有无 `did not activate` / `skipping profile bundle`
- [ ] 报告了被唤醒的会话清单

## 常见坑

- **跳过预检直接 restart**：这是唯一能造成全站白屏的操作。绝不。
- **预检失败还硬重启「试试看」**：违反 d-5，且会把全站搞挂。
- **申请方正在回复时立刻重启**：会掐断它，且它可能正在写关键内容。用 `--in=60`。
- **只看 result 不看日志**：result=PASS 但启动日志有 `did not activate` 时，restart-job.sh 已经把 VERIFY_RC 置 1，仍要看日志确认。
- **把历史告警当本次故障**：所以只查本次新增日志，不要 `tail -n 1000` 全量 grep。
- **改 config 也要求重启**：先确认是不是只需热加载。
