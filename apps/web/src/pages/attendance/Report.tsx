import { Download, Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { todayPk } from '@/components/attendance/common';
import { ErrorNote, Num } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { reportUrl, STATUS_CLASS, useReport } from '@/lib/attendance';
import { printWhenReady } from '@/lib/print';
import { useGroups, useSchool } from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * The paper attendance register: one group × one month, students down, days across, totals and %.
 * Prints on A4 landscape (styles.css @page) and downloads as CSV (formula-safe, server side).
 */
export function ReportPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const groups = useGroups().data?.items ?? [];
  const school = useSchool().data?.school;
  const grpId = params.get('grp') ?? groups[0]?.id ?? null;
  const month = params.get('month') ?? todayPk().slice(0, 7);
  const group = groups.find((g) => g.id === grpId);
  const perSubject = school?.attendance_mode === 'per_subject' && (group?.subjects.length ?? 0) > 0;
  const [subjectPick, setSubjectPick] = useState('');
  const subject = perSubject ? subjectPick || group?.subjects[0]?.id || '' : '';
  const report = useReport(grpId, month, subject);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next);
  };
  const r = report.data;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        <h1 className="me-auto text-xl font-semibold">{t('attendance.report')}</h1>
        <Button variant="outline" size="sm" onClick={() => void printWhenReady()} disabled={!r}>
          <Printer aria-hidden />
          {t('attendance.print')}
        </Button>
        {grpId && (
          <Button asChild variant="outline" size="sm">
            <a href={reportUrl(grpId, month, subject, 'csv')} download>
              <Download aria-hidden />
              {t('attendance.csv')}
            </a>
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-3 print:hidden">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rep-group">{t('attendance.group')}</Label>
          <Select id="rep-group" value={grpId ?? ''} onChange={(e) => set('grp', e.target.value)}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.programme_name} · {g.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rep-month">{t('attendance.month')}</Label>
          <Input
            id="rep-month"
            type="month"
            value={month}
            onChange={(e) => e.target.value && set('month', e.target.value)}
          />
        </div>
        {perSubject && group && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rep-subject">{t('attendance.subject')}</Label>
            <Select
              id="rep-subject"
              value={subject}
              onChange={(e) => setSubjectPick(e.target.value)}
            >
              {group.subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.subject_name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {report.isError && <ErrorNote error={report.error} />}
      {r && (
        <div className="attendance-report flex flex-col gap-2">
          <h2 className="font-medium">
            <bdi>{school?.name}</bdi> — <bdi>{r.programme_name}</bdi> · <bdi>{r.grp_name}</bdi> —{' '}
            <Num>{r.month}</Num>
          </h2>
          <div className="overflow-x-auto rounded-md border print:overflow-visible print:border-0">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-muted">
                  <th className="sticky start-0 bg-muted p-1 text-start">{t('attendance.roll')}</th>
                  <th className="sticky start-8 min-w-28 bg-muted p-1 text-start">
                    {t('attendance.name')}
                  </th>
                  {r.days.map((d) => (
                    <th
                      key={d.date}
                      className={cn(
                        'w-6 p-0.5 text-center font-sans',
                        d.day_off && 'bg-muted-foreground/20',
                      )}
                    >
                      <Num>{d.date.slice(8)}</Num>
                    </th>
                  ))}
                  {(['P', 'A', 'L', 'E'] as const).map((s) => (
                    <th key={s} className="p-1 text-center font-sans">
                      {t(`attendance.letter.${s}`)}
                    </th>
                  ))}
                  <th className="p-1 text-center font-sans">%</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row) => (
                  <tr key={row.student_id} className="border-t">
                    <td className="sticky start-0 bg-background p-1">
                      <Num>{row.roll_no ?? ''}</Num>
                    </td>
                    <td className="sticky start-8 bg-background p-1 whitespace-nowrap">
                      <bdi>{row.name}</bdi>
                    </td>
                    {row.cells.map((c, i) => (
                      <td
                        key={r.days[i]?.date ?? i}
                        className={cn(
                          'p-0.5 text-center font-sans',
                          r.days[i]?.day_off && 'bg-muted-foreground/10',
                          // Printed register (A4): fixed ink colours on paper, not theme tokens.
                          c === 'A' && 'font-bold text-red-700',
                          c === 'L' && 'text-amber-700',
                          c === 'E' && 'text-sky-700',
                          c === '–' && 'text-muted-foreground',
                        )}
                      >
                        {c}
                      </td>
                    ))}
                    {(['P', 'A', 'L', 'E'] as const).map((s) => (
                      <td key={s} className="p-1 text-center">
                        <Num>{row.counts[s]}</Num>
                      </td>
                    ))}
                    <td className="p-1 text-center">
                      <Num>{row.pct ?? '–'}</Num>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {(['P', 'A', 'L', 'E'] as const).map((s) => (
              <span key={s} className={cn('rounded px-1.5 font-sans', STATUS_CLASS[s])}>
                {t(`attendance.letter.${s}`)} = {t(`attendance.status.${s}`)}
              </span>
            ))}
          </p>
          {r.rows.length === 0 && (
            <p className="text-muted-foreground">{t('attendance.noMarks')}</p>
          )}
        </div>
      )}
    </section>
  );
}
