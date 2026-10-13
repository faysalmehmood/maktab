import {
  type CashSessionDto,
  type FirstWeekDto,
  formatPkPhone,
  type MessageListDto,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarCheck,
  CheckCircle2,
  Circle,
  CircleAlert,
  MessageSquareText,
  RotateCw,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { DayOffNote, TodayList } from '@/components/attendance/parts';
import { useFeeDashboard } from '@/components/fees/DashboardTiles';
import { Num } from '@/components/form';
import { MonthTiles } from '@/components/money/MonthTiles';
import {
  GoLink,
  ListRow,
  ListSkeleton,
  Mny,
  Page,
  PageHeader,
  Panel,
  RowList,
  Skeleton,
  StatusBadge,
  type Tone,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import '@/i18n/screens';
import { getJson, sendJson, useMe } from '@/lib/api';
import {
  canCorrect,
  canReadAttendance,
  registerPath,
  useDashboardToday,
  useToday,
} from '@/lib/attendance';
import { alarmHint, canManageBackup, useLatestAlarm } from '@/lib/backup';
import { longDate } from '@/lib/dates';
import { canCollect, canGenerate, canReadMoney, canUseCash, karachiToday } from '@/lib/fees';
import { useOnline } from '@/lib/media';
import { canReadMessages, useMessageCounts } from '@/lib/messages';
import { useSchool } from '@/lib/queries';
import { canManageRoles, useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

/** Hour of day on the school clock (Asia/Karachi, UTC+5, no DST). */
const karachiHour = (now = Date.now()) => new Date(now + 5 * 3600_000).getUTCHours();

export { longDate } from '@/lib/dates';

function Greeting({ action }: { action?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const me = useMe().data;
  const h = karachiHour();
  const key = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const first = (me?.user.name || me?.user.email || '').split(/\s+/)[0] ?? '';
  return (
    <PageHeader
      title={t(`home.greeting.${key}`, { name: first })}
      subtitle={longDate(karachiToday(), i18n.language)}
      actions={action}
    />
  );
}

/** A "today" card: title, one figure, detail, one action at the foot. */
function TodayCard({
  id,
  title,
  figure,
  children,
  action,
}: {
  id: string;
  title: ReactNode;
  figure: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      id={id}
      className="flex flex-col gap-2.5 rounded-xl border bg-card p-4"
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <h2 className="text-section font-semibold">{title}</h2>
      <p className="text-[1.75rem] leading-tight font-bold tracking-tight">{figure}</p>
      {children}
      {action && <div className="mt-auto pt-1">{action}</div>}
    </section>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-hidden data-skeleton>
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="mt-4 h-9 w-1/2" />
    </div>
  );
}

type QueryLike = {
  isError: boolean;
  isPending: boolean;
  isSuccess: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => unknown;
};

/**
 * What a home figure can honestly say: still loading, failed (an error, or stuck waiting for a
 * connection), or ready. Disabled queries (a grant the role lacks) are left out by the caller.
 */
export function loadState(
  qs: readonly QueryLike[],
  offline = false,
): 'loading' | 'failed' | 'offline' | 'ready' {
  if (qs.some((q) => q.isError)) return 'failed';
  if (qs.some((q) => q.isPending && q.fetchStatus === 'paused')) return 'offline';
  if (qs.some((q) => q.isPending)) return offline ? 'offline' : 'loading';
  return 'ready';
}

/** A today card that could not load: its title, what went wrong, and Try again. */
function CardError({ id, title, query }: { id: string; title: string; query: QueryLike }) {
  const { t } = useTranslation();
  const offline = query.fetchStatus === 'paused';
  return (
    <section
      id={id}
      data-state="error"
      className="flex flex-col gap-2.5 rounded-xl border bg-card p-4"
      aria-label={title}
    >
      <h2 className="text-section font-semibold">{title}</h2>
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        {offline ? t('home.cardOffline') : t('home.cardError')}
      </p>
      <div className="mt-auto pt-1">
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          <RotateCw aria-hidden />
          {t('common.retry')}
        </Button>
      </div>
    </section>
  );
}

/** Registers today: n of N, one block per register (dashed = still to take), "Take <next>". */
function RegistersCard() {
  const { t } = useTranslation();
  const q = useDashboardToday(true);
  const d = q.data;
  if (!d && loadState([q]) !== 'loading')
    return <CardError id="home-registers" title={t('home.registers.title')} query={q} />;
  if (!d) return <CardSkeleton />;
  const { total, taken, not_taken } = d.registers;
  const next = not_taken[0];
  return (
    <TodayCard
      id="home-registers"
      title={t('home.registers.title')}
      figure={
        total === 0 ? (
          <span className="text-base font-medium text-muted-foreground">
            {d.day_off ? '—' : t('home.registers.none')}
          </span>
        ) : (
          <span>{t('home.registers.takenOf', { taken, total })}</span>
        )
      }
      action={
        next ? (
          <Button asChild>
            <Link to={registerPath(next.grp_id, d.date, next.grp_subject_id || null)}>
              <CalendarCheck aria-hidden />
              <bdi>
                {t('home.registers.take', {
                  name: `${next.programme_name} ${next.grp_name}${next.subject_name ? ` ${next.subject_name}` : ''}`,
                })}
              </bdi>
            </Link>
          </Button>
        ) : total > 0 ? (
          <p className="text-sm font-medium text-ok">{t('home.registers.allTaken')}</p>
        ) : null
      }
    >
      <DayOffNote dayOff={d.day_off} />
      {total > 0 && (
        <>
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(18px,1fr))] gap-1"
            aria-hidden
            data-pips
          >
            {Array.from({ length: total }, (_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: one block per register, by position
                key={i}
                className={cn(
                  'h-5 rounded-[5px]',
                  i < taken
                    ? 'bg-brand'
                    : 'border-[1.5px] border-dashed border-muted-foreground/70',
                )}
              />
            ))}
          </div>
          <p className="text-meta text-muted-foreground">{t('home.registers.help')}</p>
        </>
      )}
    </TodayCard>
  );
}

/** Money in today: total, split by method (bar + legend), open the counter. */
function CollectedCard() {
  const { t } = useTranslation();
  const roles = useRoles();
  const q = useFeeDashboard();
  const d = q.data;
  if (!d && loadState([q]) !== 'loading')
    return <CardError id="home-collected" title={t('home.collected.title')} query={q} />;
  if (!d) return <CardSkeleton />;
  const shades = ['bg-brand', 'bg-brand/60', 'bg-brand/35', 'bg-brand/20'];
  return (
    <TodayCard
      id="home-collected"
      title={t('home.collected.title')}
      figure={<Mny paisa={d.collected_total} />}
      action={
        canCollect(roles) && (
          <Button asChild variant="outline">
            <Link to="/fees/counter">
              <Wallet aria-hidden />
              {t('home.collected.open')}
            </Link>
          </Button>
        )
      }
    >
      {d.collected.length === 0 || d.collected_total <= 0 ? (
        <p className="text-sm text-muted-foreground">{t('home.collected.nothing')}</p>
      ) : (
        <>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {d.collected.map((c, i) => (
              <span
                key={c.method}
                className={shades[i % shades.length]}
                style={{ flexGrow: Math.max(c.amount, 0) }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
            {d.collected.map((c, i) => (
              <li key={c.method} className="flex items-center gap-1.5">
                <i className={cn('size-2 rounded-[2px]', shades[i % shades.length])} aria-hidden />
                {t(`fee.methods.${c.method}`)} <Mny paisa={c.amount} className="font-medium" />
              </li>
            ))}
          </ul>
        </>
      )}
    </TodayCard>
  );
}

/** The send queue: how many wait, by kind; start sending. */
function MessagesCard() {
  const { t } = useTranslation();
  const q = useMessageCounts();
  const c = q.data;
  if (!c && loadState([q]) !== 'loading')
    return <CardError id="dash-messages" title={t('home.messages.title')} query={q} />;
  if (!c) return <CardSkeleton />;
  const kinds = Object.entries(c.by_template).filter(([, n]) => n > 0);
  return (
    <TodayCard
      id="dash-messages"
      title={t('home.messages.title')}
      figure={<span>{t('home.messages.waiting', { n: c.queued })}</span>}
      action={
        c.queued > 0 && (
          <Button asChild variant="outline">
            <Link to="/messages">
              <MessageSquareText aria-hidden />
              {t('home.messages.start')}
            </Link>
          </Button>
        )
      }
    >
      {kinds.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('home.messages.none')}</p>
      ) : (
        // Messages, not people: "Absence · 1 message to send" in the info tone, so a chip is never
        // read as the number of absent children (that is the Absent today panel).
        <ul className="flex flex-wrap gap-1.5" aria-label={t('home.messages.byKind')}>
          {kinds.map(([k, n]) => (
            <li key={k} data-kind={k}>
              <StatusBadge tone="info">
                {t(`msg.templates.${k}` as 'msg.templates.notice')}
                {' · '}
                {t('home.messages.toSend', { count: n })}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}
    </TodayCard>
  );
}

const useOpenDrawer = (enabled: boolean) => {
  const me = useMe().data?.user.id;
  const today = karachiToday();
  return useQuery({
    queryKey: ['cash-sessions', today, me, 'open'],
    queryFn: () =>
      getJson<{ sessions: CashSessionDto[] }>(
        `/api/cash/sessions?date=${today}&collector_id=${me}&status=open`,
      ),
    enabled: enabled && !!me,
  });
};

type Attention = { id: string; tone: Tone; tag: string; text: ReactNode; to: string; go: string };

/**
 * "Needs attention" (UI plan §5.5): only what is not zero, each linking to the fix. Fed by today's
 * registers, defaulters, the caller's open drawer, billing failures and the M6 alarm pass.
 */
function NeedsAttention() {
  const { t } = useTranslation();
  const roles = useRoles();
  const office = canCorrect(roles);
  const money = canReadMoney(roles);
  const owner = canManageBackup(roles);
  const todayQ = useDashboardToday(office);
  const feesQ = useFeeDashboard(money);
  const drawerQ = useOpenDrawer(canUseCash(roles));
  const alarmQ = useLatestAlarm(owner);
  const today = todayQ.data;
  const fees = feesQ.data;
  const drawer = drawerQ.data?.sessions[0];
  const alarm = alarmQ.data?.event;
  const offline = !useOnline();
  // Only the sources this role reads; "Nothing needs attention" only once every one answered.
  const state = loadState(
    [office && todayQ, money && feesQ, canUseCash(roles) && drawerQ, owner && alarmQ].filter(
      (q): q is typeof todayQ => !!q,
    ),
    offline,
  );
  const qc = useQueryClient();
  // The M6 alarm pass stays until the owner dismisses it (acknowledged); tomorrow's pass raises it
  // again if the problem is still there.
  const ack = useMutation({
    mutationFn: (day: string) => sendJson('POST', `/api/alarms/${day}/ack`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alarms-latest'] }),
  });
  const alarmsShown = !!alarm && !alarm.acknowledged_at && alarm.alarms.some((a) => a.count > 0);
  const rows: Attention[] = [];
  const notTaken = today && !today.day_off ? today.registers.not_taken.length : 0;
  if (notTaken > 0)
    rows.push({
      id: 'attn-registers',
      tone: 'warn',
      tag: t('home.attention.tags.attendance'),
      text: <span>{t('home.attention.registers', { n: notTaken })}</span>,
      to: '/attendance',
      go: t('home.attention.registersGo'),
    });
  if (fees && fees.defaulters > 0)
    rows.push({
      id: 'attn-defaulters',
      tone: 'bad',
      tag: t('home.attention.tags.fees'),
      text: (
        <>
          <span>{t('home.attention.defaulters', { n: fees.defaulters })}</span>
          {', '}
          <Mny paisa={fees.dues_outstanding} />
        </>
      ),
      to: '/fees/defaulters',
      go: t('home.attention.defaultersGo'),
    });
  if (drawer)
    rows.push({
      id: 'attn-drawer',
      tone: 'info',
      tag: t('home.attention.tags.cash'),
      text: (
        <>
          {t('home.attention.drawer')} <Mny paisa={drawer.expected} />
        </>
      ),
      to: '/cash',
      go: t('home.attention.drawerGo'),
    });
  const billing = fees?.billing_alerts ?? today?.billing_alerts ?? 0;
  if (billing > 0 && canGenerate(roles))
    rows.push({
      id: 'attn-billing',
      tone: 'bad',
      tag: t('home.attention.tags.billing'),
      text: <span>{t('home.attention.billing', { n: billing })}</span>,
      to: '/fees/billing',
      go: t('home.attention.billingGo'),
    });
  if (alarm && alarmsShown)
    for (const a of alarm.alarms.filter((x) => x.count > 0))
      rows.push({
        id: `attn-alarm-${a.kind}`,
        tone: 'bad',
        tag: t('home.attention.tags.system'),
        // The stale-backup alarm carries its own explanation (M6: since when, what to check).
        text: (
          <span>
            {a.kind === 'backup_stale'
              ? alarmHint(t, a)
              : t('home.attention.alarm', { kind: t(`backup.alarms.kinds.${a.kind}`), n: a.count })}
          </span>
        ),
        to: '/settings?section=backup',
        go: t('home.attention.alarmGo'),
      });
  return (
    <Panel
      id="home-attention"
      title={t('home.attention.title')}
      action={
        alarm &&
        alarmsShown && (
          <Button
            id="alarm-dismiss"
            type="button"
            size="sm"
            variant="ghost"
            disabled={ack.isPending}
            onClick={() => ack.mutate(alarm.day)}
          >
            {t('backup.alarms.dismiss')}
          </Button>
        )
      }
    >
      {state === 'loading' && rows.length === 0 ? (
        <div role="status" aria-label={t('common.loading')} data-state="loading">
          <ListSkeleton rows={2} />
        </div>
      ) : rows.length === 0 && state === 'ready' ? (
        <p className="px-4 py-3 text-sm text-muted-foreground" data-state="clear">
          {t('home.attention.clear')}
        </p>
      ) : rows.length === 0 ? null : (
        <RowList>
          {rows.map((r) => (
            <li key={r.id} id={r.id}>
              <Link
                to={r.to}
                className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 hover:bg-accent"
              >
                <StatusBadge tone={r.tone}>{r.tag}</StatusBadge>
                <span className="min-w-0 flex-1 text-sm">{r.text}</span>
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                  {r.go}
                  <span aria-hidden className="rtl:-scale-x-100">
                    ›
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </RowList>
      )}
      {(state === 'failed' || state === 'offline') && (
        <p
          role="alert"
          data-state={state}
          className="flex items-start gap-2 border-t px-4 py-3 text-sm text-destructive first:border-t-0"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {state === 'offline' ? t('home.attention.offline') : t('home.attention.failed')}
        </p>
      )}
    </Panel>
  );
}

/** Absent today, with the family's phone (office). */
function AbsentPanel() {
  const { t } = useTranslation();
  const roles = useRoles();
  const d = useDashboardToday(true).data;
  // Each absent family's message state (UI plan §5.5 Home), from today's absence rows in the
  // caller's message scope; nothing is shown to a role that cannot read messages.
  const seesMessages = canReadMessages(roles);
  const msgs = useQuery({
    queryKey: ['messages', 'absence-today', d?.date],
    queryFn: () =>
      getJson<MessageListDto>(`/api/messages?template_key=absence&date=${d?.date ?? ''}`),
    enabled: seesMessages && !!d?.date && d.absentees.length > 0,
  });
  const stateOf = (familyId: string): 'queued' | 'sent' | 'skipped' | 'failed' | null => {
    const rows = msgs.data?.items.filter((m) => m.family_id === familyId) ?? [];
    if (!rows.length) return null;
    if (rows.some((m) => m.status === 'queued')) return 'queued';
    if (rows.some((m) => m.status === 'sent' || m.status === 'delivered' || m.status === 'read'))
      return 'sent';
    return rows.some((m) => m.status === 'failed') ? 'failed' : 'skipped';
  };
  if (!d || d.day_off) return null;
  return (
    <Panel
      id="home-absent"
      title={
        <>
          {t('home.absent.title')} <Num>{d.absentees.length}</Num>
        </>
      }
    >
      {d.absentees.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('home.absent.none')}</p>
      ) : (
        <RowList>
          {d.absentees.map((a) => (
            <ListRow
              key={a.student_id}
              to={`/students/${a.student_id}`}
              chevron={false}
              title={<bdi>{a.name}</bdi>}
              meta={
                <>
                  <bdi>{a.grp_name}</bdi>
                  {a.guardian_name && (
                    <>
                      {' · '}
                      <bdi>{a.guardian_name}</bdi>
                    </>
                  )}
                </>
              }
              trailing={
                <>
                  {a.guardian_phone && (
                    <bdi className="num hidden text-sm text-muted-foreground sm:inline">
                      {formatPkPhone(a.guardian_phone)}
                    </bdi>
                  )}
                  {seesMessages && msgs.data && <MessageState state={stateOf(a.family_id)} />}
                </>
              }
            />
          ))}
        </RowList>
      )}
    </Panel>
  );
}

/** One family's absence message today: waiting, sent, skipped, failed, or none queued. */
function MessageState({ state }: { state: 'queued' | 'sent' | 'skipped' | 'failed' | null }) {
  const { t } = useTranslation();
  const tone =
    state === 'sent' ? 'ok' : state === 'queued' ? 'warn' : state === 'failed' ? 'bad' : 'neutral';
  return (
    <span data-message-state={state ?? 'none'}>
      <StatusBadge tone={tone}>{t(`screens.home.msg.${state ?? 'none'}`)}</StatusBadge>
    </span>
  );
}

/**
 * The owner's first week (fresh install): setup, first admission, first fee month, first register,
 * first message. Each open step links to where it is done; the card goes away once all are done
 * (and never shows while loading or after a failed load, so it cannot nag on a bad connection).
 */
function FirstWeekCard() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['first-week'],
    queryFn: () => getJson<FirstWeekDto>('/api/home/first-week'),
    staleTime: 60_000,
  });
  const d = q.data;
  if (!d) return null;
  const steps: { id: keyof FirstWeekDto; to: string }[] = [
    { id: 'setup', to: '/setup' },
    { id: 'admission', to: '/students/new' },
    { id: 'fees', to: '/fees/billing' },
    { id: 'register', to: '/attendance' },
    { id: 'message', to: '/messages' },
  ];
  const done = steps.filter((s) => d[s.id]).length;
  if (done === steps.length) return null;
  return (
    <Panel
      id="home-first-week"
      title={t('screens.home.firstWeek')}
      action={
        <span className="text-meta text-muted-foreground">
          {t('screens.home.firstWeekDone', { done, total: steps.length })}
        </span>
      }
    >
      <RowList>
        {steps.map((s) =>
          d[s.id] ? (
            <ListRow
              key={s.id}
              leading={<CheckCircle2 className="size-5 shrink-0 text-ok" aria-hidden />}
              title={
                <span className="text-muted-foreground line-through">
                  {t(`screens.home.steps.${s.id}`)}
                </span>
              }
              trailing={<span className="sr-only">{t('screens.home.stepDone')}</span>}
            />
          ) : (
            <ListRow
              key={s.id}
              to={s.to}
              leading={<Circle className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
              title={t(`screens.home.steps.${s.id}`)}
            />
          ),
        )}
      </RowList>
    </Panel>
  );
}

/** Owner / admin: the day's three jobs, what needs attention, the month, who is absent. */
function OfficeHome() {
  const { t } = useTranslation();
  const roles = useRoles();
  const attendance = canCorrect(roles);
  const money = canReadMoney(roles);
  const messages = canReadMessages(roles);
  return (
    <>
      <Greeting
        action={
          canCollect(roles) && (
            <Button asChild>
              <Link to="/fees/counter">
                <Wallet aria-hidden />
                {t('home.collect')}
              </Link>
            </Button>
          )
        }
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {attendance && <RegistersCard />}
        {money && <CollectedCard />}
        {messages && <MessagesCard />}
      </div>
      {canManageRoles(roles) && <FirstWeekCard />}
      <NeedsAttention />
      {money && <MonthTiles />}
      {attendance && <AbsentPanel />}
    </>
  );
}

/** Accountant: the counter, their drawer, the queue; money attention and the month. */
function AccountantHome() {
  const { t } = useTranslation();
  const roles = useRoles();
  const drawer = useOpenDrawer(canUseCash(roles));
  const open = drawer.data?.sessions[0];
  return (
    <>
      <Greeting
        action={
          canCollect(roles) && (
            <Button asChild>
              <Link to="/fees/counter">
                <Wallet aria-hidden />
                {t('home.collect')}
              </Link>
            </Button>
          )
        }
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <CollectedCard />
        {canUseCash(roles) &&
          (loadState([drawer]) === 'failed' || loadState([drawer]) === 'offline' ? (
            <CardError id="home-drawer" title={t('home.accountant.drawer')} query={drawer} />
          ) : drawer.isPending ? (
            <CardSkeleton />
          ) : (
            <TodayCard
              id="home-drawer"
              title={t('home.accountant.drawer')}
              figure={
                open ? (
                  <Mny paisa={open.expected} />
                ) : (
                  <span className="text-base font-medium text-muted-foreground">
                    {t('home.accountant.drawerClosed')}
                  </span>
                )
              }
              action={
                <Button asChild variant="outline">
                  <Link to="/cash">{t('home.accountant.openDrawer')}</Link>
                </Button>
              }
            >
              {open && (
                <p className="text-sm text-muted-foreground">{t('home.accountant.drawerOpen')}</p>
              )}
            </TodayCard>
          ))}
        {canReadMessages(roles) && <MessagesCard />}
      </div>
      <NeedsAttention />
      <MonthTiles />
    </>
  );
}

/** Teacher: today's registers and messages only. No money (PLAN M7b "done when"). */
function TeacherHome() {
  const { t } = useTranslation();
  const roles = useRoles();
  const today = useToday().data;
  const counts = useMessageCounts(canReadMessages(roles)).data;
  return (
    <>
      <Greeting />
      <Panel id="home-teacher-registers" title={t('home.teacher.registers')} bodyClassName="p-3">
        {today ? (
          <div className="flex flex-col gap-2">
            <DayOffNote dayOff={today.day_off} />
            <TodayList items={today.items} date={today.date} />
          </div>
        ) : (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        )}
      </Panel>
      {canReadMessages(roles) && (
        <Panel
          id="home-teacher-messages"
          title={t('home.teacher.messages')}
          action={<GoLink to="/messages">{t('home.teacher.openQueue')}</GoLink>}
          bodyClassName="flex items-center gap-3 px-4 py-3"
        >
          <span className="text-2xl font-bold">
            <Num>{counts?.queued ?? 0}</Num>
          </span>
          <span className="text-sm text-muted-foreground">{t('home.teacher.messagesBody')}</span>
        </Panel>
      )}
    </>
  );
}

export type HomeVariant = 'office' | 'accountant' | 'teacher' | 'none';

/** Which home a set of roles gets (the API scopes the data anyway). */
export function homeVariant(roles: Parameters<typeof canCorrect>[0]): HomeVariant {
  if (canCorrect(roles)) return 'office';
  if (canReadMoney(roles)) return 'accountant';
  if (canReadAttendance(roles)) return 'teacher';
  return 'none';
}

export function Dashboard() {
  const { t } = useTranslation();
  const me = useMe().data;
  const roles = useRoles();
  const school = useSchool().data?.school;
  const unfinished = school === null || (school && !school.setup_completed_at);
  const variant = homeVariant(roles);
  return (
    <Page className="pb-4" data-home={variant}>
      {unfinished &&
        (me?.roles.includes('owner') ? (
          <Button asChild className="self-start">
            <Link to="/setup">{t('dashboard.finishSetup')}</Link>
          </Button>
        ) : (
          <p className="text-muted-foreground">{t('dashboard.setupNotFinished')}</p>
        ))}
      {variant === 'office' && <OfficeHome />}
      {variant === 'accountant' && <AccountantHome />}
      {variant === 'teacher' && <TeacherHome />}
      {variant === 'none' && (
        <>
          <Greeting />
          <p className="text-muted-foreground">{t('common.comingSoon')}</p>
        </>
      )}
    </Page>
  );
}
