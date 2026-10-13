import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Native <select>: the phone's own picker is the best one on low-end Android. */
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'border-input flex h-ctl w-full min-w-0 rounded-lg border bg-card px-3 text-base shadow-xs outline-none md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:border-destructive disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Select };
