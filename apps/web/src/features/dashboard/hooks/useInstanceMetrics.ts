import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MetricDatum } from '../types';
import {
  type AggregatedStatusCounts,
  type InstanceMetricCounters,
  type InstanceMetricDelivery,
  type InstanceMetricRate,
  type InstanceMetricsPayload,
  type MetricsRangeSummary,
} from '../types';
import { fetchJson, formatApiError } from '../../../lib/api';
import { getSseToken } from '../../../lib/sseToken';

export type MetricsRangePreset = '30m' | '2h' | '24h' | 'all';

export type MetricsStreamState = 'idle' | 'connecting' | 'connected' | 'error';

type InstanceMetricsSnapshot = {
  counters: InstanceMetricCounters;
  delivery: InstanceMetricDelivery;
  rate: InstanceMetricRate;
  range: InstanceMetricsPayload['range'] | null;
  rangeSummary: MetricsRangeSummary | null;
  lastUpdated: number | null;
};

type UseInstanceMetricsResult = {
  metrics: MetricDatum[] | null;
  snapshot: InstanceMetricsSnapshot | null;
  isLoading: boolean;
  error: string | null;
  streamState: MetricsStreamState;
  streamError: string | null;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
};

function createZeroAggregatedStatus(): AggregatedStatusCounts {
  return {
    pending: 0,
    serverAck: 0,
    delivered: 0,
    read: 0,
    played: 0,
    failed: 0,
  };
}

function aggregateStatusCounts(source?: Record<string, number>): AggregatedStatusCounts {
  const result = createZeroAggregatedStatus();
  if (!source) return result;

  for (const [key, value] of Object.entries(source)) {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) continue;
    const code = Number(key);
    let bucket: keyof AggregatedStatusCounts | null = null;
    if (code === 0) bucket = 'failed';
    else if (code === 1) bucket = 'pending';
    else if (code === 2) bucket = 'serverAck';
    else if (code === 3) bucket = 'delivered';
    else if (code === 4) bucket = 'read';
    else if (code === 5) bucket = 'played';
    else if (code >= 6) bucket = 'failed';
    if (bucket) {
      result[bucket] += count;
    }
  }

  return result;
}

function normalizeCounters(raw?: Partial<InstanceMetricCounters> | null): InstanceMetricCounters {
  const statusCounts = raw?.statusCounts ? { ...raw.statusCounts } : {};
  return {
    sent: Number(raw?.sent ?? 0),
    byType: raw?.byType ? { ...raw.byType } : {},
    statusCounts,
    statusAggregated: aggregateStatusCounts(statusCounts),
    inFlight: Number(raw?.inFlight ?? 0),
  };
}

function buildDeliveryFromCounters(counters: InstanceMetricCounters): InstanceMetricDelivery {
  return {
    ...counters.statusAggregated,
    inFlight: counters.inFlight,
  };
}

function normalizeRate(raw?: InstanceMetricRate | null): InstanceMetricRate {
  return {
    limit: Number(raw?.limit ?? 0),
    windowMs: Number(raw?.windowMs ?? 0),
    inWindow: Number(raw?.inWindow ?? 0),
    usage: Number(raw?.usage ?? 0),
  };
}

function createSnapshotFromPayload(payload: InstanceMetricsPayload): InstanceMetricsSnapshot {
  const counters = normalizeCounters(payload.counters);
  const delivery = payload.delivery ?? buildDeliveryFromCounters(counters);
  const rate = normalizeRate(payload.rate ?? null);
  const range = payload.range ?? null;
  const rangeSummary = range?.summary ?? null;
  const lastUpdated = range?.effective?.to ?? Date.now();
  return {
    counters,
    delivery,
    rate,
    range,
    rangeSummary,
    lastUpdated,
  };
}

function formatRangeHelper(preset: MetricsRangePreset): string {
  if (preset === '2h') return 'Últimas 2h';
  if (preset === '24h') return 'Últimas 24h';
  if (preset === 'all') return 'Desde o início';
  return 'Últimos 30 min';
}

function buildMetricCards(snapshot: InstanceMetricsSnapshot | null, preset: MetricsRangePreset): MetricDatum[] | null {
  if (!snapshot) return null;
  const rangeHelper = formatRangeHelper(preset);
  const sentDelta = snapshot.rangeSummary?.deltas.sent ?? snapshot.counters.sent;
  const deliveredDelta = snapshot.rangeSummary?.deltas.delivered ?? snapshot.delivery.delivered;
  const deliveryRate =
    sentDelta > 0 ? Math.max(0, Math.min(100, Math.round((deliveredDelta / sentDelta) * 100))) : 0;
  const failures = snapshot.rangeSummary?.deltas.failed ?? snapshot.delivery.failed;
  const usagePercent = Number.isFinite(snapshot.rate.usage) ? Math.round(snapshot.rate.usage * 100) : 0;
  const limitPercent = Math.max(0, Math.min(100, usagePercent));
  const windowHelper = snapshot.rate.windowMs ? `Janela ${Math.round(snapshot.rate.windowMs / 1000)}s` : 'Janela atual';
  const inTransit = snapshot.delivery.inFlight ?? snapshot.counters.inFlight;
  const transitTone = inTransit > 0 ? 'warning' : 'neutral';

  return [
    {
      key: 'delivery',
      label: 'Taxa de entrega',
      value: `${deliveryRate}%`,
      helper: rangeHelper,
      tone: 'positive',
    },
    {
      key: 'failures',
      label: 'Falhas',
      value: String(failures),
      helper: rangeHelper,
      tone: failures > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'limit',
      label: 'Uso do limite',
      value: `${limitPercent}%`,
      helper: windowHelper,
      tone: limitPercent >= 80 ? 'warning' : 'neutral',
    },
    {
      key: 'transit',
      label: 'Mensagens em transito',
      value: String(inTransit),
      helper: 'Agora',
      tone: transitTone,
    },
  ];
}

