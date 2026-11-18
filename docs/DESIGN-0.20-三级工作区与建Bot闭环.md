# DESIGN 0.20 · 三级工作区与「建 Bot」闭环

> 版本：草案 v1（待 Boss 签字）
> 日期：2026-11-18
> 作者：开发管家（lead）
> 基线：cs-bots `0.19.2`（工作区 HEAD `b0abf97`）
> 范围：Linux + Windows 桌面版 DSH 双平台
> 需求出处：Boss 2026-11-18 截图 1/2/3 + 追加要求「要求按最完整的三级方案做」

---

## 0. 一句话

**把「部门」从一个可选字段升级成一等公民的目录与分组实体**，使得任何一条创建/迁移 Bot 的路径都同时产出
`主目录 → 部门 → Bot` 的三级真实目录和三级左侧栏分组，并且失败时给出可执行的下一步，而不是一句 400。

---

## 1. 现状盘点（证据先行，不看结论看代码/数据）

### 1.1 已经做到的部分（不要重做）

| 能力 | 证据位置 | 状态 |
|---|---|---|
| 目录派生 `主目录/部门id/Bot名`，含穿越防护 + 前缀兜底 | `src/botdirs.js:87-140` | ✅ 有测试 `test/botdirs.test.mjs` |
| 宿主按最近已登记祖先自动嵌套（`owningParentFolder`） | `src/kernel.js:676-690` 注释 + `ensureWorkspaceDir` 实现 `:709` | ✅ 能力存在 |
| 三级登记的**补齐逻辑**（主目录 / 部门 / Bot 三段串行） | `src/api.js:2689-2740`（`/workspaces/tidy`） | ⚠️ 只在「整理工作区」里跑 |
| 主目录登记成 Workspace | `src/index.js` 启动段（已改为**启动时什么都不做**） | ⚠️ 见 1.2 |
| 部门保存/改名/删除保护（有 Bot 不许删） | `src/api.js:2988-3058` | ✅ |
| 同目录共享检测（告知而非静默） | `src/api.js:3236-3258` | ✅ |

### 1.2 缺陷清单（本次要修的）

**D1 · 建 Bot 与部门登记不是一个原子动作（图 1 根因）**

- `roster.create` 用 `deriveBotCwd` 校验部门，不存在则抛 `BOT_DEPT_UNKNOWN`（`src/roster.js:713-722`）。
- 前端建 Bot 时**不登记任何 Workspace**：`POST /roster` 处理里只有 `create` + `seedBotMemory` +
  同目录检测（`src/api.js:3214-3260`），全程没有 `ensureWorkspaceDir`。
  ⇒ 直接后果：**即使建 Bot 成功，左侧栏也不会出现这一级分组**，必须再手动点「整理工作区」。
- 图 1 的表现（部门下拉显示中文，提交却报部门不存在）属于同一根因的变体：
  `services.settings` 是**启动时的内存快照**（`src/index.js:150`），
  部门写入磁盘后若未能同步内存态，就会出现「界面有、后端不认」；
  另外 `BotsTab` 的 `dept` 兜底是 `form.department || defaultDepartment || dpts[0].id`（`src/client.js:5236-5237`），
  下拉视觉上停在第 N 项（截图里是那个中文名），状态里实际却是默认部门 —— **所见非所发**。
- 补充事实：本机 `~/.dsh/cs-bots/settings.json` 的部门表只有 `dev/qa/ops/misc`；
  id `test20261118` 从未落盘。Win 那台是独立数据，**两边本就不共享**，这类漂移必然复现。

**D2 · 启动时完全不登记（层级靠用户手动触发）**

- `src/index.js:260-276` 明确写了：「彻底改为按需登记……启动时一条都不建」。
  这条决策的背景是 2026-11-15 的 `workspace domain is inconsistent` 事故
  （并发 `attachToWorkspace` 把同一路径注册两次 ⇒ 5 个组件 pending ⇒ 页面登录不了）。
  **决策是对的（先止血），但兜底路径只留了「整理工作区」这一个按钮**，普通用户不会去点。

**D3 · 登记入口分散，语义不一致**

- `moveToDept` 只改 `cwd`（`src/api.js:3318-3335`），**不登记目标目录**，也不清理源目录。
- `attach-workspaces` 只挂**已存在**的分组，缺了直接跳过（`src/api.js:2637-2641`）——
  于是「建 Bot 后左侧栏没东西 → 点这个按钮 → 提示分组还没有 → 死循环」。
- `setCwd`（手动改目录）同样不登记。
- 结果：用户感知是**四个功能各修各的，没有一个路径能一次做对**。

