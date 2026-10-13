import {
  CONCESSION_REASONS,
  type FeeLineDto,
  type Paged,
  type StudentListItem,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { BadgePercent, CalendarX2, Plus, Search, TableProperties, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { ConcessionValue, StatusBadge as FeeStatus } from '@/components/fees/common';
import { EndConcessionDialog, ReduceFeeDialog } from '@/components/fees/dialogs';
import { FeesTabs } from '@/components/fees/FeesTabs';
import { type ActiveFilter, FilterBar } from '@/components/filter-bar';
import { ErrorNote, Field, Num } from '@/components/form';
import { ReportActions } from '@/components/money/common';
import {
  EmptyState,
  GoLink,
  Mny,
  Page,
  PageHeader,
  Panel,
  StatStrip,
  StatusBadge,
} from '@/components/page';
import { RowMenu } from '@/components/row-menu';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getJson } from '@/lib/api';
import { canConcession, canGenerate, headLabel, karachiToday } from '@/lib/fees';
import { useGroups } from '@/lib/queries';
import { useRoles } from '@/lib/roles';
import '@/i18n/screens';

type RegisterRow = FeeLineDto & { father_name: string | null; roll_no: string | null };
type RegisterDto = { rows: RegisterRow[]; totals: Record<string, number> };

/**
 * PLAN §14.11 fee register: one group × one month, print-ready, CSV from the API. Nothing is
 * fetched until a class is chosen, so the page asks for one instead of showing a blank table.
 */
export function FeeRegisterPage() {
  const { t, i18n } = useTranslation();
  const roles = useRoles();
  const groups = useGroups().data?.items ?? [];
  const [grp, setGrp] = useState('');
  const [period, setPeriod] = useState(karachiToday().slice(0, 7));
  const validPeriod = /^\d{4}-\d{2}$/.test(period);
  const q = useQuery({
    queryKey: ['fee-register', grp, period],
    queryFn: () => getJson<RegisterDto>(`/api/fees/register?grp_id=${grp}&period=${period}`),
    enabled: !!grp && validPeriod,
  });
  const group = groups.find((g) => g.id === grp);
  const groupName = group ? `${group.programme_name} ${group.name}` : '';
  const rows = q.data?.rows ?? [];
  const students = new Set(rows.map((r) => r.student_id)).size;
  const columns: Column<RegisterRow>[] = [
    {
      id: 'student',
      header: t('fee.col.student'),
      primary: true,
      cell: (r) => (
        <span className="flex flex-col items-start">
          <bdi>{r.student_name}</bdi>
          <span className="text-meta font-normal text-muted-foreground">
            {r.roll_no ? (
              <>
                {t('group.rollNo')} <Num>{r.roll_no}</Num>
              </>
            ) : (
              <Num>{r.admission_no}</Num>
            )}
          </span>
        </span>
      ),
    },
    {
      id: 'father',
      header: t('screens.fees.father'),
      hideOnPhone: true,
      cell: (r) => (r.father_name ? <bdi>{r.father_name}</bdi> : '—'),
    },
    {
      id: 'head',
      header: t('fee.col.head'),
      cell: (r) => <bdi>{headLabel(r, i18n.language)}</bdi>,
    },
    // A phone card keeps what the clerk acts on (fee, due, state); the totals strip has the rest.
    {
      id: 'net',
      header: t('fee.col.net'),
      numeric: true,
      hideOnPhone: true,
      cell: (r) => <Mny paisa={r.net} />,
    },
    {
      id: 'paid',
      header: t('fee.col.paid'),
      numeric: true,
      hideOnPhone: true,
      cell: (r) => <Mny paisa={r.paid} />,
    },
    {
      id: 'due',
      header: t('fee.col.due'),
      numeric: true,
      cell: (r) => <Mny paisa={r.due} className={r.due > 0 ? 'font-semibold' : undefined} />,
    },
    { id: 'status', header: t('fee.col.status'), cell: (r) => <FeeStatus status={r.status} /> },
  ];

  return (
    <Page width="full" className="max-w-[1280px]">
      <PageHeader
        title={t('fee.cash.register')}
        subtitle={t('screens.fees.registerHint')}
        actions={
          grp &&
          validPeriod && (
            <ReportActions
              id="register"
              csv={`/api/fees/register?grp_id=${grp}&period=${period}&format=csv`}
            />
          )
        }
      />
      <FeesTabs />
      <Panel bodyClassName="grid gap-3 p-4 sm:grid-cols-2 print:hidden" id="register-choose">
        <Field id="register-group" label="fee.col.group">
          <Select id="register-group" value={grp} onChange={(e) => setGrp(e.target.value)}>
            <option value="">{t('screens.fees.chooseClass')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.programme_name} {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="register-period" label="fee.col.period">
          <Input
            id="register-period"
            type="month"
            className="num"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </Field>
      </Panel>
      {/* On paper the choice is the heading: which class, which month. */}
      {grp && (
        <p className="hidden text-section font-semibold print:block">
          <bdi>{groupName}</bdi> · <Num>{period}</Num>
        </p>
      )}
      <ErrorNote error={q.error} />
      {!grp ? (
        <Panel>
          <EmptyState
            icon={TableProperties}
            title={t('screens.fees.registerPick')}
            body={t('screens.fees.registerPickBody')}
          />
        </Panel>
      ) : (
        <>
          {q.data && rows.length > 0 && (
            <StatStrip
              items={[
                {
                  id: 'reg-students',
                  label: t('fee.sponsor.students'),
                  value: <Num>{students}</Num>,
                },
                {
                  id: 'reg-net',
                  label: t('screens.fees.billed'),
                  value: <Mny paisa={q.data.totals.net ?? 0} />,
                },
                {
                  id: 'reg-paid',
                  label: t('fee.col.paid'),
                  value: <Mny paisa={q.data.totals.paid ?? 0} />,
                },
                {
                  id: 'reg-due',
                  label: t('fee.col.due'),
                  value: <Mny paisa={q.data.totals.due ?? 0} />,
                },
              ]}
            />
          )}
          <Panel title={groupName ? <bdi>{groupName}</bdi> : undefined}>
            <DataTable
              id="register-table"
              caption={t('fee.cash.register')}
              columns={columns}
              rows={q.data?.rows}
              rowKey={(r) => r.id}
              rowHref={(r) => `/students/${r.student_id}`}
              loading={q.isPending && validPeriod}
              empty={
                <EmptyState
                  icon={CalendarX2}
                  title={t('screens.fees.registerEmpty')}
                  body={t('screens.fees.registerEmptyBody')}
                  action={
                    canGenerate(roles) && (
                      <GoLink to="/fees/billing">{t('fee.billing.open')}</GoLink>
                    )
                  }
                />
              }
            />
          </Panel>
        </>
      )}
    </Page>
  );
}

type ConcessionRow = {
  id: string;
  student_id: string;
  student_name: string;
  admission_no: string;
  head_name: string | null;
  type: 'pct' | 'fixed';
  value: number;
  reason: (typeof CONCESSION_REASONS)[number];
  note: string | null;
  approved_by_name: string | null;
  valid_from: string;
  valid_to: string | null;
  ended_at: string | null;
  end_reason: string | null;
  amount_given: number;
};

const concessionEnded = (c: ConcessionRow, today: string) =>
  !!c.ended_at || (!!c.valid_to && c.valid_to < today);

/** Pick the student a new concession is for (search by name or admission number). */
function PickStudentDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (s: StudentListItem) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const term = q.trim();
  const list = useQuery({
    queryKey: ['students', 'picker', term],
    queryFn: () =>
      getJson<Paged<StudentListItem>>(`/api/students?q=${encodeURIComponent(term)}&status=active`),
    enabled: open && term.length >= 2,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('screens.fees.addConcession')}</DialogTitle>
          <DialogDescription>{t('screens.fees.pickStudentHint')}</DialogDescription>
        </DialogHeader>
        <Field id="concession-student-search" label="fee.sponsor.student">
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="concession-student-search"
              type="search"
              className="ps-9"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </Field>
        <ErrorNote error={list.error} />
        {term.length >= 2 && list.data && list.data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('screens.fees.noStudent')}</p>
        )}
        {list.data && list.data.items.length > 0 && (
          <ul className="flex flex-col divide-y rounded-lg border" id="concession-student-results">
            {list.data.items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  data-pick={s.id}
                  onClick={() => onPick(s)}
                  className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-start hover:bg-accent focus-visible:bg-accent"
                >
                  <bdi className="min-w-0 flex-1 truncate font-medium">{s.name}</bdi>
                  <bdi className="num text-meta text-muted-foreground">{s.admission_no}</bdi>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * PLAN §14.11 concession register: every reduction with reason, approver, dates and amount given.
 * Add (pick a student → the same "Reduce fee" dialog as the profile) and End are dialogs.
 */
export function ConcessionRegisterPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const today = karachiToday();
  const [reason, setReason] = useState('');
  const [activeOn, setActiveOn] = useState('');
  const [ending, setEnding] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<StudentListItem | null>(null);
  const may = canConcession(roles);
  const qs = new URLSearchParams();
  if (reason) qs.set('reason', reason);
  if (activeOn) qs.set('active_on', activeOn);
  const q = useQuery({
    queryKey: ['fee-concessions', 'register', qs.toString()],
    queryFn: () =>
      getJson<{ concessions: ConcessionRow[]; total_given: number }>(
        `/api/fees/concessions/register?${qs}`,
      ),
  });
  const list = q.data?.concessions ?? [];
  const live = list.filter((c) => !concessionEnded(c, today)).length;

  const active: ActiveFilter[] = [];
  if (reason)
    active.push({
      id: 'reason',
      label: `${t('fee.concession.reason')}: ${t(`fee.concession.reasons.${reason as (typeof CONCESSION_REASONS)[number]}`)}`,
      onClear: () => setReason(''),
    });
  if (activeOn)
    active.push({
      id: 'active',
      label: (
        <>
          {t('fee.concession.activeOn')} <Num>{activeOn}</Num>
        </>
      ),
      onClear: () => setActiveOn(''),
    });

  const columns: Column<ConcessionRow>[] = [
    {
      id: 'student',
      header: t('fee.col.student'),
      primary: true,
      cell: (c) => (
        <span className="flex flex-col items-start">
          <Link
            to={`/students/${c.student_id}`}
            className="inline-flex min-h-11 min-w-11 items-center hover:underline"
            data-concession-student={c.student_id}
          >
            <bdi>{c.student_name}</bdi>
          </Link>
          <bdi className="num text-meta font-normal text-muted-foreground">{c.admission_no}</bdi>
        </span>
      ),
    },
    {
      id: 'reason',
      header: t('fee.col.reason'),
      cell: (c) => (
        <span className="flex flex-col items-start">
          <span>{t(`fee.concession.reasons.${c.reason}`)}</span>
          <span className="text-meta text-muted-foreground">
            {c.head_name ? <bdi>{c.head_name}</bdi> : t('fee.concession.allTuition')}
          </span>
        </span>
      ),
    },
    {
      id: 'value',
      header: t('fee.col.value'),
      cell: (c) => <ConcessionValue type={c.type} value={c.value} />,
    },
    {
      id: 'dates',
      header: t('fee.col.from'),
      cell: (c) => (
        <span className="whitespace-nowrap">
          <Num>{c.valid_from}</Num>
          {(c.ended_at ?? c.valid_to) && (
            <>
              {' – '}
              <Num>{(c.ended_at ?? c.valid_to) as string}</Num>
            </>
          )}
        </span>
      ),
    },
    {
      id: 'approved',
      header: t('screens.fees.approvedBy'),
      cell: (c) => (c.approved_by_name ? <bdi>{c.approved_by_name}</bdi> : '—'),
    },
    {
      id: 'status',
      header: t('fee.col.status'),
      cell: (c) =>
        concessionEnded(c, today) ? (
          <StatusBadge tone="neutral">{t('fee.concession.ended')}</StatusBadge>
        ) : (
          <StatusBadge tone="ok">{t('fee.concession.active')}</StatusBadge>
        ),
    },
    {
      id: 'given',
      header: t('fee.concession.given'),
      numeric: true,
      cell: (c) => <Mny paisa={c.amount_given} />,
    },
  ];

  return (
    <Page width="full" className="max-w-[1280px]">
      <PageHeader
        title={t('fee.concession.register')}
        subtitle={t('screens.fees.concessionsHint')}
        actions={
          <>
            <Button asChild variant="outline" className="print:hidden">
              <Link to="/fees/register" id="concessions-fee-register">
                <TableProperties aria-hidden />
                {t('fee.cash.register')}
              </Link>
            </Button>
            {may && (
              <Button id="concession-add" onClick={() => setPicking(true)} className="print:hidden">
                <Plus aria-hidden />
                {t('screens.fees.addConcession')}
              </Button>
            )}
          </>
        }
      />
      <FeesTabs />
      <FilterBar
        id="concession-filters"
        // No search box here: on a phone the bar is just the Filters button, not an empty card.
        className="md:rounded-xl md:border md:bg-card md:p-4"
        active={active}
        onClearAll={() => {
          setReason('');
          setActiveOn('');
        }}
      >
        <Field id="cr-reason" label="fee.concession.reason">
          <Select id="cr-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {CONCESSION_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`fee.concession.reasons.${r}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="cr-active" label="fee.concession.activeOn">
          <Input
            id="cr-active"
            type="date"
            className="num"
            value={activeOn}
            onChange={(e) => setActiveOn(e.target.value)}
          />
        </Field>
      </FilterBar>
      {q.data && list.length > 0 && (
        <StatStrip
          className="lg:grid-cols-3"
          items={[
            {
              id: 'con-count',
              label: t('fee.concession.register'),
              value: <Num>{list.length}</Num>,
            },
            { id: 'con-live', label: t('fee.concession.active'), value: <Num>{live}</Num> },
            {
              id: 'con-given',
              label: t('fee.concession.totalGiven'),
              value: <Mny paisa={q.data.total_given} />,
            },
          ]}
        />
      )}
      <Panel>
        <DataTable
          id="concession-register"
          caption={t('fee.concession.register')}
          columns={columns}
          rows={q.data?.concessions}
          rowKey={(c) => c.id}
          loading={q.isPending}
          error={q.error ? <ErrorNote error={q.error} /> : undefined}
          rowActions={
            may
              ? (c) =>
                  concessionEnded(c, today) ? null : (
                    <RowMenu
                      className="print:hidden"
                      label={t('screens.fees.receiptMore', { no: c.student_name })}
                      actions={[
                        {
                          id: `concession-end-${c.id}`,
                          label: t('fee.concession.endTitle'),
                          icon: Undo2,
                          destructive: true,
                          onSelect: () => setEnding(c.id),
                        },
                      ]}
                    />
                  )
              : undefined
          }
          empty={
            <EmptyState
              icon={BadgePercent}
              title={t('fee.concession.none')}
              body={t('screens.fees.concessionsEmptyBody')}
              action={
                may && (
                  <Button variant="outline" onClick={() => setPicking(true)}>
                    <Plus aria-hidden />
                    {t('screens.fees.addConcession')}
                  </Button>
                )
              }
            />
          }
        />
      </Panel>
      {picking && (
        <PickStudentDialog
          open
          onOpenChange={setPicking}
          onPick={(s) => {
            setPicking(false);
            setAdding(s);
          }}
        />
      )}
      {adding && (
        <ReduceFeeDialog
          open
          studentId={adding.id}
          studentName={adding.name}
          onOpenChange={(o) => !o && setAdding(null)}
        />
      )}
      {ending && (
        <EndConcessionDialog
          open
          concessionId={ending}
          onOpenChange={(o) => !o && setEnding(null)}
        />
      )}
    </Page>
  );
}
