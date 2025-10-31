(function (global) {
  const metricsCache = new Map();

  function buildCacheKey(iid, range) {
    const safeIid = typeof iid === 'string' ? iid.trim() : '';
    const rangeKey = Number.isFinite(range) ? range : Number(range) || 'default';
    return `${safeIid}::${rangeKey}`;
  }

  async function defaultFetcher(path, options) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${text ? ` — ${text}` : ''}`);
    }
    try {
      return await response.json();
    } catch (err) {
      console.warn('[metrics] falha ao interpretar JSON', err);
      return {};
    }
  }

  function summarizeLogPayload(event) {
    if (!event || typeof event !== 'object') return '';
    const payload = event.payload || {};

    if (event.type === 'WEBHOOK_DELIVERY') {
      const state = payload.state ? `estado: ${payload.state}` : '';
      const attempt = Number(payload.attempt) || 0;
      const attemptLabel = attempt ? `tentativa ${attempt}` : '';
      const status = payload.status != null ? `HTTP ${payload.status}` : '';
      return [payload.event || 'Webhook', state, attemptLabel, status].filter(Boolean).join(' • ');
    }

    const message = payload.message || {};
    if (typeof message.text === 'string' && message.text.trim()) {
      return message.text.trim().slice(0, 140);
    }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim().slice(0, 140);
    }
    if (message.media?.caption) {
      return String(message.media.caption).slice(0, 140);
    }
    if (message.interactive?.type) {
      return `Interativo: ${message.interactive.type}`;
    }

    return '';
  }

  function escapeCsv(value) {
    if (value == null) return '';
    const str = String(value);
    if (!/[";\n,]/.test(str)) return str;
    return '"' + str.replace(/"/g, '""') + '"';
  }

  function toCsvRow(values) {
    return values.map(escapeCsv).join(';');
  }

  function buildTimelineCsv(timeline = []) {
    const header = toCsvRow(['iso', 'sent', 'pending', 'serverAck', 'delivered', 'read', 'played', 'failed', 'rateInWindow']);
    const rows = timeline.map((entry) =>
      toCsvRow([
        entry.iso || '',
        entry.sent ?? 0,
        entry.pending ?? 0,
        entry.serverAck ?? 0,
        entry.delivered ?? 0,
        entry.read ?? 0,
        entry.played ?? 0,
        entry.failed ?? 0,
        entry.rateInWindow ?? 0,
      ]),
    );
    return [header, ...rows].join('\n');
  }

  function buildLogsCsv(events = []) {
    const header = toCsvRow(['id', 'direction', 'type', 'createdAt', 'acknowledged', 'summary']);
    const rows = events.map((event) =>
      toCsvRow([
        event.id || '',
        event.direction || '',
        event.type || '',
        event.createdAt || '',
        event.acknowledged ? 'sim' : 'não',
        summarizeLogPayload(event),
      ]),
    );
    return [header, ...rows].join('\n');
  }

  function buildMetricsJSON(bundle = {}) {
    const payload = {
      exportedAt: new Date().toISOString(),
      rangeMinutes: Number.isFinite(bundle.range) ? Number(bundle.range) : null,
      metrics: bundle.metrics || {},
      logs: bundle.logs || {},
    };
    return JSON.stringify(payload, null, 2);
  }

  function buildMetricsCSV(bundle = {}) {
    const timeline = Array.isArray(bundle.metrics?.timeline) ? bundle.metrics.timeline : [];
    const events = Array.isArray(bundle.logs?.events) ? bundle.logs.events : [];
    const lines = [];
    const range = Number.isFinite(bundle.range) ? Number(bundle.range) : null;
    lines.push(`Resumo;${bundle.metrics?.service || ''};${range != null ? `${range} minutos` : ''}`);
    lines.push('');
    lines.push('Timeline');
    lines.push(buildTimelineCsv(timeline));
    lines.push('');
    lines.push('Eventos recentes');
    lines.push(buildLogsCsv(events));
    return lines.join('\n');
  }

  async function loadMetrics(iid, options = {}) {
    if (!iid) throw new Error('iid_required');
    const { range, fetcher = defaultFetcher, force = false } = options;
    const key = buildCacheKey(iid, range);
    const cached = metricsCache.get(key);
    if (cached && cached.data && !force) {
      return cached.data;
    }

    if (cached && cached.promise && !force) {
      return cached.promise;
    }

    const fetchFn = typeof fetcher === 'function' ? fetcher : defaultFetcher;
    const params = new URLSearchParams({ limit: '20' });

    const combined = Promise.all([
      fetchFn(`/instances/${iid}/metrics`, options.fetcherOptions || {}),
      fetchFn(`/instances/${iid}/logs?${params.toString()}`, options.fetcherOptions || {}),
    ])
      .then(([metrics, logs]) => {
        const payload = {
          iid,
          range: Number.isFinite(range) ? Number(range) : range,
          fetchedAt: Date.now(),
          metrics: metrics || {},
          logs: logs || {},
        };
        metricsCache.set(key, { data: payload });
        return payload;
      })
      .catch((err) => {
        metricsCache.delete(key);
        throw err;
      });

    metricsCache.set(key, { promise: combined });
    return combined;
  }

  function getCachedMetrics(iid, range) {
    const key = buildCacheKey(iid, range);
    const cached = metricsCache.get(key);
    return cached?.data || null;
  }

  global.MetricsAPI = {
    loadMetrics,
    buildMetricsJSON,
    buildMetricsCSV,
    getCachedMetrics,
  };
})(window);
