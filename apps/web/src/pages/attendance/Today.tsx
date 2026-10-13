import { FileSpreadsheet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { todayPk } from '@/components/attendance/common';
import { DayOffNote, TodayPanels } from '@/components/attendance/parts';
import { DateText } from '@/components/date-text';
import { ErrorNote } from '@/components/form';
import { ListSkeleton, Page, PageHeader, Panel } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { canCorrect, useToday } from '@/lib/attendance';
import { useRoles } from '@/lib/roles';

/**
 * Registers for one day in the caller's scope. Teachers see today; the office can pick any date to
 * open (and correct) an earlier register. Progress first, then To take and Taken (UI plan §5.5).
 */
export function TodayPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const [params, setParams] = useSearchParams();
  const office = canCorrect(roles);
  const date = (office && params.get('date')) || todayPk();
  const today = useToday(date);
  return (
    <Page width="form">
      <PageHeader
        title={t('attendance.title')}
        subtitle={<DateText iso={date} kind="long" />}
        actions={
          <>
            {office && (
              <Input
                id="today-date"
                type="date"
                aria-label={t('attendance.date')}
                className="w-40"
                value={date}
                max={todayPk()}
                onChange={(e) => e.target.value && setParams({ date: e.target.value })}
              />
            )}
            <Button asChild variant="outline">
              <Link to="/attendance/report">
                <FileSpreadsheet aria-hidden />
                {t('attendance.report')}
              </Link>
            </Button>
          </>
        }
      />
      {today.isPending ? (
        <Panel>
          <ListSkeleton rows={4} />
        </Panel>
      ) : today.data ? (
        <>
          <DayOffNote dayOff={today.data.day_off} />
          {/* The asked-for date, not the response's: offline, the cached list may be yesterday's,
              and its links must still open today's register. */}
          <TodayPanels items={today.data.items} date={date} />
        </>
      ) : (
        <ErrorNote error={today.error} />
      )}
    </Page>
  );
}
