import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  QrCode,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';
import type { DashboardInstance, InstanceStatus, MetricDatum, MetricTone } from '../types';

type DashboardMainProps = {
  instance?: DashboardInstance | null;
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

export default function DashboardMain({ instance }: DashboardMainProps) {
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
  const metrics = instance.metrics?.length ? instance.metrics : DEFAULT_METRICS;

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
          </div>
          <p className="text-xs text-slate-500">Atualizado {instance.updatedAt || '—'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm hover:bg-slate-50">
            Atualizar dados
          </button>
          <button type="button" className="rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-sm hover:bg-slate-800">
            Envio rapido
          </button>
          <SettingsMenu />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="flex flex-col gap-6">
          <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">Inspector de saude</p>
                <p className="text-xs text-slate-500">Resumo operativo em tempo real.</p>
              </div>
              <div className="text-xs text-slate-400">Atualizacao continua</div>
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
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-slate-900">Metricas</p>
                <p className="text-xs text-slate-500">Ultimos indicadores da instancia.</p>
              </div>
              <button type="button" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50">
                Exportar
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {metrics.map((metric) => (
                <MetricCard
                  key={metric.key}
                  icon={METRIC_ICONS[metric.key] ?? <Activity className="h-4 w-4 text-slate-500" aria-hidden="true" />}
                  {...metric}
                />
              ))}
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-6">
          {isConnected ? (
            <section className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="relative flex h-10 w-10 items-center justify-center">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-200/60" />
                  <span className="relative inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
                  </span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-emerald-900">Status saudavel</p>
                  <p className="text-xs text-emerald-700">Instancia conectada e sincronizada.</p>
                </div>
              </div>
            </section>
          ) : (
            <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">QR de conexao</p>
                  <p className="text-xs text-slate-500">Escaneie para conectar a instancia.</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-[11px] font-medium ${meta.tone}`}>{meta.label}</span>
              </div>
              <div className="mt-4 flex min-h-[220px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50">
                {instance.qrUrl ? (
                  <img src={instance.qrUrl} alt="QR de conexao" className="h-40 w-40 rounded-xl bg-white p-2 shadow-sm" />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-center text-xs text-slate-500">
                    <QrCode className="h-6 w-6 text-slate-400" aria-hidden="true" />
                    QR indisponivel no momento
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-slate-900">Notas e contexto</p>
            <p className="text-xs text-slate-500">Centralize informacoes criticas da operacao.</p>
            <textarea
              rows={4}
              placeholder="Adicione observacoes importantes..."
              className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
            />
          </section>
        </div>
      </div>
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

function SettingsMenu() {
  return (
    <details className="relative">
      <summary className="list-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm hover:bg-slate-50">
        <span className="inline-flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-slate-500" aria-hidden="true" />
          Ajustes
        </span>
      </summary>
      <div className="absolute right-0 z-10 mt-2 w-52 rounded-xl border border-slate-100 bg-white p-2 shadow-lg">
        <button type="button" className="w-full rounded-lg px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50">
          Configuracoes avancadas
        </button>
        <button type="button" className="w-full rounded-lg px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50">
          Logout da instancia
        </button>
        <button type="button" className="w-full rounded-lg px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50">
          Excluir instancia
        </button>
      </div>
    </details>
  );
}
