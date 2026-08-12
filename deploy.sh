#!/bin/bash
# Deploy Qatin on Ubuntu (or similar). Works from any install path.
# Usage: sudo ./deploy.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo -e "${RED}Run as root: sudo ./deploy.sh${NC}"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
ACTUAL_USER="${SUDO_USER:-$USER}"
USER_HOME="$(eval echo "~$ACTUAL_USER")"
PORT="${PORT:-8545}"

echo -e "${GREEN}Deploying Qatin from ${ROOT}${NC}"

run_as_user() {
  su - "$ACTUAL_USER" -c "cd \"$ROOT\" && $*"
}

echo -e "${GREEN}Installing system dependencies...${NC}"
apt-get update -qq

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

NODE_MAJOR="$(node -v | sed 's/v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${YELLOW}Node $(node -v) detected; Node 20+ recommended.${NC}"
fi

if ! command -v redis-server >/dev/null 2>&1; then
  echo "Installing Redis..."
  apt-get install -y redis-server
  systemctl enable redis-server
  systemctl start redis-server
else
  systemctl start redis-server 2>/dev/null || true
fi

echo "Installing Playwright OS libraries..."
apt-get install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
  2>/dev/null || apt-get install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
  2>/dev/null || true

# .env
if [ ! -f "$ROOT/.env" ]; then
  echo -e "${YELLOW}Creating .env from .env.example${NC}"
  cp "$ROOT/.env.example" "$ROOT/.env"
  chown "$ACTUAL_USER:$ACTUAL_USER" "$ROOT/.env"
fi

# Ensure CREDENTIALS_SECRET for encrypted project passwords
if ! grep -q '^CREDENTIALS_SECRET=.\+' "$ROOT/.env" 2>/dev/null; then
  SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)"
  if grep -q '^CREDENTIALS_SECRET=' "$ROOT/.env" 2>/dev/null; then
    sed -i.bak "s|^CREDENTIALS_SECRET=.*|CREDENTIALS_SECRET=$SECRET|" "$ROOT/.env"
    rm -f "$ROOT/.env.bak"
  else
    printf '\nCREDENTIALS_SECRET=%s\n' "$SECRET" >> "$ROOT/.env"
  fi
  chown "$ACTUAL_USER:$ACTUAL_USER" "$ROOT/.env"
  echo -e "${GREEN}Generated CREDENTIALS_SECRET in .env${NC}"
fi

# Ensure APP_ROOT points at this install
if grep -q '^APP_ROOT=' "$ROOT/.env" 2>/dev/null; then
  sed -i.bak "s|^APP_ROOT=.*|APP_ROOT=$ROOT|" "$ROOT/.env"
  rm -f "$ROOT/.env.bak"
else
  printf '\nAPP_ROOT=%s\n' "$ROOT" >> "$ROOT/.env"
fi
chown "$ACTUAL_USER:$ACTUAL_USER" "$ROOT/.env"

mkdir -p "$ROOT/logs" "$ROOT/screenshots" "$ROOT/data"
chown -R "$ACTUAL_USER:$ACTUAL_USER" "$ROOT/logs" "$ROOT/screenshots" "$ROOT/data"

echo -e "${GREEN}Running setup (deps, Playwright, build)...${NC}"
run_as_user "npm run setup -- --yes"

# Playwright system deps when available
run_as_user "npx playwright install-deps chromium" 2>/dev/null || true
run_as_user "npx playwright install chromium"

# Stop legacy systemd units if present
systemctl stop jira-qa-server.service 2>/dev/null || true
systemctl stop 'jira-qa-worker@'{1..3}.service 2>/dev/null || true
systemctl disable jira-qa-server.service 2>/dev/null || true
systemctl disable 'jira-qa-worker@'{1..3}.service 2>/dev/null || true

echo -e "${GREEN}Starting with PM2...${NC}"
run_as_user "npx pm2 delete ecosystem.config.cjs 2>/dev/null || true"
run_as_user "npx pm2 start ecosystem.config.cjs"
run_as_user "npx pm2 save"

STARTUP_CMD="$(run_as_user "npx pm2 startup systemd -u $ACTUAL_USER --hp $USER_HOME" | grep -E 'sudo |env ' | tail -1 || true)"
if [ -n "$STARTUP_CMD" ]; then
  echo -e "${GREEN}Configuring PM2 on boot...${NC}"
  eval "$STARTUP_CMD"
fi

cat > /etc/logrotate.d/qatin << EOF
$ROOT/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 $ACTUAL_USER $ACTUAL_USER
}
EOF

if command -v nginx >/dev/null 2>&1; then
  echo -e "${YELLOW}Nginx detected. Setup reverse proxy? (y/n)${NC}"
  read -r SETUP_NGINX || SETUP_NGINX=n
  if [ "$SETUP_NGINX" = "y" ] || [ "$SETUP_NGINX" = "Y" ]; then
    cat > /etc/nginx/sites-available/qatin << EOF
server {
    listen 80;
    server_name _;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/qatin /etc/nginx/sites-enabled/qatin
    nginx -t && systemctl reload nginx
    echo -e "${GREEN}Nginx proxy → 127.0.0.1:${PORT}${NC}"
  fi
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo -e "${GREEN}Deployment complete${NC}"
run_as_user "npx pm2 status"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Edit $ROOT/.env (LLM keys, Jira optional) — or use the UI Settings"
echo "2. Redeploy after changes: cd $ROOT && npm run redeploy"
echo "3. Logs: cd $ROOT && npx pm2 logs"
echo "4. Health: curl http://127.0.0.1:${PORT}/health"
echo "5. Do not expose :${PORT} publicly without a reverse proxy / firewall"
if [ -n "$HOST_IP" ]; then
  echo -e "${GREEN}API: http://${HOST_IP}:${PORT}${NC}"
fi
