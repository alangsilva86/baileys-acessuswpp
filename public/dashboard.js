/* ---------- DOM refs ---------- */
const els = {
  badge: document.getElementById('badge'),
  sessionsRoot: document.getElementById('sessionsRoot'),
  selInstance: document.getElementById('selInstance'),
  btnNew: document.getElementById('btnNew'),
  cards: document.getElementById('cards'),
  cardsSkeleton: document.getElementById('cardsSkeleton'),
  instanceLoading: document.getElementById('instanceLoading'),

  // Note card
  noteCard: document.getElementById('noteCard'),
  noteMeta: document.getElementById('noteMeta'),
  instanceNote: document.getElementById('instanceNote'),
  noteStatus: document.getElementById('noteStatus'),
  noteRetry: document.getElementById('noteRetry'),

  // KPIs
  selRange: document.getElementById('selRange'),
  kpiDeliveryValue: document.getElementById('kpiDeliveryValue'),
  kpiDeliveryHint: document.getElementById('kpiDeliveryHint'),
  kpiFailureValue: document.getElementById('kpiFailureValue'),
  kpiFailureHint: document.getElementById('kpiFailureHint'),
  kpiRateValue: document.getElementById('kpiRateValue'),
  kpiRateHint: document.getElementById('kpiRateHint'),
  kpiAckValue: document.getElementById('kpiAckValue'),
  kpiAckHint: document.getElementById('kpiAckHint'),
  chartHint: document.getElementById('chartHint'),
  metricsSkeleton: document.getElementById('metricsSkeleton'),

  // QR / ações rápidas
  qrWrap: document.getElementById('qrWrap'),
  qrImg: document.getElementById('qrImg'),
  qrHint: document.getElementById('qrHint'),
  qrLoader: document.getElementById('qrLoader'),
  btnLogout: document.getElementById('btnLogout'),
  btnWipe: document.getElementById('btnWipe'),
  btnPair: document.getElementById('btnPair'),

  // Envio rápido
  inpApiKey: document.getElementById('inpApiKey'),
  inpPhone: document.getElementById('inpPhone'),
  inpMsg: document.getElementById('inpMsg'),
  btnSend: document.getElementById('btnSend'),
  sendOut: document.getElementById('sendOut'),
  msgCounter: document.getElementById('msgCounter'),

  // Logs recentes
  btnRefreshLogs: document.getElementById('btnRefreshLogs'),
  logsList: document.getElementById('logsList'),
  logsEmpty: document.getElementById('logsEmpty'),

  // Modal
  modalDelete: document.getElementById('modalDelete'),
  modalInstanceName: document.getElementById('modalInstanceName'),
  modalConfirm: document.querySelector('[data-act="modal-confirm"]'),
  modalCancel: document.querySelector('[data-act="modal-cancel"]'),

  // Pair modal
  pairModal: document.getElementById('pairModal'),
  pairModalCode: document.getElementById('pairModalCode'),
  pairModalClose: document.getElementById('pairModalClose'),
  pairModalCopy: document.getElementById('pairModalCopy'),
};

const STATUS_META = {
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

const STATUS_CODES = ['1', '2', '3', '4', '5'];
const TIMELINE_FIELDS = {
  '1': 'pending',
  '2': 'serverAck',
  '3': 'delivered',
  '4': 'read',
  '5': 'played',
};

const NOTE_STATE = {
  lastSaved: '',
  createdAt: null,
  updatedAt: null,
  timer: null,
  pending: '',
  saving: false,
};

const REFRESH_INTERVAL_MS = 5000;

const sharedState = window.dashboardSharedState || {
  telemetry: {
    lastRoundStartedAt: null,
    lastRoundCompletedAt: null,
    lastRoundDurationMs: null,
  },
  scheduler: {
    currentTimer: null,
    currentController: null,
    runningPromise: null,
  },
};
window.dashboardSharedState = sharedState;

const LOG_DIRECTION_META = {
  inbound: { label: 'Inbound', className: 'bg-emerald-100 text-emerald-700' },
  outbound: { label: 'Outbound', className: 'bg-sky-100 text-sky-700' },
  system: { label: 'System', className: 'bg-slate-200 text-slate-700' },
};

const DELIVERY_STATE_META = {
  pending: { label: 'Webhook pendente', className: 'bg-amber-100 text-amber-700' },
  retry: { label: 'Reenvio agendado', className: 'bg-amber-100 text-amber-700' },
  success: { label: 'Webhook entregue', className: 'bg-emerald-100 text-emerald-700' },
  failed: { label: 'Webhook falhou', className: 'bg-rose-100 text-rose-700' },
};

let lastLogsSignature = '';

/* ---------- Helpers UI ---------- */
const BADGE_STYLES = {
  'status-connected': 'bg-emerald-100 text-emerald-800',
  'status-disconnected': 'bg-rose-100 text-rose-800',
  'status-connecting': 'bg-amber-100 text-amber-800',
  logout: 'bg-amber-100 text-amber-800',
  wipe: 'bg-rose-200 text-rose-900',
  delete: 'bg-rose-600 text-white',
  update: 'bg-sky-100 text-sky-800',
  error: 'bg-amber-100 text-amber-800',
  info: 'bg-slate-200 text-slate-800'
};
let badgeLockUntil = 0;

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
};

function applyBadge(type, msg) {
  const cls = BADGE_STYLES[type] || BADGE_STYLES.info;
  els.badge.className = 'px-3 py-1 rounded-full text-sm ' + cls;
  els.badge.textContent = msg;
}
function setBadgeState(type, msg, holdMs = 4000) {
  applyBadge(type, msg);
  badgeLockUntil = holdMs ? Date.now() + holdMs : 0;
}
function canUpdateBadge() { return Date.now() >= badgeLockUntil; }
function setStatusBadge(connection, name) {
  if (!canUpdateBadge()) return;
  const info = connection || {};
  const meta = info.meta || CONNECTION_STATE_META.close;
  const text = typeof meta.badgeText === 'function'
    ? meta.badgeText(name, info.updatedText)
    : `${meta.label} (${name})${info.updatedText ? ' • ' + info.updatedText : ''}`;
  applyBadge(meta.badgeType || 'info', text);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(val) { return String(val ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] || ch); }

function toggleHidden(el, hidden) {
  if (!el) return;
  el.classList[hidden ? 'add' : 'remove']('hidden');
}

