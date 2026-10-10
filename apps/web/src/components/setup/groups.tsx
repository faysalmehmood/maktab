import {
  GRP_STATUSES,
  type GroupDto,
  type GroupInput,
  groupInputSchema,
  newId,
} from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field } from '@/components/form';
import { isolate } from '@/components/students/fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { sendJson } from '@/lib/api';
import { type FieldErrors, issuesToErrors } from '@/lib/form';
import { useGroups, useProgrammes, useStaff, useSubjects } from '@/lib/queries';

type Status = (typeof GRP_STATUSES)[number];
type SubjectRow = { subject_id: string; teacher_id: string };

type Draft = {
  programme_id: string;
  name: string;
  is_primary: boolean;
  capacity: string;
  class_teacher_id: string;
  days: string;
  start_time: string;
  end_time: string;
  room: string;
  status: Status;
  subjects: SubjectRow[];
};

function draftFrom(g: GroupDto | null): Draft {
  return {
    programme_id: g?.programme_id ?? '',
    name: g?.name ?? '',
    is_primary: g?.is_primary ?? true,
    capacity: g?.capacity != null ? String(g.capacity) : '',
    class_teacher_id: g?.class_teacher_id ?? '',
    days: g?.days ?? '',
    start_time: g?.start_time ?? '',
    end_time: g?.end_time ?? '',
    room: g?.room ?? '',
    status: g?.status ?? 'open',
    subjects: (g?.subjects ?? []).map((s) => ({
      subject_id: s.subject_id,
      teacher_id: s.teacher_id ?? '',
    })),
  };
}

