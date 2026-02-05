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

## Mapa dos módulos do dashboard

As etapas de jornada descritas na revisão de UX (`docs/dashboard-ux-review.md`) agora estão refletidas em módulos ES6 separados. O diagrama abaixo ajuda a localizar os pontos de extensão por etapa:

- **Etapa 1 — Boot do dashboard e carregamento inicial**: `public/js/boot.js` orquestra a inicialização chamando `refreshInstances`, enquanto `public/js/state.js` e `public/js/api.js` concentram estado compartilhado, headers e utilitários usados pelos demais módulos.
- **Etapa 2 — Seleção e gerenciamento de instâncias**: `public/js/instances.js` é responsável por listar instâncias, construir cards e propagar atualizações para a instância selecionada.
- **Etapa 3 — Contexto da instância e notas**: `public/js/notes.js` cuida do autosave, metadados de criação/atualização e feedback visual do bloco de notas.
- **Etapa 4 — Métricas e gráfico de timeline**: `public/js/metrics.js` controla KPIs, gráfico do Chart.js e sincronização da instância ativa.
- **Etapa 5 — Ações de sessão e QR Code**: `public/js/sessionActions.js` agrega os handlers de logout/wipe/pair, modais e feedback do QR, reutilizando bloqueios definidos em `state.js`.
- **Etapa 6 — Envio rápido**: `public/js/quickSend.js` concentra validações de telefone/mensagem e o envio de texto imediato, mantendo o contador e feedback inline.
- **Logs recentes**: `public/js/logs.js` isola o carregamento incremental e a renderização dos eventos, consumido pelas etapas 4 e 5 para dar contexto operacional.

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

### Reverse proxy e Server-Sent Events

Se o serviço estiver atrás de um reverse proxy (Nginx, Traefik, Caddy, etc.), desative qualquer forma de buffering nas rotas SSE
 (`/stream`) para que os eventos sejam entregues imediatamente. No Nginx, por exemplo:

```nginx
location /stream {
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;
  proxy_cache off;
  add_header X-Accel-Buffering no;
}
```

Outros proxies devem aplicar as configurações equivalentes (desligar buffering/caching e manter a conexão aberta) para respeitar os
headers `Content-Type: text/event-stream`, `Cache-Control: no-cache` e `Connection: keep-alive` enviados pelo backend.

### Variáveis de Ambiente

- `PORT`: Porta do servidor (padrão: 3000)
- `API_KEY`: Chave de API para autenticação (obrigatório)
- `SESSION_DIR`: Diretório para armazenar sessões (padrão: ./sessions)
- `LOG_LEVEL`: Nível de log (padrão: info)
- `SERVICE_NAME`: Nome do serviço para logs (padrão: baileys-api)
- `WEBHOOK_URL`: URL para receber webhooks de eventos
- `WEBHOOK_API_KEY`: Chave para autenticar o webhook (padrão: `57c1acd47dc2524ab06dc4640443d755072565ebed06e1a7cc6d27ab4986e0ce`)
- `WEBHOOK_BEARER_TOKEN`: Token opcional para autenticação via header `Authorization: Bearer <token>`
- Logs de falha do webhook registram apenas status, mensagem e URL para evitar exposição de segredos
- `WEBHOOK_HMAC_SECRET`: Segredo opcional para assinar os eventos via HMAC
- `RATE_MAX_SENDS`: Máximo de mensagens por janela de tempo (padrão: 20)
- `RATE_WINDOW_MS`: Janela de tempo para rate limiting em ms (padrão: 15000)
- `SEND_TIMEOUT_MS`: Timeout padrão para envios ativos, aplicado tanto às rotas HTTP quanto ao `MessageService` (padrão: 25000)
- `POLL_STORE_TTL_MS`: Tempo de retenção das mensagens de enquete (padrão: 6h)
- `POLL_FEEDBACK_TEMPLATE`: Template opcional para resposta automática após voto em enquete
- `STATUS_TTL_MS`: Janela (ms) antes de limpar entregas finalizadas do cache interno (`10 minutos` por padrão)
- `STATUS_SWEEP_INTERVAL_MS`: Frequência (ms) de varredura para expirar status antigos (padrão: `60000`)
- `POLL_METADATA_ENCRYPTION_KEY`, `APP_ENCRYPTION_SECRET` e `APP_ENCRYPTION_KEY`: segredos opcionais para criptografar os metadados de enquetes em disco — defina ao menos um para preservar chaves entre reinícios
- `WEBHOOK_RETRY_FAST`: quando definido como `1`, desativa o backoff progressivo de tentativas de entrega (útil em testes locais)

