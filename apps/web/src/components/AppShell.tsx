import type { I18nKey } from '@maktab/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  CalendarCheck,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  Settings,
  Users,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
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
import { cn } from '@/lib/utils';
import { LanguageToggle } from './LanguageToggle';

type NavItem = { to: string; label: I18nKey; icon: LucideIcon };

export const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/students', label: 'nav.students', icon: Users },
  { to: '/attendance', label: 'nav.attendance', icon: CalendarCheck },
  { to: '/fees', label: 'nav.fees', icon: Wallet },
  { to: '/settings', label: 'nav.settings', icon: Settings },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav className="flex flex-col gap-1 p-2">
      {NAV.map(({ to, label, icon: Icon }) => (
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

  const signOut = async () => {
    await logout().catch(() => undefined);
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-e md:flex">
        <div className="px-5 py-4 text-lg font-semibold">{t('app.name')}</div>
        <NavList />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-2 md:px-4">
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
            <LanguageToggle />
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut aria-hidden className="rtl:-scale-x-100" />
              <span className="sr-only sm:not-sr-only">{t('auth.signOut')}</span>
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6">
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
