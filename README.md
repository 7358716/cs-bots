# cs-bots

cs-bots 是 DSH 的多智能体协作平台插件骨架，含宿主半身（`src/index.js`）与 Web 客户端半身（`src/client.js`）。

骨架零运行时依赖：不 import 任何 `@deepseek-ai/*` 包，`dependencies` 为空，CI 由 `test/ci-zero-dep.sh` 守卫。

安装（web profile）：

```bash
dsh plugin --profile web add github:7358716/cs-bots#v0.1.0
```