### Webhooks

Defina `WEBHOOK_URL` (e opcionalmente substitua `WEBHOOK_API_KEY` / `WEBHOOK_HMAC_SECRET`) para receber eventos estruturados sempre que mensagens ou enquetes forem processadas.

#### Envelope e cabeçalhos

Cada chamada é um `POST` com `Content-Type: application/json` e os seguintes headers:

- `x-api-key`: enviado por padrão para compatibilidade. Usa `WEBHOOK_API_KEY` (ou o valor padrão `57c1acd47dc2524ab06dc4640443d755072565ebed06e1a7cc6d27ab4986e0ce`).
- `Authorization: Bearer <token>`: opcional. Enviado quando `WEBHOOK_BEARER_TOKEN` (ou `authToken` no construtor) é definido.
- `x-signature`: opcional. HMAC-SHA256 de `JSON.stringify(body)` usando `WEBHOOK_HMAC_SECRET` (ou, se ausente, o próprio `WEBHOOK_API_KEY`).

É possível combinar os headers: se o bearer estiver configurado ele será incluído junto ao `x-api-key`, que continua sendo utilizado também como fallback do segredo HMAC quando `WEBHOOK_HMAC_SECRET` não for informado.

O envelope padrão enviado é:

```json
{
  "event": "MESSAGE_INBOUND",
  "instanceId": "alan",
  "timestamp": 1760219145,
  "payload": { /* dados do evento */ }
}
```

- `instanceId` sempre utiliza o identificador público cadastrado no LeadEngine.
- `timestamp` é um Unix epoch em segundos.

#### Estrutura comum do contato e metadados

Todo payload de mensagem inclui o bloco `contact`:

```json
"contact": {
  "owner": "device | user | server",
  "remoteJid": "554499999999@s.whatsapp.net",
  "participant": "554499999999@s.whatsapp.net",
  "phone": "+554499999999",
  "displayName": "Nome visível",
  "isGroup": false
}
```

- `owner` indica a origem lógica (`device` para mensagens enviadas pela instância, `user` para contatos/grupos externos, `server` quando não é possível inferir).
- `phone` segue o formato E.164 (com `+`). Quando não for possível extrair o número, o campo virá como `null`.
- `isGroup` fica `true` quando `remoteJid` termina com `@g.us`.

##### Identificadores LID e mapeamento PN↔LID

- A partir da API 7.x, o WhatsApp tende a expor `remoteJid`/`participant` no namespace `@lid` para conversas protegidas. O backend preserva esse valor bruto em `contact.remoteJid`, e o dashboard exibe exatamente o que o socket Baileys informa (`instance.user.id`).
- O campo `phone` é derivado tentando remover o domínio do JID e normalizando para E.164; isso funciona para JIDs `@s.whatsapp.net` e para participantes de grupos, mas JIDs puramente `@lid` permanecem como `null`.
- Para enquetes e recibos, o `PollService` coleta pistas de recibos (`lid`, `participant`, `remoteJid`) e gera combinações equivalentes entre `@lid` e `@s.whatsapp.net` antes de tentar descriptografar votos. Essa heurística também registra nos logs qual versão foi aceita, ajudando a mapear um LID ao respectivo PN quando disponível.
- Eventos `WHATSAPP_MESSAGES_UPDATE` carregam os recibos crus do Baileys (incluindo `lid`/`senderLid`), permitindo que integrações persistam o relacionamento PN↔LID conforme necessário.

Os blocos `metadata` trazem a procedência do evento:

```json
"metadata": {
  "timestamp": "2023-11-14T22:13:20.000Z",
  "broker": { "type": "baileys", "direction": "inbound" },
  "source": "baileys-acessus"
}
```

#### Exemplos de eventos

Mensagem recebida (`MESSAGE_INBOUND`):

```json
{
  "event": "MESSAGE_INBOUND",
  "instanceId": "alan",
  "timestamp": 1760219145,
  "payload": {
    "contact": {
      "owner": "user",
      "remoteJid": "554499999999@s.whatsapp.net",
      "participant": null,
      "phone": "+554499999999",
      "displayName": "João",
      "isGroup": false
    },
    "message": {
      "id": "wamid-1001",
      "chatId": "554499999999@s.whatsapp.net",
      "type": "text",
      "text": "Olá, preciso de ajuda"
    },
    "metadata": {
      "timestamp": "2024-10-11T22:45:45.000Z",
      "broker": { "type": "baileys", "direction": "inbound" },
      "source": "baileys-acessus"
    }
  }
}
```

### Pipedrive (Messaging App Extension)

