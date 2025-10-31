import { fetchJSON, requireKey } from './api.js';
import { applyInstanceNote, resetNotes } from './notes.js';
import { refreshSelected, resetChart } from './metrics.js';
import { resetLogs } from './logs.js';
import {
  HTML_ESCAPES,
  INSTANCE_FILTERS,
  INSTANCE_VIEW,
  STATUS_CODES,
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
let allInstances = [];
let filteredInstances = [];
let filterHandlersBound = false;
let scrollRaf = null;
let measureRaf = null;
let resizeRaf = null;

const MAX_RENDERED_ITEMS = 50;
const VIRTUAL_OVERSCAN_ROWS = 2;

const virtualizationState = INSTANCE_VIEW.virtualization;

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

function buildStatusCards(statusCounts) {
  return STATUS_CODES.map((code) => {
    const meta = STATUS_META[code] || {};
    const titleAttr = meta.description ? ` title="${escapeHtml(meta.description)}"` : '';
    const label = escapeHtml(meta.name || `Status ${code}`);
    return `
      <div class="rounded-lg bg-slate-50 p-2"${titleAttr}>
        <span class="block text-[11px] uppercase tracking-wide text-slate-400">Status ${code} • ${label}</span>
        <span class="text-sm font-semibold ${meta.textClass || 'text-slate-600'}">${statusCounts[code] || 0}</span>
      </div>`;
  }).join('');
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), 1);
  return Math.round(clamped * 100);
}

function normalizeInstance(inst) {
  if (!inst) return null;
  const copy = { ...inst };
  if (inst.counters) {
    copy.counters = { ...inst.counters };
    const statusCounts = inst.counters.statusCounts || inst.counters.status;
    if (statusCounts) {
      copy.counters.statusCounts = { ...statusCounts };
    }
  }
  if (inst.metadata) copy.metadata = { ...inst.metadata };
  if (inst.rate) copy.rate = { ...inst.rate };
  if (inst.user) copy.user = { ...inst.user };
  return copy;
}

function mergeInstance(base, patch) {
  if (!base) return normalizeInstance(patch);
  if (!patch) return base;
  const merged = { ...base, ...patch };
  if (base.counters || patch.counters) {
    const baseCounters = base.counters || {};
    const patchCounters = patch.counters || {};
    merged.counters = { ...baseCounters, ...patchCounters };
    const baseCounts = baseCounters.statusCounts || baseCounters.status || {};
    const patchCounts = patchCounters.statusCounts || patchCounters.status || {};
    merged.counters.statusCounts = { ...baseCounts, ...patchCounts };
  }
  if (base.metadata || patch.metadata) {
    merged.metadata = { ...(base.metadata || {}), ...(patch.metadata || {}) };
  }
  if (base.rate || patch.rate) {
    merged.rate = { ...(base.rate || {}), ...(patch.rate || {}) };
  }
  if (base.user || patch.user) {
    merged.user = { ...(base.user || {}), ...(patch.user || {}) };
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
    merged.note = patch.note;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    merged.notes = patch.notes;
  }
  return merged;
}

function updateInstanceCache(instances, { replace = false } = {}) {
  if (replace) {
    if (!Array.isArray(instances)) {
      allInstances = [];
      return;
    }
    allInstances = instances.map((inst) => normalizeInstance(inst)).filter(Boolean);
    return;
  }
  if (!Array.isArray(instances)) return;
  if (!allInstances.length) {
    allInstances = instances.map((inst) => normalizeInstance(inst)).filter(Boolean);
    return;
  }
  const updates = new Map();
  instances.forEach((inst) => {
    if (inst && inst.id) updates.set(inst.id, inst);
  });
  if (!updates.size) return;
  const next = [];
  allInstances.forEach((inst) => {
    if (!inst || !inst.id) return;
    if (updates.has(inst.id)) {
      const patch = updates.get(inst.id);
      next.push(mergeInstance(inst, patch));
      updates.delete(inst.id);
    } else {
      next.push(inst);
    }
  });
  updates.forEach((patch, id) => {
    if (!id) return;
    next.push(normalizeInstance({ ...patch, id }));
  });
  allInstances = next;
}

