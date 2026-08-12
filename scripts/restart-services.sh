#!/bin/bash

# Restart all Qatin processes via PM2

echo "🔄 Restarting Qatin (PM2)…"

npx pm2 restart ecosystem.config.cjs

echo "✅ Restarted"
echo ""
npx pm2 status
