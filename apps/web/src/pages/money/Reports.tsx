import type {
  AccountBalanceDto,
  CashbookDto,
  ExpenseListDto,
  I18nKey,
  IncomeExpenseDto,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Money } from '@/components/fees/common';
import { Field, PageTitle } from '@/components/form';
import { AccountSelect, MoneyErrorNote, ReportActions } from '@/components/money/common';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getJson } from '@/lib/api';
import { addMonths, karachiToday, useAccounts } from '@/lib/fees';
import { accountKindKey, nameIn } from '@/lib/money';
import { type GrantRef, holds, useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { AdvanceTables } from './Advances';
import { ExpenseFilters, useExpenseFilters } from './Expenses';

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** PLAN §14.11 report pack: every report print-ready and CSV (the API's formula-safe writer). */

/**
 * The salaries line: "Salaries", or "Salaries (excluding management)" for a caller who may not see
 * owners' pay (F1). Its tooltip says what the figure is (F8: earnings − deductions, owed for the
 * month; advance recovery is not a deduction).
 */
export function SalariesLabel({ scope }: { scope: IncomeExpenseDto['salaries']['scope'] }) {
  const { t } = useTranslation();
  return (
    <span title={t('money.reports.salariesHint')} data-scope={scope} className="salaries-label">
      {scope === 'excluding_owners'
        ? t('money.reports.salariesLineExMgmt')
        : t('money.reports.salariesLine')}
    </span>
  );
}

export function ReportsHub() {
  const { t } = useTranslation();
  const roles = useRoles();
  const links: [string, I18nKey, GrantRef][] = [
    ['/reports/income-expense', 'money.reports.incomeExpense', ['receipt', 'read']],
    ['/reports/cashbook', 'money.reports.cashbook', ['receipt', 'read']],
    ['/reports/accounts', 'money.reports.accounts', ['receipt', 'read']],
    ['/reports/expenses', 'money.reports.expenses', ['expense', 'read']],
    ['/reports/salaries', 'money.reports.salaries', ['payslip', 'prepare']],
    ['/reports/advances', 'money.reports.advances', ['payslip', 'pay']],
    ['/fees/register', 'money.reports.feeRegister', ['receipt', 'read']],
    ['/fees/concessions', 'money.reports.concessions', ['receipt', 'read']],
    ['/fees/defaulters', 'money.reports.defaulters', ['fee', 'read']],
    ['/cash', 'money.reports.collection', ['cash_session', 'read']],
  ];
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle>{t('money.reports.title')}</PageTitle>
      <ul className="grid gap-2 sm:grid-cols-2">
        {links
          .filter(([, , g]) => holds(roles, g))
          .map(([to, label]) => (
            <li key={to}>
              <Link
                to={to}
                className="flex min-h-11 items-center rounded-md border px-4 py-3 font-medium hover:bg-accent"
              >
                {t(label)}
              </Link>
            </li>
          ))}
      </ul>
    </section>
  );
}

// ---- income vs expense --------------------------------------------------------------------------

/**
 * Income vs spending (expenses + salaries) per month as plain SVG bars (no chart library). Two
 * series, one axis; the table below is the accessible view. Colours are tokens (M7b): income in the
 * school colour (`--chart-in`), spending in amber (`--chart-out`), a pair that stays apart for
 * colour-blind readers whichever curated school colour is picked.
 */
export function MonthBars({ months }: { months: IncomeExpenseDto['months'] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expenses + m.salaries]));
  const W = 48;
  const H = 120;
  const bar = 16;
  const width = months.length * W;
  return (
    <figure className="flex flex-col gap-2" id="income-expense-chart">
      <figcaption className="flex flex-wrap items-center gap-4 text-sm">
        <span className="font-medium">{t('money.reports.chart')}</span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-3 rounded-sm bg-chart-in" aria-hidden />
          {t('money.reports.income')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-3 rounded-sm bg-chart-out" aria-hidden />
          {t('money.dash.spending')}
        </span>
      </figcaption>
      <div className="overflow-x-auto" dir="ltr">
        <svg
          role="img"
          aria-label={t('money.reports.chart')}
          viewBox={`0 0 ${width} ${H + 18}`}
          width={Math.max(width, 240)}
          height={H + 18}
          className="max-w-full"
        >
          <line x1={0} x2={width} y1={H} y2={H} className="stroke-border" strokeWidth={1} />
          {months.map((m, i) => {
            const spend = m.expenses + m.salaries;
            const hi = Math.round((m.income / max) * (H - 4));
            const hs = Math.round((spend / max) * (H - 4));
            const x = i * W + (W - 2 * bar - 2) / 2;
            return (
              <g key={m.period} data-period={m.period}>
                <rect x={x} y={H - hi} width={bar} height={hi} rx={3} className="fill-chart-in">
                  <title>{`${m.period} · ${t('money.reports.income')}: ${(m.income / 100).toLocaleString('en-PK')}`}</title>
                </rect>
                <rect
                  x={x + bar + 2}
                  y={H - hs}
                  width={bar}
                  height={hs}
                  rx={3}
                  className="fill-chart-out"
                >
                  <title>{`${m.period} · ${t('money.dash.spending')}: ${(spend / 100).toLocaleString('en-PK')}`}</title>
                </rect>
                <text
                  x={i * W + W / 2}
                  y={H + 14}
                  textAnchor="middle"
                  className="num fill-muted-foreground text-[10px]"
                >
                  {m.period.slice(2)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}

export function IncomeExpensePage() {
  const { t, i18n } = useTranslation();
  const now = karachiToday().slice(0, 7);
  const [from, setFrom] = useState(addMonths(now, -5));
  const [to, setTo] = useState(now);
  const valid = PERIOD.test(from) && PERIOD.test(to) && from <= to;
  const qs = `from=${from}&to=${to}`;
  const q = useQuery({
    queryKey: ['report', 'income-expense', qs],
    queryFn: () => getJson<IncomeExpenseDto>(`/api/reports/income-expense?${qs}`),
    enabled: valid,
  });
  const r = q.data;
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle
        actions={
          <ReportActions
            id="income-expense"
            csv={valid ? `/api/reports/income-expense?${qs}&format=csv` : null}
          />
        }
      >
        {t('money.reports.incomeExpense')}
      </PageTitle>
      <div className="grid gap-2 sm:grid-cols-2 print:hidden">
        <Field id="ie-from" label="money.common.from">
          <Input
            id="ie-from"
            type="month"
            className="num"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field id="ie-to" label="money.common.to">
          <Input
            id="ie-to"
            type="month"
            className="num"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <p className="text-sm text-muted-foreground">{t('money.reports.excluded')}</p>
      <MoneyErrorNote error={q.error} />
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" id="ie-totals">
            <Card className="gap-1 py-3">
              <CardContent className="px-4">
                <p className="text-xs text-muted-foreground">{t('money.reports.income')}</p>
                <p className="text-lg font-semibold">
                  <Money paisa={r.income.total} />
                </p>
              </CardContent>
            </Card>
            <Card className="gap-1 py-3">
              <CardContent className="px-4">
                <p className="text-xs text-muted-foreground">{t('money.reports.expensesLine')}</p>
                <p className="text-lg font-semibold">
                  <Money paisa={r.expenses.total} />
                </p>
              </CardContent>
            </Card>
            <Card className="gap-1 py-3">
              <CardContent className="px-4">
                <p className="text-xs text-muted-foreground">
                  <SalariesLabel scope={r.salaries.scope} />
                </p>
                <p className="text-lg font-semibold">
                  <Money paisa={r.salaries.pay} />
                </p>
              </CardContent>
            </Card>
            <Card className="gap-1 py-3">
              <CardContent className="px-4">
                <p className="text-xs text-muted-foreground">{t('money.reports.net')}</p>
                <p
                  className={cn('text-lg font-semibold', r.net < 0 && 'text-destructive')}
                  id="ie-net"
                >
                  <Money paisa={r.net} />
                </p>
              </CardContent>
            </Card>
          </div>
          <MonthBars months={r.months} />
          <h2 className="font-semibold">{t('money.reports.months')}</h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('money.common.month')}</TableHead>
                  <TableHead className="text-end">{t('money.reports.income')}</TableHead>
                  <TableHead className="text-end">{t('money.reports.expensesLine')}</TableHead>
                  <TableHead className="text-end">
                    <SalariesLabel scope={r.salaries.scope} />
                  </TableHead>
                  <TableHead className="text-end">{t('money.reports.net')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.months.map((m) => (
                  <TableRow key={m.period}>
                    <TableCell>
                      <bdi className="num">{m.period}</bdi>
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={m.income} />
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={m.expenses} />
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={m.salaries} />
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      <Money paisa={m.net} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Card className="gap-2 py-4">
              <CardHeader className="px-4">
                <CardTitle className="text-base">{t('money.reports.byHead')}</CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                <ul className="flex flex-col gap-1 text-sm">
                  {r.income.by_head.map((h) => (
                    <li key={h.fee_head_id} className="flex gap-2">
                      <bdi>{nameIn(h, i18n.language)}</bdi>
                      <span className="ms-auto">
                        <Money paisa={h.amount} />
                      </span>
                    </li>
                  ))}
                  <li className="flex gap-2 text-muted-foreground" id="ie-unallocated">
                    {t('money.reports.unallocated')}
                    <span className="ms-auto">
                      <Money paisa={r.income.unallocated} />
                    </span>
                  </li>
                </ul>
              </CardContent>
            </Card>
            <Card className="gap-2 py-4">
              <CardHeader className="px-4">
                <CardTitle className="text-base">{t('money.reports.byCategory')}</CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                <ul className="flex flex-col gap-1 text-sm">
                  {r.expenses.by_category.map((c) => (
                    <li key={c.category_id} className="flex gap-2">
                      <bdi>{nameIn(c, i18n.language)}</bdi>
                      <span className="ms-auto">
                        <Money paisa={c.amount} />
                      </span>
                    </li>
                  ))}
                  <li className="flex gap-2">
                    <SalariesLabel scope={r.salaries.scope} />
                    <span className="ms-auto">
                      <Money paisa={r.salaries.pay} />
                    </span>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>
          <Card className="gap-2 py-4" id="ie-reconciliation">
            <CardHeader className="px-4">
              <CardTitle className="text-base">{t('money.reports.reconciliation')}</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              {/* Without owner pay visible only `ties` comes back (F1): the lines are left out. */}
              {r.reconciliation.movement !== undefined && (
                <ul className="flex flex-col gap-1 text-sm" id="ie-rec-lines">
                  <li className="flex gap-2">
                    {t('money.reports.income')}
                    <span className="ms-auto">
                      <Money paisa={r.reconciliation.income ?? 0} />
                    </span>
                  </li>
                  <li className="flex gap-2">
                    {t('money.reports.expensesLine')}
                    <span className="ms-auto">
                      <Money paisa={-(r.reconciliation.expenses ?? 0)} />
                    </span>
                  </li>
                  <li className="flex gap-2">
                    {t('money.reports.recSalaryPaid')}
                    <span className="ms-auto">
                      <Money paisa={-(r.reconciliation.salary_paid ?? 0)} />
                    </span>
                  </li>
                  <li className="flex gap-2">
                    {t('money.reports.recAdvances')}
                    <span className="ms-auto">
                      <Money paisa={-(r.reconciliation.advances_paid ?? 0)} />
                    </span>
                  </li>
                  <li className="flex gap-2 border-t pt-1 font-medium">
                    {t('money.reports.recMovement')}
                    <span className="ms-auto">
                      <Money paisa={r.reconciliation.movement} />
                    </span>
                  </li>
                </ul>
              )}
              <p
                className={cn(
                  'mt-2 text-sm',
                  r.reconciliation.ties ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {r.reconciliation.ties ? t('money.reports.ties') : t('money.reports.broken')}
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}

// ---- cashbook ------------------------------------------------------------------------------------

export function CashbookPage() {
  const { t } = useTranslation();
  const today = karachiToday();
  const accounts = useAccounts().data?.accounts ?? [];
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const chosen = account || accounts[0]?.id || '';
  const valid = !!chosen && DATE.test(from) && DATE.test(to) && from <= to;
  const qs = `account_id=${chosen}&from=${from}&to=${to}`;
  const q = useQuery({
    queryKey: ['report', 'cashbook', qs],
    queryFn: () => getJson<CashbookDto>(`/api/reports/cashbook?${qs}`),
    enabled: valid,
  });
  const b = q.data;
  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <PageTitle
        actions={
          <ReportActions
            id="cashbook"
            csv={valid ? `/api/reports/cashbook?${qs}&format=csv` : null}
          />
        }
      >
        {t('money.reports.cashbook')}
      </PageTitle>
      <div className="grid gap-2 sm:grid-cols-3 print:hidden">
        <Field id="cb-account" label="money.reports.chooseAccount">
          <AccountSelect id="cb-account" value={chosen} accounts={accounts} onChange={setAccount} />
        </Field>
        <Field id="cb-from" label="money.common.from">
          <Input
            id="cb-from"
            type="date"
            className="num"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field id="cb-to" label="money.common.to">
          <Input
            id="cb-to"
            type="date"
            className="num"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <MoneyErrorNote error={q.error} />
      {b && (
        <>
          <h2 className="font-semibold">
            <bdi>{b.account.name}</bdi> · {t(accountKindKey(b.account.kind))}
          </h2>
          <div className="overflow-x-auto">
            <Table id="cashbook-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('money.common.date')}</TableHead>
                  <TableHead>{t('money.common.category')}</TableHead>
                  <TableHead>{t('money.reports.ref')}</TableHead>
                  <TableHead>{t('money.reports.party')}</TableHead>
                  <TableHead className="text-end">{t('money.reports.in')}</TableHead>
                  <TableHead className="text-end">{t('money.reports.out')}</TableHead>
                  <TableHead className="text-end">{t('money.reports.balance')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>
                    <bdi className="num">{b.from}</bdi>
                  </TableCell>
                  <TableCell colSpan={5}>{t('money.reports.opening')}</TableCell>
                  <TableCell className="text-end font-medium" id="cashbook-opening">
                    <Money paisa={b.opening} />
                  </TableCell>
                </TableRow>
                {b.rows.map((x) => (
                  // Masked owner rows share a ref_id ('owner_draw'); the running balance changes on
                  // every row (no movement is 0), so it keeps the key unique.
                  <TableRow key={`${x.kind}-${x.ref_id}-${x.date}-${x.balance}`} data-kind={x.kind}>
                    <TableCell>
                      <bdi className="num">{x.date}</bdi>
                    </TableCell>
                    <TableCell>{t(`money.reports.kind.${x.kind}`)}</TableCell>
                    <TableCell>
                      <bdi className="num">{x.ref_no ?? ''}</bdi>
                    </TableCell>
                    <TableCell>
                      <bdi>{x.party ?? ''}</bdi>
                    </TableCell>
                    <TableCell className="text-end">
                      {x.amount > 0 ? <Money paisa={x.amount} /> : ''}
                    </TableCell>
                    <TableCell className="text-end">
                      {x.amount < 0 ? <Money paisa={-x.amount} /> : ''}
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={x.balance} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableBody className="border-t-2 font-medium">
                <TableRow>
                  <TableCell>
                    <bdi className="num">{b.to}</bdi>
                  </TableCell>
                  <TableCell colSpan={3}>{t('money.reports.closing')}</TableCell>
                  <TableCell className="text-end">
                    <Money paisa={b.in} />
                  </TableCell>
                  <TableCell className="text-end">
                    <Money paisa={b.out} />
                  </TableCell>
                  <TableCell className="text-end font-semibold" id="cashbook-closing">
                    <Money paisa={b.closing} />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          {b.rows.length === 0 && (
            <p className="text-muted-foreground">{t('money.reports.noRows')}</p>
          )}
        </>
      )}
    </section>
  );
}

// ---- balances -------------------------------------------------------------------------------------

export function AccountsPage() {
  const { t } = useTranslation();
  const [asOf, setAsOf] = useState(karachiToday());
  const valid = DATE.test(asOf);
  const q = useQuery({
    queryKey: ['report', 'accounts', asOf],
    queryFn: () =>
      getJson<{ accounts: AccountBalanceDto[]; total: number }>(
        `/api/reports/accounts?as_of=${asOf}`,
      ),
    enabled: valid,
  });
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle
        actions={
          <ReportActions
            id="accounts"
            csv={valid ? `/api/reports/accounts?as_of=${asOf}&format=csv` : null}
          />
        }
      >
        {t('money.reports.accounts')}
      </PageTitle>
      <Field id="acc-asof" label="money.reports.asOf" className="max-w-xs print:hidden">
        <Input
          id="acc-asof"
          type="date"
          className="num"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </Field>
      <MoneyErrorNote error={q.error} />
      {q.data && (
        <Table id="accounts-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t('money.common.account')}</TableHead>
              <TableHead className="text-end">{t('money.reports.balance')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.accounts.map((a) => (
              <TableRow key={a.account_id ?? 'none'}>
                <TableCell>
                  <bdi>{a.name}</bdi> · {t(accountKindKey(a.kind))}
                </TableCell>
                <TableCell className="text-end">
                  <Money paisa={a.balance} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableBody className="border-t-2 font-medium">
            <TableRow>
              <TableCell>{t('money.reports.totalAll')}</TableCell>
              <TableCell className="text-end font-semibold">
                <Money paisa={q.data.total} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </section>
  );
}

// ---- registers -----------------------------------------------------------------------------------

export function ExpenseRegisterPage() {
  const { t, i18n } = useTranslation();
  const f = useExpenseFilters();
  const q = useQuery({
    queryKey: ['expenses', 'register', f.qs],
    queryFn: () => getJson<ExpenseListDto>(`/api/reports/expenses?${f.qs}`),
    enabled: f.valid,
  });
  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <PageTitle
        actions={
          <ReportActions id="expense-register" csv={`/api/reports/expenses?${f.qs}&format=csv`} />
        }
      >
        {t('money.reports.expenses')}
      </PageTitle>
      <ExpenseFilters f={f} />
      <MoneyErrorNote error={q.error} />
      {q.data && q.data.expenses.length === 0 && (
        <p className="text-muted-foreground">{t('money.expense.empty')}</p>
      )}
      {q.data && q.data.expenses.length > 0 && (
        <div className="overflow-x-auto">
          <Table id="expense-register">
            <TableHeader>
              <TableRow>
                <TableHead>{t('money.expense.number')}</TableHead>
                <TableHead>{t('money.common.date')}</TableHead>
                <TableHead>{t('money.common.category')}</TableHead>
                <TableHead>{t('money.common.account')}</TableHead>
                <TableHead>{t('money.common.vendor')}</TableHead>
                <TableHead className="text-end">{t('money.common.amount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.expenses.map((e) => (
                <TableRow
                  key={e.id}
                  className={cn(e.voided && 'text-muted-foreground line-through')}
                >
                  <TableCell>
                    <bdi className="num">{e.expense_no}</bdi>
                  </TableCell>
                  <TableCell>
                    <bdi className="num">{e.date}</bdi>
                  </TableCell>
                  <TableCell>
                    <bdi>
                      {nameIn(
                        { name: e.category_name, name_ur: e.category_name_ur },
                        i18n.language,
                      )}
                    </bdi>
                  </TableCell>
                  <TableCell>
                    <bdi>{e.account_name}</bdi>
                  </TableCell>
                  <TableCell>
                    <bdi>{e.vendor ?? ''}</bdi>
                  </TableCell>
                  <TableCell className="text-end">
                    <Money paisa={e.amount} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableBody className="border-t-2 font-medium">
              <TableRow>
                <TableCell colSpan={5}>{t('money.expense.totalLine')}</TableCell>
                <TableCell className="text-end font-semibold">
                  <Money paisa={q.data.total} />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

export function AdvanceRegisterPage() {
  const { t } = useTranslation();
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle
        actions={<ReportActions id="advance-register" csv="/api/reports/advances?format=csv" />}
      >
        {t('money.reports.advances')}
      </PageTitle>
      <AdvanceTables />
    </section>
  );
}