**D4 · 跨平台细节只做了一半**

- `isInsideDir` / `join` 已跨平台（`src/api.js:3310` 注释有记录）。
- 但「主目录不存在 ⇒ `registry.create` 因 `realpath` 抛错」这个坑，
  目前只在 `ensureWorkspaceDir` 内部做了 mkdir（`src/kernel.js:749-760` 注释），
  **没有一条『自愈 + 可诊断』的完整链路**；Win 首次安装仍是高风险路径。

**D5 · 失败信息不可执行**

- `BOT_DEPT_UNKNOWN` 只回「部门 X 不存在（可选：dev | qa）」。
  用户看到的是「我明明选了部门」，第一反应是软件坏了；实际要教他「先建这个部门」。

### 1.3 基线健康度（本次改动的安全网）

- `bash test/run-all.sh` ⇒ **1530 项全过，exit 0**（2026-11-18 实跑）。
- 与本次直接相关的既有测试：`botdirs` / `kernel-workspace-dir` / `index-ws-register` /
  `api-workspaces-tidy` / `path-crossplatform` / `settings-path-win` / `depttree` / `roster` / `transfer`。

---

## 2. 目标与验收（可机械判定）

### 2.1 目标

1. **任何产生 Bot 的动作，都同时产生它的三级目录与三级分组。**
2. **三级结构在 Linux 与 Windows 桌面版上都成立**，不依赖用户手动切「工作区树」视图也能看出层级。
3. **部门是唯一真相源**：目录名、分组名、团队名、群聊名同源同改。
4. **失败必须可执行**：报错要告诉用户下一步点哪里。

### 2.2 验收标准（DoD，机械可查）

| # | 场景 | 通过判据（脚本输出 / 文件事实） |
|---|---|---|
| A1 | 空部门表上建 Bot，选「＋ 新增部门…」 | 一次成功；`settings.json` 里出现该部门；磁盘出现 `主目录/部门/Bot`；`workspace.json` 出现三级三条记录 |
| A2 | 已有部门、直接建 Bot | 同上，无需任何二次操作；接口返回 `workspace: {root, dept, bot}` 三段状态 |
| A3 | 部门 id 不存在（直接打接口） | HTTP 400 + `code: BOT_DEPT_UNKNOWN` + `hint` 含「先建部门」，且**不产生任何目录/会话/workspace 残留** |
| A4 | 建 Bot 时 workspace 域不可用 | Bot **照常建成**，返回 `warnings: ['左侧栏分组未登记：<原因>，可在「Bot 档案」点「重建分组」']`，不静默、不阻塞 |
| A5 | 换部门（moveToDept） | 目录迁移成功 + 目标分组登记 + 源分组**无残留空壳**（或明确保留并说明） |
| A6 | 团队名/群聊名与部门改名联动 | 改名后三处一致（已有能力，回归不破） |
| A7 | 重启 dsh-web 后 | 三级结构**原样存在**，不重复、不产生 `domain inconsistent`（对比 `workspace.json` 前后 diff） |
| A8 | 「重建分组」按钮 | 幂等：连点 3 次后 `workspace.json` 记录数不变 |
| A9 | Win 桌面版 | 同 A1–A8，用 `test/win-regress.mjs` 一键跑通并产出报告 |

---

## 3. 方案

### 3.1 核心抽象：`WorkspaceHierarchy`（新增 `src/ws-hierarchy.js`）

把散在 `api.js` 里的三段登记逻辑收拢成一个域服务，**一条命令做完整件事**：

```js
ensureBotHierarchy(ctx, { root, deptId, deptName, botCwd, botName })
// 返回 { ok, steps: [{ level:'root'|'dept'|'bot', path, ok, created, reason? }], degraded:boolean }
```

设计要点（每条都对应一个已发生的坑）：

1. **串行 + 全局锁**：复用现有 `__csBotsWorkspaceRegLock` 模式（`src/api.js:2660-2672`），
   绝不用 `Promise.all` —— 这是 2026-11-15 事故的直接原因。
2. **磁盘优先判重**：建之前先读 `workspace.json`（`listWorkspaceRecords`），
   命中就跳过 —— 内存态 `entities` 在域初始化期不可靠。
3. **先 mkdir 再 create**：`registry.create` 第一行是 `realpath`，目录不存在直接抛（Win 首次安装坑）。
4. **不挂会话**：只建分组容器，`attachSession` 交给宿主在会话创建时自己处理。
5. **失败降级**：拿不到 `workspaceRegistry` ⇒ `degraded:true` + 明确原因，**绝不抛穿**业务主流程。
6. **title 用部门中文名**：`dev` → `开发部`（已有约定，`src/api.js:2714`）。

