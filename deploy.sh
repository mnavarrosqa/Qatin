#!/bin/bash

# Deployment script for Jira QA Agent on Ubuntu server
# Run as: sudo ./deploy.sh

set -e

echo "🚀 Starting Jira QA Agent deployment..."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}Please run as root (sudo ./deploy.sh)${NC}"
  exit 1
fi

# Get the actual user who ran sudo
ACTUAL_USER=${SUDO_USER:-$USER}
USER_HOME=$(eval echo ~$ACTUAL_USER)

echo -e "${GREEN}Installing system dependencies...${NC}"

# Update system
apt-get update

# Install Node.js 20.x
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# Install Redis
if ! command -v redis-server &> /dev/null; then
    echo "Installing Redis..."
    apt-get install -y redis-server
    systemctl enable redis-server
    systemctl start redis-server
fi

# Install Playwright dependencies
echo "Installing Playwright system dependencies..."
apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2

echo -e "${GREEN}Installing project dependencies...${NC}"

# Install Node.js dependencies
su - $ACTUAL_USER -c "cd /agent && npm install"

# Install Playwright browsers
su - $ACTUAL_USER -c "cd /agent && npx playwright install chromium"

echo -e "${GREEN}Building TypeScript project...${NC}"
su - $ACTUAL_USER -c "cd /agent && npm run build"

# Create directories
echo "Creating required directories..."
mkdir -p /agent/logs
mkdir -p /agent/screenshots
chown -R $ACTUAL_USER:$ACTUAL_USER /agent/logs
chown -R $ACTUAL_USER:$ACTUAL_USER /agent/screenshots

# Check for .env file
if [ ! -f "/agent/.env" ]; then
    echo -e "${YELLOW}Warning: .env file not found!${NC}"
    echo "Copying .env.example to .env..."
    cp /agent/.env.example /agent/.env
    chown $ACTUAL_USER:$ACTUAL_USER /agent/.env
    echo -e "${RED}Please edit /agent/.env with your configuration before starting services!${NC}"
fi

echo -e "${GREEN}Stopping legacy systemd app units (if any)...${NC}"
systemctl stop jira-qa-server.service 2>/dev/null || true
systemctl stop jira-qa-worker@{1..3}.service 2>/dev/null || true
systemctl disable jira-qa-server.service 2>/dev/null || true
systemctl disable jira-qa-worker@{1..3}.service 2>/dev/null || true

echo -e "${GREEN}Starting app with PM2...${NC}"
su - "$ACTUAL_USER" -c "cd /agent && npx pm2 delete ecosystem.config.cjs 2>/dev/null || true"
su - "$ACTUAL_USER" -c "cd /agent && npx pm2 start ecosystem.config.cjs"
su - "$ACTUAL_USER" -c "cd /agent && npx pm2 save"

# Ensure PM2 comes back after reboot (as the app user)
STARTUP_CMD=$(su - "$ACTUAL_USER" -c "cd /agent && npx pm2 startup systemd -u $ACTUAL_USER --hp $USER_HOME" | grep -E 'sudo|env ' | tail -1 || true)
if [ -n "$STARTUP_CMD" ]; then
  echo -e "${GREEN}Configuring PM2 startup on boot...${NC}"
  eval "$STARTUP_CMD"
fi

# Setup logrotate
echo "Setting up log rotation..."
cat > /etc/logrotate.d/jira-qa-agent << EOF
/agent/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 $ACTUAL_USER $ACTUAL_USER
}
EOF

# Setup nginx (optional, for reverse proxy)
if command -v nginx &> /dev/null; then
    echo -e "${YELLOW}Nginx detected. Would you like to setup reverse proxy? (y/n)${NC}"
    read -r SETUP_NGINX
    if [ "$SETUP_NGINX" = "y" ]; then
        cat > /etc/nginx/sites-available/jira-qa-agent << EOF
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:8545;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF
        ln -sf /etc/nginx/sites-available/jira-qa-agent /etc/nginx/sites-enabled/
        nginx -t && systemctl reload nginx
        echo -e "${GREEN}Nginx configured successfully${NC}"
    fi
fi

echo ""
echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "PM2 status:"
su - "$ACTUAL_USER" -c "cd /agent && npx pm2 status"
echo ""
echo -e "${YELLOW}Important next steps:${NC}"
echo "1. Edit /agent/.env with your Jira and OpenAI credentials"
echo "2. Redeploy: cd /agent && npm run redeploy"
echo "3. Logs: cd /agent && npx pm2 logs"
echo "4. Test API: curl http://localhost:8545/health"
echo ""
echo -e "${GREEN}API will be available at: http://$(hostname -I | awk '{print $1}'):8545${NC}"
