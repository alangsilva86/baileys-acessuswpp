import { fetchJSON, requireKey } from './api.js';
import { handleSaveMetadata, refreshInstances, getInstanceFromCache } from './instances.js';
import { refreshSelected, onInstanceEvent } from './metrics.js';
import {
  els,
  formatDateTime,
  isInstanceLocked,
  lockInstanceActions,
  setBadgeState,
  setBusy,
  setInstanceActionsDisabled,
  setQrState,
  setSelectedInstanceActionsDisabled,
  showError,
  validateE164,
  setActionBarInstance,
} from './state.js';

function currentInstanceId() {
  return els.selInstance?.value || '';
}

function hasCriticalToken(showFeedback = false) {
  const iid = currentInstanceId();
  if (!iid || !els.criticalConfirmInput) return false;
  const token = els.criticalConfirmInput.value.trim();
  const normalized = iid.toLowerCase();
  const ok = Boolean(token && (token.toLowerCase() === normalized || token.toUpperCase() === 'WIPE'));
  if (!ok && showFeedback) {
    showError('Confirme digitando o nome da instância ou “WIPE”.');
  }
  return ok;
}

function syncCriticalButtons() {
  const allow = hasCriticalToken(false);
  const buttons = [els.btnLogout, els.btnWipe, els.btnPair].filter(Boolean);
  buttons.forEach((btn) => {
    btn.disabled = !allow;
    btn.classList.toggle('opacity-50', !allow);
    btn.classList.toggle('cursor-not-allowed', !allow);
  });
}

function handleInstanceOfflineError(err) {
  if (!err || typeof err !== 'object') return false;
  const status = Number(err.status);
  if (!Number.isFinite(status) || status !== 503) return false;
  const body = err.body && typeof err.body === 'object' ? err.body : null;
  if (!body || body.error !== 'instance_offline') return false;

  const state = typeof body.state === 'string' && body.state.trim() ? body.state.trim() : 'desconhecido';
  const updatedAtRaw = typeof body.updatedAt === 'string' ? body.updatedAt : null;
  const updatedAt = updatedAtRaw ? formatDateTime(updatedAtRaw) : '';
  const statusDetails = updatedAt ? `${state} • atualizado em ${updatedAt}` : state;
  const message = `Instância offline (${statusDetails}). Aguarde novo QR ou acione o botão “Wipe”.`;

  console.warn('[session] instância offline', { state, updatedAt: updatedAtRaw });
  setBadgeState('status-disconnected', message, 12000);
  if (els.qrHint) {
    const qrHintDetails = updatedAt ? `${state} • ${updatedAt}` : state;
    els.qrHint.textContent = `Instância offline (${qrHintDetails}). Aguarde novo QR ou use “Wipe”.`;
  }
  return true;
}

function openDeleteModal(iid, name) {
  if (!els.modalDelete) return;
  els.modalDelete.dataset.iid = iid;
  els.modalDelete.dataset.name = name;
  if (els.modalInstanceName) els.modalInstanceName.textContent = name;
  els.modalDelete.classList.remove('hidden');
  els.modalDelete.classList.add('flex');
}

function closeDeleteModal() {
  if (!els.modalDelete) return;
  delete els.modalDelete.dataset.iid;
  delete els.modalDelete.dataset.name;
  els.modalDelete.classList.add('hidden');
  els.modalDelete.classList.remove('flex');
}

function openPairModal(code) {
  if (!els.pairModal) return;
  if (els.pairModalCode) els.pairModalCode.textContent = code || '—';
  els.pairModal.classList.remove('hidden');
  els.pairModal.classList.add('flex');
}

function closePairModal() {
  if (!els.pairModal) return;
  els.pairModal.classList.add('hidden');
  els.pairModal.classList.remove('flex');
}

