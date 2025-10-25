# Stage 1 - build
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2 - runtime
FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Entrypoint que cria o symlink /app/data -> /app/sessions
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 10000
CMD ["entrypoint.sh"]