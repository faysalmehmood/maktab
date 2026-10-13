import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ListSkeleton } from '@/components/page';
import { useIsPhone } from '@/lib/media';
import { cn } from '@/lib/utils';

/*
 * DataTable (M7b, UI plan §5.4): a semantic <table> on desktop (caption, column headers with
 * scope, sticky header, whole-row click through one real link per row) and, on a phone, the same
 * rows as cards: the primary cell as the title, the other columns as label/value lines. One markup
 * at a time (not both hidden by CSS), so screen readers and text queries see each value once.
 * Lazy-only: office screens import it, the shell does not.
 */

export type Column<R> = {
  id: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  /** Numbers and amounts: end-aligned, tabular. */
  numeric?: boolean;
  /** The row's name: a link when the table has `rowHref`; the card title on a phone. */
  primary?: boolean;
  /** Left out of the phone card (e.g. a column the title already says). */
  hideOnPhone?: boolean;
  className?: string;
};

export function DataTable<R>({
  caption,
  columns,
  rows,
  rowKey,
  rowHref,
  rowActions,
  loading = false,
  error,
  empty,
  className,
  id,
}: {
  /** Names the table for assistive tech (visually hidden unless `caption` is shown elsewhere). */
  caption: string;
  columns: readonly Column<R>[];
  rows: readonly R[] | undefined;
  rowKey: (row: R) => string;
  rowHref?: (row: R) => string;
  /** Trailing per-row controls (e.g. a RowMenu); never inside the row link. */
  rowActions?: (row: R) => ReactNode;
  loading?: boolean;
  /** Shown instead of rows when loading failed (never an empty table that reads as "none"). */
  error?: ReactNode;
  empty?: ReactNode;
  className?: string;
  id?: string;
}) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const primary = columns.find((c) => c.primary) ?? columns[0];
  if (loading) return <ListSkeleton rows={5} />;
  if (error)
    return (
      <p role="alert" className="px-4 py-3 text-sm text-destructive" id={id}>
        {error}
      </p>
    );
  if (!rows || rows.length === 0) return <>{empty}</>;

  if (phone) {
    return (
      <ul
        id={id}
        aria-label={caption}
        data-layout="cards"
        className={cn('flex flex-col divide-y', className)}
      >
        {rows.map((r) => {
          const href = rowHref?.(r);
          const body = (
            <>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-medium">{primary?.cell(r)}</span>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 text-meta">
                  {columns
                    .filter((c) => c !== primary && !c.hideOnPhone)
                    .map((c) => (
                      <div key={c.id} className="contents">
                        <dt className="text-muted-foreground">{c.header}</dt>
                        <dd className="min-w-0">{c.cell(r)}</dd>
                      </div>
                    ))}
                </dl>
              </span>
              {href && (
                <ChevronRight
                  className="size-4 shrink-0 self-center text-muted-foreground rtl:-scale-x-100"
                  aria-hidden
                />
              )}
            </>
          );
          return (
            <li key={rowKey(r)} className="flex items-start gap-1 pe-2">
              {href ? (
                <Link
                  to={href}
                  className="flex min-h-12 min-w-0 flex-1 gap-3 px-4 py-3 hover:bg-accent focus-visible:bg-accent"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex min-h-12 min-w-0 flex-1 gap-3 px-4 py-3">{body}</div>
              )}
              {rowActions && <span className="self-center">{rowActions(r)}</span>}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    // No overflow box: the header sticks under the shell's 56 px top bar while the page scrolls
    // (phones get cards, so the table never needs to scroll sideways).
    <div className={className}>
      <table id={id} data-layout="table" className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-14 z-[3] bg-card">
          <tr className="border-b">
            {columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                className={cn(
                  'px-4 py-2 text-start text-meta font-semibold whitespace-nowrap text-muted-foreground',
                  c.numeric && 'text-end',
                  c.className,
                )}
              >
                {c.header}
              </th>
            ))}
            {rowActions && (
              <th scope="col" className="w-12 px-2">
                <span className="sr-only">{t('shell.rowMenu')}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => {
            const href = rowHref?.(r);
            return (
              <tr
                key={rowKey(r)}
                className={cn('relative', href && 'hover:bg-accent focus-within:bg-accent')}
              >
                {columns.map((c) => {
                  const v = c.cell(r);
                  return c === primary ? (
                    <th
                      key={c.id}
                      scope="row"
                      className={cn('px-4 py-2.5 text-start font-medium', c.className)}
                    >
                      {href ? (
                        // One link per row; its ::after covers the row so the whole row clicks.
                        <Link
                          to={href}
                          className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                        >
                          {v}
                        </Link>
                      ) : (
                        v
                      )}
                    </th>
                  ) : (
                    <td
                      key={c.id}
                      className={cn(
                        'px-4 py-2.5',
                        c.numeric && 'text-end tabular-nums whitespace-nowrap',
                        c.className,
                      )}
                    >
                      {v}
                    </td>
                  );
                })}
                {rowActions && (
                  // Above the row link's overlay so the menu stays clickable.
                  <td className="relative z-[2] w-12 px-2 text-end">{rowActions(r)}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
