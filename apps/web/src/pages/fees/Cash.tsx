import type { CashSessionDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AmountInput, Figure, Money, ReasonDialog } from '@/components/fees/common';
import { FeesTabs } from '@/components/fees/FeesTabs';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
import { StatusBadge } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getJson, sendJson, useMe } from '@/lib/api';
import { addDaysIso, canReopenCash, karachiToday, rupeesToPaisa, useAccounts } from '@/lib/fees';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

type Sessions = { sessions: CashSessionDto[] };

function useInvalidateCash() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['cash'] });
}

function ReopenButton({ s }: { s: CashSessionDto }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const inv = useInvalidateCash();
  const reopen = useMutation({
    mutationFn: (reason: string) =>
      sendJson('POST', `/api/cash/sessions/${s.id}/reopen`, { reason }),
    onSuccess: async () => {
      await inv();
      toast.success(t('fee.cash.reopened'));
      setOpen(false);
    },
  });
  return (
    <>
      <Button size="sm" variant="outline" id={`reopen-${s.id}`} onClick={() => setOpen(true)}>
        {t('fee.cash.reopen')}
      </Button>
      {open && (
        <ReasonDialog
          id="reopen"
          open={open}
          onOpenChange={setOpen}
          title={t('fee.cash.reopenTitle')}
          confirmLabel={t('fee.cash.reopen')}
          pending={reopen.isPending}
          error={reopen.error}
          onConfirm={(r) => reopen.mutate(r)}
        />
      )}
    </>
  );
}

