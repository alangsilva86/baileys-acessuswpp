# Revisão UX/UI do Dashboard Baileys API

## Visão geral

O dashboard atual é construído com HTML estático (`public/index.html`) estilizado via Tailwind CDN e JavaScript vanilla (`public/dashboard.js`) que consome os endpoints REST expostos pelo backend Express. A interface se apoia em atualizações por polling a cada 3 segundos para manter métricas e estados das instâncias sincronizados.

## Etapas da jornada e dependências

### Etapa 1 — Boot do dashboard e carregamento inicial
- **Comportamento**: `initChart()` inicializa o gráfico de métricas (Chart.js) e `refreshInstances()` é chamado imediatamente e em intervalo de 3s (`setInterval`).
- **Dependências técnicas**: `Chart.js` via CDN, endpoint `GET /instances`, armazenamento local `localStorage` para chave API e range de métricas.
- **Observações**: Estado do badge de status é atualizado com base na resposta da instância selecionada.

### Etapa 2 — Seleção e gerenciamento de instâncias
- **Comportamento**: A lista de instâncias popula `<select id="selInstance">` e gera cards dinâmicos com estatísticas. Ações inline permitem editar nome/notas, selecionar, carregar QR, logout, wipe e exclusão (com modal).
- **Dependências técnicas**: Endpoints `GET/POST/PATCH/DELETE /instances`, componentes HTML gerados dinamicamente, `fetchJSON()` para chamadas autenticadas, modal `#modalDelete`.
- **Observações**: Cards refletem contadores por status (1–5) e uso de rate limit.

### Etapa 3 — Contexto da instância e notas
- **Comportamento**: Ao selecionar uma instância, o bloco "Contexto da instância" é exibido com textarea sincronizada e metadados de criação/atualização (`metadata.createdAt`, `metadata.updatedAt`).
- **Dependências técnicas**: Endpoint `GET /instances/:id`, propriedades `note/notes`, elementos `#noteCard`, `#instanceNote`, `#noteMeta`.
- **Observações**: Persistência depende de ação manual "Salvar" no card correspondente.

### Etapa 4 — Métricas e gráfico de timeline
- **Comportamento**: KPIs e gráfico de linha atualizam com dados de `/instances/:id/metrics`. Filtro `#selRange` determina janela em minutos armazenada em `localStorage`.
- **Dependências técnicas**: Endpoint `GET /instances/:id/metrics`, estrutura `metrics.counters`, `metrics.rate`, `metrics.ack`, timeline com campos `sent`, `pending`, `serverAck`, `delivered`, `read`, `played`.
- **Observações**: Falta fallback visual além de texto quando não há dados; atualizações dependem do polling global.

### Etapa 5 — Ações de sessão e QR Code
- **Comportamento**: Área de QR mostra imagem carregada via `/instances/:id/qr.png` quando desconectada. Botões executam `logout`, `wipe` e `pair` (gera código de pareamento copiado para clipboard).
- **Dependências técnicas**: Endpoints `/instances/:id/qr.png`, `/instances/:id/logout`, `/instances/:id/wipe`, `/instances/:id/pair`, uso de API Key (`x-api-key`) e manipulação de `navigator.clipboard`.
- **Observações**: Feedback textual em `#qrHint`; ausência de estados carregando/erro visuais além de texto.

### Etapa 6 — Envio rápido
- **Comportamento**: Formulário "Envio Rápido" solicita API Key, telefone e mensagem, envia `POST /instances/:id/send-text` e exibe JSON de resposta em `#sendOut`.
- **Dependências técnicas**: Endpoint `/instances/:id/send-text`, validações mínimas (campos vazios), armazenamento de API Key no `localStorage`.
- **Observações**: Não há máscara/validação de formato ou feedback contextual (ex: sucesso/erro inline estilizado).

## Recomendações de melhorias referenciadas

1. **Otimizar boot e sincronização (Etapa 1)**
   - Introduzir estados de carregamento/skeleton enquanto `refreshInstances()` aguarda resposta para evitar flash de conteúdo vazio.
   - Reduzir polling agressivo (3s) adotando WebSockets/SSE quando disponíveis ou expondo controle manual de refresh para ambientes com muitas instâncias.

2. **Refinar cards e listagem de instâncias (Etapa 2)**
   - Reorganizar layout dos cards usando grid responsivo com hierarquia visual clara (nome + status destacado, KPIs em colunas consistentes).
   - Adicionar filtros/pesquisa e ordenação (ex: instâncias desconectadas primeiro) para facilitar operação com dezenas de instâncias.
   - Mostrar feedback instantâneo (toast ou badge temporário) ao salvar nome/notas sem depender apenas do badge global.

3. **Melhorar edição de notas (Etapa 3)**
   - Implementar autosave com debounce no textarea, evitando exigir clique em "Salvar" para notas rápidas.
   - Exibir histórico de alterações ou pelo menos timestamp relativo (ex: "Atualizado há 5 min") para reforçar contexto temporal.

4. **Aprimorar experiência de métricas (Etapa 4)**
   - Incluir indicadores de carregamento e fallback gráfico (ex: placeholder chart) quando não houver dados.
   - Implementar tooltips personalizados descrevendo cada série e cor, e legendas acessíveis (contraste AA) para status 1–5.
   - Permitir exportar dados da timeline (CSV/JSON) e adicionar agregações como taxa de entrega média dentro do range selecionado.

5. **Feedback e estados para ações de sessão (Etapa 5)**
   - Adicionar estados "Carregando" nos botões (com spinners/desabilitados) enquanto requisições `logout/wipe/pair` estão em andamento.
   - Mostrar QR em contêiner com borda indicando status (ex: vermelho quando expirado), e incluir contador de expiração quando possível.
   - Para `pair`, exibir modal com código e botão de copiar em vez de texto plano no hint, garantindo acessibilidade mobile.

6. **Formulário de envio rápido mais robusto (Etapa 6)**
   - Validar formato E.164 com feedback inline, incluir máscara opcional e permitir mensagens multiline com contador de caracteres.
   - Destacar claramente sucesso/erro com cartões coloridos e histórico dos últimos envios (dependendo de `/instances/:id/send-text`).
   - Permitir seleção de templates/mensagens pré-definidas e anexos simples, aproveitando endpoints existentes ou futuros.

7. **Melhorias transversais**
   - Consolidar componentes de badge e botões em um micro design system (classes utilitárias reutilizáveis) para consistência.
   - Aumentar acessibilidade: atributos `aria-live` para feedbacks, foco visível, contraste ajustado (especialmente textos em cards e badges).
   - Documentar fluxos e dependências no README para alinhar onboarding de novos usuários e desenvolvedores front-end.

Estas recomendações, alinhadas às etapas mapeadas, fortalecem a experiência operacional do dashboard, reduzem fricções e criam base para evoluções futuras sem alterar drasticamente a infraestrutura existente.
