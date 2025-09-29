/* ---------- DOM refs ---------- */
const els = {
  badge: document.getElementById('badge'),
  sessionsRoot: document.getElementById('sessionsRoot'),
  selInstance: document.getElementById('selInstance'),
  btnNew: document.getElementById('btnNew'),
  cards: document.getElementById('cards'),

  // Note card
  noteCard: document.getElementById('noteCard'),
  noteMeta: document.getElementById('noteMeta'),
  instanceNote: document.getElementById('instanceNote'),

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

  // QR / ações rápidas
  qrImg: document.getElementById('qrImg'),
  qrHint: document.getElementById('qrHint'),
  btnLogout: document.getElementById('btnLogout'),
  btnWipe: document.getElementById('btnWipe'),
  btnPair: document.getElementById('btnPair'),

  // Envio rápido
  inpApiKey: document.getElementById('inpApiKey'),
  inpPhone: document.getElementById('inpPhone'),
  inpMsg: document.getElementById('inpMsg'),
  btnSend: document.getElementById('btnSend'),
  sendOut: document.getElementById('sendOut'),

  // Modal
  modalDelete: document.getElementById('modalDelete'),
  modalInstanceName: document.getElementById('modalInstanceName'),
  modalConfirm: document.querySelector('[data-act="modal-confirm"]'),
  modalCancel: document.querySelector('[data-act="modal-cancel"]'),
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

/* ---------- Helpers UI ---------- */
const BADGE_STYLES = {
  'status-connected': 'bg-emerald-100 text-emerald-800',
  'status-disconnected': 'bg-rose-100 text-rose-800',
  logout: 'bg-amber-100 text-amber-800',
  wipe: 'bg-rose-200 text-rose-900',
  delete: 'bg-rose-600 text-white',
  update: 'bg-sky-100 text-sky-800',
  error: 'bg-amber-100 text-amber-800',
  info: 'bg-slate-200 text-slate-800'
};
let badgeLockUntil = 0;

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
function setStatusBadge(connected, name) {
  if (!canUpdateBadge()) return;
  applyBadge(connected ? 'status-connected' : 'status-disconnected', connected ? 'Conectado (' + name + ')' : 'Desconectado (' + name + ')');
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(val) { return String(val ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] || ch); }

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
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return dateTimeFmt.format(d);
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
    refreshSelected();
  });
}

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

/* ---------- KPI helpers ---------- */
function percent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), 1);
  return Math.round(clamped * 100);
}

let chart;
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
async function refreshInstances() {
  try {
    const data = await fetchJSON('/instances', true);
    const prev = els.selInstance.value;
    els.selInstance.textContent = '';

    if (!Array.isArray(data) || !data.length) {
      els.selInstance.value = '';
      els.cards.innerHTML = '<div class="p-4 bg-white rounded-2xl shadow text-sm text-slate-500">Nenhuma instância cadastrada ainda. Clique em “+ Nova instância”.</div>';
      if (els.noteCard) els.noteCard.classList.add('hidden');
      resetChart();
      setBadgeState('info', 'Crie uma instância para começar', 4000);
      return;
    }

    let keepPrev = false;
    data.forEach(inst => {
      const label = `${inst.name}${inst.connected ? ' • on-line' : ' • off-line'}`;
      const opt = option(inst.id, label);
      if (inst.id === prev) { opt.selected = true; keepPrev = true; }
      els.selInstance.appendChild(opt);
    });
    if (!keepPrev && data[0]) els.selInstance.value = data[0].id;

    // Recria cards
    els.cards.innerHTML = '';
    const selected = els.selInstance.value;
    data.forEach(i => {
      const card = document.createElement('article');
      card.className = 'p-4 bg-white rounded-2xl shadow transition ring-emerald-200/50 space-y-3';
      if (i.id === selected) card.classList.add('ring-2', 'ring-emerald-200');
      const connected = !!i.connected;
      const badgeClass = connected ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700';
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
            ${connected ? 'Conectado' : 'Desconectado'}
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
    });

    await refreshSelected();

  } catch (err) {
    console.error('[dashboard] erro ao buscar instâncias', err);
    showError('Falha ao carregar instâncias');
  }
}

