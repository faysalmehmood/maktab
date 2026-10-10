import type { DayOff, MarkCounts, MarkStatus, TodayItem } from '@maktab/shared';
import { CalendarOff, ChevronRight, CloudOff, LogIn, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Num } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { registerPath, STATUS_CLASS, timeOf } from '@/lib/attendance';
import { cn, isolate } from '@/lib/utils';
import { discardFailed, useOutboxStatus } from '@/offline/sync';

/** The coloured letter; the full word is the accessible name. */
export function StatusChip({ status, className }: { status: MarkStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      title={t(`attendance.status.${status}`)}
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-md font-sans text-lg font-bold',
        STATUS_CLASS[status],
        className,
      )}
    >
      <span aria-hidden>{t(`attendance.letter.${status}`)}</span>
      <span className="sr-only">{t(`attendance.status.${status}`)}</span>
    </span>
  );
}

/** "P 28 · A 2 · L 1 · E 0" with each letter coloured. */
export function Counts({ counts }: { counts: MarkCounts }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap gap-1.5 text-xs">
      {(['P', 'A', 'L', 'E'] as const).map((s) => (
        // dir=ltr: reads "P 28" in Urdu too, like the letter on the register button.
        <span
          key={s}
          dir="ltr"
          className={cn('rounded px-1.5 py-0.5 font-sans', STATUS_CLASS[s])}
          title={t(`attendance.status.${s}`)}
        >
          {t(`attendance.letter.${s}`)} <Num>{counts[s]}</Num>
        </span>
      ))}
    </span>
  );
}

export function DayOffNote({ dayOff }: { dayOff: DayOff | null }) {
  const { t, i18n } = useTranslation();
  if (!dayOff) return null;
  const name =
    dayOff.kind === 'holiday'
      ? i18n.language === 'ur' && dayOff.name_ur
        ? dayOff.name_ur
        : dayOff.name_en
      : '';
  return (
    <p className="flex items-center gap-2 rounded-md bg-muted p-3 text-sm">
      <CalendarOff className="size-4 shrink-0" aria-hidden />
      {dayOff.kind === 'holiday' ? (
        <span>{t('attendance.dayOffHoliday', { name: isolate(name) })}</span>
      ) : (
        t('attendance.dayOffWeekly')
      )}
    </p>
  );
}

/** One row per register to take: group (· subject), students, taken / not taken, counts. */
export function TodayList({ items, date }: { items: TodayItem[]; date: string }) {
  const { t } = useTranslation();
  if (!items.length) return <p className="text-muted-foreground">{t('attendance.noGroups')}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((i) => (
        <li key={`${i.grp_id}|${i.grp_subject_id}`}>
          <Link
            to={registerPath(i.grp_id, date, i.grp_subject_id || null)}
            className="flex min-h-16 items-center gap-3 rounded-lg border p-3 hover:bg-accent"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="font-medium">
                <bdi>{i.programme_name}</bdi> · <bdi>{i.grp_name}</bdi>
                {i.subject_name && (
                  <>
                    {' · '}
                    <bdi>{i.subject_name}</bdi>
                  </>
                )}
              </span>
              <span className="text-sm text-muted-foreground">
                {t('attendance.students', { n: i.student_count })}
                {i.class_teacher_name && (
                  <>
                    {' · '}
                    <bdi>{i.class_teacher_name}</bdi>
                  </>
                )}
              </span>
              {i.status === 'taken' && (
                <span className="flex flex-wrap items-center gap-2">
                  <Counts counts={i.counts} />
                  <span className="text-xs text-muted-foreground">
                    <bdi>{i.taken_by_name ?? ''}</bdi> <Num>{timeOf(i.taken_at)}</Num>
                  </span>
                </span>
              )}
            </span>
            <Badge variant={i.status === 'taken' ? 'secondary' : 'destructive'}>
              {t(i.status === 'taken' ? 'attendance.taken' : 'attendance.notTaken')}
            </Badge>
            <ChevronRight className="size-5 shrink-0 rtl:-scale-x-100" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Header banners for saved-but-unsent attendance: offline, waiting count, refused registers, and
 * "sign in again" when the session expired (entries stay on the phone until then).
 */
export function SyncBanner() {
  const { t } = useTranslation();
  const s = useOutboxStatus();
  if (!s.pending && !s.failed && !s.paused && !s.offline) return null;
  return (
    <div className="flex flex-col gap-1 border-b bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50 print:hidden">
      {(s.offline || s.pending > 0) && (
        <p className="flex min-h-11 items-center gap-2" role="status">
          <CloudOff className="size-4 shrink-0" aria-hidden />
          {s.offline && <span>{t('attendance.offline')}</span>}
          {s.pending > 0 && <span>{t('attendance.pending', { n: s.pending })}</span>}
        </p>
      )}
      {s.paused && (
        <p className="flex min-h-11 flex-wrap items-center gap-2" role="alert">
          <LogIn className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">{t('attendance.signInAgain')}</span>
          <Button asChild size="sm" variant="outline">
            <Link to="/login">{t('attendance.signIn')}</Link>
          </Button>
        </p>
      )}
      {s.failed > 0 && (
        <p className="flex min-h-11 flex-wrap items-center gap-2" role="alert">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            {t('attendance.failed', { n: s.failed })} — {t('attendance.failedHint')}
          </span>
          <Button size="sm" variant="outline" onClick={() => void discardFailed()}>
            {t('attendance.dismiss')}
          </Button>
        </p>
      )}
    </div>
  );
}

/** Today in Asia/Karachi (the school day), whatever the phone's timezone. */
export function todayPk(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
