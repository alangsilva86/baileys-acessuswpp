import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardInstance, InstanceStats, InstanceStatus } from '../types';
import { fetchJson, formatApiError } from '../../../lib/api';

type ApiInstance = {
  id: string;
  name: string;
  note?: string;
  metadata?: { note?: string | null } | null;
  connectionState?: string | null;
  connectionUpdatedAt?: string | null;
  user?: { id?: string | null } | null;
  network?: {
    status?: string | null;
    blockReason?: string | null;
    ip?: string | null;
    isp?: string | null;
    asn?: string | null;
    proxyUrl?: string | null;
    latencyMs?: number | null;
    lastCheckAt?: number | null;
    validatedAt?: number | null;
  } | null;
  risk?: {
    config?: {
      threshold?: number | null;
      interleaveEvery?: number | null;
      safeContacts?: string[] | null;
    } | null;
    runtime?: {
      ratio?: number | null;
      unknown?: number | null;
      known?: number | null;
      responses?: number | null;
      paused?: boolean | null;
    } | null;
  } | null;
  queue?: {
    enabled?: boolean | null;
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
  if (connectionState === 'qr_timeout') return 'qr_expired';
  return 'disconnected';
}

function buildQueueLabel(queue?: ApiInstance['queue']): string {
  if (!queue) return 'Sem dados';
  if (queue.enabled === false) return 'Desativada (envio direto)';
  if (queue.enabled === true) return 'Ativa (métricas globais)';
  return 'Sem dados';
}

function buildRiskLabel(risk?: ApiInstance['risk']): string {
  if (risk?.runtime?.paused) return 'PAUSADO (risco)';
  const ratio = risk?.runtime?.ratio;
  if (ratio == null || Number.isNaN(Number(ratio))) return 'Sem dados';
  const percent = Math.round(Number(ratio) * 100);
  const unknown = risk?.runtime?.unknown;
  const known = risk?.runtime?.known;
  const responses = risk?.runtime?.responses;
  const extras = [
    Number.isFinite(Number(unknown)) ? `u:${unknown}` : null,
    Number.isFinite(Number(known)) ? `c:${known}` : null,
    Number.isFinite(Number(responses)) ? `r:${responses}` : null,
  ].filter(Boolean);
  return extras.length ? `${percent}% desconhecido • ${extras.join(' ')}` : `${percent}% desconhecido`;
}

function buildNetworkLabel(network?: ApiInstance['network']): string {
  if (!network) return 'Sem dados';
  const status = typeof network.status === 'string' ? network.status.trim().toLowerCase() : '';
  const reason = typeof network.blockReason === 'string' && network.blockReason.trim() ? network.blockReason.trim() : null;
  const latency = network.latencyMs != null ? `${Math.round(network.latencyMs)}ms` : null;

  if (status === 'ok') {
    const parts = [
      'OK',
      latency ? `• ${latency}` : null,
      network.ip ? `• ${network.ip}` : null,
      network.isp || network.asn ? `• ${network.isp || network.asn}` : null,
    ].filter(Boolean);
    return parts.join(' ');
  }

  if (status === 'blocked') return `Bloqueado${reason ? `: ${reason}` : ''}`;
  if (status === 'failed') return `Falha${reason ? `: ${reason}` : ''}`;

  const base = network.isp || network.asn || (network.proxyUrl ? 'Proxy configurado' : null) || 'Sem dados';
  return `${base}${latency ? ` • ${latency}` : ''}`;
}

function buildQrUrl(instanceId: string, apiKey: string): string {
  const encodedId = encodeURIComponent(instanceId);
  if (!apiKey) return `/instances/${encodedId}/qr.png`;
  const params = new URLSearchParams({ apiKey });
  return `/instances/${encodedId}/qr.png?${params.toString()}`;
}

function extractPhoneFromJid(userJid?: string | null): string | null {
  if (!userJid) return null;
  const raw = String(userJid);
  const base = raw.split('@')[0] ?? '';
  const numberPart = base.split(':')[0] ?? base;
  const digits = numberPart.replace(/\D+/g, '');
  return digits.length >= 10 ? digits : null;
}

function mapInstance(inst: ApiInstance, apiKey: string): DashboardInstance {
  const note = typeof inst.note === 'string' ? inst.note : (typeof inst.metadata?.note === 'string' ? inst.metadata.note : '');
  const userJid = inst.user?.id ?? null;
  const userPhone = extractPhoneFromJid(userJid);
  return {
    id: inst.id,
    name: inst.name,
    status: mapStatus(inst.connectionState),
    updatedAt: formatTimestamp(inst.connectionUpdatedAt) ?? undefined,
    qrUrl: buildQrUrl(inst.id, apiKey),
    note,
    userJid,
    userPhone,
    risk: inst.risk as any,
    network: inst.network as any,
    queueEnabled: inst.queue?.enabled ?? undefined,
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
      setInstances(data.map((inst) => mapInstance(inst, apiKey)));
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
