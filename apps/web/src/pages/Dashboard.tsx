import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/api';
import { useSchool } from '@/lib/queries';

/** Placeholder until milestone 4 (PLAN §14.11); says so if setup is unfinished. */
export function Dashboard() {
  const { t } = useTranslation();
  const me = useMe().data;
  const school = useSchool().data?.school;
  const unfinished = school === null || (school && !school.setup_completed_at);
  return (
    <section className="flex flex-col gap-3">
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
      <p className="text-muted-foreground">{t('common.comingSoon')}</p>
    </section>
  );
}