Esta integração expõe os endpoints exigidos pelo **Messaging App Extension** do Pipedrive e sincroniza mensagens em **dual‑mode**:

- **Channels API v1** (Messaging App Extension) quando disponível.
- **Fallback via Notes (v1) + Persons (v2)** quando a Channels API falhar/estiver indisponível ou quando `PIPEDRIVE_CHANNELS_MODE=v2`.

> **Importante**: quando estiver em **fallback via Notes**, as mensagens **não aparecem** em **Leads → Messaging** do Pipedrive. Elas são registradas como **Notes** na **Pessoa (People → Person → Notes)**. Para validar, procure a pessoa pelo telefone e confira as Notes.

> **Aviso**: a Channels API foi descontinuada em **1º de fevereiro de 2026**. Em `PIPEDRIVE_CHANNELS_MODE=dual`, falhas de Channels acionam o fallback automaticamente.

#### 0) Pré-requisitos básicos

0.1) Garanta acesso ao npm registry (para instalar `multer`)

Comando padrão:

```bash
npm install
```

Se falhar por proxy, configure registry/proxy e tente novamente:

```bash
npm config set registry https://registry.npmjs.org/
# se necessário:
# npm config set proxy http://SEU_PROXY:PORT
# npm config set https-proxy http://SEU_PROXY:PORT
npm install
```

0.2) (Opcional) Instale `jq` para validar JSON via terminal.

#### 1) Variáveis de ambiente (Render + local)

1.1) Em produção (Render)

Configure no painel do Render (Settings → Environment):

```
PIPEDRIVE_ENABLED=1
PIPEDRIVE_CHANNELS_MODE=dual
PIPEDRIVE_OAUTH_SCOPE=channels:full persons:full notes:full webhooks:full
PIPEDRIVE_API_BASE_URL_V1=https://api.pipedrive.com/v1
PIPEDRIVE_API_BASE_URL_V2=https://api.pipedrive.com/api/v2
PIPEDRIVE_FALLBACK_NOTES_ENABLED=1
PIPEDRIVE_FALLBACK_CREATE_PERSON=1
PIPEDRIVE_CLIENT_ID=<PIPEDRIVE_CLIENT_ID>
PIPEDRIVE_CLIENT_SECRET=<PIPEDRIVE_CLIENT_SECRET>
PIPEDRIVE_PUBLIC_BASE_URL=<BASE_URL>
PIPEDRIVE_REDIRECT_URI=<BASE_URL>/pipedrive/oauth/callback
PIPEDRIVE_PROVIDER_TYPE=whatsapp
PIPEDRIVE_TEMPLATE_SUPPORT=0
API_KEY=<API_KEY>
```

Importante: ajuste o Redirect URI no Pipedrive também para `/pipedrive/oauth/callback`.

Notas rápidas:
- `PIPEDRIVE_CHANNELS_MODE=dual`: tenta Channels e faz fallback via Notes automaticamente.
- `PIPEDRIVE_CHANNELS_MODE=channels`: força Channels (sem fallback).
- `PIPEDRIVE_CHANNELS_MODE=v2`: não usa Channels; envia tudo via Notes.

1.2) Local (`.env`)

Se quiser testar localmente, crie `.env`:

```bash
cat <<'EOF' > .env
PORT=3000
API_KEY=<API_KEY>

PIPEDRIVE_ENABLED=1
PIPEDRIVE_CHANNELS_MODE=dual
PIPEDRIVE_OAUTH_SCOPE=channels:full persons:full notes:full webhooks:full
PIPEDRIVE_API_BASE_URL_V1=https://api.pipedrive.com/v1
PIPEDRIVE_API_BASE_URL_V2=https://api.pipedrive.com/api/v2
PIPEDRIVE_FALLBACK_NOTES_ENABLED=1
PIPEDRIVE_FALLBACK_CREATE_PERSON=1
PIPEDRIVE_CLIENT_ID=<PIPEDRIVE_CLIENT_ID>
PIPEDRIVE_CLIENT_SECRET=<PIPEDRIVE_CLIENT_SECRET>
PIPEDRIVE_PUBLIC_BASE_URL=http://localhost:3000
PIPEDRIVE_REDIRECT_URI=http://localhost:3000/pipedrive/oauth/callback
PIPEDRIVE_PROVIDER_TYPE=whatsapp
PIPEDRIVE_TEMPLATE_SUPPORT=0
EOF
```

#### 2) Manifest (validação rápida)

Comando:

```bash
curl -s <BASE_URL>/pipedrive/manifest.json | jq .
```

Esperado:

- `provider_type: "whatsapp"`
- endpoints com `/pipedrive/channels/...`

