import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  FileJson,
  FileSpreadsheet,
  ListChecks,
  PauseCircle,
  PlayCircle,
  QrCode,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';
import type {
  BrokerEvent,
  DashboardInstance,
  InstanceRiskConfig,
  InstanceRiskSnapshot,
  InstanceStatus,
  MetricDatum,
  MetricTone,
  SendQueueJobSummary,
  SendQueueMetrics,
} from '../types';
import type { ToastTone } from './ToastStack';
import { fetchJson, formatApiError } from '../../../lib/api';
import Modal from './Modal';
import useInstanceMetrics, { type MetricsRangePreset } from '../hooks/useInstanceMetrics';
import useInstanceLogs from '../hooks/useInstanceLogs';
import useQueueFailedJobs from '../hooks/useQueueFailedJobs';
import PipedriveIntegrationCard from './PipedriveIntegrationCard';
import MessageMonitorDrawer from './MessageMonitorDrawer';

type DashboardMainProps = {
  instance?: DashboardInstance | null;
  allInstances?: DashboardInstance[];
  apiKey: string;
  queueMetrics?: SendQueueMetrics | null;
  queueLoading?: boolean;
  queueError?: string | null;
  onRefreshQueue?: () => void;
  onRefresh?: () => void;
  onDeleteInstance?: () => void;
  onNotify?: (message: string, tone?: ToastTone, title?: string) => void;
};

const STATUS_META: Record<InstanceStatus, { label: string; tone: string; icon: ReactNode }> = {
  connected: {
    label: 'Conectado',
    tone: 'bg-emerald-100 text-emerald-700',
    icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />,
  },
  connecting: {
    label: 'Reconectando',
    tone: 'bg-amber-100 text-amber-700',
    icon: <RefreshCw className="h-4 w-4 animate-spin text-amber-500" aria-hidden="true" />,
  },
  disconnected: {
    label: 'Desconectado',
    tone: 'bg-rose-100 text-rose-700',
    icon: <WifiOff className="h-4 w-4 text-rose-500" aria-hidden="true" />,
  },
  qr_expired: {
    label: 'QR expirado',
    tone: 'bg-rose-100 text-rose-700',
    icon: <QrCode className="h-4 w-4 text-rose-500" aria-hidden="true" />,
  },
};

const DEFAULT_METRICS: MetricDatum[] = [
  {
    key: 'delivery',
    label: 'Taxa de entrega',
    value: '0%',
    helper: 'Ultimos 30 min',
    tone: 'positive',
  },
  {
    key: 'failures',
    label: 'Falhas',
    value: '0',
    helper: 'Ultimos 30 min',
    tone: 'warning',
  },
  {
    key: 'limit',
    label: 'Uso do limite',
    value: '0%',
    helper: 'Janela atual',
  },
  {
    key: 'transit',
    label: 'Mensagens em transito',
    value: '0',
    helper: 'Agora',
  },
];

const METRIC_ICONS: Record<string, ReactNode> = {
  delivery: <ShieldCheck className="h-4 w-4 text-emerald-500" aria-hidden="true" />,
  failures: <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />,
  limit: <Activity className="h-4 w-4 text-slate-500" aria-hidden="true" />,
  transit: <Send className="h-4 w-4 text-slate-500" aria-hidden="true" />,
};

