import { useCallback, useEffect, useRef, useState } from 'react';
import { type LogEntry, type LogLevel, type LogSource } from '../../shared';

export interface LogsFilter {
  readonly level: LogLevel | '';
  readonly source: LogSource | '';
  readonly share: number | '';
  readonly since: number | undefined;
  readonly until: number | undefined;
  readonly q: string;
}

export interface UseLogsOptions {
  readonly enabled?: boolean;
  readonly live?: boolean;
  readonly maxLiveEvents?: number;
}

export interface UseLogsResult {
  readonly logs: readonly LogEntry[];
  readonly loading: boolean;
  readonly error: Error | undefined;
  readonly total: number;
  readonly live: boolean;
  /** True while the live stream is between connections. Not an error. */
  readonly reconnecting: boolean;
  readonly paused: boolean;
  readonly toggleLive: () => void;
  readonly togglePause: () => void;
  readonly clearLogs: () => void;
  readonly refresh: () => void;
}

/**
 * Manages log state with optional SSE live tail.
 *
 * When `live` is true, connects to `/logs/stream` and appends new entries.
 * The list can be paused to allow reading without new events interrupting.
 */
export function useLogs(filter: LogsFilter, options: UseLogsOptions = {}): UseLogsResult {
  const { enabled = true, live: initialLive = false, maxLiveEvents = 10_000 } = options;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();
  const [total, setTotal] = useState(0);
  const [live, setLive] = useState(initialLive);
  const [reconnecting, setReconnecting] = useState(false);
  const [paused, setPaused] = useState(false);
  const sourceRef = useRef<EventSource>();
  const logsRef = useRef<LogEntry[]>([]);
  /** Set when a connection drops, so the refetch happens on a reconnect and not on the
    first connect — where it would only duplicate the initial fetch. */
  const droppedRef = useRef(false);

  // Build query string from filter
  const buildQuery = useCallback((): URLSearchParams => {
    const params = new URLSearchParams();
    params.set('limit', '100');
    params.set('offset', '0');
    if (filter.level !== '') params.set('level', filter.level);
    if (filter.source !== '') params.set('source', filter.source);
    if (filter.share !== '') params.set('share', String(filter.share));
    if (filter.since !== undefined) params.set('since', Math.floor(filter.since / 1000).toString());
    if (filter.until !== undefined) params.set('until', Math.floor(filter.until / 1000).toString());
    if (filter.q.trim() !== '') params.set('q', filter.q.trim());
    return params;
  }, [filter]);

  // Fetch initial logs
  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(undefined);
    try {
      const query = buildQuery();
      const response = await fetch(`/api/logs?${query}`, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        ok: boolean;
        data: { items: LogEntry[]; total: number };
      };
      if (data.ok) {
        logsRef.current = data.data.items;
        setLogs(data.data.items);
        setTotal(data.data.total);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [enabled, buildQuery]);

  // Set up SSE connection for live tail
  useEffect(() => {
    if (!enabled || !live) {
      sourceRef.current?.close();
      sourceRef.current = undefined;
      setReconnecting(false);
      return;
    }

    const source = new EventSource(`/api/logs/stream?${buildQuery()}`, { withCredentials: true });
    sourceRef.current = source;

    source.onmessage = (evt: MessageEvent<string>) => {
      try {
        const entry = JSON.parse(evt.data) as LogEntry;
        if (!paused) {
          logsRef.current = [entry, ...logsRef.current];
          if (logsRef.current.length > maxLiveEvents) {
            logsRef.current = logsRef.current.slice(0, maxLiveEvents);
          }
          setLogs([...logsRef.current]);
        }
      } catch {
        // Malformed event is dropped
      }
    };

    /*
      A dropped connection is not an error, and closing it here made it one.

      `onerror` fires on every ordinary interruption an SSE stream has — a proxy timing
      the idle connection out, a laptop waking up, the service restarting after an
      update. The browser's EventSource handles all of those itself: it waits, retries,
      and sends `Last-Event-ID` so the server can replay what was missed. Calling
      `close()` in the handler took that away and turned each hiccup into a permanently
      dead tail behind a red "Live stream disconnected" — which is what an operator
      saw on a log page left open for an hour.

      So the stream is left to reconnect, and only a `CLOSED` readyState — which
      EventSource reaches when it has given up, as after an auth failure — is reported
      as an error.
    */
    source.onopen = () => {
      setError(undefined);
      setReconnecting(false);
      if (droppedRef.current) {
        droppedRef.current = false;
        // The tail missed whatever arrived while it was down, so refetch the window.
        void refresh();
      }
    };

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setError(new Error('Live stream disconnected'));
        setReconnecting(false);
        return;
      }
      droppedRef.current = true;
      setReconnecting(true);
    };

    return () => {
      source.close();
      sourceRef.current = undefined;
      setReconnecting(false);
    };
  }, [enabled, live, buildQuery, paused, maxLiveEvents, refresh]);

  const toggleLive = useCallback(() => {
    setLive((v) => !v);
    setPaused(false);
  }, []);

  const togglePause = useCallback(() => {
    setPaused((v) => !v);
  }, []);

  const clearLogs = useCallback(() => {
    logsRef.current = [];
    setLogs([]);
  }, []);

  return {
    logs,
    loading,
    error,
    total,
    live,
    reconnecting,
    paused,
    toggleLive,
    togglePause,
    clearLogs,
    refresh: () => void refresh(),
  };
}
