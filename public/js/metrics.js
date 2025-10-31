import { fetchJSON, getApiKeyValue } from './api.js';
import { applyInstanceNote, resetNotes } from './notes.js';
import { refreshLogs, resetLogs } from './logs.js';
import {
  STATUS_CODES,
  STATUS_META,
  TIMELINE_FIELDS,
  describeConnection,
  els,
  formatTimelineLabel,
  getStatusCounts,
  isInstanceLocked,
  setMetricsLoading,
  setQrState,
  setSelectedInstanceActionsDisabled,
  setStatusBadge,
  showError,
  toggleHidden,
  updateInstanceLocksFromSnapshot,
} from './state.js';

let chart;
let hasLoadedSelected = false;
let currentInstanceId = null;
let currentConnectionState = null;
const qrVersionCache = new Map();
let selectedSnapshot = null;
let qrCountdownTimer = null;
let qrInvalidationTimer = null;
let instanceEventSource = null;
let instanceEventSourceKey = null;
const instanceEventListeners = new Set();
let streamReinitTimer = null;

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), 1);
  return Math.round(clamped * 100);
}

function closeInstanceStream() {
  if (instanceEventSource) {
    try {
      instanceEventSource.close();
    } catch (err) {
      console.debug('[metrics] instance stream close failed', err);
    }
  }
  instanceEventSource = null;
  instanceEventSourceKey = null;
}

function ensureInstanceStream() {
  const key = getApiKeyValue();
  if (!key) {
    closeInstanceStream();
    return null;
  }
  if (instanceEventSource && instanceEventSourceKey === key) {
    return instanceEventSource;
  }

  closeInstanceStream();

  try {
    const origin = window.location.origin;
    const url = new URL('/instances/events', origin);
    url.searchParams.set('apiKey', key);
    const source = new EventSource(url.toString());
    instanceEventSource = source;
    instanceEventSourceKey = key;
    source.addEventListener('instance', handleInstanceStreamEvent);
    source.addEventListener('error', (ev) => {
      console.debug('[metrics] instance stream error', ev);
    });
    return source;
  } catch (err) {
    console.error('[metrics] failed to start instance stream', err);
    return null;
  }
}

export function resetInstanceStream() {
  closeInstanceStream();
}

export function onInstanceEvent(listener) {
  instanceEventListeners.add(listener);
  return () => {
    instanceEventListeners.delete(listener);
  };
}

function notifyInstanceEventListeners(payload) {
  instanceEventListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (err) {
      console.warn('[metrics] instance event listener failed', err);
    }
  });
}

function handleInstanceStreamEvent(event) {
  if (!event?.data) return;
  let parsed;
  try {
    parsed = JSON.parse(event.data);
  } catch (err) {
    console.warn('[metrics] invalid SSE payload', err);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const snapshot = parsed.instance;
  if (!snapshot || typeof snapshot.id !== 'string') return;
  notifyInstanceEventListeners(parsed);
  const selectedId = els.selInstance?.value;
  if (selectedId && snapshot.id === selectedId) {
    const reason = parsed.reason || parsed.type;
    applyInstanceSnapshot(snapshot, {
      fromStream: true,
      reason,
      forceQrReload: reason === 'qr',
    });
  }
}

function extractQrVersion(instance) {
  if (!instance || typeof instance !== 'object') return null;
  const candidates = [
    instance.lastQrVersion,
    instance.lastQRVersion,
    instance.lastQRUpdatedAt,
    instance.lastQrUpdatedAt,
    instance.lastQR,
    instance.lastQr,
  ];
  for (const value of candidates) {
    if (value != null && value !== '') return String(value);
  }
  if (instance.connectionUpdatedAt) return String(instance.connectionUpdatedAt);
  return null;
}

function stopQrCountdown() {
  if (qrCountdownTimer) {
    clearInterval(qrCountdownTimer);
    qrCountdownTimer = null;
  }
}

function updateQrCountdown(snapshot) {
  if (!els.qrCountdown) return;
  const expiresAtIso = snapshot?.qrExpiresAt;
  if (!expiresAtIso) {
    stopQrCountdown();
    els.qrCountdown.textContent = '—';
    return;
  }
  const expiresAt = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAt)) {
    stopQrCountdown();
    els.qrCountdown.textContent = '—';
    return;
  }

  stopQrCountdown();

  const render = () => {
    const diffMs = expiresAt - Date.now();
    if (diffMs <= 0) {
      els.qrCountdown.textContent = 'Expirado';
      stopQrCountdown();
      return;
    }
    const diffSec = Math.round(diffMs / 1000);
    const minutes = Math.floor(diffSec / 60);
    const seconds = diffSec % 60;
    const formatted = minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
    els.qrCountdown.textContent = formatted;
  };

  render();
  qrCountdownTimer = setInterval(render, 500);
}

function updatePairingAttempt(snapshot) {
  if (!els.qrAttempt) return;
  const attempt = Number(snapshot?.pairingAttempts);
  if (Number.isFinite(attempt) && attempt > 0) {
    els.qrAttempt.textContent = `#${attempt}`;
  } else {
    els.qrAttempt.textContent = '—';
  }
}

