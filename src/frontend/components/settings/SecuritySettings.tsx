import { useEffect, useState } from 'react';
import { type SecurityConfig } from '../../../shared';
import { Button } from '../ui/Button';
import { Checkbox, Input, Select } from '../ui/Input';
import { FullPageSpinner } from '../ui/Spinner';
import { CertificateManager } from '../CertificateManager';
import { useTranslation } from '../../hooks/useTranslation';
import { api } from '../../lib/api-client';
import { useSaveBanner, validateConfigSection } from '../../lib/config-form';

export function SecuritySettings(): JSX.Element {
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
      {/*
        First, and above the session fields, because it is the one setting on this page an
        operator comes looking for: the name in the address bar has to be the name on the
        certificate, and on a site with a DNS record that is not the machine's hostname.
      */}
      <Input
        id="certificateName"
        label={t('certificate_name')}
        hint={t('certificate_name_hint')}
        placeholder={t('certificate_name_placeholder')}
        value={form.certificateName}
        onChange={(e) => {
          setForm({ ...form, certificateName: e.target.value.trim() });
          setIsDirty(true);
        }}
        error={errors.certificateName}
        className="w-full sm:w-96"
      />

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
