FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY _lib/metrics/dist/ ./_lib/metrics/dist/
COPY _lib/tracing/dist/ ./_lib/tracing/dist/
COPY _shared/auth/dist/ ./_shared/auth/dist/
COPY _shared/agent-events/dist/ ./_shared/agent-events/dist/

RUN npx tsc --project tsconfig.build.json

FROM node:22-alpine

WORKDIR /app

# curl is required by the docker-compose healthcheck; the alpine base omits it.
RUN apk add --no-cache curl

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/_lib/metrics/dist/ ./_lib/metrics/dist/
COPY --from=build /app/_lib/tracing/dist/ ./_lib/tracing/dist/
COPY --from=build /app/_shared/auth/dist/ ./_shared/auth/dist/
COPY --from=build /app/_shared/agent-events/dist/ ./_shared/agent-events/dist/
COPY config/ ./config/

EXPOSE 3200

CMD ["node", "dist/index.js"]
