import { requireKey } from './api.js';
import { refreshSelected } from './metrics.js';
import { refreshLogs } from './logs.js';
import {
  els,
  setBadgeState,
  setBusy,
  showError,
  toggleHidden,
  validateE164,
} from './state.js';

const SEND_OUT_CLASSES = {
  success: 'text-emerald-700 bg-emerald-50',
  error: 'text-rose-700 bg-rose-50',
  info: 'text-slate-600 bg-slate-50',
};

const RESULT_TONE_META = {
  success: {
    wrapper: 'border-emerald-200 bg-emerald-50',
    title: 'text-emerald-900',
    text: 'text-emerald-800',
    meta: 'text-emerald-700',
    link: 'text-emerald-800 hover:text-emerald-900',
  },
  error: {
    wrapper: 'border-rose-200 bg-rose-50',
    title: 'text-rose-900',
    text: 'text-rose-800',
    meta: 'text-rose-700',
    link: 'text-rose-800 hover:text-rose-900',
  },
  info: {
    wrapper: 'border-slate-200 bg-slate-50',
    title: 'text-slate-800',
    text: 'text-slate-700',
    meta: 'text-slate-500',
    link: 'text-slate-700 hover:text-slate-900',
  },
};

const QUICK_TYPE_META = {
  text: {
    label: 'Mensagem',
    hint: 'Texto simples enviado como mensagem padrão.',
    requiresMessage: true,
  },
  buttons: {
    label: 'Texto principal',
    hint: 'Conteúdo exibido acima dos botões (obrigatório).',
    requiresMessage: true,
  },
  list: {
    label: 'Descrição',
    hint: 'Texto que acompanha a lista e é exibido para o contato.',
    requiresMessage: true,
  },
  media: {
    label: 'Legenda',
    hint: 'Legenda opcional enviada junto à mídia.',
    requiresMessage: false,
  },
};

const MAX_TEXT_LENGTH = 4096;
const QUICK_RESULT_LIMIT = 5;

let lastFocusedElement = null;

function rememberFocus() {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  lastFocusedElement = active instanceof HTMLElement ? active : null;
}

function restoreFocus() {
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
  }
  lastFocusedElement = null;
}

function getDialogElement(modal) {
  if (!modal) return null;
  return modal.querySelector('[role="dialog"]') || modal;
}

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
}

function focusModal(modal, preferred) {
  const dialog = getDialogElement(modal);
  if (!dialog) return;
  const attemptFocus = () => {
    const focusables = getFocusableElements(dialog);
    const target = preferred && focusables.includes(preferred) ? preferred : focusables[0] || dialog;
    if (target && typeof target.focus === 'function') target.focus();
  };
  setTimeout(attemptFocus, 0);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(attemptFocus);
  }
}

function trapModalFocus(ev, modal) {
  if (ev.key !== 'Tab') return;
  if (!modal || modal.classList.contains('hidden')) return;
  const dialog = getDialogElement(modal);
  if (!dialog) return;
  const focusables = getFocusableElements(dialog);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    ev.preventDefault();
    first.focus();
    return;
  }
  if (ev.shiftKey && (active === first || active === dialog)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
}

function createLabeledInput({ label, role, type = 'text', placeholder = '', initial = '' }) {
  const wrap = document.createElement('div');
  wrap.className = 'space-y-1';
  const lbl = document.createElement('label');
  lbl.className = 'text-xs font-medium text-slate-600';
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.className = 'w-full border rounded-lg px-3 py-2 text-sm';
  if (role) input.dataset.role = role;
  if (placeholder) input.placeholder = placeholder;
  if (initial) input.value = initial;
  wrap.appendChild(lbl);
  wrap.appendChild(input);
  return { wrap, input };
}

