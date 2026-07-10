FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY api ./api
COPY server.js ./
COPY scripts ./scripts
COPY db ./db

EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.js && node server.js"]
