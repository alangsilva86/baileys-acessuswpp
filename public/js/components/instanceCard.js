import { STATUS_CODES, STATUS_META } from '../constants.js';

const INSTANCE_ACTIONS = ['save', 'select', 'qr', 'logout', 'wipe', 'delete'];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatStatusCards(counts = {}) {
  return STATUS_CODES.map((code) => {
    const meta = STATUS_META[code] || {};
    const titleAttr = meta.description ? ` title="${escapeHtml(meta.description)}"` : '';
    const label = escapeHtml(meta.name || `Status ${code}`);
    const value = Number(counts[code]) || 0;
    return `
      <div class="rounded-lg bg-slate-50 p-2"${titleAttr}>
        <span class="block text-[11px] uppercase tracking-wide text-slate-400">Status ${code} • ${label}</span>
        <span class="text-sm font-semibold ${meta.textClass || 'text-slate-600'}">${value}</span>
      </div>`;
  }).join('');
}

function resolveMeterColor(usagePercent) {
  if (usagePercent >= 90) return 'bg-rose-400';
  if (usagePercent >= 70) return 'bg-amber-400';
  return 'bg-emerald-400';
}

function setButtonsDisabled(card, disabled) {
  INSTANCE_ACTIONS.forEach((act) => {
    const btn = card.querySelector(`[data-act="${act}"]`);
    if (!btn) return;
    btn.disabled = Boolean(disabled);
    btn.classList.toggle('pointer-events-none', Boolean(disabled));
    btn.classList.toggle('opacity-60', Boolean(disabled));
  });
}

export function renderInstanceCard(instance, options = {}) {
  const {
    connection = {},
    selected = false,
    locked = false,
    statusCounts = {},
    sent = 0,
    usagePercent = 0,
    userId = '—',
    noteValue = '',
    handlers = {},
  } = options;

  const {
    onSelect,
    onSave,
    onQr,
    onLogout,
    onWipe,
    onDelete,
  } = handlers;

  const fragment = document.createDocumentFragment();
  const card = document.createElement('article');
  card.className = 'p-4 bg-white rounded-2xl shadow transition ring-emerald-200/50 space-y-3';
  card.dataset.component = 'instance-card';
  card.dataset.iid = instance?.id || '';
  card.dataset.selected = selected ? 'true' : 'false';
  card.dataset.locked = locked ? 'true' : 'false';

  if (selected) card.classList.add('ring-2', 'ring-emerald-200');
  if (locked) card.classList.add('opacity-75');

  const statusLabel = typeof connection.meta?.cardLabel === 'function'
    ? connection.meta.cardLabel(connection.updatedText)
    : connection.meta?.label || 'Desconhecido';
  const badgeClass = connection.meta?.badgeClass || 'bg-slate-100 text-slate-700';
  const safeName = escapeHtml(instance?.name ?? '');
  const safeStatus = escapeHtml(statusLabel);
  const safeUser = escapeHtml(userId || '—');
  const usage = Number.isFinite(usagePercent) ? usagePercent : 0;
  const meterColor = resolveMeterColor(usage);

  card.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div class="flex-1">
        <label class="text-xs font-medium text-slate-500">Nome</label>
        <input data-field="name" class="mt-1 w-full border rounded-lg px-2 py-1 text-sm" value="${safeName}" />
      </div>
      <span class="px-2 py-0.5 rounded text-xs ${badgeClass}">
        ${safeStatus}
      </span>
    </div>

    <div class="text-xs text-slate-500 break-all">WhatsApp: ${safeUser}</div>

    <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
      <div class="rounded-lg bg-slate-50 p-2">
        <span class="block text-[11px] uppercase tracking-wide text-slate-400">Enviadas</span>
        <span class="text-sm font-semibold text-slate-700">${Number(sent) || 0}</span>
      </div>
      ${formatStatusCards(statusCounts)}
      <div class="col-span-2 md:col-span-3 space-y-1">
        <div class="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
          <span>Uso do limite</span>
          <span>${usage}%</span>
        </div>
        <div class="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full ${meterColor}" style="width:${Math.min(Math.max(usage, 0), 100)}%"></div>
        </div>
        <div class="text-[11px] text-slate-400">Status 1: ${statusCounts['1'] || 0} • Status 2: ${statusCounts['2'] || 0} • Status 3: ${statusCounts['3'] || 0} • Status 4: ${statusCounts['4'] || 0} • Status 5: ${statusCounts['5'] || 0}</div>
      </div>
    </div>

    <div>
      <label class="text-xs font-medium text-slate-500">Notas</label>
      <textarea data-field="note" rows="3" class="mt-1 w-full border rounded-lg px-2 py-1 text-sm"></textarea>
    </div>

    <div class="flex items-center justify-end gap-2 flex-wrap">
      <button data-act="save" class="px-3 py-1.5 text-sm bg-sky-600 hover:bg-sky-700 text-white rounded-lg">Salvar</button>
      <button data-act="select" class="px-3 py-1.5 text-sm border rounded-lg">Selecionar</button>
      <button data-act="qr" class="px-3 py-1.5 text-sm border rounded-lg">Ver QR</button>
      <button data-act="logout" class="px-3 py-1.5 text-sm border rounded-lg">Logout</button>
      <button data-act="wipe" class="px-3 py-1.5 text-sm border rounded-lg">Wipe</button>
      <button data-act="delete" class="px-3 py-1.5 text-sm bg-rose-500 hover:bg-rose-600 text-white rounded-lg">Excluir</button>
    </div>
  `;

  const nameInput = card.querySelector('[data-field="name"]');
  const noteInput = card.querySelector('[data-field="note"]');
  if (nameInput) nameInput.value = instance?.name ?? '';
  if (noteInput) noteInput.value = noteValue ?? '';

  if (locked) setButtonsDisabled(card, true);

  const contextFactory = (event, button) => ({
    event,
    button,
    card,
    name: nameInput?.value ?? '',
    note: noteInput?.value ?? '',
  });

  function bindAction(selector, handler) {
    const button = card.querySelector(selector);
    if (!button || typeof handler !== 'function') return;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler(instance, contextFactory(event, button));
    });
  }

  bindAction('[data-act="select"]', onSelect);
  bindAction('[data-act="qr"]', onQr);
  bindAction('[data-act="logout"]', onLogout);
  bindAction('[data-act="wipe"]', onWipe);
  bindAction('[data-act="delete"]', onDelete);
  bindAction('[data-act="save"]', (inst, ctx) => {
    if (typeof onSave !== 'function') return;
    const payload = { ...ctx, name: ctx.name.trim(), note: ctx.note.trim() };
    onSave(inst, payload);
  });

  fragment.appendChild(card);
  return fragment;
}
