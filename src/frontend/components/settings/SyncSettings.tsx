import { useEffect, useState } from 'react';
import { type SyncConfig } from '../../../shared';
import { Button } from '../ui/Button';
import { Checkbox, Input } from '../ui/Input';
import { FullPageSpinner } from '../ui/Spinner';
import { useTranslation } from '../../hooks/useTranslation';
import { api } from '../../lib/api-client';
import { useSaveBanner, validateConfigSection } from '../../lib/config-form';

/**
 * The sync settings that are one value for the whole appliance.
 *
 * Conflict mode, bandwidth limit, maximum file size, scan interval and exclude patterns
 * are *not* here, though the config section still carries them: they exist per share,
 * on the share itself, and that is the copy the sync engine reads. Offering them twice
 * meant two fields for one behaviour with no way to tell which won — and the global one
 * never did.
 *
 * What is left is what genuinely describes this bridge rather than one share: how close
 * two timestamps have to be before they count as the same, whether a deletion is carried
 * across, and how many transfers run at once.
 */
export function SyncSettings(): JSX.Element {
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

      <div className="flex flex-col gap-1">
        <Checkbox
          id="protectDeletes"
          label={t('protect_deletes')}
          checked={form.protectDeletes}
          onChange={(e) => {
            setForm({ ...form, protectDeletes: e.target.checked });
            setIsDirty(true);
          }}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('protect_deletes_hint')}</p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}
