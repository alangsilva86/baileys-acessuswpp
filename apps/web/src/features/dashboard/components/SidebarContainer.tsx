import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Pin, Plus, Search, Settings, X } from 'lucide-react';
import InstanceListItem from './InstanceListItem';
import type { DashboardInstance, InstanceStats, InstanceStatus } from '../types';
import { parseIsoToMs } from '../../../lib/time';

type SidebarContainerProps = {
  instances: DashboardInstance[];
  isLoading?: boolean;
  stats?: InstanceStats;
  selectedId?: string;
  onSelectInstance?: (id: string) => void;
  onCreateInstance?: () => void;
  onOpenSettings?: () => void;
  onOpenLogs?: () => void;
};

type SidebarSortMode = 'triage' | 'recent' | 'risk' | 'status' | 'name';

const PINNED_STORAGE_KEY = 'baileys_sidebar_pins_v1';
const SORT_STORAGE_KEY = 'baileys_sidebar_sort_v1';

function getNextIndex(current: number, delta: number, total: number) {
  if (total <= 0) return -1;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= total) return total - 1;
  return next;
}

function statusRank(status: InstanceStatus): number {
  if (status === 'disconnected' || status === 'qr_expired') return 0;
  if (status === 'connecting') return 1;
  return 2;
}

function riskScore(instance: DashboardInstance): number {
  const paused = Boolean(instance.risk?.runtime?.paused);
  if (paused) return 2;
  const ratio = Number(instance.risk?.runtime?.ratio);
  if (!Number.isFinite(ratio)) return -1;
  return Math.max(0, Math.min(1, ratio));
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
  const [sortMode, setSortMode] = useState<SidebarSortMode>(() => {
    if (typeof window === 'undefined') return 'triage';
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (raw === 'recent' || raw === 'risk' || raw === 'status' || raw === 'name' || raw === 'triage') return raw;
    return 'triage';
  });
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map((id) => String(id)).filter(Boolean);
    } catch {
      return [];
    }
  });
  const [activeId, setActiveId] = useState<string | null>(selectedId ?? null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldFocusRef = useRef(false);

  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SORT_STORAGE_KEY, sortMode);
  }, [sortMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinnedIds));
  }, [pinnedIds]);

  useEffect(() => {
    const ids = new Set(instances.map((inst) => inst.id));
    setPinnedIds((current) => current.filter((id) => ids.has(id)));
  }, [instances]);

  const filteredInstances = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const base = !normalized
      ? instances
      : instances.filter((instance) => {
          const haystack = `${instance.name} ${instance.id}`.toLowerCase();
          return haystack.includes(normalized);
        });

    const ranked = base.map((instance) => {
      const updatedAtMs = parseIsoToMs(instance.updatedAt) ?? 0;
      return {
        instance,
        pinned: pinnedSet.has(instance.id),
        statusRank: statusRank(instance.status),
        risk: riskScore(instance),
        updatedAtMs,
      };
    });

    ranked.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

      if (sortMode === 'name') {
        return a.instance.name.localeCompare(b.instance.name, 'pt-BR');
      }
      if (sortMode === 'recent') {
        return b.updatedAtMs - a.updatedAtMs || a.instance.name.localeCompare(b.instance.name, 'pt-BR');
      }
      if (sortMode === 'status') {
        return (
          a.statusRank - b.statusRank ||
          b.updatedAtMs - a.updatedAtMs ||
          a.instance.name.localeCompare(b.instance.name, 'pt-BR')
        );
      }
      if (sortMode === 'risk') {
        return (
          b.risk - a.risk ||
          a.statusRank - b.statusRank ||
          b.updatedAtMs - a.updatedAtMs ||
          a.instance.name.localeCompare(b.instance.name, 'pt-BR')
        );
      }

      // triage (default): críticas → risco → mais recente → nome
      return (
        a.statusRank - b.statusRank ||
        b.risk - a.risk ||
        b.updatedAtMs - a.updatedAtMs ||
        a.instance.name.localeCompare(b.instance.name, 'pt-BR')
      );
    });

    return ranked.map((entry) => entry.instance);
  }, [instances, pinnedSet, query, sortMode]);

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

  const togglePin = useCallback((id: string) => {
    setPinnedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return Array.from(next);
    });
  }, []);

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
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Instâncias</p>
          <button
            type="button"
            onClick={onCreateInstance}
            className="rounded-lg border border-transparent px-2 py-1 text-slate-500 transition hover:bg-slate-100"
            aria-label="Criar instância"
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
            placeholder="Buscar instâncias"
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

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="sidebarSort">Ordenação</label>
            <select
              id="sidebarSort"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SidebarSortMode)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <option value="triage">Prioridade</option>
              <option value="recent">Mais recentes</option>
              <option value="risk">Maior risco</option>
              <option value="status">Status</option>
              <option value="name">Nome (A→Z)</option>
            </select>
            {pinnedIds.length ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                Fixadas {pinnedIds.length}
              </span>
            ) : null}
          </div>
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
        aria-label="Lista de instâncias"
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
                trailing={(
                  <button
                    type="button"
                    onClick={() => togglePin(instance.id)}
                    className={`rounded-lg p-2 transition ${
                      pinnedSet.has(instance.id)
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-400 hover:bg-white hover:text-slate-600'
                    }`}
                    aria-label={pinnedSet.has(instance.id) ? 'Desafixar instância' : 'Fixar instância'}
                    title={pinnedSet.has(instance.id) ? 'Instância fixada' : 'Fixar instância'}
                  >
                    <Pin className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              />
            </div>
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-xs text-slate-500">
            Nenhuma instância encontrada.
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
            Configurações
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
