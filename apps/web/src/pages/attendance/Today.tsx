import { FileSpreadsheet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { DayOffNote, TodayList, todayPk } from '@/components/attendance/common';
import { ErrorNote, PageTitle } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { canCorrect, useToday } from '@/lib/attendance';
import { useRoles } from '@/lib/roles';

/**
 * Registers for one day in the caller's scope. Teachers see today; the office can pick any date to
 * open (and correct) an earlier register.
 */
export function TodayPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const [params, setParams] = useSearchParams();
  const office = canCorrect(roles);
  const date = (office && params.get('date')) || todayPk();
  const today = useToday(date);
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <PageTitle
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/attendance/report">
              <FileSpreadsheet aria-hidden />
              {t('attendance.report')}
            </Link>
          </Button>
        }
      >
        {t('attendance.title')}
      </PageTitle>
      {office && (
        <div className="flex flex-col gap-1.5 sm:w-56">
          <Label htmlFor="today-date">{t('attendance.date')}</Label>
          <Input
            id="today-date"
            type="date"
            value={date}
            max={todayPk()}
            onChange={(e) => e.target.value && setParams({ date: e.target.value })}
          />
        </div>
      )}
      {today.isPending ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : today.data ? (
        <>
          <DayOffNote dayOff={today.data.day_off} />
          <TodayList items={today.data.items} date={today.data.date} />
        </>
      ) : (
        <ErrorNote error={today.error} />
      )}
    </section>
  );
}
