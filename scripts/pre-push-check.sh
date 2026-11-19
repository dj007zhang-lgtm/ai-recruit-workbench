#!/bin/bash
# 推送前安全检查（通用模板，任何项目可直接复用）
#
# 存在理由：候选人/客户等敏感数据一旦进 Git 历史就极难清除（要改写历史 + force push）。
# 人工检查靠不住（这次真实踩过：差点把 15 份简历原件推上公开仓库）。
# 本脚本在 push 前自动拦截，不通过就禁止推送。
#
# 用法：
#   bash scripts/pre-push-check.sh          # 检查已提交内容
#   bash scripts/pre-push-check.sh --staged # 检查暂存区
#
# 退出码：0 通过 / 1 有问题
set -u

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
FAIL=0
bad() { echo -e "${RED}❌ $*${NC}"; FAIL=1; }
warn() { echo -e "${YELLOW}⚠  $*${NC}"; }
good() { echo -e "${GREEN}✅ $*${NC}"; }

MODE="${1:-}"
if [ "$MODE" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)
  SCOPE=staged
else
  # 检查「将被推送」的全部文件（远程没有的）
  UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "")
  if [ -n "$UPSTREAM" ]; then
    FILES=$(git diff --name-only "$UPSTREAM"..HEAD 2>/dev/null)
  else
    FILES=$(git ls-files 2>/dev/null)
  fi
  SCOPE=pending
fi

echo "===== 推送前安全检查（${SCOPE}）====="
echo ""

# ---------- 1. 敏感文件类型 ----------
echo "[1/6] 敏感文件类型"
HITS=$(printf '%s\n' "$FILES" | grep -Ei '\.(pdf|docx|doc|xlsx|xls|csv|db|sqlite3?|jsonl|pem|key|p12|pfx)$' 2>/dev/null)
if [ -n "$HITS" ]; then
  bad "发现数据/证书类文件（不应入库）："
  echo "$HITS" | head -10 | sed 's/^/     /'
else
  good "无数据/证书类文件"
fi

# ---------- 2. 敏感目录 ----------
echo "[2/6] 敏感目录"
HITS=$(printf '%s\n' "$FILES" | grep -Ei '(^|/)(data|uploads|resumes|candidates|datasets|recruiting|exports|secrets)/' 2>/dev/null | grep -vE '(^|/)data/(\.gitkeep|README\.md)$')
if [ -n "$HITS" ]; then
  bad "发现数据目录文件（应被 .gitignore 排除）："
  echo "$HITS" | head -10 | sed 's/^/     /'
else
  good "无数据目录文件"
fi

# ---------- 3. 本机绝对路径（换机器会崩）----------
echo "[3/6] 本机绝对路径"
HOME_PAT=$(printf '%s' "$HOME" | sed 's/[.[\*^$]/\\&/g')
HITS=$(printf '%s\n' "$FILES" | grep -vE '(\.gitignore|pre-push-check\.sh|pre-commit)$' | while read -r f; do
  [ -f "$f" ] || continue
  grep -l "$HOME_PAT" "$f" 2>/dev/null
done)
if [ -n "$HITS" ]; then
  warn "以下文件含本机路径 ${HOME}（他人克隆后可能失效）："
  echo "$HITS" | head -5 | sed 's/^/     /'
  warn "建议改为环境变量或自动探测（非阻断）"
else
  good "无本机绝对路径"
fi

# ---------- 4. 凭证/密钥 ----------
echo "[4/6] 凭证与密钥"
HITS=$(printf '%s\n' "$FILES" | grep -vE '(example|\.md$)' | while read -r f; do
  [ -f "$f" ] || continue
  grep -lE '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY)' "$f" 2>/dev/null
done)
if [ -n "$HITS" ]; then
  bad "发现疑似凭证/私钥（禁止入库）："
  echo "$HITS" | head -5 | sed 's/^/     /'
else
  good "无凭证/私钥"
fi

# ---------- 5. 大文件 ----------
echo "[5/6] 大文件（>5MB）"
HITS=$(printf '%s\n' "$FILES" | while read -r f; do
  [ -f "$f" ] || continue
  SZ=$(du -m "$f" 2>/dev/null | cut -f1)
  [ "${SZ:-0}" -gt 5 ] && echo "$SZ MB  $f"
done)
if [ -n "$HITS" ]; then
  warn "以下文件较大（考虑 Git LFS 或排除）："
  echo "$HITS" | head -5 | sed 's/^/     /'
else
  good "无大文件"
fi

# ---------- 6. .gitignore 有效性 ----------
echo "[6/6] .gitignore 覆盖检查"
if [ -f .gitignore ]; then
  MISSING=""
  for pat in ".env" "node_modules" "*.jsonl" "*.pdf" "*.docx" "data/" "recruiting/"; do
    grep -qF "$pat" .gitignore 2>/dev/null || MISSING="$MISSING $pat"
  done
  if [ -n "$MISSING" ]; then
    warn ".gitignore 缺少关键规则：$MISSING"
  else
    good ".gitignore 覆盖关键类型"
  fi
else
  bad "缺少 .gitignore（数据文件可能被误提交）"
fi

echo ""
if [ "$FAIL" -eq 1 ]; then
  echo -e "${RED}===== 检查未通过，禁止推送 =====${NC}"
  echo "修复后重试；如确认无风险需强制推送，请人工说明理由。"
  exit 1
fi
echo -e "${GREEN}===== 全部通过，可以推送 =====${NC}"
exit 0