export default function DashboardMain({
  instance,
  allInstances = [],
  apiKey,
  queueMetrics,
  queueLoading = false,
  queueError = null,
  onRefreshQueue,
  onRefresh,
  onDeleteInstance,
  onNotify,
}: DashboardMainProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'messages' | 'logs' | 'outbox'>('overview');
  const [metricsPreset, setMetricsPreset] = useState<MetricsRangePreset>('30m');
  const {
    metrics,
    isLoading: metricsLoading,
    error: metricsError,
    refresh: refreshMetrics,
    lastUpdated,
    snapshot: metricsSnapshot,
  } = useInstanceMetrics(instance?.id ?? null, apiKey, metricsPreset);
  const {
    events: logEvents,
    isLoading: logsLoading,
    error: logsError,
    refresh: refreshLogs,
  } = useInstanceLogs(instance?.id ?? null, apiKey, activeTab === 'logs', 80);
  const {
    enabled: failedJobsEnabled,
    jobs: failedJobs,
    isLoading: failedJobsLoading,
    error: failedJobsError,
    refresh: refreshFailedJobs,
  } = useQueueFailedJobs(apiKey, 80, activeTab === 'outbox');
  const [quickSendOpen, setQuickSendOpen] = useState(false);
  const [quickSendPhone, setQuickSendPhone] = useState('');
  const [quickSendMessage, setQuickSendMessage] = useState('');
  const [isQuickSending, setIsQuickSending] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [isRiskSaving, setIsRiskSaving] = useState(false);
  const [riskDraft, setRiskDraft] = useState<InstanceRiskConfig | null>(null);
  const [safeContactsDraft, setSafeContactsDraft] = useState('');
  const [isNotesSaving, setIsNotesSaving] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState('');
  const [isProxySaving, setIsProxySaving] = useState(false);

  const qrSectionRef = useRef<HTMLDivElement>(null);
  const riskSectionRef = useRef<HTMLDivElement>(null);
  const queueSectionRef = useRef<HTMLDivElement>(null);
  const networkSectionRef = useRef<HTMLDivElement>(null);

  const handleRefresh = useCallback(() => {
    onRefresh?.();
    onRefreshQueue?.();
    void refreshMetrics();
  }, [onRefresh, onRefreshQueue, refreshMetrics]);

  const quickSendReady = Boolean(quickSendPhone.trim() && quickSendMessage.trim());
  const quickSendDisabled = isQuickSending || !quickSendReady;

  const handleRetryFailedJob = useCallback(async (jobId: string) => {
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para reprocessar o job.', 'error');
      return;
    }
    setRetryingJobId(jobId);
    try {
      await fetchJson(`/instances/queue/jobs/${encodeURIComponent(jobId)}/retry`, apiKey, { method: 'POST' });
      onNotify?.('Job reenfileirado para reprocessamento.', 'success');
      await refreshFailedJobs();
      onRefreshQueue?.();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao reenfileirar job');
    } finally {
      setRetryingJobId(null);
    }
  }, [apiKey, onNotify, onRefreshQueue, refreshFailedJobs]);

  useEffect(() => {
    if (!instance) {
      setRiskDraft(null);
      setSafeContactsDraft('');
      setNoteDraft('');
      setProxyDraft('');
      return;
    }

    const cfg = instance.risk?.config;
    const safeContacts = Array.isArray(cfg?.safeContacts) ? cfg!.safeContacts : [];
    setRiskDraft({
      threshold: Number(cfg?.threshold ?? 0.7),
      interleaveEvery: Number(cfg?.interleaveEvery ?? 5),
      safeContacts,
    });
    setSafeContactsDraft(safeContacts.join('\n'));
    setNoteDraft(instance.note ?? '');
    setProxyDraft(instance.network?.proxyUrl ?? '');
  }, [instance?.id]);

  const parseSafeContacts = useCallback((value: string): string[] => {
    if (!value.trim()) return [];
    return value
      .split(/[\n,]+/g)
      .map((entry) => entry.trim())
      .map((entry) => entry.replace(/\D+/g, ''))
      .filter(Boolean);
  }, []);

  const handleRiskSave = useCallback(async () => {
    if (!instance || isRiskSaving) return;
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para salvar o risco.', 'error');
      return;
    }

    const threshold = Number(riskDraft?.threshold ?? 0.7);
    const interleaveEvery = Number(riskDraft?.interleaveEvery ?? 5);
    const safeContacts = parseSafeContacts(safeContactsDraft);

    setIsRiskSaving(true);
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}/risk`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ threshold, interleaveEvery, safeContacts }),
      });
      onNotify?.('Configuração de risco atualizada.', 'success');
      handleRefresh();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao salvar risco');
    } finally {
      setIsRiskSaving(false);
    }
  }, [apiKey, handleRefresh, instance, isRiskSaving, onNotify, parseSafeContacts, riskDraft?.interleaveEvery, riskDraft?.threshold, safeContactsDraft]);

  const handleRiskResume = useCallback(async () => {
    if (!instance) return;
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para retomar envios.', 'error');
      return;
    }
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}/risk/resume`, apiKey, { method: 'POST' });
      onNotify?.('Envios retomados para esta instância.', 'success');
      handleRefresh();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao retomar');
    }
  }, [apiKey, handleRefresh, instance, onNotify]);

  const handleRiskPause = useCallback(async () => {
    if (!instance) return;
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para pausar envios.', 'error');
      return;
    }
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}/risk/pause`, apiKey, { method: 'POST' });
      onNotify?.('Envios pausados para esta instância.', 'info');
      handleRefresh();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao pausar');
    }
  }, [apiKey, handleRefresh, instance, onNotify]);

  const handleSendSafePing = useCallback(async () => {
    if (!instance) return;
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para enviar o ping seguro.', 'error');
      return;
    }
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}/risk/send-safe`, apiKey, { method: 'POST' });
      onNotify?.('Ping enviado para o contato seguro.', 'success');
      handleRefresh();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao enviar ping');
    }
  }, [apiKey, handleRefresh, instance, onNotify]);

  const handleNotesSave = useCallback(async () => {
    if (!instance || isNotesSaving) return;
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para salvar notas.', 'error');
      return;
    }
    setIsNotesSaving(true);
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}`, apiKey, {
        method: 'PATCH',
        body: JSON.stringify({ note: noteDraft }),
      });
      onNotify?.('Notas salvas.', 'success');
      handleRefresh();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao salvar notas');
    } finally {
      setIsNotesSaving(false);
    }
  }, [apiKey, handleRefresh, instance, isNotesSaving, noteDraft, onNotify]);

  const handleLogout = useCallback(async () => {
    if (!instance) return;
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para desconectar.', 'error');
      return;
    }
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}/logout`, apiKey, { method: 'POST' });
      onNotify?.('Sessão desconectada. Um novo QR deve aparecer em breve.', 'success');
      handleRefresh();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao desconectar');
    }
  }, [apiKey, handleRefresh, instance, onNotify]);

  const handleProxyRevalidate = useCallback(async () => {
    if (!instance) return;
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para revalidar proxy.', 'error');
      return;
    }
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}/proxy/revalidate`, apiKey, { method: 'POST' });
      onNotify?.('Proxy revalidado.', 'success');
      handleRefresh();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao revalidar proxy');
    }
  }, [apiKey, handleRefresh, instance, onNotify]);

  const handleProxySave = useCallback(async () => {
    if (!instance || isProxySaving) return;
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para salvar proxy.', 'error');
      return;
    }
    const proxyUrl = proxyDraft.trim();
    if (!proxyUrl) {
      onNotify?.('Informe a URL do proxy.', 'error');
      return;
    }
    setIsProxySaving(true);
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}/proxy`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ proxyUrl }),
      });
      onNotify?.('Proxy atualizado.', 'success');
      setProxyModalOpen(false);
      handleRefresh();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao atualizar proxy');
    } finally {
      setIsProxySaving(false);
    }
  }, [apiKey, handleRefresh, instance, isProxySaving, onNotify, proxyDraft]);

  const handleQuickSend = useCallback(async () => {
    if (!instance) return;
    const phone = quickSendPhone.trim();
    const message = quickSendMessage.trim();
    if (!phone || !message) {
      onNotify?.('Informe o telefone e a mensagem.', 'error');
      return;
    }
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para envio rápido.', 'error');
      return;
    }
    setIsQuickSending(true);
    try {
      await fetchJson(`/instances/${encodeURIComponent(instance.id)}/send-quick`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ type: 'text', to: phone, text: message }),
      });
      onNotify?.('Mensagem enviada com sucesso.', 'success');
      setQuickSendPhone('');
      setQuickSendMessage('');
      setQuickSendOpen(false);
      void refreshMetrics();
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Envio rápido falhou');
    } finally {
      setIsQuickSending(false);
    }
  }, [apiKey, instance, onNotify, quickSendMessage, quickSendPhone, refreshMetrics]);

  if (!instance) {
    return (
      <section className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-6 shadow-sm">
          <p className="text-sm font-semibold text-slate-700">Selecione uma instancia</p>
          <p className="text-sm text-slate-500">Escolha uma instancia na barra lateral para ver os detalhes.</p>
        </div>
      </section>
    );
  }

  const meta = STATUS_META[instance.status] ?? STATUS_META.disconnected;
  const isConnected = instance.status === 'connected';
  const metricsCards = metrics ?? DEFAULT_METRICS;
  const formattedMetricsUpdated = lastUpdated
    ? new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(lastUpdated)
    : '—';

  const riskSnapshot = (instance.risk ?? null) as InstanceRiskSnapshot | null;
  const riskPaused = Boolean(riskSnapshot?.runtime?.paused);
  const safeContactsCount = Array.isArray(riskSnapshot?.config?.safeContacts) ? riskSnapshot!.config.safeContacts.length : 0;
  const networkStatus = instance.network?.status ?? 'unknown';
  const hasNetworkIssue = networkStatus === 'blocked' || networkStatus === 'failed';
  const queueFailed = queueMetrics?.enabled ? Number(queueMetrics.failed ?? 0) : 0;
  const hasQueueFailures = queueFailed > 0;

  const ensureOverviewAndScroll = (ref: React.RefObject<HTMLDivElement>) => {
    setActiveTab('overview');
    window.setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const safeSuggestions = allInstances
    .filter((candidate) => candidate.id !== instance.id)
    .filter((candidate) => candidate.status === 'connected')
    .filter((candidate) => Boolean(candidate.userPhone))
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      phone: candidate.userPhone!,
    }));

  const addSafeContact = (phone: string) => {
    setSafeContactsDraft((current) => {
      const existing = new Set(parseSafeContacts(current).map((item) => item.replace(/\D+/g, '')).filter(Boolean));
      const next = phone.replace(/\D+/g, '');
      if (!next) return current;
      if (existing.has(next)) return current;
      return current.trim() ? `${current.trim()}\n${next}` : next;
    });
  };

  const addAllSafeSuggestions = () => {
    safeSuggestions.forEach((entry) => addSafeContact(entry.phone));
  };

  const resolvePresetRange = (preset: MetricsRangePreset): { from?: number; to?: number } => {
    if (preset === 'all') return {};
    const now = Date.now();
    const durationMs =
      preset === '30m' ? 30 * 60 * 1000
      : preset === '2h' ? 2 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;
    return { from: now - durationMs, to: now };
  };

  const exportParams = new URLSearchParams();
  const exportRange = resolvePresetRange(metricsPreset);
  if (exportRange.from != null) exportParams.set('from', String(exportRange.from));
  if (exportRange.to != null) exportParams.set('to', String(exportRange.to));
  const exportQuery = exportParams.toString();

  const exportCsvUrl = `/instances/${encodeURIComponent(instance.id)}/export.csv${exportQuery ? `?${exportQuery}` : ''}`;
  const exportJsonUrl = `/instances/${encodeURIComponent(instance.id)}/export.json${exportQuery ? `?${exportQuery}` : ''}`;

  const formatDateTime = (value: number | null | undefined): string => {
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
  };

  const maskProxyUrl = (value: string | null | undefined): string => {
    if (!value) return '—';
    try {
      const parsed = new URL(value);
      const host = parsed.hostname ? parsed.hostname : 'proxy';
      const port = parsed.port ? `:${parsed.port}` : '';
      return `${parsed.protocol}//${host}${port}`;
    } catch {
      return 'Proxy configurado';
    }
  };

  const parseContentDispositionFilename = (header: string | null): string | null => {
    if (!header) return null;
    const star = /filename\\*=UTF-8''([^;]+)/i.exec(header);
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1].replace(/\"/g, ''));
      } catch {
        return star[1].replace(/\"/g, '');
      }
    }
    const match = /filename=\"?([^\";]+)\"?/i.exec(header);
    return match?.[1] ? match[1] : null;
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  };

  const downloadExport = async (format: 'csv' | 'json') => {
    if (!apiKey.trim()) {
      onNotify?.('Informe a API key para exportar.', 'error');
      return;
    }
    const url = format === 'csv' ? exportCsvUrl : exportJsonUrl;
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: {
          'x-api-key': apiKey.trim(),
        },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let body: unknown = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
        }
        const error = new Error(`HTTP ${response.status}`) as any;
        error.status = response.status;
        error.text = text;
        error.body = body;
        throw error;
      }
      const blob = await response.blob();
      const filename =
        parseContentDispositionFilename(response.headers.get('content-disposition')) ??
        `${instance.id}-metrics.${format}`;
      triggerDownload(blob, filename);
      onNotify?.('Export iniciado.', 'success');
    } catch (err) {
      onNotify?.(formatApiError(err), 'error', 'Falha ao exportar');
    }
  };

  const notesDirty = noteDraft.trim() !== (instance.note ?? '').trim();
  const riskSafeDraftCount = parseSafeContacts(safeContactsDraft).length;
  const riskPercentUnknown = riskSnapshot?.runtime?.ratio != null
    ? Math.max(0, Math.min(100, Math.round(Number(riskSnapshot.runtime.ratio) * 100)))
    : null;

  const riskDirty = (() => {
    const current = riskSnapshot?.config;
    if (!current) return Boolean(riskDraft || safeContactsDraft.trim());
    const nextThreshold = Number(riskDraft?.threshold ?? current.threshold);
    const nextInterleave = Number(riskDraft?.interleaveEvery ?? current.interleaveEvery);
    const nextSafe = parseSafeContacts(safeContactsDraft);
    const currentSafe = Array.isArray(current.safeContacts)
      ? current.safeContacts.map((v) => String(v).replace(/\\D+/g, '')).filter(Boolean)
      : [];
    const sortUnique = (list: string[]) => Array.from(new Set(list)).sort();
    const a = sortUnique(nextSafe);
    const b = sortUnique(currentSafe);
    if (Math.abs(Number(current.threshold) - nextThreshold) > 0.0001) return true;
    if (Number(current.interleaveEvery) !== nextInterleave) return true;
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return true;
    }
    return false;
  })();

  type RecommendedActionItem = {
    key: string;
    title: string;
    description: string;
    icon: ReactNode;
    tone: 'neutral' | 'info' | 'warning' | 'danger';
    actionLabel: string;
    onAction: () => void;
  };

  const recommendedActions: RecommendedActionItem[] = [];
  if (!isConnected) {
    recommendedActions.push({
      key: 'scan_qr',
      title: 'Escanear QR',
      description: 'A instância está offline. Conecte no WhatsApp para liberar envios e eventos.',
      icon: <QrCode className="h-4 w-4 text-slate-600" aria-hidden="true" />,
      tone: 'info',
      actionLabel: 'Ver QR',
      onAction: () => ensureOverviewAndScroll(qrSectionRef),
    });
  }
  if (riskPaused) {
    recommendedActions.push({
      key: 'resume_risk',
      title: 'Retomar envios (risco pausado)',
      description: 'A proteção de risco pausou envios para contatos desconhecidos.',
      icon: <PauseCircle className="h-4 w-4 text-rose-600" aria-hidden="true" />,
      tone: 'danger',
      actionLabel: 'Retomar',
      onAction: () => void handleRiskResume(),
    });
  }
  if (safeContactsCount === 0) {
    recommendedActions.push({
      key: 'safe_contacts',
      title: 'Configurar safe contacts',
      description: 'Adicione números confiáveis para warm-up, testes e interleaving seguro.',
      icon: <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />,
      tone: 'warning',
      actionLabel: 'Configurar',
      onAction: () => ensureOverviewAndScroll(riskSectionRef),
    });
  }
  if (queueMetrics?.enabled && hasQueueFailures) {
    recommendedActions.push({
      key: 'queue_failed',
      title: 'Fila com falhas',
      description: `Existem ${queueFailed} jobs falhos na fila global de envio.`,
      icon: <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />,
      tone: 'warning',
      actionLabel: 'Abrir outbox',
      onAction: () => setActiveTab('outbox'),
    });
  }
  if (hasNetworkIssue) {
    recommendedActions.push({
      key: 'proxy_blocked',
      title: 'Proxy/Rede com problema',
      description: 'A validação de rede indica bloqueio ou falha. Revalide e ajuste o proxy.',
      icon: <WifiOff className="h-4 w-4 text-rose-600" aria-hidden="true" />,
      tone: 'danger',
      actionLabel: 'Revisar',
      onAction: () => ensureOverviewAndScroll(networkSectionRef),
    });
  }

  return (
    <section className="flex h-full flex-col gap-6 px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Instancia selecionada</p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-900">{instance.name}</h1>
            <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${meta.tone}`}>
              {meta.icon}
              {meta.label}
            </span>
            {riskPaused ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-rose-100 px-3 py-1 text-xs font-medium text-rose-700">
                <PauseCircle className="h-4 w-4 text-rose-600" aria-hidden="true" />
                Risco: Pausado
              </span>
            ) : riskPercentUnknown != null ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                <ShieldAlert className="h-4 w-4 text-slate-600" aria-hidden="true" />
                Risco: {riskPercentUnknown}% desconhecido
              </span>
            ) : null}
          </div>
          <p className="text-xs text-slate-500">Atualizado {instance.updatedAt || '—'}</p>
          {instance.userPhone ? (
            <p className="text-[11px] text-slate-400">
              Número: <span className="font-medium text-slate-600">{instance.userPhone}</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Atualizar dados
          </button>
          <button
            type="button"
            onClick={() => setQuickSendOpen(true)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-sm hover:bg-slate-800"
          >
            Envio rapido
          </button>
          <button
            type="button"
            onClick={() => setMonitorOpen(true)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Monitor
          </button>
          <SettingsMenu
            onAdvanced={() => ensureOverviewAndScroll(riskSectionRef)}
            onProxy={() => ensureOverviewAndScroll(networkSectionRef)}
            onLogout={() => void handleLogout()}
            onDelete={onDeleteInstance}
          />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-sm">
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            activeTab === 'overview' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          Visão geral
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('messages')}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            activeTab === 'messages' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          Mensagens
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('logs')}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            activeTab === 'logs' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          Logs & eventos
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('outbox')}
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            activeTab === 'outbox' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          Outbox
        </button>
      </div>

      {activeTab === 'overview' ? (
        <div className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="flex flex-col gap-6">
            <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Ações recomendadas</p>
                  <p className="text-xs text-slate-500">Atalhos para destravar envios e deixar a operação saudável.</p>
                </div>
                <div className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-600">
                  {recommendedActions.length ? `${recommendedActions.length} pendente(s)` : 'Tudo certo'}
                </div>
              </div>

              {recommendedActions.length ? (
                <div className="mt-4 space-y-3">
                  {recommendedActions.map((item) => {
                    const toneStyles =
                      item.tone === 'danger'
                        ? 'border-rose-100 bg-rose-50/60'
                        : item.tone === 'warning'
                        ? 'border-amber-100 bg-amber-50/60'
                        : item.tone === 'info'
                        ? 'border-slate-100 bg-slate-50'
                        : 'border-slate-100 bg-white';
                    return (
                      <div key={item.key} className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${toneStyles}`}>
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-xl bg-white shadow-sm">
                            {item.icon}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                            <p className="text-xs text-slate-600">{item.description}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={item.onAction}
                          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white shadow-sm hover:bg-slate-800"
                        >
                          {item.actionLabel}
                          <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                    Nenhuma ação pendente no momento.
                  </div>
                  <button
                    type="button"
                    onClick={handleRefresh}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    Atualizar
                  </button>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Status rápido</p>
                  <p className="text-xs text-slate-500">Rede, risco e fila em um olhar.</p>
                </div>
                <div className="text-xs text-slate-400">Atualização contínua</div>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <HealthCard
                  label="Rede"
                  value={instance.health.network}
                  icon={<ShieldCheck className="h-4 w-4 text-emerald-500" aria-hidden="true" />}
                />
                <HealthCard
                  label="Risco"
                  value={instance.health.risk}
                  icon={<ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden="true" />}
                />
                <HealthCard
                  label="Fila"
                  value={instance.health.queue}
                  icon={<Activity className="h-4 w-4 text-slate-500" aria-hidden="true" />}
                />
              </div>
            </section>

            <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Métricas</p>
                  <p className="text-xs text-slate-500">Indicadores e export por período.</p>
                  <p className="text-[11px] text-slate-400">
                    {metricsLoading ? 'Atualizando métricas...' : `Última atualização ${formattedMetricsUpdated}`}
                  </p>
                  {metricsError ? <p className="text-[11px] text-rose-600">{metricsError}</p> : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Período</label>
                  <select
                    value={metricsPreset}
                    onChange={(event) => setMetricsPreset(event.target.value as MetricsRangePreset)}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs text-slate-700"
                  >
                    <option value="30m">30 min</option>
                    <option value="2h">2 horas</option>
                    <option value="24h">24 horas</option>
                    <option value="all">Tudo</option>
                  </select>

                  <details className="relative">
                    <summary className="list-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50">
                      <span className="inline-flex items-center gap-2">
                        <Download className="h-4 w-4 text-slate-500" aria-hidden="true" />
                        Exportar
                      </span>
                    </summary>
                    <div className="absolute right-0 z-10 mt-2 w-56 rounded-xl border border-slate-100 bg-white p-2 shadow-lg">
                      <button
                        type="button"
                        onClick={(event) => {
                          (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                          void downloadExport('csv');
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
                      >
                        <span className="inline-flex items-center gap-2">
                          <FileSpreadsheet className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                          Exportar CSV
                        </span>
                        <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                          void downloadExport('json');
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
                      >
                        <span className="inline-flex items-center gap-2">
                          <FileJson className="h-4 w-4 text-slate-600" aria-hidden="true" />
                          Exportar JSON
                        </span>
                        <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
                      </button>
                    </div>
                  </details>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {metricsCards.map((metric) => (
                  <MetricCard
                    key={metric.key}
                    icon={METRIC_ICONS[metric.key] ?? <Activity className="h-4 w-4 text-slate-500" aria-hidden="true" />}
                    {...metric}
                  />
                ))}
              </div>
            </section>

            <section ref={riskSectionRef} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Risco & envios</p>
                  <p className="text-xs text-slate-500">Configure limiar, interleaving e contatos seguros.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {riskPaused ? (
                    <span className="inline-flex items-center gap-2 rounded-full bg-rose-100 px-3 py-1 text-xs font-medium text-rose-700">
                      <PauseCircle className="h-4 w-4 text-rose-600" aria-hidden="true" />
                      Pausado
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                      <PlayCircle className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                      Ativo
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void (riskPaused ? handleRiskResume() : handleRiskPause())}
                    className={`rounded-lg px-3 py-2 text-xs font-medium text-white shadow-sm ${
                      riskPaused ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
                    }`}
                  >
                    {riskPaused ? 'Retomar' : 'Pausar'}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Desconhecidos</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{riskSnapshot?.runtime?.unknown ?? 0}</p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Conhecidos</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{riskSnapshot?.runtime?.known ?? 0}</p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Respostas</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{riskSnapshot?.runtime?.responses ?? 0}</p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">% desconhecido</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{riskPercentUnknown != null ? `${riskPercentUnknown}%` : '—'}</p>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <div className="space-y-3 lg:col-span-1">
                  <label className="block text-xs font-semibold text-slate-600">Threshold (0–1)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={riskDraft?.threshold ?? 0.7}
                    onChange={(event) => setRiskDraft((current) => ({
                      threshold: Number(event.target.value),
                      interleaveEvery: Number(current?.interleaveEvery ?? 5),
                      safeContacts: current?.safeContacts ?? [],
                    }))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  />
                  <p className="text-[11px] text-slate-400">Ex: 0.7 pausa quando desconhecidos passam de ~70%.</p>

                  <label className="block text-xs font-semibold text-slate-600">Interleave a cada</label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={riskDraft?.interleaveEvery ?? 5}
                    onChange={(event) => setRiskDraft((current) => ({
                      threshold: Number(current?.threshold ?? 0.7),
                      interleaveEvery: Math.max(1, Math.floor(Number(event.target.value) || 1)),
                      safeContacts: current?.safeContacts ?? [],
                    }))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  />
                  <p className="text-[11px] text-slate-400">A cada N envios para desconhecidos, envia ping para safe contact.</p>
                </div>

                <div className="space-y-3 lg:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-slate-600">Safe contacts</p>
                      <p className="text-[11px] text-slate-400">Um por linha (E.164). Total: {riskSafeDraftCount}.</p>
                    </div>
                    {safeSuggestions.length ? (
                      <button
                        type="button"
                        onClick={addAllSafeSuggestions}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        Adicionar conectadas
                      </button>
                    ) : null}
                  </div>

                  <textarea
                    rows={5}
                    value={safeContactsDraft}
                    onChange={(event) => setSafeContactsDraft(event.target.value)}
                    placeholder="55DDDNUMERO\n55DDDNUMERO"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  />

                  {safeSuggestions.length ? (
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sugestões</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {safeSuggestions.map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            onClick={() => addSafeContact(entry.phone)}
                            className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
                            title={`Adicionar ${entry.name} (${entry.phone})`}
                          >
                            <ListChecks className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                            {entry.name}: {entry.phone}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[11px] text-slate-500">
                      {riskDirty ? (
                        <span className="inline-flex items-center gap-2">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
                          Alterações não salvas
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                          Configuração em dia
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSendSafePing()}
                        disabled={!safeContactsCount}
                        className={`rounded-lg px-3 py-2 text-xs font-medium ${
                          safeContactsCount
                            ? 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                        }`}
                      >
                        Enviar ping seguro
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRiskSave()}
                        disabled={isRiskSaving || !riskDirty}
                        className={`rounded-lg px-3 py-2 text-xs font-medium text-white shadow-sm ${
                          isRiskSaving || !riskDirty ? 'bg-slate-400 cursor-not-allowed' : 'bg-slate-900 hover:bg-slate-800'
                        }`}
                      >
                        {isRiskSaving ? 'Salvando...' : 'Salvar risco'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section ref={queueSectionRef} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Fila de envios</p>
                  <p className="text-xs text-slate-500">Métricas globais (BullMQ/Redis).</p>
                  {queueError ? <p className="text-[11px] text-rose-600">{queueError}</p> : null}
                </div>
                <button
                  type="button"
                  onClick={onRefreshQueue}
                  disabled={queueLoading}
                  className={`rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 ${
                    queueLoading ? 'opacity-60 cursor-wait' : ''
                  }`}
                >
                  {queueLoading ? 'Atualizando...' : 'Atualizar fila'}
                </button>
              </div>

              {!queueMetrics ? (
                <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
                  Carregando métricas da fila...
                </div>
              ) : queueMetrics.enabled ? (
                <>
                  <div className="mt-4 grid gap-3 md:grid-cols-3 lg:grid-cols-6">
                    <QueueMetric label="Aguardando" value={queueMetrics.waiting ?? 0} tone={queueFailed ? 'warning' : 'neutral'} />
                    <QueueMetric label="Ativos" value={queueMetrics.active ?? 0} />
                    <QueueMetric label="Atrasados" value={queueMetrics.delayed ?? 0} />
                    <QueueMetric label="Falhas" value={queueMetrics.failed ?? 0} tone={queueFailed ? 'danger' : 'neutral'} />
                    <QueueMetric label="Concluídos" value={queueMetrics.completed ?? 0} />
                    <QueueMetric label="ETA" value={queueMetrics.etaSeconds != null ? `${queueMetrics.etaSeconds}s` : '—'} />
                  </div>
                  {hasQueueFailures ? (
                    <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
                      Existem jobs em falha. Use a aba <span className="font-semibold">Outbox</span> para revisar e reprocessar.
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-4 text-xs text-slate-600">
                  Fila desativada. Envios são processados direto (sem outbox). Para habilitar, configure{' '}
                  <span className="font-semibold">REDIS_URL</span> e <span className="font-semibold">ENABLE_SEND_QUEUE=1</span>.
                </div>
              )}
            </section>

            <section ref={networkSectionRef} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Rede & proxy</p>
                  <p className="text-xs text-slate-500">Diagnóstico, bloqueios e ajuste do proxy.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setProxyModalOpen(true)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    Editar proxy
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleProxyRevalidate()}
                    className="rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-sm hover:bg-slate-800"
                  >
                    Revalidar
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Status</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {networkStatus === 'ok'
                      ? 'OK'
                      : networkStatus === 'blocked'
                      ? 'Bloqueado'
                      : networkStatus === 'failed'
                      ? 'Falha'
                      : 'Sem dados'}
                  </p>
                  {instance.network?.blockReason ? (
                    <p className="mt-1 text-xs text-slate-600">Motivo: {instance.network.blockReason}</p>
                  ) : null}
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Proxy</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{maskProxyUrl(instance.network?.proxyUrl ?? null)}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    IP {instance.network?.ip ?? '—'} • {instance.network?.latencyMs != null ? `${Math.round(instance.network.latencyMs)}ms` : '—'}
                  </p>
                </div>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">ISP/ASN</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {instance.network?.isp || instance.network?.asn || '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Última checagem</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {formatDateTime(instance.network?.lastCheckAt ?? null)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Validado em</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {formatDateTime(instance.network?.validatedAt ?? null)}
                  </p>
                </div>
              </div>
            </section>
          </div>

          <div className="flex flex-col gap-6">
            <section ref={qrSectionRef} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              {isConnected ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="relative flex h-10 w-10 items-center justify-center">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-200/60" />
                      <span className="relative inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
                        <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
                      </span>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-emerald-900">Conectado</p>
                      <p className="text-xs text-emerald-700">Instância pareada e pronta para operar.</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                    >
                      Logout (gera novo QR)
                    </button>
                    {riskPaused ? (
                      <button
                        type="button"
                        onClick={() => void handleRiskResume()}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
                      >
                        Retomar envios
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">QR de conexão</p>
                      <p className="text-xs text-slate-500">Escaneie para conectar a instância.</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-[11px] font-medium ${meta.tone}`}>{meta.label}</span>
                  </div>
                  <div className="mt-4 flex min-h-[220px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50">
                    {instance.qrUrl ? (
                      <img src={instance.qrUrl} alt="QR de conexão" className="h-40 w-40 rounded-xl bg-white p-2 shadow-sm" />
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-center text-xs text-slate-500">
                        <QrCode className="h-6 w-6 text-slate-400" aria-hidden="true" />
                        QR indisponível no momento
                      </div>
                    )}
                  </div>
                  <p className="mt-3 text-[11px] text-slate-500">
                    Dica: se o QR não aparecer, clique em <span className="font-semibold">Logout</span> e aguarde a regeneração.
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    className="mt-3 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    Logout / gerar novo QR
                  </button>
                </>
              )}
            </section>

            <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Notas</p>
                  <p className="text-xs text-slate-500">Contexto operacional e lembretes para esta instância.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleNotesSave()}
                  disabled={isNotesSaving || !notesDirty}
                  className={`rounded-lg px-3 py-2 text-xs font-medium text-white shadow-sm ${
                    isNotesSaving || !notesDirty ? 'bg-slate-400 cursor-not-allowed' : 'bg-slate-900 hover:bg-slate-800'
                  }`}
                >
                  {isNotesSaving ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
              <textarea
                rows={5}
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="Adicione observações importantes..."
                className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
              />
              {notesDirty ? (
                <p className="mt-2 text-[11px] text-amber-700">Alterações não salvas.</p>
              ) : (
                <p className="mt-2 text-[11px] text-slate-400">Até 280 caracteres. Salva via PATCH /instances/:iid.</p>
              )}
            </section>

            <PipedriveIntegrationCard
              instanceId={instance.id}
              instanceName={instance.name}
              isConnected={isConnected}
              apiKey={apiKey}
              onNotify={onNotify}
            />
          </div>
        </div>
      ) : activeTab === 'messages' ? (
        <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Mensagens</p>
              <p className="mt-1 text-xs text-slate-500">
                Status atuais e deltas do período{' '}
                <span className="font-semibold">
                  {metricsPreset === '30m'
                    ? '30 min'
                    : metricsPreset === '2h'
                    ? '2 horas'
                    : metricsPreset === '24h'
                    ? '24 horas'
                    : 'tudo'}
                </span>
                .
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refreshMetrics()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-4 w-4 text-slate-500" aria-hidden="true" />
              Atualizar
            </button>
          </div>

          {metricsSnapshot ? (
            <>
              <div className="mt-4 grid gap-3 md:grid-cols-3 lg:grid-cols-6">
                <QueueMetric label="Pending" value={metricsSnapshot.delivery.pending} />
                <QueueMetric label="ServerAck" value={metricsSnapshot.delivery.serverAck} />
                <QueueMetric label="Delivered" value={metricsSnapshot.delivery.delivered} />
                <QueueMetric label="Read" value={metricsSnapshot.delivery.read} />
                <QueueMetric
                  label="Failed"
                  value={metricsSnapshot.delivery.failed}
                  tone={metricsSnapshot.delivery.failed ? 'danger' : 'neutral'}
                />
                <QueueMetric
                  label="Em voo"
                  value={metricsSnapshot.delivery.inFlight}
                  tone={metricsSnapshot.delivery.inFlight ? 'warning' : 'neutral'}
                />
              </div>

              {metricsSnapshot.rangeSummary ? (
                <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <QueueMetric label="Enviadas (Δ)" value={metricsSnapshot.rangeSummary.deltas.sent} />
                  <QueueMetric label="Entregues (Δ)" value={metricsSnapshot.rangeSummary.deltas.delivered} />
                  <QueueMetric label="Lidas (Δ)" value={metricsSnapshot.rangeSummary.deltas.read} />
                  <QueueMetric
                    label="Falhas (Δ)"
                    value={metricsSnapshot.rangeSummary.deltas.failed}
                    tone={metricsSnapshot.rangeSummary.deltas.failed ? 'danger' : 'neutral'}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
              Carregando métricas...
            </div>
          )}
        </section>
      ) : activeTab === 'logs' ? (
        <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Logs & eventos</p>
              <p className="mt-1 text-xs text-slate-500">Últimos eventos desta instância (webhook, envio, sistema).</p>
              {logsError ? <p className="mt-1 text-[11px] text-rose-600">{logsError}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => void refreshLogs()}
              disabled={logsLoading}
              className={`inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 ${
                logsLoading ? 'opacity-60 cursor-wait' : ''
              }`}
            >
              <RefreshCw className={`h-4 w-4 text-slate-500 ${logsLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              {logsLoading ? 'Atualizando...' : 'Atualizar'}
            </button>
          </div>

          {logsLoading ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="h-14 rounded-xl border border-slate-100 bg-white/80 shadow-sm animate-pulse" />
              ))}
            </div>
          ) : logEvents.length ? (
            <div className="mt-4 space-y-2">
              {logEvents.map((event: BrokerEvent) => {
                const payload = (event.payload ?? {}) as Record<string, unknown>;
                const direction = event.direction ?? 'system';
                const dirMeta: Record<string, { label: string; tone: string }> = {
                  inbound: { label: 'in', tone: 'bg-indigo-50 text-indigo-700' },
                  outbound: { label: 'out', tone: 'bg-emerald-50 text-emerald-700' },
                  system: { label: 'sys', tone: 'bg-slate-100 text-slate-700' },
                };

                const webhookState = event.type === 'WEBHOOK_DELIVERY' && typeof (payload as any).state === 'string'
                  ? String((payload as any).state)
                  : null;
                const tone =
                  webhookState === 'failed'
                    ? 'border-rose-100 bg-rose-50/50'
                    : webhookState === 'retry'
                    ? 'border-amber-100 bg-amber-50/50'
                    : 'border-slate-100 bg-white';

                let detail: string | null = null;
                if (event.type === 'WEBHOOK_DELIVERY') {
                  const state = webhookState;
                  const evName = typeof (payload as any).event === 'string' ? String((payload as any).event) : null;
                  const status = (payload as any).status != null ? String((payload as any).status) : null;
                  const errMsg =
                    (payload as any)?.error && typeof (payload as any).error === 'object' && typeof (payload as any).error.message === 'string'
                      ? String((payload as any).error.message)
                      : null;
                  detail = [evName ? `Evento ${evName}` : null, state ? `state:${state}` : null, status ? `HTTP ${status}` : null, errMsg ? `• ${errMsg}` : null]
                    .filter(Boolean)
                    .join(' ');
                } else if (event.type === 'QUICK_SEND_RESULT') {
                  const summary = (payload as any)?.response && typeof (payload as any).response === 'object'
                    ? (payload as any).response.summary
                    : null;
                  detail = typeof summary === 'string' ? summary : null;
                } else if (event.type === 'MESSAGE_OUTBOUND') {
                  const type = typeof (payload as any).type === 'string' ? String((payload as any).type) : null;
                  const text = typeof (payload as any).text === 'string' ? String((payload as any).text) : null;
                  detail = [type, text ? `${text.slice(0, 140)}${text.length > 140 ? '…' : ''}` : null].filter(Boolean).join(' • ') || null;
                }

                const dir = dirMeta[direction] ?? dirMeta.system;
                return (
                  <div key={event.id} className={`rounded-xl border p-3 shadow-sm ${tone}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${dir.tone}`}>{dir.label}</span>
                        <span className="text-xs font-semibold text-slate-900">{event.type}</span>
                        {webhookState ? (
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            webhookState === 'failed'
                              ? 'bg-rose-100 text-rose-700'
                              : webhookState === 'retry'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}>
                            {webhookState}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-slate-400">{formatDateTime(event.createdAt)}</div>
                    </div>
                    {detail ? <div className="mt-1 text-xs text-slate-600">{detail}</div> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
              Nenhum evento recente para esta instância.
            </div>
          )}
        </section>
      ) : (
        <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">Outbox (fila)</p>
              <p className="mt-1 text-xs text-slate-500">Jobs com falha e reprocessamento manual.</p>
              {failedJobsError ? <p className="mt-1 text-[11px] text-rose-600">{failedJobsError}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => {
                void refreshFailedJobs();
                onRefreshQueue?.();
              }}
              disabled={failedJobsLoading}
              className={`inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 ${
                failedJobsLoading ? 'opacity-60 cursor-wait' : ''
              }`}
            >
              <RefreshCw className={`h-4 w-4 text-slate-500 ${failedJobsLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              {failedJobsLoading ? 'Atualizando...' : 'Atualizar'}
            </button>
          </div>

          {queueMetrics?.enabled ? (
            <div className="mt-4 grid gap-3 md:grid-cols-3 lg:grid-cols-6">
              <QueueMetric label="Aguardando" value={queueMetrics.waiting ?? 0} />
              <QueueMetric label="Ativos" value={queueMetrics.active ?? 0} />
              <QueueMetric label="Atrasados" value={queueMetrics.delayed ?? 0} />
              <QueueMetric label="Falhas" value={queueMetrics.failed ?? 0} tone={queueFailed ? 'danger' : 'neutral'} />
              <QueueMetric label="Concluídos" value={queueMetrics.completed ?? 0} />
              <QueueMetric label="ETA" value={queueMetrics.etaSeconds != null ? `${queueMetrics.etaSeconds}s` : '—'} />
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-4 text-xs text-slate-600">
              Fila desativada ou sem Redis configurado. Configure <span className="font-semibold">REDIS_URL</span> e{' '}
              <span className="font-semibold">ENABLE_SEND_QUEUE=1</span>.
            </div>
          )}

          {!failedJobsEnabled ? (
            <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
              Outbox indisponível (fila desativada).
            </div>
          ) : failedJobsLoading ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-16 rounded-xl border border-slate-100 bg-white/80 shadow-sm animate-pulse" />
              ))}
            </div>
          ) : failedJobs.length ? (
            <div className="mt-4 space-y-2">
              {failedJobs.map((job: SendQueueJobSummary) => {
                const title = job.to ? job.to : job.jid || 'Destino desconhecido';
                const when = formatDateTime(job.finishedOn ?? job.timestamp ?? null);
                const retrying = retryingJobId === job.id;
                return (
                  <div key={job.id} className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {title}{' '}
                          <span className="text-xs font-normal text-slate-500">
                            • {job.type} • instância {job.iid}
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          Tentativas: {job.attemptsMade}{job.failedReason ? ` • ${job.failedReason}` : ''}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-400">
                          Job {job.id.slice(0, 8)}… • {when}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRetryFailedJob(job.id)}
                        disabled={retrying}
                        className={`rounded-lg px-3 py-2 text-xs font-medium text-white shadow-sm ${
                          retrying ? 'bg-slate-400 cursor-not-allowed' : 'bg-slate-900 hover:bg-slate-800'
                        }`}
                      >
                        {retrying ? 'Reenfileirando...' : 'Retry'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
              Nenhum job falho no momento.
            </div>
          )}
        </section>
      )}

      <Modal
        open={proxyModalOpen}
        title="Proxy da instância"
        description="Atualize a URL do proxy (evite expor credenciais em telas compartilhadas)."
        onClose={() => setProxyModalOpen(false)}
        footer={(
          <>
            <button
              type="button"
              onClick={() => setProxyModalOpen(false)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleProxySave()}
              disabled={isProxySaving}
              className={`rounded-lg px-3 py-2 text-xs text-white ${
                isProxySaving ? 'bg-slate-400 cursor-not-allowed' : 'bg-slate-900 hover:bg-slate-800'
              }`}
            >
              {isProxySaving ? 'Salvando...' : 'Salvar proxy'}
            </button>
          </>
        )}
      >
        <label className="text-xs font-semibold text-slate-600">Proxy URL</label>
        <input
          type="text"
          value={proxyDraft}
          onChange={(event) => setProxyDraft(event.target.value)}
          placeholder="http://user:pass@host:port"
          disabled={isProxySaving}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleProxyRevalidate()}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
          >
            Revalidar agora
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Dica: proxies bloqueados podem derrubar o socket. Ao salvar um proxy inválido, a instância pode desconectar.
        </p>
      </Modal>

      <Modal
        open={quickSendOpen}
        title="Envio rápido"
        description="Envie um texto simples para um contato sem sair do painel."
        onClose={() => setQuickSendOpen(false)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setQuickSendOpen(false)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleQuickSend()}
              disabled={quickSendDisabled}
              className={`rounded-lg px-3 py-2 text-xs text-white ${
                quickSendDisabled ? 'bg-slate-400 cursor-not-allowed' : 'bg-slate-900 hover:bg-slate-800'
              }`}
            >
              {isQuickSending ? 'Enviando...' : 'Enviar mensagem'}
            </button>
          </>
        }
      >
        <label className="text-xs font-semibold text-slate-600">Telefone (E.164)</label>
        <input
          type="text"
          value={quickSendPhone}
          onChange={(event) => setQuickSendPhone(event.target.value)}
          placeholder="55DDDNUMERO"
          disabled={isQuickSending}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
        />
        <p className="mt-1 text-[11px] text-slate-400">Sem sinais ou espaços, ex: 5511999991234.</p>
        <label className="mt-4 text-xs font-semibold text-slate-600">Mensagem</label>
        <textarea
          rows={4}
          value={quickSendMessage}
          onChange={(event) => setQuickSendMessage(event.target.value)}
          placeholder="Escreva uma mensagem de texto simples..."
          disabled={isQuickSending}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
        />
      </Modal>

      <MessageMonitorDrawer
        open={monitorOpen}
        apiKey={apiKey}
        instanceId={instance.id}
        instanceName={instance.name}
        onClose={() => setMonitorOpen(false)}
      />
    </section>
  );
}

function MetricCard({
  label,
  value,
  helper,
  icon,
  tone = 'neutral',
}: MetricDatum & { icon: ReactNode }) {
  const toneStyles: Record<MetricTone, string> = {
    neutral: 'bg-slate-50 text-slate-600',
    positive: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-700',
    danger: 'bg-rose-50 text-rose-700',
  };

  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
      <div className={`inline-flex items-center gap-2 rounded-full px-2 py-1 text-[11px] font-medium ${toneStyles[tone]}`}>
        {icon}
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold text-slate-900">{value}</div>
      {helper ? <div className="mt-1 text-xs text-slate-500">{helper}</div> : null}
    </div>
  );
}

function HealthCard({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function QueueMetric({ label, value, tone = 'neutral' }: { label: string; value: string | number; tone?: MetricTone }) {
  const toneStyles: Record<MetricTone, string> = {
    neutral: 'bg-white text-slate-900',
    positive: 'bg-emerald-50 text-emerald-800',
    warning: 'bg-amber-50 text-amber-800',
    danger: 'bg-rose-50 text-rose-800',
  };

  return (
    <div className={`rounded-xl border border-slate-100 p-4 shadow-sm ${toneStyles[tone]}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function SettingsMenu({
  onAdvanced,
  onProxy,
  onLogout,
  onDelete,
}: {
  onAdvanced?: () => void;
  onProxy?: () => void;
  onLogout?: () => void;
  onDelete?: () => void;
}) {
  const deleteDisabled = !onDelete;
  const closeMenu = (target: EventTarget & HTMLElement) => {
    (target.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
  };
  return (
    <details className="relative">
      <summary className="list-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm hover:bg-slate-50">
        <span className="inline-flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-slate-500" aria-hidden="true" />
          Ajustes
        </span>
      </summary>
      <div className="absolute right-0 z-10 mt-2 w-52 rounded-xl border border-slate-100 bg-white p-2 shadow-lg">
        <button
          type="button"
          onClick={(event) => {
            closeMenu(event.currentTarget);
            onAdvanced?.();
          }}
          className="w-full rounded-lg px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
        >
          Configurações avançadas
        </button>
        <button
          type="button"
          onClick={(event) => {
            closeMenu(event.currentTarget);
            onProxy?.();
          }}
          className="w-full rounded-lg px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
        >
          Proxy & rede
        </button>
        <button
          type="button"
          onClick={(event) => {
            closeMenu(event.currentTarget);
            onLogout?.();
          }}
          className="w-full rounded-lg px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50"
        >
          Logout da instância
        </button>
        <button
          type="button"
          onClick={(event) => {
            closeMenu(event.currentTarget);
            onDelete?.();
          }}
          disabled={deleteDisabled}
          className={`w-full rounded-lg px-3 py-2 text-left text-xs text-rose-600 ${deleteDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-rose-50'}`}
        >
          Excluir instancia
        </button>
      </div>
    </details>
  );
}
