import { fetchJSON, requireKey } from './api.js';
import { applyInstanceNote, resetNotes } from './notes.js';
import { refreshSelected, resetChart } from './metrics.js';
import { resetLogs } from './logs.js';
import {
  HTML_ESCAPES,
  STATUS_SERIES,
  STATUS_META,
  describeConnection,
  els,
  getStatusCounts,
  isInstanceLocked,
  setBadgeState,
  setCardsLoading,
  setInstanceActionsDisabled,
  setQrState,
  setSelectedInstanceActionsDisabled,
  setBusy,
  showError,
  toggleHidden,
  updateInstanceLocksFromSnapshot,
} from './state.js';

let hasLoadedInstances = false;
let refreshInstancesInFlight = null;
const instanceEtags = new Map();
let lastInstancesSignature = '';
let lastSelectedInstanceEtag = null;

function computeInstanceEtag(inst) {
  if (!inst) return '';
  const directKeys = ['etag', 'updatedAt', 'updated_at', 'updated_at_ms', 'connectionUpdatedAt'];
  for (const key of directKeys) {
    const value = inst[key];
    if (value != null && value !== '') return String(value);
  }
  if (inst?.metadata?.updatedAt) return String(inst.metadata.updatedAt);
  if (inst?.metadata?.createdAt) return String(inst.metadata.createdAt);
  if (inst?.counters?.sent != null) return `${inst.id}:${inst.counters.sent}`;
  return `${inst.id}:${inst.name || ''}:${inst.connectionState || ''}`;
}

function buildInstancesSignature(data = []) {
  const parts = data.map((inst) => `${inst.id}:${computeInstanceEtag(inst)}`);
  parts.sort();
  return parts.join('|');
}

function escapeHtml(val) {
  return String(val ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] || ch);
}

function option(value, text) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  return opt;
}

function buildStatusCards(statusCounts = {}) {
  return STATUS_SERIES.map((series) => {
    const meta = STATUS_META[series.key] || series;
    const titleAttr = meta.description ? ` title="${escapeHtml(meta.description)}"` : '';
    const codesLabel = series.codes.length ? `Status ${series.codes.join('/')}` : 'Status';
    const count = Number(statusCounts[series.key]) || 0;
    return `
      <div class="rounded-lg bg-slate-50 p-2"${titleAttr}>
        <span class="block text-[11px] uppercase tracking-wide text-slate-400">${escapeHtml(codesLabel)} • ${escapeHtml(
          meta.name || series.key,
        )}</span>
        <span class="text-sm font-semibold ${meta.textClass || 'text-slate-600'}">${count}</span>
      </div>`;
  }).join('');
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), 1);
  return Math.round(clamped * 100);
}