function updateLastError(snapshot) {
  if (!els.qrLastError || !els.qrLastErrorWrap) return;
  const message = typeof snapshot?.lastError === 'string' ? snapshot.lastError.trim() : '';
  if (message) {
    els.qrLastError.textContent = message;
    toggleHidden(els.qrLastErrorWrap, false);
  } else {
    els.qrLastError.textContent = '—';
    toggleHidden(els.qrLastErrorWrap, true);
  }
}

function clearQrInvalidation() {
  if (qrInvalidationTimer) {
    clearTimeout(qrInvalidationTimer);
    qrInvalidationTimer = null;
  }
}

function scheduleQrInvalidation(snapshot, connection) {
  clearQrInvalidation();
  const expiresAtIso = snapshot?.qrExpiresAt;
  if (!expiresAtIso || !connection?.meta?.shouldLoadQr) return;
  const expiresAt = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAt)) return;
  const delay = Math.max(0, expiresAt - Date.now());
  qrInvalidationTimer = setTimeout(() => {
    if (els.qrImg) toggleHidden(els.qrImg, true);
    setQrState('loading', 'QR expirado. Aguardando novo QR…');
    if (els.qrCountdown) els.qrCountdown.textContent = 'Expirado';
    stopQrCountdown();
    if (selectedSnapshot?.id) {
      qrVersionCache.delete(selectedSnapshot.id);
    }
  }, delay + 300);
}

function initChart() {
  const canvas = document.getElementById('metricsChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const statusDatasets = STATUS_CODES.map((code) => {
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
        {
          label: 'Enviadas',
          data: [],
          borderColor: '#0ea5e9',
          backgroundColor: 'rgba(14,165,233,0.15)',
          tension: 0.25,
          fill: false,
        },
        ...statusDatasets,
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grace: '5%' },
      },
      plugins: { legend: { display: true, position: 'bottom' } },
    },
  });
}

export function resetChart() {
  if (!chart) return;
  chart.data.labels = [];
  chart.data.datasets.forEach((ds) => {
    ds.data = [];
  });
  chart.update('none');
  if (els.chartHint) els.chartHint.textContent = 'Nenhum dado disponível ainda.';
}

function updateKpis(metrics) {
  if (!els.kpiDeliveryValue) return;
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

  const deliveryData = metrics?.delivery || {};
  const inTransitRaw = Number(deliveryData.inFlight);
  const inTransit = Number.isFinite(inTransitRaw) ? inTransitRaw : pending + serverAck;
  if (sent) {
    els.kpiTransitValue.textContent = String(inTransit);
    els.kpiTransitHint.textContent = `Status 1: ${pending} • Status 2: ${serverAck}`;
  } else {
    els.kpiTransitValue.textContent = '0';
    els.kpiTransitHint.textContent = 'Envie mensagens para acompanhar envios em trânsito.';
  }
}

function applyInstanceSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return;
  selectedSnapshot = snapshot;
  const iid = snapshot.id;
  updateInstanceLocksFromSnapshot([snapshot]);
  const connection = describeConnection(snapshot);
  currentConnectionState = connection.state;
  setStatusBadge(connection, snapshot.name);
  setSelectedInstanceActionsDisabled(iid, isInstanceLocked(iid));

  if (options.refreshNote && els.noteCard) {
    applyInstanceNote(snapshot);
  }

  updatePairingAttempt(snapshot);
  updateLastError(snapshot);
  updateQrCountdown(snapshot);
  scheduleQrInvalidation(snapshot, connection);

  const qrMessage = connection.meta?.qrMessage
    ? connection.meta.qrMessage(connection.updatedText)
    : connection.meta?.shouldLoadQr
    ? 'Instância desconectada.'
    : 'Instância conectada.';
  const qrState = connection.meta?.qrState || 'loading';
  const normalizedQrVersion = extractQrVersion(snapshot);
  const previousQrVersion = qrVersionCache.get(iid) ?? null;
  const shouldLoadQr = Boolean(connection.meta?.shouldLoadQr);
  const hasNewQr = normalizedQrVersion ? previousQrVersion !== normalizedQrVersion : !previousQrVersion;
  const shouldForceReload = Boolean(options.forceQrReload);

  if (shouldLoadQr) {
    if (hasNewQr || shouldForceReload) {
      if (els.qrImg) toggleHidden(els.qrImg, true);
      setQrState('loading', 'Sincronizando QR…');
      const versionKey = normalizedQrVersion || `loaded:${Date.now()}`;
      ensureInstanceStream();
      void loadQRCode(iid, { version: versionKey, qrState, qrMessage });
    } else {
      setQrState(qrState, qrMessage);
      if (els.qrImg?.src) toggleHidden(els.qrImg, false);
    }
  } else {
    qrVersionCache.delete(iid);
    toggleHidden(els.qrImg, true);
    setQrState(qrState, qrMessage);
    stopQrCountdown();
    clearQrInvalidation();
  }
}

