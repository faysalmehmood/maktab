import {
  type AdmissionInput,
  type AdmissionResult,
  admissionInputSchema,
  type FamilyDetailDto,
  type FamilySearchHit,
  newId,
  normalizePkPhone,
  type StudentDetailDto,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Search, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
import {
  CustomFieldInputs,
  type Extra,
  emptyGuardian,
  type GuardianDraft,
  GuardianFieldset,
  guardianInput,
  isolate,
  PhoneHint,
  PhotoPicker,
} from '@/components/students/fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson, uploadFile } from '@/lib/api';
import { type FieldErrors, issuesToErrors, todayIso } from '@/lib/form';
import { useCurrentSession, useCustomFields, useGroups } from '@/lib/queries';

type AdmissionPayload = ReturnType<typeof admissionInputSchema.parse>;

type FamilyChoice = { kind: 'existing'; id: string; name: string } | { kind: 'new' } | null;

type StudentDraft = {
  name: string;
  father_name: string;
  gender: '' | 'm' | 'f';
  dob: string;
  b_form_no: string;
  admission_no: string;
  admission_date: string;
};

const emptyStudent = (): StudentDraft => ({
  name: '',
  father_name: '',
  gender: '',
  dob: '',
  b_form_no: '',
  admission_no: '',
  admission_date: todayIso(),
});

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">{children}</CardContent>
    </Card>
  );
}

