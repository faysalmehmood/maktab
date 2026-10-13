import {
  BRAND_COLORS,
  brandColor,
  type I18nKey,
  type SchoolInput,
  type SchoolResponse,
} from '@maktab/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { RunsOnMaktab, SchoolChip, SchoolMark } from '@/components/brand/SchoolBadge';
import { WizardFees } from '@/components/fees/setup';
import { ErrorNote, Num } from '@/components/form';
import { LanguageToggle } from '@/components/LanguageToggle';
import { GroupsEditor } from '@/components/setup/groups';
import { ProgrammesEditor, SeedLadderButton, SubjectsEditor } from '@/components/setup/programmes';
import { LogoUpload, SchoolForm, useCompleteSetup } from '@/components/setup/school';
import { SessionForm, SessionsList } from '@/components/setup/sessions';
import { InviteForm, StaffList } from '@/components/setup/staff';
import { Button } from '@/components/ui/button';
import { uploadFile } from '@/lib/api';
import { useFeeHeads, useFeeRates } from '@/lib/fees';
import { useCurrentSession, useGroups, useSchool, useStaff } from '@/lib/queries';
import { useRoles } from '@/lib/roles';
import { useBrand } from '@/lib/theme';
import { cn } from '@/lib/utils';

export const WIZARD_STEPS = [
  'school',
  'mode',
  'session',
  'programmes',
  'groups',
  'fees',
  'staff',
  'done',
] as const;
type Step = (typeof WIZARD_STEPS)[number];

/**
 * The five stages the owner sees (UI plan §7.2, PLAN 2026-10-13), over the same WIZARD_STEPS: the
 * classes stage walks mode → session → classes → groups as its parts. Step keys, the forms each step
 * saves and the `no_groups` guard are unchanged.
 */
export const WIZARD_STAGES = [
  { id: 'identity', steps: ['school'] },
  { id: 'classes', steps: ['mode', 'session', 'programmes', 'groups'] },
  { id: 'fees', steps: ['fees'] },
  { id: 'people', steps: ['staff'] },
  { id: 'done', steps: ['done'] },
] as const satisfies readonly { id: string; steps: readonly Step[] }[];
export type Stage = (typeof WIZARD_STAGES)[number]['id'];

export const stageOf = (step: Step) => {
  const i = WIZARD_STAGES.findIndex((s) => (s.steps as readonly Step[]).includes(step));
  const stage = WIZARD_STAGES[i] ?? WIZARD_STAGES[0];
  return { index: i, stage, part: (stage.steps as readonly Step[]).indexOf(step) };
};

/** Steps whose Next button submits a form (and only advances once it saved). */
const FORM_ID = 'wizard-step';

function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

/**
 * Live preview of step 1 (UI plan §7.2): the sign-in band, the phone's top bar and a receipt
 * header, all drawn with the uploaded logo when there is one (staged or saved), else the badge.
 * (The per-school installed-app icon waits for UI plan §6.5, so it is not previewed.)
 */
function IdentityPreview({ draft, logo }: { draft: IdentityDraft; logo: string | null }) {
  const { t } = useTranslation();
  const c = BRAND_COLORS[brandColor(draft.brand_color)].light;
  const id = {
    name: draft.name || t('app.name'),
    short_name: draft.short_name,
    brand_color: draft.brand_color,
  };
  return (
    <aside className="flex flex-col gap-3" aria-label={t('wizard.preview')} id="identity-preview">
      <h2 className="text-meta font-semibold text-muted-foreground">{t('wizard.preview')}</h2>
      <div
        className="flex flex-col items-center gap-1 rounded-xl px-3 py-5 text-center text-white"
        style={{ background: c.side }}
        data-preview="signin"
      >
        <SchoolMark school={id} logoSrc={logo} size={52} />
        <b className="mt-1 leading-tight">
          <bdi>{id.name}</bdi>
        </b>
        {draft.city && (
          <span className="text-meta" style={{ color: c.mut }}>
            <bdi>{draft.city}</bdi>
          </span>
        )}
      </div>
      <figure className="flex flex-col gap-1" data-preview="shell">
        <div className="flex h-12 items-center gap-2 rounded-lg border bg-card px-2.5">
          <SchoolChip school={id} logoSrc={logo} city={draft.city} />
          <span className="ms-auto h-7 w-20 rounded-md border bg-background" aria-hidden />
        </div>
        <figcaption className="text-meta text-muted-foreground">
          {t('wizard.previewShell')}
        </figcaption>
      </figure>
      <div
        className="flex items-center gap-2.5 rounded-lg border bg-white px-3 py-2 text-[13px] leading-tight text-[#14211f]"
        data-preview="receipt"
      >
        <SchoolMark school={id} logoSrc={logo} size={30} />
        <span className="flex min-w-0 flex-col">
          <b className="truncate">
            <bdi>{id.name}</bdi>
          </b>
          <span>
            {draft.city && (
              <>
                <bdi>{draft.city}</bdi>,{' '}
              </>
            )}
            {t('wizard.previewReceipt')}
          </span>
        </span>
      </div>
    </aside>
  );
}

