# Son of Anton — MCP Gateway
# Model Context Protocol gateway that exposes graph and vector queries
# as MCP tools for Claude-based agents.

FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
COPY _lib/metrics/dist/ ./_lib/metrics/dist/
COPY _lib/tracing/dist/ ./_lib/tracing/dist/
RUN npx tsc

EXPOSE 3100

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
    CMD curl -sf http://localhost:3100/health || exit 1

CMD ["node", "dist/index.js"]
