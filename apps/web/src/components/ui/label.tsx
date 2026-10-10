import type * as React from 'react';
import { cn } from '@/lib/utils';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or wrap the control.
    <label
      data-slot="label"
      className={cn('text-sm font-medium leading-snug select-none', className)}
      {...props}
    />
  );
}

export { Label };
