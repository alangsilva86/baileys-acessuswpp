import { fetchJSON } from './api.js';
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
  try {
    const payload = await fetchJSON('/instances/' + els.selInstance.value, true, {
      method: 'PATCH',
      body: JSON.stringify({ note: NOTE_STATE.pending }),
    });
    NOTE_STATE.lastSaved = (NOTE_STATE.pending || '').trim();
    NOTE_STATE.updatedAt = payload?.metadata?.updatedAt || new Date().toISOString();
    NOTE_STATE.createdAt = payload?.metadata?.createdAt || NOTE_STATE.createdAt;
    updateNoteMetaText();
    setNoteStatus('synced');
  } catch (err) {
    console.error('[notes] erro ao salvar notas', err);
    setNoteStatus('error', err.message || 'Falha inesperada');
  } finally {
    NOTE_STATE.saving = false;
  }
}

function scheduleNoteAutosave(immediate = false) {
  if (!els.instanceNote || !els.selInstance?.value) return;
  const value = els.instanceNote.value;
  NOTE_STATE.pending = value;
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
  els.noteCard.classList.remove('hidden');
  const noteVal = instance.note || '';
  els.instanceNote.value = noteVal;
  NOTE_STATE.pending = noteVal;
  NOTE_STATE.lastSaved = noteVal.trim();
  NOTE_STATE.createdAt = instance.metadata?.createdAt || null;
  NOTE_STATE.updatedAt = instance.metadata?.updatedAt || null;
  updateNoteMetaText();
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
  resetTimer();
  updateNoteMetaText();
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
  setInterval(updateNoteMetaText, 60000);
  setNoteStatus('synced');
}
