# cs-bots 改造03 · 接口契约（冻结）

> 日期：2026-11-06（Asia/Shanghai）
> 状态：**冻结**。后端按本文件实现，前端按本文件调用；**不得改动路径与字段名**。
> 铁律不变：零第三方依赖、kernel.js 单点、写操作回显失败原因、CAS 冲突必抛。

## 0. 写作范围（防冲突）

| 角色 | 可写文件 |
|---|---|
| 后端工程师 | `src/api.js`、`test/api-artifacts.test.mjs`（新建）、`test/api-data.test.mjs`（新建） |
| 前端工程师 | `src/client.js`、`test/client.test.mjs`（仅在追加断言时） |
| 文档工程师 | `docs/操作手册-v1.md`（新建）、`docs/ARCHITECTURE.md`（追加章节） |

**任何人不得修改** `src/board.js` / `src/room.js` / `src/store.js` / `src/index.js` / `src/kernel.js`。
若后端认为必须改域层，**停下来在汇报里说明**，不要直接改。

---

## 1. 成果（Artifacts）聚合 —— `GET /cs-bots/api/artifacts`

### 用途
把散落在任务上的 `artifacts`（产出物证据）聚合成一个可浏览的「成果库」，
支持按任务 / 负责人 / 状态 / 关键词筛选，并可下钻到原任务详情。

### 入参（query）
| 参数 | 类型 | 说明 |
|---|---|---|
| `q` | string | 关键词，在 `artifacts` 字符串与 `subject` 中做大小写不敏感子串匹配 |
| `ownerId` | string | 按 `task.ownerId` 精确过滤 |
| `status` | string | 按任务状态过滤（`pending\|in_progress\|completed\|blocked`） |
| `limit` | number | 缺省 200，上限 1000 |

### 出参
```json
{
  "ok": true,
  "artifacts": [
    {
      "taskId": "t-12",
      "subject": "实现登录接口",
      "status": "completed",
      "ownerId": "bot-xxx",
      "accepted": true,
      "completedAt": 1793900000000,
      "items": ["src/api.js", "test/login.test.mjs"]
    }
  ],
  "stats": { "tasks": 3, "items": 7 },
  "note": "已扫描 N 个任务"
}
```
- `items`：把 `task.artifacts` 归一成字符串数组；对象元素用 `JSON.stringify` 单行表示。
- 只返回 `items.length > 0` 的任务；按 `completedAt` 降序，无 `completedAt` 用 `createdAt` 兜底。
- **不新增域层函数**：只用 `board.list({})` + 内存过滤。
- 域服务缺失 → 走既有 `withService` 的 503 语义。

---

## 2. 数据浏览（只读）—— `GET /cs-bots/api/data/files` 与 `GET /cs-bots/api/data/rows`

### 背景
用户明确要「能看到数据库」。cs-bots 的存储是 **JSONL 事件流 + JSON 快照**（零依赖铁律下不引入 SQLite）。
因此提供**只读浏览层**：列文件、看行、按文件名过滤。**绝不提供写接口**。

### 2.1 `GET /cs-bots/api/data/files`
```json
{
  "ok": true,
  "stateDir": "/home/ubuntu/.dsh/cs-bots",
  "files": [
    { "name": "board.jsonl", "bytes": 20135, "lines": 44, "mtime": 1793900000000, "kind": "jsonl" },
    { "name": "board.snap.json", "bytes": 7886, "lines": 1, "mtime": 1793900000000, "kind": "json" }
  ],
  "note": "只读浏览；写请走域服务与 CAS"
}
```
- 只扫描 `stateDir` **直属**文件（不递归），扩展名限 `.jsonl` / `.json`。
- `lines` 只对 `.jsonl` 计算（逐行数）；`.json` 恒为 0。
- 单文件 > 8MB 时 `lines` 返回 `null`（避免卡死），并在该条目上给 `"truncated": true`。
- 文件不存在 / 目录不可读 → `{ "ok": true, "files": [], "note": "..." }`（不 500）。

