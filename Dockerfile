FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 make g++ \
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
    libasound2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY web/package*.json ./web/
COPY mcp-server-jira/package*.json ./mcp-server-jira/

RUN npm ci && npm ci --prefix web && npm ci --prefix mcp-server-jira

RUN npx playwright install chromium && npx playwright install-deps chromium || true

COPY src/ ./src/
COPY web/ ./web/
COPY mcp-server-jira/ ./mcp-server-jira/
COPY ecosystem.config.cjs ./

RUN npm run build

RUN mkdir -p logs screenshots data public

ENV APP_ROOT=/app
ENV NODE_ENV=production
ENV PORT=8545

EXPOSE 8545

CMD ["npm", "start"]
