import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Native checkbox inside a 44 px row label, so the whole line is the touch target. */
function Checkbox({
  className,
  label,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'> & { label: React.ReactNode }) {
  return (
    <label className={cn('flex min-h-11 cursor-pointer items-center gap-3 text-sm', className)}>
      <input type="checkbox" className="size-5 shrink-0 accent-primary" {...props} />
      <span>{label}</span>
    </label>
  );
}

export { Checkbox };
