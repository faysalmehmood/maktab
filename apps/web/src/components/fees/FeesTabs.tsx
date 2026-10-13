import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { canCollect, canGenerate, canReadFees, canUseCash } from '@/lib/fees';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

/*
 * The Fees area as one place (PLAN 2026-10-13: Fees hub = Counter / Defaulters / Billing / Cash
 * tabs; Concessions, Sponsors, Fee register and Collection under "More"). Links, not ARIA tabs:
 * each is its own page and URL. Only the tabs the role's grants allow are shown.
 */
const TABS = [
  { to: '/fees/counter', label: 'fee.nav.counter', show: canCollect },
  { to: '/fees/defaulters', label: 'fee.nav.defaulters', show: canReadFees },
  { to: '/fees/billing', label: 'fee.nav.billing', show: canGenerate },
  { to: '/cash', label: 'fee.nav.cash', show: canUseCash },
] as const;

export function FeesTabs() {
  const { t } = useTranslation();
  const roles = useRoles();
  const { pathname } = useLocation();
  const tabs = TABS.filter((x) => x.show(roles));
  if (tabs.length < 2) return null;
  const onTab = tabs.some((x) => pathname === x.to);
  return (
    <nav
      aria-label={t('fee.nav.home')}
      className="-mt-2 flex gap-1 overflow-x-auto border-b [scrollbar-width:none] print:hidden"
      data-fees-tabs
    >
      {[
        ...tabs.map((x) => ({ to: x.to, label: t(x.label) })),
        { to: '/fees', label: t('shell.nav.more') },
      ].map((x) => {
        const on = x.to === '/fees' ? !onTab && pathname === '/fees' : pathname === x.to;
        return (
          <Link
            key={x.to}
            to={x.to}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'relative inline-flex min-h-ctl shrink-0 items-center px-3 text-sm font-semibold whitespace-nowrap text-muted-foreground hover:text-foreground',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
              on &&
                'text-brand after:absolute after:inset-x-2 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-brand',
            )}
          >
            {x.label}
          </Link>
        );
      })}
    </nav>
  );
}
