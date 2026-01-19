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
  setActionBarInstance,
  resetSelectedOverview,
  setSelectedOverview,
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
const qrCooldownUntil = new Map();
let lastRangeRequest = { from: null, to: null };
let lastRangeSummary = null;
let chartLoaderPromise = null;

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

function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return 'calculando…';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.ceil(seconds / 60)} min`;
}

export function resetInspector() {
  if (els.inspectorProxyValue) {
    els.inspectorProxyValue.className = 'text-sm font-semibold text-slate-800';
    els.inspectorProxyValue.textContent = 'Aguardando instância…';
  }
  if (els.inspectorProxyHint) els.inspectorProxyHint.textContent = 'Validação ASN e latência aparecerão aqui.';
  if (els.inspectorRiskValue) {
    els.inspectorRiskValue.className = 'text-sm font-semibold text-slate-800';
    els.inspectorRiskValue.textContent = '—';
  }
  if (els.inspectorRiskHint) els.inspectorRiskHint.textContent = 'Percentual desconhecido aguardando dados.';
  if (els.inspectorQueueValue) {
    els.inspectorQueueValue.className = 'text-sm font-semibold text-slate-800';
    els.inspectorQueueValue.textContent = '—';
  }
  if (els.inspectorQueueHint) els.inspectorQueueHint.textContent = 'Tempo estimado (ETA) e pausas do guardião.';
  if (els.inspectorLogs) els.inspectorLogs.textContent = 'Selecione uma instância para ver os últimos eventos.';
}

function updateInspector(snapshot) {
  if (!els.inspectorProxy) return;
  if (!snapshot) {
    resetInspector();
    return;
  }

  const network = snapshot.network || {};
  const risk = snapshot.risk || {};
  const riskCfg = risk.config || {};
  const riskRuntime = risk.runtime || {};
  const queue = snapshot.queue || {};
  const safeCount = Array.isArray(riskCfg.safeContacts) ? riskCfg.safeContacts.length : 0;

  const latency = network.latencyMs ?? network.latency ?? null;
  const proxyStatus = network.status || 'unknown';
  const proxyLabel =
    proxyStatus === 'ok'
      ? 'Residencial'
      : proxyStatus === 'blocked'
      ? 'Datacenter'
      : proxyStatus === 'failed'
      ? 'Falha'
      : proxyStatus === 'unknown'
      ? 'Desconhecido'
      : proxyStatus;
  const ispLabel = network.isp || network.asn || 'Sem dados de ISP (provedor)';
  const proxyClass =
    proxyStatus === 'ok' ? 'text-emerald-700' : proxyStatus === 'blocked' ? 'text-rose-700' : 'text-amber-700';
  const globalProxyMetrics = (window.__healthSnapshot || null)?.proxyMetrics || null;

  if (els.inspectorProxyValue) {
    els.inspectorProxyValue.className = `text-sm font-semibold ${proxyClass}`;
    els.inspectorProxyValue.textContent = `${proxyLabel} • ${ispLabel}`;
  }
  if (els.inspectorProxyHint) {
    const proxyParts = [];
    if (network.asn) proxyParts.push(`ASN ${network.asn}`);
    if (latency != null) proxyParts.push(`${latency} ms`);
    if (globalProxyMetrics?.avgLatencyMs != null) proxyParts.push(`média ${globalProxyMetrics.avgLatencyMs} ms`);
    if (globalProxyMetrics?.failed) proxyParts.push(`${globalProxyMetrics.failed} falhas globais`);
    els.inspectorProxyHint.textContent = proxyParts.length ? proxyParts.join(' • ') : 'Validação ASN e latência aparecerão aqui.';
  }

  const ratioVal = Number(riskRuntime.ratio);
  const ratioPct = Number.isFinite(ratioVal) ? Math.round(ratioVal * 100) : null;
  const paused = Boolean(queue.paused || riskRuntime.paused);
  const riskClass = paused ? 'text-rose-700' : ratioPct != null && ratioPct >= 60 ? 'text-amber-700' : 'text-emerald-700';

  if (els.inspectorRiskValue) {
    els.inspectorRiskValue.className = `text-sm font-semibold ${riskClass}`;
    els.inspectorRiskValue.textContent = ratioPct != null ? `${ratioPct}% desconhecido` : 'Sem dados';
  }
  if (els.inspectorRiskHint) {
    els.inspectorRiskHint.textContent = paused
      ? 'Fila pausada pelo guardião de risco'
      : `Limiar ${riskCfg.threshold ?? 0.7} • Contatos seguros ${safeCount}`;
  }

  const queueEnabled = queue.enabled !== false && queue.status !== 'disabled';
  const waiting = queue.waiting ?? queue.metrics?.waiting ?? queue.count ?? 0;
  const active = queue.active ?? queue.metrics?.active ?? queue.activeCount ?? 0;
  const eta = queue.metrics?.etaSeconds ?? queue.etaSeconds;
  const queueClass = paused ? 'text-amber-700' : queueEnabled ? 'text-emerald-700' : 'text-slate-700';

  if (els.inspectorQueueValue) {
    els.inspectorQueueValue.className = `text-sm font-semibold ${queueClass}`;
    els.inspectorQueueValue.textContent = queueEnabled ? `${waiting} pend. / ${active} em exec.` : 'Envio direto';
  }
  if (els.inspectorQueueHint) {
    const parts = [];
    if (queueEnabled) {
      if (paused) parts.push('Guardião pausado');
      parts.push(`Tempo estimado (ETA) ${formatEta(eta)}`);
    } else {
      parts.push('Fila desativada');
    }
    els.inspectorQueueHint.textContent = parts.join(' • ');
  }

  if (els.inspectorLogs) {
    const lines = [
      `Proxy: ${proxyLabel} (${ispLabel})${latency != null ? ` • ${latency} ms` : ''}`,
      `Risco: ${ratioPct != null ? `${ratioPct}%` : 'sem dados'}${paused ? ' • pausado' : ''}`,
      queueEnabled
        ? `Fila: ${waiting} pend. / ${active} exec. • Tempo estimado (ETA) ${formatEta(eta)}`
        : 'Fila: envio direto',
    ];
    els.inspectorLogs.textContent = lines.join('\n');
  }

  // Habilita/desabilita ação "Enviar seguro" conforme contatos
  if (els.btnSendSafe) {
    els.btnSendSafe.disabled = safeCount === 0;
    els.btnSendSafe.title = safeCount === 0 ? 'Adicione contatos seguros para usar esta ação' : '';
  }
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

function loadChartJs() {
  if (typeof Chart !== 'undefined') return Promise.resolve(Chart);
  if (chartLoaderPromise) return chartLoaderPromise;
  chartLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    script.async = true;
    script.onload = () => resolve(window.Chart);
    script.onerror = (err) => {
      console.error('[metrics] falha ao carregar Chart.js', err);
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return chartLoaderPromise;
}

async function initChart() {
  if (chart) return;
  const ChartJs = await loadChartJs();
  if (!ChartJs) return;
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
  chart = new ChartJs(ctx, {
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
      plugins: { legend: { display: false } },
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

function buildMetricsLegendItems() {
  const baseItem = {
    id: 'sent',
    label: 'Enviadas',
    color: '#0ea5e9',
    description: 'Volume total de mensagens confirmadas durante o intervalo selecionado.',
  };
  const statusItems = STATUS_SERIES.map((series) => {
    const meta = STATUS_META[series.key] || series;
    const label = meta.name || series.key;
    const description = meta.description || (series.codes.length ? `Status ${series.codes.join(', ')}` : '');
    return {
      id: series.key,
      label,
      color: meta.chartColor || '#94a3b8',
      description,
      codes: series.codes,
    };
  });
  return [baseItem, ...statusItems];
}

function renderMetricsLegend() {
  if (!els.metricsLegend) return;
  const items = buildMetricsLegendItems();
  const fragment = document.createDocumentFragment();
  items.forEach(({ id, label, color, description, codes }) => {
    const chip = document.createElement('span');
    chip.className =
      'inline-flex items-center gap-1 px-2 py-1 rounded-full border border-slate-200 bg-white text-[11px] font-semibold text-slate-600';
    chip.dataset.series = id || '';
    chip.title = description || label;
    chip.setAttribute('aria-label', description ? `${label}: ${description}` : label);

    const bullet = document.createElement('span');
    bullet.className = 'h-2 w-2 rounded-full border border-slate-200';
    bullet.style.backgroundColor = color || '#94a3b8';
    bullet.setAttribute('aria-hidden', 'true');
    chip.appendChild(bullet);

    const labelText = document.createElement('span');
    labelText.textContent = codes && codes.length ? `${label} (${codes.join('/')})` : label;
    chip.appendChild(labelText);

    fragment.appendChild(chip);
  });
  els.metricsLegend.innerHTML = '';
  els.metricsLegend.appendChild(fragment);
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
  setActionBarInstance(snapshot);
  const connection = describeConnection(snapshot);
  currentConnectionState = connection.state;
  setStatusBadge(connection, snapshot.name);
  setSelectedOverview(snapshot);
  setSelectedInstanceActionsDisabled(iid, isInstanceLocked(iid));
  updateInspector(snapshot);

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
  const hasLastQr = snapshot.hasLastQr !== false;
  const hasNewQr = normalizedQrVersion ? previousQrVersion !== normalizedQrVersion : !previousQrVersion;
  const shouldForceReload = Boolean(options.forceQrReload);

  if (shouldLoadQr) {
    if (!hasLastQr) {
      toggleHidden(els.qrImg, true);
      setQrState('loading', 'Gerando QR… aguarde alguns segundos.');
      qrCooldownUntil.set(iid, Date.now() + 5000);
      return;
    }
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
  const now = Date.now();
  const cooldownUntil = qrCooldownUntil.get(iid) || 0;
  if (now < cooldownUntil) return false;
  try {
    const key = getApiKeyValue();
    if (!key) {
      toggleHidden(els.qrImg, true);
      setQrState('needs-key', 'Informe a chave de API para ver o QR.');
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
        const revokePreviousImageUrl = () => {
          if (els.qrImg.previousImageUrl) {
            URL.revokeObjectURL(els.qrImg.previousImageUrl);
          }
          els.qrImg.previousImageUrl = imageUrl;
          els.qrImg.removeEventListener('load', revokePreviousImageUrl);
        };

        els.qrImg.addEventListener('load', revokePreviousImageUrl, { once: true });
        els.qrImg.src = imageUrl;
        toggleHidden(els.qrImg, false);
      }
      if (version) qrVersionCache.set(iid, version);
      const nextState = qrState && qrState !== 'loading' ? qrState : 'disconnected';
      const nextMessage =
        nextState !== 'loading' && qrMessage === 'Sincronizando QR…'
          ? 'Instância desconectada. Aponte o WhatsApp para o QR.'
          : qrMessage;
      setQrState(nextState, nextMessage);
      return true;
    }

    if (response.status === 404 || response.status === 204) {
      const text = response.status === 404 ? await response.text().catch(() => '') : '';
      const waiting = response.status === 204 || text?.includes('no-qr');
      toggleHidden(els.qrImg, true);
      setQrState('loading', waiting ? 'Gerando QR… aguarde alguns segundos.' : 'Instância sem QR. Verifique conexão.');
      qrCooldownUntil.set(iid, now + 5000);
      return false;
    }

    if (response.status === 401) {
      toggleHidden(els.qrImg, true);
      setQrState('needs-key', 'Chave de API inválida.');
      return false;
    }

    throw new Error('HTTP ' + response.status);
  } catch (err) {
    console.error('[metrics] erro ao carregar QR', err);
    toggleHidden(els.qrImg, true);
    setQrState('error', 'Erro ao carregar QR.');
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
    showError('Informe a chave de API para exportar os dados.');
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
    setActionBarInstance(null);
    resetSelectedOverview();
    resetInspector();
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

    await initChart();
    updateKpis(metrics);

    const timeline = metrics.timeline || [];
    const hasData = Array.isArray(timeline) && timeline.some((p) => (p.sent ?? 0) > 0);

    if (chart && hasData) {
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
      if (hasData) {
        const sentDelta = Number(lastRangeSummary?.deltas?.sent);
        const points = timeline.length;
        const parts = [`${points} ponto${points > 1 ? 's' : ''}`];
        if (rangeLabel) parts.push(`Intervalo: ${rangeLabel}`);
        if (Number.isFinite(sentDelta)) parts.push(`Enviadas no período: ${sentDelta}`);
        els.chartHint.textContent = parts.join(' • ');
      } else {
        els.chartHint.textContent = rangeLabel ? `Sem dados no intervalo selecionado (${rangeLabel}).` : 'Nenhum dado disponível ainda.';
      }
    }

    const shouldLoadLogs = !els.logsDrawer || !els.logsDrawer.classList.contains('hidden');
    const effectiveRange = metrics?.range?.effective || { from, to: now };
    if (shouldLoadLogs) {
      setLogsLoading(true);
      await refreshLogs({ silent: true, range: effectiveRange });
      setLogsLoading(false);
    }
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
  applySavedRange();
  renderMetricsLegend();
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