function setBusy(button, busy, label) {
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

function setInstanceActionsDisabled(iid, disabled) {
  const selectorIid = escapeSelectorValue(iid);
  const buttons = INSTANCE_LOCK_ACTIONS.flatMap((act) =>
    Array.from(document.querySelectorAll(`[data-act="${act}"][data-iid="${selectorIid}"]`)),
  );
  toggleButtonsDisabled(buttons, disabled);
}

function setSelectedInstanceActionsDisabled(iid, disabled) {
  if (els.selInstance?.value !== iid) return;
  toggleButtonsDisabled(
    [els.btnLogout, els.btnWipe, els.btnPair, els.btnSend, els.btnRefreshLogs].filter(Boolean),
    disabled,
  );
}

function lockInstanceActions(iid, type = 'restart') {
  instanceActionLocks.set(iid, { type, startedAt: Date.now() });
  setInstanceActionsDisabled(iid, true);
  setSelectedInstanceActionsDisabled(iid, true);
}

function unlockInstanceActions(iid) {
  if (!instanceActionLocks.has(iid)) return;
  instanceActionLocks.delete(iid);
  setInstanceActionsDisabled(iid, false);
  setSelectedInstanceActionsDisabled(iid, false);
}

function isInstanceLocked(iid) {
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

function updateInstanceLocksFromSnapshot(instances = []) {
  const now = Date.now();
  instances.forEach((inst) => {
    const lock = instanceActionLocks.get(inst.id);
    if (lock && shouldUnlockInstance(lock, inst, now)) {
      unlockInstanceActions(inst.id);
    }
  });
}

function setCardsLoading(isLoading) {
  toggleHidden(els.cardsSkeleton, !isLoading);
  toggleHidden(els.instanceLoading, !isLoading);
}

function setMetricsLoading(isLoading) {
  toggleHidden(els.metricsSkeleton, !isLoading);
}

function resetLogs() {
  if (!els.logsList || !els.logsEmpty) return;
  els.logsList.textContent = '';
  toggleHidden(els.logsEmpty, false);
  lastLogsSignature = '';
}

function setQrState(state, message) {
  if (els.qrWrap) {
    els.qrWrap.classList.remove('border-emerald-300', 'border-rose-300', 'border-slate-200', 'border-sky-300', 'border-amber-300');
    const classMap = {
      connected: 'border-emerald-300',
      disconnected: 'border-sky-300',
      error: 'border-rose-300',
      'needs-key': 'border-amber-300',
    };
    els.qrWrap.classList.add(classMap[state] || 'border-slate-200');
  }
  toggleHidden(els.qrLoader, state !== 'loading');
  if (message && els.qrHint) els.qrHint.textContent = message;
}

function validateE164(value) {
  return /^\+?[1-9]\d{7,14}$/.test(value);
}

const SEND_OUT_CLASSES = {
  success: 'text-emerald-700 bg-emerald-50',
  error: 'text-rose-700 bg-rose-50',
  info: 'text-slate-600 bg-slate-50',
};

function setSendOut(message, tone = 'info') {
  if (!els.sendOut) return;
  els.sendOut.textContent = message;
  const toneClass = SEND_OUT_CLASSES[tone] || SEND_OUT_CLASSES.info;
  els.sendOut.className = 'text-xs rounded p-2 min-h-[2rem] ' + toneClass;
}

function updateMsgCounter() {
  if (!els.msgCounter || !els.inpMsg) return;
  const len = els.inpMsg.value.length;
  els.msgCounter.textContent = len;
  if (len > 4096) {
    els.msgCounter.classList.add('text-rose-600');
  } else {
    els.msgCounter.classList.remove('text-rose-600');
  }
}

function getStatusCounts(src) {
  const base = src || {};
  const result = {};
  STATUS_CODES.forEach(code => {
    const num = Number(base[code]);
    result[code] = Number.isFinite(num) ? num : 0;
  });
  return result;
}

const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const timeLabelFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function parseConnectionTimestamp(value) {
  if (!value && value !== 0) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatConnectionTimestamp(value) {
  const date = parseConnectionTimestamp(value);
  return date ? dateTimeFmt.format(date) : null;
}

function describeConnection(source = {}) {
  const rawState = typeof source.connectionState === 'string' ? source.connectionState : undefined;
  const state = CONNECTION_STATE_META[rawState] ? rawState : source.connected ? 'open' : 'close';
  const meta = CONNECTION_STATE_META[state] || CONNECTION_STATE_META.close;
  const updatedText = formatConnectionTimestamp(source.connectionUpdatedAt);
  return { state, meta, updatedText };
}
const relativeTimeFmt = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return dateTimeFmt.format(d);
}

function formatRelativeTime(iso) {
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

function formatLogTimestamp(event) {
  const ts = event?.payload?.metadata?.timestamp;
  if (ts) return formatDateTime(ts);

  const webhookTs = event?.payload?.body?.timestamp;
  if (webhookTs != null) {
    const secs = Number(webhookTs);
    if (Number.isFinite(secs)) {
      return formatDateTime(new Date(secs * 1000).toISOString());
    }
  }

  if (event?.createdAt) return formatDateTime(new Date(event.createdAt).toISOString());
  return '';
}

function summarizeLogMessage(event) {
  const payload = event?.payload;
  if (!payload || typeof payload !== 'object') return '';

  if (event?.type === 'WEBHOOK_DELIVERY') {
    const state = (payload.state || '').toString();
    const attempt = Number(payload.attempt) || 0;
    const maxAttempts = Number(payload.maxAttempts) || null;
    const status = payload.status != null ? `HTTP ${payload.status}` : '';
    const pieces = [
      payload.event ? `Webhook ${payload.event}` : 'Webhook',
      state ? `estado: ${state}` : '',
      attempt ? `tentativa ${attempt}${maxAttempts ? `/${maxAttempts}` : ''}` : '',
      status,
    ].filter(Boolean);
    return pieces.join(' • ');
  }

  if (!payload || typeof payload !== 'object') return '';
  const message = payload.message || {};
  if (message.text) return String(message.text).slice(0, 140);
  if (message.media?.caption) return String(message.media.caption).slice(0, 140);
  if (payload.error) return String(payload.error).slice(0, 140);
  if (message.interactive?.type) return `Interativo: ${message.interactive.type}`;
  if (message.type) return `Tipo: ${message.type}`;
  return '';
}

function extractDeliveryInfo(event) {
  if (event?.delivery) {
    return {
      state: event.delivery.state,
      attempts: event.delivery.attempts,
      lastAttemptAt: event.delivery.lastAttemptAt,
      lastStatus: event.delivery.lastStatus ?? null,
      lastError: event.delivery.lastError ?? null,
    };
  }

  if (event?.type === 'WEBHOOK_DELIVERY') {
    const payload = event.payload || {};
    return {
      state: payload.state || 'pending',
      attempts: Number(payload.attempt) || 0,
      lastAttemptAt:
        event.createdAt != null && Number.isFinite(Number(event.createdAt))
          ? Number(event.createdAt)
          : null,
      lastStatus: payload.status ?? null,
      lastError: payload.error ?? null,
      maxAttempts: Number(payload.maxAttempts) || null,
    };
  }

  return null;
}

function buildDeliveryBadge(event) {
  const info = extractDeliveryInfo(event);
  if (!info) return null;
  const meta = DELIVERY_STATE_META[info.state] || DELIVERY_STATE_META.pending;
  const badge = document.createElement('span');
  badge.className = 'px-2 py-0.5 rounded-full text-[11px] ' + meta.className;
  const attemptsText = info.attempts
    ? ` (${info.attempts} tentativa${info.attempts > 1 ? 's' : ''})`
    : '';
  badge.textContent = meta.label + attemptsText;

  const parts = [];
  if (info.lastStatus) parts.push(`HTTP ${info.lastStatus}`);
  if (info.lastError?.message && info.state !== 'success') parts.push(info.lastError.message);
  if (info.lastAttemptAt) parts.push(`Última: ${formatDateTime(new Date(info.lastAttemptAt).toISOString())}`);
  if (parts.length) badge.title = parts.join(' • ');

  return badge;
}

function extractContactInfo(event) {
  if (event?.payload?.contact) return event.payload.contact;
  const webhookContact = event?.payload?.body?.payload?.contact;
  if (webhookContact) return webhookContact;
  return null;
}

function renderLogs(events) {
  if (!els.logsList || !els.logsEmpty) return;
  els.logsList.textContent = '';

  if (!events.length) {
    toggleHidden(els.logsEmpty, false);
    return;
  }

  toggleHidden(els.logsEmpty, true);
  const fragment = document.createDocumentFragment();

  events.forEach((event) => {
    const details = document.createElement('details');
    details.className = 'bg-slate-50 border border-slate-200 rounded-xl overflow-hidden';

    const summary = document.createElement('summary');
    summary.className = 'flex items-center justify-between gap-3 px-3 py-2 cursor-pointer select-none text-sm font-medium text-slate-700';

    const left = document.createElement('span');
    left.className = 'flex items-center gap-2';

    const directionMeta = LOG_DIRECTION_META[event.direction] || LOG_DIRECTION_META.system;
    const directionBadge = document.createElement('span');
    directionBadge.className = 'px-2 py-0.5 rounded-full text-xs ' + directionMeta.className;
    directionBadge.textContent = directionMeta.label;
    left.appendChild(directionBadge);

    const typeBadge = document.createElement('span');
    typeBadge.textContent = event.type || '—';
    left.appendChild(typeBadge);

    const deliveryBadge = buildDeliveryBadge(event);
    if (deliveryBadge) {
      left.appendChild(deliveryBadge);
    } else {
      const ackBadge = document.createElement('span');
      ackBadge.className =
        'px-2 py-0.5 rounded-full text-[11px] ' +
        (event.acknowledged ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700');
      ackBadge.textContent = event.acknowledged ? 'Ack recebido' : 'Sem ack';
      left.appendChild(ackBadge);
    }

    const ts = document.createElement('span');
    ts.className = 'text-xs text-slate-500';
    ts.textContent = formatLogTimestamp(event);

    summary.appendChild(left);
    summary.appendChild(ts);

    const body = document.createElement('div');
    body.className = 'px-3 pb-3 pt-1 space-y-2 text-sm text-slate-600';

    const snippetText = summarizeLogMessage(event);
    if (snippetText) {
      const snippet = document.createElement('p');
      snippet.className = 'text-sm text-slate-600';
      snippet.textContent = snippetText;
      body.appendChild(snippet);
    }

    const contact = extractContactInfo(event);
    if (contact) {
      const contactInfo = document.createElement('div');
      contactInfo.className = 'text-xs text-slate-500';
      const parts = [];
      if (contact.displayName) parts.push(`Contato: ${contact.displayName}`);
      if (contact.phone) parts.push(`Telefone: ${contact.phone}`);
      if (contact.remoteJid) parts.push(`Chat: ${contact.remoteJid}`);
      if (!parts.length) parts.push('Contato não identificado');
      contactInfo.textContent = parts.join(' • ');
      body.appendChild(contactInfo);
    }

    const deliveryInfo = extractDeliveryInfo(event);
    if (deliveryInfo) {
      const deliveryDetails = document.createElement('div');
      deliveryDetails.className = 'text-xs text-slate-500';
      const parts = [`Estado: ${deliveryInfo.state}`];
      if (deliveryInfo.attempts) parts.push(`Tentativas: ${deliveryInfo.attempts}`);
      if (deliveryInfo.lastStatus) parts.push(`HTTP: ${deliveryInfo.lastStatus}`);
      if (deliveryInfo.lastError?.message && deliveryInfo.state !== 'success') {
        parts.push(`Erro: ${deliveryInfo.lastError.message}`);
      }
      deliveryDetails.textContent = parts.join(' • ');
      body.appendChild(deliveryDetails);
    }

    const pre = document.createElement('pre');
    pre.className = 'text-xs bg-slate-900 text-slate-100 rounded-lg p-3 overflow-x-auto';
    pre.textContent = JSON.stringify(event.payload, null, 2);
    body.appendChild(pre);

    details.appendChild(summary);
    details.appendChild(body);
    fragment.appendChild(details);
  });

  els.logsList.appendChild(fragment);
}

const NOTE_STATUS_VARIANTS = {
  synced: { text: 'Notas sincronizadas', className: 'text-emerald-600' },
  saving: { text: 'Salvando…', className: 'text-slate-500' },
  needsKey: { text: 'Informe a API Key para salvar automaticamente.', className: 'text-amber-600' },
  error: { text: 'Erro ao salvar notas', className: 'text-rose-600' },
};

function setNoteStatus(state, extra = '') {
  if (!els.noteStatus) return;
  const variant = NOTE_STATUS_VARIANTS[state] || { text: '', className: 'text-slate-500' };
  const baseText = variant.text || '';
  const text = extra ? (baseText ? `${baseText} — ${extra}` : extra) : baseText;
  els.noteStatus.textContent = text;
  els.noteStatus.className = 'text-[11px] ' + (variant.className || 'text-slate-500');
  if (state === 'error' || state === 'needsKey') {
    toggleHidden(els.noteRetry, false);
  } else {
    toggleHidden(els.noteRetry, true);
  }
}

function updateNoteMetaText() {
  if (!els.noteMeta) return;
  const created = formatDateTime(NOTE_STATE.createdAt);
  const updated = formatDateTime(NOTE_STATE.updatedAt);
  const relative = formatRelativeTime(NOTE_STATE.updatedAt);
  const parts = [];
  if (created) parts.push(`Criado: ${created}`);
  if (updated) parts.push(`Atualizado: ${updated}${relative ? ` (${relative})` : ''}`);
  els.noteMeta.textContent = parts.join(' • ');
}

const NOTE_AUTOSAVE_DEBOUNCE = 800;

function scheduleNoteAutosave(immediate = false) {
  if (!els.instanceNote || !els.selInstance?.value) return;
  const value = els.instanceNote.value;
  NOTE_STATE.pending = value;
  if (value.trim() === NOTE_STATE.lastSaved.trim()) {
    setNoteStatus('synced');
    return;
  }
  setNoteStatus('saving');
  if (NOTE_STATE.timer) clearTimeout(NOTE_STATE.timer);
  NOTE_STATE.timer = setTimeout(runNoteAutosave, immediate ? 0 : NOTE_AUTOSAVE_DEBOUNCE);
}

async function runNoteAutosave() {
  if (!els.selInstance?.value) return;
  if (NOTE_STATE.timer) {
    clearTimeout(NOTE_STATE.timer);
    NOTE_STATE.timer = null;
  }
  const key = els.inpApiKey?.value?.trim();
  if (!key) {
    setNoteStatus('needsKey');
    return;
  }
  NOTE_STATE.saving = true;
  try {
    const payload = await fetchJSON('/instances/' + els.selInstance.value, true, {
      method: 'PATCH',
      body: JSON.stringify({ note: NOTE_STATE.pending }),
    });
    NOTE_STATE.lastSaved = (NOTE_STATE.pending || '').trim();
    NOTE_STATE.updatedAt = payload?.metadata?.updatedAt || new Date().toISOString();
    NOTE_STATE.createdAt = payload?.metadata?.createdAt || NOTE_STATE.createdAt;
    updateNoteMetaText();
    setNoteStatus('synced');
  } catch (err) {
    console.error('[dashboard] erro ao salvar notas', err);
    setNoteStatus('error', err.message || 'Falha inesperada');
  } finally {
    NOTE_STATE.saving = false;
  }
}
function formatTimelineLabel(iso) {
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
function option(v, t) { const o = document.createElement('option'); o.value=v; o.textContent=t; return o; }

/* ---------- Persistência local simples ---------- */
els.inpApiKey.value = localStorage.getItem('x_api_key') || '';
els.sessionsRoot.textContent = ''; // Será preenchido via API
els.inpApiKey?.addEventListener('input', () => {
  localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
});
const savedRange = localStorage.getItem('metrics_range') || '240';
if (els.selRange) {
  const values = Array.from(els.selRange.options).map(o => o.value);
  if (values.includes(savedRange)) els.selRange.value = savedRange;
  els.selRange.addEventListener('change', () => {
    localStorage.setItem('metrics_range', els.selRange.value);
    triggerFullRefresh({ withSkeleton: true });
  });
}

if (els.instanceNote) {
  els.instanceNote.addEventListener('input', () => scheduleNoteAutosave());
  els.instanceNote.addEventListener('blur', () => scheduleNoteAutosave(true));
}
if (els.noteRetry) {
  els.noteRetry.addEventListener('click', () => scheduleNoteAutosave(true));
}

if (els.inpMsg) {
  els.inpMsg.addEventListener('input', updateMsgCounter);
  updateMsgCounter();
}

setInterval(updateNoteMetaText, 60000);
setNoteStatus('synced');

/* ---------- Requisições ---------- */
function showError(msg) {
  console.error('[dashboard] erro:', msg);
  setBadgeState('error', msg, 5000);
}
function requireKey() {
  const k = els.inpApiKey?.value?.trim();
  if (!k) {
    showError('Informe x-api-key para usar ações');
    try { els.inpApiKey.focus(); } catch {}
    throw new Error('missing_api_key');
  }
  return k;
}
async function fetchJSON(path, auth=true, opts={}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const k = els.inpApiKey?.value?.trim();
    if (k) headers['x-api-key'] = k;
    const sel = els.selInstance?.value;
    if (sel) headers['x-instance-id'] = sel;
  }
  const r = await fetch(path, { headers, cache: 'no-store', ...opts });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('HTTP ' + r.status + (txt ? ' — ' + txt : ''));
  }
  try { return await r.json(); } catch { return {}; }
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

/* ---------- KPI helpers ---------- */
function percent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), 1);
  return Math.round(clamped * 100);
}

let chart;
let hasLoadedInstances = false;
let refreshInstancesInFlight = null;
let hasLoadedSelected = false;
function initChart() {
  const ctx = document.getElementById('metricsChart').getContext('2d');
  const statusDatasets = STATUS_CODES.map(code => {
    const meta = STATUS_META[code] || {};
    const label = meta.name ? `${meta.name}` : `Status ${code}`;
    return {
      label: `Status ${code} (${label})`,
      data: [],
      borderColor: meta.chartColor || '#94a3b8',
      backgroundColor: meta.chartBackground || 'rgba(148,163,184,0.15)',
      tension: 0.25,
      fill: false,
    };
  });
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Enviadas', data: [], borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.15)', tension: 0.25, fill: false },
        ...statusDatasets,
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grace: '5%' }
      },
      plugins: { legend: { display: true, position: 'bottom' } }
    }
  });
}
function resetChart() {
  chart.data.labels = [];
  chart.data.datasets.forEach(ds => ds.data = []);
  chart.update('none');
  if (els.chartHint) els.chartHint.textContent = 'Nenhum dado disponível ainda.';
}
function updateKpis(metrics) {
  const counters = metrics?.counters || {};
  const statusCounts = getStatusCounts(counters.statusCounts || counters.status || {});
  const sent = counters.sent || 0;
  const pending = statusCounts['1'];
  const serverAck = statusCounts['2'];
  const delivered = statusCounts['3'];
  const read = statusCounts['4'];
  const played = statusCounts['5'];

  if (sent) {
    const deliveryPct = Math.round((delivered / sent) * 100);
    els.kpiDeliveryValue.textContent = deliveryPct + '%';
    els.kpiDeliveryHint.textContent = `${delivered} de ${sent} mensagens entregues (status 3). Pendentes: ${pending} • Servidor recebeu: ${serverAck}`;
  } else {
    els.kpiDeliveryValue.textContent = '—';
    els.kpiDeliveryHint.textContent = 'Envie uma mensagem para iniciar o monitoramento.';
  }

  els.kpiFailureValue.className = 'mt-1 text-2xl font-semibold text-indigo-600';
  if (sent) {
    els.kpiFailureValue.textContent = String(read || 0);
    els.kpiFailureHint.textContent = `Status 4 (Lidas): ${read} • Status 5 (Reproduzidas): ${played}`;
  } else {
    els.kpiFailureValue.textContent = '0';
    els.kpiFailureHint.textContent = 'Envie mensagens para acompanhar leituras e reproduções.';
  }

  const usage = metrics?.rate?.usage || 0;
  const ratePercent = percent(usage);
  els.kpiRateValue.textContent = ratePercent + '%';
  els.kpiRateHint.textContent = `${metrics?.rate?.inWindow || 0}/${metrics?.rate?.limit || 0} envios na janela`;
  els.kpiRateValue.className = 'mt-1 text-2xl font-semibold ' + (ratePercent >= 90 ? 'text-rose-600' : ratePercent >= 70 ? 'text-amber-600' : 'text-emerald-600');

  const samples = metrics?.ack?.samples || 0;
  if (samples) {
    const avgMs = Math.round(metrics?.ack?.avgMs || 0);
    els.kpiAckValue.textContent = `${avgMs} ms`;
    const lastMs = metrics?.ack?.lastMs ? Math.round(metrics.ack.lastMs) + ' ms' : '—';
    els.kpiAckHint.textContent = `${samples} amostra${samples > 1 ? 's' : ''} • último: ${lastMs}`;
  } else {
    els.kpiAckValue.textContent = '—';
    els.kpiAckHint.textContent = 'Envie mensagens com confirmação para ver este indicador.';
  }
}

