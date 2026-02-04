# OS.Diagnose v2 -> baileys-acessus integration (QR + report send)

Este documento descreve a integracao entre o backend do OS.Diagnose (Express) e o backend do baileys-acessus (Express/Baileys), cobrindo:
- fluxo operacional (QR/pairing)
- envio automatico de relatorio ao finalizar diagnostico
- idempotencia
- observabilidade e resiliencia
- contratos e payloads

## 1) Escopo e objetivos

Objetivo principal:
1. Conectar uma instancia WhatsApp via QR ou Pairing Code.
2. Ao finalizar diagnostico (Step 6 / Results), enviar:
   - Mensagem 1: resumo curto + link do relatorio
   - Mensagem 2: PDF como documento (ou fallback com link)
   - Mensagem 3: CTA opcional (workshop) se score baixo
3. Garantir:
   - Idempotencia (nao duplicar envios por lead)
   - Observabilidade (registrar status e eventos em SQLite)
   - Resiliencia (fila opcional e fallback)

## 2) Variaveis e configuracao (.env do OS.Diagnose)

```env
WA_API_BASE_URL=http://localhost:8787
WA_API_KEY=SEU_X_API_KEY
WA_INSTANCE_ID=os-diagnose-main
WA_SEND_MODE=quick            # quick|text|media
WA_DEFAULT_COUNTRY=55
WA_SEND_PDF_AS=document       # document|link
WA_ENABLE_WORKSHOP_CTA=true
```

Notas:
- `WA_INSTANCE_ID` deve existir no baileys. Caso nao exista, criar via `POST /instances`.
- `WA_SEND_MODE` define o endpoint preferido (`send-quick` vs `send-text`/`send-media`).

## 3) Banco (SQLite) - controle de envio e idempotencia

### Tabela `wa_deliveries`

Campos minimos recomendados:
- `id` (pk)
- `lead_id` (fk)
- `kind` (enum: `report_summary|report_pdf|workshop_cta`)
- `to_e164`
- `instance_id`
- `status` (enum: `pending|sent|failed|skipped`)
- `message_id` (id retornado pelo baileys)
- `error` (text)
- `created_at`, `sent_at`

### SQL sugerido
```sql
CREATE TABLE IF NOT EXISTS wa_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  to_e164 TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_deliveries_unique
  ON wa_deliveries (lead_id, kind, status)
  WHERE status = 'sent';
```

### Regra de idempotencia
- Um lead so pode ter 1 delivery `sent` para `report_summary` e 1 para `report_pdf`.
- Se ja existir `sent`, retornar `skipped`.

### Observabilidade (opcional)
Tabela de eventos:
```sql
CREATE TABLE IF NOT EXISTS wa_delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (delivery_id) REFERENCES wa_deliveries(id)
);
```

## 4) Servico no OS.Diagnose: `server/wa.mjs`

### 4.1 normalizeE164(number)
- Entrada: `11 98888-7777`, `+55...`, `55...`
- Saida: `55DDDNUMERO` (E.164 Brasil)
- Validar DDD + 9 digitos (10-11 digitos sem pais)

### 4.2 ensureInstance()
- `GET /instances`
- Se `WA_INSTANCE_ID` nao existir, criar:
  - `POST /instances { name: WA_INSTANCE_ID }`

### 4.3 getConnectionState()
- `GET /instances/:iid`
- Se `connected != true`, retornar `offline`

### 4.4 getQrPngBuffer()
- `GET /instances/:iid/qr.png`
- Retornar Buffer PNG

### 4.5 sendReportSummary(to, payload)
- Preferir `POST /instances/:iid/send-quick` com `type=text`
- Texto curto com:
  - headline
  - gargalo mestre
  - 1 quick win
  - link do report (tokenizado)

### 4.6 sendPdf(to, pdfUrl | pdfBuffer)
**Opcao A (preferida)**: enviar documento via URL publica
- `POST /instances/:iid/send-media`
  - `type=document`
  - `media.url=pdfUrl`
  - `fileName=Relatorio-OS-Diagnose.pdf`
  - `mimetype=application/pdf`

**Opcao B (fallback)**: se falhar, enviar link via texto
- `POST /instances/:iid/send-text`

## 5) Endpoints no OS.Diagnose

### 5.1 GET /api/whatsapp/qr
Objetivo: prover QR para operar a instancia.

Fluxo:
1. `ensureInstance()`
2. `getConnectionState()`
3. Se conectado: retornar `{ connected: true }`
4. Se offline: retornar PNG (`image/png`)

Resposta:
- JSON quando conectado
- PNG quando offline

