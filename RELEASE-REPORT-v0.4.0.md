# cs-bots v0.4.0 · 发布报告

日期：2026-11-05 ｜ 发布人：插件发布管理员（release manager）｜ 代码状态：**已冻结**

---

## 0. 结论先行

| 项目 | 结论 |
|---|---|
| 发布判定 | **通过**（门禁 G1–G6 全 PASS，无一失败） |
| 版本号 | **0.4.0**（远端 `v0.3.0` 已被占用，按规则递增） |
| 发布提交 | **`8dd22ffcc8137d6c8708f65f3ee2852df40c9eaf`**（`8dd22ff`） |
| tag `v0.4.0` | **已推到远端**，SHA 与发布提交一致 |
| `origin/main` | 发布时指向 `8dd22ff`；本报告作为 docs 提交入库后 main 再前进一提交，**tag 不移动** |
| 离线包 | `cs-bots-0.4.0.tgz`，**341230 字节** |
| tarball sha256 | **`c9ed3e9ab510c8fad3bac5dfa5637f64a57825907082f810eb419ee913b7945f`** |
| 测试 | **656 / 656 通过，0 失败**；零依赖 CI **PASS（5/5）** |
| npm publish | **未执行**（本机无凭据：`npm whoami` → `ENEEDAUTH`；npm 不是本轮通道） |
| 回滚点 | `git revert 8dd22ff` 后发 `0.4.1`；不删 tag、不移动 tag（见 `RELEASE.md` §5） |

> 本报告每条结论后面都有**真实命令输出**。没有输出的「已完成」不写。

---

## 1. 版本位点判定

发版前远端 tag 实况（`git ls-remote --tags origin`，节选）：

```
dfcd1332ada6f9fdea636ab4402a1d8b122e03cc	refs/tags/v0.1.0
a583dd77d272afde6e52d0108357ad06c82b996f	refs/tags/v0.1.1
29bd0457198a9baf29ffe4dc04ce93b4a6f2a2fc	refs/tags/v0.1.2
ada4d8864ca3ed275e2ac92d7b57f2307f17ae6e	refs/tags/v0.2.0
036748b3a303059140287ed07fa40ffc1855d3c6	refs/tags/v0.3.0
```

判定：`v0.3.0` 已被占用 ⇒ 本次版本号 **0.4.0**，`package.json` / tag / CHANGELOG 三者对齐。

**顺带发现的版本位点缺陷（已在本版修复）**：发版前 `package.json` 的 `version` 是
`0.2.0`，而远端 tag 已到 `v0.3.0`——包内版本与发布 tag 脱节，安装方无法从包内判断版本。
本版起 `version=0.4.0`、`tag=v0.4.0`。

---

## 2. 发布门禁（逐条，含失败原文）

### G1 · 全量回归 `bash test/run-all.sh` → **PASS**

```
════════ 1. 零依赖 CI ════════
== 检查 1：src/ 下除 kernel.js 外的 .js 不得 import/require @deepseek-ai/ ==
  OK: 未发现真实 @deepseek-ai/ 模块引用
== 检查 2：package.json 的 dependencies 不存在或为空对象 ==
  OK: dependencies MISSING
== 检查 3：cordis.patch.yml 每个 name 只能是 'cs-bots' 或以 @deepseek-ai/ 开头 ==
  OK: name=cs-bots
  OK: name=@deepseek-ai/dsh-experimental-agent-team
== 检查 4：cordis.patch.yml 覆盖官方行时必须列全 config 字段 ==
  OK: 覆盖行的 config 字段齐全
== 检查 5：客户端禁止 window.prompt / window.confirm（沙箱里被静默屏蔽）==
  OK: 客户端零 prompt/confirm/alert
== 结果 ==
CI PASS
  ✅ CI PASS

════════ 2. 单元测试 ════════
...
# tests 656
# suites 0
# pass 656
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2570.104834
  ✅ 单测通过

════════ 汇总 ════════
✅ 全部通过（exit 0）
```

命令退出码：`G1_EXIT=0`。计数与冻结基线一致（656/656）。

### G2 · 零依赖 CI `bash test/ci-zero-dep.sh` → **PASS（5/5）**

