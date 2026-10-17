import type { I18nKey, MeResponse, MessageCountsDto, SchoolDto, StaffRole } from '@maktab/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarCheck,
  ChartColumn,
  ChevronsUpDown,
  CloudOff,
  HandCoins,
  House,
  Layers,
  LifeBuoy,
  LogOut,
  type LucideIcon,
  MessageSquareText,
  Monitor,
  Moon,
  MoreHorizontal,
  ReceiptText,
  ScrollText,
  Settings,
  Sun,
  Users,
  Wallet,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { getJson, useMe } from '@/lib/api';
import { useIdentity } from '@/lib/identity';
import { useIsPhone } from '@/lib/media';
import { useSchool } from '@/lib/queries';
import { type GrantRef, holds, isTeacherOnly, useRoles } from '@/lib/roles';
import { setThemePref, THEMES, type ThemePref, useBrand, useThemePref } from '@/lib/theme';
import { titleOverride } from '@/lib/title';
import { stopTour, tourFor, useActiveTour } from '@/lib/tour';
import { cn } from '@/lib/utils';
import { API_CACHE } from '@/offline/api-cache';
import { queueLogout } from '@/offline/logout';
import { resumeAfterSignIn, startAutoSync, useOutboxStatus } from '@/offline/sync';
import { SyncBanner } from './attendance/common';
import { Avatar } from './avatar';
import { RunsOnMaktab, SchoolChip, SchoolMark } from './brand/SchoolBadge';
import { GlobalSearch } from './GlobalSearch';
import { InstallBanner } from './InstallBanner';
import { LanguageToggle } from './LanguageToggle';
import { SegmentedControl } from './segmented';

export type NavGroup = 'home' | 'people' | 'daily' | 'money' | 'school';

type NavItem = {
  to: string;
  label: I18nKey;
  icon: LucideIcon;
  /** Sidebar heading this item sits under (presentation only; UI plan §5.3). */
  group: NavGroup;
  /** Shown when the roles hold any of these MATRIX grants (the API's own rule for the page). */
  grants: readonly GrantRef[];
};

/**
 * PLAN §3, derived from the shared MATRIX: each entry shows for the roles its page serves. Grouped
 * as in UI plan §5.3. Cash lives in the Fees area and Advances in Payroll (both pages link there),
 * so they only get their own entry for a role that cannot open Fees / Payroll.
 */
export const NAV: NavItem[] = [
  { to: '/', label: 'shell.nav.home', icon: House, group: 'home', grants: [['self', 'read']] },
  {
    to: '/students',
    label: 'nav.students',
    icon: Users,
    group: 'people',
    grants: [['student', 'read']],
  },
  // Groups and registers: whoever reads attendance (office, and teachers for their own groups).
  {
    to: '/groups',
    label: 'shell.nav.classes',
    icon: Layers,
    group: 'people',
    grants: [['attendance', 'read']],
  },
  {
    to: '/attendance',
    label: 'nav.attendance',
    icon: CalendarCheck,
    group: 'daily',
    grants: [['attendance', 'read']],
  },
  {
    to: '/messages',
    label: 'shell.nav.messages',
    icon: MessageSquareText,
    group: 'daily',
    grants: [['message', 'read']],
  },
  { to: '/fees', label: 'nav.fees', icon: Wallet, group: 'money', grants: [['receipt', 'read']] },
  {
    to: '/expenses',
    label: 'money.nav.expenses',
    icon: ReceiptText,
    group: 'money',
    grants: [['expense', 'read']],
  },
  {
    to: '/salary',
    label: 'shell.nav.payroll',
    icon: HandCoins,
    group: 'money',
    grants: [['payslip', 'prepare']],
  },
  {
    to: '/reports',
    label: 'money.nav.reports',
    icon: ChartColumn,
    group: 'money',
    grants: [['receipt', 'read']],
  },
  // Full settings for settings.manage; the office's "settings-lite" (account + school profile)
  // for whoever writes students.
  {
    to: '/settings',
    label: 'nav.settings',
    icon: Settings,
    group: 'school',
    grants: [
      ['settings', 'manage'],
      ['student', 'write'],
    ],
  },
  {
    to: '/audit',
    label: 'money.nav.audit',
    icon: ScrollText,
    group: 'school',
    grants: [['audit', 'read']],
  },
  // Help & guide: every staff role (the guide shows each role its own tasks).
  {
    to: '/guide',
    label: 'shell.nav.guide',
    icon: LifeBuoy,
    group: 'school',
    grants: [['self', 'read']],
  },
];

