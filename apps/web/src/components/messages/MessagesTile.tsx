import { MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Num } from '@/components/form';
import { Card, CardContent } from '@/components/ui/card';
import { useMessageCounts } from '@/lib/messages';

/** Dashboard tile (PLAN §14.11 "pending send-queue"): messages waiting, linking to the queue. */
export function MessagesTile() {
  const { t } = useTranslation();
  const counts = useMessageCounts();
  if (!counts.data) return null;
  return (
    <Card className="gap-2 py-3">
      <CardContent className="px-4">
        <Link
          id="dash-messages"
          to="/messages"
          className="flex min-h-11 items-center gap-3 hover:underline"
        >
          <MessageSquareText aria-hidden className="size-5 shrink-0" />
          <span className="font-medium">{t('msg.dashboard.queued')}</span>
          <span className="ms-auto text-2xl font-semibold">
            <Num>{counts.data.queued}</Num>
          </span>
          <span className="sr-only">{t('msg.dashboard.open')}</span>
        </Link>
      </CardContent>
    </Card>
  );
}
