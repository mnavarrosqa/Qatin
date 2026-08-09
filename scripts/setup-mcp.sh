#!/bin/bash

# Setup MCP Jira Server
# Installs and configures the MCP server for Jira integration

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔧 Setting up Jira MCP Server${NC}"
echo ""

# Check if we're in the right directory
if [ ! -d "mcp-server-jira" ]; then
    echo -e "${RED}Error: mcp-server-jira directory not found${NC}"
    echo "Please run this script from /agent directory"
    exit 1
fi

# Step 1: Install dependencies
echo -e "${GREEN}1. Installing MCP server dependencies...${NC}"
cd mcp-server-jira
npm install

# Step 2: Build the server
echo -e "${GREEN}2. Building MCP server...${NC}"
npm run build

# Check if build was successful
if [ ! -f "dist/index.js" ]; then
    echo -e "${RED}Build failed!${NC}"
    exit 1
fi

# Make executable
chmod +x dist/index.js

echo -e "${GREEN}✓ Build successful${NC}"

# Step 3: Configure environment
echo -e "${GREEN}3. Configuring environment...${NC}"
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo -e "${YELLOW}⚠ Please edit mcp-server-jira/.env with your Jira credentials${NC}"
fi

cd ..

# Step 4: Update main app dependencies
echo -e "${GREEN}4. Installing MCP SDK in main app...${NC}"
if ! grep -q "@modelcontextprotocol/sdk" package.json; then
    npm install @modelcontextprotocol/sdk
fi

# Step 5: Configure main app
echo -e "${GREEN}5. Configuring main application...${NC}"

# Add MCP config to .env if not present
if [ -f ".env" ]; then
    if ! grep -q "USE_MCP" .env; then
        echo "" >> .env
        echo "# MCP Configuration" >> .env
        echo "USE_MCP=true" >> .env
        echo "MCP_JIRA_SERVER_PATH=$(pwd)/mcp-server-jira/dist/index.js" >> .env
        echo -e "${GREEN}✓ Added MCP configuration to .env${NC}"
    else
        echo -e "${YELLOW}⚠ MCP already configured in .env${NC}"
    fi
else
    echo -e "${YELLOW}⚠ .env not found, please create it from .env.example${NC}"
fi

# Step 6: Test the MCP server
echo ""
echo -e "${GREEN}6. Testing MCP server...${NC}"

cd mcp-server-jira

# Quick test to see if it starts
timeout 2 node dist/index.js <<EOF || true
{"jsonrpc": "2.0", "method": "initialize", "id": 1, "params": {}}
EOF

cd ..

echo ""
echo -e "${GREEN}✅ MCP Server Setup Complete!${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "1. Configure credentials: nano mcp-server-jira/.env"
echo "2. Restart the QA Agent: ./scripts/restart-services.sh"
echo "3. Test: curl -X POST http://localhost:3000/api/test-ticket -H 'Content-Type: application/json' -d '{\"ticketId\": \"PROJ-123\"}'"
echo "4. Check logs: tail -f logs/server.log | grep MCP"
echo ""
echo -e "${YELLOW}Optional: Setup systemd service for MCP server${NC}"
echo "Run: sudo nano /etc/systemd/system/jira-mcp-server.service"
echo "See MCP_INTEGRATION.md for details"
echo ""
