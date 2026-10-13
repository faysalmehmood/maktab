import { formatPkPhone } from '@maktab/shared';
import { MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { DayOffNote, TodayList } from '@/components/attendance/common';
import { AlarmBanner } from '@/components/backup/AlarmBanner';
import { FeeTiles } from '@/components/fees/DashboardTiles';
import { Num } from '@/components/form';
import { MessagesTile } from '@/components/messages/MessagesTile';
import { MonthTiles } from '@/components/money/MonthTiles';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe } from '@/lib/api';
import {
  canCorrect,
  canReadAttendance,
  canReadMessages,
  registerPath,
  useDashboardToday,
  useToday,
} from '@/lib/attendance';
import { canReadMoney } from '@/lib/fees';
import { useSchool } from '@/lib/queries';
import { useRoles } from '@/lib/roles';

/** Office "Today" widgets (PLAN §14.11): registers not taken, absentees, queued absence alerts. */
function OfficeToday() {
  const { t } = useTranslation();
  const roles = useRoles();
  const d = useDashboardToday(true).data;
  if (!d) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <DayOffNote dayOff={d.day_off} />
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>
            {t('dashboard.notTaken')} ·{' '}
            <Num>
              {d.registers.not_taken.length}/{d.registers.total}
            </Num>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {d.registers.not_taken.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('dashboard.allTaken')}</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {d.registers.not_taken.map((i) => (
                <li key={`${i.grp_id}|${i.grp_subject_id}`}>
                  <Link
                    to={registerPath(i.grp_id, d.date, i.grp_subject_id || null)}
                    className="flex min-h-11 flex-wrap items-center gap-2 hover:underline"
                  >
                    <bdi className="font-medium">
                      {i.programme_name} · {i.grp_name}
                      {i.subject_name ? ` · ${i.subject_name}` : ''}
                    </bdi>
                    <span className="ms-auto text-sm text-muted-foreground">
                      <bdi>{i.class_teacher_name ?? '—'}</bdi>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>
            {t('dashboard.absentees')} · <Num>{d.absentees.length}</Num>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {d.absentees.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('dashboard.noAbsentees')}</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {d.absentees.map((a) => (
                <li
                  key={a.student_id}
                  className="flex min-h-11 flex-wrap items-center gap-x-2 py-1"
                >
                  <Link
                    to={`/students/${a.student_id}`}
                    className="flex min-h-11 items-center font-medium hover:underline"
                  >
                    <bdi>{a.name}</bdi>
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    <bdi>{a.grp_name}</bdi>
                  </span>
                  <span className="ms-auto flex items-center gap-2 text-sm">
                    <bdi>{a.guardian_name ?? ''}</bdi>
                    {a.guardian_phone && (
                      <a
                        href={`tel:+${a.guardian_phone}`}
                        className="flex min-h-11 min-w-11 shrink-0 items-center px-1 underline"
                      >
                        <bdi className="num">{formatPkPhone(a.guardian_phone)}</bdi>
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('dashboard.queuedAbsence')}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3 px-4">
          <span className="text-3xl font-semibold">
            <Num>{d.queued_absence_messages}</Num>
          </span>
          {canReadMessages(roles) && (
            <Button asChild variant="outline" size="sm" className="ms-auto">
              <Link to="/messages">
                <MessageSquareText aria-hidden />
                {t('attendance.openQueue')}
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Teacher home: today's groups with taken / not-taken badges (PLAN §14.3 step 1). */
function TeacherToday() {
  const { t } = useTranslation();
  const today = useToday().data;
  if (!today) return null;
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-medium">{t('dashboard.myGroups')}</h2>
      <DayOffNote dayOff={today.day_off} />
      <TodayList items={today.items} date={today.date} />
    </div>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const me = useMe().data;
  const roles = useRoles();
  const school = useSchool().data?.school;
  const unfinished = school === null || (school && !school.setup_completed_at);
  const attendance = canReadAttendance(roles);
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{school ? school.name : t('nav.dashboard')}</h1>
      {me && <p>{t('dashboard.welcome', { name: me.user.name || me.user.email })}</p>}
      {unfinished &&
        (me?.roles.includes('owner') ? (
          <Button asChild className="self-start">
            <Link to="/setup">{t('dashboard.finishSetup')}</Link>
          </Button>
        ) : (
          <p className="text-muted-foreground">{t('dashboard.setupNotFinished')}</p>
        ))}
      <AlarmBanner />
      {canReadMessages(roles) && <MessagesTile />}
      {canReadMoney(roles) && <FeeTiles />}
      {canReadMoney(roles) && <MonthTiles />}
      {attendance && (canCorrect(roles) ? <OfficeToday /> : <TeacherToday />)}
      {!attendance && !canReadMoney(roles) && !canReadMessages(roles) && (
        <p className="text-muted-foreground">{t('common.comingSoon')}</p>
      )}
    </section>
  );
}
