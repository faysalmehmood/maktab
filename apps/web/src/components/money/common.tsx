import type { PayslipStatus } from '@maktab/shared';
import { Download, Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useErrorText } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import type { Account } from '@/lib/fees';
import { accountKindKey } from '@/lib/money';
import { printWhenReady } from '@/lib/print';

/**
 * Error sentence for the money-out screens: codes shared with the fee screens but worded
 * differently here (exceeds_net, already_void, not_voidable) read from money.err first.
 */
export function MoneyErrorNote({ error }: { error: unknown }) {
  const { t, i18n } = useTranslation();
  const text = useErrorText();
  if (!error) return null;
  const key = error instanceof ApiError ? `money.err.${error.code}` : '';
  const msg = key && i18n.exists(key) ? String(t(key as 'money.err.exceeds_net')) : text(error);
  return (
    <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
      {msg}
    </p>
  );
}

/**
 * Accounts money can be paid out of (M4 fix pass, F3): the caller's own drawer and every bank or
 * wallet — never someone else's drawer (the API refuses it with not_your_drawer).
 */
export function payOutAccounts(accounts: readonly Account[], myDrawer: string | null | undefined) {
  return accounts.filter((a) => a.kind !== 'cash' || a.id === myDrawer);
}

/** Account picker: "<name> · Drawer/Bank/Wallet"; names are data (isolated by the option). */
export function AccountSelect({
  id,
  value,
  onChange,
  accounts,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  accounts: readonly Account[];
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {t(accountKindKey(a.kind))}
        </option>
      ))}
    </Select>
  );
}

/** Status badge; an approved slip with part of its net paid reads "Partly paid" (verify pass). */
export function PayslipStatusBadge({
  status,
  partial = false,
}: {
  status: PayslipStatus;
  partial?: boolean;
}) {
  const { t } = useTranslation();
  if (status === 'approved' && partial)
    return (
      <Badge variant="default" data-status="approved" data-partial="true">
        {t('money.salary.partlyPaid')}
      </Badge>
    );
  const variant =
    status === 'void'
      ? 'destructive'
      : status === 'paid'
        ? 'outline'
        : status === 'approved'
          ? 'default'
          : ('secondary' as const);
  return (
    <Badge variant={variant} data-status={status}>
      {t(`money.salary.status.${status}`)}
    </Badge>
  );
}

/** Print + CSV buttons for a report page (CSV comes from the API's formula-safe writer). */
export function ReportActions({ csv, id }: { csv?: string | null; id: string }) {
  const { t } = useTranslation();
  return (
    <>
      {csv && (
        <Button asChild variant="outline" id={`${id}-csv`} className="print:hidden">
          <a href={csv} download>
            <Download aria-hidden />
            {t('money.common.csv')}
          </a>
        </Button>
      )}
      <Button
        variant="outline"
        onClick={() => void printWhenReady()}
        className="print:hidden"
        id={`${id}-print`}
      >
        <Printer aria-hidden />
        {t('money.common.print')}
      </Button>
    </>
  );
}
