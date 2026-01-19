import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardInstance, InstanceStats } from '../types';

const MOCK_INSTANCES: DashboardInstance[] = [
  {
    id: '91acessus',
    name: '91acessus',
    status: 'connected',
    updatedAt: '19/01/2026 13:10',
    health: {
      network: 'Proxy residencial',
      risk: '12% desconhecido',
      queue: '0 pend. / 0 exec.',
    },
  },
  {
    id: '41-2160acessus',
    name: '41-2160acessus',
    status: 'connecting',
    updatedAt: '19/01/2026 13:12',
    health: {
      network: 'Revalidando proxy',
      risk: '25% desconhecido',
      queue: '12 pend. / 2 exec.',
    },
    qrUrl: '/instances/41-2160acessus/qr.png',
  },
  {
    id: 'qa-bot',
    name: 'qa-bot',
    status: 'disconnected',
    updatedAt: '19/01/2026 12:44',
    health: {
      network: 'Proxy sem resposta',
      risk: 'Sem dados',
      queue: 'Fila pausada',
    },
    qrUrl: '/instances/qa-bot/qr.png',
  },
  {
    id: 'sales-01',
    name: 'sales-01',
    status: 'qr_expired',
    updatedAt: '19/01/2026 11:30',
    health: {
      network: 'Proxy datacenter',
      risk: '60% desconhecido',
      queue: '150 pend. / 12 exec.',
    },
    qrUrl: '/instances/sales-01/qr.png',
  },
];

export type UseInstancesResult = {
  instances: DashboardInstance[];
  isLoading: boolean;
  stats: InstanceStats;
  actions: {
    refreshInstances: () => Promise<void>;
    pauseQueue: (id: string) => Promise<void>;
    deleteInstance: (id: string) => Promise<void>;
  };
};

export default function useInstances(): UseInstancesResult {
  const [instances, setInstances] = useState<DashboardInstance[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setInstances(MOCK_INSTANCES);
      setIsLoading(false);
    }, 600);

    return () => clearTimeout(timer);
  }, []);

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

  const refreshInstances = useCallback(async () => {
    setIsLoading(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    setInstances(MOCK_INSTANCES);
    setIsLoading(false);
  }, []);

  const pauseQueue = useCallback(async (id: string) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    setInstances((current) => current.map((instance) => (
      instance.id === id
        ? {
            ...instance,
            health: {
              ...instance.health,
              queue: 'Fila pausada manualmente',
            },
          }
        : instance
    )));
  }, []);

  const deleteInstance = useCallback(async (id: string) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    setInstances((current) => current.filter((instance) => instance.id !== id));
  }, []);

  return {
    instances,
    isLoading,
    stats,
    actions: {
      refreshInstances,
      pauseQueue,
      deleteInstance,
    },
  };
}
