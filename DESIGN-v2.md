# cs-bots v2 设计规格（五大人性化功能）

> 本文是**契约**：Lead 依据本文写 `src/api.js` + `src/client.js`；
> 各域模块负责人严格按本文签名实现，**不得改动签名**（改了 API 层就崩）。
> 所有模块遵守 cs-bots 铁律：零第三方依赖、只 import node 内置 + 本仓模块、
> 写操作必须回显失败原因（不静默）、CAS(rev) 冲突必须抛错。

## 通用约定

- 错误类：各模块自己的 `XxxError`，带 `code`（大写下划线）与 `detail`。
- 持久化：`statePath(stateDir, 'xxx.jsonl')` 追加事件 + `xxx.snap.json` 快照，与 board.js 同款。
- 时间：`now` 参数可注入（测试用），缺省 `Date.now()`。
- 每条记录必须有 `id` / `rev` / `createdAt` / `createdBy` / `updatedAt` / `updatedBy`。

---

## 特性 ①：房间超级管理员（`src/room.js`）

### 房间模型新增字段
```js
{
  ...原有: id, name, members[], mode, adminId, notice, cwd, rev, createdAt
  purpose: string,        // 房间用途/话题（新）
  roles: { [sessionId]: 'admin'|'member'|'observer' },  // 成员角色（新）
  settings: {             // 房间级开关（新）
    allowBotAutoPost: boolean,   // 是否允许 Bot 自主发言（缺省 true）
    maxBotsPerRound: number,     // 单轮最多几个 Bot 发言（缺省 3）
    relayEnabled: boolean,       // 是否允许 relay 中继（缺省 true）
  },
  archivedAt: number|null,       // 归档时间（新）
}
```

### 新增/扩展函数（签名固定）
```js
// 扩展 update()：除现有 name/notice/mode/adminId 外，新增可改 purpose/settings
update({ roomId, name?, notice?, mode?, adminId?, purpose?, settings?, expectedRev, byId, now })

// 归档（软删）：archived 房间缺省不出现在 list()
archiveRoom({ roomId, expectedRev, byId, now })    // → Room(archivedAt=now)
unarchiveRoom({ roomId, expectedRev, byId, now })  // → Room(archivedAt=null)

// 硬删除：仅当 owner 且 force 或 无消息时允许
removeRoom({ roomId, expectedRev, byId, force, now }) // → { removed: roomId, messages }

// 成员角色（super admin 专用）
setMemberRole({ roomId, sessionId, role, byId, now })  // role 见上 → Room
kickMember({ roomId, sessionId, byId, now })           // 不能踢 USER → Room

// list() 扩展：includeArchived=true 时含归档房
list({ includeArchived } = {})   // 缺省 false

// 超级管理员读全部消息（含 bodyRef 全文内联，便于页面直接看，不用二次请求）
listMessages({ roomId, limit, sinceSeq, withBody })  // withBody=true → 每条加 body 字段(全文)
```
权限：`byId === 'user'`（USER 常量）视为超级管理员，可做任何操作；
非 USER 仍按原规则（admin 模式看 adminId、everyone 模式看成员资格）。

### 测试要求
`test/room-admin.test.mjs`：归档/恢复/硬删/角色/踢人/withBody/超级管理员放行/普通成员被拒。

---

## 特性 ②：分级纪律体系（**新文件** `src/discipline.js`）

### 概念
- **层级（scope）**：`global`（全局）→ `workspace`（工作区，按 cwd）→ `room`（房间）→ `bot`（单个 Bot）
  继承顺序：global 先、越具体越靠后（后出现的更具体，冲突时具体优先）。
- **分类（kind）**：`rule`（纪律/硬规矩）、`requirement`（要求/交付标准）、`principle`（原则/价值观）、`style`（风格/说话方式）。
- **优先级**：`priority` 数字越大越靠前（缺省 0）。

### 模型
```js
{
  id: 'd-xxxx', rev: 1,
  scope: 'global'|'workspace'|'room'|'bot',
  scopeId: null | cwd 绝对路径 | roomId | botId,
  kind: 'rule'|'requirement'|'principle'|'style',
  title: string,          // 短标题（≤120）
  content: string,        // 正文（≤4000）
  priority: number,
  enabled: boolean,       // 缺省 true
  createdAt, createdBy, updatedAt, updatedBy,
}
```

### 函数（签名固定）
```js
createDiscipline({ scope, scopeId, kind, title, content, priority, enabled, by, now })
updateDiscipline({ id, expectedRev, title?, content?, kind?, priority?, enabled?, by, now })
removeDiscipline({ id, expectedRev, by })            // → { removed: id }
getDiscipline(id)
listDisciplines({ scope?, scopeId?, kind?, enabled?, query? })   // → 数组
importDisciplines({ items, by, mode='skip'|'overwrite' })        // → { created[], updated[], skipped[], errors[] }

// 核心：沿层级合并生效纪律
resolveDisciplines({ botId?, cwd?, roomId? })
// → { items: [...], text: string, byScope: {global:n,...}, truncated: boolean, dropped: number }

// 注入用：带 token 预算（4 字符/token 粗算，与 memory.estimateTokens 同口径）
renderDisciplinePrompt({ botId, cwd, roomId, tokenBudget })
// → { text, items, truncated, dropped, tokens }

stats() / replay() / dispose() / history(id?)
```
`resolveDisciplines` 合并规则：
1. 收集 global（scopeId 为 null）→ workspace(cwd 匹配) → room(roomId 匹配) → bot(botId 匹配)；
2. 只要 `enabled !== false`；
3. 按 `priority` 降序，再按 scope 具体度（bot>room>workspace>global）降序；
4. 同 `title` 的只保留最具体那条（去重），丢弃计入 `dropped`；
5. `text` 渲染成分节 markdown：`## 纪律` / `## 要求` / `## 原则` / `## 风格`；
6. tokenBudget 超出 → 从低优先级丢，`truncated=true` 且 text 末尾加 `⚠️ 已省略 N 条（超出预算）`。

