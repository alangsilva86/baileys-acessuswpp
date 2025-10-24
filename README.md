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
- `WEBHOOK_API_KEY`: Chave para autenticar o webhook (padrão: `57c1acd47dc2524ab06dc4640443d755072565ebed06e1a7cc6d27ab4986e0ce`)
- Logs de falha do webhook registram apenas status, mensagem e URL para evitar exposição de segredos
- `WEBHOOK_HMAC_SECRET`: Segredo opcional para assinar os eventos via HMAC
- `RATE_MAX_SENDS`: Máximo de mensagens por janela de tempo (padrão: 20)
- `RATE_WINDOW_MS`: Janela de tempo para rate limiting em ms (padrão: 15000)
- `SEND_TIMEOUT_MS`: Timeout padrão para envios ativos, aplicado tanto às rotas HTTP quanto ao `MessageService` (padrão: 25000)

### Webhooks

Defina `WEBHOOK_URL` (e opcionalmente substitua `WEBHOOK_API_KEY` / `WEBHOOK_HMAC_SECRET`) para receber eventos estruturados sempre que mensagens forem processadas.

#### Envelope e cabeçalhos

Cada chamada é um `POST` com `Content-Type: application/json` e os seguintes headers:

- `x-api-key`: obrigatório. Usa `WEBHOOK_API_KEY` (ou o valor padrão `57c1acd47dc2524ab06dc4640443d755072565ebed06e1a7cc6d27ab4986e0ce`).
- `x-signature`: opcional. HMAC-SHA256 de `JSON.stringify(body)` usando `WEBHOOK_HMAC_SECRET` (ou, se ausente, o próprio `WEBHOOK_API_KEY`).

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

Eventos brutos do Baileys (`WHATSAPP_MESSAGES_UPSERT` / `WHATSAPP_MESSAGES_UPDATE`) mantêm o payload no formato:

```json
{
  "iid": "alan",
  "raw": { /* evento original emitido pelo Baileys */ }
}
```

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

#### Mensagens

- `POST /instances/:id/send-text` - Enviar mensagem de texto
- `POST /instances/:id/send-buttons` - Enviar botões de resposta rápida
- `POST /instances/:id/send-list` - Enviar lista interativa com seções/opções
- `POST /instances/:id/send-media` - Enviar mídia (imagem, vídeo, áudio ou documento)
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
  "footer": "Texto opcional",
  "waitAckMs": 1000
}
```

- `to` deve estar no formato E.164 (ex.: `55DDDNUMERO`).
- `text` é obrigatório e será exibido como corpo da mensagem.
- `options` é obrigatório, aceita de 1 a 3 itens com campos `id` (único) e `title`.
- `footer` é opcional e aparece abaixo dos botões.
- `waitAckMs`, quando informado, aguarda o ACK do WhatsApp pelo tempo indicado (em ms) antes de responder.

Resposta típica:

```json
{
  "id": "BAE5...",
  "messageId": "BAE5...",
  "status": 1,
  "ack": 2
}
```

O campo `ack` será `null` se `waitAckMs` não for enviado ou se o status não chegar a tempo. O mesmo formato de resposta é adotado pelos endpoints `send-text` e `send-list`.

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
  ],
  "waitAckMs": 1500
}
```

- `buttonText` define o rótulo do botão que abre a lista.
- Cada seção pode ter um `title` opcional e precisa de pelo menos uma opção.
- Cada opção exige `id` (único dentro da mensagem) e `title`; `description` é opcional e aparece como legenda.
- `text`, `footer` e `title` são exibidos como corpo, rodapé e cabeçalho da mensagem, respectivamente.
- `waitAckMs` funciona da mesma forma que em `send-text`/`send-buttons`.

Resposta:

```json
{
  "id": "BAE6...",
  "messageId": "BAE6...",
  "status": 1,
  "ack": null
}
```

O campo `messageId` é sempre retornado como alias de `id`, facilitando integrações que esperam essa nomenclatura.

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

## Estrutura do Projeto


```
├── src/
│   ├── instanceManager.ts    # Gerenciamento de instâncias
│   ├── whatsapp.ts           # Integração com Baileys e serviços auxiliares
│   ├── utils.ts              # Funções utilitárias
│   ├── server.ts             # Servidor HTTP (Express)
│   ├── broker/               # Fila de eventos HTTP compartilhada
│   ├── baileys/              # Serviços de mensagens
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
