import { type I18nKey, STAFF_ROLES, type StaffRole } from '@maktab/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  CalendarCheck,
  CloudOff,
  Layers,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  MessageSquareText,
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
import { logout } from '@/lib/api';
import { isTeacherOnly, useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { API_CACHE } from '@/offline/api-cache';
import { resumeAfterSignIn, startAutoSync, useOutboxStatus } from '@/offline/sync';
import { SyncBanner } from './attendance/common';
import { LanguageToggle } from './LanguageToggle';

type NavItem = { to: string; label: I18nKey; icon: LucideIcon; roles: readonly StaffRole[] };

const OFFICE = ['owner', 'admin'] as const;

/** PLAN §3: owner/admin see everything; a teacher sees their groups; an accountant students. */
export const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard, roles: STAFF_ROLES },
  {
    to: '/students',
    label: 'nav.students',
    icon: Users,
    roles: ['owner', 'admin', 'accountant', 'teacher'],
  },
  { to: '/groups', label: 'nav.groups', icon: Layers, roles: [...OFFICE, 'teacher'] },
  {
    to: '/attendance',
    label: 'nav.attendance',
    icon: CalendarCheck,
    roles: [...OFFICE, 'teacher'],
  },
  { to: '/fees', label: 'nav.fees', icon: Wallet, roles: [...OFFICE, 'accountant'] },
  { to: '/cash', label: 'fee.nav.cash', icon: Banknote, roles: [...OFFICE, 'accountant'] },
  {
    to: '/messages',
    label: 'nav.sendQueue',
    icon: MessageSquareText,
    roles: ['owner', 'admin', 'accountant', 'teacher'],
  },
  { to: '/settings', label: 'nav.settings', icon: Settings, roles: [...OFFICE, 'accountant'] },
];

/** The menu for a set of roles; teachers (only) see "My groups" instead of "Groups". */
export function navFor(roles: readonly StaffRole[]): NavItem[] {
  const items = NAV.filter((item) => item.roles.some((r) => roles.includes(r))).map((item) =>
    item.to === '/groups' && isTeacherOnly(roles)
      ? { ...item, label: 'nav.myGroups' as const }
      : item,
  );
  // A teacher (fee.read own_groups) sees their groups' dues summary, not the fee office.
  if (isTeacherOnly(roles) && !items.some((i) => i.to === '/fees'))
    items.splice(
      items.findIndex((i) => i.to === '/messages'),
      0,
      {
        to: '/fees/defaulters',
        label: 'fee.nav.dues',
        icon: Wallet,
        roles: ['teacher'],
      },
    );
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
    await logout().catch(() => undefined);
    queryClient.clear();
    // The offline API copy (who I am, rosters) must not outlive the session on a shared phone.
    if (typeof caches !== 'undefined') await caches.delete(API_CACHE).catch(() => false);
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-dvh">
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
