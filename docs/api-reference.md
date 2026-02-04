# Baileys AcessusWPP API - Contratos e Fluxos

Este documento descreve a API HTTP, SSE, webhooks, contratos de payload e fluxos operacionais.

## Visao geral

- Backend: Express + Baileys (WhatsApp).
- Frontend: dashboard estatico em `public/`.
- Recursos chave: multiplas instancias, envio de mensagens, QR/pairing, metrics, eventos, webhooks.
- Persistencia de sessao: arquivos em `SESSION_DIR`.

## Autenticacao

- Todas as rotas em `/instances/*` exigem `X-API-Key` valido.
- A chave pode vir tambem por query: `?apiKey=...` (usado no SSE de instancias).
- `API_KEY` pode conter multiplas chaves separadas por virgula.

## Headers e formato

- `Content-Type: application/json` para requests JSON.
- Respostas JSON por padrao (exceto PNG, CSV, SSE).

## Erros comuns

Resposta tipica:
```json
{ "error": "codigo", "detail": "mensagem" }
```

- 401: `{ "error": "unauthorized" }`
- 404: `{ "error": "instance_not_found" }`
- 503: `{ "error": "instance_offline", "state": "open|close|connecting|qr_timeout", "updatedAt": "ISO" }`
- 429: `{ "error": "rate limit exceeded" }`

## Objetos comuns

### InstanceSnapshot
Campos principais (resumo):
- `id`, `name`, `connected`, `connectionState`, `connectionUpdatedAt`
- `connectionStateDetail`: `{ statusCode, reason, isLoggedOut, isTimedOut } | null`
- `user`: info do Baileys quando conectado
- `qrVersion`, `hasLastQr`, `qrReceivedAt`, `qrExpiresAt`
- `pairingAttempts`, `lastError`, `hasStoredPhone`
- `note`, `metadata: { note, createdAt, updatedAt, revisions[] }`
- `counters`: `{ sent, byType, statusCounts, statusAggregated, inFlight }`
- `last`: `{ sentId, lastStatusId, lastStatusCode }`
- `rate`: `{ limit, windowMs, inWindow, usage }`
- `metricsStartedAt`, `revisions`
- `risk`: RiskSnapshot
- `network`: NetworkConfig
- `pairedAt`
- `queue`: `{ enabled }`

### RiskSnapshot
```json
{
  "config": { "threshold": 0.7, "interleaveEvery": 5, "safeContacts": ["5511999999999"] },
  "runtime": { "ratio": 0.3, "unknown": 10, "known": 20, "responses": 5, "paused": false }
}
```

### NetworkConfig
```json
{
  "proxyUrl": "http://user:pass@host:port",
  "ip": "1.2.3.4",
  "asn": "AS123",
  "isp": "ISP",
  "latencyMs": 120,
  "status": "ok|blocked|failed|unknown",
  "blockReason": "proxy_blocked_datacenter",
  "lastCheckAt": 1730000000000,
  "validatedAt": 1730000000000
}
```

### BrokerEvent (event store / SSE)
```json
{
  "id": "uuid",
  "sequence": 123,
  "instanceId": "inst-1",
  "direction": "inbound|outbound|system",
  "type": "MESSAGE_INBOUND|MESSAGE_OUTBOUND|POLL_CHOICE|WEBHOOK_DELIVERY|QUICK_SEND_RESULT|...",
  "payload": { "...": "..." },
  "createdAt": 1730000000000,
  "acknowledged": false,
  "delivery": { "state": "pending|retry|success|failed", "attempts": 0, "lastAttemptAt": null }
}
```

## SSE

### GET /stream (global)
- Sem auth.
- Envia `broker:event` (payload = BrokerEvent) e `ping`.
- Suporta `Last-Event-ID` para backlog.

### GET /instances/events?apiKey=...&iid=...
- SSE especifico de instancias.
- Evento `instance`:
```json
{
  "type": "connection|qr|pairing|error|metadata",
  "reason": "connection|qr|pairing|error|metadata",
  "detail": { "...": "..." },
  "instance": { "...InstanceSnapshot" }
}
```