独立执行（不依赖 run-all）的输出与上面「1. 零依赖 CI」段完全一致，末行 `CI PASS`，
`G2_EXIT=0`。5 项检查逐条 OK（依赖为空、无真实官方包引用、patch name 白名单、
覆盖行 config 齐全、客户端零 prompt/confirm）。

### G3 · 语法 `node -c src/client.js && node -c src/api.js` → **PASS**

```
G3A_EXIT=0
G3B_EXIT=0
（两文件均无任何输出）
```

`node -c` 只在语法错误时输出并返回非 0；此处两文件均静默退出 0。

### G4 · 打包清单 `npm pack --dry-run` → **PASS**

```
npm notice name: cs-bots
npm notice version: 0.4.0
npm notice filename: cs-bots-0.4.0.tgz
npm notice package size: 341.2 kB
npm notice unpacked size: 1.2 MB
npm notice shasum: 56f7180ae73582028a6eeefa1a787ee55b0f036c
npm notice total files: 40
```

`files` 白名单逐项核对（真实计数）：

| 要求 | 结果 |
|---|---|
| `src/` 全量 | `find src -name '*.js'` = **26**；包内 `src/**.js` = **26**（含 `src/routing/`） |
| `docs/` | **7** 个（`ARCHITECTURE.md`、`adr/ADR-001-*.md`、`steps/step-01..04`、`交付说明-v0.2.0.md`） |
| `CHANGELOG.md` | 1 |
| `cordis.patch.yml` | 1 |
| `cordis.patch.agent-team.yml` | 1 |
| `install.sh` | 1 |
| `README.md` | 1 |
| `LICENSE` | 1 |

包内清单原文（节选，含中文文件名）：

```
npm notice 13.2kB CHANGELOG.md
npm notice 1.1kB LICENSE
npm notice 10.1kB README.md
npm notice 1.6kB cordis.patch.agent-team.yml
npm notice 1.9kB cordis.patch.yml
npm notice 3.4kB docs/adr/ADR-001-页签结构回到七页.md
npm notice 12.4kB docs/ARCHITECTURE.md
npm notice 4.5kB docs/steps/step-01-原架构复原与IA诊断.md
npm notice 2.5kB docs/steps/step-02-页签收敛与升级通道.md
npm notice 846B docs/steps/step-03-架构资料成文.md
npm notice 2.2kB docs/steps/step-04-上线与验证.md
npm notice 4.6kB docs/交付说明-v0.2.0.md
npm notice 9.6kB install.sh
npm notice 1.4kB package.json
npm notice 61.1kB src/api.js
...
npm notice 11.3kB src/routing/complexity.js
npm notice 23.2kB src/routing/hints.js
```

### G5 · 工作区干净 `git status --short` → **PASS（空）**

发布提交 `8dd22ff` 之后、生成本报告文件之前执行：

```
$ git status --short
（无输出）

$ git status --porcelain | wc -l
0
```

> 本报告是发布之后新增的**独立 docs 提交**（不改变 `v0.4.0` 指向的发布提交）。
> 该提交入库后再次执行 `git status --short` 仍为空，最终结果见 §3.4。

### G6 · 未改源码 → **PASS**

发布者本轮只改 `package.json`（version/files）、`README.md`（安装通道）、
新增 `CHANGELOG.md` 与 `RELEASE.md`；`src/` 下的所有改动都来自**已冻结的 v2 工作**。
工作区与发布提交一致：`git status --porcelain | wc -l` = `0`，
`git diff HEAD -- src/ | wc -l` = `0`（无发布当场改动）。

---

## 3. git 通道执行结果

### 3.1 发布提交

```
$ git log -1 --format='%H%n%h %s'
8dd22ffcc8137d6c8708f65f3ee2852df40c9eaf
8dd22ff release: v0.4.0 —— v2 能力交付 + 页签收敛回 7
```

提交内容：**58 files changed, 23974 insertions(+), 232 deletions(-)**
（含 `docs/`、`CHANGELOG.md`、`RELEASE.md`、`src/` 新模块、15 个新测试文件）。

### 3.2 推送 main

```
$ git push origin main
To github.com:7358716/cs-bots.git
   b94ba0e..8dd22ff  main -> main
PUSH_MAIN_EXIT=0
```

