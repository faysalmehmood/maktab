import type { I18nKey, StaffRole } from '@maktab/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  CalendarCheck,
  ChartColumn,
  CloudOff,
  HandCoins,
  Layers,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  MessageSquareText,
  PiggyBank,
  ReceiptText,
  ScrollText,
  Settings,
  Users,
  Wallet,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { type GrantRef, holds, isTeacherOnly, useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { API_CACHE } from '@/offline/api-cache';
import { queueLogout } from '@/offline/logout';
import { resumeAfterSignIn, startAutoSync, useOutboxStatus } from '@/offline/sync';
import { SyncBanner } from './attendance/common';
import { LanguageToggle } from './LanguageToggle';

type NavItem = {
  to: string;
  label: I18nKey;
  icon: LucideIcon;
  /** Shown when the roles hold any of these MATRIX grants (the API's own rule for the page). */
  grants: readonly GrantRef[];
};

/** PLAN §3, derived from the shared MATRIX: each entry shows for the roles its page serves. */
export const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard, grants: [['self', 'read']] },
  { to: '/students', label: 'nav.students', icon: Users, grants: [['student', 'read']] },
  // Groups and registers: whoever reads attendance (office, and teachers for their own groups).
  { to: '/groups', label: 'nav.groups', icon: Layers, grants: [['attendance', 'read']] },
  {
    to: '/attendance',
    label: 'nav.attendance',
    icon: CalendarCheck,
    grants: [['attendance', 'read']],
  },
  { to: '/fees', label: 'nav.fees', icon: Wallet, grants: [['receipt', 'read']] },
  { to: '/cash', label: 'fee.nav.cash', icon: Banknote, grants: [['cash_session', 'read']] },
  {
    to: '/expenses',
    label: 'money.nav.expenses',
    icon: ReceiptText,
    grants: [['expense', 'read']],
  },
  { to: '/salary', label: 'money.nav.salary', icon: HandCoins, grants: [['payslip', 'prepare']] },
  { to: '/advances', label: 'money.nav.advances', icon: PiggyBank, grants: [['payslip', 'pay']] },
  { to: '/reports', label: 'money.nav.reports', icon: ChartColumn, grants: [['receipt', 'read']] },
  {
    to: '/messages',
    label: 'nav.sendQueue',
    icon: MessageSquareText,
    grants: [['message', 'read']],
  },
  { to: '/audit', label: 'money.nav.audit', icon: ScrollText, grants: [['audit', 'read']] },
  // Full settings for settings.manage; the office's "settings-lite" (account + school profile)
  // for whoever writes students.
  {
    to: '/settings',
    label: 'nav.settings',
    icon: Settings,
    grants: [
      ['settings', 'manage'],
      ['student', 'write'],
    ],
  },
];

/** The menu for a set of roles; teachers (only) see "My groups" instead of "Groups". */
export function navFor(roles: readonly StaffRole[]): NavItem[] {
  const items = NAV.filter((item) => item.grants.some((g) => holds(roles, g))).map((item) =>
    item.to === '/groups' && isTeacherOnly(roles)
      ? { ...item, label: 'nav.myGroups' as const }
      : item,
  );
  // Fee readers without money access (teachers: fee.read own_groups) get their groups' dues
  // summary instead of the fee office.
  if (holds(roles, ['fee', 'read']) && !holds(roles, ['receipt', 'read'])) {
    const at = items.findIndex((i) => i.to === '/messages');
    items.splice(at < 0 ? items.length : at, 0, {
      to: '/fees/defaulters',
      label: 'fee.nav.dues',
      icon: Wallet,
      grants: [['fee', 'read']],
    });
  }
  // Staff who read only their own payslip (teachers) get "My payslips".
  if (holds(roles, ['payslip', 'read']) && !holds(roles, ['payslip', 'prepare'])) {
    const at = items.findIndex((i) => i.to === '/settings');
    items.splice(at < 0 ? items.length : at, 0, {
      to: '/my/payslips',
      label: 'money.nav.myPayslips',
      icon: HandCoins,
      grants: [['payslip', 'read']],
    });
  }
  return items;
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const roles = useRoles();
  return (
    <nav className="flex flex-col gap-1 p-2">
      {navFor(roles).map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent',
              isActive && 'bg-accent text-accent-foreground',
            )
          }
        >
          <Icon className="size-5 shrink-0" aria-hidden />
          {t(label)}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * Phone-first: at 360 px the sidebar collapses into a sheet that opens from the start edge (left in
 * English, right in Urdu). From `md` up it is a fixed column.
 */
export function AppShell() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const outbox = useOutboxStatus();

  // Mounted only for a signed-in user (RequireAuth): a sync paused for re-authentication resumes,
  // and the online / visible / timer triggers start (PLAN §12 exp6).
  useEffect(() => {
    const stop = startAutoSync();
    resumeAfterSignIn().catch(() => undefined);
    return stop;
  }, []);

  const signOut = async () => {
    // Offline too: local state goes now, the server revocation waits in a queue (offline/logout.ts).
    void queueLogout();
    queryClient.clear();
    // The offline API copy (who I am, rosters) must not outlive the session on a shared phone.
    if (typeof caches !== 'undefined') await caches.delete(API_CACHE).catch(() => false);
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-dvh print:min-h-0">
      <aside className="hidden w-60 shrink-0 flex-col border-e md:flex print:hidden">
        <div className="px-5 py-4 text-lg font-semibold">{t('app.name')}</div>
        <NavList />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-2 md:px-4 print:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={t('nav.menu')}
            onClick={() => setOpen(true)}
          >
            <Menu aria-hidden />
          </Button>
          <span className="font-semibold md:hidden">{t('app.name')}</span>
          <div className="ms-auto flex items-center gap-2">
            {outbox.pending > 0 && (
              <span
                className="flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-950"
                title={t('attendance.pending', { n: outbox.pending })}
              >
                <CloudOff className="size-4" aria-hidden />
                <bdi className="num">{outbox.pending}</bdi>
                <span className="sr-only">{t('attendance.pending', { n: outbox.pending })}</span>
              </span>
            )}
            <LanguageToggle />
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut aria-hidden className="rtl:-scale-x-100" />
              <span className="sr-only sm:not-sr-only">{t('auth.signOut')}</span>
            </Button>
          </div>
        </header>
        <SyncBanner />
        <main className="flex-1 p-4 md:p-6 print:p-0">
          <Outlet />
        </main>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="start" className="w-72 p-0">
          <SheetHeader>
            <SheetTitle>{t('app.name')}</SheetTitle>
            <SheetDescription>{t('app.tagline')}</SheetDescription>
          </SheetHeader>
          <NavList onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
