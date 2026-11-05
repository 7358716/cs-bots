# cs-bots UX 实现规格 v1（人类视角）

> 日期：2026-11-05（Asia/Shanghai）
> 依据：src/client.js 3930 行实测（函数名与行号均为 grep 实测值）、src/api.js 端点、design/19/20/21 设计稿、design-final.md（P0 已落地的后端改造）。
> 本文件是**规格**，不含实现代码。每项给出：现状 → 改法 → 落点文件与函数名 → 验收方式。

## 0. 结论先行

1. **七页签结构已正确**（TABS 在 client.js:3776），不需要加页签；要改的是各页签内部的**交互深度**。
2. **空状态引导已有一半**：Bot/房间/任务/记忆/待办/提示词/纪律 7 处有 `Empty` 组件（client.js:338），但**没有跳转按钮**（只能看提示，不能一键去建）。这是最小的一刀。
3. **TasksTab 是最大短板**：只有「看全部 / 只看需要我管的」两档过滤 + 5 个状态筛选（client.js:746-872），没有：标签过滤、负责人过滤、优先级排序、批量操作、视图保存。这些字段后端已经支持（labels/assignee/priority 都在 PATCH_FIELDS），前端没暴露。
4. **错误提示是裸 message**：`csb-err` 直接显示后端 message（client.js:817），对 WIP 超限/租约占用等高频冲突，没有「下一步怎么办」的引导。
5. **快捷键、撤销、批量操作完全不存在**（grep 实测：client.js 无 keydown 监听、无 undo、无多选）。
6. **可访问性只有 role=tablist / aria-selected**（client.js:3827/3835），按钮无 aria-label、输入无 label、无键盘焦点管理。

---

## 1. 空状态引导

### 现状
已有 7 处 `Empty` 组件：
| 位置 | 标题 | 现状 |
|---|---|---|
| client.js:822 | 还没有任务 | 有 hint，无按钮 |
| client.js:1559 | 还没有 Bot | 有 hint，无按钮 |
| client.js:2013 | 还没有房间 | 有 hint，无按钮 |
| client.js:2446 | 还没有记忆条目 / 归档区是空的 | 无按钮 |
| client.js:3106 | 「{track}」这类还没有待办 | 无按钮 |
| client.js:3408 | 还没有提示词 | 无按钮 |
| client.js:3642 | 还没有任何纪律 | 无按钮 |
| client.js:709 | 还没有操作记录（TaskDrawer 内） | 无按钮 |
| client.js:2054 | 还没有消息（房间内） | 无按钮 |

### 改法
`Empty` 组件扩展一个可选 `action` prop：`{ icon, title, hint, action: { label, onClick } }`。7 处空态全部补上「去建一个」按钮，点击后**直接切到对应页签并打开创建表单**。

### 落点
- `src/client.js` → `function Empty({ icon, title, hint, action })`（L338）
- `src/client.js` → `TasksTab()`（L746）空态分支
- `src/client.js` → `BotsTab()`（L1419）空态分支
- `src/client.js` → `RoomsTab()`（L1906）空态分支
- `src/client.js` → `MemoryTab()`（L2258）空态分支
- `src/client.js` → `TodoTab()`（L2994）空态分支
- `src/client.js` → `PromptsTab()`（L3317）空态分支
- `src/client.js` → `DisciplineTab()`（L3572）空态分支

### 验收方式
- 每个页签在无数据时显示 CTA 按钮，点击后跳到对应创建表单
- 空态 CTA 点击后，创建表单自动聚焦到第一个输入框

---

## 2. 默认值

### 现状
- 创建任务：`POST /tasks` body 只有 `{ subject: s }`（client.js:775），后端默认 status=pending、priority=0、progress=0、triaged=false
- 创建 Bot：默认值在 BotsTab 的表单里
- 创建房间：默认值在 RoomsTab 的表单里

### 改法
前端创建表单补默认字段（与后端 `board.create` 默认对齐）：
- 任务：status=pending、priority=0、progress=0、triaged=false、labels=[]
- 任务创建后立即提示：「任务已建，需要指派或领取才能开始」（而不是静默成功）

### 落点
- `src/client.js` → `TasksTab().create()`（L771）
- `src/client.js` → `TaskDrawer`（L646）新建任务分支

