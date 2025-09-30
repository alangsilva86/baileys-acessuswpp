# Baileys WhatsApp API

Uma API completa para WhatsApp usando a biblioteca Baileys, com interface web para gerenciamento de instâncias e métricas em tempo real.

## Características

- ✅ Múltiplas instâncias de WhatsApp
- ✅ Interface web com dashboard
- ✅ Métricas e estatísticas em tempo real
- ✅ Rate limiting configurável
- ✅ Webhooks para eventos estruturados
- ✅ Autenticação por API Key
- ✅ Logs estruturados com Pino
- ✅ Suporte a QR Code e pareamento por código
- ✅ Envio de enquetes (polls) com feedback opcional

## Instalação

1. Clone o repositório:
```bash
git clone <repository-url>
cd baileys-acessuswpp
```

2. Instale as dependências:
```bash
npm install
```

3. Configure as variáveis de ambiente:
```bash
cp .env.example .env
# Edite o arquivo .env com suas configurações
```

4. Inicie o servidor:
```bash
npm start
```

## Configuração

### Variáveis de Ambiente

- `PORT`: Porta do servidor (padrão: 3000)
- `API_KEY`: Chave de API para autenticação (obrigatório)
- `SESSION_DIR`: Diretório para armazenar sessões (padrão: ./sessions)
- `LOG_LEVEL`: Nível de log (padrão: info)
- `SERVICE_NAME`: Nome do serviço para logs (padrão: baileys-api)
- `WEBHOOK_URL`: URL para receber webhooks de eventos
- `WEBHOOK_API_KEY`: Chave opcional para autenticar o webhook
- `WEBHOOK_HMAC_SECRET`: Segredo opcional para assinar os eventos via HMAC
- `RATE_MAX_SENDS`: Máximo de mensagens por janela de tempo (padrão: 20)
- `RATE_WINDOW_MS`: Janela de tempo para rate limiting em ms (padrão: 15000)
- `SEND_TIMEOUT_MS`: Timeout padrão para envios ativos (padrão: 25000)
- `POLL_STORE_TTL_MS`: Tempo de retenção das mensagens de enquete (padrão: 6h)
- `POLL_FEEDBACK_TEMPLATE`: Template opcional para resposta automática após voto em enquete

## Uso

### Interface Web

Acesse `http://localhost:3000` para usar o dashboard web onde você pode:

- Criar e gerenciar instâncias
- Visualizar QR codes para autenticação
- Monitorar métricas em tempo real
- Enviar mensagens de teste

### API Endpoints

Todos os endpoints requerem o header `X-API-Key` com sua chave de API.

- `GET /health` - Status da API e conexões ativas

#### Instâncias

- `POST /instances` - Criar nova instância
- `GET /instances` - Listar todas as instâncias
- `GET /instances/:id` - Obter detalhes de uma instância
- `PATCH /instances/:id` - Atualizar instância
- `DELETE /instances/:id` - Deletar instância

#### Autenticação

- `GET /instances/:id/qr.png` - Obter QR code como imagem
- `POST /instances/:id/pair` - Solicitar código de pareamento
- `POST /instances/:id/logout` - Desconectar sessão

#### Mensagens

- `POST /instances/:id/send-text` - Enviar mensagem de texto
- `POST /instances/:id/send-poll` - Enviar enquete para um contato ou grupo
- `POST /instances/:id/exists` - Verificar se número existe no WhatsApp
- `GET /instances/:id/status` - Verificar status de mensagem

#### Grupos

- `GET /instances/:id/groups` - Listar grupos da instância

#### Métricas

- `GET /instances/:id/metrics` - Obter métricas detalhadas

## Estrutura do Projeto

```
├── src/
│   ├── instanceManager.ts    # Gerenciamento de instâncias
│   ├── whatsapp.ts           # Integração com Baileys e serviços auxiliares
│   ├── utils.ts              # Funções utilitárias
│   ├── server.ts             # Servidor HTTP (Express)
│   ├── baileys/              # Serviços de mensagens e enquetes
│   ├── services/             # Camada de integração externa (webhook, lead mapper)
│   └── routes/
│       └── instances.ts      # Rotas da API
├── public/
│   ├── index.html          # Interface web
│   └── dashboard.js        # JavaScript do dashboard
├── sessions/               # Diretório de sessões (criado automaticamente)
├── package.json           # Dependências
└── .env                   # Configurações (criar a partir do .env.example)
```

## Desenvolvimento

Para desenvolvimento, você pode usar:

```bash
# Instalar dependências
npm install

# Iniciar em modo de desenvolvimento (com nodemon se instalado)
npm run dev

# Ou iniciar normalmente
npm start
```

## Logs

O sistema usa logs estruturados com Pino. Os logs incluem:

- Eventos de conexão/desconexão
- Mensagens enviadas e recebidas
- Métricas de performance
- Erros e warnings

## Segurança

- Sempre use uma API Key forte
- Configure rate limiting apropriado
- Use HTTPS em produção
- Mantenha as sessões seguras

## Suporte

Para problemas ou dúvidas, consulte a documentação da biblioteca Baileys ou abra uma issue no repositório.
