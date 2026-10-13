import type { FeeLineDto } from '@maktab/shared';
import { Delete } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field } from '@/components/form';
import { type Tone, StatusBadge as ToneBadge } from '@/components/page';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatRupeeInput, headLabel, money, type PaymentMethod } from '@/lib/fees';
import { cn } from '@/lib/utils';

/** An amount: Latin digits, isolated LTR in the system font (PLAN §12 exp3 rule 1). */
export function Money({ paisa, className }: { paisa: number; className?: string }) {
  return <bdi className={cn('num whitespace-nowrap', className)}>{money(paisa)}</bdi>;
}

const FEE_TONE: Record<FeeLineDto['status'], Tone> = {
  overdue: 'bad',
  due: 'warn',
  partial: 'info',
  paid: 'ok',
};

/** A fee line's state in the fixed status tones: overdue red, due amber, part paid blue, paid green. */
export function StatusBadge({ status }: { status: FeeLineDto['status'] }) {
  const { t } = useTranslation();
  return <ToneBadge tone={FEE_TONE[status]}>{t(`fee.status.${status}`)}</ToneBadge>;
}

export const METHODS: PaymentMethod[] = [
  'cash',
  'bank',
  'jazzcash',
  'easypaisa',
  'cheque',
  'other',
];

/** Method chips: a radio group of 44 px buttons (ids `method-<name>` for scripted checks). */
export function MethodChips({
  value,
  onChange,
  name = 'method',
}: {
  value: PaymentMethod;
  onChange: (m: PaymentMethod) => void;
  name?: string;
}) {
  const { t } = useTranslation();
  return (
    <fieldset aria-label={t('fee.counter.method')} className="flex flex-wrap gap-2">
      {METHODS.map((m) => (
        <button
          key={m}
          id={`${name}-${m}`}
          type="button"
          aria-pressed={value === m}
          data-method={m}
          onClick={() => onChange(m)}
          className={cn(
            'min-h-11 min-w-11 rounded-full border px-4 text-sm font-medium',
            value === m
              ? 'border-brand bg-brand text-brand-fg shadow-xs'
              : 'bg-card hover:bg-accent',
          )}
        >
          {t(`fee.methods.${m}`)}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * Rupee amount box: numeric keyboard on phones, thousands separators while typing, Latin digits
 * even when the phone types Urdu ones. The parent keeps the text; paisa is derived by the caller.
 */
export function AmountInput({
  id,
  value,
  onChange,
  keypad = false,
  invalid,
  ...rest
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  keypad?: boolean;
  invalid?: boolean;
  'aria-describedby'?: string;
}) {
  const { t } = useTranslation();
  const press = (k: string) => {
    if (k === 'del') return onChange(formatRupeeInput(value.slice(0, -1)));
    if (k === 'clear') return onChange('');
    onChange(formatRupeeInput(value + k));
  };
  return (
    <div className="flex flex-col gap-2">
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        dir="ltr"
        className="num h-14 text-end text-2xl font-bold tracking-tight"
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(formatRupeeInput(e.target.value))}
        {...rest}
      />
      {keypad && (
        <fieldset className="grid grid-cols-3 gap-2" dir="ltr" aria-label={t('fee.counter.keypad')}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0'].map((k) => (
            <Button
              key={k}
              type="button"
              variant="outline"
              className="num h-12 text-lg font-semibold"
              onClick={() => press(k)}
            >
              {k}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            className="h-12"
            aria-label={t('fee.counter.backspace')}
            onClick={() => press('del')}
          >
            <Delete aria-hidden />
          </Button>
        </fieldset>
      )}
    </div>
  );
}

/** Root fee lines (gross, concession, fine, net, paid, due), optionally with an action per row. */
export function FeeLinesTable({
  lines,
  showStudent = true,
  action,
  compact = false,
}: {
  lines: readonly FeeLineDto[];
  showStudent?: boolean;
  action?: (l: FeeLineDto) => ReactNode;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {showStudent && <TableHead>{t('fee.col.student')}</TableHead>}
            <TableHead>{t('fee.col.period')}</TableHead>
            <TableHead>{t('fee.col.head')}</TableHead>
            {!compact && <TableHead className="text-end">{t('fee.col.gross')}</TableHead>}
            {!compact && <TableHead className="text-end">{t('fee.col.concession')}</TableHead>}
            {!compact && <TableHead className="text-end">{t('fee.col.fine')}</TableHead>}
            <TableHead className="text-end">{t('fee.col.net')}</TableHead>
            {!compact && <TableHead className="text-end">{t('fee.col.paid')}</TableHead>}
            <TableHead className="text-end">{t('fee.col.due')}</TableHead>
            <TableHead>{t('fee.col.status')}</TableHead>
            {action && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id} data-line={l.id}>
              {showStudent && (
                <TableCell>
                  <bdi>{l.student_name}</bdi>
                </TableCell>
              )}
              <TableCell>
                <bdi className="num">{l.period_key}</bdi>
              </TableCell>
              <TableCell>
                <bdi>{headLabel(l, i18n.language)}</bdi>
              </TableCell>
              {!compact && (
                <TableCell className="text-end">
                  <Money paisa={l.gross} />
                </TableCell>
              )}
              {!compact && (
                <TableCell className="text-end">
                  {l.concession ? <Money paisa={l.concession} /> : '—'}
                </TableCell>
              )}
              {!compact && (
                <TableCell className="text-end">
                  {l.fine ? <Money paisa={l.fine} /> : '—'}
                </TableCell>
              )}
              <TableCell className="text-end">
                <Money paisa={l.net} />
              </TableCell>
              {!compact && (
                <TableCell className="text-end">
                  <Money paisa={l.paid} />
                </TableCell>
              )}
              <TableCell className="text-end font-medium">
                <Money paisa={l.due} />
              </TableCell>
              <TableCell>
                <StatusBadge status={l.status} />
              </TableCell>
              {action && <TableCell>{action(l)}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** A destructive or audited action that needs a reason (PLAN §14 conventions). */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  pending,
  error,
  onConfirm,
  children,
  id = 'reason',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  error?: unknown;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
  id?: string;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setMissing(true);
    setMissing(false);
    onConfirm(reason.trim());
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {body && (
              <DialogDescription asChild>
                <div>{body}</div>
              </DialogDescription>
            )}
          </DialogHeader>
          {children}
          <Field
            id={`${id}-reason`}
            label="fee.col.reason"
            required
            error={missing ? 'required' : undefined}
          >
            <Textarea
              id={`${id}-reason`}
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <ErrorNote error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending} id={`${id}-confirm`}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A small labelled figure (dashboard tiles, totals rows). */
export function Figure({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: 'strong' | 'muted';
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className={cn(tone === 'strong' ? 'text-xl font-bold' : 'font-semibold')}>
        {children}
      </span>
    </div>
  );
}

export function ConcessionValue({ type, value }: { type: 'pct' | 'fixed'; value: number }) {
  return type === 'pct' ? <bdi className="num">{`${value}%`}</bdi> : <Money paisa={value} />;
}
