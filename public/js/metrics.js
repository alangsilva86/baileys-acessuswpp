import { fetchJSON, getApiKeyValue } from './api.js';
import { applyInstanceNote, resetNotes } from './notes.js';
import { refreshLogs, resetLogs } from './logs.js';
import {
  STATUS_SERIES,
  STATUS_META,
  TIMELINE_FIELDS,
  describeConnection,
  els,
  formatTimelineLabel,
  formatDateTime,
  getStatusCounts,
  isInstanceLocked,
  setLogsLoading,
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
let lastRangeRequest = { from: null, to: null };
let lastRangeSummary = null;

function formatRangeLabel(range) {
  if (!range) return '';
  const formatTs = (value) => {
    if (!Number.isFinite(value)) return null;
    return formatDateTime(new Date(value).toISOString());
  };
  const fromLabel = formatTs(range.from);
  const toLabel = formatTs(range.to);
  if (fromLabel && toLabel) return `${fromLabel} – ${toLabel}`;
  if (fromLabel) return `Desde ${fromLabel}`;
  if (toLabel) return `Até ${toLabel}`;
  return '';
}
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
  const statusDatasets = STATUS_SERIES.map((series) => {
    const meta = STATUS_META[series.key] || series;
    const label = meta.name ? `${meta.name}` : series.key;
    return {
      label,
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
  const aggregatedCounts = counters.statusAggregated || null;
  const statusCounts = aggregatedCounts
    ? { ...aggregatedCounts }
    : getStatusCounts(counters.statusCounts || counters.status || {});
  const sent = counters.sent || 0;
  const pending = statusCounts.pending || 0;
  const serverAck = statusCounts.serverAck || 0;
  const delivered = statusCounts.delivered || 0;
  const read = statusCounts.read || 0;
  const played = statusCounts.played || 0;
  const failed = statusCounts.failed || 0;

  if (sent) {
    const deliveryPct = Math.round((delivered / sent) * 100);
    els.kpiDeliveryValue.textContent = deliveryPct + '%';
    els.kpiDeliveryHint.textContent = `${delivered} de ${sent} mensagens entregues. Pendentes: ${pending} • Servidor: ${serverAck} • Falhas: ${failed}`;
  } else {
    els.kpiDeliveryValue.textContent = '—';
    els.kpiDeliveryHint.textContent = 'Envie uma mensagem para iniciar o monitoramento.';
  }

  els.kpiFailureValue.className = 'mt-1 text-2xl font-semibold text-indigo-600';
  if (sent) {
    els.kpiFailureValue.textContent = String(read + played || 0);
    els.kpiFailureHint.textContent = `Lidas: ${read} • Reproduzidas: ${played} • Falhas: ${failed}`;
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
    els.kpiTransitHint.textContent = `Pendentes: ${pending} • Servidor: ${serverAck}`;
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

function toggleButtonLoading(button, loading, label = 'Exportando…') {
  if (!button) return;
  if (loading) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent || '';
    button.textContent = label;
    button.disabled = true;
    button.classList.add('opacity-60', 'pointer-events-none');
  } else {
    if (button.dataset.originalText != null) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
    button.disabled = false;
    button.classList.remove('opacity-60', 'pointer-events-none');
  }
}

async function exportMetrics(format) {
  const iid = currentInstanceId;
  if (!iid) {
    showError('Selecione uma instância para exportar.');
    return;
  }

  const button = format === 'csv' ? els.btnExportCsv : els.btnExportJson;
  const apiKey = getApiKeyValue();
  if (!apiKey) {
    showError('Informe a API Key para exportar os dados.');
    return;
  }

  try {
    toggleButtonLoading(button, true);
    const params = new URLSearchParams();
    if (lastRangeRequest.from != null) params.set('from', String(lastRangeRequest.from));
    if (lastRangeRequest.to != null) params.set('to', String(lastRangeRequest.to));
    const query = params.toString();
    const response = await fetch(`/instances/${iid}/export.${format}${query ? `?${query}` : ''}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const fallbackName = `${iid}-metrics.${format}`;
    const fileName = match ? match[1] : fallbackName;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('[metrics] export failed', err);
    showError('Falha ao exportar métricas.');
  } finally {
    toggleButtonLoading(button, false);
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
    setLogsLoading(false);
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

    const rangeMins = Number(els.selRange?.value) || 240;
    const now = Date.now();
    const from = Math.max(0, now - rangeMins * 60 * 1000);
    const params = new URLSearchParams();
    params.set('from', String(from));
    params.set('to', String(now));

    const metrics = await fetchJSON(`/instances/${iid}/metrics?${params.toString()}`, true);
    lastRangeRequest = { from, to: now };
    lastRangeSummary = metrics?.range?.summary || null;

    updateKpis(metrics);

    const timeline = metrics.timeline || [];

    if (chart && timeline.length) {
      chart.data.labels = timeline.map((p) => formatTimelineLabel(p.iso));
      chart.data.datasets[0].data = timeline.map((p) => p.sent ?? 0);
      STATUS_SERIES.forEach((series, idx) => {
        const key = TIMELINE_FIELDS[series.key];
        chart.data.datasets[idx + 1].data = timeline.map((p) => (key ? p[key] ?? 0 : 0));
      });
      chart.update();
    } else {
      resetChart();
    }

    if (els.chartHint) {
      const effectiveRange = metrics?.range?.effective || { from, to: now };
      const rangeLabel = formatRangeLabel(effectiveRange);
      if (timeline.length) {
        const sentDelta = Number(lastRangeSummary?.deltas?.sent);
        const parts = [`${timeline.length} ponto${timeline.length > 1 ? 's' : ''}`];
        if (rangeLabel) parts.push(`Intervalo: ${rangeLabel}`);
        if (Number.isFinite(sentDelta)) parts.push(`Enviadas no período: ${sentDelta}`);
        els.chartHint.textContent = parts.join(' • ');
      } else {
        els.chartHint.textContent = rangeLabel ? `Sem dados no intervalo selecionado (${rangeLabel}).` : 'Nenhum dado disponível ainda.';
      }
    }

    setLogsLoading(true);
    const effectiveRange = metrics?.range?.effective || { from, to: now };
    await refreshLogs({ silent: true, range: effectiveRange });
    setLogsLoading(false);
    hasLoadedSelected = true;
  } catch (err) {
    console.error('[metrics] erro ao buscar detalhes da instância', err);
    showError('Falha ao carregar detalhes da instância');
  } finally {
    setLogsLoading(false);
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
  if (els.btnExportCsv) els.btnExportCsv.addEventListener('click', () => exportMetrics('csv'));
  if (els.btnExportJson) els.btnExportJson.addEventListener('click', () => exportMetrics('json'));
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
