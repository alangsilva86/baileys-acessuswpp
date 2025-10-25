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

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 10000

# use ENTRYPOINT para garantir que o script sempre roda
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# e deixe o comando da app no CMD
CMD ["node", "dist/src/server.js"]
# se o seu build emite dist/server.js, troque o caminho acima