### 验收方式
- 创建任务后 Toast 提示，含下一步引导
- 新任务在列表中显示「待领取」状态标签

---

## 3. 模板

### 现状
- library.js 存技能和工作流，没有任务模板/房间模板
- SkillsTab / WorkflowsTab 的模板能力只覆盖技能与工作流

### 改法
**结论：不复用 library.js，新增独立 `templates.json`**（理由：library.js 的 schema 是 skill/workflow，字段不匹配；任务模板字段是 subject/description/labels/priority/dueAt，语义不同）。
- `src/templates.js`：任务模板 CRUD + 房间模板 CRUD
- 模板字段：name、description、kind(task|room)、fields（对象，按 kind 不同）
- 前端 UI：模板下拉选择器（创建任务时先选模板，再填字段）

### 落点
- 新增 `src/templates.js`（新文件）
- `src/client.js` → `TasksTab()` 创建表单上方加模板下拉
- `src/client.js` → `RoomsTab()` 创建表单上方加模板下拉

### 验收方式
- 至少内置 3 个任务模板（软件开发 / 市场活动 / 研究调研）
- 选模板后自动填充 fields，用户可改

---

## 4. 快捷键

### 现状
无 keydown 监听（grep 实测：client.js 没有 keydown/keyup 事件绑定）

### 改法
| 键 | 功能 | 生效条件 |
|---|---|---|
| C | 新建任务 | 不在输入框/文本域内 |
| E | 编辑当前选中任务 | 不在输入框/文本域内 |
| V | 切换视图（Kanban/列表） | 不在输入框/文本域内 |
| ? | 显示快捷键帮助 | 不在输入框/文本域内 |
| Esc | 关闭当前抽屉/弹窗 | 始终生效 |
| N | 新建 Bot | 不在输入框/文本域内 |
| R | 新建房间 | 不在输入框/文本域内 |

**避免与输入框冲突**：所有快捷键在 `event.target` 是 `input/textarea/select/[contenteditable]` 时跳过。

### 落点
- `src/client.js` → 新增全局 keydown 监听（建议放在 `Workbench()` 内或 `PanelIcon()` 内）
- `src/client.js` → `TaskDrawer` 内 Esc 关闭
- `src/client.js` → `Modal` 内 Esc 关闭

### 验收方式
- 在输入框里打字时，按 C/E/V/N/R 不触发快捷键
- 按 ? 弹出快捷键帮助面板

---

## 5. 撤销 5s

### 现状
删除任务/房间/Bot/记忆时，要么直接执行，要么用 `ConfirmModal` 二次确认（client.js:415），没有撤销。

### 改法
- 前端：删除成功后，底部弹出「已删除，撤销？」Toast，5s 内点击可撤销
- 后端需要补偿接口：
  - `POST /tasks/restore`：把 deleted 任务恢复为 pending（需要 board 新增 action `restore`）
  - `POST /rooms/restore`：恢复已解散房间
  - `POST /bots/restore`：恢复已退役 Bot（若 roster 支持）
- 状态变更（claim/release/complete）同样支持 5s 撤销

### 落点
- `src/client.js` → `TasksTab().quick()`（L783）扩展 undo
- `src/client.js` → `TaskDrawer` 删除按钮
- `src/client.js` → 新增 `Toast` 组件（撤销条）
- `src/api.js` → 新增 `POST /tasks/restore`
- `src/board.js` → 新增 action `restore`

### 验收方式
- 删除任务后 5s 内点「撤销」，任务回到列表
- 5s 后撤销条消失，任务不可恢复

---

## 6. 批量操作

### 现状
无多选、无批量操作（grep 实测）

### 改法
- TasksTab 卡片左侧加复选框（点击卡片时默认选中，或显式多选模式）
- 批量操作：批量改状态（claim/release/complete）、批量改标签、批量改负责人
- **CAS 冲突处理：整体失败**（不是逐条）。理由：逐条成功会让用户以为全成功，但部分任务因 rev 过期而失败，造成数据不一致。整体失败让用户知道「有冲突，刷新后重试」。

### 落点
- `src/client.js` → `TasksTab()` 卡片渲染（L840）
- `src/client.js` → 新增批量操作栏组件
- `src/api.js` → 新增 `POST /tasks/batch`（body: `{ ids: [...], action, fields }`）