Se falhar, o app não está rodando ou a base URL está incorreta.

#### 3) OAuth (passo a passo completo)

3.1) Gere a URL de autorização (via endpoint do app)

```bash
curl -s "<BASE_URL>/pipedrive/oauth/start" | jq .
```

Resposta esperada:

```json
{ "url": "https://oauth.pipedrive.com/oauth/authorize?..." }
```

Obs: o endpoint também pode retornar `warnings` quando o `PIPEDRIVE_OAUTH_SCOPE` parece insuficiente para Channels/Notes/Webhooks.

3.2) Abra a URL no navegador

Ela deve levar ao Pipedrive para autorizar.

3.3) Após autorizar, você será redirecionado para:

```
<BASE_URL>/pipedrive/oauth/callback?code=XXXX
```

Confirme que a resposta é:

```json
{ "success": true, "data": { ... } }
```

Se retornar erro, confira:

- `redirect_uri` cadastrado no Pipedrive
- `PIPEDRIVE_CLIENT_ID` e `PIPEDRIVE_CLIENT_SECRET`
- app reiniciado com as envs corretas

#### 4) Registrar canal no Pipedrive (admin)

Usa `x-api-key` (sua `API_KEY` interna).

```bash
curl -s -X POST "<BASE_URL>/pipedrive/admin/register-channel" \
  -H "content-type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{
    "providerChannelId": "<INSTANCE_ID>",
    "name": "WhatsApp - <INSTANCE_ID>"
  }' | jq .
```

Se retorno for `success: true`, o canal foi registrado. Em `PIPEDRIVE_CHANNELS_MODE=dual`, se a Channels API falhar, o endpoint pode retornar `success: true` com `warning` e o fluxo seguirá via Notes (fallback).

Dica rápida: quando o retorno vier com `data.id` iniciando com `fallback:`, o modo ativo é **Notes** (não Channels). Nesse caso, valide no Pipedrive em **People → Person → Notes** (procure pelo telefone).

#### 4.1) Desregistrar canal (admin)

Remove o vínculo do canal desta instância (e tenta remover também no Pipedrive quando possível).

```bash
curl -s -X POST "<BASE_URL>/pipedrive/admin/unregister-channel" \
  -H "content-type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{
    "providerChannelId": "<INSTANCE_ID>",
    "deleteRemote": true
  }' | jq .
```

#### 5) Testar envio via postMessage (Pipedrive → seu sistema)

Esse endpoint é chamado pelo Pipedrive usando **Basic Auth** com `client_id:client_secret`.

5.1) Enviar mensagem de texto

```bash
curl -s -X POST \
  "<BASE_URL>/pipedrive/channels/<INSTANCE_ID>/conversations/55DDDNUMERO@s.whatsapp.net/messages" \
  -H "Authorization: Basic $(printf '<PIPEDRIVE_CLIENT_ID>:<PIPEDRIVE_CLIENT_SECRET>' | base64)" \
  -F "senderId=source:<INSTANCE_ID>" \
  -F "recipientIds[]=55DDDNUMERO@s.whatsapp.net" \
  -F "message=Teste de mensagem via Pipedrive"
```

Observações:

- Use o número real no formato WhatsApp JID (`55DDDNUMERO@s.whatsapp.net`).
- Se quiser usar só o número (E.164), o backend tenta converter. **A normalização é BR**: prefixa `55` e aceita 10–11 dígitos.

5.2) Enviar mensagem com anexo

```bash
curl -s -X POST \
  "<BASE_URL>/pipedrive/channels/<INSTANCE_ID>/conversations/55DDDNUMERO@s.whatsapp.net/messages" \
  -H "Authorization: Basic $(printf '<PIPEDRIVE_CLIENT_ID>:<PIPEDRIVE_CLIENT_SECRET>' | base64)" \
  -F "senderId=source:<INSTANCE_ID>" \
  -F "recipientIds[]=55DDDNUMERO@s.whatsapp.net" \
  -F "message=Segue o arquivo" \
  -F "file=@/caminho/arquivo.pdf"
```

#### 6) Validar conversa retornada (getConversations)

Você pode simular:

```bash
curl -s \
  "<BASE_URL>/pipedrive/channels/<INSTANCE_ID>/conversations?limit=10&messages_limit=10" \
  -H "Authorization: Basic $(printf '<PIPEDRIVE_CLIENT_ID>:<PIPEDRIVE_CLIENT_SECRET>' | base64)" | jq .
```

Se houver paginação, o retorno inclui `additional_data.after`.

#### 7) Webhooks v2 + Automação (opcional)

