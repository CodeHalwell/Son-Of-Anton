# Son of Anton — MCP Gateway
# Model Context Protocol gateway that exposes graph and vector queries
# as MCP tools for Claude-based agents.

FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json build.mjs ./
RUN npm install

COPY src/ ./src/
COPY _lib/metrics/dist/ ./_lib/metrics/dist/
COPY _lib/tracing/dist/ ./_lib/tracing/dist/
COPY _shared/auth/dist/ ./_shared/auth/dist/
# esbuild transpile (see build.mjs). Unlike the sibling services, tsc — even with
# --noCheck — must resolve the MCP SDK's deeply-nested Zod tool-schema types and
# balloons past a 4 GB heap (exit 134) in the CI Docker builder. esbuild strips
# types without touching the declaration graph, so the build stays fast.
RUN npm run build

EXPOSE 3100

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
    CMD curl -sf http://localhost:3100/health || exit 1

CMD ["node", "dist/index.js"]