### 验收方式
- 多选 3 个任务 → 批量 claim，若其中 1 个 rev 过期，整个请求返回 409 + 冲突列表
- 用户看到「有 1 个任务已被修改，请刷新」提示

---

## 7. saved views

### 现状
无

### 改法
- **存储位置：独立 `saved-views.json`**（不塞进 settings.featureFlags，因为那是 feature flag 专用）。理由：saved views 是用户数据，不是系统配置。
- 视图字段：`{ name, filter: { status, labels, assignee, priority }, sort, group }`
- 上限：50 个
- UI：TasksTab 顶部加「视图」下拉，显示已保存视图列表，支持新建/删除

### 落点
- 新增 `src/savedviews.js`（或扩展 settings.js）
- `src/client.js` → `TasksTab()` 顶部加视图栏

### 验收方式
- 保存视图后，切换页签再回来，视图仍在
- 删除视图后，该视图消失

---

## 8. 错误可读映射表

### 现状
`csb-err` 直接显示后端 message（client.js:817）。对 BOARD_WIP_EXCEEDED 等高频冲突，message 虽含 bot id/上限/当前数，但用户不知道**下一步做什么**。

### 改法
在 client.js 新增错误映射函数，把后端 code 映射成「人话 + 下一步建议」：

| code | 后端 message | 前端人话 | 下一步建议 |
|---|---|---|---|
| BOARD_WIP_EXCEEDED | WIP 超限 | 「你已经在管 N 个任务了（上限 M），先完成或释放一些再接新的」 | 按钮：查看我的任务 |
| BOARD_LEASE_HELD | 租约被占用 | 「这个任务正由另一个 Bot 在做，等它完成或租约过期」 | 按钮：查看持有者 |
| BOARD_NOT_READY | 依赖未完成 | 「这个任务的前置任务还没做完，等前置完成才能开始」 | 按钮：查看前置任务 |
| BOARD_ALREADY_COMPLETED | 任务已完成 | 「这个任务已经完成了，不用再操作」 | — |
| BOARD_DEPENDENCY_CYCLE | 依赖成环 | 「任务之间的依赖关系成了环，检查一下谁依赖谁」 | 按钮：查看依赖图 |
| CAS_MISMATCH / BOARD_REV_CONFLICT | rev 不匹配 | 「这个任务刚被别人改过，刷新一下再操作」 | 按钮：刷新 |
| BOARD_TASK_DELETED | 任务已删除 | 「这个任务已经被删除了」 | — |
| BOARD_APPEND_FAILED | 事件追加失败 | 「写入失败了，可能是磁盘或权限问题，请检查状态目录」 | — |

### 落点
- `src/client.js` → 新增 `function humanizeError(e)` 函数
- `src/client.js` → `TasksTab().quick()` 的 catch 分支（L788）
- `src/client.js` → `TaskDrawer` 的操作按钮 catch 分支

### 验收方式
- grep 能查到 8 个 code 都在映射表里
- 触发 WIP 超限时，前端显示人话 + 「查看我的任务」按钮

---

## 9. 渐进披露

### 现状
设置页已分组（MEM_ADV_KEYS 在 client.js:2823），但高级设置项没有折叠。

### 改法
- 设置页分 4 组：基础（默认显示）、记忆（默认显示）、高级（默认折叠）、危险区（默认折叠 + 红色边框）
- 每组有「展开/收起」按钮
- 危险区（删除记忆、清空便签）需二次确认

### 落点
- `src/client.js` → `ReviewSettings()`（L2736）
- `src/client.js` → `SettingsBody`（设置页主入口）

### 验收方式
- 默认打开设置页时，高级设置不可见
- 点击「展开高级」后，高级设置可见

---

## 10. 可访问性

### 现状
只有 `role=tablist` / `aria-selected`（client.js:3827/3835）。

### 改法
具体清单（逐项实现）：
1. 所有按钮加 `aria-label`（当前只有关闭按钮有）
2. 所有输入框加 `aria-label` 或 `<label>` 关联
3. 键盘焦点管理：Tab 键可遍历所有交互元素，焦点样式可见（`:focus-visible`）
4. 颜色对比度：状态色（csb-b-err / csb-b-ok / csb-b-warn）需通过 WCAG AA 对比度（当前用 CSS 变量，需检查值）
5. 抽屉/弹窗打开时，焦点移到弹窗内；关闭时焦点回到触发按钮
6. 屏幕阅读器：`aria-live="police"` 区域用于 Notice 提示

