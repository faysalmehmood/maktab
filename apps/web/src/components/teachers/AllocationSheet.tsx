import type { GroupDto, TeacherRowDto } from '@maktab/shared';
import { BookOpen, Plus, Trash2, UserRoundCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote } from '@/components/form';
import { ConfirmDialog, EmptyState, ListRow, RowList, StatusBadge } from '@/components/page';
import { RowMenu } from '@/components/row-menu';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { useIsPhone } from '@/lib/media';
import { type AssignChange, useAssign } from '@/lib/teachers';
import { cn, isolate } from '@/lib/utils';
import { loadText, subjectLabel } from './text';

const groupName = (g: Pick<GroupDto, 'programme_name' | 'name'>) => `${g.programme_name} ${g.name}`;

/** A change waiting for the user's yes: replacing someone, or removing this teacher. */
type Pending = {
  change: AssignChange;
  title: string;
  body: string;
  confirm: string;
  remove: boolean;
};

/**
 * The teacher's "allocation card" (Teachers page): class-teacher groups and subjects, each
 * removable from its row menu, plus "Set as class teacher of…" and "Add subject…". Every write
 * goes through the group endpoints (useAssign); replacing another teacher or removing asks first.
 * A right-side sheet on desktop, full screen on a phone.
 */
export function AllocationSheet({
  teacher,
  groups,
  sessionName,
  onClose,
}: {
  teacher: TeacherRowDto;
  /** The session's live groups (GET /api/groups), with their subjects and teachers. */
  groups: readonly GroupDto[];
  sessionName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const [adding, setAdding] = useState<'class' | 'subject' | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const assign = useAssign((change) => {
    toast.success(t(change.staffId ? 'screens.teachers.saved' : 'screens.teachers.removed'));
    setPending(null);
    setAdding(null);
  });
  const me = teacher.staff_id;
  const name = isolate(teacher.name);
  const open = groups.filter((g) => g.status !== 'closed');

  const run = (p: Pending | null, change: AssignChange) => {
    assign.reset();
    if (p) setPending(p);
    else assign.mutate(change);
  };

  const setClass = (g: GroupDto) => {
    const change: AssignChange = { kind: 'class', grpId: g.id, staffId: me };
    const current = g.class_teacher_id && g.class_teacher_id !== me ? g.class_teacher_name : null;
    run(
      current
        ? {
            change,
            remove: false,
            title: t('screens.teachers.replaceTitle', { current: isolate(current) }),
            body: t('screens.teachers.replaceClassBody', {
              group: isolate(groupName(g)),
              current: isolate(current),
              name,
            }),
            confirm: t('screens.teachers.replace'),
          }
        : null,
      change,
    );
  };

  const addSubject = (g: GroupDto, s: GroupDto['subjects'][number]) => {
    const change: AssignChange = { kind: 'subject', grpId: g.id, grpSubjectId: s.id, staffId: me };
    const current = s.teacher_id && s.teacher_id !== me ? s.teacher_name : null;
    run(
      current
        ? {
            change,
            remove: false,
            title: t('screens.teachers.replaceTitle', { current: isolate(current) }),
            body: t('screens.teachers.replaceSubjectBody', {
              subject: isolate(s.subject_name),
              group: isolate(groupName(g)),
              current: isolate(current),
              name,
            }),
            confirm: t('screens.teachers.replace'),
          }
        : null,
      change,
    );
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="end"
        id="teacher-sheet"
        className={cn(
          'gap-0 overflow-y-auto',
          phone ? 'w-full max-w-none border-s-0 sm:max-w-none' : 'w-full sm:max-w-md',
        )}
      >
        <SheetHeader className="border-b pe-12">
          <SheetTitle className="text-section">
            <bdi>{teacher.name}</bdi>
          </SheetTitle>
          <SheetDescription>
            {t('screens.teachers.sheetHint', { session: isolate(sessionName) })}{' '}
            {loadText(t, teacher)}
          </SheetDescription>
          {teacher.staff_status === 'left' && (
            <p className="flex flex-col items-start gap-1 text-sm text-warn">
              <StatusBadge tone="warn">{t('screens.teachers.left')}</StatusBadge>
              {t('screens.teachers.leftHint')}
            </p>
          )}
        </SheetHeader>

        <Section
          title={t('screens.teachers.classSection')}
          action={
            teacher.staff_status === 'active' &&
            adding !== 'class' && (
              <Button id="teacher-set-class" variant="outline" onClick={() => setAdding('class')}>
                <UserRoundCheck aria-hidden />
                {t('screens.teachers.setClass')}
              </Button>
            )
          }
        >
          {adding === 'class' && (
            <ClassPicker
              groups={open.filter((g) => g.class_teacher_id !== me)}
              pending={assign.isPending}
              onCancel={() => setAdding(null)}
              onPick={setClass}
            />
          )}
          {teacher.class_teacher_of.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {t('screens.teachers.notClassTeacher')}
            </p>
          ) : (
            <RowList>
              {teacher.class_teacher_of.map((g) => (
                <ListRow
                  key={g.grp_id}
                  title={<bdi>{g.name}</bdi>}
                  trailing={
                    <RowMenu
                      label={t('screens.teachers.itemMenu', { item: isolate(g.name) })}
                      actions={[
                        {
                          id: `remove-class-${g.grp_id}`,
                          label: t('common.remove'),
                          icon: Trash2,
                          destructive: true,
                          onSelect: () =>
                            run(
                              {
                                change: { kind: 'class', grpId: g.grp_id, staffId: null },
                                remove: true,
                                title: t('screens.teachers.removeClassTitle', {
                                  name,
                                  group: isolate(g.name),
                                }),
                                body: t('screens.teachers.removeClassBody', {
                                  group: isolate(g.name),
                                }),
                                confirm: t('common.remove'),
                              },
                              { kind: 'class', grpId: g.grp_id, staffId: null },
                            ),
                        },
                      ]}
                    />
                  }
                />
              ))}
            </RowList>
          )}
        </Section>

        <Section
          title={t('screens.teachers.subjectsSection')}
          action={
            teacher.staff_status === 'active' &&
            adding !== 'subject' && (
              <Button
                id="teacher-add-subject"
                variant="outline"
                onClick={() => setAdding('subject')}
              >
                <Plus aria-hidden />
                {t('screens.teachers.addSubject')}
              </Button>
            )
          }
        >
          {adding === 'subject' && (
            <SubjectPicker
              groups={open.filter((g) => g.subjects.some((s) => s.teacher_id !== me))}
              me={me}
              pending={assign.isPending}
              onCancel={() => setAdding(null)}
              onPick={addSubject}
            />
          )}
          {teacher.subjects.length === 0 ? (
            <EmptyState icon={BookOpen} title={t('screens.teachers.noSubjects')} className="py-6" />
          ) : (
            <RowList>
              {teacher.subjects.map((s) => {
                const label = subjectLabel(t, s);
                const change: AssignChange = {
                  kind: 'subject',
                  grpId: s.grp_id,
                  grpSubjectId: s.grp_subject_id,
                  staffId: null,
                };
                return (
                  <ListRow
                    key={s.grp_subject_id}
                    title={label}
                    trailing={
                      <RowMenu
                        label={t('screens.teachers.itemMenu', { item: label })}
                        actions={[
                          {
                            id: `remove-subject-${s.grp_subject_id}`,
                            label: t('common.remove'),
                            icon: Trash2,
                            destructive: true,
                            onSelect: () =>
                              run(
                                {
                                  change,
                                  remove: true,
                                  title: t('screens.teachers.removeSubjectTitle', {
                                    name,
                                    subject: isolate(s.subject_name),
                                    group: isolate(s.grp_name),
                                  }),
                                  body: t('screens.teachers.removeSubjectBody'),
                                  confirm: t('common.remove'),
                                },
                                change,
                              ),
                          },
                        ]}
                      />
                    }
                  />
                );
              })}
            </RowList>
          )}
        </Section>

        {!pending && assign.error && (
          <div className="p-4">
            <ErrorNote error={assign.error} />
          </div>
        )}

        {pending && (
          <ConfirmDialog
            open
            destructive={pending.remove}
            title={pending.title}
            body={pending.body}
            confirm={pending.confirm}
            pending={assign.isPending}
            onCancel={() => {
              setPending(null);
              assign.reset();
            }}
            onConfirm={() => assign.mutate(pending.change)}
          >
            <ErrorNote error={assign.error} />
          </ConfirmDialog>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="border-b">
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-4 py-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/** "Set as class teacher of…": one group; a group that has someone shows who. */
function ClassPicker({
  groups,
  pending,
  onCancel,
  onPick,
}: {
  groups: readonly GroupDto[];
  pending: boolean;
  onCancel: () => void;
  onPick: (g: GroupDto) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [grpId, setGrpId] = useState('');
  const g = groups.find((x) => x.id === grpId);
  if (groups.length === 0)
    return <PickerNote onCancel={onCancel}>{t('screens.teachers.noGroupsLeft')}</PickerNote>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (g) onPick(g);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 bg-muted/40 px-4 py-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-grp`}>{t('screens.teachers.group')}</Label>
        <Select id={`${id}-grp`} value={grpId} onChange={(e) => setGrpId(e.target.value)}>
          <option value="">{t('screens.teachers.choose')}</option>
          {groups.map((x) => (
            <option key={x.id} value={x.id}>
              {x.class_teacher_name
                ? t('screens.teachers.hasTeacher', {
                    name: isolate(groupName(x)),
                    teacher: isolate(x.class_teacher_name),
                  })
                : groupName(x)}
            </option>
          ))}
        </Select>
      </div>
      <PickerButtons disabled={!g || pending} onCancel={onCancel} />
    </form>
  );
}

/** "Add subject…": a group, then one of its subjects this teacher does not teach yet. */
function SubjectPicker({
  groups,
  me,
  pending,
  onCancel,
  onPick,
}: {
  groups: readonly GroupDto[];
  me: string;
  pending: boolean;
  onCancel: () => void;
  onPick: (g: GroupDto, s: GroupDto['subjects'][number]) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [grpId, setGrpId] = useState('');
  const [subId, setSubId] = useState('');
  if (groups.length === 0)
    return <PickerNote onCancel={onCancel}>{t('screens.teachers.noGroupsLeft')}</PickerNote>;
  const g = groups.find((x) => x.id === grpId);
  const subjects = g ? g.subjects.filter((s) => s.teacher_id !== me) : [];
  const s = subjects.find((x) => x.id === subId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (g && s) onPick(g, s);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 bg-muted/40 px-4 py-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-grp`}>{t('screens.teachers.group')}</Label>
        <Select
          id={`${id}-grp`}
          value={grpId}
          onChange={(e) => {
            setGrpId(e.target.value);
            setSubId('');
          }}
        >
          <option value="">{t('screens.teachers.choose')}</option>
          {groups.map((x) => (
            <option key={x.id} value={x.id}>
              {groupName(x)}
            </option>
          ))}
        </Select>
      </div>
      {g && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-sub`}>{t('screens.teachers.subject')}</Label>
          <Select id={`${id}-sub`} value={subId} onChange={(e) => setSubId(e.target.value)}>
            <option value="">{t('screens.teachers.choose')}</option>
            {subjects.map((x) => (
              <option key={x.id} value={x.id}>
                {x.teacher_name
                  ? t('screens.teachers.hasTeacher', {
                      name: isolate(x.subject_name),
                      teacher: isolate(x.teacher_name),
                    })
                  : x.subject_name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <PickerButtons disabled={!s || pending} onCancel={onCancel} />
    </form>
  );
}

function PickerButtons({ disabled, onCancel }: { disabled: boolean; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" disabled={disabled}>
        {t('common.save')}
      </Button>
    </div>
  );
}

function PickerNote({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-3 text-sm">
      <p className="text-muted-foreground">{children}</p>
      <Button type="button" variant="outline" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </div>
  );
}