/** Group picker: open groups, current session first, with seats left. */
function GroupPicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (id: string) => void;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  const current = useCurrentSession();
  const groups = (useGroups().data?.items ?? [])
    .filter((g) => g.status !== 'closed')
    .sort((a, b) => Number(b.session_id === current?.id) - Number(a.session_id === current?.id));
  const picked = groups.find((g) => g.id === value);
  // Capacity is a planning number (never enforced): a full group stays pickable, with a warning.
  const full = picked?.seats_left != null && picked.seats_left <= 0;
  return (
    <Field
      id="adm-group"
      label="admission.group"
      error={error}
      required
      hint={
        full && (
          <span role="status" className="text-warn">
            {t('admission.groupFullWarning')}
          </span>
        )
      }
    >
      <Select id="adm-group" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('admission.pickGroup')}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {isolate(g.programme_name)} · {isolate(g.name)}
            {g.seats_left !== null &&
              ` (${g.seats_left > 0 ? t('group.seatsLeft', { n: g.seats_left }) : t('group.full')})`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function Success({ result, onSibling }: { result: AdmissionResult; onSibling: () => void }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3">
        <CheckCircle2 className="size-10 text-primary" aria-hidden />
        <h2 className="text-lg font-semibold">{t('admission.successTitle')}</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{t('student.admissionNo')}</dt>
          <dd className="text-xl font-semibold">
            <Num>{result.admission_no}</Num>
          </dd>
          {result.roll_no && (
            <>
              <dt className="text-muted-foreground">{t('admission.rollNo')}</dt>
              <dd className="text-xl font-semibold">
                <Num>{result.roll_no}</Num>
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onSibling}>
            <Plus aria-hidden />
            {t('admission.admitSibling')}
          </Button>
          <Button asChild variant="outline">
            <Link to={`/students/${result.student_id}`}>{t('admission.viewStudent')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * PLAN §14.2: phone-first family lookup ("is this a sibling?"), guardians with consent, student,
 * photo, group → one POST /api/admissions with client-minted ids (a retry is a no-op).
 */
export function AdmissionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const readmitId = params.get('readmit');
  const familyParam = params.get('family');
  const customFields = useCustomFields().data?.items ?? [];

  const [lookup, setLookup] = useState('');
  const [lookupError, setLookupError] = useState<string>();
  const [hits, setHits] = useState<FamilySearchHit[] | null>(null);
  const [family, setFamily] = useState<FamilyChoice>(null);
  const [familyDraft, setFamilyDraft] = useState({ name: '', area: '', address: '' });
  const [guardians, setGuardians] = useState<GuardianDraft[]>([]);
  const [student, setStudent] = useState<StudentDraft>(emptyStudent);
  const [extra, setExtra] = useState<Extra>({});
  const [enrol, setEnrol] = useState({ grp_id: '', roll_no: '', start_date: todayIso() });
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<AdmissionResult | null>(null);
  // Minted once per form, so re-submitting after a network error replays the same admission.
  const ids = useRef({
    family: newId(),
    student: newId(),
    enrolment: newId(),
    guardians: [newId()],
  });

  const readmitStudent = useQuery({
    queryKey: ['student', readmitId],
    queryFn: () => getJson<StudentDetailDto>(`/api/students/${readmitId}`),
    enabled: !!readmitId,
  });
  // "Admit a sibling" arrives with ?family=<id>: the family is already chosen.
  useQuery({
    queryKey: ['family', familyParam],
    queryFn: async () => {
      const f = await getJson<FamilyDetailDto>(`/api/families/${familyParam}`);
      setFamily({ kind: 'existing', id: f.id, name: f.name });
      return f;
    },
    enabled: !!familyParam && !readmitId,
  });

  const search = useMutation({
    mutationFn: (phone: string) =>
      getJson<{ items: FamilySearchHit[] }>(`/api/families?phone=${encodeURIComponent(phone)}`),
    onSuccess: (r) => setHits(r.items),
  });

  const submit = useMutation({
    mutationFn: async (input: AdmissionPayload) => {
      const r = await sendJson<AdmissionResult>('POST', '/api/admissions', input);
      if (photo) {
        await uploadFile(`/api/students/${r.student_id}/photo`, photo, 'photo.jpg').catch(() =>
          toast.error(t('errors.photo_failed')),
        );
      }
      return r;
    },
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['students'] });
      await qc.invalidateQueries({ queryKey: ['groups'] });
      window.scrollTo?.({ top: 0 });
    },
  });

  const doLookup = () => {
    if (!normalizePkPhone(lookup)) {
      setLookupError('invalid_phone');
      return;
    }
    setLookupError(undefined);
    search.mutate(lookup);
  };

  const chooseNewFamily = () => {
    setFamily({ kind: 'new' });
    if (guardians.length === 0) setGuardians([emptyGuardian(lookup)]);
  };

  const buildInput = (): AdmissionInput => {
    const enrolment = {
      id: ids.current.enrolment,
      grp_id: enrol.grp_id,
      start_date: enrol.start_date,
      roll_no: enrol.roll_no,
    };
    if (readmitId) return { readmit_student_id: readmitId, enrolment };
    while (ids.current.guardians.length < guardians.length) ids.current.guardians.push(newId());
    return {
      ...(family?.kind === 'existing'
        ? { family_id: family.id }
        : family?.kind === 'new'
          ? { family: { id: ids.current.family, ...familyDraft } }
          : {}),
      guardians: guardians.map((g, i) => ({ id: ids.current.guardians[i], ...guardianInput(g) })),
      student_id: ids.current.student,
      student: {
        ...student,
        gender: student.gender || null,
        dob: student.dob || null,
        extra,
      },
      enrolment,
    };
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const input = buildInput();
    const parsed = admissionInputSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues, input));
      return;
    }
    setErrors({});
    // The parsed payload: phones already normalised (923…), blanks as null.
    submit.mutate(parsed.data);
  };

  const startSibling = (r: AdmissionResult) => {
    setResult(null);
    const name = family?.kind === 'existing' ? family.name : familyDraft.name;
    setFamily({ kind: 'existing', id: r.family_id, name });
    setGuardians([]);
    setStudent({ ...emptyStudent(), father_name: student.father_name });
    setExtra({});
    setPhoto(null);
    setEnrol({ grp_id: '', roll_no: '', start_date: todayIso() });
    ids.current = { family: newId(), student: newId(), enrolment: newId(), guardians: [newId()] };
    navigate(`/students/new?family=${r.family_id}`, { replace: true });
  };

  if (result) {
    return (
      <section className="flex max-w-2xl flex-col gap-4">
        <PageTitle>{t('admission.title')}</PageTitle>
        <Success result={result} onSibling={() => startSibling(result)} />
      </section>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-4">
      <PageTitle>{readmitId ? t('admission.readmitTitle') : t('admission.title')}</PageTitle>

      {readmitId ? (
        <p>
          {readmitStudent.data
            ? t('admission.readmitFor', { name: readmitStudent.data.name })
            : t('common.loading')}
        </p>
      ) : (
        <>
          <Section title={t('admission.sections.family')}>
            {family?.kind === 'existing' ? (
              <div className="flex items-center gap-2">
                <span className="font-medium">{t('family.chosen', { name: family.name })}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ms-auto"
                  onClick={() => {
                    setFamily(null);
                    setHits(null);
                  }}
                >
                  {t('common.change')}
                </Button>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('family.lookupHelp')}</p>
                <div className="flex items-end gap-2">
                  <Field
                    id="lookup-phone"
                    label="family.lookupTitle"
                    error={lookupError}
                    hint={<PhoneHint value={lookup} />}
                    className="flex-1"
                  >
                    <Input
                      id="lookup-phone"
                      type="tel"
                      inputMode="tel"
                      dir="ltr"
                      value={lookup}
                      onChange={(e) => {
                        setLookup(e.target.value);
                        setLookupError(undefined);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          doLookup();
                        }
                      }}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={search.isPending}
                    onClick={doLookup}
                  >
                    <Search aria-hidden />
                    {t('family.search')}
                  </Button>
                </div>
                <ErrorNote error={search.error} />
                {hits?.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('family.noMatch')}</p>
                )}
                {hits?.map((h) => (
                  <div key={h.id} className="flex flex-col gap-2 rounded-md border p-3">
                    <p className="font-medium">
                      {t('family.siblingOf', {
                        names: h.students.map((s) => s.name).join('، ') || h.name,
                      })}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {h.guardians.map((g) => g.name).join('، ')}
                      {h.area && ` · ${h.area}`}
                    </p>
                    <Button
                      type="button"
                      className="self-start"
                      onClick={() => {
                        setFamily({ kind: 'existing', id: h.id, name: h.name });
                        setGuardians([]);
                        if (!student.father_name) {
                          const father = h.guardians.find((g) =>
                            /father|والد/i.test(g.relation ?? ''),
                          );
                          if (father) setStudent((s) => ({ ...s, father_name: father.name }));
                        }
                      }}
                    >
                      {t('family.useFamily')}
                    </Button>
                  </div>
                ))}
                {family?.kind !== 'new' && (
                  <Button type="button" variant="outline" onClick={chooseNewFamily}>
                    {t('family.newFamily')}
                  </Button>
                )}
                {errors.family && !family && (
                  <p role="alert" className="text-xs text-destructive">
                    {t('errors.family_or_family_id')}
                  </p>
                )}
                {family?.kind === 'new' && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="fam-name" label="family.name" error={errors['family.name']} required>
                      <Input
                        id="fam-name"
                        value={familyDraft.name}
                        onChange={(e) => setFamilyDraft({ ...familyDraft, name: e.target.value })}
                      />
                    </Field>
                    <Field id="fam-area" label="family.area">
                      <Input
                        id="fam-area"
                        value={familyDraft.area}
                        onChange={(e) => setFamilyDraft({ ...familyDraft, area: e.target.value })}
                      />
                    </Field>
                    <Field id="fam-address" label="family.address" className="sm:col-span-2">
                      <Input
                        id="fam-address"
                        value={familyDraft.address}
                        onChange={(e) =>
                          setFamilyDraft({ ...familyDraft, address: e.target.value })
                        }
                      />
                    </Field>
                  </div>
                )}
              </>
            )}
          </Section>

          {(family?.kind === 'new' || guardians.length > 0) && (
            <Section title={t('admission.sections.guardians')}>
              {guardians.map((g, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: drafts have no id until saved.
                <div key={i} className="flex flex-col gap-2 border-b pb-3 last:border-0">
                  <GuardianFieldset
                    value={g}
                    idPrefix={`g${i}`}
                    prefix={`guardians.${i}.`}
                    errors={errors}
                    onChange={(next) => setGuardians(guardians.map((x, j) => (j === i ? next : x)))}
                  />
                  {(guardians.length > 1 || family?.kind === 'existing') && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      onClick={() => setGuardians(guardians.filter((_, j) => j !== i))}
                    >
                      <Trash2 aria-hidden />
                      {t('common.remove')}
                    </Button>
                  )}
                </div>
              ))}
              {errors.guardians && (
                <p role="alert" className="text-xs text-destructive">
                  {t('errors.guardian_required')}
                </p>
              )}
              {guardians.length < 4 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    setGuardians([...guardians, emptyGuardian('', guardians.length + 1)])
                  }
                >
                  <Plus aria-hidden />
                  {t('guardian.add')}
                </Button>
              )}
            </Section>
          )}

          <Section title={t('admission.sections.student')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="st-name" label="student.name" error={errors['student.name']} required>
                <Input
                  id="st-name"
                  value={student.name}
                  onChange={(e) => setStudent({ ...student, name: e.target.value })}
                />
              </Field>
              <Field id="st-father" label="student.fatherName">
                <Input
                  id="st-father"
                  value={student.father_name}
                  onChange={(e) => setStudent({ ...student, father_name: e.target.value })}
                />
              </Field>
              <Field id="st-gender" label="student.gender">
                <Select
                  id="st-gender"
                  value={student.gender}
                  onChange={(e) =>
                    setStudent({ ...student, gender: e.target.value as StudentDraft['gender'] })
                  }
                >
                  <option value="">—</option>
                  <option value="m">{t('student.genders.m')}</option>
                  <option value="f">{t('student.genders.f')}</option>
                </Select>
              </Field>
              <Field id="st-dob" label="student.dob" error={errors['student.dob']}>
                <Input
                  id="st-dob"
                  type="date"
                  value={student.dob}
                  onChange={(e) => setStudent({ ...student, dob: e.target.value })}
                />
              </Field>
              <Field id="st-bform" label="student.bForm" error={errors['student.b_form_no']}>
                <Input
                  id="st-bform"
                  inputMode="numeric"
                  dir="ltr"
                  value={student.b_form_no}
                  onChange={(e) => setStudent({ ...student, b_form_no: e.target.value })}
                />
              </Field>
              <Field
                id="st-admno"
                label="student.admissionNo"
                hint={t('student.admissionNoHelp')}
                error={errors['student.admission_no']}
              >
                <Input
                  id="st-admno"
                  dir="ltr"
                  value={student.admission_no}
                  onChange={(e) => setStudent({ ...student, admission_no: e.target.value })}
                />
              </Field>
              <Field
                id="st-admdate"
                label="student.admissionDate"
                error={errors['student.admission_date']}
                required
              >
                <Input
                  id="st-admdate"
                  type="date"
                  value={student.admission_date}
                  onChange={(e) => setStudent({ ...student, admission_date: e.target.value })}
                />
              </Field>
            </div>
            <CustomFieldInputs
              fields={customFields}
              value={extra}
              onChange={setExtra}
              errors={errors}
            />
            <PhotoPicker onChange={setPhoto} />
          </Section>
        </>
      )}

      <Section title={t('admission.sections.group')}>
        <GroupPicker
          value={enrol.grp_id}
          onChange={(grp_id) => setEnrol({ ...enrol, grp_id })}
          error={errors['enrolment.grp_id']}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field id="adm-start" label="admission.startDate" error={errors['enrolment.start_date']}>
            <Input
              id="adm-start"
              type="date"
              value={enrol.start_date}
              onChange={(e) => setEnrol({ ...enrol, start_date: e.target.value })}
            />
          </Field>
          <Field id="adm-roll" label="admission.rollNo" hint={t('admission.rollNoHelp')}>
            <Input
              id="adm-roll"
              dir="ltr"
              value={enrol.roll_no}
              onChange={(e) => setEnrol({ ...enrol, roll_no: e.target.value })}
            />
          </Field>
        </div>
      </Section>

      <ErrorNote error={submit.error} />
      <Button type="submit" size="lg" disabled={submit.isPending}>
        {submit.isPending ? t('common.saving') : t('admission.submit')}
      </Button>
    </form>
  );
}
