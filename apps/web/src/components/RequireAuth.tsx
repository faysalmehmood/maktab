import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { ApiError, useMe } from '@/lib/api';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const me = useMe();
  if (me.isPending) return <p className="p-6 text-muted-foreground">{t('common.loading')}</p>;
  if (me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403)) {
    return <Navigate to="/login" replace />;
  }
  if (me.isError) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p>{t('common.error')}</p>
        <Button variant="outline" onClick={() => void me.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  return children;
}
