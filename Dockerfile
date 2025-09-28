FROM node:20-bookworm-slim

WORKDIR /app

# Definir variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar dependências (usar npm install em vez de npm ci para evitar problemas de sincronização)
RUN npm install --only=production

# Copiar código fonte
COPY . .

# Criar diretório de sessões
RUN mkdir -p /app/sessions

# Expor porta
EXPOSE 10000

# Comando para iniciar a aplicação
CMD ["npm", "start"]
