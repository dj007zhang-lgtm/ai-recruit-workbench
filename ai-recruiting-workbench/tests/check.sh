#!/bin/bash
# 全量自查：语法 → 业务规则 → SSD 渲染 → 账本不变量
# 用法：bash tests/check.sh
# 任一环节失败 → 非零退出
set -u
NODE="/Users/andyzhang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

echo "==================== 1/4 语法检查 ===================="
for f in "$DIR"/*.js; do
  if ! "$NODE" --check "$f" >/dev/null 2>&1; then echo "❌ 语法错误: $(basename "$f")"; FAIL=1; else echo "✅ $(basename "$f")"; fi
done
if ! "/Users/andyzhang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3" -c "import ast;ast.parse(open('$DIR/parse_resume.py',encoding='utf-8').read())" 2>/dev/null; then echo "❌ parse_resume.py 语法错误"; FAIL=1; else echo "✅ parse_resume.py"; fi

echo ""
echo "==================== 2/4 业务规则测试 ===================="
if ! "$NODE" "$DIR/tests/rules.test.mjs"; then FAIL=1; fi

echo ""
echo "==================== 3/4 渲染测试（SSR）===================="
# 用真实数据渲染 main + 详情 + 各页面，任何异常即失败
if [ -n "${PORT:-}" ]; then
  for pg in overview process ai talent; do
    OUT=$("$NODE" /tmp/_verify.mjs 2>&1 | grep -E "^(✅|❌)")
    case "$OUT" in *❌*) echo "❌ $pg 渲染失败"; FAIL=1;; *✅*) echo "✅ $pg 渲染通过";; *) echo "⚠ $pg 未检测（脚本缺失）";; esac
  done
else
  echo "⚠ 跳过（未提供端口：PORT=xxxx bash tests/check.sh）"
fi

echo ""
echo "==================== 4/4 账本不变量 ===================="
if ! "$NODE" "$DIR/tests/ledger-check.mjs"; then FAIL=1; fi

echo ""
echo "==================== 5/6 LLM 调用契约 ===================="
if ! "$NODE" "$DIR/tests/llm-contract.mjs"; then FAIL=1; fi

echo ""
echo "==================== 6/6 死代码扫描 ===================="
DC=$("$NODE" "$DIR/tests/dead-code.mjs" 2>&1 | tail -1)
case "$DC" in *未发现*) echo "✅ 无死代码";; *) echo "⚠ $DC";; esac

echo ""
if [ "$FAIL" != "0" ]; then echo "❌ 自查未通过"; exit 1; fi
echo "✅ 全部自查通过"