7.1) Configurar credenciais do receiver (Basic Auth)

Defina no ambiente:

```
PIPEDRIVE_WEBHOOK_USER=<USER>
PIPEDRIVE_WEBHOOK_PASS=<PASS>
PIPEDRIVE_WEBHOOK_EVENTS=deal,activity,person,organization
```

7.2) Assinar webhooks (admin)

```bash
curl -s -X POST "<BASE_URL>/pipedrive/admin/webhooks/subscribe" \
  -H "content-type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{}' | jq .
```

7.3) Ver status (admin)

```bash
curl -s "<BASE_URL>/pipedrive/admin/webhooks/status" \
  -H "x-api-key: <API_KEY>" | jq .
```

Notas:
- O receiver é `POST <BASE_URL>/pipedrive/webhooks` (chamado pelo Pipedrive).
- Eventos recebidos ficam em `data/pipedrive-webhooks.json`.

7.4) Automação (envio WhatsApp)

Para disparar alertas por WhatsApp em eventos de `deal` e `activity`:

```
PIPEDRIVE_AUTOMATION_INSTANCE_ID=<INSTANCE_ID>
PIPEDRIVE_AUTOMATION_TEMPLATE_DEAL_STAGE=Seu template {{object}} {{action}} ({{person.name}})
PIPEDRIVE_AUTOMATION_TEMPLATE_ACTIVITY=Seu template {{object}} {{action}} ({{person.name}})
```

#### 8) BI / Métricas (admin)

```bash
curl -s "<BASE_URL>/pipedrive/admin/metrics" \
  -H "x-api-key: <API_KEY>" | jq .
```

Export:

```bash
curl -s "<BASE_URL>/pipedrive/admin/metrics/export?format=csv&download=1" \
  -H "x-api-key: <API_KEY>"
```

As métricas ficam em `data/pipedrive-metrics.json`.

#### 9) Erros comuns (e como corrigir)

- `401 unauthorized`: Basic Auth errado (`client_id:secret`).
- `pipedrive_not_configured`: faltam `PIPEDRIVE_CLIENT_ID/SECRET`.
- `register_channel_failed`: OAuth não realizado ou token não salvo.
- `pipedrive_webhook_not_configured`: faltam `PIPEDRIVE_WEBHOOK_USER/PASS`.
- `instance_unavailable`: instância WhatsApp não conectada.
- `group_conversations_not_supported`: use contato 1:1 (`@g.us` não suportado).
- `senderId_and_recipientIds_required`: faltam `senderId` ou `recipientIds[]`.
- `message_or_attachments_required`: faltam `message` e `file`.

Notas:
- As chamadas do Pipedrive para os endpoints do manifest usam **Basic Auth** com o `client_id` e `client_secret`.
- Conversas de grupo (`@g.us`) são ignoradas, pois a Channels API suporta apenas 1:1.
- Os dados locais ficam em `data/pipedrive-*.json`.

Mensagem enviada (`MESSAGE_OUTBOUND`):

```json
{
  "event": "MESSAGE_OUTBOUND",
  "instanceId": "alan",
  "timestamp": 1760219146,
  "payload": {
    "contact": { /* mesmo formato descrito acima */ },
    "message": {
      "id": "wamid-1002",
      "chatId": "554499999999@s.whatsapp.net",
      "type": "media",
      "text": "Segue o catálogo",
      "media": {
        "mediaType": "image",
        "mimetype": "image/jpeg",
        "fileName": "catalogo.jpg",
        "size": 234567,
        "caption": "Segue o catálogo"
      }
    },
    "metadata": {
      "timestamp": "2024-10-11T22:45:46.000Z",
      "broker": { "type": "baileys", "direction": "outbound" },
      "source": "baileys-acessus"
    }
  }
}
```

Voto em enquete (`POLL_CHOICE`):

```json
{
  "event": "POLL_CHOICE",
  "instanceId": "alan",
  "timestamp": 1760219150,
  "payload": {
    "pollId": "poll-abc",
    "question": "Qual produto?",
    "chatId": "556299999999@g.us",
    "messageId": "BAE5F1F0E6C9",
    "timestamp": "2024-10-11T22:45:46.000Z",
    "voterJid": "556288888888@s.whatsapp.net",
    "selectedOptions": [{ "id": "p1", "text": "Produto A" }],
    "optionsAggregates": [
      { "id": "p1", "text": "Produto A", "votes": 3 },
      { "id": "p2", "text": "Produto B", "votes": 1 }
    ],
    "aggregates": {
      "totalVoters": 3,
      "totalVotes": 4,
      "optionTotals": [
        { "id": "p1", "text": "Produto A", "votes": 3 },
        { "id": "p2", "text": "Produto B", "votes": 1 }
      ]
    },
    "contact": { /* dados do votante */ }
  }
}
```

