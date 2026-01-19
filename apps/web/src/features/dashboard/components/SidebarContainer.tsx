import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Plus, Search, Settings, X } from 'lucide-react';
import InstanceListItem from './InstanceListItem';
import type { InstanceStats, InstanceSummary } from '../types';

type SidebarContainerProps = {
  instances: InstanceSummary[];
  isLoading?: boolean;
  stats?: InstanceStats;
  selectedId?: string;
  onSelectInstance?: (id: string) => void;
  onCreateInstance?: () => void;
  onOpenSettings?: () => void;
  onOpenLogs?: () => void;
};

function getNextIndex(current: number, delta: number, total: number) {
  if (total <= 0) return -1;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= total) return total - 1;
  return next;
}

export default function SidebarContainer({
  instances,
  isLoading = false,
  stats,
  selectedId,
  onSelectInstance,
  onCreateInstance,
  onOpenSettings,
  onOpenLogs,
}: SidebarContainerProps) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(selectedId ?? null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldFocusRef = useRef(false);

  const filteredInstances = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return instances;
    return instances.filter((instance) => {
      const haystack = `${instance.name} ${instance.id}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [instances, query]);

  useEffect(() => {
    if (selectedId) setActiveId(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!filteredInstances.length) {
      setActiveId(null);
      return;
    }
    if (!activeId || !filteredInstances.some((instance) => instance.id === activeId)) {
      const fallback = selectedId && filteredInstances.some((instance) => instance.id === selectedId)
        ? selectedId
        : filteredInstances[0].id;
      setActiveId(fallback);
    }
  }, [filteredInstances, activeId, selectedId]);

  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const items = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-instance-id]'));
    const target = items.find((item) => item.dataset.instanceId === activeId);
    if (!target) return;
    target.scrollIntoView({ block: 'nearest' });
    if (shouldFocusRef.current && document.activeElement !== inputRef.current) {
      const button = target.querySelector<HTMLButtonElement>('button');
      button?.focus({ preventScroll: true });
    }
    shouldFocusRef.current = false;
  }, [activeId]);

  const handleSelect = useCallback((id: string) => {
    setActiveId(id);
    onSelectInstance?.(id);
  }, [onSelectInstance]);

  const handleMove = useCallback((delta: number) => {
    if (!filteredInstances.length) return;
    const currentIndex = filteredInstances.findIndex((instance) => instance.id === activeId);
    const index = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = getNextIndex(index, delta, filteredInstances.length);
    const next = filteredInstances[nextIndex];
    if (!next) return;
    shouldFocusRef.current = true;
    handleSelect(next.id);
  }, [activeId, filteredInstances, handleSelect]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      handleMove(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      handleMove(-1);
    }
  }, [handleMove]);

  const handleClear = () => {
    setQuery('');
    inputRef.current?.focus();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 space-y-3 border-b border-slate-100 bg-white/80 px-4 py-4 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Instancias</p>
          <button
            type="button"
            onClick={onCreateInstance}
            className="rounded-lg border border-transparent px-2 py-1 text-slate-500 transition hover:bg-slate-100"
            aria-label="Criar instancia"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Buscar instancias"
            className="w-full rounded-xl border border-slate-200 bg-slate-100/80 py-2 pl-9 pr-9 text-sm text-slate-700 placeholder:text-slate-400 transition focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
          {query ? (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-white hover:text-slate-600"
              aria-label="Limpar busca"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {stats ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span className="rounded-full bg-slate-100 px-2 py-0.5">Total {stats.total}</span>
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
              Conectadas {stats.connected}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-rose-700">
              <AlertCircle className="h-3 w-3" aria-hidden="true" />
              Falhas {stats.issues}
            </span>
          </div>
        ) : null}
      </div>

      <div
        ref={listRef}
        className="flex-1 space-y-2 overflow-y-auto px-3 py-3 focus:outline-none"
        onKeyDown={handleKeyDown}
        tabIndex={0}
        aria-label="Lista de instancias"
      >
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-16 rounded-xl border border-slate-100 bg-white/80 shadow-sm animate-pulse" />
            ))}
          </div>
        ) : filteredInstances.length ? (
          filteredInstances.map((instance) => (
            <div key={instance.id} data-instance-id={instance.id}>
              <InstanceListItem
                id={instance.id}
                name={instance.name}
                status={instance.status}
                updatedAt={instance.updatedAt}
                isActive={instance.id === activeId}
                onSelect={handleSelect}
              />
            </div>
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-xs text-slate-500">
            Nenhuma instancia encontrada.
          </div>
        )}
      </div>

      <div className="sticky bottom-0 border-t border-slate-100 bg-white/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-100"
          >
            <Settings className="h-4 w-4 text-slate-400" aria-hidden="true" />
            Configuracoes
          </button>
          <button
            type="button"
            onClick={onOpenLogs}
            className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-100"
          >
            <AlertCircle className="h-4 w-4 text-slate-400" aria-hidden="true" />
            Logs globais
          </button>
        </div>
      </div>
    </div>
  );
}
