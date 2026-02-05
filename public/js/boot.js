import { REFRESH_INTERVAL_MS, els, formatDateTime } from './state.js';
import { refreshInstances } from './instances.js';
import { initMetrics, refreshSelected } from './metrics.js';
import { initNotes } from './notes.js';
import { initLogs, refreshLogs } from './logs.js';
import { initQuickSend } from './quickSend.js';
import { initSessionActions } from './sessionActions.js';

const MIN_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS;
const MAX_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS * 6;
const MIN_SELECTED_REFRESH_INTERVAL_MS = 2500;
const SELECTED_REFRESH_DELAY_MS = 400;
const STREAM_ERROR_THRESHOLD = 3;

let autoRefreshTimerId = null;
let autoRefreshInterval = MIN_REFRESH_INTERVAL_MS;
let autoRefreshInFlight = false;
let lastChangeAt = Date.now();
let autoRefreshSuspended = false;
let selectedRefreshTimerId = null;
let lastSelectedRefreshAt = 0;
let eventSource = null;
let eventSourceKey = null;
let streamErrorCount = 0;
let streamFallbackActive = false;

function scheduleAutoRefresh(delayMs = autoRefreshInterval) {
  if (autoRefreshSuspended) return;
  if (autoRefreshTimerId) {
    clearTimeout(autoRefreshTimerId);
  }
  autoRefreshTimerId = setTimeout(() => {
    autoRefreshTimerId = null;
    void performAutoRefresh();
  }, delayMs);
}

function stopAutoRefresh() {
  if (autoRefreshTimerId) {
    clearTimeout(autoRefreshTimerId);
    autoRefreshTimerId = null;
  }
}

function registerChange() {
  lastChangeAt = Date.now();
  autoRefreshInterval = MIN_REFRESH_INTERVAL_MS;
}

function expandInterval() {
  const idleMs = Date.now() - lastChangeAt;
  const multiplier = Math.max(1, Math.floor(idleMs / MIN_REFRESH_INTERVAL_MS) + 1);
  const nextInterval = MIN_REFRESH_INTERVAL_MS * multiplier;
  autoRefreshInterval = Math.min(MAX_REFRESH_INTERVAL_MS, nextInterval);
}

async function performAutoRefresh() {
  if (autoRefreshInFlight) return;
  if (typeof document !== 'undefined' && document.hidden) {
    scheduleAutoRefresh(MIN_REFRESH_INTERVAL_MS);
    return;
  }

  autoRefreshInFlight = true;
  let hadChanges = false;

  try {
    try {
      const instResult = await refreshInstances({ silent: true });
      if (instResult?.changed) hadChanges = true;
    } catch (err) {
      console.debug('[boot] auto-refresh instâncias falhou', err);
    }

    try {
      const logsChanged = await refreshLogs({ silent: true });
      if (logsChanged) hadChanges = true;
    } catch (err) {
      console.debug('[boot] auto-refresh logs falhou', err);
    }
  } finally {
    autoRefreshInFlight = false;
  }

  if (hadChanges) {
    registerChange();
  } else {
    expandInterval();
  }

  scheduleAutoRefresh(autoRefreshInterval);
}

function suspendAutoRefresh() {
  if (autoRefreshSuspended) return;
  autoRefreshSuspended = true;
  stopAutoRefresh();
}

function resumeAutoRefresh() {
  if (!autoRefreshSuspended) return false;
  autoRefreshSuspended = false;
  registerChange();
  if (!autoRefreshInFlight) {
    void performAutoRefresh();
  }
  scheduleAutoRefresh(autoRefreshInterval);
  return true;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      registerChange();
      if (!autoRefreshInFlight) {
        void performAutoRefresh();
      }
    }
  });
}

function scheduleSelectedRefresh() {
  if (typeof window === 'undefined') return;
  if (selectedRefreshTimerId) return;
  const now = Date.now();
  const elapsed = now - lastSelectedRefreshAt;
  const delay =
    elapsed >= MIN_SELECTED_REFRESH_INTERVAL_MS
      ? SELECTED_REFRESH_DELAY_MS
      : Math.max(SELECTED_REFRESH_DELAY_MS, MIN_SELECTED_REFRESH_INTERVAL_MS - elapsed);
  selectedRefreshTimerId = setTimeout(() => {
    selectedRefreshTimerId = null;
    lastSelectedRefreshAt = Date.now();
    void refreshSelected({ silent: true });
  }, delay);
}

