FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ src/
COPY _shared/auth/dist/ ./_shared/auth/dist/

RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist/ dist/
COPY _shared/auth/dist/ ./dist/_shared/auth/dist/

EXPOSE 3202

CMD ["node", "dist/src/main.js"]
