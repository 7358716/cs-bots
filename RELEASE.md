# cs-bots 发布手册（Release Runbook）

> **结论先行**：本手册是发版操作的**唯一依据**。凡手册与口头说法冲突，以手册为准；
> 凡手册与真实命令输出冲突，以**真实输出**为准，并立刻修手册。
>
> 当前版本线：**0.4.0** ｜ 发布通道：**git tag + 离线 tarball** ｜
> **npm 不是本轮通道**（本机 `npm whoami` → `ENEEDAUTH`，且 registry 仍停在 0.1.1）。

---

## 1. 版本位点规则

### 1.1 唯一真相源

- 版本号的唯一来源是 `package.json` 的 `version` 字段；
- 发布 tag 必须严格等于 `v` + `version`（例：`0.4.0` → `v0.4.0`）；
- **tag 与 `package.json` 必须指向同一个 commit**。只改其中一个 = 版本位点错乱。

### 1.2 tag 已占用 ⇒ 递增，绝不复用

发版第一步永远先查远端：

```bash
git ls-remote --tags origin | grep -E 'refs/tags/v0\.4\.0$'
```

- **有输出**（tag 已存在）⇒ 本次版本号作废，必须递增；
- **无输出** ⇒ 才能往下走。

**为什么不能复用/移动 tag**：tag 是「这个版本曾经发布过什么」的不可变证据。
已经有人装过 `v0.3.0`，再把 `v0.3.0` 指到新代码，等于让两台机器上的同名版本
内容不同——出了问题无法复现，也无法判断该回滚到哪。

### 1.3 递增口径（0.x 阶段）

| 变更性质 | 递增位 | 例 |
|---|---|---|
| 一轮能力交付（新模块 / 新页面结构 / 新通道） | **minor** | 0.3.0 → 0.4.0 |
| 同能力内的缺陷修复 / 文案 / 打包修正 | **patch** | 0.4.0 → 0.4.1 |

本版事实：远端 `v0.3.0` 已指向 `036748b`（已被占用）⇒ 本次取 **0.4.0**。

### 1.4 反面教材（本仓真实发生过）

本轮之前 `package.json` 停在 `0.2.0`，而远端 tag 已到 `v0.3.0`。
后果：装了包的人无法从包内判断自己装的是哪一版；发布报告里的版本号与 tag 对不上。
**从 0.4.0 起，version / tag / CHANGELOG 三者必须同时对齐，缺一不发。**

---

## 2. 发布门禁清单

**规则：任一条失败 ⇒ 否决发布（STOP）。**

失败时把**命令原文与错误输出**写进发布报告，然后停。
**不许为了过门禁去改 `src/`**——发版管理员的职责是判定，不是修改被测代码。
代码要改，退回开发修，修完重新冻结、重新过门禁、版本号重新判定。

| # | 门禁 | 命令 | 通过判据 |
|---|---|---|---|
| G1 | 全量回归 | `bash test/run-all.sh` | `# tests 656` / `# pass 656` / `# fail 0`，退出码 `0` |
| G2 | 零依赖 CI | `bash test/ci-zero-dep.sh` | 5 项检查全 OK，末行 `CI PASS`，退出码 `0` |
| G3 | 语法检查 | `node -c src/client.js && node -c src/api.js` | 两条均无输出、退出码 `0` |
| G4 | 打包清单 | `npm pack --dry-run` | 含 `src/` **全量**、`docs/`、`CHANGELOG.md`、`cordis.patch.yml`、`cordis.patch.agent-team.yml`、`install.sh`、`README.md`、`LICENSE` |
| G5 | 工作区干净 | `git status --short` | **提交与推送完成后必须为空** |
| G6 | 未动源码 | `git diff --stat HEAD -- src/` | 发布提交里 `src/` 的 diff 只能来自**已冻结的 v2 工作**，不能有发版当场的改动 |
| G7 | 无 npm 动作 | —— | **不执行 `npm publish`**（无凭据，且它不是本轮通道） |

**每条门禁为什么存在**