function updateInstanceMeta() {
  const prevSignature = lastInstancesSignature;
  const prevSelectedEtag = lastSelectedInstanceEtag;
  const nextSignature = buildInstancesSignature(allInstances);
  lastInstancesSignature = nextSignature;

  instanceEtags.clear();
  allInstances.forEach((inst) => {
    if (!inst || !inst.id) return;
    instanceEtags.set(inst.id, computeInstanceEtag(inst));
  });

  const selectedId = els.selInstance?.value || '';
  const selectedEtag = selectedId ? instanceEtags.get(selectedId) || null : null;
  lastSelectedInstanceEtag = selectedEtag;
  return {
    listChanged: prevSignature !== nextSignature,
    selectedChanged: selectedEtag !== prevSelectedEtag,
  };
}

function updateInstanceCounter() {
  INSTANCE_VIEW.total = allInstances.length;
  INSTANCE_VIEW.filtered = filteredInstances.length;
  if (els.instanceCounter) {
    els.instanceCounter.textContent = `${INSTANCE_VIEW.filtered}/${INSTANCE_VIEW.total}`;
  }
}

function updateInstanceSelect(prevSelected) {
  if (!els.selInstance) return '';
  const previous = typeof prevSelected === 'string' ? prevSelected : els.selInstance.value;
  els.selInstance.textContent = '';
  let keepPrev = false;
  allInstances.forEach((inst) => {
    if (!inst || !inst.id) return;
    const connection = describeConnection(inst);
    const suffix = connection.meta?.optionSuffix || '';
    const label = `${inst.name || inst.id}${suffix}`;
    const opt = option(inst.id, label);
    if (inst.id === previous) {
      opt.selected = true;
      keepPrev = true;
    }
    els.selInstance.appendChild(opt);
  });
  if (!keepPrev && allInstances[0]) {
    els.selInstance.value = allInstances[0].id;
    return els.selInstance.value;
  }
  if (!allInstances.length) {
    els.selInstance.value = '';
  }
  return keepPrev ? previous : els.selInstance.value;
}