### 3.2 调用点改造（把 D1/D3 一次补齐）

| 调用点 | 现在 | 改为 |
|---|---|---|
| `POST /roster`（建 Bot） | 只 create | create → **ensureBotHierarchy** → 返回三段状态 + 降级警告 |
| `POST /roster/manage` `moveToDept` | 只 setCwd | setCwd → **ensureBotHierarchy(新)** → 安全清理源空壳 → 返回迁移报告 |
| `POST /roster/manage` `setCwd` | 只改 cwd | 若新 cwd 在主目录下 ⇒ 同样走 hierarchy |
| `POST /roster/rebuild` | 重建会话 | 重建后补 hierarchy |
| `POST /roster/attach-workspaces` | 只挂已存在 | **分组缺失就先登记再挂**（去掉「死循环」） |
| 启动 | 什么都不做 | **不做全量登记**，只做一次**只读体检**，把差异写进 `/status.hierarchy`（见 3.3） |

> **为什么启动仍不做全量登记**：启动窗口里 `workspaceRegistry` 可能未就绪，
> 全量 create 正是事故来源。改为「体检 + 用户可见的修复入口」，把不可控副作用挪出启动路径。

### 3.3 启动体检（新）

`GET /status` 新增 `hierarchy` 字段：

```jsonc
{ "root": "/home/ubuntu/cs-bots", "exists": true, "registered": true,
  "departments": [ { "id":"dev","name":"开发部","dirExists":true,"registered":true,"bots":3,"botsRegistered":2 } ],
  "missing": [ { "level":"bot", "path":".../dev/开发执行岗" } ],
  "hint": "有 1 个 Bot 目录还没登记到左侧栏 —— 到「Bot 档案」点「重建分组」" }
```

启动时只**读**，不写。这样既保留了 11-15 事故的教训，又让「为什么左侧栏没层级」从
「靠猜」变成「一条 GET 就有答案」。

### 3.4 部门是唯一真相源（修 D5 + 图 1 变体）

1. **写后即时同步内存态**：所有改部门的路径统一走 `applyDepartments(services, next)`，
   同时写盘（`saveSettings`）与 `services.settings.departments = next`（现状已有，但是散的）。
2. **建 Bot 前端不再「所见非所发」**：下拉的 `value` 必须来自真实存在的部门；
   `dept` 兜底时若 `form.department` 不在 `dpts` 里，**立即回落到 `dpts[0]` 并高亮**，
   而不是让视觉停在一个不存在的项上。
3. **`BOT_DEPT_UNKNOWN` 升级为可执行报错**：
   ```json
   { "code":"BOT_DEPT_UNKNOWN", "department":"test20261118",
     "hint":"部门「test20261118」不存在。请先在「Bot 档案 → 部门」建它，或改选：开发部(dev) / 测试部(qa)",
     "action":"create-department" }
   ```
   前端拿到 `action` 直接把「＋ 新增部门…」展开并预填 id。

### 3.5 建 Bot 一站式向导（修「用户得知道三个页面才建得成」）

把现在的「名字 + 部门下拉 + 预设」补成四步，**缺什么就地补**：

```
① 名字           （必填）
② 部门           ├ 下拉只列真实部门
                 └ 缺部门 ⇒ 「＋ 新增部门…」就地建（先落字典，再进下一步）
③ 工作目录       （只读，实时预览 主目录/部门/名字 —— 已有）
④ 专家身份       （预设）
[创建 Bot] → 成功后回显：目录已建 ✅ / 分组已登记 ✅ / 会话已起 ✅（三段各自独立状态）
```

最后一段三段式回显是本方案的关键 UX：**把「左侧栏有没有」这种此前不可见的事，变成建完立刻可见的事实**。

### 3.6 左侧栏三级展示（双保险）

- **主路径**：靠宿主 `owningParentFolder` 自动嵌套（已存在的能力，不用改宿主）。
  我们保证三级的 `workspace.json` 记录都在。
- **兜底路径**：`GET /status.hierarchy.missing` 非空时，页面顶部常驻一条可点提示
  （「有 N 个目录还没进左侧栏 → 重建分组」），不依赖用户自己去翻「整理工作区」。
- **不碰宿主存储**：`client.js:9505` 那段「写坏 `localStorage` 导致左侧栏空白」的教训写死在纪律里，
  CI 继续机械禁止（`test/ci-zero-dep.sh` 检查项）。

### 3.7 存量数据迁移

`POST /migrate/hierarchy`（幂等，dry-run 优先）：