/* Carregar QR code com autenticação */
async function loadQRCode(iid) {
  try {
    const k = els.inpApiKey?.value?.trim();
    if (!k) {
      els.qrImg.classList.add('hidden');
      els.qrHint.textContent = 'Informe a API Key para ver o QR code.';
      return;
    }
    
    const headers = { 'x-api-key': k };
    const response = await fetch('/instances/' + iid + '/qr.png?t=' + Date.now(), { 
      headers, 
      cache: 'no-store' 
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        els.qrImg.classList.add('hidden');
        els.qrHint.textContent = 'API Key inválida.';
        return;
      }
      if (response.status === 404) {
        els.qrImg.classList.add('hidden');
        els.qrHint.textContent = 'QR code não disponível ainda.';
        return;
      }
      throw new Error('HTTP ' + response.status);
    }
    
    const blob = await response.blob();
    const imageUrl = URL.createObjectURL(blob);
    els.qrImg.src = imageUrl;
    els.qrImg.classList.remove('hidden');
    
    // Limpar URL anterior para evitar vazamento de memória
    els.qrImg.onload = () => {
      if (els.qrImg.previousImageUrl) {
        URL.revokeObjectURL(els.qrImg.previousImageUrl);
      }
      els.qrImg.previousImageUrl = imageUrl;
    };
    
  } catch (err) {
    console.error('[dashboard] erro ao carregar QR code', err);
    els.qrImg.classList.add('hidden');
    els.qrHint.textContent = 'Erro ao carregar QR code.';
  }
}

async function refreshSelected() {
  const iid = els.selInstance.value;
  if (!iid) {
    els.qrImg.classList.add('hidden');
    els.qrHint.textContent = 'Nenhuma instância selecionada.';
    if (els.noteCard) els.noteCard.classList.add('hidden');
    resetChart();
    return;
  }

  try {
    const data = await fetchJSON('/instances/' + iid, true);
    const connected = !!data.connected;
    setStatusBadge(connected, data.name);

    if (connected) {
      els.qrImg.classList.add('hidden');
      els.qrHint.textContent = 'Instância conectada.';
    } else {
      // Carregar QR code via fetch com autenticação
      await loadQRCode(iid);
      els.qrHint.textContent = 'Aponte o WhatsApp para o QR code.';
    }

    if (els.noteCard) {
      els.noteCard.classList.remove('hidden');
      els.instanceNote.value = data.note || '';
      const created = formatDateTime(data.metadata?.createdAt);
      const updated = formatDateTime(data.metadata?.updatedAt);
      els.noteMeta.textContent = `Criado: ${created || '—'} • Atualizado: ${updated || '—'}`;
    }

    // Métricas e gráfico
    const metrics = await fetchJSON('/instances/' + iid + '/metrics', true);
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
      els.chartHint.textContent = `Exibindo ${timeline.length} pontos de dados.`;
    } else {
      resetChart();
    }

  } catch (err) {
    console.error('[dashboard] erro ao buscar detalhes da instância', err);
    showError('Falha ao carregar detalhes da instância');
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

  try {
    const key = requireKey();
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const payload = await fetchJSON('/instances/' + iid, true, { method: 'PATCH', body: JSON.stringify({ name, note }) });
    setBadgeState('update', 'Dados salvos (' + payload.name + ')', 4000);
    await refreshInstances();
  } catch (err) {
    console.error('[dashboard] erro ao salvar metadados', err);
    showError('Falha ao salvar dados da instância');
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

  const url = endpoints[action];
  if (!url) return false;

  const button = context.button || null;
  const name = context.name || iid;

  if (button) button.disabled = true;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'x-api-key': key } });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      alert('Falha ao executar ' + action + ': HTTP ' + r.status + (txt ? ' — ' + txt : ''));
      setBadgeState('error', 'Falha em ' + action + ' (' + name + ')', 5000);
      return false;
    }
    const payload = await r.json().catch(() => ({}));
    const message = payload?.message || fallbackMessages[action](name);
    setBadgeState(badgeTypes[action], message, holdTimes[action]);
    await refreshInstances();
    return true;
  } catch (err) {
    console.error('[dashboard] erro em ' + action, err);
    showError('Erro ao executar ' + action);
    return false;
  } finally {
    if (button) button.disabled = false;
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
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !els.modalDelete.classList.contains('hidden')) closeDeleteModal();
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
    btn.disabled = true;
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
      await refreshInstances();
    } catch (err) {
      console.error('[dashboard] erro ao excluir instância', err);
      showError('Erro ao excluir instância');
    } finally {
      btn.disabled = false;
    }
    return;
  }

  // demais ações precisam de iid
  const iid = btn.dataset.iid;
  if (!iid) return;

  // ações simples que não alteram servidor
  if (act === 'select') {
    els.selInstance.value = iid;
    await refreshSelected();
    return;
  }
  if (act === 'qr') {
    try { requireKey(); } catch { return; }
    if (iid) els.selInstance.value = iid;
    await refreshSelected();
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
    await refreshInstances();
  } catch (err) {
    console.error('[dashboard] erro ao criar instância', err);
    showError('Falha ao criar instância');
    alert('Falha ao criar instância: ' + err.message);
  }
};

