(function (global) {
  const registry = new Map();
  const dependencies = {
    fetch: (...args) => global.fetch(...args),
  };

  const ACTION_META = {
    logout: { busyLabel: 'Desconectando…', lock: true, lockReason: 'logout' },
    wipe: { busyLabel: 'Limpando…', lock: true, lockReason: 'wipe' },
    pair: { busyLabel: 'Gerando…', lock: true, lockReason: 'pair' },
  };

  const DEFAULT_PAIR_EXPIRATION_MS = 60_000;

  function setDependencies(next = {}) {
    Object.assign(dependencies, next);
  }

  async function runSessionAction(type, iid, payload = {}) {
    if (!type) throw new Error('sessionAction.missing_type');
    if (!iid) throw new Error('sessionAction.missing_iid');
    const handler = registry.get(type);
    if (!handler) throw new Error('sessionAction.unknown_action:' + type);

    const meta = ACTION_META[type] || {};
    const context = {
      ...dependencies,
      ...payload,
      iid,
      type,
      keepLock: false,
      started: false,
      locked: false,
      async start(options = {}) {
        if (context.started) return;
        context.started = true;
        const busyLabel = options.busyLabel || payload.busyLabel || meta.busyLabel || 'Processando…';
        const submitBusyLabel = options.submitBusyLabel || payload.submitBusyLabel || busyLabel;
        if (payload.button && typeof dependencies.setBusy === 'function') {
          dependencies.setBusy(payload.button, true, busyLabel);
        }
        if (payload.submitButton && payload.submitButton !== payload.button && typeof dependencies.setBusy === 'function') {
          dependencies.setBusy(payload.submitButton, true, submitBusyLabel);
        }
        const shouldLock = options.lock ?? payload.lock ?? meta.lock ?? true;
        if (shouldLock && typeof dependencies.lockInstanceActions === 'function') {
          context.locked = true;
          const reason = options.lockReason || payload.lockReason || meta.lockReason || type;
          dependencies.lockInstanceActions(iid, reason);
        }
      },
      setKeepLock(value) {
        context.keepLock = Boolean(value);
      },
    };

    let result;
    try {
      result = await handler(context);
      if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'keepLock')) {
        context.keepLock = !!result.keepLock;
      }
      return result;
    } finally {
      if (context.started) {
        if (context.locked && !context.keepLock && typeof dependencies.unlockInstanceActions === 'function') {
          dependencies.unlockInstanceActions(iid);
        }
        if (payload.submitButton && payload.submitButton !== payload.button && typeof dependencies.setBusy === 'function') {
          dependencies.setBusy(payload.submitButton, false);
        }
        if (payload.button && typeof dependencies.setBusy === 'function') {
          dependencies.setBusy(payload.button, false);
        }
      }
    }
  }

  registry.set('logout', async (ctx) => {
    const fetchFn = typeof ctx.fetch === 'function' ? ctx.fetch : dependencies.fetch;
    const name = ctx.name || ctx.iid;
    let key;
    try {
      key = typeof ctx.requireKey === 'function' ? ctx.requireKey() : null;
    } catch (err) {
      return { ok: false, error: err };
    }

    await ctx.start({ busyLabel: 'Desconectando…', lockReason: 'logout' });

    try {
      const response = await fetchFn(`/instances/${ctx.iid}/logout`, {
        method: 'POST',
        headers: { 'x-api-key': key },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (typeof ctx.setBadgeState === 'function') {
          ctx.setBadgeState('error', `Falha em logout (${name})`, 5000);
        }
        if (typeof global.alert === 'function') {
          global.alert(`Falha ao executar logout: HTTP ${response.status}${body ? ' — ' + body : ''}`);
        }
        return { ok: false, status: response.status };
      }
      const payload = await response.json().catch(() => ({}));
      const message = payload?.message || `Logout solicitado (${name})`;
      ctx.setBadgeState?.('logout', message, 5000);
      ctx.setQrState?.('loading', { message: 'Desconectando… aguarde novo QR.' });
      await ctx.refreshInstances?.({ silent: true, withSkeleton: false });
      return { ok: true };
    } catch (err) {
      console.error('[sessionActions] logout failed', err);
      ctx.showError?.('Erro ao executar logout');
      return { ok: false, error: err };
    }
  });

  registry.set('wipe', async (ctx) => {
    const fetchFn = typeof ctx.fetch === 'function' ? ctx.fetch : dependencies.fetch;
    const name = ctx.name || ctx.iid;
    let key;
    try {
      key = typeof ctx.requireKey === 'function' ? ctx.requireKey() : null;
    } catch (err) {
      return { ok: false, error: err };
    }

    await ctx.start({ busyLabel: 'Limpando…', lockReason: 'wipe' });

    try {
      const response = await fetchFn(`/instances/${ctx.iid}/session/wipe`, {
        method: 'POST',
        headers: { 'x-api-key': key },
      });
      if (response.status === 202) {
        const payload = await response.json().catch(() => ({}));
        const message = payload?.message || `Instância reiniciando (${name})`;
        ctx.setBadgeState?.('wipe', message, 7000);
        ctx.setQrState?.('loading', { message: 'Reiniciando sessão… aguardando QR.' });
        ctx.setKeepLock(true);
        await ctx.refreshInstances?.({ silent: true, withSkeleton: false });
        return { ok: true, keepLock: true };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        ctx.setBadgeState?.('error', `Falha em wipe (${name})`, 5000);
        if (typeof global.alert === 'function') {
          global.alert(`Falha ao executar wipe: HTTP ${response.status}${body ? ' — ' + body : ''}`);
        }
        return { ok: false, status: response.status };
      }
      const payload = await response.json().catch(() => ({}));
      const message = payload?.message || `Wipe solicitado (${name})`;
      ctx.setBadgeState?.('wipe', message, 7000);
      ctx.setQrState?.('loading', { message: 'Sessão reiniciando… aguardando novo QR.' });
      await ctx.refreshInstances?.({ silent: true, withSkeleton: false });
      return { ok: true };
    } catch (err) {
      console.error('[sessionActions] wipe failed', err);
      ctx.setKeepLock(true);
      ctx.setBadgeState?.('wipe', `Instância reiniciando (${name})`, 7000);
      ctx.setQrState?.('loading', { message: 'Sessão reiniciando… aguardando novo QR.' });
      setTimeout(() => {
        try {
          ctx.refreshInstances?.({ silent: true, withSkeleton: false });
        } catch (refreshErr) {
          console.error('[sessionActions] wipe refresh failed', refreshErr);
        }
      }, 1500);
      return { ok: true, keepLock: true, error: err };
    }
  });

  registry.set('pair', async (ctx) => {
    const input = ctx.phoneInput;
    if (!input) {
      console.warn('[sessionActions] pair invoked without phone input');
      return { ok: false };
    }

    const rawValue = (input.value || '').trim();
    if (!rawValue) {
      ctx.setPairModalError?.('Informe o telefone no formato E.164 (ex: +5511999999999).');
      ctx.setPairModalStatus?.('');
      return { ok: false };
    }

    const sanitized = rawValue.replace(/[^\d+]/g, '');
    const normalized = '+' + sanitized.replace(/^\++/, '');
    if (input.value !== normalized) input.value = normalized;
    const validateE164 = typeof ctx.validateE164 === 'function'
      ? ctx.validateE164
      : (value) => /^\+?[1-9]\d{7,14}$/.test(value);
    if (!validateE164(normalized)) {
      ctx.setPairModalError?.('Telefone inválido. Use o formato E.164 (ex: +5511999999999).');
      ctx.setPairModalStatus?.('');
      return { ok: false };
    }

    ctx.setPairModalError?.('');

    try {
      if (typeof ctx.requireKey === 'function') ctx.requireKey();
    } catch (err) {
      ctx.setPairModalError?.('Informe sua API Key para gerar o código.');
      ctx.setPairModalStatus?.('');
      return { ok: false, error: err };
    }

    const fetchJSON = typeof ctx.fetchJSON === 'function'
      ? ctx.fetchJSON.bind(ctx)
      : null;

    if (!fetchJSON) {
      ctx.setPairModalStatus?.('');
      ctx.setPairModalError?.('Não foi possível gerar o código no momento.');
      return { ok: false };
    }

    ctx.setPairModalStatus?.('Gerando código de pareamento…');
    await ctx.start({ busyLabel: 'Gerando…', submitBusyLabel: 'Gerando…', lockReason: 'pair' });

    try {
      const payload = await fetchJSON(`/instances/${ctx.iid}/pair`, true, {
        method: 'POST',
        body: JSON.stringify({ phoneNumber: normalized }),
      });
      const code = payload?.pairingCode || '(sem código)';
      const expiresIn = Number.isFinite(ctx.pairingExpiresInMs)
        ? Number(ctx.pairingExpiresInMs)
        : DEFAULT_PAIR_EXPIRATION_MS;

      ctx.showPairModalResult?.({ code, expiresInMs: expiresIn });

      try {
        await navigator.clipboard.writeText(code);
        ctx.setBadgeState?.('update', 'Código gerado e copiado para a área de transferência.', 4000);
      } catch (err) {
        ctx.setBadgeState?.('update', 'Código de pareamento gerado.', 4000);
      }

      ctx.setQrState?.('disconnected', {
        message: 'Código gerado. Use o pareamento no app.',
        expiresInMs: expiresIn,
        expireState: 'error',
        expireMessage: 'Código expirado. Gere novamente.',
      });

      return { ok: true };
    } catch (err) {
      console.error('[sessionActions] pair failed', err);
      ctx.setPairModalStatus?.('Falha ao gerar o código. Tente novamente.');
      ctx.setPairModalError?.('Não foi possível gerar o código de pareamento.');
      ctx.showError?.('Não foi possível gerar o código de pareamento.');
      return { ok: false, error: err };
    }
  });

  global.sessionActions = {
    runSessionAction,
    setDependencies,
    register(type, handler) {
      if (typeof type !== 'string' || typeof handler !== 'function') return;
      registry.set(type, handler);
    },
  };
})(window);