type IdentityDraft = {
  name: string;
  short_name?: string | null;
  city?: string | null;
  brand_color?: string | null;
};

/**
 * First run (PLAN §14.1, UI plan §7.2) in five stages: your school → classes and sections → fees →
 * staff → done. Each form step saves on Next; list steps save as you edit. Re-enterable from
 * Settings at any time; usable on a phone without leaving the wizard.
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
  const groups = useGroups();
  const heads = useFeeHeads();
  const rates = useFeeRates(step === 'done');
  const staff = useStaff(step === 'done');
  // A logo chosen before the school row exists is staged here and uploaded right after the first
  // save (defect 4.6: the upload control shows on the first visit).
  const [stagedLogo, setStagedLogo] = useState<File | null>(null);
  const [logoError, setLogoError] = useState<unknown>(null);
  const stagedUrl = useObjectUrl(stagedLogo);
  const qc = useQueryClient();
  const dto = school.data?.school ?? null;
  const [draft, setDraft] = useState<IdentityDraft | null>(null);
  const onDraft = useCallback((d: SchoolInput) => setDraft(d), []);
  // The page wears the colour being picked, live.
  useBrand(draft ? (draft.brand_color ?? null) : dto ? dto.brand_color : undefined);

  if (!roles.includes('owner')) {
    return <p className="p-6">{t('setup.ownerOnly')}</p>;
  }
  if (school.isPending) return <p className="p-6 text-muted-foreground">{t('common.loading')}</p>;

  const noGroups = !groups.isPending && (groups.data?.items.length ?? 0) === 0;
  const noRates = !heads.isPending && !rates.isPending && (rates.data?.rates.length ?? 0) === 0;
  const { index: stageIndex, stage, part } = stageOf(step);
  const total = WIZARD_STAGES.length;

  // Steps where Next submits the step's own form; the others advance directly.
  const formStep = step === 'school' || step === 'mode' || (step === 'session' && !current);

  const advanceForm = (e: FormEvent) => {
    e.preventDefault();
    next();
  };
  const identity: IdentityDraft = draft ?? {
    name: dto?.name ?? '',
    short_name: dto?.short_name ?? null,
    city: dto?.city ?? null,
    brand_color: dto?.brand_color ?? null,
  };
  const logo = stagedUrl ?? (dto?.has_logo ? '/api/school/logo' : null);

  return (
    <div className="flex min-h-dvh bg-background">
      {/* The stages, named (desktop rail). */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-1 bg-side px-4 py-5 text-side-fg md:flex">
        <p className="mb-3 px-2 font-semibold text-white">{t('wizard.title')}</p>
        <ol className="flex flex-col gap-1" aria-label={t('wizard.title')}>
          {WIZARD_STAGES.map((s, i) => (
            <li
              key={s.id}
              aria-current={i === stageIndex ? 'step' : undefined}
              className={cn(
                'flex min-h-10 items-center gap-2.5 rounded-lg px-2 font-medium text-side-mut',
                i === stageIndex && 'bg-side-on text-white',
                i < stageIndex && 'text-side-fg',
              )}
            >
              <span
                className="grid size-[22px] shrink-0 place-items-center rounded-full border-[1.5px] border-current text-xs font-bold"
                aria-hidden
              >
                {i < stageIndex ? <Check className="size-3" /> : <Num>{i + 1}</Num>}
              </span>
              {t(`wizard.stages.${s.id}`)}
            </li>
          ))}
        </ol>
        <RunsOnMaktab className="mt-auto px-2 text-side-mut" />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto flex w-full max-w-[920px] flex-1 flex-col gap-4 p-4 md:p-8">
          <header className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground">
                {t('wizard.stepOf', { n: stageIndex + 1, total })}
              </p>
              <div className="ms-auto">
                <LanguageToggle />
              </div>
            </div>
            {/* Phone: the stage names as a bar under the title. */}
            <ol className="flex gap-1 md:hidden" aria-label={t('wizard.title')}>
              {WIZARD_STAGES.map((s, i) => (
                <li
                  key={s.id}
                  aria-current={i === stageIndex ? 'step' : undefined}
                  className={cn(
                    'h-1.5 flex-1 rounded-full bg-muted',
                    i <= stageIndex && 'bg-primary',
                  )}
                >
                  <span className="sr-only">{t(`wizard.stages.${s.id}`)}</span>
                </li>
              ))}
            </ol>
            <h1 className="text-title">{t(`wizard.stages.${stage.id}`)}</h1>
            {stage.steps.length > 1 && (
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="text-muted-foreground">
                  {t('wizard.partOf', { n: part + 1, total: stage.steps.length })}
                </span>
                {stage.steps.map((s, i) => (
                  <span
                    key={s}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-meta font-semibold',
                      i === part ? 'bg-brand-soft text-brand' : 'text-muted-foreground',
                    )}
                  >
                    {t(`setup.steps.${s}`)}
                  </span>
                ))}
              </p>
            )}
          </header>

          <div
            className={cn(
              'grid items-start gap-6',
              step === 'school' && 'lg:grid-cols-[minmax(0,1fr)_280px]',
            )}
          >
            <section className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 md:p-5">
              {stage.steps.length > 1 && (
                <h2 className="text-section font-semibold">
                  {t(`setup.steps.${step}` as I18nKey)}
                </h2>
              )}
              {step === 'school' && (
                <>
                  <p className="text-sm text-muted-foreground">{t('wizard.identityHelp')}</p>
                  <SchoolForm
                    school={dto}
                    part="identity"
                    formId={FORM_ID}
                    onDraft={onDraft}
                    onSaved={async () => {
                      if (stagedLogo) {
                        try {
                          const data = await uploadFile<SchoolResponse>(
                            '/api/school/logo',
                            stagedLogo,
                            stagedLogo.name,
                          );
                          qc.setQueryData(['school'], data);
                          setStagedLogo(null);
                          setLogoError(null);
                        } catch (err) {
                          // The name is saved; stay here so the logo can be tried again.
                          setLogoError(err);
                          return;
                        }
                      }
                      next();
                    }}
                  />
                  {dto ? (
                    <LogoUpload school={dto} badge={identity} />
                  ) : (
                    <LogoUpload
                      school={null}
                      staged={stagedLogo}
                      onStage={setStagedLogo}
                      badge={identity}
                    />
                  )}
                  <ErrorNote error={logoError} />
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
              {step === 'fees' && (
                <>
                  <p className="text-sm text-muted-foreground">{t('setup.feesHelp')}</p>
                  <WizardFees />
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
                  <span className="grid size-12 place-items-center rounded-full bg-ok-soft text-ok">
                    <Check className="size-6" aria-hidden />
                  </span>
                  <p className="text-lg font-semibold">{t('setup.doneTitle')}</p>
                  <p className="text-muted-foreground">{t('setup.doneBody')}</p>
                  <dl className="grid w-full grid-cols-3 overflow-hidden rounded-lg border text-center">
                    {(
                      [
                        ['classes', groups.data?.items.length],
                        ['rates', rates.data?.rates.length],
                        ['staff', staff.data?.items.length],
                      ] as const
                    ).map(([k, n]) => (
                      <div key={k} className="border-e px-2 py-3 last:border-e-0">
                        <dt className="text-meta text-muted-foreground">
                          {t(`wizard.summary.${k}`)}
                        </dt>
                        <dd className="text-xl font-bold">
                          <Num>{n ?? '—'}</Num>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {noGroups && (
                    <div role="alert" className="flex flex-col items-start gap-2">
                      <p className="text-sm text-destructive">{t('setup.noGroups')}</p>
                      <Button
                        variant="outline"
                        onClick={() => setIndex(WIZARD_STEPS.indexOf('groups'))}
                      >
                        {t('setup.backToGroups')}
                      </Button>
                    </div>
                  )}
                  {!noGroups && noRates && (
                    <p className="text-sm text-muted-foreground">{t('setup.noRates')}</p>
                  )}
                  <ErrorNote error={finish.error} />
                  <Button
                    size="lg"
                    disabled={finish.isPending || !dto || noGroups || groups.isPending}
                    onClick={() =>
                      finish.mutate(undefined, {
                        onSuccess: () => navigate('/', { replace: true }),
                      })
                    }
                  >
                    {t('setup.finish')}
                  </Button>
                </div>
              )}
              {/* List steps advance without saving anything; their edits are already saved. */}
              {!formStep && step !== 'done' && <form id={FORM_ID} onSubmit={advanceForm} />}
            </section>
            {step === 'school' && <IdentityPreview draft={identity} logo={logo} />}
          </div>
        </main>

        {step !== 'done' && (
          <nav
            data-action-bar
            style={{ bottom: 'var(--tabbar-h, 0px)' }}
            className="sticky border-t bg-card/95 backdrop-blur"
          >
            <div className="mx-auto flex w-full max-w-[920px] gap-2 px-4 py-3 md:px-8">
              <Button variant="outline" onClick={back} disabled={index === 0}>
                {t('common.back')}
              </Button>
              <Button type="submit" form={FORM_ID} className="ms-auto min-w-28">
                {t('common.next')}
              </Button>
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}