export const NAV_GROUPS: { id: Exclude<NavGroup, 'home'>; label: I18nKey }[] = [
  { id: 'people', label: 'shell.groups.people' },
  { id: 'daily', label: 'shell.groups.daily' },
  { id: 'money', label: 'shell.groups.money' },
  { id: 'school', label: 'shell.groups.school' },
];

/** The menu for a set of roles, in sidebar order; teachers (only) see "My groups". */
export function navFor(roles: readonly StaffRole[]): NavItem[] {
  const items = NAV.filter((item) => item.grants.some((g) => holds(roles, g))).map((item) =>
    item.to === '/groups' && isTeacherOnly(roles)
      ? { ...item, label: 'nav.myGroups' as const }
      : item,
  );
  const insertBefore = (before: string, item: NavItem) => {
    const at = items.findIndex((i) => i.to === before || i.group === 'school');
    items.splice(at < 0 ? items.length : at, 0, item);
  };
  // Cash drawer under Fees (a tab there); its own entry only without Fees.
  if (holds(roles, ['cash_session', 'read']) && !holds(roles, ['receipt', 'read']))
    insertBefore('/settings', {
      to: '/cash',
      label: 'fee.nav.cash',
      icon: Wallet,
      group: 'money',
      grants: [['cash_session', 'read']],
    });
  // Advances under Payroll; its own entry only without Payroll.
  if (holds(roles, ['payslip', 'pay']) && !holds(roles, ['payslip', 'prepare']))
    insertBefore('/settings', {
      to: '/advances',
      label: 'money.nav.advances',
      icon: HandCoins,
      group: 'money',
      grants: [['payslip', 'pay']],
    });
  // Fee readers without money access (teachers: fee.read own_groups) get their groups' dues
  // summary instead of the fee office.
  if (holds(roles, ['fee', 'read']) && !holds(roles, ['receipt', 'read']))
    insertBefore('/settings', {
      to: '/fees/defaulters',
      label: 'fee.nav.dues',
      icon: Wallet,
      group: 'money',
      grants: [['fee', 'read']],
    });
  // Staff who read only their own payslip (teachers) get "My payslips".
  if (holds(roles, ['payslip', 'read']) && !holds(roles, ['payslip', 'prepare']))
    insertBefore('/settings', {
      to: '/my/payslips',
      label: 'money.nav.myPayslips',
      icon: HandCoins,
      group: 'money',
      grants: [['payslip', 'read']],
    });
  return items;
}

/** Sidebar sections: Home on its own, then each heading with its items (empty ones dropped). */
export function navGroups(roles: readonly StaffRole[]) {
  const items = navFor(roles);
  return {
    home: items.filter((i) => i.group === 'home'),
    groups: NAV_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.id) })).filter(
      (g) => g.items.length > 0,
    ),
  };
}

/**
 * The phone's bottom bar (UI plan §5.3, PLAN 2026-10-13): the role's daily tasks, then "More".
 * Office: Home, Attendance, Fees, Messages. Teacher: Home, Attendance, Messages. Only what the
 * role's menu has; everything else is under More.
 */
const TAB_PATHS = ['/', '/attendance', '/fees', '/messages'] as const;
export function bottomTabs(roles: readonly StaffRole[]): NavItem[] {
  const items = navFor(roles);
  return TAB_PATHS.flatMap((p) => items.filter((i) => i.to === p));
}