function resolveRangeQuery(preset: MetricsRangePreset): { from?: number; to?: number } {
  if (preset === 'all') return {};
  const now = Date.now();
  const durationMs =
    preset === '30m' ? 30 * 60 * 1000
    : preset === '2h' ? 2 * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;
  return { from: now - durationMs, to: now };
}

export default function useInstanceMetrics(
  instanceId: string | null,
  apiKey: string,
  preset: MetricsRangePreset = '30m',
): UseInstanceMetricsResult {
  const [snapshot, setSnapshot] = useState<InstanceMetricsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<MetricsStreamState>('idle');
  const [streamError, setStreamError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!instanceId || !apiKey) {
      setSnapshot(null);
      return;
    }
    if (!silent) setIsLoading(true);
    if (!silent) setError(null);
    try {
      const qs = new URLSearchParams();
      const range = resolveRangeQuery(preset);
      if (range.from != null) qs.set('from', String(range.from));
      if (range.to != null) qs.set('to', String(range.to));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const payload = await fetchJson<InstanceMetricsPayload>(
        `/instances/${encodeURIComponent(instanceId)}/metrics${suffix}`,
        apiKey,
      );
      setSnapshot(createSnapshotFromPayload(payload));
    } catch (err) {
      if (!silent) {
        setError(formatApiError(err));
      }
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [apiKey, instanceId, preset]);

  useEffect(() => {
    if (!instanceId || !apiKey) {
      setSnapshot(null);
      setError(null);
      setIsLoading(false);
      setStreamState('idle');
      setStreamError(null);
      return;
    }
    void fetchMetrics();
  }, [fetchMetrics, instanceId, apiKey]);

  useEffect(() => {
    if (!instanceId || !apiKey) {
      return undefined;
    }
    if (typeof EventSource === 'undefined') {
      return undefined;
    }
    let cancelled = false;
    let source: EventSource | null = null;
    setStreamState('connecting');
    setStreamError(null);

    const handleInstanceEvent = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data);
        if (!parsed?.instance || parsed.instance.id !== instanceId) return;
        const counters = normalizeCounters(parsed.instance.counters);
        const delivery = buildDeliveryFromCounters(counters);
        const rate = normalizeRate(parsed.instance.rate ?? null);
        setSnapshot((previous) => ({
          counters,
          delivery,
          rate,
          range: previous?.range ?? null,
          rangeSummary: previous?.rangeSummary ?? null,
          lastUpdated: Date.now(),
        }));
        setStreamError(null);
      } catch (err) {
        console.warn('useInstanceMetrics failed to parse event', err);
      }
    };

    (async () => {
      const token = await getSseToken(apiKey).catch(() => null);
      if (cancelled) return;
      if (!token) {
        setStreamState('error');
        setStreamError('Tempo real indisponível. Usando atualização periódica.');
        return;
      }

      const params = new URLSearchParams({ iid: instanceId, sseToken: token });
      source = new EventSource(`/instances/events?${params.toString()}`);

      source.addEventListener('instance', handleInstanceEvent);
      source.onerror = () => {
        setStreamState('error');
        setStreamError('Tempo real indisponível. Usando atualização periódica.');
      };
      source.onopen = () => {
        setStreamState('connected');
        setStreamError(null);
      };
    })();

    return () => {
      cancelled = true;
      if (source) {
        source.removeEventListener('instance', handleInstanceEvent);
        source.close();
      }
    };
  }, [apiKey, instanceId]);

  useEffect(() => {
    if (!instanceId || !apiKey) return undefined;
    if (streamState === 'connected') return undefined;
    const id = window.setInterval(() => {
      void fetchMetrics({ silent: true });
    }, 10_000);
    return () => window.clearInterval(id);
  }, [apiKey, fetchMetrics, instanceId, streamState]);

  const metrics = useMemo(() => buildMetricCards(snapshot, preset), [preset, snapshot]);

  return {
    metrics,
    snapshot,
    isLoading,
    error,
    streamState,
    streamError,
    lastUpdated: snapshot?.lastUpdated ?? null,
    refresh: () => fetchMetrics({ silent: false }),
  };
}
