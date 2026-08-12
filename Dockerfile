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

WORKDIR /agent

COPY package*.json ./
COPY tsconfig.json ./
COPY web/package*.json ./web/

RUN npm ci && npm ci --prefix web

RUN npx playwright install chromium

COPY src/ ./src/
COPY web/ ./web/

RUN npm run build

RUN mkdir -p logs screenshots data

EXPOSE 8545

CMD ["npm", "start"]
