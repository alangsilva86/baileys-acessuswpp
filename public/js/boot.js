import { REFRESH_INTERVAL_MS, els } from './state.js';
import { refreshInstances } from './instances.js';
import { initMetrics } from './metrics.js';
import { initNotes } from './notes.js';
import { initLogs, refreshLogs } from './logs.js';
import { initQuickSend } from './quickSend.js';
import { initSessionActions } from './sessionActions.js';

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

  refreshInstances({ withSkeleton: true }).catch((err) => {
    console.error('[boot] erro inicial ao carregar instâncias', err);
  });

  setInterval(() => {
    refreshInstances({ silent: true }).catch((err) => console.debug('[boot] auto-refresh instâncias falhou', err));
    refreshLogs({ silent: true }).catch((err) => console.debug('[boot] auto-refresh logs falhou', err));
  }, REFRESH_INTERVAL_MS);
}
