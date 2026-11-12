---
name: rollback-and-diagnose
description: "重启失败或服务异常时的救火流程：回滚 last-working.yml、按启动日志定根因、区分「能救」与「救不了」、插件开关兜底。禁止连续硬试。"
---
# 回滚与故障定位

## 何时用

- `dsh-plugins result` 不是 PASS
- 重启后页面打不开 / 白屏 / 插件没加载
- 用户说「页面崩了」「插件不见了」

## 铁律：不连续硬试

**同一操作失败 2 次就停**（d-5）。第二次还是失败，说明不是偶发，继续重试只会延长故障窗口。

正确顺序：**先回滚到已知可用状态 → 再从日志定根因 → 再一次性修复**。

## 第 1 步：立即回滚（先让服务可用）

```bash
dsh-plugins rollback
```

它做两件事：把 `cordis.patch.yml` 恢复成 `last-working.yml`，然后**安全重启**（同样走预检+校验+失败回滚）。

> `last-working.yml` 是每次成功重启后自动存下的「已知可用配置」。回滚后服务应恢复到上一次正常状态。

### 回滚后仍起不来？

那就不是配置问题，看第 2 步。**回滚本身也会预检**，如果预检在 last-working 配置上失败，说明坏的是插件代码本身（不一定是配置）。

## 第 2 步：从启动日志定根因

```bash
dsh-plugins logs 100
```

### 特征 → 根因 → 处置

| 日志特征 | 根因 | 处置 |
|---|---|---|
| `did not activate` / `skipping profile bundle` | 插件没被激活 / bundle 层序问题 | 查 `dsh-plugins bundles list`，确认该包在挂载列表里 |
| `Failed to load plugins` / 整批回退单文件 | 某个 client bundle 解析失败 | 该插件 client.js 有语法错，交回原申请方修 |
| `loaded without registering` | client bundle 执行了但没注册 | 同上，代码问题 |
| `ValidationError: $.host missing` 之类 | `cordis.patch.yml` 覆盖 config 时**整体覆盖非合并**，丢了必填字段 | 补齐全字段（host/port/tls 都得写） |
| systemd 反复重启（PID 一直变） | 启动即崩 | 看 `systemctl status dsh-web -n 50` |
| 就绪超时但 active=active | 首次启动失败，`Restart=always` 5s 后重试 | **再等**，等满 180s 再判 |

### 关键认知

- **DSH 首次启动可能失败**（typert-loader 等），systemd `Restart=always` 会 5s 后重试。所以判死前要等满 180s。
- **启动日志要只看本次新增部分**。`restart-job.sh` 已经这么做了；你手动查时要小心，别把上次的告警当这次的（这条踩过坑）。
- **`cordis.patch.yml` 覆盖插件 config 是整体覆盖，不是合并**。只写 `compressionLevel` 会让 `host/port/tls` 丢失 → 服务起不来。这是最容易犯的配置错。

## 第 3 步：插件开关兜底（最坏情况）

如果确定是某个第三方插件把页面搞坏的，可以一键禁用后重启：

```bash
dsh-plugins off -r                  # 禁用全部受管第三方插件并重启（页面优先恢复）
dsh-plugins off cs-myfree -r        # 只禁某一个
dsh-plugins on  -r                  # 修好后全部恢复
```

受管插件：`cs-myfree` / `cs-guard` / `cs-bots` / `dsh-memory-evolve`
受管 preset：`preset-dev-steward` / `preset-work-steward` / `preset-pa-steward`

> **注意**：禁用 `cs-bots` 会让整个 Bot 平台不可用（任务板、记忆、纪律全没了）。非最后手段不要禁它。

## 第 4 步：交回与报告

### 如果能自己修（配置类）

改 `cordis.patch.yml` → `dsh-plugins precheck` → `dsh-plugins restart` → 报告。

### 如果是代码类

**交回原申请方**（开发执行岗 / 开发诊断岗）。我不改别人的代码。

报告格式：

```
【现状】已回滚到 last-working.yml，服务 <可用/仍不可用>
【根因】<日志原文摘录> → <判断>
【证据】dsh-plugins result 原文 + 日志关键行
【下一步】<谁做什么>（若需申请方修代码，明确说改哪个文件）
【风险】<还没排除的可能性>
```

## 检查清单

- [ ] 失败后**没有**连续重试
- [ ] 先回滚到 last-working.yml
- [ ] 从日志里摘了**原文**作为根因证据
- [ ] 区分了「配置问题」与「代码问题」
- [ ] 代码问题已交回原申请方，没有自己改
- [ ] 若用了 `off -r`，明确告知影响了什么
- [ ] 报告里没有「应该没问题」这类话

## 常见坑

- **失败后原地再 restart 一次**：违反 d-5，且故障窗口翻倍。
- **不看日志就下结论「插件坏了」**：可能是 config 覆盖丢字段。
- **第一次没起来就判死**：DSH 首次启动可能失败后自动重试，等满 180s。
- **手动 grep 整个 weblog**：会把历史告警当成本次故障。
- **禁了 cs-bots 却没说**：整个 Bot 平台会消失，用户会以为数据丢了。
- **自己动手改别人的代码**：越权，且改了之后没人知道。
