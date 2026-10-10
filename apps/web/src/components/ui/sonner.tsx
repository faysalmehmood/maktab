import type * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** shadcn's current toast component (the older `toast` primitive is deprecated in favour of sonner). */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { toast } from 'sonner';
export { Toaster };
