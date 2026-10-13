import { SlidersHorizontal, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsPhone } from '@/lib/media';
import { cn } from '@/lib/utils';

/*
 * FilterBar (M7b, UI plan §5.4): on desktop the filter controls sit inline; on a phone one
 * "Filters" button (with the number applied) opens a bottom sheet holding the same controls, and
 * each applied filter shows as a chip that clears it. Search, when given, stays visible on both.
 * Lazy-only.
 */

export type ActiveFilter = {
  id: string;
  /** "Class: 5-A", "From 1 Oct". */
  label: ReactNode;
  onClear: () => void;
};

export function FilterBar({
  search,
  children,
  active = [],
  onClearAll,
  className,
  id = 'filters',
}: {
  search?: ReactNode;
  /** The filter controls (Field + Select/Input…), rendered inline or in the sheet. */
  children: ReactNode;
  active?: readonly ActiveFilter[];
  onClearAll?: () => void;
  className?: string;
  id?: string;
}) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);

  if (!phone)
    return (
      <div
        id={id}
        data-layout="inline"
        className={cn('flex flex-col gap-3 print:hidden', className)}
      >
        {search}
        <div className="flex flex-wrap items-end gap-3 [&>*]:min-w-40 [&>*]:flex-1">{children}</div>
      </div>
    );

  return (
    <div id={id} data-layout="sheet" className={cn('flex flex-col gap-2 print:hidden', className)}>
      <div className="flex gap-2">
        {search && <div className="min-w-0 flex-1">{search}</div>}
        <Button
          type="button"
          variant="outline"
          aria-expanded={open}
          aria-controls={`${id}-sheet`}
          onClick={() => setOpen(true)}
          className={cn(!search && 'self-start')}
        >
          <SlidersHorizontal aria-hidden />
          {t('shell.filters.open')}
          {active.length > 0 && (
            <span className="num rounded-full bg-brand px-1.5 text-[11px] leading-[18px] font-bold text-brand-fg">
              {active.length}
            </span>
          )}
        </Button>
      </div>
      {active.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('shell.filters.applied')}>
          {active.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={f.onClear}
                data-filter={f.id}
                className="inline-flex min-h-ctl items-center gap-1.5 rounded-full border bg-card ps-3 pe-2 text-meta font-semibold hover:bg-accent"
              >
                <span>{f.label}</span>
                <X className="size-3.5" aria-hidden />
                <span className="sr-only">{t('shell.filters.clear')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          id={`${id}-sheet`}
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-card pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="pb-0">
            <SheetTitle>{t('shell.filters.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('shell.filters.title')}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4">{children}</div>
          <div className="flex gap-2 border-t px-4 pt-3 pb-4">
            {onClearAll && active.length > 0 && (
              <Button type="button" variant="outline" onClick={onClearAll}>
                {t('shell.filters.clearAll')}
              </Button>
            )}
            <Button type="button" className="ms-auto" onClick={() => setOpen(false)}>
              {t('shell.filters.done')}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
