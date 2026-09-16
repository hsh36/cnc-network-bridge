import { useEffect, useState } from 'react';
import { type LoggingConfig } from '../../../shared';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Input';
import { FullPageSpinner } from '../ui/Spinner';
import { useTranslation } from '../../hooks/useTranslation';
import { api } from '../../lib/api-client';
import { useSaveBanner, validateConfigSection } from '../../lib/config-form';

export function LoggingSettings(): JSX.Element {
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
