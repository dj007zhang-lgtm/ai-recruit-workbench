#!/bin/bash
# 新项目安全初始化（一键固化最佳实践）
#
# 用途：给任何新项目加装「防敏感数据入库」的四层防护 + GitHub 同步准备。
# 用法：bash /path/to/scripts/init-project-guard.sh [项目目录]
#
# 做的事：
#   1. 生成/追加 .gitignore（含数据目录、凭证、依赖、大文件规则）
#   2. 安装 git hooks（pre-commit 拦截单次提交、pre-push 检查推送范围）
#   3. 生成 scripts/pre-push-check.sh（六项自动检查）
#   4. 创建数据目录占位（data/.gitkeep + README 说明）
#   5. 配置 SSH remote（若提供仓库地址）
set -u

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok() { echo -e "${GREEN}✅ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠  $*${NC}"; }
err() { echo -e "${RED}❌ $*${NC}"; }

DIR="${1:-$(pwd)}"
cd "$DIR" || { err "目录不存在: $DIR"; exit 1; }
echo "===== 初始化项目防护：$DIR ====="
echo ""

# ---------- 1. git 仓库 ----------
if [ ! -d .git ]; then
  git init -q && ok "已初始化 git 仓库"
else
  ok "git 仓库已存在"
fi

# ---------- 2. .gitignore ----------
GI_ADDED=0
append_gi() {
  grep -qF "$1" .gitignore 2>/dev/null || { echo "$1" >> .gitignore; GI_ADDED=$((GI_ADDED+1)); }
}
touch .gitignore
cat > /tmp/_gi_header <<'EOF'
# ===== 密钥与环境 =====
.env
.env.*
!.env.example
*.key
*.pem
*.p12
*.pfx

# ===== 依赖与构建 =====
node_modules/
dist/
build/
.next/
__pycache__/
*.py[cod]
.venv/
venv/
*.egg-info/
.pytest_cache/

# ===== 数据目录（禁止入库）=====
data/*
!data/.gitkeep
!data/README.md
datasets/
uploads/
resumes/
candidates/
exports/
secrets/

# ===== 数据文件类型（禁止入库）=====
*.csv
*.jsonl
*.db
*.sqlite3
*.pdf
*.docx

# ===== 系统与编辑器 =====
.DS_Store
.idea/
.vscode/
*.log
EOF
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  append_gi "$line"
done < /tmp/_gi_header
rm -f /tmp/_gi_header
[ "$GI_ADDED" -gt 0 ] && ok ".gitignore 补充 $GI_ADDED 条规则" || ok ".gitignore 已完备"

# ---------- 3. hooks ----------
mkdir -p scripts/hooks
if [ ! -f scripts/hooks/pre-commit ]; then
  cat > scripts/hooks/pre-commit <<'HOOK'
#!/bin/sh
# 提交前拦截：数据文件 / 个人信息 / 大文件
export LC_ALL=C
PAT='1[3-9][0-9]{9}|[0-9]{17}[0-9Xx]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
FILES=$(git diff --cached --name-only --diff-filter=ACM -- 2>/dev/null)
BAD=$(printf '%s\n' "$FILES" | grep -vE '(^|/)data/(\.gitkeep|README\.md)$' | grep -Ei '\.(pdf|docx|doc|xlsx|xls|csv|db|sqlite3?|jsonl)$|(^|/)(data|uploads|resumes|candidates|datasets|exports|secrets)/')
[ -n "$BAD" ] && { echo "禁止提交疑似数据文件："; echo "$BAD"; exit 1; }
for f in $FILES; do
  case "$f" in */tests/*|*/vendor/*|*example*) continue ;; esac
  [ -f "$f" ] || continue
  H=$(git show ":$f" 2>/dev/null | grep -avEi 'example\.(com|org)|@demo\.|@test\.' | grep -acEi "$PAT" 2>/dev/null)
  [ "${H:-0}" -gt 0 ] && { echo "检测到疑似个人信息：$f"; exit 1; }
done
BIG=$(printf '%s\n' "$FILES" | while read -r f; do [ -f "$f" ] && du -m "$f" 2>/dev/null; done | awk '$1>10{print}')
[ -n "$BIG" ] && { echo "存在 >10MB 文件："; echo "$BIG"; exit 1; }
exit 0
HOOK
  chmod +x scripts/hooks/pre-commit
  ok "pre-commit 钩子已安装"
else
  ok "pre-commit 钩子已存在"
fi

if [ ! -f scripts/hooks/pre-push ]; then
  cat > scripts/hooks/pre-push <<'HOOK'
#!/bin/sh
ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$ROOT" ] && exit 0
[ -x "$ROOT/scripts/pre-push-check.sh" ] && { bash "$ROOT/scripts/pre-push-check.sh" || exit 1; }
exit 0
HOOK
  chmod +x scripts/hooks/pre-push
  ok "pre-push 钩子已安装"
else
  ok "pre-push 钩子已存在"
fi
git config core.hooksPath scripts/hooks && ok "hooksPath → scripts/hooks"

# ---------- 4. 数据目录占位 ----------
mkdir -p data
[ -f data/.gitkeep ] || { touch data/.gitkeep; ok "data/.gitkeep 已创建"; }
if [ ! -f data/README.md ]; then
  cat > data/README.md <<'MD'
# data/ 目录说明

本目录存放业务数据，**禁止入库**（已在 `.gitignore` 中忽略）。

- 代码通过环境变量 `DATA_DIR` 读取该目录
- 新环境请用假数据演示，切勿放入真实客户/候选人信息
MD
  ok "data/README.md 已创建"
fi

# ---------- 5. pre-push-check（从本脚本同目录复制）----------
SRC_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-push-check.sh"
if [ -f "$SRC_CHECK" ] && [ ! -f scripts/pre-push-check.sh ]; then
  cp "$SRC_CHECK" scripts/pre-push-check.sh && chmod +x scripts/pre-push-check.sh
  ok "pre-push-check.sh 已复制"
elif [ -f scripts/pre-push-check.sh ]; then
  ok "pre-push-check.sh 已存在"
else
  warn "未找到源 pre-push-check.sh，请手动复制"
fi

echo ""
echo "===== 完成 ====="
echo "下一步："
echo "  1. git add -A && git commit -m 'init'"
echo "  2. 配置 SSH remote：git remote add origin git@github.com:<user>/<repo>.git"
echo "  3. git push -u origin main（pre-push 会自动检查）"