function toggleQuickSendModal(open) {
  if (!els.quickSendModal) return;
  const shouldOpen = open === true || (open !== false && els.quickSendModal.classList.contains('hidden'));
  if (shouldOpen) rememberFocus();
  els.quickSendModal.classList[shouldOpen ? 'remove' : 'add']('hidden');
  els.quickSendModal.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
  if (shouldOpen) {
    focusModal(els.quickSendModal, els.inpApiKey || els.inpPhone || els.btnSend);
  } else {
    restoreFocus();
  }
}

function setSendOut(message, tone = 'info') {
  if (!els.sendOut) return;
  els.sendOut.textContent = message;
  const toneClass = SEND_OUT_CLASSES[tone] || SEND_OUT_CLASSES.info;
  els.sendOut.className = 'text-xs rounded p-2 min-h-[2rem] transition-colors ' + toneClass;
}

function updateMsgCounter() {
  if (!els.msgCounter || !els.inpMsg) return;
  const len = els.inpMsg.value.length;
  els.msgCounter.textContent = len;
  if (len > MAX_TEXT_LENGTH) {
    els.msgCounter.classList.add('text-rose-600');
  } else {
    els.msgCounter.classList.remove('text-rose-600');
  }
}

function updateButtonRemoveState() {
  if (!els.quickButtonsList) return;
  const rows = els.quickButtonsList.querySelectorAll('[data-role="button-row"]');
  const shouldDisable = rows.length <= 1;
  rows.forEach((row) => {
    const btn = row.querySelector('[data-act="remove-button"]');
    if (btn) {
      btn.disabled = shouldDisable;
      btn.classList.toggle('opacity-50', shouldDisable);
    }
  });
}

function ensureButtonsMinimum() {
  if (!els.quickButtonsList) return;
  if (!els.quickButtonsList.querySelector('[data-role="button-row"]')) {
    const row = createButtonRow();
    els.quickButtonsList.appendChild(row);
  }
  updateButtonRemoveState();
}

function createButtonRow(initial = {}) {
  const row = document.createElement('div');
  row.className = 'border border-slate-200 rounded-lg p-3 space-y-2';
  row.dataset.role = 'button-row';

  const { wrap: idWrap } = createLabeledInput({
    label: 'ID do botão',
    role: 'button-id',
    initial: initial.id || '',
  });

  const { wrap: titleWrap } = createLabeledInput({
    label: 'Rótulo',
    role: 'button-title',
    initial: initial.title || '',
  });

  const actions = document.createElement('div');
  actions.className = 'flex justify-end';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.dataset.act = 'remove-button';
  removeBtn.className = 'text-xs px-2 py-1 border rounded-lg hover:bg-slate-100';
  removeBtn.textContent = 'Remover';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateButtonRemoveState();
  });
  actions.appendChild(removeBtn);

  row.appendChild(idWrap);
  row.appendChild(titleWrap);
  row.appendChild(actions);

  return row;
}

function handleAddButton() {
  if (!els.quickButtonsList) return;
  if (els.quickButtonsList.querySelectorAll('[data-role="button-row"]').length >= 3) {
    showError('Máximo de 3 botões por mensagem.');
    return;
  }
  const row = createButtonRow();
  els.quickButtonsList.appendChild(row);
  updateButtonRemoveState();
}

function updateOptionRemoveState(sectionEl) {
  if (!sectionEl) return;
  const options = sectionEl.querySelectorAll('[data-role="list-option"]');
  const shouldDisable = options.length <= 1;
  options.forEach((option) => {
    const btn = option.querySelector('[data-act="remove-option"]');
    if (btn) {
      btn.disabled = shouldDisable;
      btn.classList.toggle('opacity-50', shouldDisable);
    }
  });
}