O campo `aggregates` resume os totais atuais da enquete, indicando o número total de votantes (`totalVoters`), de votos computados (`totalVotes`) e repetindo os totais por opção em `optionTotals` para facilitar a transição de integrações que ainda utilizam `optionsAggregates`.

Eventos brutos do Baileys (`WHATSAPP_MESSAGES_UPSERT` / `WHATSAPP_MESSAGES_UPDATE`) mantêm o payload no formato:

```json
{
  "iid": "alan",
  "raw": { /* evento original emitido pelo Baileys */ }
}
```

#### Endpoint de exemplo

Execute `npm run example:poll-webhook` para iniciar um receptor Express que valida API key e assinatura `x-signature` com o mesmo segredo do emissor:

```ts
import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import pino from 'pino';

const app = express();
const PORT = Number(process.env.WEBHOOK_PORT ?? process.env.PORT ?? 3001);
const EXPECTED_API_KEY = process.env.WEBHOOK_API_KEY;
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? EXPECTED_API_KEY ?? null;
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'poll-webhook-example' } });

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = Buffer.from(buf);
    },
  }),
);

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.post('/webhooks/baileys', (req, res) => {
  if (EXPECTED_API_KEY && req.header('x-api-key') !== EXPECTED_API_KEY) {
    logger.warn({ ip: req.ip }, 'webhook.invalid_api_key');
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  if (HMAC_SECRET) {
    const rawBody: Buffer = (req as any).rawBody ?? Buffer.from('');
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(rawBody).digest('hex');
    const received = req.header('x-signature');
    if (!received || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
      logger.warn({ ip: req.ip, expected, received }, 'webhook.signature.mismatch');
      return res.status(401).json({ error: 'invalid_signature' });
    }
  }

  const { event, timestamp, payload } = req.body ?? {};
  logger.info({ event, timestamp, payload }, 'webhook.event.received');
  return res.sendStatus(204);
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'webhook.server.listening');
});
```

Publique o endpoint e informe a URL em `WEBHOOK_URL` (ex.: `https://sua-api.com/webhooks/baileys`).

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
- `GET /instances/:id/events` - Listar eventos pendentes da instância (`limit`, `after`, `direction`, `type`)
- `POST /instances/:id/events/ack` - Confirmar consumo de eventos informando os IDs recebidos

#### Estrutura dos eventos `MESSAGE_INBOUND` e `MESSAGE_OUTBOUND`

Os eventos disparados pelo webhook e disponíveis no `eventStore` compartilham a mesma estrutura de payload (contato, mensagem e metadados):

```json
{
  "contact": {
    "owner": "user",
    "remoteJid": "5511987654321@s.whatsapp.net",
    "participant": null,
    "phone": "+5511987654321",
    "displayName": "Maria da Silva",
    "isGroup": false
  },
  "message": {
    "id": "ABC123",
    "chatId": "5511987654321@s.whatsapp.net",
    "type": "text",
    "text": "Olá! Tudo bem?"
  },
  "metadata": {
    "timestamp": "2023-11-14T22:13:20.000Z",
    "broker": {
      "direction": "inbound",
      "type": "baileys"
    },
    "source": "baileys-acessus"
  }
}
```

Para mensagens com mídia, o bloco `message` inclui o objeto `media` com detalhes como `mediaType`, `caption`, `mimetype`, `fileName` e `size`.

#### Autenticação

- `GET /instances/:id/qr.png` - Obter QR code como imagem
- `POST /instances/:id/pair` - Solicitar código de pareamento
- `POST /instances/:id/logout` - Desconectar sessão

##### Solicitar código de pareamento (`POST /instances/:id/pair`)

- Envie `{ "phoneNumber": "55DDDNUMERO" }` quando a instância estiver conectada ou em `connecting`. O backend valida o formato, persiste o telefone e retorna `pairingCode` direto do Baileys.
- Após definir `phoneNumber`, o runtime tenta regenerar códigos automaticamente sempre que o socket indicar `qr refs attempts ended` ou timeouts semelhantes, evitando intervenção manual.
- Para revogar o pareamento armazenado, use `POST /instances/:id/session/wipe` ou atualize o telefone com um novo POST `/instances/:id/pair`.

#### Mensagens

