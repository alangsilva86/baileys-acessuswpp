export const STATUS_META = {
  '1': {
    name: 'Pendentes',
    description: 'A mensagem saiu do app, mas ainda não foi entregue ao servidor do WhatsApp.',
    textClass: 'text-amber-600',
    chartColor: '#f59e0b',
    chartBackground: 'rgba(245,158,11,0.15)',
  },
  '2': {
    name: 'Servidor recebeu',
    description: 'O servidor do WhatsApp confirmou o recebimento (✔ cinza).',
    textClass: 'text-sky-600',
    chartColor: '#3b82f6',
    chartBackground: 'rgba(59,130,246,0.15)',
  },
  '3': {
    name: 'Entregues',
    description: 'A mensagem chegou ao dispositivo do destinatário (✔✔ cinza).',
    textClass: 'text-emerald-600',
    chartColor: '#22c55e',
    chartBackground: 'rgba(34,197,94,0.15)',
  },
  '4': {
    name: 'Lidas',
    description: 'O destinatário visualizou a mensagem (✔✔ azul).',
    textClass: 'text-indigo-600',
    chartColor: '#6366f1',
    chartBackground: 'rgba(99,102,241,0.15)',
  },
  '5': {
    name: 'Reproduzidas',
    description: 'Áudio ou mensagem de voz reproduzidos (ícone play azul).',
    textClass: 'text-pink-600',
    chartColor: '#ec4899',
    chartBackground: 'rgba(236,72,153,0.15)',
  },
};

export const STATUS_CODES = ['1', '2', '3', '4', '5'];

export const TIMELINE_FIELDS = {
  '1': 'pending',
  '2': 'serverAck',
  '3': 'delivered',
  '4': 'read',
  '5': 'played',
};

export const LOG_DIRECTION_META = {
  inbound: { label: 'Inbound', className: 'bg-emerald-100 text-emerald-700' },
  outbound: { label: 'Outbound', className: 'bg-sky-100 text-sky-700' },
  system: { label: 'System', className: 'bg-slate-200 text-slate-700' },
};

export const DELIVERY_STATE_META = {
  pending: { label: 'Webhook pendente', className: 'bg-amber-100 text-amber-700' },
  retry: { label: 'Reenvio agendado', className: 'bg-amber-100 text-amber-700' },
  success: { label: 'Webhook entregue', className: 'bg-emerald-100 text-emerald-700' },
  failed: { label: 'Webhook falhou', className: 'bg-rose-100 text-rose-700' },
};

export const CONNECTION_STATE_META = {
  open: {
    label: 'Conectado',
    badgeType: 'status-connected',
    badgeClass: 'bg-emerald-100 text-emerald-700',
    optionSuffix: ' • on-line',
    cardLabel: (ts) => (ts ? `Conectado • ${ts}` : 'Conectado'),
    badgeText: (name, ts) => (ts ? `Conectado (${name}) • ${ts}` : `Conectado (${name})`),
    qrState: 'connected',
    qrMessage: (ts) => (ts ? `Instância conectada. Atualizado em ${ts}.` : 'Instância conectada.'),
    shouldLoadQr: false,
  },
  connecting: {
    label: 'Reconectando…',
    badgeType: 'status-connecting',
    badgeClass: 'bg-amber-100 text-amber-700',
    optionSuffix: ' • reconectando',
    cardLabel: (ts) => (ts ? `Reconectando… • ${ts}` : 'Reconectando…'),
    badgeText: (name, ts) => (ts ? `Reconectando (${name}) • ${ts}` : `Reconectando (${name})`),
    qrState: 'loading',
    qrMessage: (ts) => (ts ? `Reconectando… Atualizado em ${ts}.` : 'Reconectando…'),
    shouldLoadQr: false,
  },
  close: {
    label: 'Desconectado',
    badgeType: 'status-disconnected',
    badgeClass: 'bg-rose-100 text-rose-700',
    optionSuffix: ' • off-line',
    cardLabel: (ts) => (ts ? `Desconectado • ${ts}` : 'Desconectado'),
    badgeText: (name, ts) => (ts ? `Desconectado (${name}) • ${ts}` : `Desconectado (${name})`),
    qrState: 'disconnected',
    qrMessage: (ts) =>
      ts ? `Instância desconectada. Atualizado em ${ts}.` : 'Instância desconectada. Aponte o WhatsApp para o QR code.',
    shouldLoadQr: true,
  },
};