/** Today's drawer (PLAN §14.6 step 1): expected by method, counted, variance, close. */
function TodayDrawer() {
  const { t } = useTranslation();
  const me = useMe().data?.user.id;
  const roles = useRoles();
  const today = karachiToday();
  const inv = useInvalidateCash();
  const q = useQuery({
    queryKey: ['cash', 'today', me, today],
    queryFn: () => getJson<Sessions>(`/api/cash/sessions?date=${today}&collector_id=${me}`),
    enabled: !!me,
  });
  const [float, setFloat] = useState('');
  const [counted, setCounted] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const open = useMutation({
    mutationFn: () =>
      sendJson('POST', '/api/cash/sessions', { opening: rupeesToPaisa(float) ?? 0 }),
    onSuccess: inv,
  });
  const close = useMutation({
    mutationFn: ({ id, paisa }: { id: string; paisa: number }) =>
      sendJson('POST', `/api/cash/sessions/${id}/close`, { counted: paisa }),
    onSuccess: async () => {
      await inv();
      toast.success(t('fee.cash.closed'));
    },
  });
  const s = q.data?.sessions.find((x) => x.collector_id === me);
  const countedPaisa = rupeesToPaisa(counted);
  const submitClose = (e: FormEvent) => {
    e.preventDefault();
    if (!s) return;
    if (countedPaisa === null) return setErr(counted ? 'amount_invalid' : 'amount_required');
    setErr(undefined);
    close.mutate({ id: s.id, paisa: countedPaisa });
  };
  return (
    <Card className="gap-3 py-4" id="cash-today">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2">
          {t('fee.cash.today')} · <Num>{today}</Num>
          {s && (
            <StatusBadge tone={s.closed_at ? 'neutral' : 'ok'} className="ms-auto">
              {s.closed_at ? t('fee.cash.closed') : t('fee.cash.openState')}
            </StatusBadge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {q.isSuccess && !s && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              open.mutate();
            }}
          >
            <p className="text-sm text-muted-foreground">{t('fee.cash.noSession')}</p>
            <Field id="cash-float" label="fee.cash.openingFloat">
              <AmountInput id="cash-float" value={float} onChange={setFloat} />
            </Field>
            <ErrorNote error={open.error} />
            <Button type="submit" id="cash-open" disabled={open.isPending}>
              {t('fee.cash.open')}
            </Button>
          </form>
        )}
        {s && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label={t('fee.cash.opening')}>
                <Money paisa={s.opening} />
              </Figure>
              <Figure label={t('fee.cash.expected')} tone="strong">
                <span id="cash-expected">
                  <Money paisa={s.expected} />
                </span>
              </Figure>
              {s.closed_at && (
                <>
                  <Figure label={t('fee.cash.counted')}>
                    <Money paisa={s.counted ?? 0} />
                  </Figure>
                  <Figure label={t('fee.cash.variance')}>
                    <Money paisa={s.variance ?? 0} />
                  </Figure>
                </>
              )}
            </div>
            {s.by_method.length > 0 && (
              <ul className="flex flex-col text-sm" aria-label={t('fee.cash.byMethod')}>
                {s.by_method.map((m) => (
                  <li key={m.method} className="flex gap-2">
                    {t(`fee.methods.${m.method as 'cash'}`)} · <Num>{m.count}</Num>
                    <span className="ms-auto">
                      <Money paisa={m.amount} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!s.closed_at ? (
              <form onSubmit={submitClose} className="flex flex-col gap-2" noValidate>
                <Field id="cash-counted" label="fee.cash.counted" required error={err}>
                  <AmountInput id="cash-counted" value={counted} onChange={setCounted} />
                </Field>
                {countedPaisa !== null && (
                  <p
                    id="cash-variance"
                    data-tone={
                      countedPaisa === s.expected
                        ? 'ok'
                        : countedPaisa < s.expected
                          ? 'bad'
                          : 'warn'
                    }
                    className={cn(
                      'rounded-lg p-3 text-sm font-semibold',
                      countedPaisa === s.expected
                        ? 'bg-ok-soft text-ok'
                        : countedPaisa < s.expected
                          ? 'bg-bad-soft text-bad'
                          : 'bg-warn-soft text-warn',
                    )}
                  >
                    {t('fee.cash.variance')}: <Money paisa={countedPaisa - s.expected} />
                  </p>
                )}
                <ErrorNote error={close.error} />
                <Button type="submit" id="cash-close" disabled={close.isPending}>
                  {t('fee.cash.close')}
                </Button>
              </form>
            ) : (
              canReopenCash(roles) && <ReopenButton s={s} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TransferForm() {
  const { t } = useTranslation();
  const acc = useAccounts().data;
  const accounts = acc?.accounts ?? [];
  const [d, setD] = useState({ from: '', to: '', amount: '', note: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (amount: number) =>
      sendJson('POST', '/api/transfers', {
        from_account: d.from,
        to_account: d.to,
        amount,
        note: d.note,
      }),
    onSuccess: () => {
      toast.success(t('fee.cash.transferred'));
      setD({ from: '', to: '', amount: '', note: '' });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!d.from) er.from = 'required';
    if (!d.to || d.to === d.from) er.to = d.to ? 'invalid' : 'required';
    const p = rupeesToPaisa(d.amount);
    if (!p) er.amount = d.amount ? 'amount_invalid' : 'amount_required';
    setErrors(er);
    if (!Object.keys(er).length && p) save.mutate(p);
  };
  const opts = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name}
    </option>
  ));
  // Cash moves only out of the caller's own drawer (F3/F6); into any account.
  const fromOpts = accounts
    .filter((a) => a.kind !== 'cash' || a.id === acc?.my_drawer)
    .map((a) => (
      <option key={a.id} value={a.id}>
        {a.name}
      </option>
    ));
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t('fee.cash.transfer')}</CardTitle>
        <p className="text-xs text-muted-foreground">{t('fee.cash.transferNote')}</p>
      </CardHeader>
      <CardContent className="px-4">
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2" noValidate id="transfer-form">
          <Field id="transfer-from" label="fee.cash.from" required error={errors.from}>
            <Select
              id="transfer-from"
              value={d.from}
              onChange={(e) => setD({ ...d, from: e.target.value })}
            >
              <option value="">—</option>
              {fromOpts}
            </Select>
          </Field>
          <Field id="transfer-to" label="fee.cash.to" required error={errors.to}>
            <Select
              id="transfer-to"
              value={d.to}
              onChange={(e) => setD({ ...d, to: e.target.value })}
            >
              <option value="">—</option>
              {opts}
            </Select>
          </Field>
          <Field id="transfer-amount" label="fee.cash.amount" required error={errors.amount}>
            <AmountInput
              id="transfer-amount"
              value={d.amount}
              onChange={(v) => setD({ ...d, amount: v })}
            />
          </Field>
          <Field id="transfer-note" label="fee.cash.note">
            <Input
              id="transfer-note"
              value={d.note}
              maxLength={200}
              onChange={(e) => setD({ ...d, note: e.target.value })}
            />
          </Field>
          <ErrorNote error={save.error} />
          <Button type="submit" className="sm:col-span-2" disabled={save.isPending}>
            {t('fee.cash.transfer')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionsList() {
  const { t } = useTranslation();
  const roles = useRoles();
  const today = karachiToday();
  const [from, setFrom] = useState(addDaysIso(today, -13));
  const [to, setTo] = useState(today);
  const q = useQuery({
    queryKey: ['cash', 'sessions', from, to],
    queryFn: () => getJson<Sessions>(`/api/cash/sessions?from=${from}&to=${to}`),
  });
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t('fee.cash.sessions')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4">
        <div className="grid grid-cols-2 gap-2">
          <Field id="sessions-from" label="fee.col.from">
            <Input
              id="sessions-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field id="sessions-to" label="fee.col.to">
            <Input
              id="sessions-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
        <ErrorNote error={q.error} />
        {q.data?.sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('fee.cash.none')}</p>
        )}
        {!!q.data?.sessions.length && (
          <Table id="sessions-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t('fee.col.date')}</TableHead>
                <TableHead>{t('fee.cash.collector')}</TableHead>
                <TableHead className="text-end">{t('fee.cash.expected')}</TableHead>
                <TableHead className="text-end">{t('fee.cash.variance')}</TableHead>
                <TableHead>{t('fee.col.status')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Num>{s.business_date}</Num>
                  </TableCell>
                  <TableCell>
                    <bdi>{s.collector_name ?? ''}</bdi>
                  </TableCell>
                  <TableCell className="text-end">
                    <Money paisa={s.expected} />
                  </TableCell>
                  <TableCell className="text-end">
                    {s.variance === null ? '—' : <Money paisa={s.variance} />}
                  </TableCell>
                  <TableCell>
                    {s.closed_at ? t('fee.cash.closed') : t('fee.cash.openState')}
                  </TableCell>
                  <TableCell>
                    {s.closed_at && canReopenCash(roles) && <ReopenButton s={s} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

type CollectionRow = {
  collector_id: string;
  collector_name: string | null;
  method: string;
  payments: number;
  received: number;
  reversed: number;
  refunded: number;
  net: number;
};

export function CollectionReport() {
  const { t } = useTranslation();
  const today = karachiToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const q = useQuery({
    queryKey: ['fee-collection', from, to],
    queryFn: () =>
      getJson<{ rows: CollectionRow[]; total: number }>(
        `/api/fees/collection?from=${from}&to=${to}`,
      ),
    enabled: !!from && !!to && from <= to,
  });
  return (
    <Card className="gap-3 py-4" id="collection-report">
      <CardHeader className="px-4">
        <CardTitle>{t('fee.cash.report')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4">
        <div className="grid grid-cols-2 gap-2">
          <Field id="collection-from" label="fee.col.from">
            <Input
              id="collection-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field id="collection-to" label="fee.col.to">
            <Input
              id="collection-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
        <ErrorNote error={q.error} />
        {q.data && q.data.rows.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('fee.cash.none')}</p>
        )}
        {q.data && q.data.rows.length > 0 && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('fee.cash.collector')}</TableHead>
                  <TableHead>{t('fee.col.method')}</TableHead>
                  <TableHead className="text-end">{t('fee.cash.payments')}</TableHead>
                  <TableHead className="text-end">{t('fee.cash.received')}</TableHead>
                  <TableHead className="text-end">{t('fee.cash.reversed')}</TableHead>
                  <TableHead className="text-end">{t('fee.cash.net')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.rows.map((r) => (
                  <TableRow key={`${r.collector_id}|${r.method}`}>
                    <TableCell>
                      <bdi>{r.collector_name ?? ''}</bdi>
                    </TableCell>
                    <TableCell>{t(`fee.methods.${r.method as 'cash'}`)}</TableCell>
                    <TableCell className="text-end">
                      <Num>{r.payments}</Num>
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={r.received} />
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={r.reversed + r.refunded} />
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      <Money paisa={r.net} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-end font-medium">
              {t('fee.cash.total')}: <Money paisa={q.data.total} />
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** PLAN §14.6: today's drawer, handovers, every drawer (own for accountants), collection report. */
export function CashPage() {
  const { t } = useTranslation();
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle>{t('fee.cash.title')}</PageTitle>
      <FeesTabs />
      <TodayDrawer />
      <TransferForm />
      <SessionsList />
      <CollectionReport />
    </section>
  );
}
