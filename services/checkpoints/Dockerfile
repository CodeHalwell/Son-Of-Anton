# Build stage
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY _lib/metrics/dist/ ./_lib/metrics/dist/
COPY _shared/auth/dist/ ./_shared/auth/dist/

RUN npx tsc --project tsconfig.build.json --noCheck

# Runtime stage
FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/_lib/metrics/dist/ ./_lib/metrics/dist/
COPY --from=build /app/_shared/auth/dist/ ./_shared/auth/dist/
COPY package.json ./

EXPOSE 3201

USER node

CMD ["node", "dist/index.js"]
