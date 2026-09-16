import { type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { PRODUCT_NAME } from '../../shared';
import { useAuth } from '../hooks/useAuth';
import { useTranslation } from '../hooks/useTranslation';
import { NetworkApplyBanner } from './NetworkApplyBanner';
import { Button } from './ui/Button';
import { LanguagePickerButtons } from './LanguagePicker';
import { ThemeToggle } from './ui/ThemeToggle';
import { cn } from './ui/cn';

/**
 * `labelKey` rather than a label: the menu is rebuilt on every render, so resolving the
 * string here would freeze it in whichever language was active when this module loaded.
 *
 * Ordered by how often an operator needs it, not alphabetically: what the bridge is
 * serving, then what is happening on it, then what is being kept, then how it is set up.
 *
 * There is no Configuration entry. There was, holding eight tabs of settings that each
 * belonged to a page of their own — someone wanting to change the log level went to the
 * log page, found nothing, and had to know that a second place existed. Each of those
 * tabs now sits under the thing it governs, which is also the thing whose behaviour
 * explains it. Scheduling and Machines are gone outright: schedules are edited where the
 * job they run is configured, and the machines list only ever restated what the locks
 * and log pages already said, per connection and with more detail.
 */
const NAV_ITEMS = [
  { to: '/', labelKey: 'dashboard', end: true },
  { to: '/shares', labelKey: 'shares' },
  { to: '/files', labelKey: 'files' },
  { to: '/locks', labelKey: 'locks' },
  { to: '/versions', labelKey: 'versions' },
  { to: '/monitoring', labelKey: 'monitoring' },
  { to: '/logs', labelKey: 'logs' },
  // Its own entry rather than a tab in Configuration: it is the first page of a new
  // install, the one an operator returns to when the bridge is unreachable, and the
  // only one that can take the interface away while it is being used.
  { to: '/network', labelKey: 'network' },
  { to: '/security', labelKey: 'security' },
  { to: '/system-updates', labelKey: 'updates' },
] as const;

export function Layout({ children }: { readonly children: ReactNode }): JSX.Element {
  const { logout } = useAuth();
  const t = useTranslation('navigation');
  const navigate = useNavigate();

  const handleLogout = (): void => {
    void logout().then(() => navigate('/login', { replace: true }));
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/*
        Sticky and viewport-tall from `md` up.

        Without it the aside is simply a flex child that grows to the height of the
        page, so on a long page — the log viewer, a share list — the footer with the
        theme toggle, language and logout sat somewhere far below the fold. They are
        controls, not content: they have to stay where they were put. The nav scrolls
        on its own if it ever outgrows the viewport, which keeps the footer pinned to
        the bottom either way.
      */}
      <aside className="flex shrink-0 flex-col border-b border-border bg-white md:sticky md:top-0 md:h-screen md:w-56 md:border-b-0 md:border-r dark:border-border-dark dark:bg-surface-dark-subtle">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="text-lg" aria-hidden="true">
            🌉
          </span>
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {PRODUCT_NAME}
          </span>
        </div>
        <nav className="flex flex-1 flex-row gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-y-auto">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={({ isActive }) =>
                cn(
                  'whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )
              }
            >
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
        {/* No account name here: this appliance has one login and no user management, so
          the line only ever said "admin" — a word that told an operator nothing and
          took up the space the controls beneath it needed. */}
        <div className="shrink-0 border-t border-border px-4 py-3 dark:border-border-dark">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                {t('logout')}
              </Button>
            </div>
            <LanguagePickerButtons />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">
        {/*
          Above every page, not only the network form.

          This is the screen an operator reaches after a network change has cut their
          connection: new address, fresh certificate warning, fresh login. Whatever page
          that login drops them on, the countdown has to be in front of them — it is the
          only thing standing between a working configuration and an automatic rollback,
          and it renders nothing at all when there is no pending change.
        */}
        <NetworkApplyBanner />
        {children}
      </main>
    </div>
  );
}