async function performInstanceAction(action, iid, key, context = {}) {
  const endpoints = {
    logout: `/instances/${iid}/logout`,
    wipe: `/instances/${iid}/session/wipe`,
  };
  const badgeTypes = { logout: 'logout', wipe: 'wipe' };
  const fallbackMessages = {
    logout: (name) => 'Logout solicitado (' + name + ')',
    wipe: (name) => 'Wipe solicitado (' + name + ')',
  };
  const holdTimes = { logout: 5000, wipe: 7000 };
  const restartingMessage = (name) => 'Instância reiniciando (' + name + ')';

  const url = endpoints[action];
  if (!url) return false;

  const button = context.button || null;
  const name = context.name || iid;
  if (button) setBusy(button, true, action === 'logout' ? 'Desconectando…' : 'Limpando…');
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'x-api-key': key } });
    if (action === 'wipe' && response.status === 202) {
      const payload = await response.json().catch(() => ({}));
      const message = payload?.message || restartingMessage(name);
      lockInstanceActions(iid, 'restart');
      setBadgeState('wipe', message, holdTimes[action]);
      await refreshInstances({ silent: true, withSkeleton: false });
      return true;
    }
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      alert('Falha ao executar ' + action + ': HTTP ' + response.status + (txt ? ' — ' + txt : ''));
      setBadgeState('error', 'Falha em ' + action + ' (' + name + ')', 5000);
      return false;
    }
    const payload = await response.json().catch(() => ({}));
    const message = payload?.message || fallbackMessages[action](name);
    setBadgeState(badgeTypes[action], message, holdTimes[action]);
    await refreshInstances({ silent: true, withSkeleton: false });
    return true;
  } catch (err) {
    if (action === 'wipe') {
      console.error('[session] erro em ' + action, err);
      lockInstanceActions(iid, 'restart');
      setBadgeState('wipe', restartingMessage(name), holdTimes[action]);
      setTimeout(() => {
        refreshInstances({ silent: true, withSkeleton: false }).catch(() => undefined);
      }, 1500);
      return true;
    }
    console.error('[session] erro em ' + action, err);
    showError('Erro ao executar ' + action);
    return false;
  } finally {
    if (button) setBusy(button, false);
    if (isInstanceLocked(iid)) {
      setInstanceActionsDisabled(iid, true);
      setSelectedInstanceActionsDisabled(iid, true);
    }
  }
}

function bindModalEvents() {
  if (els.modalDelete) {
    els.modalDelete.addEventListener('click', (ev) => {
      if (ev.target === els.modalDelete) closeDeleteModal();
    });
  }
  if (els.modalCancel) {
    els.modalCancel.addEventListener('click', (ev) => {
      ev.preventDefault();
      closeDeleteModal();
    });
  }
  if (els.modalConfirm) {
    els.modalConfirm.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const iidTarget = els.modalDelete?.dataset.iid;
      if (!iidTarget) {
        closeDeleteModal();
        return;
      }
      let key;
      try {
        key = requireKey();
      } catch {
        return;
      }
      if (els.inpApiKey) {
        localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
      }
      setBusy(els.modalConfirm, true, 'Excluindo…');
      try {
        const response = await fetch(`/instances/${iidTarget}`, {
          method: 'DELETE',
          headers: { 'x-api-key': key },
        });
        if (!response.ok) {
          const txt = await response.text().catch(() => '');
          alert('Falha ao excluir: HTTP ' + response.status + (txt ? ' — ' + txt : ''));
          setBadgeState('error', 'Falha ao excluir ' + iidTarget, 5000);
          return;
        }
        const payload = await response.json().catch(() => ({}));
        const name = els.modalDelete?.dataset.name || iidTarget;
        setBadgeState('delete', payload?.message || 'Instância removida (' + name + ')', 7000);
        closeDeleteModal();
        await refreshInstances({ withSkeleton: true });
      } catch (err) {
        console.error('[session] erro ao excluir instância', err);
        showError('Erro ao excluir instância');
      } finally {
        setBusy(els.modalConfirm, false);
      }
    });
  }
}