- `POST /instances/:id/send-text` - Enviar mensagem de texto
- `POST /instances/:id/send-buttons` - Enviar botões de resposta rápida
- `POST /instances/:id/send-list` - Enviar lista interativa com seções/opções
- `POST /instances/:id/send-media` - Enviar mídia (imagem, vídeo, áudio ou documento)
- `POST /instances/:id/send-poll` - Enviar enquete para um contato ou grupo
- `POST /instances/:id/exists` - Verificar se número existe no WhatsApp
- `GET /instances/:id/status` - Verificar status de mensagem

##### Enviar botões interativos (`POST /instances/:id/send-buttons`)

Envie até **3 botões de resposta rápida** para um contato usando `templateButtons` do Baileys. O corpo deve conter:

```json
{
  "to": "5511999999999",
  "text": "Escolha uma opção:",
  "options": [
    { "id": "opt-1", "title": "Primeira opção" },
    { "id": "opt-2", "title": "Segunda opção" }
  ],
  "footer": "Texto opcional"
}
```

- `to` deve estar no formato E.164 (ex.: `55DDDNUMERO`).
- `text` é obrigatório e será exibido como corpo da mensagem.
- `options` é obrigatório, aceita de 1 a 3 itens com campos `id` (único) e `title`.
- `footer` é opcional e aparece abaixo dos botões.
- A resposta da API é enviada imediatamente após o Baileys confirmar o envio da mensagem.

Resposta típica:

```json
{
  "id": "BAE5...",
  "messageId": "BAE5...",
  "status": 1
}
```

O campo `status` reflete o último código retornado pelo Baileys no momento da escrita da mensagem (ex.: `1` para "pendente"). Não há mais espera automática por ACK — acompanhe a evolução pela rota `GET /instances/:id/status?id=<messageId>` ou pelo webhook `WHATSAPP_MESSAGES_UPDATE`, que avisam quando o WhatsApp promove a mensagem para os status `2` (servidor recebeu), `3` (entregue), `4` (lida) ou `5` (reproduzida).

##### Enviar listas interativas (`POST /instances/:id/send-list`)

Monte menus com seções usando mensagens do tipo `list` do Baileys. Exemplo de requisição:

```json
{
  "to": "5511999999999",
  "text": "Selecione um item do cardápio:",
  "buttonText": "Ver opções",
  "title": "Cardápio do dia",
  "footer": "Valores sujeitos a alteração",
  "sections": [
    {
      "title": "Bebidas quentes",
      "options": [
        { "id": "espresso", "title": "Espresso" },
        { "id": "latte", "title": "Latte", "description": "Com leite vaporizado" }
      ]
    },
    {
      "title": "Sobremesas",
      "options": [
        { "id": "cheesecake", "title": "Cheesecake" }
      ]
    }
  ]
}
```

- `buttonText` define o rótulo do botão que abre a lista.
- Cada seção pode ter um `title` opcional e precisa de pelo menos uma opção.
- Cada opção exige `id` (único dentro da mensagem) e `title`; `description` é opcional e aparece como legenda.
- `text`, `footer` e `title` são exibidos como corpo, rodapé e cabeçalho da mensagem, respectivamente.
- A confirmação do endpoint ocorre assim que o envio é aceito pelo WhatsApp.

Resposta:

```json
{
  "id": "BAE6...",
  "messageId": "BAE6...",
  "status": 1
}
```

`messageId` é sempre retornado como alias de `id` e deve ser usado para consultar a entrega como descrito acima.

###### Monitorar entrega

- `GET /instances/:id/status?id=<messageId>` retorna o status mais recente armazenado na instância para o ID informado (ou `null` quando expirado). Os códigos seguem a escala oficial do WhatsApp: `1` pendente, `2` servidor recebeu, `3` entregue, `4` lida e `5` reproduzida.
- Webhooks `WHATSAPP_MESSAGES_UPDATE` e o event store `/instances/:id/events` emitem as mesmas transições em tempo real — use-os para reagir a lidas/entregas sem polling.
- O dashboard consolida esses valores em `counters.statusCounts` e na timeline de métricas. Por padrão, itens finalizados permanecem disponíveis por até `STATUS_TTL_MS` (10 minutos, ajustável).

#### Grupos

- `GET /instances/:id/groups` - Listar grupos da instância
- `POST /instances/:id/groups` - Criar novo grupo a partir da instância conectada
- `POST /instances/:id/groups/:gid/members` - Adicionar participantes em um grupo existente
- `DELETE /instances/:id/groups/:gid/members` - Remover participantes de um grupo existente

##### Criar grupo (`POST /instances/:id/groups`)

**Requisitos**

- A instância deve estar conectada no WhatsApp.
- Informe `subject` (nome do grupo) e `participants` (array com números brasileiros no formato `55DDDNUMERO`).
- A instância será adicionada automaticamente como administradora.