function getInstanceTimestamp(inst) {
  if (!inst) return 0;
  const candidates = [
    inst.connectionUpdatedAt,
    inst.metadata?.updatedAt,
    inst.metadata?.createdAt,
    inst.updatedAt,
    inst.updated_at,
    inst.updated_at_ms,
  ];
  for (const value of candidates) {
    if (value == null) continue;
    if (typeof value === 'number' && Number.isFinite(value)) return Number(value);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function compareInstances(a, b, sortKey) {
  if (sortKey === 'recent') {
    const diff = getInstanceTimestamp(b) - getInstanceTimestamp(a);
    if (diff) return diff;
  } else if (sortKey === 'usage') {
    const usageA = Number(a?.rate?.usage) || 0;
    const usageB = Number(b?.rate?.usage) || 0;
    const diff = usageB - usageA;
    if (diff) return diff;
  }
  const nameA = (a?.name || '').toLocaleLowerCase('pt-BR');
  const nameB = (b?.name || '').toLocaleLowerCase('pt-BR');
  const cmp = nameA.localeCompare(nameB);
  if (cmp) return cmp;
  return (a?.id || '').localeCompare(b?.id || '');
}

function applyFiltersList() {
  const searchRaw = (INSTANCE_FILTERS.search || '').trim();
  const search = searchRaw.toLocaleLowerCase('pt-BR');
  const statusFilter = INSTANCE_FILTERS.status || 'all';
  const sortKey = INSTANCE_FILTERS.sort || 'name';

  const filtered = allInstances.filter((inst) => {
    if (!inst) return false;
    if (statusFilter !== 'all') {
      const connection = describeConnection(inst);
      if (connection.state !== statusFilter) return false;
    }
    if (!search) return true;
    const fields = [
      inst.name,
      inst.id,
      inst.user?.id,
      inst.metadata?.label,
      inst.note,
      inst.notes,
    ];
    return fields.some((field) => typeof field === 'string' && field.toLocaleLowerCase('pt-BR').includes(search));
  });

  filtered.sort((a, b) => compareInstances(a, b, sortKey));
  return filtered;
}

function scheduleMeasurement() {
  if (measureRaf) return;
  measureRaf = requestAnimationFrame(() => {
    measureRaf = null;
    if (!els.cards) return;
    const sample = els.cards.querySelector('article');
    if (!sample) return;
    const cardRect = sample.getBoundingClientRect();
    if (!cardRect || !cardRect.height) return;
    const containerRect = els.cards.getBoundingClientRect();
    const style = window.getComputedStyle(els.cards);
    const gap = parseFloat(style.rowGap || '0') || 0;
    const width = cardRect.width || 1;
    const columns = width ? Math.max(1, Math.round(containerRect.width / width)) : 1;
    const ready = filteredInstances.length > MAX_RENDERED_ITEMS && columns > 0 && cardRect.height > 0;
    const changed =
      virtualizationState.rowHeight !== cardRect.height ||
      virtualizationState.columns !== columns ||
      virtualizationState.rowGap !== gap ||
      virtualizationState.ready !== ready;

    virtualizationState.rowHeight = cardRect.height;
    virtualizationState.columns = columns;
    virtualizationState.rowGap = gap;
    virtualizationState.ready = ready;
    INSTANCE_VIEW.virtualization.ready = ready;

    if (ready && changed) {
      updateVirtualWindow(true);
    } else if (!ready) {
      applyVirtualPadding(0, filteredInstances.length);
    }
  });
}

function applyVirtualPadding(startIndex, endIndex) {
  if (!els.cards) return;
  if (!virtualizationState.ready) {
    els.cards.style.paddingTop = '';
    els.cards.style.paddingBottom = '';
    INSTANCE_VIEW.virtualization.paddingTop = 0;
    INSTANCE_VIEW.virtualization.paddingBottom = 0;
    return;
  }

  const total = filteredInstances.length;
  const columns = Math.max(1, virtualizationState.columns || 1);
  const rowHeight = virtualizationState.rowHeight || 0;
  const rowGap = virtualizationState.rowGap || 0;
  const totalRows = Math.ceil(total / columns);
  const totalHeight = totalRows * rowHeight + Math.max(0, totalRows - 1) * rowGap;
  const startRow = Math.floor(startIndex / columns);
  const visibleItems = Math.max(0, endIndex - startIndex);
  const visibleRows = Math.ceil(visibleItems / columns);
  const topPadding = startRow * rowHeight + Math.max(0, startRow) * rowGap;
  const visibleHeight = visibleRows * rowHeight + Math.max(0, visibleRows - 1) * rowGap;
  const bottomPadding = Math.max(0, totalHeight - topPadding - visibleHeight);

  INSTANCE_VIEW.virtualization.paddingTop = topPadding;
  INSTANCE_VIEW.virtualization.paddingBottom = bottomPadding;
  els.cards.style.paddingTop = topPadding ? `${topPadding}px` : '';
  els.cards.style.paddingBottom = bottomPadding ? `${bottomPadding}px` : '';
}

function createInstanceCard(inst, selectedId) {
  const connection = describeConnection(inst);
  const card = document.createElement('article');
  card.className = 'p-4 bg-white rounded-2xl shadow transition ring-emerald-200/50 space-y-3';
  if (inst.id === selectedId) card.classList.add('ring-2', 'ring-emerald-200');
  const locked = isInstanceLocked(inst.id);
  card.classList.toggle('opacity-75', locked);
  const badgeClass = connection.meta?.badgeClass || 'bg-slate-100 text-slate-700';
  const statusLabel = typeof connection.meta?.cardLabel === 'function'
    ? connection.meta.cardLabel(connection.updatedText)
    : connection.meta?.label || 'Desconhecido';
  const sent = inst.counters?.sent || 0;
  const statusCounts = getStatusCounts(inst.counters?.statusCounts || inst.counters?.status || {});
  const statusCardsHtml = buildStatusCards(statusCounts);
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
        <div class="text-[11px] text-slate-400">Status 1: ${statusCounts['1'] || 0} • Status 2: ${statusCounts['2'] || 0} • Status 3: ${statusCounts['3'] || 0} • Status 4: ${statusCounts['4'] || 0} • Status 5: ${statusCounts['5'] || 0}</div>
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

  return { card, locked };
}

function drawSlice(startIndex, endIndex) {
  if (!els.cards) return;
  const selectedId = els.selInstance?.value || '';
  const frag = document.createDocumentFragment();
  const lockQueue = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    const inst = filteredInstances[i];
    if (!inst) continue;
    const { card, locked } = createInstanceCard(inst, selectedId);
    frag.appendChild(card);
    lockQueue.push({ id: inst.id, locked });
  }
  els.cards.innerHTML = '';
  els.cards.appendChild(frag);
  lockQueue.forEach(({ id, locked }) => {
    setInstanceActionsDisabled(id, locked);
  });

  virtualizationState.startIndex = startIndex;
  virtualizationState.endIndex = endIndex;
  INSTANCE_VIEW.virtualization.startIndex = startIndex;
  INSTANCE_VIEW.virtualization.endIndex = endIndex;

  applyVirtualPadding(startIndex, endIndex);
}

function computeVirtualRange() {
  const total = filteredInstances.length;
  const columns = Math.max(1, virtualizationState.columns || 1);
  const rowHeight = virtualizationState.rowHeight || 0;
  const rowGap = virtualizationState.rowGap || 0;
  const rowSize = rowHeight + rowGap;
  if (!rowHeight || !virtualizationState.ready || !els.cards) {
    return {
      startIndex: 0,
      endIndex: Math.min(total, MAX_RENDERED_ITEMS),
    };
  }

  const containerRect = els.cards.getBoundingClientRect();
  const containerTop = window.scrollY + containerRect.top;
  const viewportTop = window.scrollY;
  const viewportBottom = viewportTop + window.innerHeight;
  const relTop = Math.max(0, viewportTop - containerTop);
  const relBottom = Math.max(0, viewportBottom - containerTop);
  const startRow = Math.floor(relTop / rowSize);
  const endRow = Math.ceil(relBottom / rowSize);
  const totalRows = Math.ceil(total / columns);
  const overscan = Math.max(VIRTUAL_OVERSCAN_ROWS, Math.ceil(MAX_RENDERED_ITEMS / columns / 2));
  const safeStartRow = Math.max(0, startRow - overscan);
  const safeEndRow = Math.min(totalRows, endRow + overscan);
  let startIndex = safeStartRow * columns;
  let endIndex = safeEndRow * columns;
  startIndex = Math.max(0, Math.min(startIndex, total));
  endIndex = Math.max(startIndex, Math.min(endIndex, total));
  const minVisible = Math.min(total, MAX_RENDERED_ITEMS);
  if (endIndex - startIndex < minVisible) {
    endIndex = Math.min(total, startIndex + minVisible);
  }
  return { startIndex, endIndex };
}

function updateVirtualWindow(force = false) {
  if (!virtualizationState.ready) return;
  const { startIndex, endIndex } = computeVirtualRange();
  if (
    force ||
    startIndex !== virtualizationState.startIndex ||
    endIndex !== virtualizationState.endIndex
  ) {
    drawSlice(startIndex, endIndex);
  } else {
    applyVirtualPadding(startIndex, endIndex);
  }
}

function renderVirtualizedCards({ force = false } = {}) {
  if (!els.cards) return;
  const total = filteredInstances.length;
  if (!total) {
    virtualizationState.ready = false;
    INSTANCE_VIEW.virtualization.ready = false;
    virtualizationState.startIndex = 0;
    virtualizationState.endIndex = 0;
    INSTANCE_VIEW.virtualization.startIndex = 0;
    INSTANCE_VIEW.virtualization.endIndex = 0;
    els.cards.style.paddingTop = '';
    els.cards.style.paddingBottom = '';
    const message = allInstances.length
      ? 'Nenhuma instância corresponde aos filtros aplicados.'
      : 'Nenhuma instância cadastrada ainda. Clique em “+ Nova instância”.';
    els.cards.innerHTML = `<div class="p-4 bg-white rounded-2xl shadow text-sm text-slate-500">${message}</div>`;
    return;
  }

  if (total <= MAX_RENDERED_ITEMS) {
    virtualizationState.ready = false;
    INSTANCE_VIEW.virtualization.ready = false;
    drawSlice(0, total);
    els.cards.style.paddingTop = '';
    els.cards.style.paddingBottom = '';
    return;
  }

  if (force || !virtualizationState.ready) {
    virtualizationState.ready = false;
    INSTANCE_VIEW.virtualization.ready = false;
    drawSlice(0, Math.min(total, MAX_RENDERED_ITEMS));
    scheduleMeasurement();
    return;
  }

  updateVirtualWindow(force);
}

function applyFiltersAndRender({ keepSelection = true } = {}) {
  filteredInstances = applyFiltersList();
  updateInstanceCounter();
  renderVirtualizedCards({ force: true });
  if (keepSelection) {
    const currentSelected = els.selInstance?.value;
    if (currentSelected) {
      setSelectedInstanceActionsDisabled(currentSelected, isInstanceLocked(currentSelected));
    }
  }
}

function updateFilterState(key, value) {
  if (INSTANCE_FILTERS[key] === value) return;
  INSTANCE_FILTERS[key] = value;
  applyFiltersAndRender({ keepSelection: true });
}

function ensureFilterHandlers() {
  if (filterHandlersBound) return;
  filterHandlersBound = true;
  if (els.instanceSearch) {
    els.instanceSearch.value = INSTANCE_FILTERS.search || '';
    let debounceId = null;
    els.instanceSearch.addEventListener('input', () => {
      const value = els.instanceSearch.value;
      if (debounceId) clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        updateFilterState('search', value);
      }, 180);
    });
  }
  if (els.instanceFilterState) {
    els.instanceFilterState.value = INSTANCE_FILTERS.status || 'all';
    els.instanceFilterState.addEventListener('change', () => {
      updateFilterState('status', els.instanceFilterState.value);
    });
  }
  if (els.instanceSort) {
    els.instanceSort.value = INSTANCE_FILTERS.sort || 'name';
    els.instanceSort.addEventListener('change', () => {
      updateFilterState('sort', els.instanceSort.value);
    });
  }

  window.addEventListener('scroll', () => {
    if (!virtualizationState.ready) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      updateVirtualWindow();
    });
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      virtualizationState.ready = false;
      INSTANCE_VIEW.virtualization.ready = false;
      renderVirtualizedCards({ force: true });
    });
  });
}

