const q = (id) => document.getElementById(id);

export const els = {
  badge: q('badge'),
  sessionsRoot: q('sessionsRoot'),
  selInstance: q('selInstance'),
  btnNew: q('btnNew'),
  cards: q('cards'),
  cardsSkeleton: q('cardsSkeleton'),
  instanceLoading: q('instanceLoading'),
  instanceSearch: q('instanceSearch'),
  instanceFilterState: q('instanceFilterState'),
  instanceSort: q('instanceSort'),
  instanceCounter: q('instanceCounter'),

  // Note card
  noteCard: q('noteCard'),
  noteMeta: q('noteMeta'),
  instanceNote: q('instanceNote'),
  noteStatus: q('noteStatus'),
  noteRetry: q('noteRetry'),

  // KPIs
  selRange: q('selRange'),
  kpiDeliveryValue: q('kpiDeliveryValue'),
  kpiDeliveryHint: q('kpiDeliveryHint'),
  kpiFailureValue: q('kpiFailureValue'),
  kpiFailureHint: q('kpiFailureHint'),
  kpiRateValue: q('kpiRateValue'),
  kpiRateHint: q('kpiRateHint'),
  kpiTransitValue: q('kpiTransitValue'),
  kpiTransitHint: q('kpiTransitHint'),
  chartHint: q('chartHint'),
  metricsSkeleton: q('metricsSkeleton'),
  btnExportCsv: q('btnExportCsv'),
  btnExportJson: q('btnExportJson'),

  // QR / ações rápidas
  qrWrap: q('qrWrap'),
  qrImg: q('qrImg'),
  qrHint: q('qrHint'),
  qrLoader: q('qrLoader'),
  qrMeta: q('qrMeta'),
  qrCountdown: q('qrCountdown'),
  qrAttempt: q('qrAttempt'),
  qrLastError: q('qrLastError'),
  qrLastErrorWrap: q('qrLastErrorWrap'),
  btnLogout: q('btnLogout'),
  btnWipe: q('btnWipe'),
  btnPair: q('btnPair'),

  // Envio rápido
  inpApiKey: q('inpApiKey'),
  inpPhone: q('inpPhone'),
  inpMsg: q('inpMsg'),
  quickMessageGroup: q('quickMessageGroup'),
  quickType: q('selQuickType'),
  quickMsgLabel: q('quickMsgLabel'),
  quickMsgHint: q('quickMsgHint'),
  quickButtonsFields: q('quickButtonsFields'),
  quickButtonsList: q('quickButtonsList'),
  quickButtonsAdd: q('quickButtonsAdd'),
  quickButtonsFooter: q('quickButtonsFooter'),
  quickListFields: q('quickListFields'),
  quickListButtonText: q('quickListButtonText'),
  quickListTitle: q('quickListTitle'),
  quickListFooter: q('quickListFooter'),
  quickListSections: q('quickListSections'),
  quickListAddSection: q('quickListAddSection'),
  quickMediaFields: q('quickMediaFields'),
  quickMediaType: q('quickMediaType'),
  quickMediaUrl: q('quickMediaUrl'),
  quickMediaBase64: q('quickMediaBase64'),
  quickMediaMime: q('quickMediaMime'),
  quickMediaFileName: q('quickMediaFileName'),
  quickMediaPtt: q('quickMediaPtt'),
  quickMediaGif: q('quickMediaGif'),
  btnSend: q('btnSend'),
  sendOut: q('sendOut'),
  msgCounter: q('msgCounter'),
  quickResults: q('quickResults'),

  // Logs recentes
  btnRefreshLogs: q('btnRefreshLogs'),
  logsList: q('logsList'),
  logsEmpty: q('logsEmpty'),
  logsSkeleton: q('logsSkeleton'),

  // Modal
  modalDelete: q('modalDelete'),
  modalInstanceName: q('modalInstanceName'),
  modalConfirm: document.querySelector('[data-act="modal-confirm"]'),
  modalCancel: document.querySelector('[data-act="modal-cancel"]'),

  // Pair modal
  pairModal: q('pairModal'),
  pairModalCode: q('pairModalCode'),
  pairModalClose: q('pairModalClose'),
  pairModalCopy: q('pairModalCopy'),
};

