#!/usr/bin/env bash
# cs-bots 零依赖 CI 检查：任一失败，退出码非 0
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail=0

echo "== 检查 1：src/ 下除 kernel.js 外的 .js 不得 import @deepseek-ai/ =="
hits=0
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  if [ "$base" = "kernel.js" ]; then
    continue
  fi
  if grep -qF '@deepseek-ai/' "$f"; then
    echo "  违规: $f"
    grep -nF '@deepseek-ai/' "$f"
    hits=$((hits + 1))
  fi
done < <(find src -type f -name '*.js' -print0)
if [ "$hits" -eq 0 ]; then
  echo "  OK: 未发现 @deepseek-ai/ 引用"
else
  echo "  失败: $hits 个文件违规"
  fail=1
fi

echo "== 检查 2：package.json 的 dependencies 不存在或为空对象 =="
deps="$(python3 -c 'import json;d=json.load(open("package.json",encoding="utf-8")).get("dependencies");print("MISSING" if d is None else ("EMPTY" if len(d)==0 else "NONEMPTY:"+",".join(sorted(d))))')" || deps="ERROR"
case "$deps" in
  MISSING|EMPTY)
    echo "  OK: dependencies $deps"
    ;;
  *)
    echo "  失败: dependencies $deps"
    fail=1
    ;;
esac

echo "== 检查 3：cordis.patch.yml 每个 name 只能是 'cs-bots' 或以 @deepseek-ai/ 开头 =="
names="$(grep -E '^[[:space:]]*name:' cordis.patch.yml | sed -E "s/^[[:space:]]*name:[[:space:]]*//; s/^['\"]//; s/['\"]\$//")"
if [ -z "$names" ]; then
  echo "  失败: 未解析到任何 name: 行"
  fail=1
else
  bad=0
  while IFS= read -r n; do
    [ -z "$n" ] && continue
    if [ "$n" = "cs-bots" ] || [ "${n#@deepseek-ai/}" != "$n" ]; then
      echo "  OK: name=$n"
    else
      echo "  违规: name=$n"
      bad=$((bad + 1))
    fi
  done <<< "$names"
  if [ "$bad" -ne 0 ]; then
    echo "  失败: $bad 个非法 name"
    fail=1
  fi
fi

echo "== 结果 =="
if [ "$fail" -eq 0 ]; then
  echo "CI PASS"
  exit 0
fi
echo "CI FAIL"
exit 1
