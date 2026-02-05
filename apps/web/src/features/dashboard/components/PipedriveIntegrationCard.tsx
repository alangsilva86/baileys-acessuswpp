import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link2, BadgeCheck, BadgeAlert, Loader2 } from 'lucide-react';
import { fetchJson, formatApiError } from '../../../lib/api';
import type { ToastTone } from './ToastStack';

type NotifyFn = (message: string, tone?: ToastTone, title?: string) => void;

type PipedriveChannelRecord = {
  id: string;
  provider_channel_id: string;
  name: string;
  provider_type: string;
  template_support: boolean;
  avatar_url: string | null;
  company_id: number | null;
  api_domain: string | null;
  created_at: string;
  updated_at: string;
};

type PipedriveChannelsResponse = { success: true; data: PipedriveChannelRecord[] };

type RegisterChannelResponse = { success: true; data: PipedriveChannelRecord; warning?: unknown };

type UnregisterChannelResponse = {
  success: true;
  data: {
    provider_channel_id: string;
    removed: boolean;
    remote_deleted: boolean;
    purged: boolean;
  };
  warning?: unknown;
};

type PipedriveIntegrationCardProps = {
  instanceId: string;
  instanceName: string;
  isConnected: boolean;
  apiKey: string;
  onNotify?: NotifyFn;
};

function formatTimestamp(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function summarizeWarning(warning: unknown): string | null {
  if (!warning) return null;
  if (typeof warning === 'string') return warning;
  if (typeof warning === 'object') {
    const record = warning as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (record.classification && typeof record.classification === 'object') {
      const cls = record.classification as Record<string, unknown>;
      if (typeof cls.type === 'string' && cls.type.trim()) return cls.type;
    }
  }
  return 'warning';
}

export default function PipedriveIntegrationCard({
  instanceId,
  instanceName,
  isConnected,
  apiKey,
  onNotify,
}: PipedriveIntegrationCardProps) {
  const [channel, setChannel] = useState<PipedriveChannelRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiKey.trim()) {
      setChannel(null);
      setError('Informe a API key para ver o status do Pipedrive.');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const payload = await fetchJson<PipedriveChannelsResponse>('/pipedrive/admin/channels', apiKey);
      const match = payload.data.find((item) => item.provider_channel_id === instanceId) ?? null;
      setChannel(match);
    } catch (err) {
      setError(formatApiError(err));
      setChannel(null);
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isActive = Boolean(channel);
  const isFallback = Boolean(channel?.id?.startsWith('fallback:'));

  const statusBadge = useMemo(() => {
    if (!isActive) return { label: 'Inativo', tone: 'bg-slate-100 text-slate-700', icon: null as any };
    if (isFallback) {
      return {
        label: 'Ativo (Notes)',
        tone: 'bg-amber-100 text-amber-800',
        icon: <BadgeAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />,
      };
    }
    return {
      label: 'Ativo (Channels)',
      tone: 'bg-emerald-100 text-emerald-800',
      icon: <BadgeCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />,
    };
  }, [isActive, isFallback]);

  const selectValue = isActive ? 'active' : 'inactive';
  const disableEnable = (!isConnected && !isActive) || !apiKey.trim() || isMutating;

  const registerChannel = useCallback(async () => {
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para vincular ao Pipedrive.', 'error');
      return;
    }
    setIsMutating(true);
    setError(null);
    try {
      const payload = await fetchJson<RegisterChannelResponse>('/pipedrive/admin/register-channel', apiKey, {
        method: 'POST',
        body: JSON.stringify({
          providerChannelId: instanceId,
          name: instanceName?.trim() ? `WhatsApp - ${instanceName.trim()}` : `WhatsApp - ${instanceId}`,
        }),
      });
      setChannel(payload.data);
      const warningText = summarizeWarning(payload.warning);
      if (warningText) {
        onNotify?.(`Vinculado com aviso: ${warningText}`, 'info', 'Pipedrive');
      } else {
        onNotify?.('Instância vinculada ao Pipedrive.', 'success', 'Pipedrive');
      }
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      onNotify?.(msg, 'error', 'Falha ao vincular');
    } finally {
      setIsMutating(false);
    }
  }, [apiKey, instanceId, instanceName, onNotify]);

  const unregisterChannel = useCallback(async () => {
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para desvincular do Pipedrive.', 'error');
      return;
    }
    setIsMutating(true);
    setError(null);
    try {
      const payload = await fetchJson<UnregisterChannelResponse>('/pipedrive/admin/unregister-channel', apiKey, {
        method: 'POST',
        body: JSON.stringify({
          providerChannelId: instanceId,
          deleteRemote: true,
        }),
      });
      setChannel(null);
      const warningText = summarizeWarning(payload.warning);
      if (warningText) {
        onNotify?.(`Desvinculado localmente (aviso: ${warningText}).`, 'info', 'Pipedrive');
      } else {
        onNotify?.('Instância desvinculada do Pipedrive.', 'success', 'Pipedrive');
      }
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      onNotify?.(msg, 'error', 'Falha ao desvincular');
    } finally {
      setIsMutating(false);
    }
  }, [apiKey, instanceId, onNotify]);

  const handleToggle = useCallback(async (nextValue: string) => {
    if (nextValue === 'active') {
      if (channel) return;
      if (!isConnected) {
        onNotify?.('Conecte a instância antes de ativar no Pipedrive.', 'info', 'Pipedrive');
        return;
      }
      await registerChannel();
      return;
    }
    if (nextValue === 'inactive') {
      if (!channel) return;
      await unregisterChannel();
    }
  }, [channel, isConnected, onNotify, registerChannel, unregisterChannel]);

  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <p className="text-sm font-semibold text-slate-900">Pipedrive</p>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusBadge.tone}`}>
              {statusBadge.icon}
              {statusBadge.label}
            </span>
          </div>
          <p className="text-xs text-slate-500">Vincule esta instância ao canal (ou fallback via Notes) do Pipedrive.</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isLoading || isMutating || !apiKey.trim()}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? 'Atualizando...' : 'Atualizar'}
        </button>
      </div>

      <div className="mt-4 grid gap-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <label className="text-xs font-semibold text-slate-600">Ativo no Pipedrive</label>
            <div className="mt-1 text-[11px] text-slate-400">
              {isConnected ? 'A instância está conectada.' : 'Conecte a instância para ativar.'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectValue}
              onChange={(event) => void handleToggle(event.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-60 md:w-44"
              disabled={!apiKey.trim() || isMutating}
            >
              <option value="inactive">Inativo</option>
              <option value="active" disabled={disableEnable}>Ativo</option>
            </select>
            {isMutating ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" /> : null}
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        ) : null}

        {channel ? (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-semibold text-slate-700">Canal:</span> {channel.name} •{' '}
                <span className="font-mono">{channel.provider_channel_id}</span>
              </span>
              <span className="text-slate-400">Atualizado {formatTimestamp(channel.updated_at)}</span>
            </div>
            {isFallback ? (
              <div className="mt-1 text-amber-700">
                Channels indisponível — usando fallback via Notes/Persons (API v1/v2).
                <div className="mt-1 text-amber-700/80">
                  Neste modo, as mensagens aparecem como Notes na Pessoa (People → Person → Notes), não em Leads → Messaging.
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
            Nenhum canal vinculado a esta instância.
          </div>
        )}
      </div>
    </section>
  );
}
