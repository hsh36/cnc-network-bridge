import { type ReactNode } from 'react';
import { cn } from './cn';

/**
 * A section that is folded away until someone asks for it.
 *
 * Built on `<details>`/`<summary>` rather than a `useState` toggle: the browser gives
 * keyboard operation, the open/closed state in the accessibility tree, and find-in-page
 * that opens the section it matched inside — all of which a div with an onClick has to
 * reimplement and usually does not.
 *
 * ## The marker is ours
 *
 * The native triangle is removed and replaced with a chevron that rotates. Two reasons:
 * the native marker renders differently in every browser and cannot be styled to match
 * the rest of the interface, and — the reason it matters here — it is small and easy to
 * miss. The complaint that prompted this was not "I cannot open these sections", it was
 * "I could not see that they open".
 *
 * ## Why closed is the default
 *
 * These hold the settings that have a working default and are changed rarely: bandwidth
 * ceilings, scan intervals, exclude patterns. Shown open, they bury the two fields that
 * actually have to be filled in — the server path and the share name — under a screenful
 * of things nobody is going to touch. A form that looks like it needs twenty answers is
 * a form people put off.
 */
export function Collapsible({
  title,
  subtitle,
  defaultOpen = false,
  children,
  className,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  /** Open on first render. The state is the browser's from then on. */
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <details
      open={defaultOpen}
      className={cn(
        'group rounded-md border border-border dark:border-border-dark',
        // `open:` has no Tailwind variant, so the open state is read off the parent.
        '[&[open]>summary>svg]:rotate-90',
        className,
      )}
    >
      <summary
        className={cn(
          'flex cursor-pointer select-none items-center gap-2 px-3 py-2',
          'text-sm font-medium text-slate-700 dark:text-slate-300',
          'hover:bg-slate-50 dark:hover:bg-slate-800/50',
          // The default triangle, removed in the two ways browsers spell it.
          'list-none [&::-webkit-details-marker]:hidden',
        )}
      >
        <svg
          viewBox="0 0 12 12"
          className="h-3 w-3 shrink-0 text-slate-400 transition-transform duration-150 dark:text-slate-500"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 2l4 4-4 4" />
        </svg>
        <span className="min-w-0 flex-1">
          {title}
          {subtitle !== undefined && (
            <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400">
              {subtitle}
            </span>
          )}
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border p-3 dark:border-border-dark">
        {children}
      </div>
    </details>
  );
}