function handleActivityEvent(event) {
  registerChange();
  const selected = els.selInstance?.value || null;
  const matchesSelected = Boolean(selected && event?.instanceId === selected);
  void refreshInstances({ silent: true, skipSelected: matchesSelected });
  if (matchesSelected) {
    scheduleSelectedRefresh();
  }
}

const streamHandlers = {
  MESSAGE_INBOUND: handleActivityEvent,
  MESSAGE_OUTBOUND: handleActivityEvent,
  POLL_CHOICE: handleActivityEvent,
  WEBHOOK_DELIVERY: handleActivityEvent,
  default: () => {
    registerChange();
  },
};

function routeStreamEvent(event) {
  if (!event || typeof event !== 'object') return;
  const handler = streamHandlers[event.type] || streamHandlers.default;
  if (typeof handler === 'function') {
    handler(event);
  }
}

function parseStreamData(data) {
  if (typeof data !== 'string' || !data) return null;
  try {
    return JSON.parse(data);
  } catch (err) {
    console.debug('[boot] falha ao decodificar evento SSE', err);
    return null;
  }
}

function startEventStream() {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
  const key = localStorage.getItem('baileys_api_key') || localStorage.getItem('x_api_key') || '';
  if (!key) return;
  if (eventSource && eventSourceKey === key) return;

  if (eventSource) {
    try {
      eventSource.close();
    } catch (err) {
      console.debug('[boot] stream close failed', err);
    }
  }

  eventSourceKey = key;
  const url = new URL('/stream', window.location.origin);
  url.searchParams.set('apiKey', key);
  eventSource = new EventSource(url.toString());

  const handleOpen = () => {
    streamErrorCount = 0;
    streamFallbackActive = false;
    suspendAutoRefresh();
  };

  const handleBrokerEvent = (event) => {
    streamErrorCount = 0;
    const payload = parseStreamData(event.data);
    if (payload) routeStreamEvent(payload);
  };

  const handlePing = () => {
    streamErrorCount = 0;
  };

  eventSource.addEventListener('open', handleOpen);
  eventSource.addEventListener('broker:event', handleBrokerEvent);
  eventSource.addEventListener('ping', handlePing);
  eventSource.onerror = () => {
    streamErrorCount += 1;
    if (streamErrorCount >= STREAM_ERROR_THRESHOLD && !streamFallbackActive) {
      if (resumeAutoRefresh()) {
        streamFallbackActive = true;
      }
    }
  };

  window.addEventListener('beforeunload', () => {
    eventSource?.close();
    eventSourceKey = null;
  });
}

export function bootDashboard() {
  if (els.inpApiKey) {
    els.inpApiKey.value = localStorage.getItem('baileys_api_key') || localStorage.getItem('x_api_key') || '';
    els.inpApiKey.addEventListener('input', () => {
      const next = els.inpApiKey.value.trim();
      if (!next) {
        localStorage.removeItem('baileys_api_key');
        localStorage.removeItem('x_api_key');
        return;
      }
      localStorage.setItem('baileys_api_key', next);
      localStorage.setItem('x_api_key', next);
      startEventStream();
    });
  }

  if (els.sessionsRoot) {
    const host = typeof window !== 'undefined' ? window.location.host : '';
    const now = formatDateTime(new Date().toISOString());
    const envLabel = host || 'local';
    els.sessionsRoot.textContent = now ? `${envLabel} • ${now}` : envLabel;
  }

  initNotes();
  initMetrics();
  initLogs();
  initQuickSend();
  initSessionActions();

  registerChange();

  if (typeof window !== 'undefined') {
    startEventStream();
  }

  refreshInstances({ withSkeleton: true })
    .then((result) => {
      if (result?.changed) registerChange();
    })
    .catch((err) => {
      console.error('[boot] erro inicial ao carregar instâncias', err);
    })
    .finally(() => {
      scheduleAutoRefresh(autoRefreshInterval);
    });
}
