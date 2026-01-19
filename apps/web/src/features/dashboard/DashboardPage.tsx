import { useCallback, useEffect, useMemo, useState } from 'react';
import LayoutShell from './components/LayoutShell';
import SidebarContainer from './components/SidebarContainer';
import DashboardMain from './components/DashboardMain';
import useInstances from './hooks/useInstances';

export default function DashboardPage() {
  const { instances, isLoading, stats, actions } = useInstances();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!instances.length) {
      setSelectedId(null);
      return;
    }
    if (selectedId && instances.some((instance) => instance.id === selectedId)) return;
    setSelectedId(instances[0].id);
  }, [instances, selectedId]);

  const selectedInstance = useMemo(
    () => instances.find((instance) => instance.id === selectedId) ?? null,
    [instances, selectedId],
  );

  const handleSelectInstance = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const handleCreateInstance = useCallback(() => {
    void actions.refreshInstances();
  }, [actions]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Baileys</p>
        <h2 className="text-lg font-semibold text-slate-900">Dashboard de Instancias</h2>
      </div>
      <button
        type="button"
        onClick={() => void actions.refreshInstances()}
        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm hover:bg-slate-50"
      >
        Atualizar
      </button>
    </div>
  );

  return (
    <LayoutShell
      header={header}
      sidebar={(
        <SidebarContainer
          instances={instances}
          isLoading={isLoading}
          stats={stats}
          selectedId={selectedId ?? undefined}
          onSelectInstance={handleSelectInstance}
          onCreateInstance={handleCreateInstance}
        />
      )}
      main={<DashboardMain instance={selectedInstance} />}
    />
  );
}
