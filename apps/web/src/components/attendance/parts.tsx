import type { DayOff, MarkCounts, MarkStatus, TodayItem } from '@maktab/shared';
import { CalendarOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/i18n/screens';
import { Num } from '@/components/form';
import { ListRow, Panel, RowList, StatusBadge } from '@/components/page';
import { registerPath, STATUS_CLASS, STATUS_SOLID, timeOf } from '@/lib/attendance';
import { cn, isolate } from '@/lib/utils';

/*
 * The register's parts (M7b-2, UI plan §5.5 Attendance): the mark chip, the counts, the day-off
 * note, the day's progress and the To take / Taken lists. A lazy chunk: the shell keeps only the
 * sync banner (./common.tsx).
 */

/**
 * A mark in colour. `solid` is the register row's current mark: a solid pill with the full word in
 * white ("Present", "Late"; owner feedback 2026-10-17: single letters were unclear), at least 44 px
 * tall. Everywhere else it is a soft square badge with the code (P, A, Lt, Lv) and the word as its
 * accessible name.
 */
export function StatusChip({
  status,
  solid = false,
  className,
}: {
  status: MarkStatus;
  solid?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const word = t(`attendance.status.${status}`);
  if (solid)
    return (
      <span
        title={word}
        data-solid
        className={cn(
          'inline-flex min-h-11 min-w-12 shrink-0 items-center justify-center rounded-full px-3 text-[13px] font-semibold whitespace-nowrap',
          STATUS_SOLID[status],
          className,
        )}
      >
        {word}
      </span>
    );
  return (
    <span
      title={word}
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-md font-sans text-lg font-bold',
        STATUS_CLASS[status],
        className,
      )}
    >
      <span aria-hidden>{t(`attendance.letter.${status}`)}</span>
      <span className="sr-only">{word}</span>
    </span>
  );
}

/** "P 28 · A 2 · Lt 1 · Lv 0" with each code coloured. */
export function Counts({ counts, className }: { counts: MarkCounts; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn('flex flex-wrap gap-1.5 text-xs', className)}>
      {(['P', 'A', 'L', 'E'] as const).map((s) => (
        // dir=ltr: reads "P 28" in Urdu too, like the printed register.
        <span
          key={s}
          dir="ltr"
          className={cn('rounded px-1.5 py-0.5 font-sans font-semibold', STATUS_CLASS[s])}
          title={t(`attendance.status.${s}`)}
        >
          {t(`attendance.letter.${s}`)} <Num>{counts[s]}</Num>
        </span>
      ))}
    </span>
  );
}

/**
 * The marks as one proportional bar (present / absent / late / leave), letters and counts beside
 * it in `Counts`. Decorative: the numbers are always written out next to it.
 */
export function MarkBar({ counts, className }: { counts: MarkCounts; className?: string }) {
  const total = counts.P + counts.A + counts.L + counts.E;
  if (!total) return null;
  return (
    <span
      aria-hidden
      data-markbar
      className={cn('flex h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      {(['P', 'A', 'L', 'E'] as const).map((s) =>
        counts[s] ? (
          <span
            key={s}
            className={cn('h-full', STATUS_SOLID[s].split(' ')[0])}
            style={{ width: `${(counts[s] / total) * 100}%` }}
          />
        ) : null,
      )}
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
    <p className="flex items-center gap-2 rounded-lg bg-info-soft p-3 text-sm text-info">
      <CalendarOff className="size-4 shrink-0" aria-hidden />
      {dayOff.kind === 'holiday' ? (
        <span>{t('attendance.dayOffHoliday', { name: isolate(name) })}</span>
      ) : (
        t('attendance.dayOffWeekly')
      )}
    </p>
  );
}

const absentOf = (c: MarkCounts) => c.A;

