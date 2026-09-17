import { useEffect, useState } from 'react';
import { type LockingConfig } from '../../../shared';
import { Button } from '../ui/Button';
import { Checkbox, Input, Select } from '../ui/Input';
import { FullPageSpinner } from '../ui/Spinner';
import { useTranslation } from '../../hooks/useTranslation';
import { api } from '../../lib/api-client';
import { useSaveBanner, validateConfigSection } from '../../lib/config-form';

export function LockingSettings(): JSX.Element {
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
        label={t('machine_lock_ttl')}
        type="number"
        value={form.machineLockTtlS}
        onChange={(e) => {
          setForm({ ...form, machineLockTtlS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.machineLockTtlS}
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
