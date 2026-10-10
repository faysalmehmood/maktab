import type { MarkStatus } from '@maktab/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayPk } from '@/components/attendance/common';
import { Num } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { monthEnd, STATUS_CLASS, shiftMonth, useStudentAttendance } from '@/lib/attendance';
import { cn } from '@/lib/utils';

/** Worst status of a day wins when a per-subject school has several registers on one date. */
const RANK: Record<MarkStatus, number> = { A: 3, L: 2, E: 1, P: 0 };

/** Student detail → attendance: a month as a calendar grid (Mon-first) and the derived %. */
export function StudentAttendanceCard({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => todayPk().slice(0, 7));
  const q = useStudentAttendance(studentId, month);
  const byDate = new Map<string, MarkStatus>();
  for (const d of q.data?.days ?? []) {
    const prev = byDate.get(d.date);
    if (!prev || RANK[d.status] > RANK[prev]) byDate.set(d.date, d.status);
  }
  const last = Number(monthEnd(month).slice(8));
  const lead = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex flex-wrap items-center gap-2 px-4">
        <CardTitle className="me-auto">{t('attendance.title')}</CardTitle>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('attendance.prevMonth')}
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
        >
          <ChevronLeft aria-hidden className="rtl:-scale-x-100" />
        </Button>
        <Num>{month}</Num>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('attendance.nextMonth')}
          disabled={month >= todayPk().slice(0, 7)}
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
        >
          <ChevronRight aria-hidden className="rtl:-scale-x-100" />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        <p className="text-sm">
          {q.data?.pct != null
            ? t('attendance.monthPct', { pct: q.data.pct })
            : t('attendance.noMarks')}
        </p>
        {/* Calendar order is left-to-right in both languages, like a printed calendar. */}
        <div dir="ltr" className="grid grid-cols-7 gap-1 font-sans text-xs">
          {cells.map((d, i) =>
            d ? (
              <div
                key={d}
                className={cn(
                  'flex aspect-square flex-col items-center justify-center rounded-md border',
                  byDate.get(d) && STATUS_CLASS[byDate.get(d) as MarkStatus],
                )}
                title={byDate.get(d) ? t(`attendance.status.${byDate.get(d) as MarkStatus}`) : d}
              >
                <span>{Number(d.slice(8))}</span>
                {byDate.get(d) && (
                  <span className="font-bold">
                    {t(`attendance.letter.${byDate.get(d) as MarkStatus}`)}
                  </span>
                )}
              </div>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: padding cells before day 1 have no identity
              <div key={`pad-${i}`} />
            ),
          )}
        </div>
        {q.data && (
          <p className="flex flex-wrap gap-1.5 text-xs">
            {(['P', 'A', 'L', 'E'] as const).map((s) => (
              <span key={s} className={cn('rounded px-1.5 py-0.5', STATUS_CLASS[s])}>
                {t(`attendance.status.${s}`)} <Num>{q.data.counts[s]}</Num>
              </span>
            ))}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