/** One register row: group (· subject), class teacher and size, then taken / not taken. */
function TodayRow({ i, date }: { i: TodayItem; date: string }) {
  const { t } = useTranslation();
  const taken = i.status === 'taken';
  const absent = absentOf(i.counts);
  return (
    <ListRow
      to={registerPath(i.grp_id, date, i.grp_subject_id || null)}
      tour="att-group"
      className="min-h-16"
      title={
        <>
          <bdi>{`${i.programme_name} ${i.grp_name}`}</bdi>
          {i.subject_name && (
            <>
              {' · '}
              <bdi>{i.subject_name}</bdi>
            </>
          )}
        </>
      }
      meta={
        <>
          {t('attendance.students', { count: i.student_count })}
          {' · '}
          {i.class_teacher_name ? (
            <bdi>{i.class_teacher_name}</bdi>
          ) : (
            t('screens.att.noClassTeacher')
          )}
          {taken && (
            <>
              {' · '}
              <bdi>{i.taken_by_name ?? ''}</bdi> <Num>{timeOf(i.taken_at)}</Num>
            </>
          )}
        </>
      }
      trailing={
        taken ? (
          <>
            <span className="hidden text-meta text-muted-foreground sm:inline">
              {t('screens.att.presentN', { n: i.counts.P })}
            </span>
            {absent > 0 ? (
              <StatusBadge tone="bad">{t('screens.att.absentN', { n: absent })}</StatusBadge>
            ) : (
              <StatusBadge tone="ok">{t('screens.att.allPresent')}</StatusBadge>
            )}
          </>
        ) : (
          <StatusBadge tone="warn">{t('attendance.notTaken')}</StatusBadge>
        )
      }
    />
  );
}

/** A plain list of the day's registers (teacher home). */
export function TodayList({ items, date }: { items: TodayItem[]; date: string }) {
  const { t } = useTranslation();
  if (!items.length)
    return <p className="px-1 text-sm text-muted-foreground">{t('attendance.noGroups')}</p>;
  return (
    <RowList className="-mx-3">
      {items.map((i) => (
        <TodayRow key={`${i.grp_id}|${i.grp_subject_id}`} i={i} date={date} />
      ))}
    </RowList>
  );
}

/** Progress first ("6 of 12 registers taken", absent so far), then To take and Taken. */
export function TodayPanels({ items, date }: { items: TodayItem[]; date: string }) {
  const { t } = useTranslation();
  if (!items.length)
    return (
      <Panel>
        <p className="p-4 text-sm text-muted-foreground">{t('attendance.noGroups')}</p>
      </Panel>
    );
  const toTake = items.filter((i) => i.status !== 'taken');
  const taken = items.filter((i) => i.status === 'taken');
  const absent = taken.reduce((n, i) => n + absentOf(i.counts), 0);
  const pct = Math.round((taken.length / items.length) * 100);
  const row = (i: TodayItem) => (
    <TodayRow key={`${i.grp_id}|${i.grp_subject_id}`} i={i} date={date} />
  );
  return (
    <>
      <Panel bodyClassName="flex flex-col gap-2 p-4" className="print:hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p id="att-progress" className="text-section font-semibold">
            {t('screens.att.progress', { done: taken.length, total: items.length })}
          </p>
          {taken.length > 0 && (
            <p className="text-meta text-muted-foreground">
              {t('screens.att.absentSoFar', { count: absent })}
            </p>
          )}
        </div>
        <div
          role="progressbar"
          aria-labelledby="att-progress"
          aria-valuemin={0}
          aria-valuemax={items.length}
          aria-valuenow={taken.length}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full rounded-full bg-brand transition-[width] motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        </div>
      </Panel>
      {toTake.length > 0 ? (
        <Panel
          id="att-to-take"
          title={t('screens.att.toTake')}
          action={
            <span className="text-meta text-muted-foreground">
              {t('screens.att.classes', { count: toTake.length })}
            </span>
          }
        >
          <RowList>{toTake.map(row)}</RowList>
        </Panel>
      ) : (
        <p className="rounded-lg bg-ok-soft p-3 text-sm font-semibold text-ok" role="status">
          {t('screens.att.allTaken')}
        </p>
      )}
      {taken.length > 0 && (
        <Panel
          id="att-taken"
          title={t('screens.att.takenList')}
          action={
            <span className="text-meta text-muted-foreground">
              {t('screens.att.classes', { count: taken.length })}
            </span>
          }
        >
          <RowList>{taken.map(row)}</RowList>
        </Panel>
      )}
    </>
  );
}
