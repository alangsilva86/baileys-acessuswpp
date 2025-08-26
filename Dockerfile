FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Instala dependências em modo produção
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o servidor
COPY server.js ./server.js

# Diretório de sessão (será montado como volume)
RUN mkdir -p /app/sessions
VOLUME ["/app/sessions"]

EXPOSE 3000
CMD ["node", "server.js"]