function bindPairModal() {
  if (!els.pairModal) return;
  els.pairModal.addEventListener('click', (ev) => {
    if (ev.target === els.pairModal) closePairModal();
  });
  if (els.pairModalClose) els.pairModalClose.addEventListener('click', closePairModal);
  if (els.pairModalCopy) {
    els.pairModalCopy.addEventListener('click', async () => {
      try {
        const code = els.pairModalCode?.textContent?.trim();
        if (!code) return;
        await navigator.clipboard.writeText(code);
        setBadgeState('update', 'Código copiado para a área de transferência.', 3000);
      } catch (err) {
        console.error('[session] erro ao copiar código', err);
        showError('Não foi possível copiar o código.');
      }
    });
  }
}

function bindDocumentShortcuts() {
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (els.modalDelete && !els.modalDelete.classList.contains('hidden')) closeDeleteModal();
    if (els.pairModal && !els.pairModal.classList.contains('hidden')) closePairModal();
  });

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
      return;
    }

    const iid = btn.dataset.iid;
    if (!iid) return;

    if (act === 'select') {
      if (els.selInstance) els.selInstance.value = iid;
      const cached = getInstanceFromCache(iid);
      setActionBarInstance(cached);
      await refreshSelected({ withSkeleton: true });
      return;
    }
    if (act === 'qr') {
      try {
        requireKey();
      } catch {
        return;
      }
      if (els.selInstance) els.selInstance.value = iid;
      const cached = getInstanceFromCache(iid);
      setActionBarInstance(cached);
      await refreshSelected({ withSkeleton: true });
      setBadgeState('info', 'QR atualizado', 3000);
      return;
    }
    if (act === 'delete') {
      const card = btn.closest('article');
      const name = card?.querySelector('[data-field="name"]')?.value?.trim() || iid;
      openDeleteModal(iid, name);
      return;
    }

    let key;
    try {
      key = requireKey();
    } catch {
      return;
    }
    if (els.inpApiKey) {
      localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    }

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
}

