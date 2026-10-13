import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { cn } from '@/lib/utils';

/*
 * Small option sets and in-page sections (M7b, UI plan §5.4). Both are tiny and dependency-free so
 * the shell (entry chunk) can use SegmentedControl for the theme switch.
 */

export type SegmentOption<V extends string> = { value: V; label: ReactNode; icon?: LucideIcon };

/**
 * A few mutually exclusive choices that apply at once (theme, paper size, language of a print).
 * Toggle buttons in a labelled group: each carries `aria-pressed`. Height is the density token.
 */
export function SegmentedControl<V extends string>({
  label,
  value,
  options,
  onChange,
  className,
  id,
}: {
  label: ReactNode;
  value: V;
  options: readonly SegmentOption<V>[];
  onChange: (v: V) => void;
  className?: string;
  id?: string;
}) {
  return (
    <fieldset className={cn('flex min-w-0 flex-col gap-1.5', className)} id={id}>
      <legend className="mb-1.5 text-meta font-semibold text-muted-foreground">{label}</legend>
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-muted p-1">
        {options.map((o) => {
          const Icon = o.icon;
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(o.value)}
              className={cn(
                // The control's outer height is the density token (36 px mouse / 44 px touch):
                // the 4 px track padding is taken out of the buttons.
                'flex h-[calc(var(--h)-8px)] min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-meta font-medium text-muted-foreground',
                'focus-visible:outline-2 focus-visible:outline-ring',
                on && 'bg-card text-foreground shadow-xs',
              )}
            >
              {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
              <span className="truncate">{o.label}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export type TabItem<V extends string> = { value: V; label: ReactNode; count?: ReactNode };

/**
 * In-page sections (WAI-ARIA tabs): a tablist with roving focus (arrow keys, Home/End; mirrored in
 * Urdu), `aria-selected`, and each tab controlling its panel `${idBase}-panel-${value}`. Render the
 * selected panel with `<TabPanel>`. Scrolls sideways on a phone instead of wrapping.
 */
export function Tabs<V extends string>({
  label,
  value,
  items,
  onChange,
  idBase,
  className,
}: {
  label: string;
  value: V;
  items: readonly TabItem<V>[];
  onChange: (v: V) => void;
  idBase: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = items.findIndex((i) => i.value === value);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const step: Record<string, number> = {
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
      Home: -at,
      End: items.length - 1 - at,
    };
    const d = step[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const next = (at + d + items.length) % items.length;
    const item = items[next];
    if (!item) return;
    onChange(item.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={move}
      className={cn('flex gap-1 overflow-x-auto border-b [scrollbar-width:none]', className)}
    >
      {items.map((it, i) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${it.value}`}
            aria-selected={on}
            aria-controls={`${idBase}-panel-${it.value}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.value)}
            className={cn(
              'relative inline-flex min-h-ctl shrink-0 items-center gap-1.5 px-3 text-sm font-semibold whitespace-nowrap text-muted-foreground hover:text-foreground',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
              on &&
                'text-brand after:absolute after:inset-x-2 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-brand',
            )}
          >
            {it.label}
            {it.count !== undefined && (
              <span className="num rounded-full bg-muted px-1.5 text-[11px] leading-[18px] text-muted-foreground">
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel for the selected tab (pair with `Tabs` and the same `idBase`). */
export function TabPanel({
  idBase,
  value,
  children,
  className,
}: {
  idBase: string;
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${value}`}
      aria-labelledby={`${idBase}-tab-${value}`}
      className={className}
    >
      {children}
    </div>
  );
}
