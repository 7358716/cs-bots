#!/usr/bin/env bash
# cs-bots 单入口回归 —— 一次跑完「零依赖 CI + 全部单测」，任一失败退出码非 0。
#
# 用法：bash test/run-all.sh
#
# 为什么单入口：交付验收只认**这一个退出码**，避免「跑了一半就说通过」。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail=0

echo "════════ 1. 零依赖 CI ════════"
if bash test/ci-zero-dep.sh; then
  echo "  ✅ CI PASS"
else
  echo "  ❌ CI FAIL"
  fail=1
fi

echo
echo "════════ 2. 单元测试 ════════"
# Node 22 的 --test 不接受目录，需显式列文件。
if node --test test/*.test.mjs; then
  echo "  ✅ 单测通过"
else
  echo "  ❌ 单测失败"
  fail=1
fi

echo
echo "════════ 汇总 ════════"
if [ "$fail" -eq 0 ]; then
  echo "✅ 全部通过（exit 0）"
  exit 0
fi
echo "❌ 有失败（exit 1）"
exit 1
