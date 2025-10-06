# Stage 1 - build the TypeScript sources
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2 - runtime image
FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

RUN mkdir -p /app/sessions

EXPOSE 10000
CMD ["node", "dist/src/server.js"]