- **G1**：单入口一个退出码，避免「跑了一半就说通过」。656 是冻结时的实测基线，
  数字变了就说明冻结被破坏，必须解释清楚才能发。
- **G2**：防依赖悄悄长回来。零第三方依赖是本插件「新机器只装它就能跑」的前提；
  CI 的 5 项是机械检查（禁真实 `@deepseek-ai/` 引用、`dependencies` 必须为空、
  patch 的 name 白名单、覆盖官方行必须列全 config、客户端禁 `prompt/confirm`）。
- **G3**：`node -c` 只做语法解析，能抓住「本地能跑、打包后炸」的低级错误；
  两个文件是页面与 API 的总入口，最值得单独把一道关。
- **G4**：`files` 白名单一旦漏项，装出来的包就是残的，而且**安装时不会报错**。
  架构资料（`docs/`）与变更日志必须跟包走：只留在仓库里，装包的人看不到。
- **G5**：`git status --short` 为空 = 打包内容与 tag 内容一致，没有「发完才想起忘了提交」。
- **G6**：发版管理员不改代码。`src/` 若有发版当场的改动，说明冻结已失效，
  本次发布失去意义（测的不是要发的那个东西）。
- **G7**：无凭据时的 `npm publish` 只会失败或（更糟）让人误以为发了。
  npm 通道留给有凭据的发布轮次。

### 2.1 门禁执行记录（每次发版填）

| 门禁 | 本版结果 | 证据位置 |
|---|---|---|
| G1 | PASS 656/656 | `RELEASE-REPORT-v0.4.0.md` §2 |
| G2 | PASS 5/5，CI PASS | 同上 |
| G3 | PASS（两文件退出码 0） | 同上 |
| G4 | PASS（32 文件，含 docs/CHANGELOG） | 同上 |
| G5 | PASS（空） | 同上 |
| G6 | PASS（`src/` 仅冻结工作，无发版改动） | 同上 |

---

## 3. git 通道（主通道）

### 3.1 前置

```bash
cd <repo>
git ls-remote --tags origin | grep -E 'refs/tags/v0\.4\.0$'   # 必须无输出
bash test/run-all.sh                                          # 必须 656/656
```

远端 `git@github.com:7358716/cs-bots.git` 为公开仓库，SSH over 443 已配置。
推之前先确认当前分支与领先关系：

```bash
git status --short
git log --oneline origin/main..HEAD
```

### 3.2 提交 + 打 tag + 推送

```bash
git add -A
git commit -F - <<'MSG'
release: v0.4.0 —— v2 能力交付 + 页签收敛回 7

为什么发这一版：
- v2 的待办/便签/纪律/提示词/建议确认/记忆自审已冻结并通过 656 项回归；
- 页签从 11 收敛回 7（新增能力只做子视图），修复了「能力对等=页面对等」的越界；
- API 鉴权围栏与受保护区写闸门修复了两个 P0，必须尽快让安装方拿到；
- 远端 v0.3.0 已被占用，按版本位点规则递增为 0.4.0。

本版同时把 docs/ 与 CHANGELOG.md 纳入发布物，保证装包的人能看到架构决策。
MSG

git tag v0.4.0
git push origin main
git push origin v0.4.0
```

> 提交信息必须写「为什么发这一版」，不是「改了哪些文件」——文件列表 `git show` 就有。

### 3.3 失败处置

- SSH/网络失败：**最多重试 1 次**（同一条命令原样重跑）；
- 仍失败：**停**。把错误原文贴进报告，明确写「未推送成功」，
  **不许伪造成功、不许改用 force push 硬推**；
- `main` 推成功但 tag 推失败：单独重试 `git push origin v0.4.0` 一次；
  仍失败则报告「commit 已推、tag 未推」，由主管决定是否次日补推。

### 3.4 推送后验证

```bash
git ls-remote --tags origin | grep 'refs/tags/v0.4.0$'
git ls-remote origin refs/heads/main
git status --short          # 必须为空
```

`ls-remote` 的输出必须同时包含 **tag 的 40 位 SHA**；该 SHA 必须等于本地 `git rev-parse v0.4.0`。
只看到「命令没报错」不算验证。

