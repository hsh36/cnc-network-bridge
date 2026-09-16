import { useEffect, useState } from 'react';
import {
  type ConflictMode,
  type LoggingConfig,
  type LockingConfig,
  type MonitoringConfig,
  type SecurityConfig,
  type SyncConfig,
  type UpdatesConfig,
  type VersioningConfig,
} from '../../shared';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Checkbox, Input, Select } from '../components/ui/Input';
import { Tabs } from '../components/ui/Tabs';
import { FullPageSpinner } from '../components/ui/Spinner';
import { CertificateManager } from '../components/CertificateManager';
import { SchedulePicker } from '../components/SchedulePicker';
import { SharesSection } from '../components/SharesSection';
import { useTranslation } from '../hooks/useTranslation';
import { api } from '../lib/api-client';
import { useSaveBanner, validateConfigSection } from '../lib/config-form';

/**
 * A per-section save form with Zod validation, unsaved-changes guard, and
 * test connectivity buttons. Replaces the simpler previous implementation with
 * full T47 scope: network, SMB, AD, sync, locking, versioning, security, updates,
 * logging, monitoring, plus test/connection features.
 */

// ---------------------------------------------------------------------------
// Sync Behavior
// ---------------------------------------------------------------------------

function SyncSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<SyncConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'sync' } }).then((data) =>
      setForm(data as SyncConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('sync', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'sync' }, body: form })
      .then((data) => {
        setForm(data as SyncConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Select
        id="conflictMode"
        label={t('conflict_mode')}
        value={form.conflictMode}
        onChange={(e) => {
          setForm({ ...form, conflictMode: e.target.value as ConflictMode });
          setIsDirty(true);
        }}
        error={errors.conflictMode}
        className="w-64"
      >
        <option value="last_write_wins">{t('last_write_wins')}</option>
        <option value="tnc_wins">{t('tnc_wins')}</option>
        <option value="server_wins">{t('server_wins')}</option>
      </Select>

      <Input
        id="bandwidthLimit"
        label={t('bandwidth_limit')}
        type="number"
        value={form.bandwidthLimitKbps ?? ''}
        onChange={(e) => {
          setForm({
            ...form,
            bandwidthLimitKbps: e.target.value === '' ? null : Number(e.target.value),
          });
          setIsDirty(true);
        }}
        error={errors.bandwidthLimitKbps}
        className="w-64"
      />

      <Input
        id="maxFileSize"
        label={t('max_file_size')}
        type="number"
        value={form.maxFileSizeMb}
        onChange={(e) => {
          setForm({ ...form, maxFileSizeMb: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.maxFileSizeMb}
        className="w-64"
      />

      <Input
        id="mtimeTolerance"
        label={t('mtime_tolerance')}
        type="number"
        value={form.mtimeToleranceMs}
        onChange={(e) => {
          setForm({ ...form, mtimeToleranceMs: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.mtimeToleranceMs}
        className="w-64"
      />

      <Input
        id="scanInterval"
        label={t('scan_interval')}
        type="number"
        value={form.scanIntervalMs}
        onChange={(e) => {
          setForm({ ...form, scanIntervalMs: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.scanIntervalMs}
        className="w-64"
      />

      <Input
        id="concurrency"
        label={t('concurrency')}
        type="number"
        value={form.concurrency}
        onChange={(e) => {
          setForm({ ...form, concurrency: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.concurrency}
        className="w-40"
      />

      <div>
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {t('exclude_patterns')}
        </label>
        <textarea
          className="mt-1 h-24 w-full rounded-md border border-border bg-white px-3 py-2 text-sm dark:border-border-dark dark:bg-surface-dark"
          value={form.excludePatterns.join('\n')}
          onChange={(e) => {
            setForm({
              ...form,
              excludePatterns: e.target.value
                .split('\n')
                .map((p) => p.trim())
                .filter((p) => p.length > 0),
            });
            setIsDirty(true);
          }}
        />
      </div>

      <Checkbox
        id="protectDeletes"
        label={t('protect_deletes')}
        checked={form.protectDeletes}
        onChange={(e) => {
          setForm({ ...form, protectDeletes: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Checkbox
        id="failoverReadOnly"
        label={t('failover_readonly')}
        checked={form.failoverReadOnly}
        onChange={(e) => {
          setForm({ ...form, failoverReadOnly: e.target.checked });
          setIsDirty(true);
        }}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Locking Settings
// ---------------------------------------------------------------------------

function LockingSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<LockingConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'locking' } }).then((data) =>
      setForm(data as LockingConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('locking', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'locking' }, body: form })
      .then((data) => {
        setForm(data as LockingConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        id="lockingEnabled"
        label={t('enable_locking')}
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="serverProjection"
        label={t('server_projection')}
        value={form.serverProjection}
        onChange={(e) => {
          setForm({
            ...form,
            serverProjection: e.target.value as 'none' | 'sidecar' | 'byte_range',
          });
          setIsDirty(true);
        }}
        error={errors.serverProjection}
      >
        <option value="none">{t('projection_none')}</option>
        <option value="sidecar">{t('projection_sidecar')}</option>
        <option value="byte_range">{t('projection_byte_range')}</option>
      </Select>

      <Input
        id="tncLockTtl"
        label={t('tnc_lock_ttl')}
        type="number"
        value={form.tncLockTtlS}
        onChange={(e) => {
          setForm({ ...form, tncLockTtlS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.tncLockTtlS}
        className="w-64"
      />

      <Input
        id="releaseLinger"
        label={t('release_linger')}
        type="number"
        value={form.releaseLingerS}
        onChange={(e) => {
          setForm({ ...form, releaseLingerS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.releaseLingerS}
        className="w-64"
      />

      <Select
        id="scheduleDefault"
        label={t('schedule_default')}
        value={form.scheduleDefault}
        onChange={(e) => {
          setForm({
            ...form,
            scheduleDefault: e.target.value as 'none' | 'business_hours' | 'custom',
          });
          setIsDirty(true);
        }}
        error={errors.scheduleDefault}
      >
        <option value="none">{t('schedule_none')}</option>
        <option value="business_hours">{t('schedule_business')}</option>
        <option value="custom">{t('schedule_custom')}</option>
      </Select>

      <Checkbox
        id="blockPullWhenLocked"
        label={t('block_pull_locked')}
        checked={form.blockPullWhenLocked}
        onChange={(e) => {
          setForm({ ...form, blockPullWhenLocked: e.target.checked });
          setIsDirty(true);
        }}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Versioning Settings
// ---------------------------------------------------------------------------

function VersioningSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<VersioningConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'versioning' } }).then((data) =>
      setForm(data as VersioningConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('versioning', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'versioning' }, body: form })
      .then((data) => {
        setForm(data as VersioningConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        id="versioningEnabled"
        label={t('enable_versioning')}
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="keepCount"
        label={t('keep_count')}
        type="number"
        value={form.keepCount}
        onChange={(e) => {
          setForm({ ...form, keepCount: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.keepCount}
        className="w-64"
      />

      <Input
        id="keepDays"
        label={t('keep_days')}
        type="number"
        value={form.keepDays}
        onChange={(e) => {
          setForm({ ...form, keepDays: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.keepDays}
        className="w-64"
      />

      <Input
        id="maxStoreGb"
        label={t('max_store_gb')}
        type="number"
        step="0.1"
        value={form.maxStoreGb}
        onChange={(e) => {
          setForm({ ...form, maxStoreGb: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.maxStoreGb}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security Settings
// ---------------------------------------------------------------------------

function SecuritySection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<SecurityConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'security' } }).then((data) =>
      setForm(data as SecurityConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('security', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'security' }, body: form })
      .then((data) => {
        setForm(data as SecurityConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        id="sessionIdleMin"
        label={t('session_idle')}
        type="number"
        value={form.sessionIdleMin}
        onChange={(e) => {
          setForm({ ...form, sessionIdleMin: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.sessionIdleMin}
        className="w-64"
      />

      <Input
        id="sessionAbsoluteH"
        label={t('session_absolute')}
        type="number"
        value={form.sessionAbsoluteH}
        onChange={(e) => {
          setForm({ ...form, sessionAbsoluteH: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.sessionAbsoluteH}
        className="w-64"
      />

      <Input
        id="loginMaxAttempts"
        label={t('login_attempts')}
        type="number"
        value={form.loginMaxAttempts}
        onChange={(e) => {
          setForm({ ...form, loginMaxAttempts: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.loginMaxAttempts}
        className="w-64"
      />

      <Checkbox
        id="fail2banEnabled"
        label={t('enable_fail2ban')}
        checked={form.fail2banEnabled}
        onChange={(e) => {
          setForm({ ...form, fail2banEnabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="tlsMin"
        label={t('tls_minimum')}
        value={form.tlsMin}
        onChange={(e) => {
          setForm({ ...form, tlsMin: e.target.value as 'TLSv1.2' | 'TLSv1.3' });
          setIsDirty(true);
        }}
        error={errors.tlsMin}
        className="w-40"
      >
        <option value="TLSv1.2">{t('tls_1_2')}</option>
        <option value="TLSv1.3">{t('tls_1_3')}</option>
      </Select>

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>

      {/*
        Outside the form above on purpose: the certificate is installed by its own
        endpoints the moment the operator confirms, not by this section's Save button.
        Putting it inside would suggest the two are saved together.
      */}
      <CertificateManager />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Updates Settings
// ---------------------------------------------------------------------------

function UpdatesSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<UpdatesConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'updates' } }).then((data) =>
      setForm(data as UpdatesConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('updates', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'updates' }, body: form })
      .then((data) => {
        setForm(data as UpdatesConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        id="updatesEnabled"
        label={t('enable_updates')}
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="channel"
        label={t('update_channel')}
        value={form.channel}
        onChange={(e) => {
          setForm({ ...form, channel: e.target.value as 'stable' | 'beta' });
          setIsDirty(true);
        }}
        error={errors.channel}
      >
        <option value="stable">{t('channel_stable')}</option>
        <option value="beta">{t('channel_beta')}</option>
      </Select>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
          {t('update_schedule')}
        </span>
        <SchedulePicker
          idPrefix="updatesConfig"
          value={form.scheduleCron}
          onChange={(cron) => {
            setForm({ ...form, scheduleCron: cron });
            setIsDirty(true);
          }}
          {...(errors.scheduleCron === undefined ? {} : { error: errors.scheduleCron })}
        />
      </div>

      <Checkbox
        id="autoRestart"
        label={t('auto_restart')}
        checked={form.autoRestart}
        onChange={(e) => {
          setForm({ ...form, autoRestart: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Checkbox
        id="rollbackOnFailure"
        label={t('rollback_failure')}
        checked={form.rollbackOnFailure}
        onChange={(e) => {
          setForm({ ...form, rollbackOnFailure: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="healthTimeoutS"
        label={t('health_timeout')}
        type="number"
        value={form.healthTimeoutS}
        onChange={(e) => {
          setForm({ ...form, healthTimeoutS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.healthTimeoutS}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logging Settings
// ---------------------------------------------------------------------------

function LoggingSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<LoggingConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'logging' } }).then((data) =>
      setForm(data as LoggingConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('logging', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'logging' }, body: form })
      .then((data) => {
        setForm(data as LoggingConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Select
        id="logLevel"
        label={t('log_level')}
        value={form.level}
        onChange={(e) => {
          setForm({
            ...form,
            level: e.target.value as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
          });
          setIsDirty(true);
        }}
        error={errors.level}
      >
        <option value="trace">{t('log_trace')}</option>
        <option value="debug">{t('log_debug')}</option>
        <option value="info">{t('log_info')}</option>
        <option value="warn">{t('log_warn')}</option>
        <option value="error">{t('log_error')}</option>
        <option value="fatal">{t('log_fatal')}</option>
      </Select>

      <Input
        id="retainDays"
        label={t('retain_logs')}
        type="number"
        value={form.retainDays}
        onChange={(e) => {
          setForm({ ...form, retainDays: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.retainDays}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitoring Settings
// ---------------------------------------------------------------------------

function MonitoringSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<MonitoringConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'monitoring' } }).then((data) =>
      setForm(data as MonitoringConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('monitoring', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'monitoring' }, body: form })
      .then((data) => {
        setForm(data as MonitoringConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        id="sampleInterval"
        label={t('sample_interval')}
        type="number"
        value={form.sampleIntervalS}
        onChange={(e) => {
          setForm({ ...form, sampleIntervalS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.sampleIntervalS}
        className="w-64"
      />

      <Input
        id="diskWarnPct"
        label={t('disk_warn_threshold')}
        type="number"
        value={form.diskWarnPct}
        onChange={(e) => {
          setForm({ ...form, diskWarnPct: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.diskWarnPct}
        className="w-40"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Config Page
// ---------------------------------------------------------------------------

export function ConfigPage(): JSX.Element {
  const t = useTranslation('config');
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t('page_title')}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('page_subtitle')}</p>
      </div>
      <Card>
        <CardHeader title={t('settings_title')} />
        <CardBody>
          <Tabs
            items={[
              { id: 'shares', label: t('tab_shares'), content: <SharesSection /> },
              { id: 'sync', label: t('tab_sync'), content: <SyncSection /> },
              { id: 'locking', label: t('tab_locking'), content: <LockingSection /> },
              { id: 'versioning', label: t('tab_versioning'), content: <VersioningSection /> },
              { id: 'security', label: t('tab_security'), content: <SecuritySection /> },
              { id: 'updates', label: t('tab_updates'), content: <UpdatesSection /> },
              { id: 'logging', label: t('tab_logging'), content: <LoggingSection /> },
              { id: 'monitoring', label: t('tab_monitoring'), content: <MonitoringSection /> },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