async function loadQRCode(iid, options = {}) {
  const { version = null, qrState = 'loading', qrMessage = 'Sincronizando QR…' } = options;
  try {
    const key = getApiKeyValue();
    if (!key) {
      toggleHidden(els.qrImg, true);
      setQrState('needs-key', 'Informe a API Key para ver o QR code.');
      return false;
    }

    if (currentConnectionState === 'qr_timeout') {
      toggleHidden(els.qrImg, true);
      setQrState('qr-timeout', 'QR expirado. Solicite um novo código de pareamento no aplicativo.');
      return false;
    }

    const headers = { 'x-api-key': key };
    const response = await fetch(`/instances/${iid}/qr.png?t=${Date.now()}`, {
      headers,
      cache: 'no-store',
    });

    if (response.ok) {
      const blob = await response.blob();
      const imageUrl = URL.createObjectURL(blob);
      if (els.qrImg) {
        els.qrImg.src = imageUrl;
        toggleHidden(els.qrImg, false);
        els.qrImg.onload = () => {
          if (els.qrImg.previousImageUrl) {
            URL.revokeObjectURL(els.qrImg.previousImageUrl);
          }
          els.qrImg.previousImageUrl = imageUrl;
        };
      }
      if (version) qrVersionCache.set(iid, version);
      setQrState(qrState, qrMessage);
      return true;
    }

    if (response.status === 401) {
      toggleHidden(els.qrImg, true);
      setQrState('needs-key', 'API Key inválida.');
      return false;
    }

    if (response.status === 404) {
      toggleHidden(els.qrImg, true);
      setQrState('loading', 'QR code ainda não disponível. Aguarde atualização.');
      return false;
    }

    throw new Error('HTTP ' + response.status);
  } catch (err) {
    console.error('[metrics] erro ao carregar QR code', err);
    toggleHidden(els.qrImg, true);
    setQrState('error', 'Erro ao carregar QR code.');
    return false;
  }
}

export async function refreshSelected(options = {}) {
  const { silent = false, withSkeleton } = options;
  const iid = els.selInstance?.value;

  if (!iid) {
    toggleHidden(els.qrImg, true);
    setQrState('idle', 'Nenhuma instância selecionada.');
    resetNotes();
    resetChart();
    resetLogs();
    hasLoadedSelected = false;
    currentInstanceId = null;
    currentConnectionState = null;
    selectedSnapshot = null;
    stopQrCountdown();
    clearQrInvalidation();
    return;
  }

  if (iid !== currentInstanceId) {
    currentInstanceId = iid;
  }
  ensureInstanceStream();
  const shouldShowMetricsSkeleton = withSkeleton ?? (!silent && !hasLoadedSelected);
  if (shouldShowMetricsSkeleton) setMetricsLoading(true);
  if (!silent) {
    setQrState('loading', 'Sincronizando instância…');
  }

  try {
    const data = await fetchJSON(`/instances/${iid}`, true);
    applyInstanceSnapshot(data, { refreshNote: true, forceQrReload: true });

    const metrics = await fetchJSON(`/instances/${iid}/metrics`, true);
    updateKpis(metrics);

    const rangeMins = Number(els.selRange?.value) || 240;
    const since = Date.now() - rangeMins * 60 * 1000;
    const timeline = (metrics.timeline || []).filter((p) => p.ts >= since);

    if (chart && timeline.length > 1) {
      chart.data.labels = timeline.map((p) => formatTimelineLabel(p.iso));
      chart.data.datasets[0].data = timeline.map((p) => p.sent ?? 0);
      STATUS_CODES.forEach((code, idx) => {
        const key = TIMELINE_FIELDS[code];
        chart.data.datasets[idx + 1].data = timeline.map((p) => (key ? p[key] ?? 0 : 0));
      });
      chart.update();
      if (els.chartHint) els.chartHint.textContent = `Exibindo ${timeline.length} pontos de dados.`;
    } else {
      resetChart();
    }

    await refreshLogs({ silent: true });
    hasLoadedSelected = true;
  } catch (err) {
    console.error('[metrics] erro ao buscar detalhes da instância', err);
    showError('Falha ao carregar detalhes da instância');
  } finally {
    setMetricsLoading(false);
  }
}

function applySavedRange() {
  if (!els.selRange) return;
  const savedRange = localStorage.getItem('metrics_range') || '240';
  const values = Array.from(els.selRange.options).map((o) => o.value);
  if (values.includes(savedRange)) els.selRange.value = savedRange;
  els.selRange.addEventListener('change', () => {
    localStorage.setItem('metrics_range', els.selRange.value);
    refreshSelected({ withSkeleton: true });
  });
}

export function initMetrics() {
  initChart();
  applySavedRange();
  ensureInstanceStream();
  if (els.inpApiKey) {
    const scheduleReinit = () => {
      if (streamReinitTimer) clearTimeout(streamReinitTimer);
      streamReinitTimer = setTimeout(() => {
        resetInstanceStream();
        ensureInstanceStream();
      }, 300);
    };
    els.inpApiKey.addEventListener('change', scheduleReinit);
    els.inpApiKey.addEventListener('input', scheduleReinit);
  }
}
