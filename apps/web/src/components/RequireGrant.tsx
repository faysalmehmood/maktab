import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { toast } from '@/components/ui/sonner';
import { useMe } from '@/lib/api';
import { type GrantRef, holds } from '@/lib/roles';

function Denied() {
  const { t } = useTranslation();
  useEffect(() => {
    // One toast however often the guard renders (id dedupes).
    toast.error(t('errors.forbidden'), { id: 'route-forbidden' });
  }, [t]);
  return <Navigate to="/" replace />;
}

/**
 * Route-level guard from the shared permission MATRIX: a role without the grant typing the URL is
 * sent to the dashboard with a toast instead of a page of 403s. The API enforces the same matrix.
 */
export function RequireGrant({ grant, children }: { grant: GrantRef; children: ReactNode }) {
  const me = useMe();
  if (!me.data) return null;
  return holds(me.data.roles, grant) ? children : <Denied />;
}