function createListOption(sectionEl, initial = {}) {
  const option = document.createElement('div');
  option.className = 'border border-slate-200 rounded-lg p-3 space-y-2';
  option.dataset.role = 'list-option';

  const { wrap: idWrap } = createLabeledInput({
    label: 'ID da opção',
    role: 'option-id',
    initial: initial.id || '',
  });

  const { wrap: titleWrap } = createLabeledInput({
    label: 'Título',
    role: 'option-title',
    initial: initial.title || '',
  });

  const { wrap: descWrap } = createLabeledInput({
    label: 'Descrição (opcional)',
    role: 'option-description',
    initial: initial.description || '',
  });

  const actions = document.createElement('div');
  actions.className = 'flex justify-end';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.dataset.act = 'remove-option';
  removeBtn.className = 'text-xs px-2 py-1 border rounded-lg hover:bg-slate-100';
  removeBtn.textContent = 'Remover opção';
  removeBtn.addEventListener('click', () => {
    option.remove();
    updateOptionRemoveState(sectionEl);
  });
  actions.appendChild(removeBtn);

  option.appendChild(idWrap);
  option.appendChild(titleWrap);
  option.appendChild(descWrap);
  option.appendChild(actions);

  return option;
}

function createListSection(initial = {}) {
  const section = document.createElement('div');
  section.className = 'border border-slate-200 rounded-lg p-3 space-y-3 bg-white/70';
  section.dataset.role = 'list-section';

  const header = document.createElement('div');
  header.className = 'flex flex-col md:flex-row md:items-end gap-2';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'flex-1 space-y-1';
  const titleLabel = document.createElement('label');
  titleLabel.className = 'text-xs font-medium text-slate-600';
  titleLabel.textContent = 'Título da seção (opcional)';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'w-full border rounded-lg px-3 py-2 text-sm';
  titleInput.dataset.role = 'section-title';
  if (initial.title) titleInput.value = initial.title;
  titleWrap.appendChild(titleLabel);
  titleWrap.appendChild(titleInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.dataset.act = 'remove-section';
  removeBtn.className = 'text-xs px-2 py-1 border rounded-lg hover:bg-slate-100 self-start';
  removeBtn.textContent = 'Remover seção';
  removeBtn.addEventListener('click', () => {
    section.remove();
    updateSectionRemoveState();
  });

  header.appendChild(titleWrap);
  header.appendChild(removeBtn);

  const optionsHeader = document.createElement('div');
  optionsHeader.className = 'flex items-center justify-between text-xs text-slate-500';
  optionsHeader.textContent = 'Opções';

  const addOptionBtn = document.createElement('button');
  addOptionBtn.type = 'button';
  addOptionBtn.dataset.act = 'add-option';
  addOptionBtn.className = 'text-xs px-2 py-1 border rounded-lg hover:bg-slate-100';
  addOptionBtn.textContent = 'Adicionar opção';
  addOptionBtn.addEventListener('click', () => {
    const option = createListOption(section);
    optionsWrap.appendChild(option);
    updateOptionRemoveState(section);
  });
  optionsHeader.appendChild(addOptionBtn);

  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'space-y-2';
  optionsWrap.dataset.role = 'options';

  const initialOptions = Array.isArray(initial.options) && initial.options.length ? initial.options : [{}];
  initialOptions.forEach((opt) => {
    const option = createListOption(section, opt);
    optionsWrap.appendChild(option);
  });
  updateOptionRemoveState(section);

  section.appendChild(header);
  section.appendChild(optionsHeader);
  section.appendChild(optionsWrap);

  return section;
}

function updateSectionRemoveState() {
  if (!els.quickListSections) return;
  const sections = els.quickListSections.querySelectorAll('[data-role="list-section"]');
  const shouldDisable = sections.length <= 1;
  sections.forEach((section) => {
    const btn = section.querySelector('[data-act="remove-section"]');
    if (btn) {
      btn.disabled = shouldDisable;
      btn.classList.toggle('opacity-50', shouldDisable);
    }
  });
}

function ensureListSectionsMinimum() {
  if (!els.quickListSections) return;
  if (!els.quickListSections.querySelector('[data-role="list-section"]')) {
    const section = createListSection();
    els.quickListSections.appendChild(section);
  }
  updateSectionRemoveState();
}

function handleAddSection() {
  if (!els.quickListSections) return;
  const section = createListSection();
  els.quickListSections.appendChild(section);
  updateSectionRemoveState();
}

function formatTime() {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date());
}

