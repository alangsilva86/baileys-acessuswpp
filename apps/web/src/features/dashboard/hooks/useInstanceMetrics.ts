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

type InstanceMetricsSnapshot = {
  counters: InstanceMetricCounters;
  delivery: InstanceMetricDelivery;
  rate: InstanceMetricRate;
  rangeSummary: MetricsRangeSummary | null;
  lastUpdated: number | null;
};

type UseInstanceMetricsResult = {
  metrics: MetricDatum[] | null;
  isLoading: boolean;
  error: string | null;
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
  const rangeSummary = payload.range?.summary ?? null;
  const lastUpdated = payload.range?.effective?.to ?? Date.now();
  return {
    counters,
    delivery,
    rate,
    rangeSummary,
    lastUpdated,
  };
}

function buildMetricCards(snapshot: InstanceMetricsSnapshot | null): MetricDatum[] | null {
  if (!snapshot) return null;
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
      helper: 'Últimos 30 min',
      tone: 'positive',
    },
    {
      key: 'failures',
      label: 'Falhas',
      value: String(failures),
      helper: 'Últimos 30 min',
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

export default function useInstanceMetrics(instanceId: string | null, apiKey: string): UseInstanceMetricsResult {
  const [snapshot, setSnapshot] = useState<InstanceMetricsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    if (!instanceId || !apiKey) {
      setSnapshot(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const payload = await fetchJson<InstanceMetricsPayload>(`/instances/${encodeURIComponent(instanceId)}/metrics`, apiKey);
      setSnapshot(createSnapshotFromPayload(payload));
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, instanceId]);

  useEffect(() => {
    if (!instanceId || !apiKey) {
      setSnapshot(null);
      setError(null);
      setIsLoading(false);
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
    const params = new URLSearchParams({ iid: instanceId, apiKey });
    const source = new EventSource(`/instances/events?${params.toString()}`);

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
          rangeSummary: previous?.rangeSummary ?? null,
          lastUpdated: Date.now(),
        }));
        setError(null);
      } catch (err) {
        console.warn('useInstanceMetrics failed to parse event', err);
      }
    };

    source.addEventListener('instance', handleInstanceEvent);
    source.onerror = () => {
      setError('Não foi possível manter o fluxo de métricas em tempo real.');
    };
    source.onopen = () => {
      setError(null);
    };

    return () => {
      source.removeEventListener('instance', handleInstanceEvent);
      source.close();
    };
  }, [apiKey, instanceId]);

  const metrics = useMemo(() => buildMetricCards(snapshot), [snapshot]);

  return {
    metrics,
    isLoading,
    error,
    lastUpdated: snapshot?.lastUpdated ?? null,
    refresh: fetchMetrics,
  };
}
