import {
  type EnrolmentDto,
  enrolmentEndSchema,
  enrolmentTransferSchema,
  type FamilyDetailDto,
  formatPkPhone,
  type GuardianDto,
  guardianFieldsSchema,
  newId,
  type StudentDetailDto,
  studentStatusSchema,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, UserRound } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { canReadAttendance } from '@/lib/attendance';
import { type FieldErrors, issuesToErrors, todayIso } from '@/lib/form';
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
    <div className="flex justify-between gap-3 border-b py-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  );
}

export function StudentDetail() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const qc = useQueryClient();
  const roles = useRoles();
  const write = canWriteStudents(roles);
  const student = useStudent(id);
  const fields = useCustomFields().data?.items ?? [];
  const familyId = student.data?.family_id;
  const family = useQuery({
    queryKey: ['family', familyId],
    queryFn: () => getJson<FamilyDetailDto>(`/api/families/${familyId}`),
    enabled: !!familyId,
  });
  const [statusOpen, setStatusOpen] = useState(false);
  const [enrolmentAction, setEnrolmentAction] = useState<EnrolmentAction | null>(null);
  const [guardianEdit, setGuardianEdit] = useState<GuardianDto | 'new' | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const uploadPhoto = useMutation({
    mutationFn: (blob: Blob) => uploadFile(`/api/students/${id}/photo`, blob, 'photo.jpg'),
    onSuccess: async () => {
      setPhoto(null);
      setPhotoVersion((v) => v + 1);
      toast.success(t('student.photoSaved'));
      await qc.invalidateQueries({ queryKey: ['student', id] });
    },
  });

  if (student.isPending) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  if (!student.data) return <p role="alert">{t('common.notFound')}</p>;
  const s = student.data;
  const siblings = (family.data?.students ?? []).filter((x) => x.id !== s.id);

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle
        actions={
          write && (
            <>
              <Button asChild variant="outline" size="sm">
                <Link to={`/students/${s.id}/edit`}>
                  <Pencil aria-hidden />
                  {t('student.edit')}
                </Link>
              </Button>
              {s.status === 'active' ? (
                <Button variant="outline" size="sm" onClick={() => setStatusOpen(true)}>
                  {t('student.changeStatus')}
                </Button>
              ) : (
                <Button asChild size="sm">
                  <Link to={`/students/new?readmit=${s.id}`}>{t('student.readmit')}</Link>
                </Button>
              )}
            </>
          )
        }
      >
        {s.name}
      </PageTitle>

      <Card className="gap-4 py-4">
        <CardContent className="flex flex-col gap-4 px-4 sm:flex-row">
          <div className="flex flex-col items-center gap-2">
            {s.has_photo ? (
              <img
                src={`/api/students/${s.id}/photo?v=${photoVersion}`}
                alt={t('student.photo')}
                className="size-28 rounded-md object-cover"
              />
            ) : (
              <UserRound className="size-28 rounded-md bg-muted p-6" aria-hidden />
            )}
            {write && (
              <>
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
              </>
            )}
          </div>
          <dl className="flex-1 text-sm">
            <Row label={t('student.admissionNo')}>
              <Num>{s.admission_no}</Num>
            </Row>
            <Row label={t('student.status')}>
              <Badge variant={s.status === 'active' ? 'secondary' : 'outline'}>
                {t(`student.statuses.${s.status}`)}
              </Badge>
            </Row>
            {s.left_date && (
              <Row label={t('student.date')}>
                <Num>{s.left_date}</Num> {s.left_reason && `· ${s.left_reason}`}
              </Row>
            )}
            {s.father_name && <Row label={t('student.fatherName')}>{s.father_name}</Row>}
            {s.gender && <Row label={t('student.gender')}>{t(`student.genders.${s.gender}`)}</Row>}
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
                  {typeof v === 'boolean' ? v ? t('common.yes') : t('common.no') : <bdi>{v}</bdi>}
                </Row>
              );
            })}
          </dl>
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="flex items-center px-4">
          <CardTitle>{t('student.guardians')}</CardTitle>
          {write && (
            <Button
              size="sm"
              variant="outline"
              className="ms-auto"
              onClick={() => setGuardianEdit('new')}
            >
              <Plus aria-hidden />
              {t('guardian.add')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="px-4">
          <ul className="flex flex-col divide-y">
            {s.guardians.map((g) => (
              <li key={g.id} className="flex items-center gap-3 py-2">
                <div className="flex flex-1 flex-col">
                  <span className="font-medium">
                    <bdi>{g.name}</bdi>
                    {g.relation && (
                      <span className="text-muted-foreground">
                        {' · '}
                        <bdi>{g.relation}</bdi>
                      </span>
                    )}
                  </span>
                  <span className="text-sm">
                    {g.phone && (
                      <a
                        href={`tel:+${g.phone}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        <Num>{formatPkPhone(g.phone)}</Num>
                      </a>
                    )}
                    {g.consent_whatsapp && (
                      <Badge variant="outline" className="ms-2">
                        WhatsApp
                      </Badge>
                    )}
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
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('student.enrolments')}</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {s.enrolments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('enrolment.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {s.enrolments.map((e) => (
                <li key={e.id} className="flex flex-col gap-1 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/groups/${e.grp_id}`} className="font-medium hover:underline">
                      <bdi>{e.programme_name}</bdi> · <bdi>{e.grp_name}</bdi>
                    </Link>
                    <Badge variant={e.status === 'active' ? 'secondary' : 'outline'}>
                      {t(`enrolment.statuses.${e.status}`)}
                    </Badge>
                    {!e.is_primary && <Badge variant="outline">{t('group.batchBadge')}</Badge>}
                    {write && e.status === 'active' && s.status === 'active' && (
                      <span className="ms-auto flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEnrolmentAction({ kind: 'transfer', enrolment: e })}
                        >
                          {t('enrolment.transferAction')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEnrolmentAction({ kind: 'end', enrolment: e })}
                        >
                          {t('enrolment.endAction')}
                        </Button>
                      </span>
                    )}
                  </div>
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
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="flex items-center px-4">
          <CardTitle>{t('student.siblings')}</CardTitle>
          {write && (
            <Button asChild size="sm" variant="outline" className="ms-auto">
              <Link to={`/students/new?family=${s.family_id}`}>
                <Plus aria-hidden />
                {t('admission.admitSibling')}
              </Link>
            </Button>
          )}
        </CardHeader>
        <CardContent className="px-4">
          {siblings.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {siblings.map((x) => (
                <li key={x.id}>
                  <Link
                    to={`/students/${x.id}`}
                    className="flex min-h-11 items-center gap-2 hover:underline"
                  >
                    <bdi>{x.name}</bdi>
                    <span className="ms-auto text-sm text-muted-foreground">
                      <Num>{x.admission_no}</Num>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canReadAttendance(roles) && <StudentAttendanceCard studentId={s.id} />}

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
    </section>
  );
}
