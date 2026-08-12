#!/bin/bash
set -euo pipefail

# Build + reload Qatin under PM2 (no sudo)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Building…"
npm run build

echo "Reloading PM2 apps…"
if npx pm2 describe qatin-server >/dev/null 2>&1; then
  npx pm2 startOrReload ecosystem.config.cjs --update-env
else
  npx pm2 start ecosystem.config.cjs
fi

npx pm2 save
npx pm2 status
