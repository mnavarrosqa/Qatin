#!/bin/bash

# Check status of all Jira QA Agent services

echo "=== Jira QA Agent Status ==="
echo ""

echo "📡 Server Status:"
systemctl is-active --quiet jira-qa-server && echo "✅ Running" || echo "❌ Stopped"
echo ""

echo "👷 Workers Status:"
for i in {1..3}; do
    echo -n "  Worker $i: "
    systemctl is-active --quiet jira-qa-worker@$i && echo "✅ Running" || echo "❌ Stopped"
done
echo ""

echo "🔴 Redis Status:"
systemctl is-active --quiet redis-server && echo "✅ Running" || echo "❌ Stopped"
echo ""

echo "📊 Recent Logs (Server):"
journalctl -u jira-qa-server -n 5 --no-pager
echo ""

echo "📊 Recent Logs (Worker 1):"
journalctl -u jira-qa-worker@1 -n 5 --no-pager
echo ""

echo "🌐 API Health Check:"
curl -s http://localhost:3000/health | jq . 2>/dev/null || echo "API not responding"
echo ""

echo "📈 Queue Stats:"
redis-cli INFO stats | grep total_commands_processed || echo "Redis not accessible"
