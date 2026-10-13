import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Num } from '@/components/form';
import { Button } from '@/components/ui/button';
import { sendJson } from '@/lib/api';
import { canManageBackup, useLatestAlarm } from '@/lib/backup';
import { useRoles } from '@/lib/roles';

/**
 * Owner dashboard banner (M6): the latest daily alarm pass found something. Stays until the owner
 * dismisses it (acknowledged); the next day's pass raises it again if the problem is still there.
 */
export function AlarmBanner() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const owner = canManageBackup(useRoles());
  const event = useLatestAlarm(owner).data?.event;
  const ack = useMutation({
    mutationFn: (day: string) => sendJson('POST', `/api/alarms/${day}/ack`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alarms-latest'] }),
  });
  if (!owner || !event || event.total === 0 || event.acknowledged_at) return null;
  const firing = event.alarms.filter((a) => a.count > 0);
  return (
    <div
      role="alert"
      id="alarm-banner"
      className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3"
    >
      <TriangleAlert className="size-5 shrink-0 text-destructive" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          <Num>{t('backup.alarms.banner', { count: event.total })}</Num>
        </span>
        <span className="text-sm text-muted-foreground">
          {firing.map((a) => t(`backup.alarms.kinds.${a.kind}`)).join(' · ')}
        </span>
      </div>
      <div className="flex gap-2">
        <Button asChild size="sm">
          <Link to="/settings?section=backup">{t('backup.alarms.open')}</Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={ack.isPending}
          onClick={() => ack.mutate(event.day)}
        >
          {t('backup.alarms.dismiss')}
        </Button>
      </div>
    </div>
  );
}
