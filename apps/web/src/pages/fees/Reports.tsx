import { CONCESSION_REASONS, type FeeLineDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ConcessionValue, FeeLinesTable, Money } from '@/components/fees/common';
import { EndConcessionDialog } from '@/components/fees/dialogs';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getJson } from '@/lib/api';
import { canConcession, karachiToday } from '@/lib/fees';
import { printWhenReady } from '@/lib/print';
import { useGroups } from '@/lib/queries';
import { useRoles } from '@/lib/roles';

type RegisterRow = FeeLineDto & { father_name: string | null; roll_no: string | null };

/** PLAN §14.11 fee register: one group × one month, print-ready, CSV from the API. */
export function FeeRegisterPage() {
  const { t } = useTranslation();
  const groups = useGroups().data?.items ?? [];
  const [grp, setGrp] = useState('');
  const [period, setPeriod] = useState(karachiToday().slice(0, 7));
  const q = useQuery({
    queryKey: ['fee-register', grp, period],
    queryFn: () =>
      getJson<{ rows: RegisterRow[]; totals: Record<string, number> }>(
        `/api/fees/register?grp_id=${grp}&period=${period}`,
      ),
    enabled: !!grp && /^\d{4}-\d{2}$/.test(period),
  });
  const csv = `/api/fees/register?grp_id=${grp}&period=${period}&format=csv`;
  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <PageTitle
        actions={
          grp && (
            <>
              <Button asChild variant="outline" id="register-csv">
                <a href={csv} download>
                  <Download aria-hidden />
                  {t('fee.cash.csv')}
                </a>
              </Button>
              <Button
                variant="outline"
                onClick={() => void printWhenReady()}
                className="print:hidden"
              >
                <Printer aria-hidden />
                {t('fee.receipt.print')}
              </Button>
            </>
          )
        }
      >
        {t('fee.cash.register')}
      </PageTitle>
      <div className="grid gap-2 sm:grid-cols-2 print:hidden">
        <Field id="register-group" label="fee.col.group">
          <Select id="register-group" value={grp} onChange={(e) => setGrp(e.target.value)}>
            <option value="">—</option>
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
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </Field>
      </div>
      <ErrorNote error={q.error} />
      {q.data && q.data.rows.length === 0 && (
        <p className="text-muted-foreground">{t('fee.cash.none')}</p>
      )}
      {q.data && q.data.rows.length > 0 && (
        <>
          <FeeLinesTable lines={q.data.rows} />
          <p className="text-end font-medium">
            {t('fee.col.net')} <Money paisa={q.data.totals.net ?? 0} /> · {t('fee.col.paid')}{' '}
            <Money paisa={q.data.totals.paid ?? 0} /> · {t('fee.col.due')}{' '}
            <Money paisa={q.data.totals.due ?? 0} />
          </p>
        </>
      )}
    </section>
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

/** PLAN §14.11 concession register: every reduction with reason, approver, dates and amount given. */
export function ConcessionRegisterPage() {
  const { t, i18n } = useTranslation();
  const roles = useRoles();
  const [reason, setReason] = useState('');
  const [activeOn, setActiveOn] = useState('');
  const [ending, setEnding] = useState<string | null>(null);
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
  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <PageTitle>{t('fee.concession.register')}</PageTitle>
      <div className="grid gap-2 sm:grid-cols-2">
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
            value={activeOn}
            onChange={(e) => setActiveOn(e.target.value)}
          />
        </Field>
      </div>
      <ErrorNote error={q.error} />
      {q.data && q.data.concessions.length === 0 && (
        <p className="text-muted-foreground">{t('fee.concession.none')}</p>
      )}
      {q.data && q.data.concessions.length > 0 && (
        <>
          <Table id="concession-register">
            <TableHeader>
              <TableRow>
                <TableHead>{t('fee.col.student')}</TableHead>
                <TableHead>{t('fee.col.reason')}</TableHead>
                <TableHead>{t('fee.col.value')}</TableHead>
                <TableHead>{t('fee.col.from')}</TableHead>
                <TableHead>{t('fee.col.status')}</TableHead>
                <TableHead className="text-end">{t('fee.concession.given')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.concessions.map((c) => {
                const ended = !!c.ended_at || (!!c.valid_to && c.valid_to < karachiToday());
                return (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        to={`/students/${c.student_id}`}
                        className="inline-flex min-h-11 min-w-11 items-center hover:underline"
                        data-concession-student={c.student_id}
                      >
                        <bdi>{c.student_name}</bdi>
                      </Link>{' '}
                      <Num>{c.admission_no}</Num>
                    </TableCell>
                    <TableCell>
                      {t(`fee.concession.reasons.${c.reason}`)}
                      {c.head_name && (
                        <span className="text-muted-foreground">
                          {' '}
                          · <bdi>{c.head_name}</bdi>
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ConcessionValue type={c.type} value={c.value} />
                    </TableCell>
                    <TableCell>
                      <Num>{c.valid_from}</Num>
                      {(c.ended_at ?? c.valid_to) && (
                        <>
                          {' → '}
                          <Num>{(c.ended_at ?? c.valid_to) as string}</Num>
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ended ? 'outline' : 'secondary'}>
                        {ended ? t('fee.concession.ended') : t('fee.concession.active')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={c.amount_given} />
                    </TableCell>
                    <TableCell>
                      {!ended && canConcession(roles) && (
                        <Button size="sm" variant="ghost" onClick={() => setEnding(c.id)}>
                          {t('fee.concession.end')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-end font-medium" lang={i18n.language}>
            {t('fee.concession.totalGiven')}: <Money paisa={q.data.total_given} />
          </p>
        </>
      )}
      {ending && (
        <EndConcessionDialog
          open
          concessionId={ending}
          onOpenChange={(o) => !o && setEnding(null)}
        />
      )}
    </section>
  );
}