### 2.2 `GET /cs-bots/api/data/rows`
入参：
| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | string | **必填**，必须是 `files` 里出现过的文件名（防目录穿越，见下） |
| `limit` | number | 缺省 50，上限 200 |
| `offset` | number | 缺省 0 |
| `dir` | string | 可选，子目录名（如 `rooms`、`scratch`），**只允许单段、无 `..`** |

出参：
```json
{
  "ok": true,
  "name": "board.jsonl",
  "total": 44,
  "offset": 0,
  "rows": [ { "_line": 1, "_raw": "{\"type\":...}" } ],
  "note": "共 44 行，显示 1-50"
}
```
- `_raw` 是原始行文本（截断到 4000 字符，超出给 `_truncated: true`）。
- **安全**：`name` 与 `dir` 必须通过白名单校验——
  `name` 必须匹配 `^[A-Za-z0-9._-]+$` 且不得含 `..`；
  `dir` 必须匹配 `^[A-Za-z0-9._-]+$` 且不得含 `..`、不得为空。
  校验失败 → **400 + `{ ok:false, reason:"非法文件名" }`**（绝不读任意路径）。
- 解析 JSON 失败的行照样返回 `_raw`，并给 `"_parseError": true`（不整页 500）。

---

## 3. 任务依赖图 —— `GET /cs-bots/api/tasks/graph`

### 用途
前端画「主任务流程进度」：任务节点 + `blockedBy` 边。

### 入参
| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | string | 可选。给了就返回该任务的**传递闭包**（上游 `blockedBy` 递归 + 下游 dependents） |

### 出参
```json
{
  "ok": true,
  "nodes": [
    { "id": "t-1", "subject": "A", "status": "completed", "ownerId": "bot-1", "progress": 100, "priority": 5 }
  ],
  "edges": [ { "from": "t-2", "to": "t-1", "kind": "blockedBy" } ],
  "note": "节点 2 个，边 1 条"
}
```
- `edges.from` 依赖 `edges.to`（`from` 的 `blockedBy` 含 `to`）。
- 无 `id` 时返回全量图（`status !== 'deleted'`）；有 `id` 时返回闭包。
- 闭包只走**已存在**的任务节点；悬空依赖忽略并计入 `note`（不抛）。

---

## 4. 房间历史分页 —— **复用既有端点，不改后端**

`GET /rooms/messages` 已支持 `sinceSeq` / `limit` / `withBody`。
前端「看更早」用 `before` 语义时，改法：前端一次取全量（现状），
新增「加载更早」按钮通过 `sinceSeq` 递增拉取并**前置插入**。

> **因此：房间分页不改 `src/api.js`**，只改 `src/client.js`。
> 若后端认为需要 `beforeSeq`（反向分页）端点，**不要加**，前端用 `sinceSeq` 即可。

---

## 5. 前端验收清单（自查用）

1. 任务页：Kanban / 列表 双视图可切换；列 = 待办/进行中/已完成/已终止；卡片显示负责人、进度、优先级。
2. 任务页筛选：状态 + 负责人下拉 + 关键词（本地过滤）。
3. 任务详情：进度可**编辑**（0-100，走 `POST /tasks/update` `action:'edit'` + `progress`）；
   展示依赖链（调用 `/tasks/graph?id=`）；展示成果（`artifacts`）。
4. 成果页签：「成果」新页签，调用 `/artifacts`，空态有 CTA。
5. 数据页签：「数据」新页签，左列文件，右列行，调用 `/data/files` + `/data/rows`。
6. 房间：历史「加载更早」按钮；消息支持 `@名字` 高亮；发送时若正文含 `@X` 给出提示（不发额外请求）。
7. 全部新组件在域服务缺失（503）时显示可读错误，不白屏。

---

## 6. 交付门禁

- `bash test/run-all.sh` → exit 0，且测试数 **只增不减**。
- `bash test/ci-zero-dep.sh` → exit 0（禁第三方依赖）。
- 新增文件必须在 `vim -c` 之外的常规编辑器下为合法 UTF-8，且 `node --check` 通过。