function addResultCard({ tone = 'info', title, summary, details = [], links = [] }) {
  if (!els.quickResults) return;
  const meta = RESULT_TONE_META[tone] || RESULT_TONE_META.info;
  const card = document.createElement('div');
  card.className = `rounded-xl border p-3 shadow-sm space-y-2 ${meta.wrapper}`;

  const header = document.createElement('div');
  header.className = 'flex items-baseline justify-between gap-3';
  const titleEl = document.createElement('h3');
  titleEl.className = `text-sm font-semibold ${meta.title}`;
  titleEl.textContent = title || (tone === 'success' ? 'Envio realizado' : tone === 'error' ? 'Falha no envio' : 'Atualização');
  const timeEl = document.createElement('span');
  timeEl.className = `text-[11px] ${meta.meta}`;
  timeEl.textContent = formatTime();
  header.appendChild(titleEl);
  header.appendChild(timeEl);

  const summaryEl = document.createElement('p');
  summaryEl.className = `text-xs md:text-sm ${meta.text}`;
  summaryEl.textContent = summary || '';

  card.appendChild(header);
  card.appendChild(summaryEl);

  if (details.length) {
    const list = document.createElement('dl');
    list.className = 'grid sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] md:text-xs';
    details.forEach((detail) => {
      if (!detail || !detail.value) return;
      const dt = document.createElement('dt');
      dt.className = `${meta.meta} font-medium`;
      dt.textContent = detail.label || '';
      const dd = document.createElement('dd');
      dd.className = meta.text;
      dd.textContent = detail.value;
      list.appendChild(dt);
      list.appendChild(dd);
    });
    if (list.childElementCount) card.appendChild(list);
  }

  if (links.length) {
    const linksWrap = document.createElement('div');
    linksWrap.className = 'flex flex-wrap gap-2';
    links.forEach((link) => {
      if (!link || !link.href || !link.label) return;
      const anchor = document.createElement('a');
      anchor.href = link.href;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      anchor.className = `text-xs md:text-sm font-medium underline underline-offset-2 ${meta.link}`;
      anchor.textContent = link.label;
      linksWrap.appendChild(anchor);
    });
    if (linksWrap.childElementCount) card.appendChild(linksWrap);
  }

  els.quickResults.prepend(card);
  while (els.quickResults.childElementCount > QUICK_RESULT_LIMIT) {
    const last = els.quickResults.lastElementChild;
    if (last) last.remove();
    else break;
  }
}

function getMessageValue() {
  return els.inpMsg ? els.inpMsg.value.trim() : '';
}

function buildTextPayload(message) {
  if (!message) throw new Error('Informe o texto da mensagem.');
  if (message.length > MAX_TEXT_LENGTH) throw new Error('Mensagem excede 4096 caracteres.');
  return { type: 'text', text: message };
}

function buildButtonsPayload(message) {
  if (!message) throw new Error('Informe o texto que acompanhará os botões.');
  if (message.length > MAX_TEXT_LENGTH) throw new Error('Mensagem excede 4096 caracteres.');
  if (!els.quickButtonsList) throw new Error('Configure os botões antes de enviar.');

  const seenIds = new Set();
  const buttons = [];
  const rows = els.quickButtonsList.querySelectorAll('[data-role="button-row"]');
  rows.forEach((row) => {
    const idInput = row.querySelector('[data-role="button-id"]');
    const titleInput = row.querySelector('[data-role="button-title"]');
    const id = idInput ? idInput.value.trim() : '';
    const title = titleInput ? titleInput.value.trim() : '';
    if (!id || !title || seenIds.has(id)) return;
    seenIds.add(id);
    buttons.push({ id, title });
  });

  if (!buttons.length) throw new Error('Adicione pelo menos um botão com ID e rótulo únicos.');

  const footer = els.quickButtonsFooter ? els.quickButtonsFooter.value.trim() : '';

  return {
    type: 'buttons',
    text: message,
    footer: footer || undefined,
    buttons,
  };
}

