#!/bin/bash

# Check status of Qatin (PM2) + Redis

echo "=== Qatin Status ==="
echo ""

echo "📦 PM2:"
if command -v pm2 >/dev/null 2>&1 || npx pm2 -v >/dev/null 2>&1; then
  npx pm2 status
else
  echo "❌ PM2 not available (npm install)"
fi
echo ""

echo "🔴 Redis:"
if systemctl is-active --quiet redis-server 2>/dev/null; then
  echo "✅ Running (systemd redis-server)"
elif redis-cli ping >/dev/null 2>&1; then
  echo "✅ Responding (redis-cli ping)"
else
  echo "❌ Not reachable"
fi
echo ""

echo "🌐 API Health:"
curl -s http://localhost:8545/health | jq . 2>/dev/null || echo "API not responding"
echo ""

echo "📈 Queue (Redis commands):"
redis-cli INFO stats 2>/dev/null | grep total_commands_processed || echo "Redis not accessible"
