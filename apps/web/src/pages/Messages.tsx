import type { MessageDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { todayPk } from '@/components/attendance/common';
import { ErrorNote, Num, PageTitle } from '@/components/form';
import { getJson } from '@/lib/api';

/**
 * Milestone 5 builds the send queue (wa.me → sent). Until then this page only shows what is
 * waiting, so the "n absence messages queued" link after saving a register leads somewhere true.
 */
export function MessagesPage() {
  const { t } = useTranslation();
  const date = todayPk();
  const q = useQuery({
    queryKey: ['messages', 'absence', date],
    queryFn: () =>
      getJson<{ items: MessageDto[]; total: number }>(
        `/api/messages?status=queued&template_key=absence&date=${date}`,
      ),
  });
  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <PageTitle>{t('queue.title')}</PageTitle>
      <p className="text-muted-foreground">{t('queue.placeholder')}</p>
      {q.isError && <ErrorNote error={q.error} />}
      {q.data && (
        <>
          <p className="font-medium">{t('queue.queuedAbsence', { n: q.data.total })}</p>
          <ul className="flex flex-col divide-y rounded-md border">
            {q.data.items.map((m) => (
              <li
                key={m.id}
                className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-2 text-sm"
              >
                <bdi className="font-medium">{m.guardian_name ?? m.family_name}</bdi>
                <span className="text-muted-foreground">
                  <bdi>{((m.payload?.student_names as string[] | undefined) ?? []).join('، ')}</bdi>
                </span>
                <span className="ms-auto text-muted-foreground">
                  <Num>{m.guardian_phone ?? ''}</Num>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
