import { formatPKR } from '@maktab/shared';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/*
 * Shared page parts (M7b, UI plan §5.4): one header, panels instead of nested cards, one stat strip,
 * row lists with full-width tap targets, the fixed status tones, one money cell, empty and loading
 * states, and a confirm dialog. Screens move onto these one at a time (Students and Expenses first).
 */

/** Width tiers (UI plan §5.4): forms ~680 px, detail pages ~1080 px, tables full width; centred. */
const WIDTH = { form: 'max-w-[680px]', detail: 'max-w-[1080px]', full: 'max-w-none' } as const;

export function Page({
  width = 'detail',
  className,
  children,
  ...rest
}: {
  width?: keyof typeof WIDTH;
  className?: string;
  children: ReactNode;
} & Omit<React.ComponentProps<'section'>, 'children'>) {
  return (
    <section
      {...rest}
      className={cn('mx-auto flex w-full flex-col gap-5', WIDTH[width], className)}
    >
      {children}
    </section>
  );
}

/** Title, optional subtitle, one primary action and secondary actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <header className="flex flex-col gap-1">
      {back && (
        <Link
          to={back.to}
          className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="size-4 rotate-180 rtl:rotate-0" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col">
          <h1 className="text-title text-balance">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="ms-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** A section with a header row (title + optional action); replaces most cards. */
export function Panel({
  title,
  action,
  id,
  className,
  bodyClassName,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  id?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn('rounded-xl border bg-card text-card-foreground', className)}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      {(title || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          {title && <h2 className="text-section font-semibold">{title}</h2>}
          {action && <div className="ms-auto flex items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export type StatItem = {
  id?: string;
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  to?: string;
};

/** One strip of figures (label, value, optional note), 4 across on desktop, 2 on a phone. */
export function StatStrip({ items, className }: { items: StatItem[]; className?: string }) {
  return (
    <dl
      className={cn(
        'grid grid-cols-2 overflow-hidden rounded-xl border bg-card lg:grid-cols-4',
        className,
      )}
    >
      {items.map((s, i) => {
        const body = (
          <>
            <dt className="text-meta text-muted-foreground">{s.label}</dt>
            <dd className="mt-0.5 text-lg font-bold">{s.value}</dd>
            {s.note && <dd className="text-meta text-muted-foreground">{s.note}</dd>}
          </>
        );
        return (
          <div
            key={s.id ?? i}
            id={s.id}
            className="border-b border-e px-4 py-3 [&:nth-child(2n)]:border-e-0 lg:border-b-0 lg:[&:nth-child(2n)]:border-e lg:last:border-e-0"
          >
            {s.to ? (
              <Link to={s.to} className="block min-h-11 hover:underline">
                {body}
              </Link>
            ) : (
              body
            )}
          </div>
        );
      })}
    </dl>
  );
}

/** A list of rows separated by hairlines (inside a Panel or on its own). */
export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn('flex flex-col divide-y', className)}>{children}</ul>;
}

/** One row: a full-width tap target when `to` is given (min 44 px on touch). */
export function ListRow({
  to,
  leading,
  title,
  meta,
  trailing,
  chevron = !!to,
  className,
}: {
  to?: string;
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  className?: string;
}) {
  const inner = (
    <>
      {leading}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        {meta && <span className="truncate text-meta text-muted-foreground">{meta}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2">{trailing}</span>}
      {chevron && (
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
          aria-hidden
        />
      )}
    </>
  );
  const cls = cn('flex min-h-12 items-center gap-3 px-4 py-2', className);
  return (
    <li>
      {to ? (
        <Link to={to} className={cn(cls, 'hover:bg-accent focus-visible:bg-accent')}>
          {inner}
        </Link>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}

export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'neutral';
const TONE: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  bad: 'bg-bad-soft text-bad',
  warn: 'bg-warn-soft text-warn',
  info: 'bg-info-soft text-info',
  neutral: 'bg-muted text-muted-foreground',
};
/** Soft background + strong text, for each status tone (fixed for every school). */
export const toneClass = (tone: Tone) => TONE[tone];

/** A status pill with a dot: present/paid (ok), absent/overdue (bad), late/due (warn), info. */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-meta font-semibold whitespace-nowrap',
        'before:size-1.5 before:shrink-0 before:rounded-full before:bg-current',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Money on screen: a small muted "PKR", then the amount in tabular figures, one isolated LTR run
 * (Latin digits in Urdu too). The text is exactly `formatPKR` ("PKR 5,700", "-PKR 500.50").
 */
export function Mny({ paisa, className }: { paisa: number; className?: string }) {
  const text = formatPKR(paisa);
  const at = text.indexOf('PKR');
  const sign = text.slice(0, at);
  const amount = text.slice(at + 3).trim();
  return (
    <bdi className={cn('mny', className)} data-paisa={paisa}>
      {sign}
      <span className="mny-cur">PKR</span> {amount}
    </bdi>
  );
}

/** What will appear here, and the action that fills it (PLAN §11 "Empty states that teach"). */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 px-6 py-10 text-center text-muted-foreground',
        className,
      )}
    >
      {Icon && (
        <span className="mb-1 grid size-11 place-items-center rounded-full bg-brand-soft text-brand">
          <Icon className="size-5" aria-hidden />
        </span>
      )}
      <p className="font-semibold text-foreground">{title}</p>
      {body && <p className="max-w-prose text-sm">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Placeholder bars while a list or figure loads (instead of "Loading…" text). */
export function Skeleton({ className }: { className?: string }) {
  return <span className={cn('block animate-pulse rounded-md bg-muted', className)} aria-hidden />;
}

/** A list's loading state: `rows` skeleton rows, announced once as loading. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t('common.loading')} className="flex flex-col divide-y">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex min-h-12 items-center gap-3 px-4 py-2">
          <Skeleton className="size-8 rounded-full" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </span>
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  );
}

/** Ask before a consequential action; the confirm button carries the action's own name. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirm,
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirm: ReactNode;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {body && <DialogDescription>{body}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={onConfirm}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Small action link in a row or panel header ("See defaulters ›"). */
export function GoLink({ to, children, id }: { to: string; children: ReactNode; id?: string }) {
  return (
    <Link
      id={id}
      to={to}
      className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline"
    >
      {children}
      <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
    </Link>
  );
}
