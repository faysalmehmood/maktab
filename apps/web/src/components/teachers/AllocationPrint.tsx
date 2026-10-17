import { formatPkPhone, type SchoolDto, type TeacherRowDto } from '@maktab/shared';
import { useTranslation } from 'react-i18next';
import { PrintBadge } from '@/components/brand/SchoolBadge';
import { shortDate } from '@/lib/dates';
import { cn, isolate } from '@/lib/utils';
import { classTeacherText, loadText, NONE, subjectLines } from './text';

/**
 * "Teacher allocation <session>" on A4 portrait: the school header as receipts and payslips print
 * it (logo or generated badge, name, address, phone), one table, and the principal's signature.
 * Hidden on screen; the Print button injects the A4 page and the document title.
 */
export function AllocationPrint({
  items,
  sessionName,
  school,
  today,
  className,
}: {
  items: readonly TeacherRowDto[];
  sessionName: string;
  school: SchoolDto | null | undefined;
  today: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'ur' ? 'ur' : 'en';
  const name = school ? (lang === 'ur' && school.name_ur ? school.name_ur : school.name) : '';
  return (
    <article
      id="teacher-allocation-print"
      lang={lang}
      dir={lang === 'ur' ? 'rtl' : 'ltr'}
      className={cn('allocation-print', className)}
    >
      <header className="receipt-head">
        {school?.has_logo ? (
          <img src="/api/school/logo" alt="" className="receipt-logo" />
        ) : (
          <PrintBadge school={school} />
        )}
        {name && <h1>{name}</h1>}
        {school?.address && <div className="receipt-sub">{school.address}</div>}
        {school?.phone && (
          <div className="receipt-sub">
            <bdi className="num">{formatPkPhone(school.phone)}</bdi>
          </div>
        )}
        <div className="receipt-title">
          {t('screens.teachers.printTitle', { session: isolate(sessionName) })}
        </div>
        <div className="receipt-sub">
          {t('screens.teachers.printedOn', { date: isolate(shortDate(today, lang)) })}
        </div>
      </header>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('screens.teachers.teacher')}</th>
            <th scope="col">{t('screens.teachers.classTeacherOf')}</th>
            <th scope="col">{t('screens.teachers.subjects')}</th>
            <th scope="col">{t('screens.teachers.load')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.staff_id}>
              <td>
                <bdi>{r.name}</bdi>
              </td>
              <td>{classTeacherText(t, r)}</td>
              <td>
                <SubjectLines lines={subjectLines(t, r)} />
              </td>
              <td>{loadText(t, r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="allocation-foot">
        <span />
        <span className="allocation-sign">{t('screens.teachers.principalSign')}</span>
      </footer>
    </article>
  );
}

/** One block line per subject ("—" when none); shared with the screen's table. */
export function SubjectLines({ lines }: { lines: readonly string[] }) {
  if (!lines.length) return <>{NONE}</>;
  return (
    <>
      {lines.map((l) => (
        <span key={l} className="block">
          {l}
        </span>
      ))}
    </>
  );
}