**Exemplo de payload**

```json
{
  "subject": "Equipe Comercial",
  "participants": ["5511999999999", "5551988887777"]
}
```

**Resposta**

```json
{
  "id": "120363025043304321@g.us",
  "subject": "Equipe Comercial",
  "creation": 1714589667,
  "owner": "5511987654321@whatsapp.net",
  "size": 3,
  "participants": [
    {
      "jid": "5511987654321@whatsapp.net",
      "phone": "5511987654321",
      "isAdmin": true,
      "isSuperAdmin": true
    }
  ]
}
```

##### Adicionar participantes (`POST /instances/:id/groups/:gid/members`)

**Requisitos**

- A instância deve ser administradora do grupo informado.
- `gid` pode ser informado com ou sem o sufixo `@g.us` (ex.: `120363025043304321` ou `120363025043304321@g.us`).
- O corpo deve conter `participants` com números brasileiros válidos (`55DDDNUMERO`).

**Exemplo de payload**

```json
{
  "participants": ["5511999999999", "5551988887777"]
}
```

**Resposta**

```json
{
  "status": "partial",
  "message": "Alguns participantes não puderam ser adicionados.",
  "results": [
    {
      "jid": "5511999999999@whatsapp.net",
      "phone": "5511999999999",
      "status": 200,
      "rawStatus": "200",
      "success": true,
      "message": "ok",
      "systemMessageId": "A1B2C3"
    },
    {
      "jid": "5551988887777@whatsapp.net",
      "phone": "5551988887777",
      "status": 403,
      "rawStatus": "403",
      "success": false,
      "message": "instância não é administradora ou não possui permissão para esta ação",
      "systemMessageId": null
    }
  ]
}
```

Quando todos os participantes são adicionados, a resposta traz `status: "success"` com HTTP 200. Se nenhum for adicionado, a resposta retorna HTTP 400 com `status: "error"`.

##### Remover participantes (`DELETE /instances/:id/groups/:gid/members`)

**Requisitos**

- A instância deve ser administradora do grupo informado.
- Informe `gid` com ou sem o sufixo `@g.us`.
- O corpo deve conter `participants` com números brasileiros válidos (`55DDDNUMERO`).

**Exemplo de payload**

```json
{
  "participants": ["5511999999999"]
}
```

**Resposta**

```json
{
  "status": "success",
  "message": "Participantes removidos do grupo com sucesso.",
  "results": [
    {
      "jid": "5511999999999@whatsapp.net",
      "phone": "5511999999999",
      "status": 200,
      "rawStatus": "200",
      "success": true,
      "message": "ok",
      "systemMessageId": "XYZ123"
    }
  ]
}
```

Se algum participante não puder ser removido, o endpoint retorna `status: "partial"` (HTTP 207) com detalhes linha a linha.

#### Métricas

- `GET /instances/:id/metrics` - Obter métricas detalhadas

#### Consumo de eventos via HTTP

Consuma os eventos estruturados gerados pela instância atual usando `GET /instances/:id/events`. O endpoint permite filtrar por
`direction` (`inbound`, `outbound` ou `system`) e/ou `type` conforme necessário e retorna também o `nextCursor` (ID do último
evento listado) para paginação incremental.

Os eventos permanecem na fila até serem confirmados. Após processá-los, envie `POST /instances/:id/events/ack` com o array `ids`
retornado na listagem. Eventos reconhecidos deixam de ser entregues em chamadas futuras; IDs desconhecidos são retornados em
`missing`. Enquanto o ACK não for enviado, os eventos continuam disponíveis e podem ser reenviados em caso de falhas.
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
  }
}
```

O endpoint retorna o `id` da mensagem enviada, o status informado pelo WhatsApp e metadados da mídia (`type`, `mimetype`, `fileName`, `size` e `source`). Mensagens com mídia seguem o mesmo fluxo de entrega assíncrona descrito em [Monitorar entrega](#monitorar-entrega).

## Estrutura do Projeto


```
├── src/
│   ├── instanceManager.ts    # Gerenciamento de instâncias
│   ├── whatsapp.ts           # Integração com Baileys e serviços auxiliares
│   ├── utils.ts              # Funções utilitárias
│   ├── server.ts             # Servidor HTTP (Express)
│   ├── broker/               # Fila de eventos HTTP compartilhada
│   ├── baileys/              # Serviços de mensagens e enquetes
│   ├── services/             # Camada de integração externa (webhook, lead mapper)
│   └── routes/
│       └── instances.ts      # Rotas da API HTTP
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
