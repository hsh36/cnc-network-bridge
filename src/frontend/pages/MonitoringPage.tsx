import { useCallback, useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { type TimeRange } from '../../shared';
import { CPUMemChart } from '../components/CPUMemChart';
import { DiskUsageChart } from '../components/DiskUsageChart';
import { ErrorRateChart } from '../components/ErrorRateChart';
import { QueueDepthChart } from '../components/QueueDepthChart';
import { ShareHealthTable } from '../components/ShareHealthTable';
import { TemperatureChart } from '../components/TemperatureChart';
import { ThroughputChart } from '../components/ThroughputChart';
import { SystemInfoCard } from '../components/SystemInfoCard';
import { TimeRangeSelector } from '../components/TimeRangeSelector';
import { MonitoringSettings } from '../components/settings/MonitoringSettings';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { FullPageSpinner } from '../components/ui/Spinner';
import { useApiQuery } from '../hooks/useApi';
import { getTimeRangeSeconds, useMetrics } from '../hooks/useMetrics';

const METRICS_TO_FETCH = [
  'sync.bytes_in',
  'sync.bytes_out',
  'queue.depth',
  'sync.error_rate',
  'cpu.load',
  'mem.used_pct',
  'cpu.temp',
];

export function MonitoringPage(): JSX.Element {
  const t = useTranslation('monitoring');
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [customFrom, setCustomFrom] = useState<number | undefined>(undefined);
  const [customTo, setCustomTo] = useState<number | undefined>(undefined);

  // Calculate time range
  const timeParams =
    timeRange === 'custom' && customFrom && customTo
      ? { since: customFrom, until: customTo }
      : getTimeRangeSeconds(timeRange as '1h' | '24h' | '7d' | '30d');

  // Fetch all metrics
  const metrics = useMetrics(METRICS_TO_FETCH, {
    since: timeParams.since,
    until: timeParams.until,
    enabled: true,
  });

  // Fetch system info
  const systemInfo = useApiQuery('system.get', {}, { pollMs: 30_000 });

  // Fetch status for shares
  const status = useApiQuery('status.get', {}, { pollMs: 15_000 });

  const handleTimeRangeSelect = useCallback(
    (range: TimeRange, from?: number, to?: number): void => {
      setTimeRange(range);
      if (range === 'custom' && from !== undefined && to !== undefined) {
        setCustomFrom(from);
        setCustomTo(to);
      }
    },
    [],
  );

  // Extract individual metric series for each chart
  const metricsByName = new Map(metrics.series.map((s) => [s.metric, s]));

  const seriesThroughputIn = metricsByName.get('sync.bytes_in');
  const seriesThroughputOut = metricsByName.get('sync.bytes_out');
  const seriesQueueDepth = metricsByName.get('queue.depth');
  const seriesErrorRate = metricsByName.get('sync.error_rate');
  const seriesCpuLoad = metricsByName.get('cpu.load');
  const seriesMemory = metricsByName.get('mem.used_pct');
  const seriesTemperature = metricsByName.get('cpu.temp');

  /*
    Every chart gets `chartsLoading`, not `metrics.loading`.

    `metrics.loading` goes true on each poll, so passing it straight through replaced
    the drawn series with a spinner every cycle — a page that blinked once a minute and
    could never be read. These three say the same thing: show the placeholder only while
    there is nothing to draw yet, and leave the previous series standing until the next
    one has arrived.
  */
  const chartsLoading = metrics.loading && metrics.series.length === 0;
  const systemLoading = systemInfo.loading && systemInfo.data === undefined;
  const sharesLoading = status.loading && status.data === undefined;

  if (chartsLoading && systemLoading) {
    return <FullPageSpinner />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('subtitle')}</p>
      </div>

      {metrics.error !== undefined && (
        <Card className="border-status-error/40">
          <CardBody>
            <p className="text-sm text-status-error">
              {t('load_error', { message: metrics.error.message })}
            </p>
          </CardBody>
        </Card>
      )}

      <div className="rounded-md border border-border bg-slate-50 p-4 dark:border-border-dark dark:bg-slate-900">
        <TimeRangeSelector selected={timeRange} onSelect={handleTimeRangeSelect} />
      </div>

      {/* Row 1: Throughput + System Info */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ThroughputChart
            seriesIn={seriesThroughputIn}
            seriesOut={seriesThroughputOut}
            loading={chartsLoading}
          />
        </div>
        <div>
          <SystemInfoCard systemInfo={systemInfo.data} loading={systemLoading} />
        </div>
      </div>

      {/* Row 2: Queue Depth + Error Rate */}
      <div className="grid gap-4 sm:grid-cols-2">
        <QueueDepthChart series={seriesQueueDepth} loading={chartsLoading} />
        <ErrorRateChart series={seriesErrorRate} loading={chartsLoading} />
      </div>

      {/* Row 3: CPU & Memory + Temperature */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CPUMemChart seriesCpu={seriesCpuLoad} seriesMem={seriesMemory} loading={chartsLoading} />
        </div>
        <div>
          <TemperatureChart series={seriesTemperature} loading={chartsLoading} />
        </div>
      </div>

      {/* Row 4: Disk Usage + Share Health */}
      <div className="grid gap-4 sm:grid-cols-2">
        <DiskUsageChart systemInfo={systemInfo.data} loading={systemLoading} />
        <ShareHealthTable shares={status.data?.shares} loading={sharesLoading} />
      </div>

      {/* What the page above measures is configured here rather than on a Configuration
        page of its own: the sample interval and the disk warning threshold only mean
        anything next to the charts they govern. */}
      <Card>
        <CardHeader title={t('settings_title')} />
        <CardBody>
          <MonitoringSettings />
        </CardBody>
      </Card>
    </div>
  );
}