function buildListPayload(message) {
  if (!message) throw new Error('Informe o texto que introduz a lista.');
  if (message.length > MAX_TEXT_LENGTH) throw new Error('Mensagem excede 4096 caracteres.');
  if (!els.quickListSections) throw new Error('Configure as seções da lista antes de enviar.');

  const sections = [];
  const seenIds = new Set();
  const sectionEls = els.quickListSections.querySelectorAll('[data-role="list-section"]');
  sectionEls.forEach((sectionEl) => {
    const titleInput = sectionEl.querySelector('[data-role="section-title"]');
    const sectionTitle = titleInput ? titleInput.value.trim() : '';
    const optionsWrap = sectionEl.querySelector('[data-role="options"]');
    const optionEls = optionsWrap ? optionsWrap.querySelectorAll('[data-role="list-option"]') : [];
    const options = [];
    optionEls.forEach((optionEl) => {
      const idInput = optionEl.querySelector('[data-role="option-id"]');
      const titleField = optionEl.querySelector('[data-role="option-title"]');
      const descField = optionEl.querySelector('[data-role="option-description"]');
      const id = idInput ? idInput.value.trim() : '';
      const title = titleField ? titleField.value.trim() : '';
      const description = descField ? descField.value.trim() : '';
      if (!id || !title || seenIds.has(id)) return;
      seenIds.add(id);
      const option = { id, title };
      if (description) option.description = description;
      options.push(option);
    });
    if (options.length) {
      const section = { options };
      if (sectionTitle) section.title = sectionTitle;
      sections.push(section);
    }
  });

  if (!sections.length) {
    throw new Error('Inclua pelo menos uma seção com opções válidas (IDs únicos e título).');
  }

  const buttonText = els.quickListButtonText ? els.quickListButtonText.value.trim() : '';
  if (!buttonText) throw new Error('Informe o texto do botão da lista.');

  const footer = els.quickListFooter ? els.quickListFooter.value.trim() : '';
  const title = els.quickListTitle ? els.quickListTitle.value.trim() : '';

  return {
    type: 'list',
    text: message,
    buttonText,
    footer: footer || undefined,
    title: title || undefined,
    sections,
  };
}

function buildMediaPayload(message) {
  if (!els.quickMediaType) throw new Error('Selecione o tipo de mídia.');
  const mediaType = els.quickMediaType.value;
  const allowed = ['image', 'video', 'audio', 'document'];
  if (!allowed.includes(mediaType)) throw new Error('Tipo de mídia inválido.');

  const url = els.quickMediaUrl ? els.quickMediaUrl.value.trim() : '';
  const base64 = els.quickMediaBase64 ? els.quickMediaBase64.value.trim() : '';
  if (!url && !base64) throw new Error('Informe a URL ou o conteúdo Base64 da mídia.');

  const media = {
    url: url || undefined,
    base64: base64 || undefined,
    mimetype: els.quickMediaMime ? els.quickMediaMime.value.trim() || undefined : undefined,
    fileName: els.quickMediaFileName ? els.quickMediaFileName.value.trim() || undefined : undefined,
    ptt: els.quickMediaPtt ? Boolean(els.quickMediaPtt.checked) : undefined,
    gifPlayback: els.quickMediaGif ? Boolean(els.quickMediaGif.checked) : undefined,
  };

  const caption = message && message.length <= MAX_TEXT_LENGTH ? message : message.slice(0, MAX_TEXT_LENGTH);

  return {
    type: 'media',
    mediaType,
    caption: caption || undefined,
    media,
  };
}

