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
- `BROKER_MODE`: Quando definido como `true`, inicializa o servidor no modo broker minimalista (desabilita o dashboard e rotas legadas)
- `LEADENGINE_INSTANCE_ID`: Identificador padrão da sessão usada no modo broker (padrão: `leadengine`)
- `LOG_LEVEL`: Nível de log (padrão: info)
- `SERVICE_NAME`: Nome do serviço para logs (padrão: baileys-api)
- `WEBHOOK_URL`: URL para receber webhooks de eventos
- `WEBHOOK_API_KEY`: Chave opcional para autenticar o webhook
- `WEBHOOK_HMAC_SECRET`: Segredo opcional para assinar os eventos via HMAC
- `RATE_MAX_SENDS`: Máximo de mensagens por janela de tempo (padrão: 20)
- `RATE_WINDOW_MS`: Janela de tempo para rate limiting em ms (padrão: 15000)
- `SEND_TIMEOUT_MS`: Timeout padrão para envios ativos, aplicado tanto às rotas HTTP quanto ao `MessageService` (padrão: 25000)
- `POLL_STORE_TTL_MS`: Tempo de retenção das mensagens de enquete (padrão: 6h)
- `POLL_FEEDBACK_TEMPLATE`: Template opcional para resposta automática após voto em enquete

### Webhooks

Defina `WEBHOOK_URL` (e opcionalmente `WEBHOOK_API_KEY`/`WEBHOOK_HMAC_SECRET`) para receber eventos push. Ao ativar, o serviço envia um `POST` para o endpoint configurado sempre que um voto de enquete é processado.

#### Implementando o endpoint receptor

Você pode testar rapidamente com o servidor de exemplo incluso no projeto. Basta executar:

```bash
npm run example:poll-webhook
```

O script lê `WEBHOOK_API_KEY` e `WEBHOOK_HMAC_SECRET` do ambiente, expõe `POST /webhooks/baileys` e registra cada voto recebido em log usando Pino. O código completo está em `src/examples/pollWebhookServer.ts`:

```ts
import 'dotenv/config';
import crypto from 'node:crypto';
import express, { type Request } from 'express';
import pino from 'pino';

const app = express();
const PORT = Number(process.env.WEBHOOK_PORT ?? process.env.PORT ?? 3001);
const EXPECTED_API_KEY = process.env.WEBHOOK_API_KEY;
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET;
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'poll-webhook-example' } });

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as RequestWithRawBody).rawBody = Buffer.from(buf);
    },
  }),
);

function timingSafeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function buildSignature(rawBody: Buffer, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  return `sha256=${hmac.digest('hex')}`;
}

function isValidSignature(req: RequestWithRawBody): boolean {
  if (!HMAC_SECRET) return true;
  const rawBody = req.rawBody;
  const received = req.header('x-signature-256');
  if (!rawBody || !received) return false;
  const expected = buildSignature(rawBody, HMAC_SECRET);
  return timingSafeEqual(received, expected);
}

app.post('/webhooks/baileys', (req: RequestWithRawBody, res) => {
  if (EXPECTED_API_KEY && req.header('x-api-key') !== EXPECTED_API_KEY) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  if (!isValidSignature(req)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const { event, payload, timestamp } = req.body ?? {};
  if (event === 'POLL_CHOICE') {
    logger.info({ event, timestamp, payload }, 'webhook.poll_choice');
  }

  return res.sendStatus(204);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'webhook.server.listening');
});
```

Depois de publicar esse endpoint, configure `WEBHOOK_URL` apontando para ele (ex.: `https://sua-api.com/webhooks/baileys`).

#### Payload do evento `POLL_CHOICE`

O evento tem o tipo `POLL_CHOICE` e carrega o payload:

```json
{
  "event": "POLL_CHOICE",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "instanceId": "leadengine",
  "payload": {
    "pollId": "ABCD",
    "question": "Qual a melhor data?",
    "chatId": "123@g.us",
    "voterJid": "555199999999@whatsapp.net",
    "selectedOptions": ["Sexta"],
    "aggregate": [
      {
        "name": "Sexta",
        "voters": ["555199999999@whatsapp.net"],
        "count": 1
      }
    ],
    "lead": {
      "name": "Fulano",
      "phone": "+55 51 99999-9999"
    }
  }
}
```

