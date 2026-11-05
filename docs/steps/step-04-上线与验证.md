# Step 04 · 上线与线上验证（只认证据）

## 1. 部署动作（安装副本是真实拷贝，必须 rsync + 重启）
```bash
rsync -a --delete src/ ~/.dsh/profiles/web/node_modules/cs-bots/src/
cp -f package.json README.md ~/.dsh/profiles/web/node_modules/cs-bots/
rsync -a docs/ ~/.dsh/profiles/web/node_modules/cs-bots/docs/
diff -rq src <副本>/src   # → 无输出 = 一致
sudo systemd-run --unit=csbots-v3-restart --collect /bin/bash restart-verify-v3.sh
```
**为什么用 systemd-run 独立单元**：重启 dsh-web 会连带杀掉发起者的 cgroup，
脚本自身被清理、日志断在 restart 那一行（前两次踩过）。

重启实测：
```
旧 MainPID: 1059257
restart 返回: 0
就绪: 第 1 次探测 active=active
新 MainPID: 1156272  更换=YES
```

## 2. 线上验证结果（逐项，可复跑）

| 检查 | 结果 |
|---|---|
| 服务状态 | `active`，MainPID 已更换 |
| 域服务装配 | **12/12 就绪**：roster, board, dispatcher, room, memory, library, discipline, todo, scratch, prompts, suggest, reviewer |
| 鉴权围栏 | 无 cookie 的 `POST /fs/mkdir` → **401**，目录未创建 |
| 带会话访问 | `GET /status` → **200** |
| `POST /memory/purge` | 存在（空参返回 `MEMORY_MISSING_FIELD` 校验错误，不是 404） |
| `POST /todos/promote` | **200**，`task.subject=「V3-线上验证：写发布脚本」` |
| 页面加载的客户端 bundle | `HTTP=200`，**191,958 字节** |
| bundle 内页签结构 | 实测为 7 个页签 + `subs`，`id:'todos'` 顶层页签 **0 处** |
| 新 UI 关键字 | 协作看板 / 我的待办 / 事实与偏好 / 纪律与要求 / csb-subtabs / 派下去 / 来源目录 / 分类管理 / 记忆自审 —— 全部命中 |

> 客户端 bundle 地址形如 `/plugins/??cs-bots/client.js&rev=<hash>`；
> 重启后 `rev` 变化，浏览器刷新即拿到新版（不需要清缓存）。

## 3. 测试数据已清理
线上验证产生的待办（`td-58b2af70`）与任务（`t-20`）均已删除，未留残留。

## 4. 全量测试
```
bash test/run-all.sh  → 656 tests / 656 pass / 0 fail
bash test/ci-zero-dep.sh → CI PASS（5 项机械检查）
```
