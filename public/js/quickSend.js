import { requireKey } from './api.js';
import { refreshSelected } from './metrics.js';
import { els, setBadgeState, setBusy, showError, validateE164 } from './state.js';

const SEND_OUT_CLASSES = {
  success: 'text-emerald-700 bg-emerald-50',
  error: 'text-rose-700 bg-rose-50',
  info: 'text-slate-600 bg-slate-50',
};

function setSendOut(message, tone = 'info') {
  if (!els.sendOut) return;
  els.sendOut.textContent = message;
  const toneClass = SEND_OUT_CLASSES[tone] || SEND_OUT_CLASSES.info;
  els.sendOut.className = 'text-xs rounded p-2 min-h-[2rem] ' + toneClass;
}

function updateMsgCounter() {
  if (!els.msgCounter || !els.inpMsg) return;
  const len = els.inpMsg.value.length;
  els.msgCounter.textContent = len;
  if (len > 4096) {
    els.msgCounter.classList.add('text-rose-600');
  } else {
    els.msgCounter.classList.remove('text-rose-600');
  }
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
    setSendOut('Informe a API Key para enviar mensagens.', 'error');
    return;
  }

  const rawPhone = els.inpPhone.value.trim();
  const sanitized = rawPhone.replace(/[^\d+]/g, '');
  const phoneNumber = sanitized.startsWith('+') ? sanitized : '+' + sanitized.replace(/^\++/, '');
  const message = els.inpMsg.value.trim();
  updateMsgCounter();

  if (!validateE164(phoneNumber)) {
    setSendOut('Telefone inválido. Use o formato E.164 (ex: +5511999999999).', 'error');
    return;
  }
  if (!message) {
    setSendOut('Informe uma mensagem para enviar.', 'error');
    return;
  }
  if (message.length > 4096) {
    setSendOut('Mensagem excede 4096 caracteres.', 'error');
    return;
  }

  const body = JSON.stringify({ to: phoneNumber, message, waitAckMs: 8000 });
  setBusy(els.btnSend, true, 'Enviando…');
  setSendOut('Enviando mensagem…', 'info');

  try {
    const response = await fetch(`/instances/${iid}/send-text`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let payload;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch (err) {
          console.warn('[quickSend] erro ao interpretar resposta', err);
        }
      }
      if (response.status === 503 && payload?.error === 'socket_unavailable') {
        const details = [payload.detail, payload.message]
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .filter(Boolean);
        const detailMsg = details.join(' — ') || 'Socket indisponível.';
        setSendOut('Instância desconectada: ' + detailMsg, 'error');
        showError('Instância desconectada. Refaça o pareamento e tente novamente.');
        return;
      }
      const bodyMsg = payload?.detail || payload?.error || raw;
      throw new Error('HTTP ' + response.status + (bodyMsg ? ' — ' + bodyMsg : ''));
    }
    const payload = await response.json().catch(() => ({}));
    setSendOut('Sucesso: ' + JSON.stringify(payload), 'success');
    setBadgeState('update', 'Mensagem enviada — acompanhe os indicadores.', 3000);
    await refreshSelected({ silent: true });
  } catch (err) {
    console.error('[quickSend] erro ao enviar mensagem', err);
    setSendOut('Falha no envio: ' + err.message, 'error');
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
  if (els.btnSend) {
    els.btnSend.addEventListener('click', handleQuickSend);
  }
}
