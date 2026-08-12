#!/bin/bash
# Builds the bundled Jira MCP server. Credentials are configured in the UI
# (Settings → Jira), not in mcp-server-jira/.env.
set -e
cd "$(dirname "$0")/.."
npm run build:mcp
echo "Done. Open Settings → Jira, add credentials, then Connect to Jira MCP."
