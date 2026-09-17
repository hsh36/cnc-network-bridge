import { useEffect } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { FullPageSpinner } from '../components/ui/Spinner';
import { StatCard } from '../components/ui/StatCard';
import { Table, type Column } from '../components/ui/Table';
import { useApiQuery } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { useTranslation } from '../hooks/useTranslation';
import { type Lock } from '../../shared';

function bytesToHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function connectionTone(state: string): BadgeTone {
  return state === 'open' ? 'ok' : state === 'connecting' ? 'warn' : 'error';
}

function getLockColumns(t: ReturnType<typeof useTranslation>): readonly Column<Lock>[] {
  return [
    {
      key: 'path',
      header: t('table_path'),
      render: (l) => <span className="font-mono text-xs">{l.relPath}</span>,
    },
    {
      key: 'origin',
      header: t('table_origin'),
      render: (l) => <Badge tone={l.origin === 'machine' ? 'accent' : 'idle'}>{l.origin}</Badge>,
    },
    {
      key: 'owner',
      header: t('table_owner'),
      render: (l) => l.ownerLabel ?? l.machineIp ?? '—',
    },
    {
      key: 'age',
      header: t('table_acquired'),
      render: (l) => new Date(l.acquiredAt * 1000).toLocaleTimeString(),
    },
  ];
}

export function Dashboard(): JSX.Element {
  const t = useTranslation('dashboard');
  const status = useApiQuery('status.get', {}, { pollMs: 15_000 });
  const system = useApiQuery('system.get', {}, { pollMs: 15_000 });
  const locks = useApiQuery('locks.list', { query: {} }, { pollMs: 10_000 });
  const sse = useSSE({ types: ['status', 'lock', 'sync.progress', 'failover', 'conflict'] });
  /*
    `info` and above, so the list is what happened rather than everything that was traced.

    It polls slowly as well as refreshing on an event: an event is a hint that something
    is new, not a guarantee that one will arrive — the stream may be down, or the entry
    may come from a job that publishes nothing.
  */
  const events = useApiQuery(
    'logs.list',
    { query: { limit: 20, offset: 0, level: 'info' } },
    { pollMs: 60_000 },
  );
  const refreshEvents = events.refresh;
  useEffect(() => {
    if (sse.latest !== undefined) {
      refreshEvents();
    }
  }, [sse.latest, refreshEvents]);

  if (status.loading && status.data === undefined) {
    return <FullPageSpinner />;
  }

  const data = status.data;
  const disk = system.data?.disks[0];
  const recentEvents = events.data?.items ?? [];
  const lockColumns = getLockColumns(t);

  const getConnectionStatus = (): string => {
    if (sse.state === 'open') return t('status_live');
    if (sse.state === 'connecting') return t('status_connecting');
    return t('status_disconnected');
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('live_status', { version: data?.version ?? '—' })}
          </p>
        </div>
        <Badge tone={connectionTone(sse.state)}>{getConnectionStatus()}</Badge>
      </div>

      {status.error !== undefined && (
        <Card className="border-status-error/40">
          <CardBody>
            <p className="text-sm text-status-error">
              {t('load_error', { message: status.error.message })}
            </p>
          </CardBody>
        </Card>
      )}

      {data !== undefined && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard
              label={t('server_link')}
              value={data.serverLink.reachable ? t('online') : t('offline')}
              tone={data.serverLink.reachable ? 'ok' : 'error'}
              hint={data.serverLink.dialect ?? undefined}
            />
            <StatCard label={t('shares_enabled')} value={data.totals.sharesEnabled} />
            <StatCard
              label={t('files_indexed')}
              value={data.totals.filesIndexed}
              hint={t('pending', { count: data.totals.filesPending })}
            />
            <StatCard
              label={t('active_locks')}
              value={data.totals.activeLocks}
              tone={data.totals.activeLocks > 0 ? 'warn' : 'default'}
            />
            <StatCard
              label={t('conflicts')}
              value={data.totals.unacknowledgedConflicts}
              tone={data.totals.unacknowledgedConflicts > 0 ? 'error' : 'default'}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard
              label={t('throughput_in')}
              value={`${bytesToHuman(data.totals.bytesInPerSec)}/s`}
            />
            <StatCard
              label={t('throughput_out')}
              value={`${bytesToHuman(data.totals.bytesOutPerSec)}/s`}
            />
            <StatCard
              label={t('disk_used')}
              value={disk !== undefined ? `${disk.usedPct}%` : '—'}
              tone={disk !== undefined && disk.usedPct >= 85 ? 'warn' : 'default'}
              hint={
                disk !== undefined ? t('free', { size: bytesToHuman(disk.freeBytes) }) : undefined
              }
            />
            <StatCard
              label={t('memory_used')}
              value={system.data !== undefined ? `${system.data.memory.usedPct}%` : '—'}
            />
          </div>

          {data.readOnlyReason !== null && (
            <Card className="border-status-warn/40">
              <CardBody>
                <p className="text-sm text-status-warn">
                  {t('read_only_mode', { reason: data.readOnlyReason })}
                </p>
              </CardBody>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader
          title={t('active_locks_title')}
          subtitle={t('locks_held', { total: locks.data?.total ?? 0 })}
        />
        {locks.data?.items.length === 0 ? (
          <EmptyState title={t('no_locks_message')} description={t('no_locks_description')} />
        ) : (
          <Table columns={lockColumns} rows={locks.data?.items ?? []} rowKey={(l) => l.id} />
        )}
      </Card>

      {/*
        Read from the log, not from the stream.

        This card used to render `sse.events`, which is whatever arrived while the page
        happened to be open. Nothing was stored, so an operator who opened the dashboard
        after an update saw an empty list and concluded the update had not run — the one
        moment the card exists for is the one it could never cover.

        The log is where every one of these events is already recorded, so the list is a
        query against it and an incoming event only triggers a refresh. Same shape as the
        update status: one source of truth, and a dropped stream costs liveness rather
        than correctness.
      */}
      <Card>
        <CardHeader title={t('recent_events')} subtitle={t('event_log')} />
        <CardBody className="max-h-72 overflow-y-auto p-0">
          {recentEvents.length === 0 ? (
            <EmptyState title={t('no_events')} description={t('no_events_description')} />
          ) : (
            <ul className="divide-y divide-border text-sm dark:divide-border-dark">
              {recentEvents.map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                      {entry.source}
                    </span>{' '}
                    <span className="text-slate-700 dark:text-slate-300">{entry.message}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                    {new Date(entry.ts).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
