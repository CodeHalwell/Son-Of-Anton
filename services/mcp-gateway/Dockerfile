# Son of Anton — MCP Gateway
# Model Context Protocol gateway that exposes graph and vector queries
# as MCP tools for Claude-based agents.

FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json build.mjs ./
RUN npm ci --no-audit --no-fund

COPY src/ ./src/
COPY _lib/metrics/dist/ ./_lib/metrics/dist/
COPY _lib/tracing/dist/ ./_lib/tracing/dist/
COPY _lib/embeddings/dist/ ./_lib/embeddings/dist/
COPY _shared/auth/dist/ ./_shared/auth/dist/
COPY _shared/cypher/dist/ ./_shared/cypher/dist/
COPY _shared/sanitiser/dist/ ./_shared/sanitiser/dist/
RUN npm run build

EXPOSE 3100

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
    CMD curl -sf http://localhost:3100/health || exit 1

CMD ["node", "dist/index.js"]
