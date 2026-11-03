#!/usr/bin/env bash
# cs-bots 零依赖 CI 检查：任一失败，退出码非 0。
#
# 检查 1 的判定口径（重要）：只认**真实的模块引用**（import / require / 动态 import），
# 不认注释与字符串里的字面量 —— 因为文档化这条纪律本身是有价值的，
# 而「注释里写了 @deepseek-ai/ 就判违规」是假阳性（2026-11-01 实测踩到）。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail=0

echo "== 检查 1：src/ 下除 kernel.js 外的 .js 不得 import/require @deepseek-ai/ =="
violations="$(python3 - <<'PY'
import pathlib, re

# 去掉块注释与行注释，避免把注释里的说明文字误判为依赖。
BLOCK = re.compile(r'/\*.*?\*/', re.S)
LINE = re.compile(r'^\s*//.*$', re.M)

# 只匹配真实引用形态：import ... from '...' / import('...') / require('...')
REF = re.compile(r"""(?:\bimport\b[^;\n]*?\bfrom\b\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]""")

bad = []
for path in sorted(pathlib.Path('src').rglob('*.js')):
    if path.name == 'kernel.js':
        continue
    src = path.read_text(encoding='utf-8')
    src = BLOCK.sub(' ', src)
    src = LINE.sub('', src)
    for spec in REF.findall(src):
        if spec.startswith('@deepseek-ai/'):
            bad.append(f'{path}: {spec}')

print('\n'.join(bad))
PY
)"

if [ -z "$violations" ]; then
  echo "  OK: 未发现真实 @deepseek-ai/ 模块引用"
else
  echo "$violations" | sed 's/^/  违规: /'
  echo "  失败: $(printf '%s\n' "$violations" | grep -c .) 处违规"
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
PATCH_FILES="cordis.patch.yml"
[ -f cordis.patch.agent-team.yml ] && PATCH_FILES="$PATCH_FILES cordis.patch.agent-team.yml"
names=""
for pf in $PATCH_FILES; do
  names="$names$(grep -E '^[[:space:]]*name:' "$pf" | sed -E "s/^[[:space:]]*name:[[:space:]]*//; s/^['\"]//; s/['\"]\$//")
"
done
names="$(printf '%s' "$names" | grep -v '^$' || true)"
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

echo "== 检查 4：cordis.patch.yml 覆盖官方行时必须列全 config 字段 =="
# 依据（dsh-app-boot/lib/index.js 实测）：不带 insert 的顶层 id = 覆盖既有行，
# 且 config 是**整体覆盖**（逐 key），漏字段会触发 required 校验失败 → 整个 profile 起不来。
overlay="$(python3 - <<'PY'
import sys
try:
    import yaml
except ImportError:
    print('SKIP:pyyaml-missing')
    sys.exit(0)

docs = []
for _f in ('cordis.patch.yml', 'cordis.patch.agent-team.yml'):
    try:
        docs += (yaml.safe_load(open(_f, encoding='utf-8')) or [])
    except FileNotFoundError:
        pass
# 官方 agent-team 的必填 config 字段（dsh-experimental-agent-team/lib/index.js:1437-1445）
REQUIRED = {
    'agent-team': {'maxMembers', 'maxTasks', 'maxMessageBytes', 'disposalTimeoutMs'},
}
problems = []
for row in docs:
    if not isinstance(row, dict) or 'insert' in row:
        continue
    rid = row.get('id')
    need = REQUIRED.get(rid)
    if not need:
        continue
    got = set((row.get('config') or {}).keys())
    missing = need - got
    if missing:
        problems.append(f'{rid}: 缺字段 {sorted(missing)}')
print('\n'.join(problems))
PY
)"
case "$overlay" in
  SKIP:pyyaml-missing)
    echo "  SKIP: 无 pyyaml，跳过该检查"
    ;;
  '')
    echo "  OK: 覆盖行的 config 字段齐全"
    ;;
  *)
    echo "$overlay" | sed 's/^/  违规: /'
    fail=1
    ;;
esac


echo "== 检查 5：客户端禁止 window.prompt / window.confirm（沙箱里被静默屏蔽）=="
# 依据（2026-11-03 实测）：官方 DSH 客户端包全量 grep 0 处使用 prompt/confirm，
# 且存在 sandboxed 渲染路径 —— 在这些视图里两者被静默屏蔽（返回 null/false，不报错），
# 表现就是「按钮点了没反应」。所以必须机械禁止，全部改用内联表单与站内弹窗。
banned="$(grep -nE "window\.(prompt|confirm|alert)\(" src/client.js || true)"
if [ -z "$banned" ]; then
  echo "  OK: 客户端零 prompt/confirm/alert"
else
  echo "$banned" | sed 's/^/  违规: /'
  fail=1
fi

echo "== 结果 =="
if [ "$fail" -eq 0 ]; then
  echo "CI PASS"
  exit 0
fi
echo "CI FAIL"
exit 1
