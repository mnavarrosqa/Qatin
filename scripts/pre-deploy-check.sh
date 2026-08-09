#!/bin/bash

# Pre-deployment checklist script
# Verifies all requirements before deploying

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🔍 Pre-Deployment Checklist for Jira QA Agent"
echo ""

ERRORS=0
WARNINGS=0

# Check 1: .env file exists
echo -n "1. Checking .env file... "
if [ -f ".env" ]; then
    echo -e "${GREEN}✓${NC}"
    
    # Check required vars
    source .env
    
    echo -n "   - JIRA_URL... "
    if [ -z "$JIRA_URL" ]; then
        echo -e "${RED}✗ Missing${NC}"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "${GREEN}✓${NC}"
    fi
    
    echo -n "   - JIRA_EMAIL... "
    if [ -z "$JIRA_EMAIL" ]; then
        echo -e "${RED}✗ Missing${NC}"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "${GREEN}✓${NC}"
    fi
    
    echo -n "   - JIRA_API_TOKEN... "
    if [ -z "$JIRA_API_TOKEN" ]; then
        echo -e "${RED}✗ Missing${NC}"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "${GREEN}✓${NC}"
    fi
    
    echo -n "   - OPENAI_API_KEY... "
    if [ -z "$OPENAI_API_KEY" ]; then
        echo -e "${RED}✗ Missing${NC}"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "${GREEN}✓${NC}"
    fi
    
    echo -n "   - APP_BASE_URL... "
    if [ -z "$APP_BASE_URL" ]; then
        echo -e "${YELLOW}⚠ Missing (not critical)${NC}"
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "${GREEN}✓${NC}"
    fi
else
    echo -e "${RED}✗ Not found${NC}"
    echo -e "${YELLOW}   → Run: cp .env.example .env${NC}"
    ERRORS=$((ERRORS + 1))
fi

echo ""

# Check 2: Node.js
echo -n "2. Checking Node.js... "
if command -v node &> /dev/null; then
    VERSION=$(node --version)
    echo -e "${GREEN}✓ $VERSION${NC}"
    
    # Check version >= 18
    MAJOR=$(echo $VERSION | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$MAJOR" -lt 18 ]; then
        echo -e "${YELLOW}   ⚠ Node.js 18+ recommended${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo -e "${RED}✗ Not installed${NC}"
    ERRORS=$((ERRORS + 1))
fi

# Check 3: npm
echo -n "3. Checking npm... "
if command -v npm &> /dev/null; then
    VERSION=$(npm --version)
    echo -e "${GREEN}✓ v$VERSION${NC}"
else
    echo -e "${RED}✗ Not installed${NC}"
    ERRORS=$((ERRORS + 1))
fi

echo ""

# Check 4: Redis
echo -n "4. Checking Redis... "
if command -v redis-server &> /dev/null; then
    VERSION=$(redis-server --version | awk '{print $3}')
    echo -e "${GREEN}✓ $VERSION${NC}"
    
    echo -n "   - Redis running... "
    if pgrep redis-server > /dev/null; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}⚠ Not running${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo -e "${RED}✗ Not installed${NC}"
    ERRORS=$((ERRORS + 1))
fi

echo ""

# Check 5: Dependencies installed
echo -n "5. Checking node_modules... "
if [ -d "node_modules" ]; then
    echo -e "${GREEN}✓ Installed${NC}"
else
    echo -e "${YELLOW}⚠ Not installed${NC}"
    echo -e "${YELLOW}   → Run: npm install${NC}"
    WARNINGS=$((WARNINGS + 1))
fi

# Check 6: TypeScript compiled
echo -n "6. Checking compiled code... "
if [ -d "dist" ]; then
    echo -e "${GREEN}✓ Built${NC}"
else
    echo -e "${YELLOW}⚠ Not built${NC}"
    echo -e "${YELLOW}   → Run: npm run build${NC}"
    WARNINGS=$((WARNINGS + 1))
fi

echo ""

# Check 7: Playwright
echo -n "7. Checking Playwright... "
if [ -d "node_modules/playwright" ]; then
    echo -e "${GREEN}✓ Installed${NC}"
    
    echo -n "   - Chromium browser... "
    if [ -d "$HOME/.cache/ms-playwright" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}⚠ Not installed${NC}"
        echo -e "${YELLOW}   → Run: npx playwright install chromium${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo -e "${YELLOW}⚠ Not installed${NC}"
    WARNINGS=$((WARNINGS + 1))
fi

echo ""

# Check 8: System dependencies (if Linux)
if [ "$(uname)" == "Linux" ]; then
    echo "8. Checking system dependencies..."
    
    DEPS=("libnss3" "libxcomposite1" "libxdamage1")
    for dep in "${DEPS[@]}"; do
        echo -n "   - $dep... "
        if dpkg -l | grep -q "^ii  $dep"; then
            echo -e "${GREEN}✓${NC}"
        else
            echo -e "${YELLOW}⚠ Missing${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    done
fi

echo ""

# Check 9: Disk space
echo -n "9. Checking disk space... "
AVAILABLE=$(df -h . | awk 'NR==2 {print $4}')
echo -e "${GREEN}✓ $AVAILABLE available${NC}"

# Check 10: Ports
echo "10. Checking ports..."
echo -n "   - Port 3000 (API)... "
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Already in use${NC}"
    WARNINGS=$((WARNINGS + 1))
else
    echo -e "${GREEN}✓ Available${NC}"
fi

echo -n "   - Port 6379 (Redis)... "
if lsof -Pi :6379 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${GREEN}✓ In use (Redis)${NC}"
else
    echo -e "${YELLOW}⚠ Not in use${NC}"
    WARNINGS=$((WARNINGS + 1))
fi

echo ""
echo "================================"
echo ""

# Summary
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✅ All checks passed! Ready to deploy.${NC}"
    echo ""
    echo "Run: sudo ./deploy.sh"
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠️  $WARNINGS warning(s) found. Deployment possible but not optimal.${NC}"
    echo ""
    echo "You can proceed with: sudo ./deploy.sh"
    exit 0
else
    echo -e "${RED}❌ $ERRORS error(s) found. Please fix before deploying.${NC}"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}⚠️  $WARNINGS warning(s) also found.${NC}"
    fi
    echo ""
    echo "Fix the errors above and run this script again."
    exit 1
fi
