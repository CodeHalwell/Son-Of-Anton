# Son of Anton — Deployment Pipeline MCP Server

FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
COPY _shared/auth/dist/ ./_shared/auth/dist/
RUN npx tsc --noCheck

EXPOSE 3103

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
    CMD curl -sf http://localhost:3103/health || exit 1

CMD ["node", "dist/index.js"]
