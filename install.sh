#!/usr/bin/env bash
# cs-bots 安装器 —— 装 + **自检**（一条命令完成）。
#
# 为什么必须有自检（硬约束 E4'）：
#   `link:` 断链 / 版本错位 / bundle 未进 `dsh.profile.bundles` 时，DSH **只打一行
#   `skipping profile bundle` 就静默跳过** —— 页面照常 HTTP 200，功能全失效。
#   ⇒ 「页面能打开」不等于「插件装好了」。本脚本用 `--dump-config` 验证**装配树里真有我们的行**。
#
# 用法：
#   bash install.sh                      # 默认：npm 通道，profile=web
#   bash install.sh --channel git        # github:7358716/cs-bots#<ref>
#   bash install.sh --profile desktop    # 换 profile
#   bash install.sh --check-only         # 只自检，不安装
#   bash install.sh --ref v0.1.0         # 指定 git tag（默认 main）
#
# 退出码：0 = 安装且自检通过；1 = 安装失败；2 = 装了但**自检不通过**（最危险，必须显式暴露）
set -uo pipefail

PKG_NAME="cs-bots"
BUNDLE_ID="cs-bots"
REPO="7358716/cs-bots"

CHANNEL="npm"
PROFILE="web"
REF="main"
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

# ── 0. 前置检查 ──────────────────────────────────────────────────────────────
say "════════ cs-bots 安装器 ════════"
say "  通道    : $CHANNEL"
say "  profile : $PROFILE"
[ "$CHECK_ONLY" -eq 1 ] || say "  版本    : $REF"

command -v dsh >/dev/null 2>&1 || die "找不到 dsh 命令（请先装 DeepSeek Harness 并在 PATH 里）"

# ── 1. 安装 ──────────────────────────────────────────────────────────────────
if [ "$CHECK_ONLY" -eq 0 ]; then
  case "$CHANNEL" in
    npm)
      # 首选通道：npmmirror 稳定（实测 200）。dsh plugin 转发 pnpm。
      say ""
      say "▶ 安装（npm）..."
      if ! dsh plugin --profile "$PROFILE" add "$PKG_NAME"; then
        die "npm 安装失败。兜底：改用 --channel git（需 github.com 可达）或本地 tarball。"
      fi
      ;;
    git)
      # 次选：github.com **间歇可达**（实测曾 3/3 成功、也曾 0/5 超时）
      say ""
      say "▶ 安装（git: github:$REPO#$REF）..."
      if ! dsh plugin --profile "$PROFILE" add "github:$REPO#$REF"; then
        cat >&2 <<'EOF'
❌ git 通道失败。

   已知事实（本机实测）：github.com:443 **间歇不可达**（DNS 正常、TCP 超时），
   而 api.github.com / codeload.github.com 稳定；本机**无私钥**故 SSH 必失败。

   处置顺序：
     1) 重试一次（间歇性）
     2) 换 npm 通道：bash install.sh --channel npm
     3) 走 tarball：先下载再 add ./cs-bots-<ver>.tgz
EOF
        exit 1
      fi
      ;;
    *) die "未知通道: $CHANNEL（支持 npm | git）" ;;
  esac
fi

# ── 2. 自检（**这一步才是关键**）─────────────────────────────────────────────
say ""
say "▶ 自检：验证装配树里真有我们的行（不是只看页面能不能打开）..."

DUMP="$(dsh --profile "$PROFILE" --dump-config 2>/dev/null)"
if [ -z "$DUMP" ]; then
  say "⚠️  --dump-config 无输出 → 无法自检（DSH 版本过旧？）"
  say "    手工确认：dsh --profile $PROFILE --dump-config | grep -n '$BUNDLE_ID'"
  exit 2
fi

# 判据 1：我们的 bundle 行在装配树里
if printf '%s\n' "$DUMP" | grep -qE "id:[[:space:]]*$BUNDLE_ID\b"; then
  say "  ✅ bundle 行已进入装配树（id: $BUNDLE_ID）"
else
  say "  ❌ **装配树里没有 $BUNDLE_ID** —— 插件没真正挂上"
  say "     常见原因：只在 dependencies、没进 dsh.profile.bundles（DSH 会静默跳过）"
  exit 2
fi

# 判据 2：我们覆盖的 maxMembers 真的生效（P1 路径 A 的验收点）
MM="$(printf '%s\n' "$DUMP" | grep -A 12 "id:[[:space:]]*agent-team$" | grep -oE "maxMembers:[[:space:]]*[0-9]+" | head -1 | grep -oE '[0-9]+')"
if [ -n "$MM" ]; then
  if [ "$MM" -ge 32 ]; then
    say "  ✅ agent-team.maxMembers = $MM（P1 已生效，官方默认 16、本机曾压到 8）"
  else
    say "  ⚠️  agent-team.maxMembers = $MM（< 32）—— 覆盖未生效"
    say "     检查：本 bundle 是否排在 agent-team-profile **之后**（层序决定谁覆盖谁）"
  fi
else
  say "  ⚠️  未找到 agent-team 行 → 目标 profile 未启用实验性 Agent Teams"
  say "     平台将降级为「仅内建域服务」（符合缺服务不阻塞的纪律）"
fi

# 判据 3：状态目录可写（不然任务板/记忆全是内存态，重启即丢）
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
STATE_DIR="$DSH_HOME_DIR/$BUNDLE_ID"
if mkdir -p "$STATE_DIR" 2>/dev/null && [ -w "$STATE_DIR" ]; then
  say "  ✅ 状态目录可写：$STATE_DIR"
else
  say "  ❌ 状态目录不可写：$STATE_DIR（任务板/记忆无法落盘）"
  exit 2
fi

say ""
say "✅ 安装并自检通过。"
say "   下一步：重启 DSH 后，在会话里应能看到 bot_* 工具（bot_task_create 等）。"
say "   若看不到工具：检查 tools 服务是否可用（本平台缺它时只 warn 不崩）。"
exit 0