function buildRequestPayload(type, message) {
  switch (type) {
    case 'buttons':
      return buildButtonsPayload(message);
    case 'list':
      return buildListPayload(message);
    case 'media':
      return buildMediaPayload(message);
    case 'text':
    default:
      return buildTextPayload(message);
  }
}

function updateTypeUI() {
  const type = els.quickType ? String(els.quickType.value || 'text') : 'text';
  const meta = QUICK_TYPE_META[type] || QUICK_TYPE_META.text;
  if (els.quickMsgLabel) els.quickMsgLabel.textContent = meta.label;
  if (els.quickMsgHint) els.quickMsgHint.textContent = meta.hint;

  toggleHidden(els.quickButtonsFields, type !== 'buttons');
  toggleHidden(els.quickListFields, type !== 'list');
  toggleHidden(els.quickMediaFields, type !== 'media');

  if (type === 'buttons') ensureButtonsMinimum();
  if (type === 'list') ensureListSectionsMinimum();
}

async function handleQuickSend() {
  if (els.inpApiKey) {
    localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
  }

  const iid = els.selInstance?.value;
  if (!iid) {
    setSendOut('Selecione uma instância antes de enviar.', 'error');
    showError('Selecione uma instância.');
    return;
  }

  let key;
  try {
    key = requireKey();
  } catch {
    setSendOut('Informe a chave de API para enviar mensagens.', 'error');
    return;
  }

  const rawPhone = els.inpPhone ? els.inpPhone.value.trim() : '';
  const sanitized = rawPhone.replace(/[^\d+]/g, '');
  const phoneNumber = sanitized.startsWith('+') ? sanitized : '+' + sanitized.replace(/^\++/, '');
  const message = getMessageValue();
  updateMsgCounter();

  if (!validateE164(phoneNumber)) {
    setSendOut('Telefone inválido. Use o formato E.164 (ex: +5511999999999).', 'error');
    return;
  }

  const type = els.quickType ? String(els.quickType.value || 'text') : 'text';
  const meta = QUICK_TYPE_META[type] || QUICK_TYPE_META.text;

  try {
    if (meta.requiresMessage && !message) {
      throw new Error('Informe a mensagem a ser enviada.');
    }
    if (message && message.length > MAX_TEXT_LENGTH) {
      throw new Error('Mensagem excede 4096 caracteres.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Campos inválidos.';
    setSendOut(msg, 'error');
    showError(msg);
    return;
  }

  let payload;
  try {
    payload = buildRequestPayload(type, message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Campos inválidos.';
    setSendOut(msg, 'error');
    showError(msg);
    return;
  }

  const body = JSON.stringify({ ...payload, to: phoneNumber });
  setBusy(els.btnSend, true, 'Enviando…');
  setSendOut('Enviando mensagem…', 'info');

  try {
    const response = await fetch(`/instances/${iid}/send-quick`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body,
    });

    const raw = await response.text().catch(() => '');
    let data;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (err) {
        console.warn('[quickSend] erro ao interpretar resposta', err);
      }
    }
    data = data || {};

    if (!response.ok) {
      const isSocketIssue = response.status === 503 && data?.error === 'socket_unavailable';
      const detail =
        (typeof data.detail === 'string' && data.detail.trim()) ||
        (typeof data.error === 'string' && data.error.trim()) ||
        raw ||
        response.statusText ||
        'Falha desconhecida';

      if (isSocketIssue) {
        const extras = [detail, typeof data.message === 'string' ? data.message.trim() : '']
          .filter(Boolean)
          .join(' — ');
        const msg = extras || 'Conexão com o WhatsApp indisponível. Refaça o pareamento e tente novamente.';
        setSendOut('Instância desconectada: ' + msg, 'error');
        addResultCard({
          tone: 'error',
          title: 'Instância desconectada',
          summary: msg,
          details: [
            { label: 'Instância', value: iid },
            { label: 'Telefone', value: phoneNumber },
          ],
        });
        showError('Instância desconectada. Refaça o pareamento e tente novamente.');
        return;
      }

      setSendOut('Falha no envio: ' + detail, 'error');
      addResultCard({
        tone: 'error',
        title: 'Envio não concluído',
        summary: detail,
        details: [
          { label: 'Instância', value: iid },
          { label: 'Telefone', value: phoneNumber },
          { label: 'Tipo', value: type },
        ],
      });
      showError('Não foi possível enviar a mensagem.');
      return;
    }

    const summary =
      typeof data.summary === 'string' && data.summary.trim()
        ? data.summary.trim()
        : 'Mensagem enviada com sucesso.';

    const details = [];
    if (data.messageId) details.push({ label: 'Message ID', value: data.messageId });
    if (data.type) details.push({ label: 'Tipo', value: data.type });
    if (data.to) details.push({ label: 'Destino', value: data.to });
    if (data.status != null) details.push({ label: 'Status', value: String(data.status) });
    if (data.preview?.text) details.push({ label: 'Prévia', value: String(data.preview.text) });

    const links = Array.isArray(data.links)
      ? data.links
          .map((link) => {
            if (!link || typeof link !== 'object') return null;
            const href = typeof link.href === 'string' ? link.href : '';
            const label = typeof link.label === 'string' ? link.label : link.rel;
            if (!href || typeof label !== 'string' || !label.trim()) return null;
            return { href, label: label.trim() };
          })
          .filter(Boolean)
      : [];

    addResultCard({ tone: 'success', title: 'Envio realizado', summary, details, links });
    setSendOut('Mensagem enviada com sucesso.', 'success');
    setBadgeState('update', 'Mensagem enviada — acompanhe os indicadores.', 3000);
    await refreshSelected({ silent: true });
    await refreshLogs({ silent: true });
  } catch (err) {
    console.error('[quickSend] erro ao enviar mensagem', err);
    const msg = err instanceof Error ? err.message : 'Erro desconhecido.';
    setSendOut('Falha no envio: ' + msg, 'error');
    addResultCard({
      tone: 'error',
      title: 'Erro inesperado',
      summary: msg,
      details: [
        { label: 'Instância', value: iid },
        { label: 'Telefone', value: phoneNumber },
        { label: 'Tipo', value: type },
      ],
    });
    showError('Não foi possível enviar a mensagem.');
  } finally {
    setBusy(els.btnSend, false);
  }
}

export function initQuickSend() {
  if (els.inpMsg) {
    els.inpMsg.addEventListener('input', updateMsgCounter);
    updateMsgCounter();
  }

  if (els.quickButtonsAdd) {
    els.quickButtonsAdd.addEventListener('click', handleAddButton);
  }

  if (els.quickListAddSection) {
    els.quickListAddSection.addEventListener('click', handleAddSection);
  }

  if (els.quickType) {
    els.quickType.addEventListener('change', updateTypeUI);
    updateTypeUI();
  } else {
    ensureButtonsMinimum();
    ensureListSectionsMinimum();
  }

  if (els.btnSend) {
    els.btnSend.addEventListener('click', handleQuickSend);
  }

  if (els.btnOpenQuickSend) {
    els.btnOpenQuickSend.addEventListener('click', () => toggleQuickSendModal(true));
  }
  if (els.btnCloseQuickSend) {
    els.btnCloseQuickSend.addEventListener('click', () => toggleQuickSendModal(false));
  }
  if (els.quickSendModal) {
    els.quickSendModal.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        toggleQuickSendModal(false);
        return;
      }
      if (ev.key === 'Tab') trapModalFocus(ev, els.quickSendModal);
    });
    els.quickSendModal.addEventListener('click', (ev) => {
      if (ev.target === els.quickSendModal) toggleQuickSendModal(false);
    });
  }
}