### 测试要求
`test/discipline.test.mjs`：CRUD、CAS 冲突、层级合并顺序、同名去重、预算裁剪、import 去重、replay 恢复。

---

## 特性 ③：Bot 档案增强（`src/botprofile.js` + `src/roster.js`）

### profile 模型扩展（保持向后兼容，旧字段不变）
```js
{
  identity, experience, skills[], workflows[], memory[],   // 原有
  title: string,        // 岗位/角色名，如「后端负责人」（新，≤120）
  persona: string,      // 人格设定（说话风格、性格）（新，≤2000）
  boundaries: string,   // 禁止事项/红线（新，≤2000）
  disciplineIds: [],    // 关联的纪律条目 id（新）
}
```
`LIMITS` 增加 `title:120, persona:2000, boundaries:2000, disciplineIds:50`。

### 函数（签名固定）
```js
// botprofile.js
normalizeProfile(input)              // 扩展支持新字段，未知字段仍拒绝
renderManagedSection(profile)        // 扩展渲染新字段（title/persona/boundaries）
importMemoryToProfile({ existing, entries, dedup=true })
// → { memory: string[], added: number, skipped: number }  纯函数，不写盘

// roster.js
getProfile(id)                       // 已修好，保持
setProfile({ id, profile, byId, expectedRev?, now })   // 已存在；确保新字段透传并写 AGENTS.md
addProfileMemory({ id, entries, dedup, byId, expectedRev })  // → { bot, added, skipped }
linkSkills({ id, skills, byId, expectedRev })        // → bot（写入 bot.profile.skills 并落 skill 文件）
```

### 测试要求
`test/profile-rich.test.mjs`：新字段校验/超长拒绝、AGENTS.md 渲染含新字段、
importMemoryToProfile 去重、addProfileMemory 落盘、linkSkills 同步。

---

## 特性 ④：记忆完整增删改查（**无需改 memory.js 领域层**，缺的是 API/UI）

领域层已有 `add/get/list/update/remove/archive/restore/search/contextFor`。
只需：
- API 增加 `GET /memory/detail?id=..&layer=..`（返回单条全文 + 版本历史）
- API 的 `/memory/update` 支持改 `content`/`tags`/`layer`/`explicit`
- 客户端 MemoryTab 增加：查看全文、编辑、永久删除、归档区切换

**Lead 负责，不起域改动。**

---

## 特性 ⑤：技能导入（`src/library.js`）

### 函数（签名固定）
```js
// 解析 SKILL.md（--- frontmatter + 正文）
parseSkillMarkdown({ text, filename })
// → { name, description, body, tags }  解析失败抛 LIB_BAD_SKILL_MD

// 批量导入（去重）
importSkills({ items, by, mode='skip'|'overwrite'|'rename', now })
// → { created: [], updated: [], skipped: [], errors: [{name, reason}] }

// 从目录扫描（.agents/skills/<name>/SKILL.md）
scanSkillsDir({ dir })
// → { items: [...], errors: [...] }   纯读取，不写库

// 导出（便于备份/迁移）
exportSkills({ ids })
// → { markdown: string, count: number }
```
规则：
- `name` 必须 kebab-case；非法 → 进 `errors`，不中断整批。
- 同名已存在：`skip` 跳过 / `overwrite` 覆盖（rev+1）/ `rename` 加 `-2` 后缀。
- 单条 body ≤ `LIMITS.skillBody`（20000）。

### 测试要求
`test/library-import.test.mjs`：frontmatter 解析（有/无/坏）、三种 mode、非法名、
批量部分失败不中断、exportSkills 往返、scanSkillsDir 读真实目录。

---

## 分工与写入范围（**不得越界**）

| 角色 | 写入范围 |
|---|---|
| Lead | `src/api.js`、`src/client.js`、`src/index.js`、`src/tools.js`、`src/fence.js`(新)、`test/api.test.mjs` |
| room-admin | `src/room.js`、`test/room-admin.test.mjs` |
| discipline | `src/discipline.js`(新)、`test/discipline.test.mjs` |
| skill-import | `src/library.js`、`test/library-import.test.mjs` |
| bot-profile | `src/botprofile.js`、`src/roster.js`、`test/profile-rich.test.mjs` |

**共享文件只有 Lead 能改。** 各域负责人不得编辑 `api.js` / `client.js`。
新增测试文件必须能被 `test/run-all.sh` 自动发现（沿用现有 glob 规则）。