export const STATUS_SERIES = [
  {
    key: 'pending',
    codes: ['1'],
    name: 'Pendentes',
    description: 'Aguardando confirmação do servidor do WhatsApp.',
    textClass: 'text-amber-600',
    chartColor: '#f59e0b',
    chartBackground: 'rgba(245,158,11,0.15)',
    timelineKey: 'pending',
  },
  {
    key: 'serverAck',
    codes: ['2'],
    name: 'Servidor recebeu',
    description: 'O servidor do WhatsApp confirmou o recebimento (✔ cinza).',
    textClass: 'text-sky-600',
    chartColor: '#3b82f6',
    chartBackground: 'rgba(59,130,246,0.15)',
    timelineKey: 'serverAck',
  },
  {
    key: 'delivered',
    codes: ['3'],
    name: 'Entregues',
    description: 'Mensagem entregue ao destinatário (✔✔ cinza).',
    textClass: 'text-emerald-600',
    chartColor: '#22c55e',
    chartBackground: 'rgba(34,197,94,0.15)',
    timelineKey: 'delivered',
  },
  {
    key: 'read',
    codes: ['4'],
    name: 'Lidas',
    description: 'Destinatário visualizou a mensagem (✔✔ azul).',
    textClass: 'text-indigo-600',
    chartColor: '#6366f1',
    chartBackground: 'rgba(99,102,241,0.15)',
    timelineKey: 'read',
  },
  {
    key: 'played',
    codes: ['5'],
    name: 'Reproduzidas',
    description: 'Áudio ou mensagem de voz reproduzidos (ícone play azul).',
    textClass: 'text-pink-600',
    chartColor: '#ec4899',
    chartBackground: 'rgba(236,72,153,0.15)',
    timelineKey: 'played',
  },
  {
    key: 'failed',
    codes: ['0'],
    name: 'Falhas',
    description: 'Mensagens com erro definitivo ou recusadas.',
    textClass: 'text-rose-600',
    chartColor: '#f87171',
    chartBackground: 'rgba(248,113,113,0.15)',
    timelineKey: 'failed',
  },
];

export const STATUS_META = STATUS_SERIES.reduce((acc, item) => {
  acc[item.key] = item;
  return acc;
}, {});

export const STATUS_KEYS = STATUS_SERIES.map((item) => item.key);

export const TIMELINE_FIELDS = STATUS_SERIES.reduce((acc, item) => {
  if (item.timelineKey) acc[item.key] = item.timelineKey;
  return acc;
}, {});

export const NOTE_STATE = {
  lastSaved: '',
  createdAt: null,
  updatedAt: null,
  timer: null,
  pending: '',
  saving: false,
  revisions: [],
  selectedRevision: 'current',
  restoring: false,
};

export const INSTANCE_FILTERS = {
  search: '',
  status: 'all',
  sort: 'name',
};

export const INSTANCE_VIEW = {
  total: 0,
  filtered: 0,
  virtualization: {
    ready: false,
    columns: 1,
    rowHeight: 0,
    rowGap: 16,
    paddingTop: 0,
    paddingBottom: 0,
    startIndex: 0,
    endIndex: 0,
  },
};

export const REFRESH_INTERVAL_MS = 5000;

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

const BADGE_STYLES = {
  'status-connected': 'bg-emerald-100 text-emerald-800',
  'status-disconnected': 'bg-rose-100 text-rose-800',
  'status-connecting': 'bg-amber-100 text-amber-800',
  logout: 'bg-amber-100 text-amber-800',
  wipe: 'bg-rose-200 text-rose-900',
  delete: 'bg-rose-600 text-white',
  update: 'bg-sky-100 text-sky-800',
  error: 'bg-amber-100 text-amber-800',
  info: 'bg-slate-200 text-slate-800',
};

let badgeLockUntil = 0;

export function applyBadge(type, msg) {
  const cls = BADGE_STYLES[type] || BADGE_STYLES.info;
  if (!els.badge) return;
  els.badge.className = 'px-3 py-1 rounded-full text-sm ' + cls;
  els.badge.textContent = msg;
}