## Webhooks (saida do sistema)

### Configuracao
- `WEBHOOK_URL` (obrigatorio para habilitar).
- `WEBHOOK_API_KEY` (default interno).
- `WEBHOOK_BEARER_TOKEN` (opcional).
- `WEBHOOK_HMAC_SECRET` (opcional; se ausente, usa API_KEY para assinatura).

### Headers enviados
- `x-api-key: <WEBHOOK_API_KEY>`
- `Authorization: Bearer <WEBHOOK_BEARER_TOKEN>` (se configurado)
- `x-signature: <hmac-sha256>` sobre o body

### Envelope padrao
```json
{
  "event": "MESSAGE_INBOUND",
  "instanceId": "inst-1",
  "timestamp": 1760219145,
  "payload": { "..." }
}
```

### Eventos principais
- `MESSAGE_INBOUND`
- `MESSAGE_OUTBOUND`
- `POLL_CHOICE`
- `WHATSAPP_MESSAGES_UPSERT` (raw + normalized)
- `WHATSAPP_MESSAGES_UPDATE` (raw updates)

### Payload de mensagem (inbound/outbound)
```json
{
  "contact": {
    "owner": "device|user|server",
    "remoteJid": "5511999999999@s.whatsapp.net",
    "participant": null,
    "phone": "+5511999999999",
    "displayName": "Nome",
    "isGroup": false
  },
  "message": {
    "id": "wamid-123",
    "chatId": "5511999999999@s.whatsapp.net",
    "type": "text|media|buttons|list|poll|...",
    "text": "...",
    "interactive": { "type": "buttons|list|interactive_response", "...": "..." },
    "media": { "mediaType": "image|video|audio|document", "mimetype": "...", "fileName": "...", "size": 123 }
  },
  "metadata": {
    "timestamp": "2025-01-01T00:00:00.000Z",
    "broker": { "type": "baileys", "direction": "inbound|outbound" },
    "source": "baileys-acessus",
    "pollChoice": null
  }
}
```

## Endpoints HTTP

### Health

#### GET /health
Resposta:
```json
{
  "status": "ok",
  "uptime": 123.45,
  "instances": [ { "id": "inst-1", "connected": true, "connectionState": "open", "connectionUpdatedAt": "ISO" } ],
  "queue": { "pending": 0, "total": 0, "lastEventAt": null, "lastAckAt": null },
  "proxyMetrics": { "total": 0, "ok": 0, "blocked": 0, "failed": 0, "avgLatencyMs": null, "lastError": null }
}
```

### Instancias

#### POST /instances
Body:
```json
{ "name": "Minha Instancia", "note": "opcional" }
```
Resposta:
```json
{ "id": "inst-id", "name": "Minha Instancia", "dir": "...", "metadata": { "note": "", "createdAt": "ISO", "updatedAt": "ISO", "revisions": [] } }
```
Erros: `409 instance_exists`.

#### GET /instances
Resposta: array de instancias (resumo com counters, rate, risk, network, queue).

#### GET /instances/:iid
Resposta: InstanceSnapshot completo.

#### PATCH /instances/:iid
Body (parcial):
```json
{ "name": "Novo Nome", "note": "nova nota" }
```
Resposta: InstanceSnapshot atualizado.
Erros: `name_invalid`, `name_empty`, `note_invalid`, `no_updates`.

#### DELETE /instances/:iid
Resposta:
```json
{ "ok": true, "message": "..." }
```
Erros: `default_instance_cannot_be_deleted`.

### Sessao e QR

#### GET /instances/:iid/qr.png
- `200` PNG
- `204` sem QR

#### POST /instances/:iid/pair
Body:
```json
{ "phoneNumber": "55DDDNUMERO" }
```
Resposta:
```json
{ "pairingCode": "123-456" }
```

#### POST /instances/:iid/logout
Resposta:
```json
{ "ok": true, "message": "..." }
```

#### POST /instances/:iid/session/wipe
Resposta (202):
```json
{ "ok": true, "message": "..." }
```

### Mensagens