Basta expor um endpoint HTTPS que valide a chave/assinatura (se configuradas) e processe o corpo recebido. O campo `selectedOptions` contém as alternativas escolhidas pelo contato e `aggregate` apresenta o consolidado de votos por opção.

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
- `POST /instances/:id/send-media` - Enviar mídia (imagem, vídeo, áudio ou documento)
- `POST /instances/:id/send-poll` - Enviar enquete para um contato ou grupo
- `POST /instances/:id/exists` - Verificar se número existe no WhatsApp
- `GET /instances/:id/status` - Verificar status de mensagem

#### Grupos

- `GET /instances/:id/groups` - Listar grupos da instância

#### Métricas

- `GET /instances/:id/metrics` - Obter métricas detalhadas

##### `POST /instances/:id/send-media`

Envia arquivos de mídia para um contato ou grupo. Os parâmetros aceitos são:

- `type` (string, obrigatório): define o tipo da mídia. Valores aceitos: `image`, `video`, `audio`, `document`.
- `to` (string, obrigatório): número de destino no formato E.164 brasileiro (`55DDDNUMERO`).
- `media` (objeto, obrigatório): descreve o arquivo a ser enviado.
  - `base64`: conteúdo em base64. Aceita tanto a string crua quanto em formato Data URI (`data:image/jpeg;base64,...`).
  - `url`: alternativa para fazer o download do arquivo via HTTP/HTTPS.
  - `mimetype`: MIME type do arquivo (ex.: `image/jpeg`, `video/mp4`, `audio/mpeg`, `application/pdf`).
  - `fileName`: nome do arquivo (obrigatório para documentos; opcional nos demais tipos).
- `caption` (string, opcional): legenda a ser anexada à mídia.
- `waitAckMs` (number, opcional): tempo em milissegundos para aguardar o ACK da mensagem.

> **Limites:** uploads em base64 são limitados a 16 MB por mensagem. Para URLs, apenas protocolos `http` ou `https` são aceitos. Recomenda-se utilizar os MIME types suportados oficialmente pelo WhatsApp (`image/jpeg`, `image/png`, `video/mp4`, `audio/mpeg`, `application/pdf`, entre outros).

Exemplo de requisição:

```json
POST /instances/meu-bot/send-media
{
  "type": "image",
  "to": "5511999999999",
  "caption": "Confira o novo catálogo",
  "media": {
    "base64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD...",
    "fileName": "catalogo.jpg",
    "mimetype": "image/jpeg"
  },
  "waitAckMs": 5000
}
```

O endpoint retorna o `id` da mensagem enviada, o status informado pelo WhatsApp, além de metadados da mídia (`type`, `mimetype`, `fileName`, `size` e `source`).

### Modo Broker Minimalista

O modo broker é pensado para integrações server-to-server com o LeadEngine, mantendo o backend enxuto e orientado a filas HTTP. Para habilitar:

```bash
BROKER_MODE=true npm start
```

Quando ativo, as rotas legadas `/instances` e o dashboard são desabilitados. Os endpoints disponíveis ficam sob o prefixo `/broker`:

- `POST /broker/session/connect` — inicializa (ou reutiliza) a sessão declarada em `LEADENGINE_INSTANCE_ID` e retorna o status atual (incluindo QR se disponível).
- `POST /broker/session/logout` — encerra a sessão atual; envie `{ "wipe": true }` para remover o diretório em disco.
- `GET /broker/session/status` — consulta o estado e métricas básicas da sessão.
- `POST /broker/messages` — envia mensagens de texto; suporta `waitAckMs` para aguardar ACK e `timeoutMs` para sobrescrever o timeout padrão.
- `GET /broker/events` — lista eventos pendentes na fila HTTP (mensagens inbound/outbound e votos de enquete) com suporte a filtros (`instanceId`, `type`, `direction`).
- `POST /broker/events/ack` — confirma o consumo de eventos informando uma lista de IDs.

O endpoint `/health` passa a incluir a chave `queue` com estatísticas da fila (`pending`, `total`, `lastEventAt`, `lastAckAt`).

## Estrutura do Projeto

```
├── src/
│   ├── instanceManager.ts    # Gerenciamento de instâncias
│   ├── whatsapp.ts           # Integração com Baileys e serviços auxiliares
│   ├── utils.ts              # Funções utilitárias
│   ├── server.ts             # Servidor HTTP (Express)
│   ├── broker/               # Componentes do modo broker (event store)
│   ├── baileys/              # Serviços de mensagens e enquetes
│   ├── services/             # Camada de integração externa (webhook, lead mapper)
│   └── routes/
│       ├── broker.ts         # Rotas minimalistas para o LeadEngine
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