export function canUpdateBadge() {
  return Date.now() >= badgeLockUntil;
}

export function setBadgeState(type, msg, holdMs = 4000) {
  applyBadge(type, msg);
  badgeLockUntil = holdMs ? Date.now() + holdMs : 0;
}

export function setStatusBadge(connection, name) {
  if (!canUpdateBadge()) return;
  const info = connection || {};
  const meta = info.meta || CONNECTION_STATE_META.close;
  const text = typeof meta.badgeText === 'function'
    ? meta.badgeText(name, info.updatedText)
    : `${meta.label} (${name})${info.updatedText ? ' • ' + info.updatedText : ''}`;
  applyBadge(meta.badgeType || 'info', text);
}

const CONNECTION_STATE_META = {
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
  qr_timeout: {
    label: 'QR expirado',
    badgeType: 'status-disconnected',
    badgeClass: 'bg-rose-100 text-rose-700',
    optionSuffix: ' • QR expirado',
    cardLabel: (ts) => (ts ? `QR expirado • ${ts}` : 'QR expirado'),
    badgeText: (name, ts) => (ts ? `QR expirado (${name}) • ${ts}` : `QR expirado (${name})`),
    qrState: 'qr-timeout',
    qrMessage: (ts) =>
      ts
        ? `O QR code expirou. Atualizado em ${ts}. Solicite um novo código de pareamento no aplicativo.`
        : 'O QR code expirou. Solicite um novo código de pareamento no aplicativo.',
    shouldLoadQr: false,
  },
};

export const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function describeConnection(source = {}) {
  const rawState = typeof source.connectionState === 'string' ? source.connectionState : undefined;
  const state = CONNECTION_STATE_META[rawState] ? rawState : source.connected ? 'open' : 'close';
  const meta = CONNECTION_STATE_META[state] || CONNECTION_STATE_META.close;
  const updatedText = formatConnectionTimestamp(source.connectionUpdatedAt);
  return { state, meta, updatedText };
}

