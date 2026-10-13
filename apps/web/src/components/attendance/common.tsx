import { CloudOff, LogIn, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Num } from '@/components/form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRejectionText } from '@/lib/attendance';
import { useRoles } from '@/lib/roles';
import type { OutboxEntry } from '@/offline/outbox';
import { discardFailed, failedEntries, retryFailed, useOutboxStatus } from '@/offline/sync';

/*
 * The attendance parts the shell needs (entry chunk): the sync banner and the school day. The
 * register's own parts (marks, counts, the day lists) live in ./parts.tsx, a lazy chunk (M7b-2).
 */

/**
 * Header banners for saved-but-unsent attendance: offline, waiting count, refused registers, and
 * "sign in again" when the session expired (entries stay on the phone until then).
 */
export function SyncBanner() {
  const { t } = useTranslation();
  const s = useOutboxStatus();
  const roles = useRoles();
  // Another account's registers on this phone: only the owner/admin is told how many (M7a).
  const others = roles.some((r) => r === 'owner' || r === 'admin') ? s.others : 0;
  if (!s.pending && !s.failed && !s.paused && !s.offline && !others) return null;
  return (
    <div className="flex flex-col gap-1 border-b bg-warn-soft px-3 py-2 text-sm text-warn print:hidden">
      {(s.offline || s.pending > 0) && (
        <p className="flex min-h-11 items-center gap-2" role="status">
          <CloudOff className="size-4 shrink-0" aria-hidden />
          {s.offline && <span>{t('attendance.offline')}</span>}
          {s.pending > 0 && <span>{t('attendance.pending', { n: s.pending })}</span>}
        </p>
      )}
      {s.paused && (
        <p className="flex min-h-11 flex-wrap items-center gap-2" role="alert">
          <LogIn className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">{t('attendance.signInAgain')}</span>
          <Button asChild size="sm" variant="outline">
            <Link to="/login">{t('attendance.signIn')}</Link>
          </Button>
        </p>
      )}
      {s.failed > 0 && <FailedList count={s.failed} />}
      {others > 0 && (
        <p className="flex min-h-11 items-center gap-2" role="status">
          <CloudOff className="size-4 shrink-0" aria-hidden />
          <span>{t('attendance.otherAccount', { count: others })}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Registers the school refused, one row each: group, date, the reason in the user's language,
 * Retry (back to the queue, sent now) and Dismiss (after a confirm: it is deleted from the phone).
 */
export function FailedList({ count }: { count: number }) {
  const { t } = useTranslation();
  const reason = useRejectionText();
  const [items, setItems] = useState<OutboxEntry[]>([]);
  const [confirm, setConfirm] = useState<OutboxEntry | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read whenever the failed count moves
  useEffect(() => {
    let live = true;
    failedEntries()
      .then((e) => live && setItems(e))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [count]);
  return (
    <div role="alert" className="flex flex-col gap-1">
      <p className="flex min-h-11 items-center gap-2">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        <span>
          {t('attendance.failed', { n: count })} — {t('attendance.failedHint')}
        </span>
      </p>
      <ul className="flex flex-col gap-1">
        {items.map((e) => (
          <li key={e.client_id} className="flex flex-wrap items-center gap-2 ps-6">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">
                <bdi>{e.label ?? t('attendance.group')}</bdi> · <Num>{e.submission.date}</Num>
              </span>
              <span>{reason(e.error_code ?? e.error, e.submission.date)}</span>
            </span>
            <Button size="sm" variant="outline" onClick={() => void retryFailed([e.client_id])}>
              {t('attendance.retry')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(e)}>
              {t('attendance.dismiss')}
            </Button>
          </li>
        ))}
      </ul>
      {confirm && (
        <Dialog open onOpenChange={(o) => !o && setConfirm(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('attendance.dismissTitle')}</DialogTitle>
              <DialogDescription>{t('attendance.dismissBody')}</DialogDescription>
            </DialogHeader>
            <p className="text-sm">
              <bdi>{confirm.label ?? t('attendance.group')}</bdi> ·{' '}
              <Num>{confirm.submission.date}</Num>
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const id = confirm.client_id;
                  setConfirm(null);
                  void discardFailed([id]);
                }}
              >
                {t('attendance.dismiss')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** Today in Asia/Karachi (the school day), whatever the phone's timezone. */
export function todayPk(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