---

## 4. 离线包通道（github 不可达时的兜底）

### 4.1 为什么需要

实测 `github.com:443` 在某些网络下**间歇不可达**（DNS 正常、TCP 超时）。
主管在 Windows 上验证时，git 通道失败不能变成「这版没法验」。

### 4.2 生成与登记

```bash
npm pack                                  # → cs-bots-0.4.0.tgz
sha256sum cs-bots-0.4.0.tgz               # 登记哈希
stat -c '%s bytes' cs-bots-0.4.0.tgz      # 登记字节数
tar -tzf cs-bots-0.4.0.tgz | grep -E '^package/(src/|docs/|CHANGELOG.md|cordis\.patch|install\.sh|README\.md|LICENSE)' | head
```

**为什么必须登记 sha256 + 字节数**：tgz 通过聊天/网盘/邮件传递时可能被截断或替换。
主管拿到后先核对哈希，不一致就**不要装**——装一个损坏的包，故障现象会像代码 bug，
排查成本远高于重传一次。

`*.tgz` 在 `.gitignore` 里（**故意不提交**）：它是发布产物，不进源码历史。
传输靠文件本身，不靠仓库。

### 4.3 安装（Windows DSH）

在 tgz 所在目录打开 PowerShell：

```powershell
dsh plugin --profile web add "C:\path\to\cs-bots-0.4.0.tgz"
```

说明：
- 路径用**绝对路径**，避免相对路径在 profile 目录下解析成别处；
- 本地路径安装等价于「把包内容放进 profile 的 node_modules 并登记 bundle」，
  不经过 registry，也不经过 github；
- 装完**必须重启 DSH**，再做 §6 的验证。

### 4.4 与 `install.sh` 的关系（重要事实）

`install.sh` 只支持 `npm | git` 两个通道（`--channel`），**没有** tarball 分支。
离线包通道请直接用 `dsh plugin add <tgz>`，不要给 `install.sh` 传不存在的参数。
装完后可以单独跑自检：

```bash
bash install.sh --check-only --profile web
```

---

## 5. 回滚办法

### 5.1 代码回滚（首选：正向提交）

```bash
git revert --no-edit <release-commit>
git push origin main
```

- **不删 tag、不移动 tag**。已发布的 `v0.4.0` 永远指向它当时发布的内容；
- 需要「回到旧行为」时，发布一个**新的 patch 版本**（如 `0.4.1`），
  让它包含 revert 提交，然后按 §3 重新发；
- 为什么：回滚本身也是一次发布，也必须可追溯。删 tag / 改历史会让已经安装的人
  无法判断自己那台机器上的 `v0.4.0` 到底是不是官方那份。

### 5.2 禁忌清单（任一都不许做）

| 禁忌 | 后果 |
|---|---|
| `git push --force` / `--force-with-lease` 到 `main` | 覆盖他人提交，历史不可恢复 |
| `git tag -f v0.4.0`（重打已推的 tag） | 同名版本内容不一致，装过的人无法复现问题 |
| `git push origin :v0.4.0`（删远端 tag） | 审计断链；已安装方无法核对来源 |
| `git rebase` / `commit --amend` 已推历史 | 同上，且会制造分叉 |
| 直接改远端文件 / 网页端强推 | 同上 |

> 唯一例外：tag **只打在本地、尚未推送**时打错了，可以 `git tag -d v0.4.0` 后重打。
> 一旦 `git push origin v0.4.0` 成功，上述禁忌即生效。

### 5.3 数据层面

- 状态目录（`$DSH_HOME/cs-bots/`）与代码是两套东西：**回滚代码不回滚数据**；
- 事件流只追加、不改写历史；`memory.purge` 是**不可逆**的彻底删除
  （与可恢复的 `remove` 不同）——所以**升级前先备份状态目录**；
- 回滚安装：`dsh plugin --profile web add github:7358716/cs-bots#v0.3.0`
  或装回旧的 tarball，然后重启 DSH。装回旧版不会自动降级状态目录里的数据，
  若新版本写入了旧版不认识的事件，需从备份恢复。

---

