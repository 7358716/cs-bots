# Step 03 · 架构资料成文

产出：
- `docs/ARCHITECTURE.md`（245 行）——唯一架构真相源：四层结构、三条原则、12 域服务、
  7 页签 IA、权限、实现模式、数据布局、实测数字、开发验收
- `docs/adr/ADR-001-页签结构回到七页.md`——页签收敛的决策记录（背景/分析/决策/后果）
- `docs/steps/step-01..03`——每步存档，避免重复劳动

实测数字（写入文档，均可复核）：
| 指标 | 值 | 复核命令 |
|---|---|---|
| HTTP 端点 | 93 | `grep -oE "path === '[^']+'" src/api.js \| sort -u \| wc -l` |
| 模型工具 | 27 | `grep -cE "    name: 'bot_" src/tools.js` |
| 域服务 | 12 | `GET /cs-bots/api/status` → `services` |
| 源文件 | 24 / 24,736 行 | `wc -l src/*.js` |
| 测试 | 30 文件 / 656 用例全绿 | `bash test/run-all.sh` |
