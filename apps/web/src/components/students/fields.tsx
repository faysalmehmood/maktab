import {
  type CustomFieldDto,
  formatPkPhone,
  type GuardianDto,
  type GuardianFields,
  normalizePkPhone,
} from '@maktab/shared';
import { Camera } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field, useErrorText } from '@/components/form';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { currentLanguage } from '@/i18n';
import { errorKey, type FieldErrors } from '@/lib/form';
import { resizeToJpeg } from '@/lib/image';

/** First Strong Isolate … Pop: keeps a Latin number intact inside an Urdu sentence. */
export const isolate = (s: string) => `⁨${s}⁩`;

export type GuardianDraft = {
  name: string;
  relation: string;
  phone: string;
  whatsapp: string;
  cnic: string;
  priority: number;
  consent_whatsapp: boolean;
  consent_sms: boolean;
  lang: 'en' | 'ur';
};

export const emptyGuardian = (phone = '', priority = 1): GuardianDraft => ({
  name: '',
  relation: '',
  phone,
  whatsapp: '',
  cnic: '',
  priority,
  consent_whatsapp: false,
  consent_sms: false,
  lang: 'ur',
});

export const guardianDraftFrom = (g: GuardianDto): GuardianDraft => ({
  name: g.name,
  relation: g.relation ?? '',
  phone: formatPkPhone(g.phone),
  whatsapp: g.whatsapp && g.whatsapp !== g.phone ? formatPkPhone(g.whatsapp) : '',
  // A masked CNIC must not be sent back as if it were the real one.
  cnic: g.cnic && /^\d{13}$/.test(g.cnic) ? g.cnic : '',
  priority: g.priority,
  consent_whatsapp: g.consent_whatsapp,
  consent_sms: g.consent_sms,
  lang: g.lang,
});

export const guardianInput = (d: GuardianDraft): GuardianFields => ({
  name: d.name,
  relation: d.relation,
  phone: d.phone,
  whatsapp: d.whatsapp,
  cnic: d.cnic,
  priority: d.priority,
  consent_whatsapp: d.consent_whatsapp,
  consent_sms: d.consent_sms,
  lang: d.lang,
});

/** Shows what a typed phone will be stored as (PLAN exp4), or nothing while it is blank. */
export function PhoneHint({ value }: { value: string }) {
  const { t } = useTranslation();
  const p = value.trim() ? normalizePkPhone(value) : null;
  if (!p) return null;
  return <>{t('guardian.savedAs', { phone: isolate(p.number) })}</>;
}

export function GuardianFieldset({
  value,
  onChange,
  errors,
  prefix,
  idPrefix,
}: {
  value: GuardianDraft;
  onChange: (g: GuardianDraft) => void;
  errors: FieldErrors;
  /** Error-path prefix, e.g. "guardians.0." */
  prefix: string;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof GuardianDraft>(k: K, v: GuardianDraft[K]) =>
    onChange({ ...value, [k]: v });
  const id = (f: string) => `${idPrefix}-${f}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={id('name')} label="guardian.name" error={errors[`${prefix}name`]} required>
          <Input id={id('name')} value={value.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field id={id('relation')} label="guardian.relation">
          <Input
            id={id('relation')}
            placeholder={t('guardian.relationPlaceholder')}
            value={value.relation}
            onChange={(e) => set('relation', e.target.value)}
          />
        </Field>
        <Field
          id={id('phone')}
          label="guardian.phone"
          error={errors[`${prefix}phone`]}
          hint={<PhoneHint value={value.phone} />}
          required
        >
          <Input
            id={id('phone')}
            type="tel"
            inputMode="tel"
            dir="ltr"
            value={value.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
        </Field>
        <Field
          id={id('whatsapp')}
          label="guardian.whatsapp"
          error={errors[`${prefix}whatsapp`]}
          hint={t('guardian.whatsappHelp')}
        >
          <Input
            id={id('whatsapp')}
            type="tel"
            inputMode="tel"
            dir="ltr"
            value={value.whatsapp}
            onChange={(e) => set('whatsapp', e.target.value)}
          />
        </Field>
        <Field id={id('cnic')} label="guardian.cnic" error={errors[`${prefix}cnic`]}>
          <Input
            id={id('cnic')}
            inputMode="numeric"
            dir="ltr"
            value={value.cnic}
            onChange={(e) => set('cnic', e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id={id('lang')} label="guardian.lang">
            <Select
              id={id('lang')}
              value={value.lang}
              onChange={(e) => set('lang', e.target.value === 'en' ? 'en' : 'ur')}
            >
              <option value="ur">اردو</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field id={id('priority')} label="guardian.priority">
            <Select
              id={id('priority')}
              value={String(value.priority)}
              onChange={(e) => set('priority', Number(e.target.value))}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Checkbox
        label={t('guardian.consent')}
        checked={value.consent_whatsapp}
        onChange={(e) => set('consent_whatsapp', e.target.checked)}
      />
      <Checkbox
        label={t('guardian.consentSms')}
        checked={value.consent_sms}
        onChange={(e) => set('consent_sms', e.target.checked)}
      />
    </div>
  );
}

export type Extra = Record<string, string | number | boolean | null>;

/** Inputs for the school's custom fields; values are typed per field (PLAN §5.1 `extra`). */
export function CustomFieldInputs({
  fields,
  value,
  onChange,
  errors,
}: {
  fields: CustomFieldDto[];
  value: Extra;
  onChange: (v: Extra) => void;
  errors: FieldErrors;
}) {
  const { t } = useTranslation();
  const lang = currentLanguage();
  if (!fields.length) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => {
        const id = `cf-${f.key}`;
        const label = lang === 'ur' && f.label_ur ? f.label_ur : f.label_en;
        const v = value[f.key];
        const err = errors[`extra.${f.key}`];
        if (f.type === 'bool') {
          return (
            <Checkbox
              key={f.key}
              label={label}
              checked={v === true}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.checked })}
            />
          );
        }
        return (
          <div key={f.key} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium">
              {label}
            </label>
            <Input
              id={id}
              type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
              dir={f.type === 'text' ? undefined : 'ltr'}
              value={v == null ? '' : String(v)}
              onChange={(e) => {
                const raw = e.target.value;
                const next =
                  raw === '' ? null : f.type === 'number' ? Number(raw) : (raw as string);
                onChange({ ...value, [f.key]: next });
              }}
            />
            {err && (
              <p role="alert" className="text-xs text-destructive">
                {t(errorKey(err))}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Camera or gallery → JPEG ≤ 100 KB in the browser, before anything is uploaded. */
export function PhotoPicker({ onChange }: { onChange: (photo: Blob | null) => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [preview, setPreview] = useState<{ url: string; kb: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="student-photo"
        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-accent"
      >
        <Camera aria-hidden className="size-5" />
        {t('student.takePhoto')}
      </label>
      <input
        id="student-photo"
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            const blob = await resizeToJpeg(file);
            setError(null);
            setPreview({ url: URL.createObjectURL(blob), kb: Math.ceil(blob.size / 1024) });
            onChange(blob);
          } catch (err) {
            setError(err);
            onChange(null);
          }
        }}
      />
      {preview && (
        <div className="flex items-center gap-3">
          <img src={preview.url} alt="" className="size-16 rounded-md object-cover" />
          <span className="text-sm text-muted-foreground">
            {t('student.photoReady', { kb: preview.kb })}
          </span>
        </div>
      )}
      {!!error && (
        <p role="alert" className="text-xs text-destructive">
          {errorText(error)}
        </p>
      )}
    </div>
  );
}
