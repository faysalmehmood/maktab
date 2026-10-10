import {
  newId,
  PROGRAMME_KINDS,
  type ProgrammeDto,
  type ProgrammeInput,
  programmeInputSchema,
  type SeedResult,
  type SubjectDto,
  subjectInputSchema,
} from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Sparkles, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { sendJson } from '@/lib/api';
import { type FieldErrors, issuesToErrors } from '@/lib/form';
import { useProgrammes, useSubjects } from '@/lib/queries';

type Kind = (typeof PROGRAMME_KINDS)[number];

/** One button seeds both lists (PLAN §14.1: prefilled Pakistani ladder, editable). */
export function SeedLadderButton() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const seed = useMutation({
    mutationFn: async () => {
      const p = await sendJson<SeedResult>('POST', '/api/programmes/seed-pk');
      const s = await sendJson<SeedResult>('POST', '/api/subjects/seed-pk');
      return { created: p.created + s.created, existing: p.existing + s.existing };
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['programmes'] });
      await qc.invalidateQueries({ queryKey: ['subjects'] });
      toast.success(t('setup.seeded', { created: r.created, existing: r.existing }));
    },
  });
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
      <Button
        type="button"
        variant="secondary"
        disabled={seed.isPending}
        onClick={() => seed.mutate()}
      >
        <Sparkles aria-hidden />
        {t('setup.seedLadder')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('setup.seedHelp')}</p>
      <ErrorNote error={seed.error} />
    </div>
  );
}

function ProgrammeDialog({
  programme,
  all,
  onClose,
}: {
  programme: ProgrammeDto;
  all: ProgrammeDto[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState({
    name: programme.name,
    kind: programme.kind as Kind,
    next_programme_id: programme.next_programme_id ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      sendJson<ProgrammeDto>('PATCH', `/api/programmes/${programme.id}`, {
        name: draft.name,
        kind: draft.kind,
        next_programme_id: draft.next_programme_id || null,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['programmes'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('common.edit')}</DialogTitle>
          <DialogDescription>{programme.name}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.name.trim()) save.mutate();
          }}
        >
          <Field id="prog-name" label="programme.name">
            <Input
              id="prog-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field id="prog-kind" label="programme.kind">
            <Select
              id="prog-kind"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}
            >
              {PROGRAMME_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`programme.kinds.${k}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="prog-next" label="programme.next">
            <Select
              id="prog-next"
              value={draft.next_programme_id}
              onChange={(e) => setDraft({ ...draft, next_programme_id: e.target.value })}
            >
              <option value="">{t('common.none')}</option>
              {all
                .filter((p) => p.id !== programme.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          <ErrorNote error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProgrammesEditor() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const programmes = useProgrammes();
  const items = programmes.data?.items ?? [];
  const [editing, setEditing] = useState<ProgrammeDto | null>(null);
  const [draft, setDraft] = useState<{ name: string; kind: Kind }>({ name: '', kind: 'grade' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const add = useMutation({
    mutationFn: (input: ProgrammeInput) => sendJson<ProgrammeDto>('POST', '/api/programmes', input),
    onSuccess: async () => {
      setDraft({ name: '', kind: draft.kind });
      await qc.invalidateQueries({ queryKey: ['programmes'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => sendJson('DELETE', `/api/programmes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['programmes'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input: ProgrammeInput = {
      id: newId(),
      name: draft.name,
      kind: draft.kind,
      seq: (items.at(-1)?.seq ?? 0) + 1,
    };
    const parsed = programmeInputSchema.safeParse(input);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, input));
    setErrors({});
    add.mutate(input);
  };
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium">{t('programme.title')}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('programme.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {items.map((p) => (
            <li key={p.id} className="flex min-h-12 items-center gap-2 px-3">
              <span className="flex-1">{p.name}</span>
              <Badge variant={p.kind === 'grade' ? 'secondary' : 'outline'}>
                {t(`programme.kinds.${p.kind}`)}
              </Badge>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('common.edit')}
                onClick={() => setEditing(p)}
              >
                <Pencil aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('common.delete')}
                disabled={remove.isPending}
                onClick={() => remove.mutate(p.id)}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={remove.error} />
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2">
        <Field id="new-prog-name" label="programme.name" error={errors.name} className="flex-1">
          <Input
            id="new-prog-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field id="new-prog-kind" label="programme.kind">
          <Select
            id="new-prog-kind"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}
          >
            {PROGRAMME_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`programme.kinds.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="outline" disabled={add.isPending}>
          {t('common.add')}
        </Button>
      </form>
      <ErrorNote error={add.error} />
      {editing && (
        <ProgrammeDialog programme={editing} all={items} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

export function SubjectsEditor() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const subjects = useSubjects();
  const items = subjects.data?.items ?? [];
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SubjectDto | null>(null);
  const [editName, setEditName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['subjects'] });
  const add = useMutation({
    mutationFn: () => sendJson('POST', '/api/subjects', { id: newId(), name }),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  const rename = useMutation({
    mutationFn: (s: SubjectDto) => sendJson('PATCH', `/api/subjects/${s.id}`, { name: editName }),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => sendJson('DELETE', `/api/subjects/${id}`),
    onSuccess: refresh,
  });
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium">{t('subject.title')}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('subject.empty')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((s) =>
            editing?.id === s.id ? (
              <li key={s.id} className="flex items-center gap-1">
                <Input
                  aria-label={t('subject.name')}
                  value={editName}
                  className="h-11 w-36"
                  onChange={(e) => setEditName(e.target.value)}
                />
                <Button size="sm" onClick={() => editName.trim() && rename.mutate(s)}>
                  {t('common.save')}
                </Button>
              </li>
            ) : (
              <li key={s.id} className="flex items-center gap-1 rounded-md border ps-3 text-sm">
                {s.name}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('common.edit')}
                  onClick={() => {
                    setEditing(s);
                    setEditName(s.name);
                  }}
                >
                  <Pencil aria-hidden />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('common.delete')}
                  onClick={() => remove.mutate(s.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ),
          )}
        </ul>
      )}
      <form
        noValidate
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = subjectInputSchema.safeParse({ name });
          if (!parsed.success) return setError('required');
          setError(undefined);
          add.mutate();
        }}
      >
        <Field id="new-subject" label="subject.name" error={error} className="flex-1">
          <Input id="new-subject" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" variant="outline" disabled={add.isPending}>
          {t('common.add')}
        </Button>
      </form>
      <ErrorNote error={add.error ?? rename.error ?? remove.error} />
    </div>
  );
}
