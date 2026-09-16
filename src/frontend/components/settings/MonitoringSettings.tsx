import { useEffect, useState } from 'react';
import { type MonitoringConfig } from '../../../shared';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { FullPageSpinner } from '../ui/Spinner';
import { useTranslation } from '../../hooks/useTranslation';
import { api } from '../../lib/api-client';
import { useSaveBanner, validateConfigSection } from '../../lib/config-form';

export function MonitoringSettings(): JSX.Element {
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
