import type { ReactNode } from 'react';
import { CheckCircle2, Loader, WifiOff, QrCode } from 'lucide-react';
import type { InstanceStatus } from '../types';

type InstanceListItemProps = {
  id: string;
  name: string;
  status: InstanceStatus;
  updatedAt?: string;
  isActive?: boolean;
  onSelect?: (id: string) => void;
  trailing?: ReactNode;
};

const STATUS_META: Record<InstanceStatus, { label: string; tone: string; icon: ReactNode }> = {
  connected: {
    label: 'Conectado',
    tone: 'bg-emerald-100 text-emerald-700',
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />,
  },
  connecting: {
    label: 'Reconectando',
    tone: 'bg-amber-100 text-amber-700',
    icon: <Loader className="h-3.5 w-3.5 animate-spin text-amber-500" aria-hidden="true" />,
  },
  disconnected: {
    label: 'Desconectado',
    tone: 'bg-rose-100 text-rose-700',
    icon: <WifiOff className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" />,
  },
  qr_expired: {
    label: 'QR expirado',
    tone: 'bg-rose-100 text-rose-700',
    icon: <QrCode className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" />,
  },
};

export default function InstanceListItem({
  id,
  name,
  status,
  updatedAt,
  isActive = false,
  onSelect,
  trailing,
}: InstanceListItemProps) {
  const meta = STATUS_META[status] ?? STATUS_META.disconnected;
  const handleClick = () => onSelect?.(id);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-current={isActive ? 'true' : undefined}
      className={`w-full rounded-xl border px-3 py-3 text-left transition ${
        isActive
          ? 'border-slate-900 bg-slate-900 text-white shadow-sm'
          : 'border-slate-100 bg-white/80 text-slate-900 hover:border-slate-200 hover:bg-white'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            {meta.icon}
            <span className="truncate text-sm font-medium">{name}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${isActive ? 'bg-white/15 text-white' : meta.tone}`}>
              {meta.label}
            </span>
            <span className={`text-[11px] ${isActive ? 'text-white/70' : 'text-slate-400'}`}>
              {updatedAt || 'Sem atualizacao'}
            </span>
          </div>
        </div>
        {trailing ? <div className="flex items-center">{trailing}</div> : null}
      </div>
    </button>
  );
}
