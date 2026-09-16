import { useTranslation } from '../hooks/useTranslation';
import { SecuritySettings } from '../components/settings/SecuritySettings';
import { Card, CardBody } from '../components/ui/Card';

/**
 * Sessions, sign-in protection, TLS and the certificate.
 *
 * Its own entry rather than a tab, because this is the page an administrator is sent to
 * by an audit or an incident, and it is the one whose settings can lock them out of the
 * interface they are changing them in. Something reachable in one click is something
 * they can also undo in one click.
 */
export function SecurityPage(): JSX.Element {
  const t = useTranslation('security');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('subtitle')}</p>
      </div>

      <Card>
        <CardBody>
          <SecuritySettings />
        </CardBody>
      </Card>
    </div>
  );
}
