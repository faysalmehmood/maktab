import { CloudOff } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { ApiError, useMe } from '@/lib/api';
import { refreshStatus, useOutboxStatus } from '@/offline/sync';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const me = useMe();
  const outbox = useOutboxStatus();
  // The shell (which starts the outbox triggers) is not mounted on the error screen: read the
  // count here so a teacher who cannot reach the school still sees their registers are safe.
  useEffect(() => {
    if (me.isError) refreshStatus().catch(() => undefined);
  }, [me.isError]);
  if (me.isPending) return <p className="p-6 text-muted-foreground">{t('common.loading')}</p>;
  if (me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403)) {
    return <Navigate to="/login" replace />;
  }
  if (me.isError) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p>{t('common.error')}</p>
        {outbox.pending > 0 && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-md bg-warn-soft p-3 text-sm text-warn"
          >
            <CloudOff className="size-4 shrink-0" aria-hidden />
            {t('attendance.safeOnPhone', { count: outbox.pending })}
          </p>
        )}
        <Button variant="outline" onClick={() => void me.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  return children;
}