#### POST /instances/:iid/send-text
Body:
```json
{ "to": "55DDDNUMERO", "message": "Ola" }
```
Resposta:
```json
{ "id": "MSGID", "messageId": "MSGID", "status": 1 }
```

#### POST /instances/:iid/send-buttons
Body:
```json
{
  "to": "55DDDNUMERO",
  "text": "Escolha",
  "options": [ { "id": "opt-1", "title": "Opcao 1" } ],
  "footer": "opcional"
}
```
Resposta:
```json
{ "id": "MSGID", "messageId": "MSGID", "status": 1 }
```

#### POST /instances/:iid/send-list
Body:
```json
{
  "to": "55DDDNUMERO",
  "text": "Menu",
  "buttonText": "Ver",
  "title": "Titulo",
  "footer": "opcional",
  "sections": [
    { "title": "Categoria", "options": [ { "id": "item-1", "title": "Item" } ] }
  ]
}
```
Resposta:
```json
{ "id": "MSGID", "messageId": "MSGID", "status": 1 }
```

#### POST /instances/:iid/send-media
Body:
```json
{
  "type": "image|video|audio|document",
  "to": "55DDDNUMERO",
  "caption": "opcional",
  "media": {
    "url": "https://...",
    "base64": "data:image/jpeg;base64,...",
    "mimetype": "image/jpeg",
    "fileName": "arquivo.jpg",
    "ptt": false,
    "gifPlayback": false
  }
}
```
Resposta (201):
```json
{
  "id": "MSGID",
  "status": 1,
  "type": "image",
  "mimetype": "image/jpeg",
  "fileName": "arquivo.jpg",
  "source": "url|base64",
  "size": 12345
}
```
Erros: `media_source_missing`, `media_url_invalid`, `media_base64_invalid`, `media_too_large`.

#### POST /instances/:iid/exists
Body:
```json
{ "to": "55DDDNUMERO" }
```
Resposta:
```json
{ "results": [ { "jid": "...", "exists": true } ] }
```

#### GET /instances/:iid/status?id=MSGID
Resposta:
```json
{ "id": "MSGID", "status": 1 }
```

Status codes:
- `0` falha, `1` pendente, `2` server ack, `3` entregue, `4` lido, `5` reproduzido.

### Envio rapido (unificado)

#### POST /instances/:iid/send-quick
Body base:
```json
{ "to": "55DDDNUMERO", "type": "text|buttons|list|media", "..." }
```

- text:
```json
{ "type": "text", "text": "Ola" }
```
- buttons:
```json
{ "type": "buttons", "text": "Escolha", "buttons": [ { "id": "1", "title": "Opcao" } ], "footer": "..." }
```
- list:
```json
{ "type": "list", "text": "Menu", "buttonText": "Ver", "sections": [ { "options": [ { "id": "a", "title": "Item" } ] } ] }
```
- media:
```json
{ "type": "media", "mediaType": "image", "media": { "url": "https://..." }, "caption": "..." }
```