/** Create or edit one group, including subject → teacher assignment (PLAN §4). */
export function GroupDialog({
  group,
  sessionId,
  onClose,
}: {
  group: GroupDto | null;
  sessionId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const programmes = useProgrammes().data?.items ?? [];
  const subjects = useSubjects().data?.items ?? [];
  const staff = (useStaff().data?.items ?? []).filter((s) => s.staff_id);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(group));
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: async (input: GroupInput) => {
      const subjectsBody = { subjects: input.subjects ?? [] };
      if (!group) return sendJson<GroupDto>('POST', '/api/groups', input);
      const { subjects: _s, id: _id, ...patch } = input;
      await sendJson<GroupDto>('PATCH', `/api/groups/${group.id}`, patch);
      return sendJson<GroupDto>('PUT', `/api/groups/${group.id}/subjects`, subjectsBody);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['groups'] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input: GroupInput = {
      ...(group ? {} : { id: newId() }),
      programme_id: draft.programme_id,
      session_id: group ? group.session_id : sessionId,
      name: draft.name,
      is_primary: draft.is_primary,
      capacity: draft.capacity ? Number(draft.capacity) : null,
      class_teacher_id: draft.class_teacher_id || null,
      days: draft.days,
      start_time: draft.start_time || null,
      end_time: draft.end_time || null,
      room: draft.room,
      status: draft.status,
      subjects: draft.subjects
        .filter((s) => s.subject_id)
        .map((s) => ({ subject_id: s.subject_id, teacher_id: s.teacher_id || null })),
    };
    const parsed = groupInputSchema.safeParse(input);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, input));
    setErrors({});
    save.mutate(input);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{group ? t('group.edit') : t('group.add')}</DialogTitle>
          <DialogDescription>{t('setup.groupsHelp')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <Field id="grp-programme" label="group.programme" error={errors.programme_id} required>
            <Select
              id="grp-programme"
              value={draft.programme_id}
              onChange={(e) => {
                const p = programmes.find((x) => x.id === e.target.value);
                setDraft((d) => ({
                  ...d,
                  programme_id: e.target.value,
                  is_primary: group ? d.is_primary : p ? p.kind === 'grade' : d.is_primary,
                }));
              }}
            >
              <option value="">{t('admission.pickGroup')}</option>
              {programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="grp-name" label="group.name" error={errors.name} required>
              <Input
                id="grp-name"
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field id="grp-capacity" label="group.capacity" error={errors.capacity}>
              <Input
                id="grp-capacity"
                type="number"
                inputMode="numeric"
                min={1}
                dir="ltr"
                value={draft.capacity}
                onChange={(e) => set('capacity', e.target.value)}
              />
            </Field>
          </div>
          <Checkbox
            label={t('group.primary')}
            checked={draft.is_primary}
            onChange={(e) => set('is_primary', e.target.checked)}
          />
          <Field id="grp-teacher" label="group.classTeacher">
            <Select
              id="grp-teacher"
              value={draft.class_teacher_id}
              onChange={(e) => set('class_teacher_id', e.target.value)}
            >
              <option value="">{t('group.noTeacher')}</option>
              {staff.map((s) => (
                <option key={s.staff_id} value={s.staff_id ?? ''}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field id="grp-days" label="group.days">
              <Input
                id="grp-days"
                value={draft.days}
                onChange={(e) => set('days', e.target.value)}
              />
            </Field>
            <Field id="grp-start" label="group.startTime" error={errors.start_time}>
              <Input
                id="grp-start"
                type="time"
                value={draft.start_time}
                onChange={(e) => set('start_time', e.target.value)}
              />
            </Field>
            <Field id="grp-end" label="group.endTime" error={errors.end_time}>
              <Input
                id="grp-end"
                type="time"
                value={draft.end_time}
                onChange={(e) => set('end_time', e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field id="grp-room" label="group.room">
              <Input
                id="grp-room"
                value={draft.room}
                onChange={(e) => set('room', e.target.value)}
              />
            </Field>
            <Field id="grp-status" label="group.status">
              <Select
                id="grp-status"
                value={draft.status}
                onChange={(e) => set('status', e.target.value as Status)}
              >
                {GRP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`group.statuses.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('group.subjects')}</legend>
            {draft.subjects.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved.
              <div key={i} className="flex items-center gap-2">
                <Select
                  aria-label={t('subject.name')}
                  value={row.subject_id}
                  onChange={(e) =>
                    set(
                      'subjects',
                      draft.subjects.map((r, j) =>
                        j === i ? { ...r, subject_id: e.target.value } : r,
                      ),
                    )
                  }
                >
                  <option value="">{t('admission.pickGroup')}</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={t('group.teacher')}
                  value={row.teacher_id}
                  onChange={(e) =>
                    set(
                      'subjects',
                      draft.subjects.map((r, j) =>
                        j === i ? { ...r, teacher_id: e.target.value } : r,
                      ),
                    )
                  }
                >
                  <option value="">{t('group.noTeacher')}</option>
                  {staff.map((s) => (
                    <option key={s.staff_id} value={s.staff_id ?? ''}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('common.remove')}
                  onClick={() =>
                    set(
                      'subjects',
                      draft.subjects.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}
            {errors.subjects && (
              <p role="alert" className="text-xs text-destructive">
                {t(
                  `errors.${errors.subjects === 'duplicate_subject' ? 'duplicate_subject' : 'invalid'}`,
                )}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                set('subjects', [...draft.subjects, { subject_id: '', teacher_id: '' }])
              }
            >
              <Plus aria-hidden />
              {t('group.addSubject')}
            </Button>
          </fieldset>
          <ErrorNote error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function GroupCard({ g, onEdit }: { g: GroupDto; onEdit?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            <bdi>{g.programme_name}</bdi> · <bdi>{g.name}</bdi>
          </span>
          <Badge variant={g.is_primary ? 'secondary' : 'outline'}>
            {g.is_primary ? t('group.primaryBadge') : t('group.batchBadge')}
          </Badge>
          {g.status !== 'open' && (
            <Badge variant="outline">{t(`group.statuses.${g.status}`)}</Badge>
          )}
        </div>
        <span className="text-sm text-muted-foreground">
          {t('group.students', { n: g.active_count })}
          {g.seats_left != null && (
            <>
              {' · '}
              {g.seats_left > 0 ? t('group.seatsLeft', { n: g.seats_left }) : t('group.full')}
            </>
          )}
        </span>
        {g.class_teacher_name && (
          <span className="text-sm">
            {t('group.classTeacher')}: <bdi>{g.class_teacher_name}</bdi>
          </span>
        )}
        {g.subjects.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {g.subjects
              .map((s) =>
                s.teacher_name
                  ? `${isolate(s.subject_name)} (${isolate(s.teacher_name)})`
                  : isolate(s.subject_name),
              )
              .join('، ')}
          </span>
        )}
      </div>
      {onEdit && (
        <Button size="icon" variant="ghost" aria-label={t('common.edit')} onClick={onEdit}>
          <Pencil aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** Groups of one session with add/edit; used by Settings and the setup wizard. */
export function GroupsEditor({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation();
  const groups = useGroups({ session_id: sessionId });
  const [editing, setEditing] = useState<GroupDto | 'new' | null>(null);
  const items = groups.data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('group.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((g) => (
            <GroupCard key={g.id} g={g} onEdit={() => setEditing(g)} />
          ))}
        </div>
      )}
      <Button variant="outline" className="self-start" onClick={() => setEditing('new')}>
        <Plus aria-hidden />
        {t('group.add')}
      </Button>
      {editing && (
        <GroupDialog
          group={editing === 'new' ? null : editing}
          sessionId={sessionId}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
