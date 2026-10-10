import type { I18nKey } from '@maktab/shared';
import { Check } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { ErrorNote, Num } from '@/components/form';
import { LanguageToggle } from '@/components/LanguageToggle';
import { GroupsEditor } from '@/components/setup/groups';
import { ProgrammesEditor, SeedLadderButton, SubjectsEditor } from '@/components/setup/programmes';
import { LogoUpload, SchoolForm, useCompleteSetup } from '@/components/setup/school';
import { SessionForm, SessionsList } from '@/components/setup/sessions';
import { InviteForm, StaffList } from '@/components/setup/staff';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCurrentSession, useSchool } from '@/lib/queries';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

export const WIZARD_STEPS = [
  'school',
  'mode',
  'session',
  'programmes',
  'groups',
  'staff',
  'done',
] as const;
type Step = (typeof WIZARD_STEPS)[number];

/** Steps whose Next button submits a form (and only advances once it saved). */
const FORM_ID = 'wizard-step';

/**
 * First run (PLAN §14.1): school → mode → session → classes → groups → staff → done. Each form
 * step saves on Next; list steps save as you edit. Re-enterable from Settings at any time.
 */
export function SetupWizard() {
  const { t } = useTranslation();
  const roles = useRoles();
  const navigate = useNavigate();
  const school = useSchool();
  const current = useCurrentSession();
  const [index, setIndex] = useState(0);
  const step: Step = WIZARD_STEPS[index] ?? 'school';
  const next = () => setIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  const back = () => setIndex((i) => Math.max(i - 1, 0));
  const finish = useCompleteSetup();

  if (!roles.includes('owner')) {
    return <p className="p-6">{t('setup.ownerOnly')}</p>;
  }
  if (school.isPending) return <p className="p-6 text-muted-foreground">{t('common.loading')}</p>;
  const dto = school.data?.school ?? null;

  // Steps where Next submits the step's own form; the others advance directly.
  const formStep = step === 'school' || step === 'mode' || (step === 'session' && !current);

  const advanceForm = (e: FormEvent) => {
    e.preventDefault();
    next();
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">{t('setup.title')}</h1>
        <div className="ms-auto">
          <LanguageToggle />
        </div>
      </header>
      <ol className="flex gap-1" aria-label={t('setup.title')}>
        {WIZARD_STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === index ? 'step' : undefined}
            className={cn('h-1.5 flex-1 rounded-full bg-muted', i <= index && 'bg-primary')}
          >
            <span className="sr-only">{t(`setup.steps.${s}`)}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">
        {t('common.step', { n: index + 1, total: WIZARD_STEPS.length })}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t(`setup.steps.${step}` as I18nKey)}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step === 'school' && (
            <>
              <p className="text-sm text-muted-foreground">{t('setup.intro')}</p>
              <SchoolForm school={dto} part="profile" formId={FORM_ID} onSaved={next} />
              {dto && <LogoUpload school={dto} />}
            </>
          )}
          {step === 'mode' && (
            <SchoolForm school={dto} part="mode" formId={FORM_ID} onSaved={next} />
          )}
          {step === 'session' && (
            <>
              <p className="text-sm text-muted-foreground">{t('setup.sessionHelp')}</p>
              <SessionsList />
              {!current && <SessionForm formId={FORM_ID} onSaved={next} />}
            </>
          )}
          {step === 'programmes' && (
            <>
              <SeedLadderButton />
              <ProgrammesEditor />
              <SubjectsEditor />
            </>
          )}
          {step === 'groups' && (
            <>
              <p className="text-sm text-muted-foreground">{t('setup.groupsHelp')}</p>
              {current && (
                <p className="text-sm">
                  {t('group.session')}: <Num>{current.name}</Num>
                </p>
              )}
              <GroupsEditor sessionId={current?.id ?? null} />
            </>
          )}
          {step === 'staff' && (
            <>
              <p className="text-sm text-muted-foreground">{t('setup.staffHelp')}</p>
              <InviteForm />
              <StaffList />
            </>
          )}
          {step === 'done' && (
            <div className="flex flex-col items-start gap-3">
              <Check className="size-10 text-primary" aria-hidden />
              <p className="text-lg font-medium">{t('setup.doneTitle')}</p>
              <p className="text-muted-foreground">{t('setup.doneBody')}</p>
              <ErrorNote error={finish.error} />
              <Button
                size="lg"
                disabled={finish.isPending || !dto}
                onClick={() =>
                  finish.mutate(undefined, { onSuccess: () => navigate('/', { replace: true }) })
                }
              >
                {t('setup.finish')}
              </Button>
            </div>
          )}
          {/* List steps advance without saving anything; their edits are already saved. */}
          {!formStep && step !== 'done' && <form id={FORM_ID} onSubmit={advanceForm} />}
        </CardContent>
      </Card>

      {step !== 'done' && (
        <nav className="sticky bottom-0 flex gap-2 bg-background py-3">
          <Button variant="outline" onClick={back} disabled={index === 0}>
            {t('common.back')}
          </Button>
          <Button type="submit" form={FORM_ID} className="ms-auto">
            {t('common.next')}
          </Button>
        </nav>
      )}
    </div>
  );
}
