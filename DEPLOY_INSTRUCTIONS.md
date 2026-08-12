# Install Qatin on a new server

Qatin runs from **any directory** (e.g. `/opt/qatin`, `~/Qatin`). There is no hard-coded `/agent` path.

## Requirements

- Node.js **20+**
- Redis
- Linux recommended for Playwright (Ubuntu 22.04 / 24.04)
- At least one LLM provider key (or Ollama)
- Jira credentials only if you use Jira tickets

## Option A — Ubuntu with `deploy.sh` (recommended)

```bash
git clone <repository-url> qatin
cd qatin
cp .env.example .env
# Edit .env: LLM keys (and optional Jira). Leave CREDENTIALS_SECRET empty —
# deploy.sh will generate one.

chmod +x deploy.sh scripts/*.sh
./scripts/pre-deploy-check.sh   # optional checklist
sudo ./deploy.sh
```

What `deploy.sh` does:

1. Installs Node 20 (if missing), Redis, Playwright OS libs
2. Creates `.env` / `CREDENTIALS_SECRET` / `APP_ROOT` if needed
3. Runs `npm run setup -- --yes` (deps, Chromium, MCP, build)
4. Starts **PM2** (`qatin-server` + 3 workers) and enables boot startup
5. Optionally configures Nginx reverse proxy

Verify:

```bash
curl http://127.0.0.1:8545/health
cd /path/to/qatin && npx pm2 status
```

Redeploy after pulls:

```bash
git pull
npm run redeploy
```

## Option B — Manual (any OS with Node + Redis)

```bash
git clone <repository-url> qatin && cd qatin
cp .env.example .env
# set CREDENTIALS_SECRET to a long random string in production
npm run setup -- --yes
npm run pm2:start
# or without PM2:
# npm start          # terminal 1
# npm run worker     # terminal 2
```

Open `http://localhost:8545`.

## Option C — Docker Compose

```bash
cp .env.example .env
# set LLM keys + CREDENTIALS_SECRET
mkdir -p data logs screenshots
docker compose up -d --build
# scale workers:
docker compose up -d --scale worker=3
```

Data persists in `./data`, screenshots in `./screenshots`, logs in `./logs`.

## Security notes

- Do **not** expose port `8545` to the public internet without a reverse proxy (HTTPS) and network controls. The API has no login yet.
- Always set `CREDENTIALS_SECRET` on shared/production hosts so project passwords are encrypted in SQLite.
- Prefer putting secrets in the UI **Settings** or `.env` with restricted file permissions (`chmod 600 .env`).

## Useful commands

| Action | Command |
|--------|---------|
| Status | `./scripts/check-status.sh` |
| Restart | `./scripts/restart-services.sh` |
| Logs | `npx pm2 logs` |
| Health | `curl http://127.0.0.1:8545/health` |
| Pre-check | `./scripts/pre-deploy-check.sh` |
