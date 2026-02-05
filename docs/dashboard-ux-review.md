# Revisão UX/UI do Dashboard Baileys API

## Visão geral

O projeto possui **duas UIs** que consomem os mesmos endpoints do backend Express:

- **UI canônica (React SPA)**: código em `apps/web` (Vite → `dist/web`). É servida quando `dist/web` existe.
- **UI legada (fallback)**: HTML em `public/index.html` + módulos ES6 em `public/js/*.js`, com Tailwind buildado em `public/assets/app.css`.

Ambas dependem de autenticação via `x-api-key` e usam REST + SSE (`/instances/*`, `/stream`) para manter estado, métricas e logs atualizados.

## Etapas da jornada e dependências

### Etapa 1 — Boot do dashboard e carregamento inicial
- **UI canônica (React)**: `apps/web/src/main.tsx` + `apps/web/src/features/dashboard/DashboardPage.tsx`. A conexão “tempo real” vem de SSE em `apps/web/src/features/dashboard/hooks/useInstanceMetrics.ts`.
- **UI legada (fallback)**: `public/js/main.js` + `public/js/boot.js` (inicialização, refresh e fallback entre SSE e polling).
- **Dependências técnicas**: endpoints `GET /instances`, SSE em `/instances/events` e `/stream`, `localStorage` para chave de API.

### Etapa 2 — Seleção e gerenciamento de instâncias
- **UI canônica (React)**: `apps/web/src/features/dashboard/components/SidebarContainer.tsx` + `apps/web/src/features/dashboard/hooks/useInstances.ts`.
- **UI legada (fallback)**: `public/js/instances.js` (select, cards e ações).
- **Dependências técnicas**: endpoints `GET/POST/PATCH/DELETE /instances`.

### Etapa 3 — Contexto da instância e notas
- **UI canônica (React)**: seção “Notas” em `apps/web/src/features/dashboard/components/DashboardMain.tsx`.
- **UI legada (fallback)**: `public/js/notes.js` (autosave, metadados e histórico).
- **Dependências técnicas**: `PATCH /instances/:iid` (backend já suporta revisões em `metadata.revisions`).

### Etapa 4 — Métricas e gráfico de timeline
- **UI canônica (React)**: `apps/web/src/features/dashboard/hooks/useInstanceMetrics.ts` + UI em `apps/web/src/features/dashboard/components/DashboardMain.tsx` (inclui export CSV/JSON).
- **UI legada (fallback)**: `public/js/metrics.js`.
- **Dependências técnicas**: `GET /instances/:iid/metrics`, `GET /instances/:iid/export.csv`, `GET /instances/:iid/export.json`.

### Etapa 5 — Ações de sessão e QR Code
- **UI canônica (React)**: seção de QR e ações em `apps/web/src/features/dashboard/components/DashboardMain.tsx`.
- **UI legada (fallback)**: `public/js/sessionActions.js`.
- **Dependências técnicas**: `/instances/:iid/qr.png`, `/instances/:iid/logout`, `/instances/:iid/session/wipe`, `/instances/:iid/pair`.

### Etapa 6 — Envio rápido
- **UI canônica (React)**: modal em `apps/web/src/features/dashboard/components/DashboardMain.tsx` chamando `POST /instances/:iid/send-quick`.
- **UI legada (fallback)**: `public/js/quickSend.js`.
- **Dependências técnicas**: `/instances/:iid/send-quick` (text/buttons/list/media) e `/instances/:iid/exists` para pré-checagem opcional.

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
