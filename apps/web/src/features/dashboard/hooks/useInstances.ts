import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardInstance, InstanceStats, InstanceStatus } from '../types';
import { fetchJson, formatApiError } from '../../../lib/api';

type ApiInstance = {
  id: string;
  name: string;
  connectionState?: string | null;
  connectionUpdatedAt?: string | null;
  network?: {
    isp?: string | null;
    asn?: string | null;
    proxyUrl?: string | null;
    latencyMs?: number | null;
  } | null;
  risk?: {
    runtime?: {
      ratio?: number | null;
    } | null;
  } | null;
  queue?: {
    enabled?: boolean | null;
    status?: string | null;
    paused?: boolean | null;
    waiting?: number | null;
    active?: number | null;
    count?: number | null;
    activeCount?: number | null;
    metrics?: {
      waiting?: number | null;
      active?: number | null;
    } | null;
  } | null;
};

function formatTimestamp(value?: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function mapStatus(connectionState?: string | null): InstanceStatus {
  if (connectionState === 'open') return 'connected';
  if (connectionState === 'connecting') return 'connecting';
  return 'disconnected';
}

function buildQueueLabel(queue?: ApiInstance['queue']): string {
  if (!queue) return 'Sem dados';
  if (queue.paused) return 'Fila pausada';
  if (queue.enabled === false || queue.status === 'disabled') return 'Fila direta';
  const waiting = queue.waiting ?? queue.metrics?.waiting ?? queue.count ?? 0;
  const active = queue.active ?? queue.metrics?.active ?? queue.activeCount ?? 0;
  return `${waiting} pend. / ${active} exec.`;
}

function buildRiskLabel(risk?: ApiInstance['risk']): string {
  const ratio = risk?.runtime?.ratio;
  if (ratio == null || Number.isNaN(Number(ratio))) return 'Sem dados';
  const percent = Math.round(Number(ratio) * 100);
  return `${percent}% desconhecido`;
}

function buildNetworkLabel(network?: ApiInstance['network']): string {
  if (!network) return 'Sem dados';
  const base = network.isp || network.asn || network.proxyUrl || 'Sem dados';
  const latency = network.latencyMs != null ? ` • ${network.latencyMs}ms` : '';
  return `${base}${latency}`;
}

function mapInstance(inst: ApiInstance): DashboardInstance {
  return {
    id: inst.id,
    name: inst.name,
    status: mapStatus(inst.connectionState),
    updatedAt: formatTimestamp(inst.connectionUpdatedAt) ?? undefined,
    qrUrl: `/instances/${inst.id}/qr.png`,
    health: {
      network: buildNetworkLabel(inst.network ?? undefined),
      risk: buildRiskLabel(inst.risk ?? undefined),
      queue: buildQueueLabel(inst.queue ?? undefined),
    },
  };
}

export type UseInstancesResult = {
  instances: DashboardInstance[];
  isLoading: boolean;
  stats: InstanceStats;
  error: string | null;
  actions: {
    refreshInstances: () => Promise<void>;
    createInstance: (name?: string) => Promise<void>;
    deleteInstance: (id: string) => Promise<void>;
  };
};

export default function useInstances(apiKey: string): UseInstancesResult {
  const [instances, setInstances] = useState<DashboardInstance[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshInstances = useCallback(async () => {
    if (!apiKey) {
      setInstances([]);
      setError('Informe a API key para carregar instancias.');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchJson<ApiInstance[]>('/instances', apiKey);
      setInstances(data.map(mapInstance));
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  const createInstance = useCallback(async (name?: string) => {
    if (!apiKey) {
      setError('Informe a API key para criar instancias.');
      return;
    }
    setError(null);
    try {
      const payload = { name: name?.trim() || undefined };
      await fetchJson('/instances', apiKey, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await refreshInstances();
    } catch (err) {
      setError(formatApiError(err));
      throw err;
    }
  }, [apiKey, refreshInstances]);

  const deleteInstance = useCallback(async (id: string) => {
    if (!apiKey) {
      setError('Informe a API key para excluir instancias.');
      return;
    }
    setError(null);
    try {
      await fetchJson(`/instances/${encodeURIComponent(id)}`, apiKey, {
        method: 'DELETE',
      });
      await refreshInstances();
    } catch (err) {
      setError(formatApiError(err));
      throw err;
    }
  }, [apiKey, refreshInstances]);

  useEffect(() => {
    if (!apiKey) {
      setInstances([]);
      return;
    }
    void refreshInstances();
  }, [apiKey, refreshInstances]);

  const stats = useMemo<InstanceStats>(() => {
    const connected = instances.filter((instance) => instance.status === 'connected').length;
    const connecting = instances.filter((instance) => instance.status === 'connecting').length;
    const issues = instances.filter((instance) => instance.status === 'disconnected' || instance.status === 'qr_expired').length;
    return {
      total: instances.length,
      connected,
      connecting,
      issues,
    };
  }, [instances]);

  return {
    instances,
    isLoading,
    stats,
    error,
    actions: {
      refreshInstances,
      createInstance,
      deleteInstance,
    },
  };
}
