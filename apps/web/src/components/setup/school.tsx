import {
  formatPkPhone,
  MAX_LOGO_BYTES,
  SCHOOL_MODES,
  type SchoolDto,
  type SchoolInput,
  type SchoolResponse,
  schoolInputSchema,
} from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { sendJson, uploadFile } from '@/lib/api';
import { useFeeSettings } from '@/lib/fees';
import { type FieldErrors, issuesToErrors } from '@/lib/form';
import { cn } from '@/lib/utils';

export function schoolToInput(s: SchoolDto | null | undefined): SchoolInput {
  return {
    name: s?.name ?? '',
    name_ur: s?.name_ur ?? '',
    mode: s?.mode ?? 'school',
    address: s?.address ?? '',
    phone: formatPkPhone(s?.phone),
    default_lang: s?.default_lang ?? 'ur',
    receipt_prefix: s?.receipt_prefix ?? '',
  };
}

export function useSaveSchool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SchoolInput) => sendJson<SchoolResponse>('PUT', '/api/school', input),
    onSuccess: (data) => qc.setQueryData(['school'], data),
  });
}

/** The wizard's last step: an explicit owner action, separate from saving the profile. */
export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => sendJson<SchoolResponse>('POST', '/api/school/complete-setup'),
    onSuccess: (data) => qc.setQueryData(['school'], data),
  });
}

/**
 * School profile (`part="profile"`), school/academy mode (`part="mode"`) or both. Always PUTs the
 * whole profile, starting from what the server has, so one part never blanks the other.
 */
export function SchoolForm({
  school,
  part = 'all',
  formId,
  readOnly = false,
  onSaved,
}: {
  school: SchoolDto | null | undefined;
  part?: 'profile' | 'mode' | 'all';
  formId?: string;
  readOnly?: boolean;
  onSaved?: (s: SchoolDto | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SchoolInput>(() => schoolToInput(school));
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useSaveSchool();
  // Printed receipt numbers carry the prefix: locked once a receipt exists (API: prefix_locked).
  const prefixLocked = !!useFeeSettings().data?.fees.receipts_issued;
  const set = <K extends keyof SchoolInput>(k: K, v: SchoolInput[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    const parsed = schoolInputSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues, draft));
      return;
    }
    setErrors({});
    save.mutate(draft, {
      onSuccess: (data) => {
        if (!formId) toast.success(t('common.saved'));
        onSaved?.(data.school);
      },
    });
  };

  const showProfile = part !== 'mode';
  const showMode = part !== 'profile';
  return (
    <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {showProfile && (
        <>
          <Field id="school-name" label="school.name" error={errors.name} required>
            <Input
              id="school-name"
              value={draft.name}
              readOnly={readOnly}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field id="school-name-ur" label="school.nameUr">
            <Input
              id="school-name-ur"
              lang="ur"
              dir="rtl"
              value={draft.name_ur ?? ''}
              readOnly={readOnly}
              onChange={(e) => set('name_ur', e.target.value)}
            />
          </Field>
          <Field id="school-address" label="school.address">
            <Input
              id="school-address"
              value={draft.address ?? ''}
              readOnly={readOnly}
              onChange={(e) => set('address', e.target.value)}
            />
          </Field>
          <Field id="school-phone" label="school.phone" error={errors.phone}>
            <Input
              id="school-phone"
              type="tel"
              dir="ltr"
              inputMode="tel"
              value={draft.phone ?? ''}
              readOnly={readOnly}
              onChange={(e) => set('phone', e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="school-lang" label="school.defaultLang">
              <Select
                id="school-lang"
                value={draft.default_lang}
                disabled={readOnly}
                onChange={(e) => set('default_lang', e.target.value === 'en' ? 'en' : 'ur')}
              >
                <option value="ur">اردو</option>
                <option value="en">English</option>
              </Select>
            </Field>
            <Field
              id="school-prefix"
              label="school.receiptPrefix"
              error={errors.receipt_prefix}
              hint={prefixLocked ? t('fee.setup.prefixLocked') : t('school.receiptPrefixHelp')}
            >
              <Input
                id="school-prefix"
                dir="ltr"
                value={draft.receipt_prefix ?? ''}
                readOnly={readOnly || prefixLocked}
                onChange={(e) => set('receipt_prefix', e.target.value.toUpperCase())}
              />
            </Field>
          </div>
        </>
      )}
      {showMode && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('school.mode')}</legend>
          {SCHOOL_MODES.map((m) => (
            <label
              key={m}
              className={cn(
                'flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3',
                draft.mode === m && 'border-primary bg-primary/5',
              )}
            >
              <input
                type="radio"
                name="mode"
                value={m}
                className="mt-1 size-5 accent-primary"
                checked={draft.mode === m}
                disabled={readOnly}
                onChange={() => set('mode', m)}
              />
              <span className="flex flex-col">
                <span className="font-medium">{t(`school.modes.${m}`)}</span>
                <span className="text-sm text-muted-foreground">{t(`school.modeHelp.${m}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <ErrorNote error={save.error} />
      {!formId && !readOnly && (
        <Button type="submit" className="self-start" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </Button>
      )}
    </form>
  );
}

/**
 * The school logo. With a saved school it uploads on choose. Before the school row exists (the
 * wizard's first visit to step 1, defect 4.6) it *stages* the file instead: `onStage` gets it, the
 * preview shows, and the wizard uploads it right after the first save.
 */
export function LogoUpload({
  school,
  staged,
  onStage,
}: {
  school: SchoolDto | null | undefined;
  staged?: File | null;
  onStage?: (f: File | null) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [version, setVersion] = useState(0);
  const [tooBig, setTooBig] = useState(false);
  const kb = MAX_LOGO_BYTES / 1024;
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile<SchoolResponse>('/api/school/logo', file, file.name),
    onSuccess: (data) => {
      qc.setQueryData(['school'], data);
      setVersion((v) => v + 1);
      toast.success(t('common.saved'));
    },
  });
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!staged || typeof URL.createObjectURL !== 'function') {
      setPreview(null);
      return;
    }
    const u = URL.createObjectURL(staged);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [staged]);
  const staging = !school && !!onStage;
  if (!school && !staging) return null;
  return (
    <div className="flex flex-col gap-2">
      <Field id="school-logo" label="school.logo" hint={t('school.logoHelp', { kb })}>
        <div className="flex items-center gap-3">
          {school?.has_logo && (
            <img
              src={`/api/school/logo?v=${version}`}
              alt={t('school.logo')}
              className="size-14 rounded-md border object-contain"
            />
          )}
          {staging && preview && (
            <img
              src={preview}
              alt={t('school.logo')}
              className="size-14 rounded-md border object-contain"
            />
          )}
          <Input
            id="school-logo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Same limit as the API (MAX_LOGO_BYTES), so a big photo is refused before upload.
              setTooBig(!!f && f.size > MAX_LOGO_BYTES);
              const ok = f && f.size <= MAX_LOGO_BYTES ? f : null;
              if (staging) onStage?.(ok);
              else if (ok) upload.mutate(ok);
            }}
          />
        </div>
      </Field>
      {staging && staged && (
        <p className="text-sm text-muted-foreground">{t('setup.logoStaged')}</p>
      )}
      {tooBig && (
        <p role="alert" className="text-sm text-destructive">
          {t('school.logoTooBig', { kb })}
        </p>
      )}
      <ErrorNote error={upload.error} />
    </div>
  );
}
