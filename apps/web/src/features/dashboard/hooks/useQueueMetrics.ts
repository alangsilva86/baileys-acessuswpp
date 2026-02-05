import { useCallback, useEffect, useState } from 'react';
import type { SendQueueMetrics } from '../types';
import { fetchJson, formatApiError } from '../../../lib/api';

type UseQueueMetricsResult = {
  metrics: SendQueueMetrics | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export default function useQueueMetrics(apiKey: string): UseQueueMetricsResult {
  const [metrics, setMetrics] = useState<SendQueueMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiKey) {
      setMetrics(null);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const payload = await fetchJson<SendQueueMetrics>('/instances/queue/metrics', apiKey);
      setMetrics(payload);
    } catch (err) {
      setMetrics(null);
      setError(formatApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { metrics, isLoading, error, refresh };
}

