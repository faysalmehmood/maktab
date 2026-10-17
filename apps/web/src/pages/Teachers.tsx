import type { TeacherRowDto, TeachersDto } from '@maktab/shared';
import { GraduationCap, Printer } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { ErrorNote, Num } from '@/components/form';
import {
  EmptyState,
  GoLink,
  ListRow,
  Page,
  PageHeader,
  Panel,
  RowList,
  StatStrip,
  StatusBadge,
} from '@/components/page';
import { AllocationPrint } from '@/components/teachers/AllocationPrint';
import { AllocationSheet } from '@/components/teachers/AllocationSheet';
import { classTeacherText, loadText, subjectLabel, subjectsText } from '@/components/teachers/text';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import '@/i18n/screens';
import { karachiToday } from '@/lib/fees';
import { printWhenReady } from '@/lib/print';
import { useGroups, useSchool, useSessions } from '@/lib/queries';
import { useTeachers } from '@/lib/teachers';
import { isolate } from '@/lib/utils';

type Warn = 'class' | 'subject' | 'double';
const WARNS: readonly Warn[] = ['class', 'subject', 'double'];

/** The A4 page of the printout, injected only while printing (as the receipts inject theirs). */
const PRINT_PAGE =
  '@page teacher-a4 { size: A4 portrait; margin: 12mm; } @media print { html, body { page: teacher-a4; } }';

/**
 * Teachers (owner/admin, 2026-10-17): the teacher side of the class/subject assignments. One row
 * per teacher with their class-teacher groups, subjects and load in a session; the gaps on top;
 * a row opens the teacher's allocation card. Writes go through the group endpoints.
 * URL: ?session=<id> (another session), ?teacher=<staff id> (the open card), ?warn=class|subject|double.
 */
