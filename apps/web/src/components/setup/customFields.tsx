import {
  CUSTOM_FIELD_TYPES,
  type CustomFieldDto,
  customFieldInputSchema,
  newId,
} from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { sendJson } from '@/lib/api';
import { type FieldErrors, issuesToErrors } from '@/lib/form';
import { useCustomFields } from '@/lib/queries';

type FieldType = (typeof CUSTOM_FIELD_TYPES)[number];
const empty = { key: '', label_en: '', label_ur: '', type: 'text' as FieldType };

export function CustomFieldsEditor() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fields = useCustomFields().data?.items ?? [];
  const [draft, setDraft] = useState(empty);
  const [editing, setEditing] = useState<CustomFieldDto | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['custom-fields'] });
  const save = useMutation({
    mutationFn: () =>
      editing
        ? sendJson('PATCH', `/api/custom-fields/${editing.id}`, {
            label_en: draft.label_en,
            label_ur: draft.label_ur,
          })
        : sendJson('POST', '/api/custom-fields', { id: newId(), entity: 'student', ...draft }),
    onSuccess: async () => {
      setDraft(empty);
      setEditing(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => sendJson('DELETE', `/api/custom-fields/${id}`),
    onSuccess: refresh,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = customFieldInputSchema.safeParse(draft);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, draft));
    setErrors({});
    save.mutate();
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('customField.help')}</p>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('customField.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {fields.map((f) => (
            <li key={f.id} className="flex min-h-12 items-center gap-2 px-3">
              <span className="flex-1">
                {f.label_en}
                {f.label_ur && (
                  <span lang="ur" className="ms-2 text-muted-foreground">
                    {f.label_ur}
                  </span>
                )}
              </span>
              <bdi className="text-xs text-muted-foreground">{f.key}</bdi>
              <Badge variant="outline">{t(`customField.types.${f.type}`)}</Badge>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('common.edit')}
                onClick={() => {
                  setEditing(f);
                  setDraft({
                    key: f.key,
                    label_en: f.label_en,
                    label_ur: f.label_ur ?? '',
                    type: f.type,
                  });
                }}
              >
                <Pencil aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('common.delete')}
                onClick={() => remove.mutate(f.id)}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={remove.error} />
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-3 rounded-md border p-3 sm:grid-cols-2"
      >
        <Field id="cf-key" label="customField.key" error={errors.key} required>
          <Input
            id="cf-key"
            dir="ltr"
            value={draft.key}
            disabled={!!editing}
            placeholder="blood_group"
            onChange={(e) => setDraft({ ...draft, key: e.target.value.toLowerCase() })}
          />
        </Field>
        <Field id="cf-type" label="customField.type">
          <Select
            id="cf-type"
            value={draft.type}
            disabled={!!editing}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as FieldType })}
          >
            {CUSTOM_FIELD_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`customField.types.${ty}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="cf-en" label="customField.labelEn" error={errors.label_en} required>
          <Input
            id="cf-en"
            value={draft.label_en}
            onChange={(e) => setDraft({ ...draft, label_en: e.target.value })}
          />
        </Field>
        <Field id="cf-ur" label="customField.labelUr">
          <Input
            id="cf-ur"
            lang="ur"
            dir="rtl"
            value={draft.label_ur}
            onChange={(e) => setDraft({ ...draft, label_ur: e.target.value })}
          />
        </Field>
        <ErrorNote error={save.error} />
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={save.isPending}>
            {editing ? t('common.save') : t('customField.add')}
          </Button>
          {editing && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditing(null);
                setDraft(empty);
              }}
            >
              {t('common.cancel')}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
