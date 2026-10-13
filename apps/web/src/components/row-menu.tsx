import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/*
 * The "more" button on a row or page header (M7b, UI plan §5.4): rare and destructive actions live
 * here instead of beside every row ("Void" on an expense, "Reverse" on a receipt). A destructive
 * item is red, comes last after a separator, and the caller still asks before acting
 * (ConfirmDialog with the reason field where the API wants one). Lazy-only: not in the shell.
 */

export type RowAction = {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

export function RowMenu({
  actions,
  label,
  className,
  id,
}: {
  id?: string;
  actions: readonly RowAction[];
  /** Accessible name of the button, e.g. "More actions for EXP-2026-00012". */
  label?: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const visible = actions.filter(Boolean);
  if (visible.length === 0) return null;
  const plain = visible.filter((a) => !a.destructive);
  const danger = visible.filter((a) => a.destructive);
  const item = (a: RowAction) => {
    const Icon = a.icon;
    return (
      <DropdownMenu.Item
        key={a.id}
        id={`row-action-${a.id}`}
        disabled={a.disabled}
        onSelect={a.onSelect}
        data-destructive={a.destructive || undefined}
        className={cn(
          'flex min-h-ctl cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm font-medium outline-none select-none',
          'data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
          a.destructive && 'text-destructive data-[highlighted]:bg-bad-soft',
        )}
      >
        {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
        {a.label}
      </DropdownMenu.Item>
    );
  };
  return (
    <DropdownMenu.Root dir={i18n.language === 'ur' ? 'rtl' : 'ltr'} modal={false}>
      <DropdownMenu.Trigger
        id={id}
        aria-label={label ?? t('shell.rowMenu')}
        className={cn(
          'inline-grid size-ctl shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
          'focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-accent',
          className,
        )}
      >
        <MoreHorizontal className="size-5" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 flex min-w-44 flex-col rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {plain.map(item)}
          {plain.length > 0 && danger.length > 0 && (
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
          )}
          {danger.map(item)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
