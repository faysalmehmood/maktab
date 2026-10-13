import {
  type EnrolmentDto,
  enrolmentEndSchema,
  enrolmentTransferSchema,
  type FamilyDetailDto,
  formatPkPhone,
  type GuardianDto,
  guardianFieldsSchema,
  type MessageListDto,
  newId,
  type StudentDetailDto,
  type StudentFeesDto,
  studentStatusSchema,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  ChevronLeft,
  CircleStop,
  MessageSquareText,
  Pencil,
  Plus,
  UserX,
  Wallet,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { todayPk } from '@/components/attendance/common';
import { Avatar } from '@/components/avatar';
import { DateText } from '@/components/date-text';
import { StudentFeesCard } from '@/components/fees/StudentFees';
import { ErrorNote, Field, Num } from '@/components/form';
import {
  EmptyState,
  GoLink,
  ListRow,
  ListSkeleton,
  Mny,
  Page,
  Panel,
  RowList,
  StatStrip,
  StatusBadge,
  type Tone,
} from '@/components/page';
import { type RowAction, RowMenu } from '@/components/row-menu';
import { type TabItem, TabPanel, Tabs } from '@/components/segmented';
import '@/i18n/screens';
import { ParentLinkPanel } from '@/components/messages/ParentLinkPanel';
import { StudentAttendanceCard } from '@/components/students/attendance';
import {
  emptyGuardian,
  type GuardianDraft,
  GuardianFieldset,
  guardianDraftFrom,
  guardianInput,
  isolate,
  PhotoPicker,
} from '@/components/students/fields';
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
import { getJson, sendJson, uploadFile } from '@/lib/api';
import { canReadAttendance, useStudentAttendance } from '@/lib/attendance';
import { canCollect, canReadMoney } from '@/lib/fees';
import { type FieldErrors, issuesToErrors, todayIso } from '@/lib/form';
import { canReadMessages } from '@/lib/messages';
import { useCurrentSession, useCustomFields, useGroups } from '@/lib/queries';
import { canWriteStudents, useRoles } from '@/lib/roles';

export const useStudent = (id: string | undefined) =>
  useQuery({
    queryKey: ['student', id],
    queryFn: () => getJson<StudentDetailDto>(`/api/students/${id}`),
    enabled: !!id,
  });

function StatusDialog({ student, onClose }: { student: StudentDetailDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState({
    status: 'left' as 'left' | 'graduated',
    date: todayIso(),
    reason: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: () =>
      sendJson<StudentDetailDto>('POST', `/api/students/${student.id}/status`, draft),
    onSuccess: async (s) => {
      qc.setQueryData(['student', student.id], s);
      await qc.invalidateQueries({ queryKey: ['students'] });
      toast.success(t('student.statusSaved'));
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = studentStatusSchema.safeParse(draft);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, draft));
    setErrors({});
    save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('student.changeStatus')}</DialogTitle>
          <DialogDescription>{student.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <Field id="st-status" label="student.status">
            <Select
              id="st-status"
              value={draft.status}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  status: e.target.value === 'graduated' ? 'graduated' : 'left',
                })
              }
            >
              <option value="left">{t('student.statuses.left')}</option>
              <option value="graduated">{t('student.statuses.graduated')}</option>
            </Select>
          </Field>
          <Field id="st-status-date" label="student.date" error={errors.date} required>
            <Input
              id="st-status-date"
              type="date"
              value={draft.date}
              onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            />
          </Field>
          <Field id="st-status-reason" label="student.reason" error={errors.reason} required>
            <Input
              id="st-status-reason"
              value={draft.reason}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            />
          </Field>
          <ErrorNote error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type EnrolmentAction = { kind: 'end' | 'transfer'; enrolment: EnrolmentDto };

/**
 * End an enrolment (withdrawn / completed) or transfer it to another group, through the existing
 * routes; a transfer marks the old row `transferred` and opens the new one in one batch.
 */
function EnrolmentDialog({
  action,
  studentId,
  onClose,
}: {
  action: EnrolmentAction;
  studentId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { kind, enrolment: e } = action;
  const current = useCurrentSession();
  const groups = (useGroups().data?.items ?? []).filter(
    (g) => g.status !== 'closed' && g.id !== e.grp_id && g.is_primary === e.is_primary,
  );
  groups.sort(
    (a, b) => Number(b.session_id === current?.id) - Number(a.session_id === current?.id),
  );
  const [draft, setDraft] = useState({
    status: 'withdrawn' as 'withdrawn' | 'completed',
    grp_id: '',
    date: todayIso(),
    reason: '',
  });
  const [newEnrolmentId] = useState(newId);
  const [errors, setErrors] = useState<FieldErrors>({});
  const body =
    kind === 'end'
      ? { status: draft.status, end_date: draft.date, reason: draft.reason }
      : { new_id: newEnrolmentId, grp_id: draft.grp_id, date: draft.date, reason: draft.reason };
  const save = useMutation({
    mutationFn: () => sendJson('POST', `/api/enrolments/${e.id}/${kind}`, body),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['student', studentId] }),
        qc.invalidateQueries({ queryKey: ['students'] }),
        qc.invalidateQueries({ queryKey: ['groups'] }),
      ]);
      toast.success(t(kind === 'end' ? 'enrolment.ended' : 'enrolment.moved'));
      onClose();
    },
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const parsed = (kind === 'end' ? enrolmentEndSchema : enrolmentTransferSchema).safeParse(body);
    if (!parsed.success) {
      // Field ids here are the draft's: end_date is shown as "date".
      const errs = issuesToErrors(parsed.error.issues, body);
      if (errs.end_date) errs.date = errs.end_date;
      return setErrors(errs);
    }
    setErrors({});
    save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(kind === 'end' ? 'enrolment.endTitle' : 'enrolment.transferTitle')}
          </DialogTitle>
          <DialogDescription>
            <bdi>{e.programme_name}</bdi> · <bdi>{e.grp_name}</bdi>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          {kind === 'end' ? (
            <Field id="enr-outcome" label="enrolment.outcome">
              <Select
                id="enr-outcome"
                value={draft.status}
                onChange={(ev) =>
                  setDraft({
                    ...draft,
                    status: ev.target.value === 'completed' ? 'completed' : 'withdrawn',
                  })
                }
              >
                <option value="withdrawn">{t('enrolment.statuses.withdrawn')}</option>
                <option value="completed">{t('enrolment.statuses.completed')}</option>
              </Select>
            </Field>
          ) : (
            <Field id="enr-group" label="enrolment.toGroup" error={errors.grp_id} required>
              <Select
                id="enr-group"
                value={draft.grp_id}
                onChange={(ev) => setDraft({ ...draft, grp_id: ev.target.value })}
              >
                <option value="">{t('admission.pickGroup')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {isolate(g.programme_name)} · {isolate(g.name)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field id="enr-date" label="enrolment.date" error={errors.date} required>
            <Input
              id="enr-date"
              type="date"
              value={draft.date}
              onChange={(ev) => setDraft({ ...draft, date: ev.target.value })}
            />
          </Field>
          <Field id="enr-reason" label="enrolment.reason" error={errors.reason} required>
            <Input
              id="enr-reason"
              value={draft.reason}
              onChange={(ev) => setDraft({ ...draft, reason: ev.target.value })}
            />
          </Field>
          <ErrorNote error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant={kind === 'end' ? 'destructive' : 'default'}
              disabled={save.isPending}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GuardianDialog({
  familyId,
  studentId,
  guardian,
  onClose,
}: {
  familyId: string;
  studentId: string;
  guardian: GuardianDto | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<GuardianDraft>(() =>
    guardian ? guardianDraftFrom(guardian) : emptyGuardian(),
  );
  const [newGuardianId] = useState(newId);
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: () => {
      const body = guardianInput(draft);
      // Never send a blank CNIC over a masked one the user could not see.
      if (guardian && !draft.cnic) delete body.cnic;
      return guardian
        ? sendJson('PATCH', `/api/guardians/${guardian.id}`, body)
        : sendJson('POST', '/api/guardians', { ...body, id: newGuardianId, family_id: familyId });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['student', studentId] });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = guardianInput(draft);
    const parsed = guardianFieldsSchema.safeParse(input);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, input));
    setErrors({});
    save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{guardian ? t('guardian.edit') : t('guardian.add')}</DialogTitle>
          <DialogDescription>{guardian?.name ?? ''}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <GuardianFieldset
            value={draft}
            onChange={setDraft}
            errors={errors}
            prefix=""
            idPrefix="gd"
          />
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b py-2.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end font-medium">{children}</dd>
    </div>
  );
}

type ProfileTab = 'overview' | 'guardians' | 'attendance' | 'fees' | 'messages';

const STATUS_TONE: Record<StudentDetailDto['status'], Tone> = {
  active: 'ok',
  left: 'neutral',
  graduated: 'info',
};

/** The family's messages (newest last), inside the caller's message scope. */
function FamilyMessages({ familyId }: { familyId: string }) {
  const { t, i18n } = useTranslation();
  const q = useQuery({
    queryKey: ['messages', 'family', familyId],
    queryFn: () => getJson<MessageListDto>(`/api/messages?family_id=${familyId}`),
  });
  const tone = (st: string): Tone =>
    st === 'queued' ? 'warn' : st === 'skipped' ? 'neutral' : st === 'failed' ? 'bad' : 'ok';
  return (
    <Panel
      title={t('screens.profile.messages')}
      action={<GoLink to="/messages">{t('screens.profile.openQueue')}</GoLink>}
    >
      {q.isPending ? (
        <ListSkeleton rows={3} />
      ) : q.error ? (
        <div className="p-4">
          <ErrorNote error={q.error} />
        </div>
      ) : !q.data?.items.length ? (
        <EmptyState icon={MessageSquareText} title={t('screens.profile.noMessages')} />
      ) : (
        <RowList>
          {q.data.items.map((m) => (
            <li key={m.id} className="flex flex-col gap-1 px-4 py-3" data-message={m.id}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {i18n.exists(`msg.templates.${m.template_key}`)
                    ? t(`msg.templates.${m.template_key}` as 'msg.templates.notice')
                    : m.template_key}
                </span>
                <StatusBadge tone={tone(m.status)}>
                  {i18n.exists(`msg.statuses.${m.status}`)
                    ? t(`msg.statuses.${m.status}` as 'msg.statuses.sent')
                    : m.status}
                </StatusBadge>
                <span className="ms-auto text-meta text-muted-foreground">
                  <DateText iso={m.created_at} />
                </span>
              </span>
              <p
                className="line-clamp-2 text-sm text-muted-foreground"
                dir={m.lang === 'ur' ? 'rtl' : 'ltr'}
                lang={m.lang}
              >
                {m.preview}
              </p>
            </li>
          ))}
        </RowList>
      )}
    </Panel>
  );
}

export function StudentDetail() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const qc = useQueryClient();
  const roles = useRoles();
  const navigate = useNavigate();
  const write = canWriteStudents(roles);
  const student = useStudent(id);
  const fields = useCustomFields().data?.items ?? [];
  const familyId = student.data?.family_id;
  const family = useQuery({
    queryKey: ['family', familyId],
    queryFn: () => getJson<FamilyDetailDto>(`/api/families/${familyId}`),
    enabled: !!familyId,
  });
  const seesAttendance = canReadAttendance(roles);
  const seesMoney = canReadMoney(roles);
  const seesMessages = canReadMessages(roles);
  const month = todayPk().slice(0, 7);
  const attendance = useStudentAttendance(id, month, seesAttendance);
  // Same key as the Fees tab's card: one request serves both.
  const fees = useQuery({
    queryKey: ['fee-student', id],
    queryFn: () => getJson<StudentFeesDto>(`/api/fees/student/${id}`),
    enabled: !!id && seesMoney,
  });
  const [tab, setTab] = useState<ProfileTab>('overview');
  const [statusOpen, setStatusOpen] = useState(false);
  const [enrolmentAction, setEnrolmentAction] = useState<EnrolmentAction | null>(null);
  const [guardianEdit, setGuardianEdit] = useState<GuardianDto | 'new' | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const uploadPhoto = useMutation({
    mutationFn: (blob: Blob) => uploadFile(`/api/students/${id}/photo`, blob, 'photo.jpg'),
    onSuccess: async () => {
      setPhoto(null);
      setPhotoVersion((v) => v + 1);
      setPhotoFailed(false);
      toast.success(t('student.photoSaved'));
      await qc.invalidateQueries({ queryKey: ['student', id] });
    },
  });

  if (student.isPending)
    return (
      <Page>
        <Panel>
          <ListSkeleton rows={4} />
        </Panel>
      </Page>
    );
  if (!student.data) return <p role="alert">{t('common.notFound')}</p>;
  const s = student.data;
  const siblings = (family.data?.students ?? []).filter((x) => x.id !== s.id);
  const current =
    s.enrolments.find((e) => e.status === 'active' && e.is_primary) ??
    s.enrolments.find((e) => e.status === 'active');
  const photoSrc =
    s.has_photo && !photoFailed ? `/api/students/${s.id}/photo?v=${photoVersion}` : null;
  const pct = attendance.data?.pct;
  const tabs: TabItem<ProfileTab>[] = [
    { value: 'overview', label: t('screens.profile.overview') },
    { value: 'guardians', label: t('student.guardians'), count: s.guardians.length },
    ...(seesAttendance ? [{ value: 'attendance' as const, label: t('attendance.title') }] : []),
    ...(seesMoney ? [{ value: 'fees' as const, label: t('screens.profile.fees') }] : []),
    ...(seesMessages ? [{ value: 'messages' as const, label: t('screens.profile.messages') }] : []),
  ];
  const shown = tabs.some((x) => x.value === tab) ? tab : 'overview';
  const menu: RowAction[] = write
    ? [
        {
          id: 'student-edit',
          label: t('student.edit'),
          icon: Pencil,
          onSelect: () => navigate(`/students/${s.id}/edit`),
        },
        s.status === 'active'
          ? {
              id: 'student-status',
              label: t('student.changeStatus'),
              icon: UserX,
              destructive: true,
              onSelect: () => setStatusOpen(true),
            }
          : {
              id: 'student-readmit',
              label: t('student.readmit'),
              icon: Plus,
              onSelect: () => navigate(`/students/new?readmit=${s.id}`),
            },
      ]
    : [];

  return (
    <Page>
      <header className="flex flex-col gap-3">
        <Link
          to="/students"
          className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden />
          {t('nav.students')}
        </Link>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-64 items-center gap-4">
            {photoSrc ? (
              <img
                id="student-photo-img"
                src={photoSrc}
                alt={t('student.photo')}
                className="size-16 shrink-0 rounded-xl object-cover"
                onError={() => setPhotoFailed(true)}
              />
            ) : (
              // No photo (or it did not load): the child's initials, never an empty box.
              <Avatar
                id="student-avatar"
                name={s.name}
                size="xl"
                className="size-16 text-xl"
                square
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-title">
                <bdi>{s.name}</bdi>
              </h1>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <Num>{s.admission_no}</Num>
                {current && (
                  <>
                    <span aria-hidden>·</span>
                    <bdi>{`${current.programme_name} ${current.grp_name}`}</bdi>
                  </>
                )}
                <StatusBadge tone={STATUS_TONE[s.status]}>
                  {t(`student.statuses.${s.status}`)}
                </StatusBadge>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 max-sm:w-full max-sm:[&>a]:flex-1">
            {canCollect(roles) && (
              <Button asChild>
                <Link to={`/fees/counter?family=${s.family_id}`} id="student-collect">
                  <Wallet aria-hidden />
                  {t('screens.profile.collect')}
                </Link>
              </Button>
            )}
            {s.status !== 'active' && write && (
              <Button asChild variant="outline">
                <Link to={`/students/new?readmit=${s.id}`}>{t('student.readmit')}</Link>
              </Button>
            )}
            <RowMenu
              id="student-more"
              actions={menu}
              label={t('screens.profile.more', { name: s.name })}
            />
          </div>
        </div>
      </header>

      <StatStrip
        items={[
          {
            id: 'sum-class',
            label: t('screens.profile.class'),
            value: current ? <bdi>{`${current.programme_name} ${current.grp_name}`}</bdi> : '—',
            note: current?.roll_no ? (
              <>
                {t('group.rollNo')} <Num>{current.roll_no}</Num>
              </>
            ) : undefined,
          },
          ...(seesAttendance
            ? [
                {
                  id: 'sum-attendance',
                  label: t('screens.profile.attendance'),
                  value: pct != null ? <Num>{`${pct}%`}</Num> : '—',
                  note: <DateText iso={month} kind="month" />,
                },
              ]
            : []),
          ...(seesMoney
            ? [
                {
                  id: 'sum-dues',
                  label: t('screens.profile.dues'),
                  value: fees.data ? <Mny paisa={fees.data.due} /> : '—',
                  note: fees.data ? (
                    <>
                      {t('screens.profile.familyOwes')} <Mny paisa={fees.data.family_due} />
                    </>
                  ) : undefined,
                },
              ]
            : []),
          {
            id: 'sum-admitted',
            label: t('student.admissionDate'),
            value: <DateText iso={s.admission_date} />,
            note: t('screens.profile.siblings', { count: siblings.length }),
          },
        ]}
      />

      <div className="flex flex-col gap-4">
        <Tabs
          label={t('screens.profile.sections')}
          idBase="profile"
          value={shown}
          items={tabs}
          onChange={setTab}
        />
        <TabPanel idBase="profile" value={shown} className="flex flex-col gap-4">
          {shown === 'overview' && (
            <>
              <Panel
                title={t('screens.profile.details')}
                bodyClassName="flex flex-col gap-4 p-4 sm:flex-row"
              >
                {write && (
                  <div className="flex flex-col items-start gap-2 sm:w-44">
                    <PhotoPicker onChange={setPhoto} />
                    {photo && (
                      <Button
                        size="sm"
                        disabled={uploadPhoto.isPending}
                        onClick={() => uploadPhoto.mutate(photo)}
                      >
                        {t('student.uploadPhoto')}
                      </Button>
                    )}
                    <ErrorNote error={uploadPhoto.error} />
                  </div>
                )}
                <dl className="flex-1 text-sm">
                  {s.left_date && (
                    <Row label={t('student.date')}>
                      <Num>{s.left_date}</Num> {s.left_reason && `· ${s.left_reason}`}
                    </Row>
                  )}
                  {s.father_name && (
                    <Row label={t('student.fatherName')}>
                      <bdi>{s.father_name}</bdi>
                    </Row>
                  )}
                  {s.gender && (
                    <Row label={t('student.gender')}>{t(`student.genders.${s.gender}`)}</Row>
                  )}
                  {s.dob && (
                    <Row label={t('student.dob')}>
                      <Num>{s.dob}</Num>
                    </Row>
                  )}
                  {s.b_form_no && (
                    <Row label={t('student.bForm')}>
                      <Num>{s.b_form_no}</Num>
                    </Row>
                  )}
                  <Row label={t('student.admissionDate')}>
                    <Num>{s.admission_date}</Num>
                  </Row>
                  <Row label={t('student.family')}>
                    <bdi>{s.family.name}</bdi>
                  </Row>
                  {fields.map((f) => {
                    const v = s.extra[f.key];
                    if (v == null || v === '') return null;
                    const label = i18n.language === 'ur' && f.label_ur ? f.label_ur : f.label_en;
                    return (
                      <Row key={f.key} label={label}>
                        {typeof v === 'boolean' ? (
                          v ? (
                            t('common.yes')
                          ) : (
                            t('common.no')
                          )
                        ) : (
                          <bdi>{v}</bdi>
                        )}
                      </Row>
                    );
                  })}
                </dl>
              </Panel>

              <Panel title={t('student.enrolments')}>
                {s.enrolments.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">{t('enrolment.empty')}</p>
                ) : (
                  <RowList>
                    {s.enrolments.map((e) => (
                      <li key={e.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <Link
                              to={`/groups/${e.grp_id}`}
                              className="inline-flex min-h-11 items-center font-medium hover:underline"
                            >
                              <bdi>{`${e.programme_name} ${e.grp_name}`}</bdi>
                            </Link>
                            <StatusBadge tone={e.status === 'active' ? 'ok' : 'neutral'}>
                              {t(`enrolment.statuses.${e.status}`)}
                            </StatusBadge>
                            {!e.is_primary && (
                              <StatusBadge tone="info">{t('group.batchBadge')}</StatusBadge>
                            )}
                          </span>
                          <span className="text-muted-foreground">
                            <Num>
                              {e.start_date}
                              {e.end_date ? ` → ${e.end_date}` : ''}
                            </Num>
                            {e.roll_no && (
                              <>
                                {' · '}
                                {t('group.rollNo')} <Num>{e.roll_no}</Num>
                              </>
                            )}
                            {e.end_reason && (
                              <>
                                {' · '}
                                <bdi>{e.end_reason}</bdi>
                              </>
                            )}
                          </span>
                        </span>
                        {write && e.status === 'active' && s.status === 'active' && (
                          <RowMenu
                            label={t('screens.profile.more', {
                              name: `${e.programme_name} ${e.grp_name}`,
                            })}
                            actions={[
                              {
                                id: `transfer-${e.id}`,
                                label: t('enrolment.transferAction'),
                                icon: ArrowLeftRight,
                                onSelect: () =>
                                  setEnrolmentAction({ kind: 'transfer', enrolment: e }),
                              },
                              {
                                id: `end-${e.id}`,
                                label: t('enrolment.endAction'),
                                icon: CircleStop,
                                destructive: true,
                                onSelect: () => setEnrolmentAction({ kind: 'end', enrolment: e }),
                              },
                            ]}
                          />
                        )}
                      </li>
                    ))}
                  </RowList>
                )}
              </Panel>

              <Panel
                title={t('student.siblings')}
                action={
                  write && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/students/new?family=${s.family_id}`}>
                        <Plus aria-hidden />
                        {t('admission.admitSibling')}
                      </Link>
                    </Button>
                  )
                }
              >
                {siblings.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    {t('screens.profile.noSiblings')}
                  </p>
                ) : (
                  <RowList>
                    {siblings.map((x) => (
                      <ListRow
                        key={x.id}
                        to={`/students/${x.id}`}
                        leading={<Avatar name={x.name} size="sm" />}
                        title={<bdi>{x.name}</bdi>}
                        trailing={
                          <span className="text-sm text-muted-foreground">
                            <Num>{x.admission_no}</Num>
                          </span>
                        }
                      />
                    ))}
                  </RowList>
                )}
              </Panel>
            </>
          )}

          {shown === 'guardians' && (
            <Panel
              title={t('student.guardians')}
              action={
                write && (
                  <Button size="sm" variant="outline" onClick={() => setGuardianEdit('new')}>
                    <Plus aria-hidden />
                    {t('guardian.add')}
                  </Button>
                )
              }
            >
              {s.guardians.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {t('screens.profile.noGuardians')}
                </p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {s.guardians.map((g) => (
                    <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <Avatar name={g.name} size="md" tone="muted" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium">
                          <bdi>{g.name}</bdi>
                          {g.relation && (
                            <span className="font-normal text-muted-foreground">
                              {' · '}
                              <bdi>{g.relation}</bdi>
                            </span>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-2 text-sm">
                          {g.phone && (
                            <a
                              href={`tel:+${g.phone}`}
                              className="inline-flex min-h-11 items-center text-brand underline-offset-4 hover:underline"
                            >
                              <Num>{formatPkPhone(g.phone)}</Num>
                            </a>
                          )}
                          {g.consent_whatsapp && <StatusBadge tone="ok">WhatsApp</StatusBadge>}
                        </span>
                      </div>
                      {write && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t('guardian.edit')}
                          onClick={() => setGuardianEdit(g)}
                        >
                          <Pencil aria-hidden />
                        </Button>
                      )}
                      {write && (
                        <div className="w-full">
                          <ParentLinkPanel guardian={g} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {shown === 'attendance' && <StudentAttendanceCard studentId={s.id} />}
          {shown === 'fees' && <StudentFeesCard studentId={s.id} studentName={s.name} />}
          {shown === 'messages' && <FamilyMessages familyId={s.family_id} />}
        </TabPanel>
      </div>

      {statusOpen && <StatusDialog student={s} onClose={() => setStatusOpen(false)} />}
      {enrolmentAction && (
        <EnrolmentDialog
          action={enrolmentAction}
          studentId={s.id}
          onClose={() => setEnrolmentAction(null)}
        />
      )}
      {guardianEdit && (
        <GuardianDialog
          familyId={s.family_id}
          studentId={s.id}
          guardian={guardianEdit === 'new' ? null : guardianEdit}
          onClose={() => setGuardianEdit(null)}
        />
      )}
    </Page>
  );
}
