import { useTranslation } from '../hooks/useTranslation';
import { SharesSection } from '../components/SharesSection';
import { MachineSmbGlobals } from '../components/MachineSmbGlobals';
import { SyncSettings } from '../components/settings/SyncSettings';
import { Collapsible } from '../components/ui/Collapsible';

/**
 * Shares, and everything that describes how they are served.
 *
 * Its own entry rather than a tab inside a Configuration page, because a share is the
 * thing this appliance exists to provide: on a bridge with one share, this page and the
 * dashboard are the only two an operator ever opens.
 *
 * The order is deliberate. The list comes first — that is what the page is *for*, and
 * each row opens a dialog holding everything that differs between shares: conflict mode,
 * bandwidth, scan interval, size limit, exclude patterns, read-only, and who may connect.
 * Below it sit the two things that cannot be per share and would otherwise have no home:
 * the `[global]` Samba parameters, which Samba reads once per server, and the handful of
 * sync values that describe the bridge rather than a share.
 */
export function SharesPage(): JSX.Element {
  const t = useTranslation('shares');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('subtitle')}</p>
      </div>

      {/*
        Settings above the list, folded away.

        They were at the bottom, which on a bridge with several shares meant scrolling
        past the whole table to reach them — and nothing on the way down said they were
        there at all. Folded, they cost one line each and announce themselves.
      */}
      <Collapsible title={t('sync_settings_title')} subtitle={t('sync_settings_hint')}>
        <SyncSettings />
      </Collapsible>

      <MachineSmbGlobals />

      <SharesSection />
    </div>
  );
}
