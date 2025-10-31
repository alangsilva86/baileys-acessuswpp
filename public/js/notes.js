import { fetchJSON, requireKey } from './api.js';
import {
  els,
  NOTE_STATE,
  formatDateTime,
  formatRelativeTime,
  toggleHidden,
} from './state.js';

const NOTE_STATUS_VARIANTS = {
  synced: { text: 'Notas sincronizadas', className: 'text-emerald-600' },
  saving: { text: 'Salvando…', className: 'text-slate-500' },
  needsKey: { text: 'Informe a API Key para salvar automaticamente.', className: 'text-amber-600' },
  error: { text: 'Erro ao salvar notas', className: 'text-rose-600' },
};

const NOTE_AUTOSAVE_DEBOUNCE = 800;

let revisionControlsInitialized = false;
let revisionSelect = null;
let revisionInfo = null;
let revisionRestoreButton = null;

function truncate(text, max = 120) {
  if (!text) return '';
  const value = String(text).trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

function ensureRevisionControls() {
  if (revisionControlsInitialized) return;
  if (!els.noteCard) return;
  const container = els.noteCard.querySelector('.space-y-2');
  if (!container) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'flex flex-col gap-1 text-[11px] text-slate-500';

  const row = document.createElement('div');
  row.className = 'flex flex-wrap items-center gap-2';

  const label = document.createElement('span');
  label.className = 'uppercase font-semibold tracking-wide text-sky-700';
  label.textContent = 'Histórico';

  const select = document.createElement('select');
  select.className = 'flex-1 min-w-[10rem] border rounded-lg px-2 py-1 text-xs';
  select.addEventListener('change', () => {
    NOTE_STATE.selectedRevision = select.value;
    updateRevisionInfo();
  });

  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className =
    'text-sky-600 hover:underline disabled:text-slate-400 disabled:hover:no-underline';
  restoreBtn.textContent = 'Restaurar';
  restoreBtn.addEventListener('click', () => {
    void restoreSelectedRevision();
  });

  const info = document.createElement('div');
  info.className = 'text-[11px] text-slate-500 min-h-[1rem]';

  row.append(label, select, restoreBtn);
  wrapper.append(row, info);
  container.prepend(wrapper);

  revisionControlsInitialized = true;
  revisionSelect = select;
  revisionInfo = info;
  revisionRestoreButton = restoreBtn;
  renderRevisionOptions();
}

function buildRevisionLabel(revision) {
  if (!revision || typeof revision !== 'object') return '';
  const absolute = formatDateTime(revision.timestamp) || revision.timestamp || '—';
  const relative = formatRelativeTime(revision.timestamp);
  const author = revision.author ? ` • ${revision.author}` : '';
  return `${absolute}${relative ? ` (${relative})` : ''}${author}`;
}

function getSortedRevisions() {
  if (!Array.isArray(NOTE_STATE.revisions)) return [];
  return [...NOTE_STATE.revisions].sort((a, b) => {
    const aTs = new Date(a.timestamp).getTime();
    const bTs = new Date(b.timestamp).getTime();
    return Number.isNaN(bTs) ? -1 : Number.isNaN(aTs) ? 1 : bTs - aTs;
  });
}

function renderRevisionOptions() {
  if (!revisionSelect) return;
  const revisions = getSortedRevisions();
  const currentSelection = NOTE_STATE.selectedRevision || 'current';
  revisionSelect.textContent = '';
  const currentOption = document.createElement('option');
  currentOption.value = 'current';
  currentOption.textContent = 'Versão atual';
  revisionSelect.appendChild(currentOption);
  revisions.forEach((revision) => {
    const option = document.createElement('option');
    option.value = revision.timestamp;
    option.textContent = buildRevisionLabel(revision);
    revisionSelect.appendChild(option);
  });
  const hasSelection = revisions.some((revision) => revision.timestamp === currentSelection);
  const nextSelection = hasSelection ? currentSelection : 'current';
  revisionSelect.value = nextSelection;
  NOTE_STATE.selectedRevision = nextSelection;
  updateRevisionInfo();
}

function updateRevisionInfo() {
  if (!revisionSelect || !revisionInfo || !revisionRestoreButton) return;
  const isBusy = NOTE_STATE.saving || NOTE_STATE.restoring;
  revisionSelect.disabled = isBusy && revisionSelect.value !== 'current';
  const selected = NOTE_STATE.selectedRevision || 'current';
  if (selected === 'current') {
    const relative = formatRelativeTime(NOTE_STATE.updatedAt);
    const absolute = formatDateTime(NOTE_STATE.updatedAt);
    const pieces = [];
    if (absolute) pieces.push(absolute);
    if (relative) pieces.push(relative);
    revisionInfo.textContent = pieces.length
      ? `Versão atual • ${pieces.join(' • ')}`
      : 'Versão atual';
    revisionRestoreButton.disabled = true;
    return;
  }
  const revision = getSortedRevisions().find((rev) => rev.timestamp === selected);
  if (!revision) {
    revisionSelect.value = 'current';
    NOTE_STATE.selectedRevision = 'current';
    updateRevisionInfo();
    return;
  }
  const absolute = formatDateTime(revision.timestamp) || revision.timestamp;
  const relative = formatRelativeTime(revision.timestamp);
  const author = revision.author || 'desconhecido';
  const summary = truncate(revision.diff?.summary || revision.diff?.after || '');
  const parts = [`${absolute}${relative ? ` (${relative})` : ''}`, `por ${author}`];
  if (summary) parts.push(summary);
  revisionInfo.textContent = parts.join(' • ');
  revisionRestoreButton.disabled = isBusy;
}

async function restoreSelectedRevision() {
  if (!els.selInstance?.value) return;
  const selected = NOTE_STATE.selectedRevision;
  if (!selected || selected === 'current') return;
  const revision = getSortedRevisions().find((rev) => rev.timestamp === selected);
  if (!revision) return;
  try {
    requireKey();
  } catch (err) {
    setNoteStatus('needsKey');
    return;
  }

  NOTE_STATE.restoring = true;
  setNoteStatus('saving', 'Restaurando versão…');
  updateRevisionInfo();
  resetTimer();
  try {
    const payload = await fetchJSON('/instances/' + els.selInstance.value, true, {
      method: 'PATCH',
      body: JSON.stringify({ note: revision.diff?.after ?? '', restoreFrom: revision.timestamp }),
    });
    applyInstanceNote(payload);
    setNoteStatus('synced', 'Versão restaurada');
  } catch (err) {
    console.error('[notes] erro ao restaurar revisão', err);
    setNoteStatus('error', err.message || 'Falha ao restaurar versão');
  } finally {
    NOTE_STATE.restoring = false;
    updateRevisionInfo();
  }
}

export function setNoteStatus(state, extra = '') {
  if (!els.noteStatus) return;
  const variant = NOTE_STATUS_VARIANTS[state] || { text: '', className: 'text-slate-500' };
  const baseText = variant.text || '';
  const text = extra ? (baseText ? `${baseText} — ${extra}` : extra) : baseText;
  els.noteStatus.textContent = text;
  els.noteStatus.className = 'text-[11px] ' + (variant.className || 'text-slate-500');
  if (state === 'error' || state === 'needsKey') {
    toggleHidden(els.noteRetry, false);
  } else {
    toggleHidden(els.noteRetry, true);
  }
}

export function updateNoteMetaText() {
  if (!els.noteMeta) return;
  const created = formatDateTime(NOTE_STATE.createdAt);
  const updated = formatDateTime(NOTE_STATE.updatedAt);
  const relative = formatRelativeTime(NOTE_STATE.updatedAt);
  const parts = [];
  if (created) parts.push(`Criado: ${created}`);
  if (updated) parts.push(`Atualizado: ${updated}${relative ? ` (${relative})` : ''}`);
  els.noteMeta.textContent = parts.join(' • ');
}

function resetTimer() {
  if (NOTE_STATE.timer) {
    clearTimeout(NOTE_STATE.timer);
    NOTE_STATE.timer = null;
  }
}

async function runNoteAutosave() {
  if (!els.selInstance?.value) return;
  resetTimer();
  const key = els.inpApiKey?.value?.trim();
  if (!key) {
    setNoteStatus('needsKey');
    return;
  }
  NOTE_STATE.saving = true;
  updateRevisionInfo();
  try {
    const payload = await fetchJSON('/instances/' + els.selInstance.value, true, {
      method: 'PATCH',
      body: JSON.stringify({ note: NOTE_STATE.pending }),
    });
    applyInstanceNote(payload);
  } catch (err) {
    console.error('[notes] erro ao salvar notas', err);
    setNoteStatus('error', err.message || 'Falha inesperada');
  } finally {
    NOTE_STATE.saving = false;
    updateRevisionInfo();
  }
}

function scheduleNoteAutosave(immediate = false) {
  if (!els.instanceNote || !els.selInstance?.value) return;
  const value = els.instanceNote.value;
  NOTE_STATE.pending = value;
  NOTE_STATE.selectedRevision = 'current';
  if (revisionSelect) {
    revisionSelect.value = 'current';
  }
  updateRevisionInfo();
  if (value.trim() === NOTE_STATE.lastSaved.trim()) {
    setNoteStatus('synced');
    return;
  }
  setNoteStatus('saving');
  resetTimer();
  NOTE_STATE.timer = setTimeout(runNoteAutosave, immediate ? 0 : NOTE_AUTOSAVE_DEBOUNCE);
}

export function applyInstanceNote(instance) {
  if (!els.noteCard) return;
  ensureRevisionControls();
  els.noteCard.classList.remove('hidden');
  const noteVal = instance.note || '';
  els.instanceNote.value = noteVal;
  NOTE_STATE.pending = noteVal;
  NOTE_STATE.lastSaved = noteVal.trim();
  NOTE_STATE.createdAt = instance.metadata?.createdAt || null;
  NOTE_STATE.updatedAt = instance.metadata?.updatedAt || null;
  NOTE_STATE.revisions = Array.isArray(instance.metadata?.revisions)
    ? instance.metadata.revisions
    : instance.revisions && Array.isArray(instance.revisions)
    ? instance.revisions
    : [];
  NOTE_STATE.selectedRevision = 'current';
  NOTE_STATE.restoring = false;
  updateNoteMetaText();
  renderRevisionOptions();
  updateRevisionInfo();
  setNoteStatus('synced');
}

export function resetNotes() {
  if (!els.noteCard) return;
  els.noteCard.classList.add('hidden');
  if (els.instanceNote) {
    els.instanceNote.value = '';
  }
  NOTE_STATE.lastSaved = '';
  NOTE_STATE.pending = '';
  NOTE_STATE.createdAt = null;
  NOTE_STATE.updatedAt = null;
  NOTE_STATE.revisions = [];
  NOTE_STATE.selectedRevision = 'current';
  NOTE_STATE.restoring = false;
  resetTimer();
  updateNoteMetaText();
  renderRevisionOptions();
  updateRevisionInfo();
  setNoteStatus('synced');
}

export function initNotes() {
  if (els.instanceNote) {
    els.instanceNote.addEventListener('input', () => scheduleNoteAutosave());
    els.instanceNote.addEventListener('blur', () => scheduleNoteAutosave(true));
  }
  if (els.noteRetry) {
    els.noteRetry.addEventListener('click', () => scheduleNoteAutosave(true));
  }
  ensureRevisionControls();
  setInterval(() => {
    updateNoteMetaText();
    updateRevisionInfo();
  }, 60000);
  setNoteStatus('synced');
  updateRevisionInfo();
}
