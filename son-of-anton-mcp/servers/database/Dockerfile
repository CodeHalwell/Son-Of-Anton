# Son of Anton — Database MCP Server
# Read-only SQL access for agents

FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

COPY src/ ./src/
COPY _shared/auth/dist/ ./_shared/auth/dist/
RUN npm run build

EXPOSE 3102

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
    CMD curl -sf http://localhost:3102/health || exit 1

CMD ["node", "dist/index.js"]
