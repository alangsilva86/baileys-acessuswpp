import { useCallback, useEffect, useMemo, useState } from 'react';
import LayoutShell from './components/LayoutShell';
import SidebarContainer from './components/SidebarContainer';
import DashboardMain from './components/DashboardMain';
import Modal from './components/Modal';
import ToastStack, { type ToastItem, type ToastTone } from './components/ToastStack';
import useInstances from './hooks/useInstances';
import { formatApiError, readStoredApiKey, writeStoredApiKey } from '../../lib/api';

export default function DashboardPage() {
  const [apiKey, setApiKey] = useState(() => readStoredApiKey());
  const { instances, isLoading, stats, error, actions } = useInstances(apiKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [instanceName, setInstanceName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

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

  useEffect(() => {
    if (!selectedInstance) {
      setDeleteModalOpen(false);
    }
  }, [selectedInstance]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((message: string, tone: ToastTone = 'success', title?: string) => {
    const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const toast: ToastItem = { id: uuid, message, tone, title };
    setToasts((current) => [...current, toast]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== uuid));
    }, 4500);
  }, []);

  const handleSelectInstance = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const handleCreateInstance = useCallback(() => {
    setInstanceName('');
    setCreateModalOpen(true);
  }, []);

  const handleDeleteInstance = useCallback(() => {
    if (!selectedInstance) return;
    setDeleteModalOpen(true);
  }, [selectedInstance]);

  const handleApiKeyChange = useCallback((value: string) => {
    setApiKey(value);
    writeStoredApiKey(value);
  }, []);

  const handleSubmitCreate = useCallback(async () => {
    if (isCreating) return;
    if (!apiKey.trim()) {
      pushToast('Informe a API key para criar instancias.', 'error');
      return;
    }
    setIsCreating(true);
    try {
      await actions.createInstance(instanceName.trim() || undefined);
      setCreateModalOpen(false);
      setInstanceName('');
      pushToast('Instancia criada com sucesso.', 'success');
    } catch (err) {
      pushToast(formatApiError(err), 'error', 'Falha ao criar');
    } finally {
      setIsCreating(false);
    }
  }, [actions, apiKey, instanceName, isCreating, pushToast]);

  const handleConfirmDelete = useCallback(async () => {
    if (!selectedInstance || isDeleting) return;
    if (!apiKey.trim()) {
      pushToast('Informe a API key para excluir instancias.', 'error');
      return;
    }
    setIsDeleting(true);
    try {
      await actions.deleteInstance(selectedInstance.id);
      setDeleteModalOpen(false);
      pushToast(`Instancia "${selectedInstance.name}" removida.`, 'success');
    } catch (err) {
      pushToast(formatApiError(err), 'error', 'Falha ao excluir');
    } finally {
      setIsDeleting(false);
    }
  }, [actions, apiKey, isDeleting, pushToast, selectedInstance]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Baileys</p>
        <h2 className="text-lg font-semibold text-slate-900">Dashboard de Instancias</h2>
        {error ? <p className="mt-1 text-xs text-rose-600">{error}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => handleApiKeyChange(event.target.value)}
            placeholder="x-api-key"
            className="w-44 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
          />
        </div>
        <button
          type="button"
          onClick={() => void actions.refreshInstances()}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm hover:bg-slate-50"
        >
          Atualizar
        </button>
      </div>
    </div>
  );

  return (
    <>
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
        main={(
          <DashboardMain
            instance={selectedInstance}
            onRefresh={() => void actions.refreshInstances()}
            onDeleteInstance={handleDeleteInstance}
          />
        )}
      />

      <Modal
        open={createModalOpen}
        title="Nova instancia"
        description="Crie uma nova instancia para conectar ao WhatsApp."
        onClose={() => setCreateModalOpen(false)}
        footer={(
          <>
            <button
              type="button"
              onClick={() => setCreateModalOpen(false)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleSubmitCreate()}
              disabled={isCreating}
              className={`rounded-lg px-3 py-2 text-xs text-white ${isCreating ? 'bg-slate-400 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700'}`}
            >
              {isCreating ? 'Criando...' : 'Criar instancia'}
            </button>
          </>
        )}
      >
        <label className="text-xs font-semibold text-slate-600">Nome da instancia (opcional)</label>
        <input
          value={instanceName}
          onChange={(event) => setInstanceName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void handleSubmitCreate();
            }
          }}
          placeholder="ex: suporte-01"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700"
        />
      </Modal>

      <Modal
        open={deleteModalOpen}
        title="Excluir instancia"
        description={selectedInstance ? `Tem certeza que deseja remover "${selectedInstance.name}"?` : undefined}
        onClose={() => setDeleteModalOpen(false)}
        footer={(
          <>
            <button
              type="button"
              onClick={() => setDeleteModalOpen(false)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmDelete()}
              disabled={isDeleting || !selectedInstance}
              className={`rounded-lg px-3 py-2 text-xs text-white ${isDeleting ? 'bg-slate-400 cursor-not-allowed' : 'bg-rose-600 hover:bg-rose-700'}`}
            >
              {isDeleting ? 'Excluindo...' : 'Excluir instancia'}
            </button>
          </>
        )}
      >
        <p className="text-xs text-slate-500">Essa acao remove a instancia e a sessao associada.</p>
      </Modal>

      <ToastStack items={toasts} onDismiss={dismissToast} />
    </>
  );
}
