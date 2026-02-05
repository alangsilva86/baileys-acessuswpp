import { useCallback, useEffect, useState } from 'react';
import type { SendQueueFailedJobsPayload, SendQueueJobSummary } from '../types';
import { fetchJson, formatApiError } from '../../../lib/api';

type UseQueueFailedJobsResult = {
  enabled: boolean;
  jobs: SendQueueJobSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export default function useQueueFailedJobs(apiKey: string, limit = 50, active = true): UseQueueFailedJobsResult {
  const [enabled, setEnabled] = useState(false);
  const [jobs, setJobs] = useState<SendQueueJobSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiKey || !active) {
      setEnabled(false);
      setJobs([]);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (Number.isFinite(Number(limit))) qs.set('limit', String(Math.max(1, Math.min(Math.floor(Number(limit)), 200))));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const payload = await fetchJson<SendQueueFailedJobsPayload>(`/instances/queue/failed${suffix}`, apiKey);
      setEnabled(Boolean(payload?.enabled));
      setJobs(Array.isArray(payload?.jobs) ? payload.jobs : []);
    } catch (err) {
      setEnabled(false);
      setJobs([]);
      setError(formatApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [active, apiKey, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { enabled, jobs, isLoading, error, refresh };
}

