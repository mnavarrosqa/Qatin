#!/bin/bash
# Pre-install / pre-deploy checklist for Qatin
# Run from the repo root: ./scripts/pre-deploy-check.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

ok() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; WARNINGS=$((WARNINGS + 1)); }
fail() { echo -e "${RED}✗${NC} $1"; ERRORS=$((ERRORS + 1)); }

echo "Qatin pre-deploy checklist"
echo "Root: $ROOT"
echo ""

# 1. .env
if [ -f .env ]; then
  ok ".env present"
  # shellcheck disable=SC1091
  set -a
  # Prefer safe parse: only KEY=VALUE lines without executing shell
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
      *=*)
        key="${line%%=*}"
        val="${line#*=}"
        export "$key=$val" 2>/dev/null || true
        ;;
    esac
  done < .env
  set +a

  if [ -n "${CREDENTIALS_SECRET:-}" ]; then
    ok "CREDENTIALS_SECRET set"
  else
    warn "CREDENTIALS_SECRET empty (deploy.sh can generate one)"
  fi

  if [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${DEEPSEEK_API_KEY:-}" ] || [ -n "${LLM_API_KEY:-}" ] || [ "${LLM_PROVIDER:-}" = "ollama" ]; then
    ok "At least one LLM credential / ollama provider"
  else
    warn "No LLM API key in .env (you can set keys later in the UI)"
  fi

  if [ -z "${JIRA_URL:-}" ] || [ -z "${JIRA_API_TOKEN:-}" ]; then
    warn "Jira env incomplete (optional if you only paste tickets / configure in UI)"
  else
    ok "Jira env present"
  fi
else
  fail ".env missing — run: cp .env.example .env"
fi

echo ""

# 2. Node
if command -v node >/dev/null 2>&1; then
  VER="$(node -v)"
  MAJOR="$(echo "$VER" | sed 's/v//' | cut -d. -f1)"
  if [ "$MAJOR" -ge 20 ]; then
    ok "Node $VER"
  else
    warn "Node $VER (20+ recommended)"
  fi
else
  fail "Node.js not installed"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v)"
else
  fail "npm not installed"
fi

echo ""

# 3. Redis
if redis-cli ping 2>/dev/null | grep -q PONG; then
  ok "Redis responds PONG"
elif command -v redis-server >/dev/null 2>&1; then
  warn "Redis installed but not responding (start redis-server)"
else
  fail "Redis not installed"
fi

echo ""

# 4. Build artifacts
if [ -d node_modules ]; then
  ok "node_modules present"
else
  warn "node_modules missing — npm install / npm run setup"
fi

if [ -f dist/server.js ] && [ -f dist/worker.js ]; then
  ok "Server build (dist/) present"
else
  warn "dist/ incomplete — npm run build"
fi

if [ -f public/index.html ]; then
  ok "UI build (public/) present"
else
  warn "public/ missing — npm run build:web"
fi

echo ""

# 5. Playwright
if [ -d node_modules/playwright ]; then
  if node -e "const {chromium}=require('playwright'); const p=chromium.executablePath(); process.exit(require('fs').existsSync(p)?0:1)" 2>/dev/null; then
    ok "Playwright Chromium binary present"
  else
    warn "Playwright package ok but Chromium missing — npx playwright install chromium"
  fi
else
  warn "Playwright not installed"
fi

echo ""

# 6. Directories
for d in data logs screenshots; do
  mkdir -p "$d"
  if [ -w "$d" ]; then
    ok "$d/ writable"
  else
    fail "$d/ not writable"
  fi
done

echo ""

# 7. Ports
PORT="${PORT:-8545}"
if command -v lsof >/dev/null 2>&1; then
  if lsof -Pi ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    warn "Port $PORT already in use"
  else
    ok "Port $PORT available"
  fi
  if lsof -Pi :6379 -sTCP:LISTEN -t >/dev/null 2>&1; then
    ok "Port 6379 in use (likely Redis)"
  else
    warn "Port 6379 not listening"
  fi
fi

echo ""

# 8. Disk
AVAIL="$(df -h . | awk 'NR==2 {print $4}')"
ok "Disk free: $AVAIL"

echo ""
echo "================================"

if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
  echo -e "${GREEN}All checks passed.${NC}"
  echo "Deploy: sudo ./deploy.sh"
  echo "Or local: npm run setup -- --yes && npm run pm2:start"
  exit 0
elif [ "$ERRORS" -eq 0 ]; then
  echo -e "${YELLOW}$WARNINGS warning(s) — deploy usually still works.${NC}"
  echo "Deploy: sudo ./deploy.sh"
  exit 0
else
  echo -e "${RED}$ERRORS error(s) — fix before deploying.${NC}"
  [ "$WARNINGS" -gt 0 ] && echo -e "${YELLOW}$WARNINGS warning(s) also.${NC}"
  exit 1
fi