function parseConnectionTimestamp(value) {
  if (!value && value !== 0) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatConnectionTimestamp(value) {
  const date = parseConnectionTimestamp(value);
  return date ? dateTimeFmt.format(date) : null;
}

export function toggleHidden(el, hidden) {
  if (!el) return;
  el.classList[hidden ? 'add' : 'remove']('hidden');
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
    button.disabled = true;
    button.innerHTML = `<span class="inline-flex items-center gap-2 justify-center"><span class="h-4 w-4 border-2 border-white/50 border-t-transparent rounded-full animate-spin"></span>${label || button.dataset.originalLabel}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.originalLabel) {
      button.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }
}

const INSTANCE_LOCK_ACTIONS = ['save', 'qr', 'logout', 'wipe', 'delete'];
const INSTANCE_LOCK_TIMEOUT_MS = 60_000;
const instanceActionLocks = new Map();

function escapeSelectorValue(value) {
  if (typeof CSS !== 'undefined' && CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function toggleButtonsDisabled(buttons, disabled) {
  buttons.forEach((btn) => {
    if (!btn) return;
    btn.disabled = disabled;
    btn.classList[disabled ? 'add' : 'remove']('pointer-events-none');
    btn.classList[disabled ? 'add' : 'remove']('opacity-60');
  });
}

export function setInstanceActionsDisabled(iid, disabled) {
  const selectorIid = escapeSelectorValue(iid);
  const buttons = INSTANCE_LOCK_ACTIONS.flatMap((act) =>
    Array.from(document.querySelectorAll(`[data-act="${act}"][data-iid="${selectorIid}"]`)),
  );
  toggleButtonsDisabled(buttons, disabled);
}

export function setSelectedInstanceActionsDisabled(iid, disabled) {
  if (els.selInstance?.value !== iid) return;
  const buttons = [els.btnLogout, els.btnWipe, els.btnPair, els.btnSend, els.btnRefreshLogs].filter(Boolean);
  toggleButtonsDisabled(buttons, disabled);
}

export function lockInstanceActions(iid, type = 'restart') {
  instanceActionLocks.set(iid, { type, startedAt: Date.now() });
  setInstanceActionsDisabled(iid, true);
  setSelectedInstanceActionsDisabled(iid, true);
}

export function unlockInstanceActions(iid) {
  if (!instanceActionLocks.has(iid)) return;
  instanceActionLocks.delete(iid);
  setInstanceActionsDisabled(iid, false);
  setSelectedInstanceActionsDisabled(iid, false);
}

export function isInstanceLocked(iid) {
  return instanceActionLocks.has(iid);
}

function shouldUnlockInstance(lock, snapshot, now = Date.now()) {
  if (!lock || !snapshot) return false;
  const stateRaw = typeof snapshot.connectionState === 'string' ? snapshot.connectionState : undefined;
  const state = stateRaw || (snapshot.connected ? 'open' : 'close');
  if (state === 'open' || state === 'connecting') return true;

  const updatedAt = snapshot.connectionUpdatedAt;
  const updatedMs = updatedAt ? Date.parse(updatedAt) : null;
  if (updatedMs && Number.isFinite(updatedMs) && updatedMs > lock.startedAt && state !== 'close') {
    return true;
  }

  return now - lock.startedAt > INSTANCE_LOCK_TIMEOUT_MS;
}

export function updateInstanceLocksFromSnapshot(instances = []) {
  const now = Date.now();
  instances.forEach((inst) => {
    const lock = instanceActionLocks.get(inst.id);
    if (lock && shouldUnlockInstance(lock, inst, now)) {
      unlockInstanceActions(inst.id);
    }
  });
}

export function setCardsLoading(isLoading) {
  toggleHidden(els.cardsSkeleton, !isLoading);
  toggleHidden(els.instanceLoading, !isLoading);
}

export function setMetricsLoading(isLoading) {
  toggleHidden(els.metricsSkeleton, !isLoading);
}

export function setLogsLoading(isLoading) {
  if (els.logsSkeleton) toggleHidden(els.logsSkeleton, !isLoading);
}

export function setQrState(state, message) {
  if (els.qrWrap) {
    els.qrWrap.classList.remove('border-emerald-300', 'border-rose-300', 'border-slate-200', 'border-sky-300', 'border-amber-300');
    const classMap = {
      connected: 'border-emerald-300',
      disconnected: 'border-sky-300',
      error: 'border-rose-300',
      'needs-key': 'border-amber-300',
      'qr-timeout': 'border-rose-300',
    };
    els.qrWrap.classList.add(classMap[state] || 'border-slate-200');
  }
  toggleHidden(els.qrLoader, state !== 'loading');
  if (message && els.qrHint) els.qrHint.textContent = message;
}

export function validateE164(value) {
  return /^\+?[1-9]\d{7,14}$/.test(value);
}

export function getStatusCounts(src) {
  const base = src || {};
  const totals = {};
  STATUS_SERIES.forEach((series) => {
    totals[series.key] = 0;
  });

  const handled = new Set();
  STATUS_SERIES.forEach((series) => {
    series.codes.forEach((code) => {
      const key = String(code);
      handled.add(key);
      const value = Number(base[key]);
      if (Number.isFinite(value)) totals[series.key] += value;
    });
  });

  for (const [key, value] of Object.entries(base)) {
    if (handled.has(key)) continue;
    const numeric = Number(key);
    const count = Number(value);
    if (!Number.isFinite(count)) continue;
    if (Number.isFinite(numeric) && numeric >= 6) {
      totals.failed += count;
    }
  }

  return totals;
}

const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const timeLabelFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const relativeTimeFmt = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return dateTimeFmt.format(d);
}

export function formatRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = d.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 60) return relativeTimeFmt.format(Math.round(diffSec), 'second');
  if (absSec < 3600) return relativeTimeFmt.format(Math.round(diffSec / 60), 'minute');
  if (absSec < 86400) return relativeTimeFmt.format(Math.round(diffSec / 3600), 'hour');
  return relativeTimeFmt.format(Math.round(diffSec / 86400), 'day');
}

export function formatTimelineLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeLabelFmt.format(d);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mn}`;
}

export function showError(msg) {
  console.error('[dashboard] erro:', msg);
  setBadgeState('error', msg, 5000);
}