export async function refreshInstances(options = {}) {
  if (refreshInstancesInFlight) return refreshInstancesInFlight;
  const { silent = false, withSkeleton, skipSelected = false } = options;
  const shouldShowSkeleton = withSkeleton ?? (!hasLoadedInstances && !silent);
  if (shouldShowSkeleton || !hasLoadedInstances) setCardsLoading(true);

  refreshInstancesInFlight = (async () => {
    let result = { changed: false, selectedChanged: false };
    try {
      const data = await fetchJSON('/instances', true);
      updateInstanceLocksFromSnapshot(data);
      const prev = els.selInstance?.value;
      if (els.selInstance) els.selInstance.textContent = '';

      if (!Array.isArray(data) || !data.length) {
        const hadLoadedBefore = hasLoadedInstances;
        const prevSignature = lastInstancesSignature;
        const prevSelectedEtag = lastSelectedInstanceEtag;
        instanceEtags.clear();
        lastInstancesSignature = '';
        lastSelectedInstanceEtag = null;
        if (els.selInstance) els.selInstance.value = '';
        if (els.cards) {
          els.cards.innerHTML = '<div class="p-4 bg-white rounded-2xl shadow text-sm text-slate-500">Nenhuma instância cadastrada ainda. Clique em “+ Nova instância”.</div>';
        }
        resetNotes();
        resetChart();
        resetLogs();
        toggleHidden(els.qrImg, true);
        setQrState('idle', 'Selecione uma instância para visualizar o QR.');
        setBadgeState('info', 'Crie uma instância para começar', 4000);
        hasLoadedInstances = true;
        const listChanged = !hadLoadedBefore || prevSignature !== '';
        const selectedChanged = prevSelectedEtag !== null;
        result = { changed: listChanged || selectedChanged, selectedChanged };
        return result;
      }

      const hadLoadedBefore = hasLoadedInstances;
      const prevSelectedEtag = lastSelectedInstanceEtag;
      const previousSignature = lastInstancesSignature;
      const nextEtags = new Map();
      const nextSignature = buildInstancesSignature(data);
      const listChanged = !hadLoadedBefore || previousSignature !== nextSignature;
      data.forEach((inst) => {
        nextEtags.set(inst.id, computeInstanceEtag(inst));
      });
      instanceEtags.clear();
      nextEtags.forEach((val, key) => instanceEtags.set(key, val));
      lastInstancesSignature = nextSignature;

      let keepPrev = false;
      data.forEach((inst) => {
        const connection = describeConnection(inst);
        const suffix = connection.meta?.optionSuffix || '';
        const label = `${inst.name}${suffix}`;
        const opt = option(inst.id, label);
        if (inst.id === prev) {
          opt.selected = true;
          keepPrev = true;
        }
        if (els.selInstance) {
          els.selInstance.appendChild(opt);
        }
      });
      if (!keepPrev && data[0] && els.selInstance) els.selInstance.value = data[0].id;

      if (els.cards) els.cards.innerHTML = '';
      const selected = els.selInstance?.value;
      const selectedEtag = selected ? instanceEtags.get(selected) || null : null;
      const selectedChanged = selectedEtag !== prevSelectedEtag;
      lastSelectedInstanceEtag = selectedEtag;
      data.forEach((inst) => {
        const connection = describeConnection(inst);
        const card = document.createElement('article');
        card.className = 'p-4 bg-white rounded-2xl shadow transition ring-emerald-200/50 space-y-3';
        if (inst.id === selected) card.classList.add('ring-2', 'ring-emerald-200');
        const locked = isInstanceLocked(inst.id);
        card.classList.toggle('opacity-75', locked);
        const badgeClass = connection.meta?.badgeClass || 'bg-slate-100 text-slate-700';
        const statusLabel = typeof connection.meta?.cardLabel === 'function'
          ? connection.meta.cardLabel(connection.updatedText)
          : connection.meta?.label || 'Desconhecido';
        const sent = inst.counters?.sent || 0;
        const aggregatedCounts = inst.counters?.statusAggregated || null;
        const statusCounts = aggregatedCounts
          ? { ...aggregatedCounts }
          : getStatusCounts(inst.counters?.statusCounts || inst.counters?.status || {});
        const statusCardsHtml = buildStatusCards(statusCounts);
        const statusSummaryText = [
          `Pendentes: ${statusCounts.pending || 0}`,
          `Servidor: ${statusCounts.serverAck || 0}`,
          `Entregues: ${statusCounts.delivered || 0}`,
          `Lidas: ${statusCounts.read || 0}`,
          `Reproduzidas: ${statusCounts.played || 0}`,
          `Falhas: ${statusCounts.failed || 0}`,
        ].join(' • ');
        const usagePercent = percent(inst.rate?.usage || 0);
        const meterColor = usagePercent >= 90 ? 'bg-rose-400' : usagePercent >= 70 ? 'bg-amber-400' : 'bg-emerald-400';
        const userId = inst.user?.id ? escapeHtml(inst.user.id) : '—';
        const noteVal = (inst.note || inst.notes || '').trim();

        card.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1">
            <label class="text-xs font-medium text-slate-500">Nome</label>
            <input data-field="name" data-iid="${inst.id}" class="mt-1 w-full border rounded-lg px-2 py-1 text-sm" value="${escapeHtml(inst.name)}" />
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
            <div class="text-[11px] text-slate-400">${statusSummaryText}</div>
          </div>
        </div>

        <div>
          <label class="text-xs font-medium text-slate-500">Notas</label>
          <textarea data-field="note" data-iid="${inst.id}" rows="3" class="mt-1 w-full border rounded-lg px-2 py-1 text-sm">${escapeHtml(noteVal)}</textarea>
        </div>

        <div class="flex items-center justify-end gap-2 flex-wrap">
          <button data-act="save" data-iid="${inst.id}" class="px-3 py-1.5 text-sm bg-sky-600 hover:bg-sky-700 text-white rounded-lg">Salvar</button>
          <button data-act="select" data-iid="${inst.id}" class="px-3 py-1.5 text-sm border rounded-lg">Selecionar</button>
          <button data-act="qr" data-iid="${inst.id}" class="px-3 py-1.5 text-sm border rounded-lg">Ver QR</button>
          <button data-act="logout" data-iid="${inst.id}" class="px-3 py-1.5 text-sm border rounded-lg">Logout</button>
          <button data-act="wipe" data-iid="${inst.id}" class="px-3 py-1.5 text-sm border rounded-lg">Wipe</button>
          <button data-act="delete" data-iid="${inst.id}" class="px-3 py-1.5 text-sm bg-rose-500 hover:bg-rose-600 text-white rounded-lg">Excluir</button>
        </div>
      `;
        if (els.cards) {
          els.cards.appendChild(card);
        }
        setInstanceActionsDisabled(inst.id, locked);
      });

      hasLoadedInstances = true;
      if (!skipSelected && (selectedChanged || !hadLoadedBefore)) {
        await refreshSelected({ silent, withSkeleton: !silent });
      }

      result = { changed: listChanged || selectedChanged, selectedChanged };
    } catch (err) {
      console.error('[instances] erro ao buscar instâncias', err);
      showError('Falha ao carregar instâncias');
    } finally {
      setCardsLoading(false);
      refreshInstancesInFlight = null;
      const currentSelected = els.selInstance?.value;
      if (currentSelected) {
        setSelectedInstanceActionsDisabled(currentSelected, isInstanceLocked(currentSelected));
      }
    }

    return result;
  })();

  return refreshInstancesInFlight;
}

export function findCardByIid(iid) {
  return document.querySelector(`[data-iid="${iid}"]`)?.closest('article');
}

export async function handleSaveMetadata(iid) {
  const card = findCardByIid(iid);
  if (!card) return;
  const name = card.querySelector('[data-field="name"]')?.value?.trim();
  const note = card.querySelector('[data-field="note"]')?.value?.trim();
  if (!name) {
    showError('O nome não pode estar vazio.');
    return;
  }

  const btn = card.querySelector(`[data-act="save"][data-iid="${iid}"]`);
  setBusy(btn, true, 'Salvando…');
  try {
    requireKey();
    if (els.inpApiKey) {
      localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    }
    const payload = await fetchJSON(`/instances/${iid}`, true, {
      method: 'PATCH',
      body: JSON.stringify({ name, note }),
    });
    const label = payload?.name || name;
    setBadgeState('update', 'Dados salvos (' + label + ')', 4000);
    if (iid === els.selInstance?.value) {
      applyInstanceNote({ note: note || '', metadata: payload?.metadata || {} });
    }
    await refreshInstances({ silent: true, withSkeleton: false });
  } catch (err) {
    console.error('[instances] erro ao salvar metadados', err);
    showError('Falha ao salvar dados da instância');
  } finally {
    setBusy(btn, false);
  }
}
