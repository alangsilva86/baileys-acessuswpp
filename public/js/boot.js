import { REFRESH_INTERVAL_MS, els } from './state.js';
import { refreshInstances } from './instances.js';
import { initMetrics } from './metrics.js';
import { initNotes } from './notes.js';
import { initLogs, refreshLogs } from './logs.js';
import { initQuickSend } from './quickSend.js';
import { initSessionActions } from './sessionActions.js';

const MIN_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS;
const MAX_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS * 6;

let autoRefreshTimerId = null;
let autoRefreshInterval = MIN_REFRESH_INTERVAL_MS;
let autoRefreshInFlight = false;
let lastChangeAt = Date.now();

function scheduleAutoRefresh(delayMs = autoRefreshInterval) {
  if (autoRefreshTimerId) {
    clearTimeout(autoRefreshTimerId);
  }
  autoRefreshTimerId = setTimeout(() => {
    autoRefreshTimerId = null;
    void performAutoRefresh();
  }, delayMs);
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

export function bootDashboard() {
  if (els.inpApiKey) {
    els.inpApiKey.value = localStorage.getItem('x_api_key') || '';
    els.inpApiKey.addEventListener('input', () => {
      localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    });
  }

  if (els.sessionsRoot) {
    els.sessionsRoot.textContent = '';
  }

  initNotes();
  initMetrics();
  initLogs();
  initQuickSend();
  initSessionActions();

  registerChange();

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