/* ---------- Instâncias ---------- */
async function refreshInstances(options = {}) {
  if (refreshInstancesInFlight) return refreshInstancesInFlight;
  const { silent = false, withSkeleton, signal } = options;
  const shouldShowSkeleton = withSkeleton ?? (!hasLoadedInstances && !silent);
  if (shouldShowSkeleton || !hasLoadedInstances) setCardsLoading(true);

  refreshInstancesInFlight = (async () => {
    try {
      const data = await fetchJSON('/instances', true, { signal });
      if (signal?.aborted) return;
      updateInstanceLocksFromSnapshot(data);
      const prev = els.selInstance.value;
      els.selInstance.textContent = '';

      if (!Array.isArray(data) || !data.length) {
        els.selInstance.value = '';
        els.cards.innerHTML = '<div class="p-4 bg-white rounded-2xl shadow text-sm text-slate-500">Nenhuma instância cadastrada ainda. Clique em “+ Nova instância”.</div>';
        if (els.noteCard) els.noteCard.classList.add('hidden');
        NOTE_STATE.lastSaved = '';
        NOTE_STATE.createdAt = null;
        NOTE_STATE.updatedAt = null;
        updateNoteMetaText();
        resetChart();
        resetLogs();
        toggleHidden(els.qrImg, true);
        setQrState('idle', 'Selecione uma instância para visualizar o QR.');
        setBadgeState('info', 'Crie uma instância para começar', 4000);
        hasLoadedInstances = true;
        hasLoadedSelected = false;
        return;
      }

      let keepPrev = false;
      data.forEach(inst => {
        const connection = describeConnection(inst);
        const suffix = connection.meta?.optionSuffix || '';
        const label = `${inst.name}${suffix}`;
        const opt = option(inst.id, label);
        if (inst.id === prev) { opt.selected = true; keepPrev = true; }
        els.selInstance.appendChild(opt);
      });
      if (!keepPrev && data[0]) els.selInstance.value = data[0].id;

      els.cards.innerHTML = '';
      const selected = els.selInstance.value;
      data.forEach(i => {
        const connection = describeConnection(i);
        const card = document.createElement('article');
        card.className = 'p-4 bg-white rounded-2xl shadow transition ring-emerald-200/50 space-y-3';
        if (i.id === selected) card.classList.add('ring-2', 'ring-emerald-200');
        const locked = isInstanceLocked(i.id);
        card.classList.toggle('opacity-75', locked);
        const badgeClass = connection.meta?.badgeClass || 'bg-slate-100 text-slate-700';
        const statusLabel = typeof connection.meta?.cardLabel === 'function'
          ? connection.meta.cardLabel(connection.updatedText)
          : connection.meta?.label || 'Desconhecido';
        const sent = i.counters?.sent || 0;
        const statusCounts = getStatusCounts(i.counters?.statusCounts || i.counters?.status || {});
        const statusCardsHtml = STATUS_CODES.map(code => {
          const meta = STATUS_META[code] || {};
          const titleAttr = meta.description ? ` title="${escapeHtml(meta.description)}"` : '';
          const label = escapeHtml(meta.name || `Status ${code}`);
          return `
          <div class="rounded-lg bg-slate-50 p-2"${titleAttr}>
            <span class="block text-[11px] uppercase tracking-wide text-slate-400">Status ${code} • ${label}</span>
            <span class="text-sm font-semibold ${meta.textClass || 'text-slate-600'}">${statusCounts[code] || 0}</span>
          </div>`;
        }).join('');
        const usagePercent = percent(i.rate?.usage || 0);
        const meterColor = usagePercent >= 90 ? 'bg-rose-400' : usagePercent >= 70 ? 'bg-amber-400' : 'bg-emerald-400';
        const userId = i.user?.id ? escapeHtml(i.user.id) : '—';
        const noteVal = (i.note || i.notes || '').trim();

        card.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1">
            <label class="text-xs font-medium text-slate-500">Nome</label>
            <input data-field="name" data-iid="${i.id}" class="mt-1 w-full border rounded-lg px-2 py-1 text-sm" value="${escapeHtml(i.name)}" />
          </div>
          <span class="px-2 py-0.5 rounded text-xs ${badgeClass}">
            ${escapeHtml(statusLabel)}
          </span>
        </div>

        <div class="text-xs text-slate-500 break-all">WhatsApp: ${userId}</div>

        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
          <div class="rounded-lg bg-slate-50 p-2">
            <span class="block text-[11px] uppercase tracking-wide text-slate-400">Enviadas</span>
            <span class="text-sm font-semibold text-slate-700">${sent}</span>
          </div>
          ${statusCardsHtml}
          <div class="col-span-2 md:col-span-3 space-y-1">
            <div class="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
              <span>Uso do limite</span>
              <span>${usagePercent}%</span>
            </div>
            <div class="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div class="h-full ${meterColor}" style="width:${Math.min(usagePercent, 100)}%"></div>
            </div>
            <div class="text-[11px] text-slate-400">Status 1: ${statusCounts['1'] || 0} • Status 2: ${statusCounts['2'] || 0} • Status 3: ${statusCounts['3'] || 0} • Status 4: ${statusCounts['4'] || 0} • Status 5: ${statusCounts['5'] || 0}</div>
          </div>
        </div>

        <div>
          <label class="text-xs font-medium text-slate-500">Notas</label>
          <textarea data-field="note" data-iid="${i.id}" rows="3" class="mt-1 w-full border rounded-lg px-2 py-1 text-sm">${escapeHtml(noteVal)}</textarea>
        </div>

        <div class="flex items-center justify-end gap-2 flex-wrap">
          <button data-act="save" data-iid="${i.id}" class="px-3 py-1.5 text-sm bg-sky-600 hover:bg-sky-700 text-white rounded-lg">Salvar</button>
          <button data-act="select" data-iid="${i.id}" class="px-3 py-1.5 text-sm border rounded-lg">Selecionar</button>
          <button data-act="qr" data-iid="${i.id}" class="px-3 py-1.5 text-sm border rounded-lg">Ver QR</button>
          <button data-act="logout" data-iid="${i.id}" class="px-3 py-1.5 text-sm border rounded-lg">Logout</button>
          <button data-act="wipe" data-iid="${i.id}" class="px-3 py-1.5 text-sm border rounded-lg">Wipe</button>
          <button data-act="delete" data-iid="${i.id}" class="px-3 py-1.5 text-sm bg-rose-500 hover:bg-rose-600 text-white rounded-lg">Excluir</button>
        </div>
      `;
        els.cards.appendChild(card);
        setInstanceActionsDisabled(i.id, locked);
      });

      hasLoadedInstances = true;
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return;
      console.error('[dashboard] erro ao buscar instâncias', err);
      showError('Falha ao carregar instâncias');
    } finally {
      if (!signal?.aborted) setCardsLoading(false);
      refreshInstancesInFlight = null;
      const currentSelected = els.selInstance.value;
      if (currentSelected) {
        setSelectedInstanceActionsDisabled(currentSelected, isInstanceLocked(currentSelected));
      }
    }
  })();

  return refreshInstancesInFlight;
}

/* Carregar QR code com autenticação */
async function loadQRCode(iid, options = {}) {
  const { attempts = 3, delayMs = 2000 } = options;
  try {
    const k = els.inpApiKey?.value?.trim();
    if (!k) {
      toggleHidden(els.qrImg, true);
      setQrState('needs-key', 'Informe a API Key para ver o QR code.');
      return false;
    }

    const headers = { 'x-api-key': k };
    let attempt = 0;
    while (attempt < attempts) {
      attempt += 1;
      const response = await fetch('/instances/' + iid + '/qr.png?t=' + Date.now(), {
        headers,
        cache: 'no-store'
      });

      if (response.ok) {
        const blob = await response.blob();
        const imageUrl = URL.createObjectURL(blob);
        els.qrImg.src = imageUrl;
        toggleHidden(els.qrImg, false);

        els.qrImg.onload = () => {
          if (els.qrImg.previousImageUrl) {
            URL.revokeObjectURL(els.qrImg.previousImageUrl);
          }
          els.qrImg.previousImageUrl = imageUrl;
        };

        return true;
      }

      if (response.status === 401) {
        toggleHidden(els.qrImg, true);
        setQrState('needs-key', 'API Key inválida.');
        return false;
      }

      if (response.status === 404) {
        toggleHidden(els.qrImg, true);
        if (attempt < attempts) {
          setQrState('loading', 'QR code ainda não disponível. Tentando novamente…');
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        setQrState('error', 'QR code não disponível ainda.');
        return false;
      }

      throw new Error('HTTP ' + response.status);
    }

    return false;
  } catch (err) {
    console.error('[dashboard] erro ao carregar QR code', err);
    toggleHidden(els.qrImg, true);
    setQrState('error', 'Erro ao carregar QR code.');
    return false;
  }
}

async function refreshSelected(options = {}) {
  const { silent = false, withSkeleton, signal } = options;
  const iid = els.selInstance.value;

  if (!iid) {
    toggleHidden(els.qrImg, true);
    setQrState('idle', 'Nenhuma instância selecionada.');
    if (els.noteCard) els.noteCard.classList.add('hidden');
    resetChart();
    resetLogs();
    hasLoadedSelected = false;
    return;
  }

  const shouldShowMetricsSkeleton = withSkeleton ?? (!silent && !hasLoadedSelected);
  if (shouldShowMetricsSkeleton) setMetricsLoading(true);
  if (!silent) {
    toggleHidden(els.qrImg, true);
    setQrState('loading', 'Sincronizando instância…');
  }

  try {
    const [data, metrics] = await Promise.all([
      fetchJSON('/instances/' + iid, true, { signal }),
      fetchJSON('/instances/' + iid + '/metrics', true, { signal }),
    ]);

    if (signal?.aborted) return;

    updateInstanceLocksFromSnapshot([data]);
    const connection = describeConnection(data);
    setStatusBadge(connection, data.name);
    setSelectedInstanceActionsDisabled(iid, isInstanceLocked(iid));

    if (els.noteCard) {
      els.noteCard.classList.remove('hidden');
      const noteVal = data.note || '';
      els.instanceNote.value = noteVal;
      NOTE_STATE.pending = noteVal;
      NOTE_STATE.lastSaved = noteVal.trim();
      NOTE_STATE.createdAt = data.metadata?.createdAt || null;
      NOTE_STATE.updatedAt = data.metadata?.updatedAt || null;
      updateNoteMetaText();
      setNoteStatus('synced');
    }

    if (signal?.aborted) return;

    if (connection.meta?.shouldLoadQr) {
      setQrState('loading', 'Sincronizando QR…');
      const qrOk = await loadQRCode(iid, { attempts: 5, delayMs: 2000 });
      if (qrOk) {
        const qrMessage = connection.meta?.qrMessage
          ? connection.meta.qrMessage(connection.updatedText)
          : 'Instância desconectada.';
        setQrState(connection.meta.qrState, qrMessage);
      }
    } else {
      toggleHidden(els.qrImg, true);
      const qrMessage = connection.meta?.qrMessage
        ? connection.meta.qrMessage(connection.updatedText)
        : 'Instância conectada.';
      setQrState(connection.meta?.qrState || 'loading', qrMessage);
    }

    if (signal?.aborted) return;

    updateKpis(metrics);

    const rangeMins = Number(els.selRange.value) || 240;
    const since = Date.now() - rangeMins * 60 * 1000;
    const timeline = (metrics.timeline || []).filter(p => p.ts >= since);

    if (timeline.length > 1) {
      chart.data.labels = timeline.map(p => formatTimelineLabel(p.iso));
      chart.data.datasets[0].data = timeline.map(p => p.sent ?? 0);
      STATUS_CODES.forEach((code, idx) => {
        const key = TIMELINE_FIELDS[code];
        chart.data.datasets[idx + 1].data = timeline.map(p => (key ? (p[key] ?? 0) : 0));
      });
      chart.update();
      if (els.chartHint) els.chartHint.textContent = `Exibindo ${timeline.length} pontos de dados.`;
    } else {
      resetChart();
    }

    hasLoadedSelected = true;
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) return;
    console.error('[dashboard] erro ao buscar detalhes da instância', err);
    showError('Falha ao carregar detalhes da instância');
  } finally {
    if (!signal?.aborted) setMetricsLoading(false);
  }
}

function findCardByIid(iid) {
  return document.querySelector(`[data-iid="${iid}"]`)?.closest('article');
}

async function handleSaveMetadata(iid) {
  const card = findCardByIid(iid);
  if (!card) return;
  const name = card.querySelector('[data-field="name"]')?.value?.trim();
  const note = card.querySelector('[data-field="note"]')?.value?.trim();
  if (!name) { showError('O nome não pode estar vazio.'); return; }

  const btn = card.querySelector('[data-act="save"][data-iid="' + iid + '"]');
  setBusy(btn, true, 'Salvando…');
  try {
    const key = requireKey();
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const payload = await fetchJSON('/instances/' + iid, true, { method: 'PATCH', body: JSON.stringify({ name, note }) });
    setBadgeState('update', 'Dados salvos (' + payload.name + ')', 4000);
    if (iid === els.selInstance.value) {
      NOTE_STATE.lastSaved = (note || '').trim();
      NOTE_STATE.pending = note || '';
      NOTE_STATE.updatedAt = payload?.metadata?.updatedAt || NOTE_STATE.updatedAt;
      NOTE_STATE.createdAt = payload?.metadata?.createdAt || NOTE_STATE.createdAt;
      updateNoteMetaText();
      setNoteStatus('synced');
    }
    await triggerFullRefresh({ silent: true, withSkeleton: false });
  } catch (err) {
    console.error('[dashboard] erro ao salvar metadados', err);
    showError('Falha ao salvar dados da instância');
  } finally {
    setBusy(btn, false);
  }
}

async function performInstanceAction(action, iid, key, context = {}) {
  const endpoints = {
    logout: '/instances/' + iid + '/logout',
    wipe: '/instances/' + iid + '/session/wipe'
  };
  const badgeTypes = { logout: 'logout', wipe: 'wipe' };
  const fallbackMessages = {
    logout: (name) => 'Logout solicitado (' + name + ')',
    wipe: (name) => 'Wipe solicitado (' + name + ')'
  };
  const holdTimes = { logout: 5000, wipe: 7000 };
  const restartingMessage = (name) => 'Instância reiniciando (' + name + ')';

  const url = endpoints[action];
  if (!url) return false;

  const button = context.button || null;
  const name = context.name || iid;
  if (button) setBusy(button, true, action === 'logout' ? 'Desconectando…' : 'Limpando…');
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'x-api-key': key } });
    if (action === 'wipe' && r.status === 202) {
      const payload = await r.json().catch(() => ({}));
      const message = payload?.message || restartingMessage(name);
      lockInstanceActions(iid, 'restart');
      setBadgeState('wipe', message, holdTimes[action]);
      await triggerFullRefresh({ silent: true, withSkeleton: false });
      return true;
    }
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      alert('Falha ao executar ' + action + ': HTTP ' + r.status + (txt ? ' — ' + txt : ''));
      setBadgeState('error', 'Falha em ' + action + ' (' + name + ')', 5000);
      return false;
    }
    const payload = await r.json().catch(() => ({}));
    const message = payload?.message || fallbackMessages[action](name);
    setBadgeState(badgeTypes[action], message, holdTimes[action]);
    await triggerFullRefresh({ silent: true, withSkeleton: false });
    return true;
  } catch (err) {
    if (action === 'wipe') {
      console.error('[dashboard] erro em ' + action, err);
      lockInstanceActions(iid, 'restart');
      setBadgeState('wipe', restartingMessage(name), holdTimes[action]);
      setTimeout(() => {
        triggerFullRefresh({ silent: true, withSkeleton: false }).catch(() => undefined);
      }, 1500);
      return true;
    }
    console.error('[dashboard] erro em ' + action, err);
    showError('Erro ao executar ' + action);
    return false;
  } finally {
    if (button) setBusy(button, false);
    if (isInstanceLocked(iid)) {
      setInstanceActionsDisabled(iid, true);
      setSelectedInstanceActionsDisabled(iid, true);
    }
  }
}

/* Modal de exclusão */
function openDeleteModal(iid, name) {
  els.modalDelete.dataset.iid = iid;
  els.modalDelete.dataset.name = name;
  els.modalInstanceName.textContent = name;
  els.modalDelete.classList.remove('hidden');
  els.modalDelete.classList.add('flex');
}
function closeDeleteModal() {
  delete els.modalDelete.dataset.iid;
  delete els.modalDelete.dataset.name;
  els.modalDelete.classList.add('hidden');
  els.modalDelete.classList.remove('flex');
}
els.modalDelete.addEventListener('click', (ev) => {
  if (ev.target === els.modalDelete) closeDeleteModal();
});
function openPairModal(code) {
  if (!els.pairModal) return;
  if (els.pairModalCode) els.pairModalCode.textContent = code || '—';
  els.pairModal.classList.remove('hidden');
  els.pairModal.classList.add('flex');
}
function closePairModal() {
  if (!els.pairModal) return;
  els.pairModal.classList.add('hidden');
  els.pairModal.classList.remove('flex');
}
if (els.pairModal) {
  els.pairModal.addEventListener('click', (ev) => {
    if (ev.target === els.pairModal) closePairModal();
  });
}
if (els.pairModalClose) els.pairModalClose.addEventListener('click', closePairModal);
if (els.pairModalCopy) {
  els.pairModalCopy.addEventListener('click', async () => {
    try {
      const code = els.pairModalCode?.textContent?.trim();
      if (!code) return;
      await navigator.clipboard.writeText(code);
      setBadgeState('update', 'Código copiado para a área de transferência.', 3000);
    } catch (err) {
      console.error('[dashboard] erro ao copiar código', err);
      showError('Não foi possível copiar o código.');
    }
  });
}
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (els.modalDelete && !els.modalDelete.classList.contains('hidden')) closeDeleteModal();
  if (els.pairModal && !els.pairModal.classList.contains('hidden')) closePairModal();
});

/* Delegação de eventos click */
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === 'modal-cancel') {
    ev.preventDefault();
    closeDeleteModal();
    return;
  }
  if (act === 'modal-confirm') {
    const iidTarget = els.modalDelete.dataset.iid;
    if (!iidTarget) { closeDeleteModal(); return; }
    let key;
    try { key = requireKey(); } catch { return; }
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    setBusy(btn, true, 'Excluindo…');
    try {
      const r = await fetch('/instances/' + iidTarget, { method: 'DELETE', headers: { 'x-api-key': key } });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        alert('Falha ao excluir: HTTP ' + r.status + (txt ? ' — ' + txt : ''));
        setBadgeState('error', 'Falha ao excluir ' + iidTarget, 5000);
        return;
      }
      const payload = await r.json().catch(() => ({}));
      const name = els.modalDelete.dataset.name || iidTarget;
      setBadgeState('delete', payload?.message || ('Instância removida (' + name + ')'), 7000);
      closeDeleteModal();
      await triggerFullRefresh({ withSkeleton: true });
    } catch (err) {
      console.error('[dashboard] erro ao excluir instância', err);
      showError('Erro ao excluir instância');
    } finally {
      setBusy(btn, false);
    }
    return;
  }

  // demais ações precisam de iid
  const iid = btn.dataset.iid;
  if (!iid) return;

  // ações simples que não alteram servidor
  if (act === 'select') {
    els.selInstance.value = iid;
    await triggerFullRefresh({ withSkeleton: true });
    return;
  }
  if (act === 'qr') {
    try { requireKey(); } catch { return; }
    if (iid) els.selInstance.value = iid;
    await triggerFullRefresh({ withSkeleton: true });
    setBadgeState('info', 'QR atualizado', 3000);
    return;
  }
  if (act === 'delete') {
    const name = findCardByIid(iid)?.querySelector('[data-field="name"]')?.value?.trim() || iid;
    openDeleteModal(iid, name);
    return;
  }

  // ações que usam API Key
  let key;
  try { key = requireKey(); } catch { return; }
  localStorage.setItem('x_api_key', els.inpApiKey.value.trim());

  if (act === 'logout') {
    await performInstanceAction('logout', iid, key, { button: btn });
    return;
  }
  if (act === 'wipe') {
    await performInstanceAction('wipe', iid, key, { button: btn });
    return;
  }
  if (act === 'save') {
    await handleSaveMetadata(iid);
    return;
  }
});

/* Novo */
els.btnNew.onclick = async () => {
  const name = prompt('Nome da nova instância (ex: suporte-goiania)');
  if (!name) return;
  localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
  try {
    const payload = await fetchJSON('/instances', true, { method:'POST', body: JSON.stringify({ name }) });
    setBadgeState('update', 'Instância criada (' + (payload?.name || payload?.id || name) + ')', 4000);
    await triggerFullRefresh({ withSkeleton: true });
  } catch (err) {
    console.error('[dashboard] erro ao criar instância', err);
    showError('Falha ao criar instância');
    alert('Falha ao criar instância: ' + err.message);
  }
};

/* Select change */
els.selInstance.onchange = () => {
  triggerFullRefresh({ withSkeleton: true });
};

/* Logout/Wipe (header) */
els.btnLogout.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const iid = els.selInstance.value;
    if (!iid) return;
    const key = requireKey();
    const ok = await performInstanceAction('logout', iid, key, { name: iid, button: els.btnLogout });
    if (ok) els.qrHint.textContent = 'Desconectando… aguarde novo QR.';
  } catch {}
};
els.btnWipe.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const iid = els.selInstance.value;
    if (!iid) return;
    const key = requireKey();
    const ok = await performInstanceAction('wipe', iid, key, { name: iid, button: els.btnWipe });
    if (ok) els.qrHint.textContent = 'Limpando sessão… o serviço reiniciará para gerar novo QR.';
  } catch {}
};

/* Pair por código */
els.btnPair.onclick = async () => {
  try {
    const iid = els.selInstance.value;
    if (!iid) { showError('Selecione uma instância.'); return; }
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    try { requireKey(); } catch { return; }
    const phoneInput = prompt('Número no formato E.164 (ex: +5544999999999):');
    if (!phoneInput) return;
    const sanitized = phoneInput.replace(/[^\d+]/g, '');
    const phoneNumber = sanitized.startsWith('+') ? sanitized : '+' + sanitized.replace(/^\++/, '');
    if (!validateE164(phoneNumber)) {
      showError('Telefone inválido. Use o formato E.164 (ex: +5511999999999).');
      return;
    }
    setBusy(els.btnPair, true, 'Gerando…');
    const payload = await fetchJSON('/instances/' + iid + '/pair', true, { method: 'POST', body: JSON.stringify({ phoneNumber }) });
    const code = payload?.pairingCode || '(sem código)';
    openPairModal(code);
    try {
      await navigator.clipboard.writeText(code);
      setBadgeState('update', 'Código gerado e copiado para a área de transferência.', 4000);
    } catch {
      setBadgeState('update', 'Código de pareamento gerado.', 4000);
    }
    setQrState('disconnected', 'Código gerado. Use o pareamento no app.');
  } catch (e) {
    console.error('[dashboard] erro ao gerar código', e);
    showError('Não foi possível gerar o código de pareamento.');
    alert('Falha ao gerar código: ' + e.message);
  } finally {
    setBusy(els.btnPair, false);
  }
};

/* Envio rápido */
if (els.btnSend) els.btnSend.onclick = async () => {
  localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
  const iid = els.selInstance.value;
  if (!iid) { setSendOut('Selecione uma instância antes de enviar.', 'error'); showError('Selecione uma instância.'); return; }
  let key;
  try { key = requireKey(); } catch { setSendOut('Informe a API Key para enviar mensagens.', 'error'); return; }

  const rawPhone = els.inpPhone.value.trim();
  const sanitized = rawPhone.replace(/[^\d+]/g, '');
  const phoneNumber = sanitized.startsWith('+') ? sanitized : '+' + sanitized.replace(/^\++/, '');
  const message = els.inpMsg.value.trim();
  updateMsgCounter();

  if (!validateE164(phoneNumber)) {
    setSendOut('Telefone inválido. Use o formato E.164 (ex: +5511999999999).', 'error');
    return;
  }
  if (!message) {
    setSendOut('Informe uma mensagem para enviar.', 'error');
    return;
  }
  if (message.length > 4096) {
    setSendOut('Mensagem excede 4096 caracteres.', 'error');
    return;
  }

  const body = JSON.stringify({ to: phoneNumber, message, waitAckMs: 8000 });
  setBusy(els.btnSend, true, 'Enviando…');
  setSendOut('Enviando mensagem…', 'info');

  try {
    const response = await fetch('/instances/' + iid + '/send-text', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let payload;
      if (raw) {
        try { payload = JSON.parse(raw); } catch (err) {
          console.warn('[dashboard] erro ao interpretar resposta', err);
        }
      }
      if (response.status === 503 && payload?.error === 'socket_unavailable') {
        const details = [payload.detail, payload.message]
          .map(v => (typeof v === 'string' ? v.trim() : ''))
          .filter(Boolean);
        const detailMsg = details.join(' — ') || 'Socket indisponível.';
        setSendOut('Instância desconectada: ' + detailMsg, 'error');
        showError('Instância desconectada. Refaça o pareamento e tente novamente.');
        return;
      }
      const bodyMsg = payload?.detail || payload?.error || raw;
      throw new Error('HTTP ' + response.status + (bodyMsg ? ' — ' + bodyMsg : ''));
    }
    const payload = await response.json().catch(() => ({}));
    setSendOut('Sucesso: ' + JSON.stringify(payload), 'success');
    setBadgeState('update', 'Mensagem enviada — acompanhe os indicadores.', 3000);
    await triggerFullRefresh({ silent: true, withSkeleton: false });
  } catch (e) {
    console.error('[dashboard] erro ao enviar mensagem', e);
    setSendOut('Falha no envio: ' + e.message, 'error');
    showError('Não foi possível enviar a mensagem.');
  } finally {
    setBusy(els.btnSend, false);
  }
};

async function refreshLogs(options = {}) {
  if (!els.logsList || !els.logsEmpty) return;
  const { silent = false, signal } = options;
  const iid = els.selInstance?.value;
  if (!iid) {
    resetLogs();
    return;
  }

  if (!silent && els.btnRefreshLogs) setBusy(els.btnRefreshLogs, true, 'Atualizando…');

  try {
    const params = new URLSearchParams({ limit: '20' });
    const data = await fetchJSON('/instances/' + iid + '/logs?' + params.toString(), true, { signal });
    if (signal?.aborted) return;
    const events = Array.isArray(data?.events) ? data.events : [];
    const signature = events
      .map((ev) => {
        const delivery = extractDeliveryInfo(ev);
        const deliveryKey = delivery ? `${delivery.state}:${delivery.attempts}:${delivery.lastStatus ?? ''}` : '';
        return `${ev.id}:${ev.acknowledged ? 1 : 0}:${deliveryKey}`;
      })
      .join('|');
    if (signature !== lastLogsSignature) {
      renderLogs(events);
      lastLogsSignature = signature;
    }
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) return;
    console.error('[dashboard] erro ao carregar logs', err);
    if (!silent) showError('Falha ao carregar eventos recentes');
  } finally {
    if (!silent && els.btnRefreshLogs && !signal?.aborted) setBusy(els.btnRefreshLogs, false);
  }
}

if (els.btnRefreshLogs) {
  els.btnRefreshLogs.addEventListener('click', () => refreshLogs({ silent: false }));
}

function triggerFullRefresh(options = {}) {
  const scheduler = window.dashboardAppScheduler;
  if (scheduler?.requestImmediateRound) {
    return scheduler.requestImmediateRound(options);
  }
  return (async () => {
    await refreshInstances(options);
    await refreshSelected(options);
  })();
}

/* Boot do dashboard */
initChart();

window.dashboardApp = {
  refreshInstances,
  refreshSelected,
  refreshLogs,
  triggerFullRefresh,
  REFRESH_INTERVAL_MS,
  state: sharedState,
};
