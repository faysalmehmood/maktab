import { type StudentDetailDto, type StudentFields, studentPatchSchema } from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { ErrorNote, Field, PageTitle } from '@/components/form';
import { CustomFieldInputs, type Extra } from '@/components/students/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { sendJson } from '@/lib/api';
import { type FieldErrors, issuesToErrors } from '@/lib/form';
import { useCustomFields } from '@/lib/queries';
import { useStudent } from './StudentDetail';

type Draft = {
  name: string;
  father_name: string;
  gender: '' | 'm' | 'f';
  dob: string;
  b_form_no: string;
  admission_no: string;
  admission_date: string;
};

function EditForm({ s }: { s: StudentDetailDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fields = useCustomFields().data?.items ?? [];
  // A masked B-form (teachers never get here, but be safe) is not editable as a value.
  const bForm = s.b_form_no && /^\d{13}$/.test(s.b_form_no) ? s.b_form_no : '';
  const [draft, setDraft] = useState<Draft>({
    name: s.name,
    father_name: s.father_name ?? '',
    gender: s.gender ?? '',
    dob: s.dob ?? '',
    b_form_no: bForm,
    admission_no: s.admission_no,
    admission_date: s.admission_date,
  });
  const [extra, setExtra] = useState<Extra>(s.extra);
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: (input: Partial<StudentFields>) =>
      sendJson<StudentDetailDto>('PATCH', `/api/students/${s.id}`, input),
    onSuccess: async (updated) => {
      qc.setQueryData(['student', s.id], updated);
      await qc.invalidateQueries({ queryKey: ['students'] });
      navigate(`/students/${s.id}`);
    },
  });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input: Partial<StudentFields> = {
      ...draft,
      gender: draft.gender || null,
      dob: draft.dob || null,
      extra,
    };
    if (!draft.b_form_no && s.b_form_no && !bForm) delete input.b_form_no;
    const parsed = studentPatchSchema.safeParse(input);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, input));
    setErrors({});
    save.mutate(input);
  };
  return (
    <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-4">
      <PageTitle>{t('student.editTitle')}</PageTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="ed-name" label="student.name" error={errors.name} required>
          <Input id="ed-name" value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field id="ed-father" label="student.fatherName">
          <Input
            id="ed-father"
            value={draft.father_name}
            onChange={(e) => set('father_name', e.target.value)}
          />
        </Field>
        <Field id="ed-gender" label="student.gender">
          <Select
            id="ed-gender"
            value={draft.gender}
            onChange={(e) => set('gender', e.target.value as Draft['gender'])}
          >
            <option value="">—</option>
            <option value="m">{t('student.genders.m')}</option>
            <option value="f">{t('student.genders.f')}</option>
          </Select>
        </Field>
        <Field id="ed-dob" label="student.dob" error={errors.dob}>
          <Input
            id="ed-dob"
            type="date"
            value={draft.dob}
            onChange={(e) => set('dob', e.target.value)}
          />
        </Field>
        <Field id="ed-bform" label="student.bForm" error={errors.b_form_no}>
          <Input
            id="ed-bform"
            dir="ltr"
            inputMode="numeric"
            value={draft.b_form_no}
            onChange={(e) => set('b_form_no', e.target.value)}
          />
        </Field>
        <Field id="ed-admno" label="student.admissionNo" error={errors.admission_no}>
          <Input
            id="ed-admno"
            dir="ltr"
            value={draft.admission_no}
            onChange={(e) => set('admission_no', e.target.value)}
          />
        </Field>
        <Field id="ed-admdate" label="student.admissionDate" error={errors.admission_date} required>
          <Input
            id="ed-admdate"
            type="date"
            value={draft.admission_date}
            onChange={(e) => set('admission_date', e.target.value)}
          />
        </Field>
      </div>
      <CustomFieldInputs fields={fields} value={extra} onChange={setExtra} errors={errors} />
      <ErrorNote error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </Button>
        <Button type="button" variant="outline" onClick={() => navigate(-1)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

export function StudentEdit() {
  const { t } = useTranslation();
  const { id } = useParams();
  const student = useStudent(id);
  if (student.isPending) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  if (!student.data) return <p role="alert">{t('common.notFound')}</p>;
  return <EditForm s={student.data} />;
}