/**
 * Messages waiting, for the menu badge. Same query (key and URL) as useMessageCounts in
 * lib/messages, inlined so the first load does not pull the messaging module.
 */
function useWaitingMessages(roles: readonly StaffRole[]): number {
  const counts = useQuery({
    queryKey: ['message-counts'],
    queryFn: () => getJson<MessageCountsDto>('/api/messages/counts'),
    enabled: holds(roles, ['message', 'read']),
  });
  return counts.data?.queued ?? 0;
}

function CountPill({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        'num rounded-full bg-warn-soft px-1.5 text-[11px] leading-[18px] font-bold text-warn',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

function SideLink({
  item,
  count,
  onNavigate,
}: {
  item: NavItem;
  count?: number;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'relative flex min-h-ctl items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-side-fg transition-colors motion-reduce:transition-none hover:bg-side-on hover:text-white',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white',
          isActive &&
            'bg-side-on text-white before:absolute before:inset-y-1.5 before:start-0 before:w-[3px] before:rounded-full before:bg-brand',
        )
      }
    >
      <Icon className="size-[18px] shrink-0" aria-hidden />
      <span className="truncate">{t(item.label)}</span>
      {count ? <CountPill n={count} className="ms-auto" /> : null}
    </NavLink>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const roles = useRoles();
  const waiting = useWaitingMessages(roles);
  const { home, groups } = navGroups(roles);
  return (
    <nav aria-label={t('nav.menu')} className="flex flex-col gap-1 px-2.5 pb-3">
      {home.map((i) => (
        <SideLink key={i.to} item={i} onNavigate={onNavigate} />
      ))}
      {groups.map((g) => (
        <div key={g.id} className="mt-2 flex flex-col gap-0.5">
          <h3 className="px-2.5 pt-1 pb-1 text-meta font-semibold text-side-mut">{t(g.label)}</h3>
          {g.items.map((i) => (
            <SideLink
              key={i.to}
              item={i}
              count={i.to === '/messages' ? waiting : undefined}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

/** The school in front (UI plan §6.4): badge or logo, name, city. Maktab before setup. */
export function SchoolIdentity({
  school,
  size = 36,
  compact = false,
}: {
  school: SchoolDto | null | undefined;
  size?: number;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const name =
    (i18n.language === 'ur' && school?.name_ur ? school.name_ur : school?.name) || t('app.name');
  const logo = school?.has_logo ? '/api/school/logo' : null;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <SchoolMark
        school={{
          name: school?.name ?? 'Maktab',
          short_name: school?.short_name ?? (school ? null : 'M'),
          brand_color: school?.brand_color,
        }}
        logoSrc={logo}
        size={size}
      />
      {!compact && (
        <span className="flex min-w-0 flex-col">
          <span className="line-clamp-2 leading-tight font-semibold text-white">
            <bdi>{name}</bdi>
          </span>
          {school?.city && (
            <span className="truncate text-meta text-side-mut">
              <bdi>{school.city}</bdi>
            </span>
          )}
        </span>
      )}
    </span>
  );
}

const TourRunner = lazy(() => import('@/guide/TourRunner'));

/** The running "Show me" tour, if any (the engine loads only when a tour starts). */
function TourHost() {
  const running = useActiveTour();
  const active = tourFor(running, useMe().data?.user.id);
  // A tour left over from another account (or from before sign-out) ends here.
  useEffect(() => {
    if (running && !active) stopTour();
  }, [running, active]);
  if (!active) return null;
  return (
    <Suspense fallback={null}>
      <TourRunner key={active.key} task={active.task} />
    </Suspense>
  );
}

const THEME_ICON: Record<ThemePref, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

/** Light / dark / match the phone, as one segmented control (account menu and More sheet). */
export function ThemeSwitch() {
  const { t } = useTranslation();
  const [pref] = useThemePref();
  return (
    <SegmentedControl
      id="theme-switch"
      label={t('shell.account.theme')}
      value={pref}
      onChange={setThemePref}
      options={THEMES.map((th) => ({
        value: th,
        label: t(`shell.account.themes.${th}`),
        icon: THEME_ICON[th],
      }))}
    />
  );
}

/** Who is signed in: initials, name, first role. */
function Who({ me, light = false }: { me: MeResponse | undefined; light?: boolean }) {
  const { t } = useTranslation();
  const name = me?.user.name || me?.user.email || '';
  const role = me?.roles[0];
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-start">
      <Avatar name={name} size="sm" tone={light ? 'brand' : 'side'} />
      <span className="flex min-w-0 flex-col">
        <span className={cn('truncate text-sm font-semibold', !light && 'text-white')}>
          <bdi>{name}</bdi>
        </span>
        {role && (
          <span
            className={cn('truncate text-meta', light ? 'text-muted-foreground' : 'text-side-mut')}
          >
            {t(`staff.roles.${role}`)}
          </span>
        )}
      </span>
    </span>
  );
}

/** Desktop account menu at the foot of the sidebar: language, theme, sign out. */
function AccountMenu({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useTranslation();
  const me = useMe().data;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {open && (
        <div
          id="account-menu"
          // Wider than the 240 px sidebar: at its width the theme options truncated to "A…".
          className="absolute start-0 bottom-full z-30 mb-2 flex w-72 flex-col gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-meta font-semibold text-muted-foreground">
              {t('common.language')}
            </span>
            <LanguageToggle />
          </div>
          <ThemeSwitch />
          <Button variant="outline" className="justify-start" onClick={onSignOut}>
            <LogOut aria-hidden className="rtl:-scale-x-100" />
            {t('auth.signOut')}
          </Button>
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="account-menu"
        aria-label={t('shell.account.menu')}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-side-on focus-visible:outline-2 focus-visible:outline-white"
      >
        <Who me={me} />
        <ChevronsUpDown className="ms-auto size-4 shrink-0 text-side-mut" aria-hidden />
      </button>
    </div>
  );
}

/** Top-bar state of this phone's queue: saved, waiting (with count), or offline. */
function SyncState() {
  const { t } = useTranslation();
  const outbox = useOutboxStatus();
  const waiting = outbox.pending > 0;
  const offline = outbox.offline;
  // One live region that stays mounted, so a change (saved → waiting → offline) is announced.
  return (
    <span
      id="sync-state"
      data-tour="sync-state"
      aria-live="polite"
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-meta',
        waiting
          ? 'rounded-full bg-warn-soft px-2.5 py-1 font-semibold text-warn'
          : 'text-muted-foreground',
      )}
      title={waiting ? t('attendance.pending', { n: outbox.pending }) : undefined}
    >
      {waiting ? (
        <>
          <CloudOff className="size-4" aria-hidden />
          <bdi className="num" aria-hidden>
            {outbox.pending}
          </bdi>
          <span className="sr-only">{t('attendance.pending', { n: outbox.pending })}</span>
        </>
      ) : (
        <>
          <i className={cn('size-2 rounded-full', offline ? 'bg-bad' : 'bg-ok')} aria-hidden />
          <span className={cn(!offline && 'sr-only md:not-sr-only')}>
            {offline ? t('shell.sync.offline') : t('shell.sync.saved')}
          </span>
        </>
      )}
    </span>
  );
}

function TabLink({ item, count }: { item: NavItem; count?: number }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-muted-foreground',
          isActive && 'text-brand',
        )
      }
    >
      <Icon className="size-5" aria-hidden />
      <span className="max-w-full truncate px-0.5">{t(item.label)}</span>
      {count ? <CountPill n={count} className="absolute top-1 start-[calc(50%+4px)]" /> : null}
    </NavLink>
  );
}

/**
 * The app frame (UI plan §5.3). Desktop: the school's sidebar (identity, grouped menu, account
 * menu, "Runs on Maktab") and a top bar with student search and the sync state. Phone: a top bar
 * with the badge and search, a bottom tab bar with the role's daily tasks and "More" (a sheet with
 * the rest and the account). In Urdu the whole frame mirrors (<html dir="rtl">).
 */
/** The public demo (DEMO_MODE=1): a thin strip on every screen, in the page's language. */
function DemoBanner() {
  const { t } = useTranslation();
  const demo = useIdentity().data?.demo;
  if (!demo) return null;
  return (
    <p
      id="demo-banner"
      role="note"
      className="bg-warn-soft px-3 py-1.5 text-center text-sm text-warn md:px-6 print:hidden"
    >
      {t('demo.banner')}
    </p>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const [more, setMore] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const outbox = useOutboxStatus();
  const roles = useRoles();
  const me = useMe().data;
  const school = useSchool().data?.school;
  useBrand(school === undefined ? undefined : (school?.brand_color ?? null));
  const waiting = useWaitingMessages(roles);
  const tabs = bottomTabs(roles);
  const { home, groups } = navGroups(roles);
  const tabPaths = new Set(tabs.map((i) => i.to));
  const moreActive =
    location.pathname !== '/' &&
    !tabs.some((i) => i.to !== '/' && location.pathname.startsWith(i.to));

  // Browser tab: short name first (UI plan §6.4).
  useEffect(() => {
    const short = school?.short_name || school?.name;
    if (titleOverride()) return;
    document.title = short ? `${short} · ${t('app.name')}` : t('app.name');
  }, [school?.short_name, school?.name, t]);

  // Mounted only for a signed-in user (RequireAuth): a sync paused for re-authentication resumes,
  // and the online / visible / timer triggers start (PLAN §12 exp6).
  useEffect(() => {
    const stop = startAutoSync();
    resumeAfterSignIn().catch(() => undefined);
    return stop;
  }, []);

  const [unsentConfirm, setUnsentConfirm] = useState(false);
  const signOut = async () => {
    // Offline too: local state goes now; the server revocation of *this* session waits in a queue
    // (offline/logout.ts) bound to this session's logout token.
    const me = queryClient.getQueryData<MeResponse>(['me']);
    void queueLogout(me?.logout_token);
    stopTour();
    queryClient.clear();
    // The offline API copy (who I am, rosters) must not outlive the session on a shared phone.
    if (typeof caches !== 'undefined') await caches.delete(API_CACHE).catch(() => false);
    navigate('/login', { replace: true });
  };
  // Registers this user saved but has not sent: only they can send them, so ask first.
  const requestSignOut = () => {
    setMore(false);
    if (outbox.pending + outbox.failed > 0) setUnsentConfirm(true);
    else void signOut();
  };

  // Sticky action bars (attendance Save, setup Next/Back) sit above the phone tab bar: they read
  // `bottom: var(--tabbar-h, 0px)`. Tab bar = min-h-14 (3.5rem) + the home-indicator inset.
  const phone = useIsPhone();
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      '--tabbar-h',
      phone ? 'calc(3.5rem + env(safe-area-inset-bottom, 0px))' : '0px',
    );
    return () => {
      root.style.removeProperty('--tabbar-h');
    };
  }, [phone]);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:rounded-md focus:bg-card focus:p-3"
      >
        {t('shell.skip')}
      </a>
      <div className="flex min-h-dvh print:block print:min-h-0">
        <aside
          id="sidebar"
          className="hidden w-60 shrink-0 bg-side text-side-fg md:block print:hidden"
        >
          <div className="sticky top-0 flex h-dvh flex-col">
            <NavLink
              to="/"
              className="flex items-center px-4 pt-4 pb-3 focus-visible:outline-2 focus-visible:outline-white"
            >
              <SchoolIdentity school={school} />
            </NavLink>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SidebarNav />
            </div>
            <div className="border-t border-side-on p-2.5">
              <AccountMenu onSignOut={requestSignOut} />
              <RunsOnMaktab className="px-2 pt-2 text-side-mut" />
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <DemoBanner />
          <header
            data-tour-bar
            className="sticky top-0 z-20 flex min-h-14 items-center gap-2 border-b bg-card px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-6 print:hidden"
          >
            {/* Phone: badge + short name (+ city when it fits); the whole chip is a 44 px link. */}
            <NavLink
              to="/"
              id="topbar-school"
              className="-ms-1.5 flex min-h-11 max-w-[9.5rem] min-w-11 shrink-0 items-center rounded-lg px-1.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring md:hidden"
              aria-label={t('shell.nav.home')}
            >
              <SchoolChip
                school={{
                  name: school?.name ?? t('app.name'),
                  short_name: school?.short_name ?? (school ? null : 'M'),
                  brand_color: school?.brand_color,
                }}
                logoSrc={school?.has_logo ? '/api/school/logo' : null}
                city={school?.city}
              />
            </NavLink>
            <GlobalSearch />
            <div className="ms-auto flex items-center gap-2">
              <SyncState />
            </div>
          </header>
          <InstallBanner />
          <SyncBanner />
          <main id="main" className="flex-1 p-4 pb-24 md:p-6 md:pb-8 print:p-0">
            <Outlet />
          </main>
        </div>
      </div>

      <nav
        id="tabbar"
        aria-label={t('nav.menu')}
        className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
      >
        {tabs.map((i) => (
          <TabLink key={i.to} item={i} count={i.to === '/messages' ? waiting : undefined} />
        ))}
        <button
          type="button"
          onClick={() => setMore(true)}
          aria-expanded={more}
          className={cn(
            'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-muted-foreground',
            moreActive && 'text-brand',
          )}
        >
          <MoreHorizontal className="size-5" aria-hidden />
          {t('shell.nav.more')}
        </button>
      </nav>

      {unsentConfirm && (
        <Dialog open onOpenChange={(o) => !o && setUnsentConfirm(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('auth.unsentTitle')}</DialogTitle>
              <DialogDescription>
                {t('auth.unsentBody', { count: outbox.pending + outbox.failed })}
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm">{t('auth.unsentHint')}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUnsentConfirm(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setUnsentConfirm(false);
                  void signOut();
                }}
              >
                {t('auth.signOutAnyway')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <TourHost />

      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] gap-2 overflow-y-auto rounded-t-2xl bg-card p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="pb-0">
            <SheetTitle>{t('shell.nav.moreTitle')}</SheetTitle>
            <SheetDescription className="sr-only">{t('app.tagline')}</SheetDescription>
          </SheetHeader>
          <nav aria-label={t('shell.nav.more')} className="flex flex-col gap-1 px-3">
            {[{ id: 'home', label: null, items: home }, ...groups].map((g) => {
              const rest = g.items.filter((i) => !tabPaths.has(i.to));
              if (rest.length === 0) return null;
              return (
                <div key={g.id} className="flex flex-col">
                  {g.label && (
                    <h3 className="px-3 pt-2 pb-1 text-meta font-semibold text-muted-foreground">
                      {t(g.label)}
                    </h3>
                  )}
                  <div className="grid grid-cols-2 gap-1">
                    {rest.map((i) => {
                      const Icon = i.icon;
                      return (
                        <NavLink
                          key={i.to}
                          to={i.to}
                          onClick={() => setMore(false)}
                          className={({ isActive }) =>
                            cn(
                              'flex min-h-12 items-center gap-2.5 rounded-lg px-3 text-sm font-semibold hover:bg-accent',
                              isActive && 'bg-brand-soft text-brand',
                            )
                          }
                        >
                          <Icon className="size-5 shrink-0" aria-hidden />
                          <span className="truncate">{t(i.label)}</span>
                        </NavLink>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>
          <div className="mt-2 flex flex-col gap-3 border-t px-4 pt-3 pb-4">
            <div className="flex items-center gap-2">
              <Who me={me} light />
              <div className="ms-auto">
                <LanguageToggle />
              </div>
            </div>
            <ThemeSwitch />
            <Button variant="outline" onClick={requestSignOut}>
              <LogOut aria-hidden className="rtl:-scale-x-100" />
              {t('auth.signOut')}
            </Button>
            <RunsOnMaktab className="justify-center text-muted-foreground" />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