### 3.3 推送 tag

第一次执行 `git push origin v0.4.0` 时得到：

```
fatal: not a git repository (or any of the parent directories): .git
PUSH_TAG_EXIT=128
```

**根因**：该条命令在错误的工作目录执行（漏了 `workdir`），不是 SSH/网络故障，
也不是仓库问题。修正目录后原样重跑一次即成功（未使用任何强制参数）：

```
$ git push origin v0.4.0
To github.com:7358716/cs-bots.git
 * [new tag]         v0.4.0 -> v0.4.0
PUSH_TAG_EXIT=0
```

> 按手册「SSH 失败最多重试 1 次」执行；本次失败与 SSH 无关，仍只重试一次，第二次成功。
> 全程**未** force push、**未**删 tag、**未**改写历史。

### 3.4 远端验证（发布提交推送后、本报告入库前，真实输出）

```
$ git ls-remote --tags origin | grep 'refs/tags/v0.4.0$'
8dd22ffcc8137d6c8708f65f3ee2852df40c9eaf	refs/tags/v0.4.0

$ git ls-remote origin refs/heads/main
8dd22ffcc8137d6c8708f65f3ee2852df40c9eaf	refs/heads/main

$ git rev-parse v0.4.0
8dd22ffcc8137d6c8708f65f3ee2852df40c9eaf

$ git status --short
（无输出）
$ git status --porcelain | wc -l
0
```

三条 SHA（本地 tag / 远端 tag / 远端 main / 发布提交）**完全一致**。

> 本报告随后作为独立 docs 提交入库并推送，`origin/main` 因此再前进一个提交
> （仅新增本报告，不动代码）。**tag `v0.4.0` 不随之移动**，始终指向 `8dd22ff`；
> 发布位点由 tag 决定，不由 main 的最新提交决定。最终 `ls-remote` 输出见交付消息。

---

## 4. 离线包产物

### 4.1 生成与哈希

```
$ npm pack
cs-bots-0.4.0.tgz
npm notice name: cs-bots
npm notice version: 0.4.0
npm notice filename: cs-bots-0.4.0.tgz
npm notice package size: 341.2 kB
npm notice unpacked size: 1.2 MB
npm notice shasum: 56f7180ae73582028a6eeefa1a787ee55b0f036c
npm notice total files: 40

$ sha256sum cs-bots-0.4.0.tgz
c9ed3e9ab510c8fad3bac5dfa5637f64a57825907082f810eb419ee913b7945f  cs-bots-0.4.0.tgz

$ stat -c '%s bytes' cs-bots-0.4.0.tgz
341230 bytes
```

### 4.2 包内容校验（解包后直接读，不是看 npm 自报）

```
$ tar -xzOf cs-bots-0.4.0.tgz package/package.json | grep '"version"'
  "version": "0.4.0",

$ tar -tzf cs-bots-0.4.0.tgz | grep -c '^package/src/.*\.js$'
26

$ tar -tzf cs-bots-0.4.0.tgz | grep -c '^package/docs/'
7

$ tar -tzf cs-bots-0.4.0.tgz | grep -E '^package/(CHANGELOG\.md|README\.md|LICENSE|install\.sh|cordis\.patch\.yml|cordis\.patch\.agent-team\.yml)$'
package/LICENSE
package/CHANGELOG.md
package/README.md
package/install.sh
package/cordis.patch.agent-team.yml
package/cordis.patch.yml
```

`*.tgz` 在 `.gitignore` 中（**故意不提交**）：它是发布产物，不进源码历史。
传输时请随包附上 sha256 与字节数，主管装前先核对。

---

## 5. 发布后验证清单（V1–V6 实测）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| V1 | 远端 tag 存在且 SHA 正确 | `git ls-remote --tags origin \| grep 'refs/tags/v0.4.0$'` | **PASS**：`8dd22ff...` = 本地 `git rev-parse v0.4.0` |
| V2 | 远端 main 指向发布提交 | `git ls-remote origin refs/heads/main` | **PASS（发布时刻）**：`8dd22ff...`；报告文档提交后 main 前进，tag 不变 |
| V3 | 工作区干净 | `git status --short` | **PASS**：无输出；porcelain 行数 0 |
| V4 | tarball 哈希登记 | `sha256sum` | **PASS**：`c9ed3e9a…7945f`，341230 字节 |
| V5 | 包内 src 全量 | `tar -tzf ... \| grep -c '^package/src/.*\.js$'` | **PASS**：26 = 26 |
| V6 | 包内版本 | `tar -xzOf ... package/package.json \| grep version` | **PASS**：`0.4.0` |

