FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY _lib/metrics/dist/ ./_lib/metrics/dist/
COPY _lib/tracing/dist/ ./_lib/tracing/dist/

RUN npx tsc --project tsconfig.build.json --noCheck

FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/_lib/metrics/dist/ ./_lib/metrics/dist/
COPY --from=build /app/_lib/tracing/dist/ ./_lib/tracing/dist/
COPY config/ ./config/

EXPOSE 3200

CMD ["node", "dist/index.js"]
