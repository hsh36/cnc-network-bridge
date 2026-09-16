import { useCallback, useEffect, useState } from 'react';
import { type Lock } from '../../shared';
import { api, ApiError } from '../lib/api-client';
import { useSSE } from './useSSE';

export interface LocksState {
  readonly active: readonly Lock[];
  readonly loading: boolean;
  readonly error: ApiError | undefined;
  readonly refresh: () => Promise<void>;
}

/**
 * Manages the list of active locks, refreshed on load and on every SSE lock event.
 *
 * It used to fetch a second page of up to 500 released locks for a history tab. The tab
 * is gone, and so is that request: it ran again on every lock event — that is, every
 * time a machine opened or closed a file — to fill a list nobody was looking at.
 */
export function useLocks(): LocksState {
  const [active, setActive] = useState<Lock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError>();

  // Subscribe to lock events via SSE
  const sse = useSSE({ types: ['lock'] });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const activeLocks = await api('locks.list', {
        query: { includeReleased: false, limit: 500 },
      });
      setActive(activeLocks.items);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refresh when lock events occur via SSE
  useEffect(() => {
    if (sse.latest?.type === 'lock') {
      void refresh();
    }
  }, [sse.latest, refresh]);

  return {
    active,
    loading,
    error,
    refresh,
  };
}