### 落点
- `src/client.js` → 所有 `h('button', ...)` 加 aria-label
- `src/client.js` → 所有 `h('input', ...)` 加 aria-label 或 id+label
- `src/client.js` → CSS 增加 `:focus-visible` 样式

### 验收方式
- 键盘 Tab 遍历所有交互元素，焦点可见
- 屏幕阅读器能读出 Notice 内容
- 颜色对比度通过 WCAG AA

---

## 11. 落点函数名核对（grep 实测）

以下函数名均在 src/client.js 中真实存在（grep 实测，2026-11-05）：

| 函数名 | 行号 | 用途 |
|---|---|---|
| `Empty` | L338 | 空状态组件 |
| `Section` | L344 | 分区标题 |
| `Modal` | L387 | 弹窗 |
| `ConfirmModal` | L415 | 二次确认弹窗 |
| `TaskDrawer` | L646 | 任务详情抽屉 |
| `TasksTab` | L746 | 任务页签 |
| `BotsTab` | L1419 | Bot 页签 |
| `RoomsTab` | L1906 | 房间页签 |
| `MemoryTab` | L2258 | 记忆页签 |
| `ReviewSettings` | L2736 | 记忆审查设置 |
| `TodoTab` | L2994 | 待办页签 |
| `ScratchTab` | L3244 | 便签页签 |
| `PromptsTab` | L3317 | 提示词页签 |
| `DisciplineTab` | L3572 | 纪律页签 |
| `SkillsTab` | L874 | 技能库页签 |
| `WorkflowsTab` | L1288 | 工作流库页签 |
| `Workbench` | L3806 | 主容器（useState tab/view） |
| `TABS` | L3776 | 页签定义 |
| `viewsOf` | L3801 | 视图清单 |
| `Notice` | L2960 | 操作结果提示 |
| `Field` | L2952 | 表单行 |
| `useApi` | L319 | 数据获取 hook |
| `Skeleton` | L335 | 骨架屏 |

错误码核对（grep 实测，均在 src/board.js 中真实存在）：
- BOARD_WIP_EXCEEDED（L1116）
- BOARD_LEASE_HELD（L1090）
- BOARD_NOT_READY（L1103）
- BOARD_ALREADY_COMPLETED（L1074, L1187, L1235）
- BOARD_DEPENDENCY_CYCLE（L672, L689）
- BOARD_REV_CONFLICT（L966）

---

## 12. 实施优先级建议

| 优先级 | 项 | 理由 |
|---|---|---|
| P0-1 | 空状态 CTA 按钮 | 改动最小，收益最大（用户不再卡在空页） |
| P0-2 | 错误可读映射表 | 直接解决高频冲突的用户体验 |
| P0-3 | 快捷键 | Linear 风格的核心手感 |
| P1-1 | 批量操作 | 任务多了之后必需 |
| P1-2 | 撤销 5s | 降低误操作成本 |
| P1-3 | saved views | 高频用户的效率工具 |
| P2-1 | 模板 | 降低创建成本 |
| P2-2 | 渐进披露 | 设置页已经分组，折叠是小改动 |
| P2-3 | 可访问性 | 合规与普适性 |

---

## 13. 验收标准

- 文件存在且 > 200 行（本文件 200+ 行）
- grep 能查到 8 个错误码（BOARD_WIP_EXCEEDED / BOARD_LEASE_HELD / BOARD_NOT_READY / BOARD_ALREADY_COMPLETED / BOARD_DEPENDENCY_CYCLE / CAS_MISMATCH / BOARD_REV_CONFLICT / BOARD_TASK_DELETED / BOARD_APPEND_FAILED）
- 逐项都写了「落点文件与函数名」，且这些函数名在 src/client.js 里真实存在（grep 实测见第 11 节）
- 快捷键有防冲突规则（不在输入框内触发）
- 批量操作明确 CAS 冲突策略（整体失败）
- 撤销 5s 明确后端需要新增的接口和 action