export function TeachersPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const sessions = useSessions();
  const list = sessions.data?.items ?? [];
  const picked = params.get('session');
  const session =
    list.find((s) => s.id === picked) ?? list.find((s) => s.is_current) ?? list[0] ?? null;
  const sessionId = session?.id ?? null;
  const ready = !sessions.isPending;
  const teachers = useTeachers(sessionId, ready);
  const groups = useGroups({ session_id: sessionId });
  const school = useSchool().data?.school;
  const data = teachers.data;
  const items = data?.items ?? [];
  const warn = WARNS.find((w) => w === params.get('warn')) ?? null;
  const w = data?.warnings;
  const sessionName = session?.name ?? '';

  const withParam = (key: string, value: string | null) => {
    const n = new URLSearchParams(params);
    if (value === null) n.delete(key);
    else n.set(key, value);
    return n;
  };
  const href = (key: string, value: string | null) => {
    const s = withParam(key, value).toString();
    return s ? `/teachers?${s}` : '/teachers';
  };

  const doubles = new Set(w?.double_class_teachers.map((d) => d.staff_id) ?? []);
  const rows =
    warn === 'double' && doubles.size ? items.filter((r) => doubles.has(r.staff_id)) : items;
  const open = items.find((r) => r.staff_id === params.get('teacher')) ?? null;

  // Title and @page for the printout, restored when printing ends (or the page goes away).
  const restore = useRef<(() => void) | null>(null);
  useEffect(() => () => restore.current?.(), []);
  const print = () => {
    restore.current?.();
    const before = document.title;
    const style = document.createElement('style');
    style.dataset.printPage = 'teacher-a4';
    style.textContent = PRINT_PAGE;
    document.head.appendChild(style);
    const done = () => {
      document.title = before;
      style.remove();
      window.removeEventListener('afterprint', done);
      restore.current = null;
    };
    restore.current = done;
    window.addEventListener('afterprint', done);
    document.title = t('screens.teachers.printTitle', { session: sessionName });
    void printWhenReady();
  };

  const columns: Column<TeacherRowDto>[] = [
    {
      id: 'teacher',
      header: t('screens.teachers.teacher'),
      primary: true,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <bdi>{r.name}</bdi>
          {r.staff_status === 'left' && (
            <StatusBadge tone="warn">{t('screens.teachers.left')}</StatusBadge>
          )}
          {doubles.has(r.staff_id) && (
            <StatusBadge tone="warn">{t('screens.teachers.doubleClass')}</StatusBadge>
          )}
        </span>
      ),
    },
    {
      id: 'class',
      header: t('screens.teachers.classTeacherOf'),
      cell: (r) => classTeacherText(t, r),
    },
    { id: 'subjects', header: t('screens.teachers.subjects'), cell: (r) => subjectsText(t, r) },
    {
      id: 'load',
      header: t('screens.teachers.load'),
      className: 'whitespace-nowrap',
      cell: (r) => loadText(t, r),
    },
  ];

  const counts: Record<Warn, number> = {
    class: w?.groups_without_class_teacher.length ?? 0,
    subject: w?.subjects_without_teacher.length ?? 0,
    double: w?.double_class_teachers.length ?? 0,
  };
  const warnLabel: Record<Warn, string> = {
    class: t('screens.teachers.noClassTeacher'),
    subject: t('screens.teachers.noSubjectTeacher'),
    double: t('screens.teachers.doubleClass'),
  };
  const clear = counts.class + counts.subject + counts.double === 0;

  return (
    <>
      <Page width="full" className="max-w-[1200px] print:hidden">
        <PageHeader
          title={t('screens.teachers.title')}
          subtitle={t('screens.teachers.subtitle')}
          help="who-teaches"
          actions={
            <>
              {list.length > 1 && (
                <Select
                  id="teachers-session"
                  aria-label={t('group.session')}
                  value={sessionId ?? ''}
                  onChange={(e) => setParams(withParam('session', e.target.value))}
                >
                  {list.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button
                id="teachers-print"
                variant="outline"
                disabled={items.length === 0}
                onClick={print}
              >
                <Printer aria-hidden />
                {t('screens.teachers.print')}
              </Button>
            </>
          }
        />
        {data && items.length > 0 && (
          <StatStrip
            items={[
              {
                id: 'teachers-count',
                label: t('screens.teachers.count'),
                value: <Num>{items.length}</Num>,
              },
              ...WARNS.map((k) => ({
                id: `teachers-warn-${k}`,
                label: warnLabel[k],
                value: <Num>{counts[k]}</Num>,
                to: counts[k] > 0 ? href('warn', k) : undefined,
              })),
            ]}
          />
        )}
        {data && items.length > 0 && clear && (
          <p className="text-sm text-ok" id="teachers-all-clear">
            {t('screens.teachers.allClear')}
          </p>
        )}
        {data && warn && counts[warn] > 0 && (
          <WarnPanel
            kind={warn}
            title={warnLabel[warn]}
            warnings={data.warnings}
            teacherHref={(id) => href('teacher', id)}
            showAll={<GoLink to={href('warn', null)}>{t('screens.teachers.showAll')}</GoLink>}
          />
        )}
        <Panel>
          <DataTable
            id="teachers-table"
            caption={t('screens.teachers.title')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.staff_id}
            rowHref={(r) => href('teacher', r.staff_id)}
            loading={!ready || teachers.isPending}
            error={teachers.error ? <ErrorNote error={teachers.error} /> : undefined}
            empty={
              <EmptyState
                icon={GraduationCap}
                title={t('screens.teachers.emptyTitle')}
                body={t('screens.teachers.emptyBody')}
                action={
                  <Button asChild>
                    <Link id="teachers-invite" to="/settings?section=staff">
                      {t('staff.invite')}
                    </Link>
                  </Button>
                }
              />
            }
          />
        </Panel>
      </Page>
      {items.length > 0 && (
        <AllocationPrint
          className="hidden print:block"
          items={items}
          sessionName={sessionName}
          school={school}
          today={karachiToday()}
        />
      )}
      {open && (
        <AllocationSheet
          key={open.staff_id}
          teacher={open}
          groups={groups.data?.items ?? []}
          sessionName={sessionName}
          onClose={() => setParams(withParam('teacher', null))}
        />
      )}
    </>
  );
}

function WarnPanel({
  kind,
  title,
  warnings,
  teacherHref,
  showAll,
}: {
  kind: Warn;
  title: string;
  warnings: TeachersDto['warnings'];
  teacherHref: (staffId: string) => string;
  showAll: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Panel id="teachers-attention" title={title} action={showAll}>
      <RowList>
        {kind === 'class' &&
          warnings.groups_without_class_teacher.map((g) => (
            <ListRow
              key={g.grp_id}
              to={`/groups/${g.grp_id}`}
              title={<bdi>{g.name}</bdi>}
              meta={t('screens.teachers.noClassTeacherShort')}
            />
          ))}
        {kind === 'subject' &&
          warnings.subjects_without_teacher.map((s) => (
            <ListRow
              key={s.grp_subject_id}
              to={`/groups/${s.grp_id}`}
              title={subjectLabel(t, s)}
              meta={t('screens.teachers.noSubjectTeacherShort')}
            />
          ))}
        {kind === 'double' &&
          warnings.double_class_teachers.map((d) => (
            <ListRow
              key={d.staff_id}
              to={teacherHref(d.staff_id)}
              title={<bdi>{d.name}</bdi>}
              meta={d.groups.map((g) => isolate(g.name)).join(t('screens.teachers.sep'))}
            />
          ))}
      </RowList>
    </Panel>
  );
}
