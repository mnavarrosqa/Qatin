#!/bin/bash

# Restart all Jira QA Agent services

echo "🔄 Restarting Jira QA Agent services..."

sudo systemctl restart jira-qa-server
sudo systemctl restart jira-qa-worker@1
sudo systemctl restart jira-qa-worker@2
sudo systemctl restart jira-qa-worker@3

echo "✅ Services restarted"
echo ""
echo "Status:"
./scripts/check-status.sh