function bindNewInstance() {
  if (!els.btnNew) return;
  els.btnNew.addEventListener('click', async () => {
    const rawName = prompt('Nome da nova instância (ex: suporte-goiania)');
    const name = rawName ? rawName.trim() : '';
    if (!name) return;
    try {
      requireKey();
    } catch {
      return;
    }
    if (els.inpApiKey) {
      localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
    }
    setBusy(els.btnNew, true, 'Criando…');
    try {
      const payload = await fetchJSON('/instances', true, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const label = payload?.name || payload?.id || name;
      setBadgeState('update', 'Instância criada (' + label + ')', 4000);
      const newId = payload?.id || null;
      await refreshInstances({ withSkeleton: true });
      if (newId && els.selInstance) {
        els.selInstance.value = newId;
        await refreshSelected({ withSkeleton: true });
      }
    } catch (err) {
      if (err?.status === 409) {
        console.warn('[session] instância já existe', { name });
        showError('Já existe uma instância com esse identificador.');
        setBadgeState('error', 'Instância já cadastrada (' + name + ')', 6000);
        return;
      }
      if (handleInstanceOfflineError(err)) return;
      console.error('[session] erro ao criar instância', err);
      showError('Falha ao criar instância');
      alert('Falha ao criar instância: ' + err.message);
    } finally {
      setBusy(els.btnNew, false);
    }
  });
}

function bindHeaderActions() {
  if (els.btnLogout) {
    els.btnLogout.addEventListener('click', async () => {
      try {
        if (!hasCriticalToken(true)) return;
        if (els.inpApiKey) {
          localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
        }
        const iid = els.selInstance?.value;
        if (!iid) return;
        const key = requireKey();
        const ok = await performInstanceAction('logout', iid, key, { name: iid, button: els.btnLogout });
        if (ok && els.qrHint) els.qrHint.textContent = 'Desconectando… aguarde novo QR.';
      } catch {
      } finally {
        if (els.criticalConfirmInput) {
          els.criticalConfirmInput.value = '';
          syncCriticalButtons();
        }
      }
    });
  }
  if (els.btnWipe) {
    els.btnWipe.addEventListener('click', async () => {
      try {
        if (!hasCriticalToken(true)) return;
        if (els.inpApiKey) {
          localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
        }
        const iid = els.selInstance?.value;
        if (!iid) return;
        const key = requireKey();
        const ok = await performInstanceAction('wipe', iid, key, { name: iid, button: els.btnWipe });
        if (ok && els.qrHint) els.qrHint.textContent = 'Limpando sessão… o serviço reiniciará para gerar novo QR.';
      } catch {
      } finally {
        if (els.criticalConfirmInput) {
          els.criticalConfirmInput.value = '';
          syncCriticalButtons();
        }
      }
    });
  }
  if (els.btnPair) {
    els.btnPair.addEventListener('click', async () => {
      try {
        if (!hasCriticalToken(true)) return;
        const iid = els.selInstance?.value;
        if (!iid) {
          showError('Selecione uma instância.');
          return;
        }
        if (els.inpApiKey) {
          localStorage.setItem('x_api_key', els.inpApiKey.value.trim());
        }
        try {
          requireKey();
        } catch {
          return;
        }
        const phoneInput = prompt('Número no formato E.164 (ex: +5544999999999):');
        if (!phoneInput) return;
        const sanitized = phoneInput.replace(/[^\d+]/g, '');
        const phoneNumber = sanitized.startsWith('+') ? sanitized : '+' + sanitized.replace(/^\++/, '');
        if (!validateE164(phoneNumber)) {
          showError('Telefone inválido. Use o formato E.164 (ex: +5511999999999).');
          return;
        }
        setBusy(els.btnPair, true, 'Gerando…');
        const payload = await fetchJSON(`/instances/${iid}/pair`, true, {
          method: 'POST',
          body: JSON.stringify({ phoneNumber }),
        });
        const code = payload?.pairingCode || '(sem código)';
        openPairModal(code);
        try {
          await navigator.clipboard.writeText(code);
          setBadgeState('update', 'Código gerado e copiado para a área de transferência.', 4000);
        } catch {
          setBadgeState('update', 'Código de pareamento gerado.', 4000);
        }
        setQrState('disconnected', 'Código gerado. Use o pareamento no app.');
      } catch (err) {
        if (handleInstanceOfflineError(err)) return;
        console.error('[session] erro ao gerar código', err);
        showError('Não foi possível gerar o código de pareamento.');
        alert('Falha ao gerar código: ' + err.message);
      } finally {
        setBusy(els.btnPair, false);
        if (els.criticalConfirmInput) {
          els.criticalConfirmInput.value = '';
          syncCriticalButtons();
        }
      }
    });
  }
}

function bindSelectionChange() {
  if (!els.selInstance) return;
  els.selInstance.addEventListener('change', () => {
    if (els.criticalConfirmInput) {
      els.criticalConfirmInput.value = '';
      syncCriticalButtons();
    }
    const current = els.selInstance.value;
    const cached = getInstanceFromCache(current);
    setActionBarInstance(cached);
    refreshSelected({ withSkeleton: true });
  });
}

function initStreamReactions() {
  onInstanceEvent((event) => {
    const selected = els.selInstance?.value;
    if (!selected || event?.instance?.id !== selected) return;
    const reason = event?.reason || event?.type;
    const detail = event?.detail || {};

    if (reason === 'pairing') {
      const attempt = detail?.attempt ? `#${detail.attempt}` : '';
      if (detail?.status === 'ok') {
        setBadgeState('update', `Pareamento solicitado ${attempt || ''}`.trim(), 4000);
      } else if (detail?.status === 'error') {
        const message = detail?.message || 'Falha ao solicitar pareamento';
        setBadgeState('error', `${message}${attempt ? ` (${attempt})` : ''}`, 6000);
      } else {
        setBadgeState('info', `Solicitando pareamento ${attempt || ''}`.trim(), 3000);
      }
    }

    if (reason === 'error' && detail?.message) {
      setBadgeState('error', detail.message, 6000);
    }
  });
}

export function initSessionActions() {
  bindModalEvents();
  bindPairModal();
  bindDocumentShortcuts();
  bindNewInstance();
  bindHeaderActions();
  bindSelectionChange();
  initStreamReactions();
  if (els.criticalConfirmInput) {
    els.criticalConfirmInput.addEventListener('input', () => syncCriticalButtons());
    syncCriticalButtons();
  }
}