1. 扫 `workspace.json` + 磁盘 + `roster`，列出三类差异：目录有分组无 / 分组有会话无 / 孤儿分组。
2. 默认 `dryRun:true` 只报清单；`confirm:true` 才串行修，逐条回报。
3. **不删任何 Bot、不删任何目录**，只增登记与清理**明确识别为空壳**的分组（且需 `confirm`）。

---

## 4. 任务拆分与排期

WIP 上限 2（按你定的 `wipLimitPerBot`）。每个任务都是**文件分区独立**的，可并行不打架。

| ID | 任务 | 主要文件（写域） | 依赖 | 估时 |
|---|---|---|---|---|
| T1 | `ws-hierarchy.js` 域服务 + 单测 | `src/ws-hierarchy.js`、`test/ws-hierarchy.test.mjs` | — | 4h |
| T2 | 六条调用点改造 + 契约测试 | `src/api.js`、`test/api-hierarchy.test.mjs` | T1 | 4h |
| T3 | 启动体检 + `/status.hierarchy` | `src/index.js`、`src/api.js`(status 段) | T1 | 2h |
| T4 | 前端：向导四步 + 三段式回显 + 所见即所发 | `src/client.js`（BotsTab 区） | T2 | 5h |
| T5 | 前端：`hierarchy.missing` 常驻提示 + 重建分组 | `src/client.js`（提示区） | T3 | 2h |
| T6 | 迁移端点 `POST /migrate/hierarchy`（dry-run） | `src/api.js`（新段）、`test/api-migrate.test.mjs` | T1 | 3h |
| T7 | Windows 回归脚本 + 报告模板 | `test/win-regress.mjs`、`docs/WIN-REGRESS.md` | T2,T3 | 3h |
| T8 | 文档：ARCHITECTURE 补 §10、ADR-002、CHANGELOG | `docs/`、`CHANGELOG.md` | T2–T4 | 2h |
| T9 | 打包与安装验证（tgz + 干净 profile 安装） | `package.json`、发布脚本 | 全部 | 2h |

**关键路径**：T1 → T2 → T4/T6/T7 → T9。合计约 27 人时 ⇒ 我按 **1 轮（今日）出 0.20.0-rc1，次日回归** 排。

**冲突规避（文件写域）**

- `client.js` 是单文件大文件（43 万行字符级体积），T4/T5 必须**顺序做**，或由同一执行者一次改完。
- `api.js` 由 T2/T3/T6 共用 ⇒ 三人不能并行写同一文件：**串行 T2 → T3 → T6**，
  或拆成三个不相邻区间后由我合并复核（我倾向串行，安全）。

---

## 5. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 再次出现 `workspace domain is inconsistent` | 中 | **页面登录不了**（历史最高危） | 只增不删 + 全局串行锁 + 磁盘优先判重 + 启动只读；上线前先备份 `workspace.json` |
| Win 路径分隔符/盘符大小写差异 | 中 | 登记判重失效 ⇒ 重复记录 | 判重按规范化路径（大小写不敏感 + 分隔符归一），T7 专项 |
| 引导部门目录被当成 Bot 目录 | 中 | 多一层空分组 | 白名单：`archive/shared/scratch` 不登记 |
| 存量 26 个 Bot（11 个 retired 同名）迁移误伤 | 中 | 用户数据混乱 | 迁移默认 dry-run；retired 不建目录不登记 |
| 前端大文件改动引入回归 | 中 | 建 Bot 页面白屏 | T4 完成后必跑 `test/client*.test.mjs`（现有 11 个）+ jsdom 快照 |

---

## 6. 需要 Boss 拍板的三件事

1. **部门 id 用英文还是允许中文？** 现在是英文 id + 中文显示名（`dev` → 开发部）。
   图 1 里输的是 `test20261118`，说明你自己也按英文在填。建议**保持**（跨平台最稳）。
2. **建 Bot 失败时，是否允许「自动建部门」？**
   我建议**不允许静默自动建**，只给一键预填（避免打错一个字就多个垃圾部门）。
3. **retired Bot 的目录与分组**：保留（占位可见）还是折叠隐藏？我建议**保留目录、分组不显示**。

---

## 7. 不在本次范围

- 宿主导航/页签结构改造（ADR-001 已定，不动）。
- 多人协作/远程同步（无此需求）。
- npm 主通道切换（另案，见发布章节）。

---

## 附：本次要交付的证据清单

- `bash test/run-all.sh` 全绿（基线 1530 → 目标 ≥1560）
- `workspace.json` 前后 diff（证明只增不删、无重复）
- A1–A9 逐条实测输出（Linux 本机 + Win 报告）
- `/status.hierarchy` 截图或 JSON 原文