### 5.2 POST /api/whatsapp/pair
Body:
```json
{ "phoneNumber": "55DDDNUMERO" }
```
Chama `POST /instances/:iid/pair` no baileys.
Resposta:
```json
{ "pairingCode": "123-456" }
```

### 5.3 POST /api/leads/:id/send-whatsapp-report
Fluxo:
1. Auth admin
2. Carregar lead + report_json + token
3. Normalizar `contact.whatsapp`
4. Checar idempotencia
5. Enviar summary + pdf
6. Salvar status

Resposta sugerida:
```json
{
  "leadId": "...",
  "summary": { "status": "sent|failed|skipped", "messageId": "..." },
  "pdf": { "status": "sent|failed|skipped", "messageId": "..." },
  "cta": { "status": "sent|failed|skipped", "messageId": "..." }
}
```

## 6) Trigger automatico (Step 6 / Results)

Regras para enviar:
- lead com whatsapp valido
- relatorio existe (`report_json` ok)
- token do report existe
- envio ainda nao foi feito (idempotencia)

Implementacao recomendada (backend-driven):
- No final de `/api/generate-report`, disparar `enqueueDelivery(leadId)`
- Execucao assincrona (setImmediate ou fila simples)

Nao depender do frontend para evitar duplicacao.

## 7) Mensagens (templates)

### Mensagem 1 (texto)
```
Seu relatorio esta pronto.

- Diagnostico: {headline}
- Gargalo mestre: {bottleneck.title}
- Proximo passo (7 dias): {quick_wins_7d[0]}

Abrir relatorio: {reportLink}
```

### Mensagem 2 (PDF)
Arquivo: `Relatorio-OS-Diagnose-{leadId}.pdf`
Caption:
```
PDF do seu diagnostico (guarde isso).
```

### Mensagem 3 (CTA opcional)
Se `score < 6`:
```
Se quiser, eu te ajudo a construir a primeira automacao ao vivo (workshop IA na Pratica). Quer detalhes?
```

Opcional com botoes:
- `POST /instances/:iid/send-buttons`

## 8) Tratamento de erros e fallback

- Se instancia offline:
  - registrar `failed` com error `instance_offline`
  - aplicar cooldown (ex: 30 min)
- Se `rate limit exceeded`:
  - se fila ativa, enfileirar
  - senao, esperar 60-120s e retry 1 vez
- Se envio de PDF falhar:
  - fallback para link via texto
- Sempre registrar em `wa_deliveries`

## 9) Contratos com o baileys-acessus (resumo)

### Criar/listar instancia
- `GET /instances`
- `POST /instances` body `{ "name": "..." }`

### Ver estado
- `GET /instances/:iid` -> `InstanceSnapshot`

### QR
- `GET /instances/:iid/qr.png` -> PNG

### Pairing
- `POST /instances/:iid/pair` body `{ "phoneNumber": "55DDDNUMERO" }`

### Envio texto rapido
- `POST /instances/:iid/send-quick`
```json
{ "to": "55DDDNUMERO", "type": "text", "text": "..." }
```

### Envio documento
- `POST /instances/:iid/send-media`
```json
{
  "type": "document",
  "to": "55DDDNUMERO",
  "caption": "opcional",
  "media": { "url": "https://...", "fileName": "Relatorio.pdf", "mimetype": "application/pdf" }
}
```

### Fallback texto
- `POST /instances/:iid/send-text`
```json
{ "to": "55DDDNUMERO", "message": "Aqui esta seu PDF: <link>" }
```

## 10) Seguranca

- Nunca expor `WA_API_KEY` no frontend.
- Endpoints `/api/whatsapp/*` devem exigir auth admin.
- `/api/leads/:id/send-whatsapp-report` restrito ao backend/admin.

## 11) Checklist de aceite (DoD)

- [ ] Admin conecta instancia via QR (GET /api/whatsapp/qr)
- [ ] Admin pareia via codigo (POST /api/whatsapp/pair)
- [ ] Ao concluir diagnostico, lead recebe resumo + PDF (ou link)
- [ ] Idempotencia previne duplicacao
- [ ] `wa_deliveries` registra status e erros
- [ ] Evento `WHATSAPP_REPORT_SENT` registrado no lead (telemetria)

## 12) Fase 2 (opcional)

Se desejar resposta interativa (ex: botao "Quero"), sera necessario:
- consumir webhooks `MESSAGE_INBOUND` / `POLL_CHOICE`
- expor endpoint `/api/webhooks/whatsapp` no OS.Diagnose
- mapear inbound para atualizacao de lead

