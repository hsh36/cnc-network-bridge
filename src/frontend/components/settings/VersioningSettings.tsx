import { useEffect, useState } from 'react';
import { type VersioningConfig } from '../../../shared';
import { Button } from '../ui/Button';
import { Checkbox, Input } from '../ui/Input';
import { FullPageSpinner } from '../ui/Spinner';
import { useTranslation } from '../../hooks/useTranslation';
import { api } from '../../lib/api-client';
import { useSaveBanner, validateConfigSection } from '../../lib/config-form';

export function VersioningSettings(): JSX.Element {
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
