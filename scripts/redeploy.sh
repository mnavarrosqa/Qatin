#!/bin/bash
set -euo pipefail

# Build + reload Qatin under PM2 (no sudo)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8545}"

echo "Building…"
npm run build

# Free the API port if an old non-PM2 server is still holding it
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${PIDS}" ]; then
    echo "Port $PORT busy (pids: $PIDS) — stopping so PM2 can bind…"
    npx pm2 stop qatin-server >/dev/null 2>&1 || true
    sleep 0.5
    PIDS="$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "${PIDS}" ]; then
      # shellcheck disable=SC2086
      kill $PIDS 2>/dev/null || true
      sleep 0.5
    fi
  fi
fi

echo "Reloading PM2 apps…"
if npx pm2 describe qatin-server >/dev/null 2>&1; then
  npx pm2 startOrReload ecosystem.config.cjs --update-env
else
  npx pm2 start ecosystem.config.cjs
fi

npx pm2 save
npx pm2 reset qatin-server >/dev/null 2>&1 || true
npx pm2 status
echo ""
curl -s "http://127.0.0.1:${PORT}/health" || echo "Health check failed"
echo ""
