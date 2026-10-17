import { MARK_STATUSES, type MarkStatus } from '@maktab/shared';
import { Download, Printer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { todayPk } from '@/components/attendance/common';
import { SchoolMark } from '@/components/brand/SchoolBadge';
import { DateText } from '@/components/date-text';
import { ErrorNote, Num } from '@/components/form';
import { MonthInput } from '@/components/month-input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { reportUrl, STATUS_CLASS, useReport } from '@/lib/attendance';
import { monthLabel } from '@/lib/dates';
import { printWhenReady } from '@/lib/print';
import { useGroups, useSchool } from '@/lib/queries';
import { useDocumentTitle } from '@/lib/title';
import { cn } from '@/lib/utils';

/**
 * The paper attendance register: one group × one month, students down, days across, totals and %.
 * Prints on one A4 landscape sheet like a school register (logo, school, class, month, class
 * teacher, present per day, working days, signatures) and downloads as CSV (formula-safe, server
 * side). Marks print as P, A, Lt, Lv.
 */
const isMark = (c: string): c is MarkStatus => (MARK_STATUSES as readonly string[]).includes(c);

/**
 * While the register is on screen the whole document prints on A4 landscape with no page margin
 * (owner feedback 2026-10-17): a named page on the report alone left the hidden app frame on default
 * pages before and after it (a blank page 1 and 3), and margin 0 makes Chrome drop its header and
 * footer line (title + URL). The report pads itself in print instead (styles.css).
 */
function useRegisterPage() {
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.registerPage = '';
    // The page has no margin, so the app's tinted <html> background would show under the sheet.
    style.textContent =
      '@page { size: A4 landscape; margin: 0; } @media print { html, body { background: white; } }';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
}

export function ReportPage() {
  const { t, i18n } = useTranslation();
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
  // Non-school days (holidays and the weekly day off) are shaded; a day with no register is "–".
  const off = new Set(r?.non_school_days ?? []);
  const presentOn = useMemo(
    () =>
      r?.days.map((_, i) =>
        r.rows.reduce((n, row) => n + (row.cells[i] === 'P' || row.cells[i] === 'L' ? 1 : 0), 0),
      ) ?? [],
    [r],
  );
  const schoolName = (i18n.language === 'ur' && school?.name_ur) || school?.name || '';
  const groupLabel = r ? `${r.programme_name} ${r.grp_name}` : '';
  const subjectName = perSubject
    ? group?.subjects.find((s) => s.id === subject)?.subject_name
    : undefined;
  useDocumentTitle(
    r
      ? t('attendance.docTitle', {
          group: groupLabel,
          month: monthLabel(r.month, i18n.language),
        })
      : null,
  );
  useRegisterPage();

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
          <MonthInput id="rep-month" value={month} onChange={(v) => set('month', v)} />
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
          <header className="flex items-center gap-3 border-b-2 border-foreground pb-2 print:border-black">
            {/* The school's mark as everywhere else: its logo, else the generated badge. */}
            {school && (
              <SchoolMark
                school={school}
                logoSrc={school.has_logo ? '/api/school/logo' : null}
                size={52}
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-lg font-bold">
                <bdi>{schoolName}</bdi>
              </p>
              <h2 className="font-semibold">{t('attendance.registerTitle')}</h2>
            </div>
            <dl className="grid grid-cols-[auto_auto] gap-x-2 text-sm">
              <dt className="text-muted-foreground">{t('attendance.group')}</dt>
              <dd>
                <bdi>{groupLabel}</bdi>
                {subjectName && (
                  <>
                    {' · '}
                    <bdi>{subjectName}</bdi>
                  </>
                )}
              </dd>
              <dt className="text-muted-foreground">{t('attendance.month')}</dt>
              <dd>
                <DateText iso={r.month} kind="month" />
              </dd>
              <dt className="text-muted-foreground">{t('group.classTeacher')}</dt>
              <dd>{r.class_teacher_name ? <bdi>{r.class_teacher_name}</bdi> : '–'}</dd>
            </dl>
          </header>
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
                        off.has(d.date) && 'day-off',
                      )}
                    >
                      <Num>{d.date.slice(8)}</Num>
                    </th>
                  ))}
                  {MARK_STATUSES.map((s) => (
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
                    {row.cells.map((c, i) => {
                      const date = r.days[i]?.date ?? '';
                      return (
                        <td
                          key={date || i}
                          className={cn(
                            'p-0.5 text-center font-sans',
                            off.has(date) && 'day-off',
                            // Printed register (A4): fixed ink colours on paper, not theme tokens.
                            c === 'A' && 'font-bold text-red-700',
                            c === 'L' && 'text-amber-700',
                            c === 'E' && 'text-sky-700',
                            !isMark(c) && 'text-muted-foreground',
                          )}
                        >
                          {isMark(c) ? t(`attendance.letter.${c}`) : '–'}
                        </td>
                      );
                    })}
                    {MARK_STATUSES.map((s) => (
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
              {r.rows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 font-semibold" data-totals>
                    <th scope="row" colSpan={2} className="p-1 text-start">
                      {t('attendance.presentPerDay')}
                    </th>
                    {r.days.map((d, i) => (
                      <td
                        key={d.date}
                        className={cn('p-0.5 text-center font-sans', off.has(d.date) && 'day-off')}
                      >
                        {d.taken ? <Num>{presentOn[i] ?? 0}</Num> : ''}
                      </td>
                    ))}
                    {MARK_STATUSES.map((s) => (
                      <td key={s} className="p-1 text-center">
                        <Num>{r.rows.reduce((n, row) => n + row.counts[s], 0)}</Num>
                      </td>
                    ))}
                    <td className="p-1" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span title={t('attendance.workingDaysHint')}>
              {t('attendance.workingDays', { n: r.working_days })}
            </span>
            <span>
              {t('attendance.registersTaken', { n: r.days.filter((d) => d.taken).length })}
            </span>
          </p>
          <p className="register-legend flex flex-wrap gap-2 text-xs text-muted-foreground">
            {MARK_STATUSES.map((s) => (
              <span key={s} className={cn('rounded px-1.5 font-sans', STATUS_CLASS[s])}>
                {t(`attendance.letter.${s}`)} = {t(`attendance.status.${s}`)}
              </span>
            ))}
            <span className="px-1.5">{t('attendance.legendNone')}</span>
            <span className="day-off rounded px-1.5">{t('attendance.legendOff')}</span>
          </p>
          {r.rows.length === 0 && (
            <p className="text-muted-foreground">{t('attendance.noMarks')}</p>
          )}
          <div className="register-signs hidden print:flex">
            <span>{t('attendance.signTeacher')}</span>
            <span>{t('attendance.signPrincipal')}</span>
          </div>
        </div>
      )}
    </section>
  );
}