/* Select change */
els.selInstance.onchange = refreshSelected;

/* Logout/Wipe (header) */
els.btnLogout.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const iid = els.selInstance.value;
    if (!iid) return;
    const key = requireKey();
    const ok = await performInstanceAction('logout', iid, key, { name: iid, button: null });
    if (ok) els.qrHint.textContent = 'Desconectando… aguarde novo QR.';
  } catch {}
};
els.btnWipe.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const iid = els.selInstance.value;
    if (!iid) return;
    const key = requireKey();
    const ok = await performInstanceAction('wipe', iid, key, { name: iid, button: null });
    if (ok) els.qrHint.textContent = 'Limpando sessão… o serviço reiniciará para gerar novo QR.';
  } catch {}
};

/* Pair por código */
els.btnPair.onclick = async () => {
  try {
    const iid = els.selInstance.value;
    if (!iid) { showError('Selecione uma instância.'); return; }
    requireKey();
    const phone = prompt('Número no formato E.164 (ex: 5544999999999):');
    if (!phone) return;
    const j = await fetchJSON('/instances/'+iid+'/pair', true, { method:'POST', body: JSON.stringify({ phoneNumber: phone }) });
    const code = j?.pairingCode || '(sem código)';
    els.qrHint.textContent = 'Código de pareamento: ' + code + ' (copiado)';
    try { await navigator.clipboard.writeText(code); } catch {}
    setBadgeState('update', 'Código de pareamento gerado.', 4000);
  } catch (e) {
    alert('Falha ao gerar código: ' + e.message);
  }
};

/* Envio rápido */
els.btnSend.onclick = async () => {
  try {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    const iid = els.selInstance.value;
    if (!iid) { showError('Selecione uma instância.'); return; }
    const to = els.inpPhone.value.trim();
    const message = els.inpMsg.value.trim();
    if (!to || !message) { showError('Informe destino e mensagem.'); return; }
    const body = JSON.stringify({ to, message, waitAckMs: 8000 });
    const r = await fetch('/instances/'+iid+'/send-text', { method: 'POST', headers: { 'x-api-key': els.inpApiKey.value.trim(), 'Content-Type':'application/json' }, body });
    const j = await r.json();
    els.sendOut.textContent = 'Resposta: ' + JSON.stringify(j);
    setBadgeState('update', 'Mensagem enviada — acompanhe os indicadores.', 3000);
    await refreshSelected();
  } catch (e) {
    els.sendOut.textContent = 'Falha no envio: ' + e.message;
    showError('Não foi possível enviar a mensagem.');
  }
};

/* Boot do dashboard */
initChart();
setInterval(refreshInstances, 3000);
refreshInstances();

