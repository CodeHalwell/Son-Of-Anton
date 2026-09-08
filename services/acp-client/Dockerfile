# Son of Anton — ACP Client
# Agent Client Protocol client for connecting to any ACP-compatible agent server.

FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
COPY _shared/acp/dist/ ./_shared/acp/dist/
COPY _shared/auth/dist/ ./_shared/auth/dist/
RUN npm run build

ENV ACP_HOST=0.0.0.0
EXPOSE 3300

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
    CMD curl -sf http://localhost:3300/health || exit 1

CMD ["node", "dist/index.js"]
