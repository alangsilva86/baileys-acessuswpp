import { useCallback, useEffect, useState } from 'react';
import type { BrokerEvent, InstanceLogsPayload } from '../types';
import { fetchJson, formatApiError } from '../../../lib/api';

type UseInstanceLogsResult = {
  events: BrokerEvent[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export default function useInstanceLogs(
  instanceId: string | null,
  apiKey: string,
  active = true,
  limit = 50,
): UseInstanceLogsResult {
  const [events, setEvents] = useState<BrokerEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!instanceId || !apiKey || !active) {
      setEvents([]);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(Math.floor(Number(limit)), 200)) : 50;
      const payload = await fetchJson<InstanceLogsPayload>(
        `/instances/${encodeURIComponent(instanceId)}/logs?limit=${safeLimit}`,
        apiKey,
      );
      setEvents(Array.isArray(payload?.events) ? payload.events : []);
    } catch (err) {
      setEvents([]);
      setError(formatApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [active, apiKey, instanceId, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { events, isLoading, error, refresh };
}