Resposta:
```json
{
  "messageId": "MSGID",
  "type": "text",
  "to": "55DDDNUMERO",
  "status": 1,
  "summary": "...",
  "preview": { "text": "..." },
  "links": [ { "rel": "chat", "label": "Abrir conversa", "href": "https://wa.me/..." } ],
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

Se fila ativa, pode responder:
```json
{ "enqueued": true, "jobId": "...", "quickLinks": [ ... ] }
```

### Contatos e utilitarios

#### GET /instances/:iid/check-number?number=55DDDNUMERO
Resposta:
```json
{ "exists": true, "jid": "..." }
```

#### GET /instances/:iid/profile-pic?number=55DDDNUMERO
Resposta:
```json
{ "profilePicUrl": "https://..." }
```

### Grupos

#### GET /instances/:iid/groups
Resposta:
```json
[ { "id": "1203@g.us", "subject": "Grupo" } ]
```

#### POST /instances/:iid/groups
Body:
```json
{ "subject": "Equipe", "participants": ["55DDDNUMERO"] }
```
Resposta (201): inclui `id`, `subject`, `participants`, etc.

#### POST /instances/:iid/groups/:gid/members
Body:
```json
{ "participants": ["55DDDNUMERO"] }
```
Resposta:
```json
{ "status": "success|partial|error", "message": "...", "results": [ { "jid": "...", "status": 200, "success": true } ] }
```

#### DELETE /instances/:iid/groups/:gid/members
Body igual ao add. Resposta igual ao add.

### Events e logs

#### GET /instances/:iid/events?limit=&after=&type=&direction=
Resposta:
```json
{ "events": [ ...BrokerEvent ], "nextCursor": "eventId" }
```

#### POST /instances/:iid/events/ack
Body:
```json
{ "ids": ["eventId1", "eventId2"] }
```
Resposta:
```json
{ "acknowledged": ["eventId1"], "missing": ["eventId2"] }
```

#### GET /instances/:iid/logs?limit=&type=&direction=
Resposta:
```json
{ "events": [ ...BrokerEvent ] }
```

### Metrics e export

#### GET /instances/:iid/metrics?from=&to=
- `from` e `to` aceitam timestamp (ms) ou ISO string.
- Retorna payload com `counters`, `timeline`, `delivery`, `range`, `aggregates`.

#### GET /instances/:iid/export.json?from=&to=
- Arquivo JSON com `exportedAt` + payload de metrics.

#### GET /instances/:iid/export.csv?from=&to=
- Arquivo CSV com meta + timeline.

### Risco e proxy

#### GET /instances/:iid/risk
Resposta: RiskSnapshot.

#### POST /instances/:iid/risk
Body:
```json
{ "threshold": 0.7, "interleaveEvery": 5, "safeContacts": ["5511999999999"] }
```
Resposta:
```json
{ "ok": true, "risk": { ... } }
```

#### POST /instances/:iid/risk/pause | /resume
Resposta:
```json
{ "ok": true, "risk": { ... } }
```

#### POST /instances/:iid/risk/send-safe
Body (opcional):
```json
{ "message": "Safe ping" }
```
Resposta:
```json
{ "ok": true, "target": "5511...", "message": "..." }
```

#### GET /instances/:iid/proxy
Resposta: NetworkConfig.

#### POST /instances/:iid/proxy
Body:
```json
{ "proxyUrl": "http://user:pass@host:port" }
```
Resposta:
```json
{ "ok": true, "network": { ...NetworkConfig } }
```

#### POST /instances/:iid/proxy/revalidate
Resposta igual ao POST /proxy.

### Queue

#### GET /instances/queue/metrics
Resposta (quando habilitada):
```json
{ "waiting": 0, "active": 0, "delayed": 0, "failed": 0, "completed": 0, "etaSeconds": 12 }
```
Ou:
```json
{ "enabled": false }
```

## Fluxos principais

### 1) Criar instancia e parear
1. `POST /instances`
2. Aguardar `GET /instances/:iid/qr.png` ou `POST /instances/:iid/pair`.
3. Quando conectado, `connectionState` muda para `open` (SSE `/instances/events`).

### 2) Envio de mensagem e status
1. `POST /instances/:iid/send-*` ou `send-quick`.
2. Recebe `messageId`.
3. `GET /instances/:iid/status?id=...` ou webhook `WHATSAPP_MESSAGES_UPDATE`.

### 3) Inbound -> webhook / event store
1. Baileys recebe `messages.upsert`.
2. `MessageService` gera `MESSAGE_INBOUND`.
3. Evento vai para webhook e para broker (SSE `/stream` e `/instances/:iid/events`).

2. Respostas sao processadas em `PollService`.
3. Evento `POLL_CHOICE` publicado (webhook + broker).

### 5) Risco e fila
- `riskGuardian` pode pausar envios quando a razao de desconhecidos ultrapassa `threshold`.
- `send-quick` pode enfileirar (BullMQ) se `ENABLE_SEND_QUEUE` e `REDIS_URL` estiverem ativos.

### 6) Proxy
- `POST /instances/:iid/proxy` valida ASN/ISP e pode bloquear datacenter.
- Em caso de bloqueio, a instancia pode ser desligada.