安装侧（Windows DSH）验证步骤见 §7。

---

## 6. 已知问题（均**不阻塞**本次发布，如实记录）

1. **npm registry 仍是 0.1.1**：本轮无 npm 凭据（`npm whoami` → `ENEEDAUTH`），
   未执行、也不应执行 `npm publish`。README 已把 npm 通道标注为「旧版」，
   0.4.0 只走 git / 离线包。
2. **`docs/交付说明-v0.2.0.md` 标题沿用旧版本号**：它是 v2 工作的历史交付说明，
   内容与 0.4.0 一致，仅标题版本滞后。未改（改写历史交付文档的版本标签会破坏可追溯性），
   建议下轮统一改名。
3. **`docs/ARCHITECTURE.md` 标题写「v0.2.0」**：内容描述 v2 架构（12 服务 / 93 端点 /
   27 工具），与 0.4.0 代码一致；仅标题版本滞后。同上，未改。
4. **`RELEASE.md` 不在 npm `files` 白名单**：发布手册是仓库运维文档，
   不随包分发给安装方（`package.json` 只按要求加入 `docs` 与 `CHANGELOG.md`）。
5. 发布前存在的历史问题：`package.json` 版本（0.2.0）与远端 tag（v0.3.0）脱节，
   本版已对齐为 0.4.0。

---

## 7. 给主管：Windows DSH 验证

### 7.1 两条安装命令（二选一）

```powershell
# 通道 1 · git（推荐）
dsh plugin --profile web add github:7358716/cs-bots#v0.4.0

# 通道 2 · 离线包（github:443 间歇不可达时用；先核对 sha256）
dsh plugin --profile web add "C:\path\to\cs-bots-0.4.0.tgz"
```

### 7.2 装后逐项验证（不看这条，页面 200 也可能是静默跳过）

1. **装配树**：`dsh --profile web --dump-config | Select-String cs-bots` → 有 `id: cs-bots`。
2. **重启 DSH**，刷新页面。
3. **页签 = 7**：任务 / Bot / 房间 / 记忆 / 技能库 / 工作流库 / 设置；
   「任务」下有 协作看板 / 我的待办 / 便签；「记忆」下有 事实与偏好 / 纪律与要求 / 提示词。
   若出现顶层「待办 / 便签 / 纪律 / 提示词」⇒ 装到旧包了。
4. **12 域服务**：浏览器打开 `http://<origin>/cs-bots/api/status`，
   `services` 下 12 个键全部 `available: true`。
5. **鉴权围栏**：无 cookie 的 `POST /cs-bots/api/fs/mkdir` → 401/403，且目录未创建。
6. **待办 → 任务幂等**：同一条待办连点两次「派下去」，看板里只有 1 条任务。
7. **记忆删除语义**：`remove` 进归档可恢复；`purge` 彻底消失不可恢复。
8. **包内版本**：安装目录下 `package.json` 的 `version` = `0.4.0`。

任何一项不通过 ⇒ 记录原始输出，按 `RELEASE.md` §5 回滚，**不要现场改代码**。

---

## 8. 回滚办法（摘要，全文见 `RELEASE.md` §5）

- 代码回滚：`git revert --no-edit 8dd22ff` → 发 **0.4.1** 新版本；
- **禁止**：force push、`git tag -f v0.4.0`、删除已推 tag、rebase 已推历史；
- 数据：`memory.purge` 不可逆，升级前备份 `$DSH_HOME/cs-bots/`；
- 安装侧回退：`dsh plugin --profile web add github:7358716/cs-bots#v0.3.0`（或旧 tarball）后重启。

---

*报告完。证据链：门禁日志 → 提交 `8dd22ff` → tag `v0.4.0` → tarball `c9ed3e9a…`。*
