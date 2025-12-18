import { fetchJSON } from './api.js';
import {
  DELIVERY_STATE_META,
  LOG_DIRECTION_META,
  els,
  formatDateTime,
  setBusy,
  setLogsLoading,
  showError,
  toggleHidden,
} from './state.js';

let lastLogsSignature = '';
let activeRange = null;

function getEventTimestampMs(event) {
  const metaTs = event?.payload?.metadata?.timestamp;
  if (metaTs) {
    const parsed = Date.parse(metaTs);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const webhookTs = event?.payload?.body?.timestamp;
  if (webhookTs != null) {
    const num = Number(webhookTs);
    if (Number.isFinite(num)) return num * 1000;
  }

  if (event?.createdAt != null) {
    const createdNum = Number(event.createdAt);
    if (Number.isFinite(createdNum)) return createdNum;
    const createdParsed = Date.parse(event.createdAt);
    if (!Number.isNaN(createdParsed)) return createdParsed;
  }

  return null;
}

function isWithinRange(ts, range) {
  if (!range || ts == null) return false;
  if (range.from != null && ts < range.from) return false;
  if (range.to != null && ts > range.to) return false;
  return true;
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

  if (event?.type === 'QUICK_SEND_RESULT') {
    const response = payload.response || {};
    const summary = typeof response.summary === 'string' ? response.summary.trim() : '';
    if (summary) return summary;
    const type = response.type || payload.request?.type || 'rápido';
    const to = response.to || payload.request?.to;
    const base = `Envio ${type}`;
    return to ? `${base} • ${to}` : base;
  }

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
  const attemptsText = info.attempts ? ` (${info.attempts} tentativa${info.attempts > 1 ? 's' : ''})` : '';
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
  const fragment = document.createDocumentFragment();
  const hasEvents = Array.isArray(events) && events.length > 0;
  toggleHidden(els.logsEmpty, hasEvents);
  els.logsList.textContent = '';

  if (els.logsAlert) {
    const webhookErrors = (events || []).filter((ev) => {
      const status = ev?.payload?.status ?? ev?.payload?.body?.status;
      return Number(status) >= 400;
    });
    if (webhookErrors.length) {
      const first = webhookErrors[0];
      const status = first?.payload?.status ?? first?.payload?.body?.status;
      els.logsAlert.textContent = `${webhookErrors.length} falha${webhookErrors.length > 1 ? 's' : ''} de webhook (HTTP ${status}). Verifique credenciais ou headers.`;
      els.logsAlert.classList.remove('hidden');
    } else {
      els.logsAlert.classList.add('hidden');
      els.logsAlert.textContent = '';
    }
  }

  events.forEach((event) => {
    const details = document.createElement('details');
    details.className = 'bg-white rounded-xl shadow-sm p-3 space-y-2';
    const eventTs = getEventTimestampMs(event);
    const inRange = isWithinRange(eventTs, activeRange);
    if (inRange) {
      details.classList.add('ring-2', 'ring-emerald-200/80', 'ring-offset-1');
    }

    const summary = document.createElement('summary');
    summary.className = 'flex items-start gap-3 cursor-pointer';

    const directionMeta = LOG_DIRECTION_META[event.direction] || LOG_DIRECTION_META.system;
    const direction = document.createElement('span');
    direction.className = 'px-2 py-0.5 rounded-full text-[11px] ' + directionMeta.className;
    direction.textContent = directionMeta.label;

    const summaryBody = document.createElement('div');
    summaryBody.className = 'flex-1 space-y-1';
    const title = document.createElement('div');
    title.className = 'text-sm font-medium text-slate-700';
    title.textContent = summarizeLogMessage(event) || '(sem descrição)';

    const meta = document.createElement('div');
    meta.className = 'text-[11px] text-slate-500';
    const timestamp = formatLogTimestamp(event);
    meta.textContent = timestamp ? `${timestamp}${event.acknowledged ? ' • ACK' : ''}` : event.id;
    if (inRange) {
      const badge = document.createElement('span');
      badge.className = 'ml-2 px-2 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-700';
      badge.textContent = 'Intervalo';
      meta.appendChild(badge);
    }

    const contact = extractContactInfo(event);
    if (contact?.name) {
      const contactEl = document.createElement('div');
      contactEl.className = 'text-[11px] text-slate-500';
      contactEl.textContent = `Contato: ${contact.name}`;
      summaryBody.appendChild(contactEl);
    }

    summaryBody.appendChild(title);
    summaryBody.appendChild(meta);
    summary.appendChild(direction);
    summary.appendChild(summaryBody);

    const body = document.createElement('div');
    body.className = 'text-xs text-slate-600 space-y-2';

    const deliveryBadge = buildDeliveryBadge(event);
    if (deliveryBadge) body.appendChild(deliveryBadge);

    const deliveryInfo = extractDeliveryInfo(event);
    if (deliveryInfo) {
      const deliveryDetails = document.createElement('div');
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

export function resetLogs() {
  if (!els.logsList || !els.logsEmpty) return;
  els.logsList.textContent = '';
  toggleHidden(els.logsEmpty, false);
  lastLogsSignature = '';
}

function openDrawer() {
  if (els.logsDrawer) els.logsDrawer.classList.remove('hidden');
}

function closeDrawer() {
  if (els.logsDrawer) els.logsDrawer.classList.add('hidden');
}

export async function refreshLogs(options = {}) {
  if (!els.logsList || !els.logsEmpty) return false;
  const { silent = false, range } = options;

  if (range !== undefined) {
    if (range && typeof range === 'object') {
      const from = Number(range.from);
      const to = Number(range.to);
      activeRange = {
        from: Number.isFinite(from) ? from : null,
        to: Number.isFinite(to) ? to : null,
      };
    } else {
      activeRange = null;
    }
  }

  const iid = els.selInstance?.value;
  if (!iid) {
    const hadSignature = lastLogsSignature !== '';
    resetLogs();
    activeRange = null;
    setLogsLoading(false);
    return hadSignature;
  }

  if (!silent && els.btnRefreshLogs) setBusy(els.btnRefreshLogs, true, 'Atualizando…');
  if (!silent) setLogsLoading(true);

  let changed = false;
  try {
    const params = new URLSearchParams({ limit: '20' });
    const data = await fetchJSON(`/instances/${iid}/logs?${params.toString()}`, true);
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
      changed = true;
    }
  } catch (err) {
    console.error('[logs] erro ao carregar logs', err);
    if (!silent) showError('Falha ao carregar eventos recentes');
  } finally {
    if (!silent && els.btnRefreshLogs) setBusy(els.btnRefreshLogs, false);
    if (!silent) setLogsLoading(false);
  }

  return changed;
}

export function initLogs() {
  if (els.btnRefreshLogs) {
    els.btnRefreshLogs.addEventListener('click', () => refreshLogs({ silent: false }));
  }
  if (els.btnOpenLogs) {
    els.btnOpenLogs.addEventListener('click', () => {
      openDrawer();
      void refreshLogs({ silent: false });
    });
  }
  if (els.btnCloseLogs) {
    els.btnCloseLogs.addEventListener('click', () => closeDrawer());
  }
  if (els.logsDrawer) {
    els.logsDrawer.addEventListener('click', (ev) => {
      if (ev.target === els.logsDrawer) closeDrawer();
    });
  }
}