## 6. 发布后验证清单（只认输出）

### 6.1 发布侧（Linux，发版人执行）

| # | 检查 | 命令 | 通过判据 |
|---|---|---|---|
| V1 | 远端 tag 存在 | `git ls-remote --tags origin \| grep 'refs/tags/v0.4.0$'` | 有输出，SHA = 本地 `git rev-parse v0.4.0` |
| V2 | 远端 main 指向发布提交 | `git ls-remote origin refs/heads/main` | SHA = 发布 commit |
| V3 | 工作区干净 | `git status --short` | 空 |
| V4 | 包哈希 | `sha256sum cs-bots-0.4.0.tgz` | 与报告一致 |
| V5 | 包内容 | `tar -tzf cs-bots-0.4.0.tgz \| grep -c '^package/src/'` | 等于 `src/` 下 `.js` 全量条数 |
| V6 | 包内版本 | `tar -xzOf cs-bots-0.4.0.tgz package/package.json \| grep '"version"'` | `0.4.0` |

### 6.2 安装侧（Windows DSH，主管执行）

> 前置：DSH 已安装且在 PATH；记下页面地址的 `主机:端口`（下称 `<origin>`）。

1. **安装**（二选一，git 失败就用离线包）：
   ```powershell
   dsh plugin --profile web add github:7358716/cs-bots#v0.4.0
   # 或
   dsh plugin --profile web add "C:\path\to\cs-bots-0.4.0.tgz"
   ```
2. **装配树自检**（不看这条，页面 200 也可能是静默跳过）：
   ```powershell
   dsh --profile web --dump-config | Select-String cs-bots
   ```
   通过判据：输出里有 `id: cs-bots` 的行。
3. **重启 DSH**，刷新页面（`/plugins/??cs-bots/client.js&rev=` 会变，无需清缓存）。
4. **页签结构**：顶层 **7 个**：任务 / Bot / 房间 / 记忆 / 技能库 / 工作流库 / 设置。
   「任务」下有 协作看板 / 我的待办 / 便签；「记忆」下有 事实与偏好 / 纪律与要求 / 提示词。
   出现顶层「待办 / 便签 / 纪律 / 提示词」= 装的是旧包。
5. **域服务**：浏览器打开 `http://<origin>/cs-bots/api/status`，
   `services` 里 12 个键（roster/board/dispatcher/room/memory/library/discipline/
   todo/scratch/prompts/suggest/reviewer）全部 `available: true`。
6. **鉴权围栏**：无 cookie 请求应被拒。
   ```powershell
   curl.exe -i -X POST "http://<origin>/cs-bots/api/fs/mkdir" -H "Content-Type: application/json" -d "{\"path\":\"C:\\\\temp\\\\csb-pwn\",\"by\":\"probe\"}"
   ```
   通过判据：`401`（或 403），且目录**没有**被创建。
7. **待办 → 任务幂等**：在「我的待办」新建一条 → 连点两次「派下去」→
   「协作看板」里只能有 **1 条**对应任务；待办变「进行中」。
8. **记忆删除语义**：对一条记忆先「删除」（进归档、可恢复），
   再对另一条用「彻底删除」→ 归档区里**不再出现**，且无法恢复（按钮有后果说明）。
9. **包内版本**：
   ```powershell
   node -p "require(process.env.APPDATA + '/../.dsh/profiles/web/node_modules/cs-bots/package.json').version"
   ```
   通过判据：`0.4.0`。（若 DSH 数据目录不在默认位置，换成实际 profile 路径。）

**任何一项不通过 ⇒ 记录原始输出，按 §5 回滚，不要现场改代码。**

---

## 7. 本次发布执行记录

- 版本：`0.4.0`
- 门禁：G1–G6 全 PASS（原始输出见 `RELEASE-REPORT-v0.4.0.md`）
- git：commit / tag / push 结果见报告 §3
- 离线包：`cs-bots-0.4.0.tgz` 的 sha256 与字节数见报告 §4

> 报告里的每条结论都必须能对应到一条**真实命令输出**。
> 没有输出支撑的「已完成」，一律视为未完成。