export async function refreshInstances(options = {}) {
  const { silent = false, withSkeleton, skipSelected = false, partial } = options;

  if (Array.isArray(partial)) {
    ensureFilterHandlers();
    updateInstanceCache(partial, { replace: false });
    const previousSelected = els.selInstance?.value || '';
    updateInstanceSelect(previousSelected);
    const meta = updateInstanceMeta();
    hasLoadedInstances = true;
    applyFiltersAndRender({ keepSelection: true });
    return { changed: meta.listChanged, selectedChanged: meta.selectedChanged };
  }

  if (refreshInstancesInFlight) return refreshInstancesInFlight;
  const shouldShowSkeleton = withSkeleton ?? (!hasLoadedInstances && !silent);
  if (shouldShowSkeleton || !hasLoadedInstances) setCardsLoading(true);

  refreshInstancesInFlight = (async () => {
    let result = { changed: false, selectedChanged: false };
    try {
      const data = await fetchJSON('/instances', true);
      updateInstanceLocksFromSnapshot(data);
      ensureFilterHandlers();

      const hadLoadedBefore = hasLoadedInstances;
      const previousSelected = els.selInstance?.value || '';

      updateInstanceCache(data, { replace: true });
      updateInstanceSelect(previousSelected);
      const meta = updateInstanceMeta();
      hasLoadedInstances = true;

      if (!Array.isArray(data) || !data.length) {
        applyFiltersAndRender({ keepSelection: false });
        resetNotes();
        resetChart();
        resetLogs();
        toggleHidden(els.qrImg, true);
        setQrState('idle', 'Selecione uma instância para visualizar o QR.');
        setBadgeState('info', 'Crie uma instância para começar', 4000);
        result = { changed: meta.listChanged || meta.selectedChanged, selectedChanged: meta.selectedChanged };
        return result;
      }

      applyFiltersAndRender({ keepSelection: true });

      const selectedChanged = meta.selectedChanged;
      if (!skipSelected && (selectedChanged || !hadLoadedBefore)) {
        await refreshSelected({ silent, withSkeleton: !silent });
      }

      result = { changed: meta.listChanged || selectedChanged, selectedChanged };
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
