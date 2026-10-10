import type { I18nKey } from '@maktab/shared';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { errorKey } from '@/lib/form';
import { cn } from '@/lib/utils';

/** API error → translated sentence (falls back to the server's English message). */
export function useErrorText() {
  const { t, i18n } = useTranslation();
  return (err: unknown): string => {
    if (err instanceof ApiError) {
      const key = errorKey(err.code);
      return i18n.exists(key) ? String(t(key)) : err.message;
    }
    if (err instanceof Error && i18n.exists(errorKey(err.message))) return t(errorKey(err.message));
    return t('errors.generic');
  };
}

/** Label + control + hint/error, stacked; the error is announced to screen readers. */
export function Field({
  id,
  label,
  error,
  hint,
  required,
  className,
  children,
}: {
  id: string;
  label: I18nKey;
  error?: string | undefined;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>
        {t(label)}
        {required && (
          <span aria-hidden className="text-destructive">
            {' '}
            *
          </span>
        )}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {t(errorKey(error))}
        </p>
      )}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const text = useErrorText();
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
      {text(error)}
    </p>
  );
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="text-xl font-semibold">{children}</h1>
      {actions && <div className="ms-auto flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Numbers, dates, phones and codes: isolated LTR runs in the system font, even in Urdu. */
export const Num = ({ children }: { children: ReactNode }) => <bdi className="num">{children}</bdi>;
