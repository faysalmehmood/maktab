import {
  type AttendanceSubmission,
  type AttendanceSyncResult,
  MAX_MARKS_PER_REGISTER,
  type MarkCounts,
  type MarkStatus,
  newId,
  type RegisterResponse,
} from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CloudOff, History, MessageSquareText, PencilLine, StickyNote } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { todayPk } from '@/components/attendance/common';
import { Counts, DayOffNote, MarkBar, StatusChip } from '@/components/attendance/parts';
import { Avatar } from '@/components/avatar';
import { DateText } from '@/components/date-text';
import { ErrorNote, Num, useErrorText } from '@/components/form';
import { ListSkeleton, Page, PageHeader, Panel, StatusBadge } from '@/components/page';
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
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { sendJson } from '@/lib/api';
import {
  canCorrect,
  canReadMessages,
  nextStatus,
  timeOf,
  useRegister,
  useRejectionText,
} from '@/lib/attendance';
import { useOnline } from '@/lib/media';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { onAnswer, type SaveOutcome, saveRegister, useOutboxStatus } from '@/offline/sync';

/** A quiet tint on rows that are not present, so the exceptions stand out on a long roster. */
const ROW_TINT: Record<MarkStatus, string> = {
  P: '',
  A: 'bg-bad-soft/70',
  L: 'bg-warn-soft/70',
  E: 'bg-info-soft/70',
};

type Draft = Record<string, { status: MarkStatus; note: string }>;

/** Everyone present by default; a register already taken opens with its current marks. */
const draftFrom = (r: RegisterResponse): Draft =>
  Object.fromEntries(
    r.rows.map((x) => [x.student_id, { status: x.status ?? 'P', note: x.note ?? '' }]),
  );

function tally(d: Draft): MarkCounts {
  const c: MarkCounts = { P: 0, A: 0, L: 0, E: 0 };
  for (const v of Object.values(d)) c[v.status]++;
  return c;
}

function StudentAvatar({ id, name, hasPhoto }: { id: string; name: string; hasPhoto: boolean }) {
  return (
    <Avatar
      name={name}
      size="lg"
      tone="muted"
      src={hasPhoto ? `/api/students/${id}/photo` : null}
    />
  );
}

/** Office correction: same marks, plus a mandatory reason (PLAN §14.3; audit keeps it). */
export function CorrectionDialog({
  onSubmit,
  onClose,
  pending,
  error,
}: {
  onSubmit: (reason: string) => void;
  onClose: () => void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setMissing(true);
    onSubmit(reason.trim());
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('attendance.correct')}</DialogTitle>
          <DialogDescription>{t('attendance.reasonHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <Label htmlFor="correction-reason">{t('attendance.reason')}</Label>
          <Textarea
            id="correction-reason"
            value={reason}
            aria-invalid={missing || undefined}
            onChange={(e) => {
              setReason(e.target.value);
              setMissing(false);
            }}
          />
          {missing && (
            <p role="alert" className="text-xs text-destructive">
              {t('errors.required')}
            </p>
          )}
          <ErrorNote error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HistorySheet({ r, onClose }: { r: RegisterResponse; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="end" className="w-80 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('attendance.history')}</SheetTitle>
          <SheetDescription>
            <Num>{r.date}</Num>
          </SheetDescription>
        </SheetHeader>
        {r.history.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">{t('attendance.historyEmpty')}</p>
        ) : (
          <ol className="flex flex-col divide-y px-4">
            {r.history.map((h) => (
              <li key={h.register_id} className="flex flex-col gap-1 py-3 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <bdi className="font-medium">{h.taken_by_name ?? '—'}</bdi>
                  <Num>{timeOf(h.taken_at)}</Num>
                  {h.is_current && <StatusBadge tone="ok">{t('attendance.current')}</StatusBadge>}
                  {h.kind === 'correct' && (
                    <StatusBadge tone="info">{t('attendance.correction')}</StatusBadge>
                  )}
                </span>
                {h.reason && (
                  <span className="text-muted-foreground">
                    <bdi>{h.reason}</bdi>
                  </span>
                )}
                <Counts counts={h.counts} />
                <MarkBar counts={h.counts} className="h-1.5" />
              </li>
            ))}
          </ol>
        )}
      </SheetContent>
    </Sheet>
  );
}

function NoteSheet({
  name,
  note,
  onSave,
  onClose,
}: {
  name: string;
  note: string;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(note);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>{t('attendance.noteFor', { name })}</SheetTitle>
          <SheetDescription className="sr-only">{t('attendance.note')}</SheetDescription>
        </SheetHeader>
        <form
          className="flex flex-col gap-3 px-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(value.trim());
          }}
        >
          <Input
            aria-label={t('attendance.note')}
            maxLength={200}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <Button type="submit">{t('common.done')}</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

type Saved =
  | { kind: 'answered'; result: AttendanceSyncResult }
  | { kind: 'offline'; clientId: string }
  | { kind: 'paused'; clientId: string };

export function RegisterPage() {
  const { t } = useTranslation();
  const online = useOnline();
  const errorText = useErrorText();
  const { grpId } = useParams();
  const [params] = useSearchParams();
  const date = params.get('date') ?? todayPk();
  const subject = params.get('subject') ?? '';
  const roles = useRoles();
  const qc = useQueryClient();
  const reg = useRegister(grpId, date, subject);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [saving, setSaving] = useState(false);
  const outbox = useOutboxStatus();
  const rejection = useRejectionText();
  // One submission (one client_id, one taken_at) per draft: a double tap, or Save pressed again
  // after "saved on this phone", re-sends the same register instead of creating a second one.
  // Any edit to the draft starts a new one.
  const pending = useRef<AttendanceSubmission | null>(null);
  const busy = useRef(false);
  const edit = (fn: (d: Draft | null) => Draft | null) => {
    pending.current = null;
    setDraft(fn);
  };

  // A different register (or a refetch after saving) starts a fresh draft.
  const loadedFor = reg.data
    ? `${reg.data.grp_id}|${date}|${subject}|${reg.data.current?.register_id ?? ''}`
    : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the register changes
  useEffect(() => {
    pending.current = null;
    if (reg.data) setDraft(draftFrom(reg.data));
  }, [loadedFor]);

  const counts = useMemo(() => (draft ? tally(draft) : null), [draft]);
  const office = canCorrect(roles);

  const submission = (): AttendanceSubmission | null => {
    if (!reg.data || !draft) return null;
    return {
      client_id: newId(),
      grp_id: reg.data.grp_id,
      date,
      grp_subject_id: subject,
      taken_at: new Date().toISOString(),
      marks: reg.data.rows.map((r) => {
        const d = draft[r.student_id];
        return { student_id: r.student_id, status: d?.status ?? 'P', note: d?.note || null };
      }),
    };
  };

  const refresh = () => qc.invalidateQueries({ queryKey: ['attendance'] });

  const answered = async (r: AttendanceSyncResult) => {
    setSaved({ kind: 'answered', result: r });
    if (r.status === 'rejected') {
      toast.error(rejection(r.error, date));
      return;
    }
    if (r.status === 'stale') toast.warning(t('attendance.stale'));
    else
      toast.success(t(r.status === 'replaced' ? 'attendance.savedReplaced' : 'attendance.saved'));
    await refresh();
  };

  const handle = async (out: SaveOutcome, clientId: string) => {
    if (out.kind === 'queued') {
      setSaved({ kind: 'offline', clientId });
      toast.info(t('attendance.savedOffline'));
    } else if (out.kind === 'paused') {
      setSaved({ kind: 'paused', clientId });
      toast.warning(t('attendance.signInAgain'));
    } else await answered(out.result);
  };

  // Saved on this phone: when a later sync (online event, timer, another screen) gets the
  // server's answer for this register, the "will be sent" note gives way to that answer.
  const waitingFor = saved && saved.kind !== 'answered' ? saved.clientId : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answered` is recreated every render
  useEffect(() => {
    if (!waitingFor) return;
    return onAnswer((r) => {
      if (r.client_id === waitingFor) void answered(r);
    });
  }, [waitingFor]);

  // A plain async call, not a react-query mutation: mutations pause while the browser reports
  // offline (networkMode 'online'), and an offline save must still reach the outbox.
  const save = async () => {
    if (busy.current) return;
    const sub = pending.current ?? submission();
    if (!sub || !reg.data) return;
    pending.current = sub;
    busy.current = true;
    setSaving(true);
    try {
      const label = `${reg.data.programme_name} ${reg.data.grp_name}`.trim();
      await handle(await saveRegister(sub, { label }), sub.client_id);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const correct = useMutation({
    mutationFn: (reason: string) => {
      const sub = submission();
      if (!sub) throw new Error('not loaded');
      const { taken_at: _ignored, ...rest } = sub;
      return sendJson<AttendanceSyncResult>('POST', '/api/attendance/correct', { ...rest, reason });
    },
    onSuccess: async (result) => {
      setCorrecting(false);
      setSaved({ kind: 'answered', result });
      toast.success(t('attendance.corrected'));
      await refresh();
    },
  });

  if (reg.isPending)
    return (
      <Page width="form">
        <Panel>
          <ListSkeleton rows={6} />
        </Panel>
      </Page>
    );
  if (!reg.data || !draft || !counts)
    return <ErrorNote error={reg.error ?? new Error('not_found')} />;
  const r = reg.data;
  // Office users editing a register that already exists make a correction (with reason).
  const isCorrection = office && !!r.current;
  const closed = !!r.day_off;
  // One register holds at most 200 marks (the per-request budget); bigger groups must be split.
  const tooBig = r.rows.length > MAX_MARKS_PER_REGISTER;
  const queued = saved?.kind === 'answered' ? (saved.result.queued_messages ?? 0) : 0;

  const cycle = (id: string) =>
    edit((d) => {
      const cur = d?.[id];
      return d && cur ? { ...d, [id]: { ...cur, status: nextStatus(cur.status) } } : d;
    });

  const noteStudent = noteFor ? r.rows.find((x) => x.student_id === noteFor) : undefined;

  const back = office && date !== todayPk() ? `/attendance?date=${date}` : '/attendance';
  const total = r.rows.length;

  return (
    <Page width="form" className="pb-28 md:pb-0">
      <PageHeader
        back={{ to: back, label: t('attendance.title') }}
        title={<bdi>{`${r.programme_name} ${r.grp_name}`}</bdi>}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <DateText iso={date} kind="long" />
            {r.current ? (
              <StatusBadge tone="ok">
                <span>
                  {t('attendance.taken')} · <bdi>{r.current.taken_by_name ?? ''}</bdi>{' '}
                  <Num>{timeOf(r.current.taken_at)}</Num>
                </span>
              </StatusBadge>
            ) : (
              <StatusBadge tone="warn">{t('attendance.notTaken')}</StatusBadge>
            )}
          </span>
        }
        actions={
          <Button variant="outline" onClick={() => setHistoryOpen(true)}>
            <History aria-hidden />
            {t('attendance.history')}
            {r.history.length > 0 && <Num>({r.history.length})</Num>}
          </Button>
        }
      />
      <DayOffNote dayOff={r.day_off} />

      {total > 0 && (
        <Panel bodyClassName="flex flex-col gap-2 p-4">
          <p id="register-progress" className="text-section font-semibold" aria-live="polite">
            {t('screens.att.marked', { present: counts.P, total })}
          </p>
          <MarkBar counts={counts} />
        </Panel>
      )}

      {isCorrection && !closed && (
        <p
          id="correction-mode"
          className="flex items-start gap-2 rounded-lg bg-info-soft p-3 text-sm text-info"
        >
          <PencilLine className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('screens.att.correctionMode')}
        </p>
      )}
      {saved?.kind === 'offline' && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg bg-warn-soft p-3 text-sm text-warn"
        >
          <CloudOff className="size-4 shrink-0" aria-hidden />
          {t('attendance.savedOffline')}
        </p>
      )}
      {saved?.kind === 'paused' && (
        <p role="alert" className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
          {t('attendance.signInAgain')}{' '}
          <Link to="/login" className="font-semibold underline">
            {t('attendance.signIn')}
          </Link>
        </p>
      )}
      {saved?.kind === 'answered' && saved.result.status === 'rejected' && (
        <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
          {rejection(saved.result.error, date)}
        </p>
      )}
      {outbox.pending > 0 && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <CloudOff className="size-4 shrink-0" aria-hidden />
          {t('attendance.waitingHere', { count: outbox.pending })}
        </p>
      )}
      {tooBig && (
        <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
          {t('attendance.rosterTooBig', { n: r.rows.length, max: MAX_MARKS_PER_REGISTER })}
        </p>
      )}
      {queued > 0 && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-3 text-sm"
        >
          <MessageSquareText className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">{t('attendance.queued', { count: queued })}</span>
          {canReadMessages(roles) && (
            <Button asChild size="sm" variant="outline">
              <Link to="/messages">{t('attendance.openQueue')}</Link>
            </Button>
          )}
        </p>
      )}

      {!closed && <p className="text-sm text-muted-foreground">{t('attendance.tapHint')}</p>}

      <Panel>
        <ul className="flex flex-col divide-y">
          {r.rows.map((row) => {
            const d = draft[row.student_id];
            if (!d) return null;
            return (
              <li
                key={row.student_id}
                data-status={d.status}
                className={cn(
                  'flex items-center gap-1 pe-2 first:rounded-t-xl last:rounded-b-xl',
                  ROW_TINT[d.status],
                )}
              >
                <button
                  type="button"
                  disabled={closed}
                  onClick={() => cycle(row.student_id)}
                  aria-label={`${row.name}: ${t(`attendance.status.${d.status}`)}`}
                  className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-[inherit] ps-3 text-start hover:bg-accent/60 disabled:opacity-60"
                >
                  <StudentAvatar id={row.student_id} name={row.name} hasPhoto={row.has_photo} />
                  <span className="w-7 shrink-0 text-center text-sm text-muted-foreground">
                    <Num>{row.roll_no ?? '—'}</Num>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <bdi className="truncate font-medium">{row.name}</bdi>
                    {d.note && (
                      <bdi className="truncate text-xs text-muted-foreground">{d.note}</bdi>
                    )}
                  </span>
                  <StatusChip status={d.status} solid className="size-12" />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={closed}
                  aria-label={t('attendance.noteFor', { name: row.name })}
                  onClick={() => setNoteFor(row.student_id)}
                >
                  <StickyNote aria-hidden className={cn(d.note && 'text-brand')} />
                </Button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <div
        data-action-bar
        style={{ bottom: 'var(--tabbar-h, 0px)' }}
        className="fixed inset-x-0 z-10 border-t bg-card/95 p-3 backdrop-blur md:sticky md:rounded-xl md:border md:shadow-sm"
      >
        <div className="mx-auto flex max-w-[680px] flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex min-w-0 flex-col gap-1">
            <span className="sr-only">{t('screens.att.marksLabel')}</span>
            <Counts counts={counts} />
            {!online && (
              <span className="flex items-center gap-1 text-meta text-warn">
                <CloudOff className="size-3.5 shrink-0" aria-hidden />
                {t('attendance.offline')}
              </span>
            )}
          </span>
          <Button
            size="lg"
            className="ms-auto min-w-40"
            disabled={closed || tooBig || saving || correct.isPending || r.rows.length === 0}
            onClick={() => (isCorrection ? setCorrecting(true) : void save())}
          >
            {saving
              ? t('common.saving')
              : isCorrection
                ? t('attendance.correct')
                : t('attendance.save')}
          </Button>
        </div>
      </div>

      {noteStudent && (
        <NoteSheet
          name={noteStudent.name}
          note={draft[noteStudent.student_id]?.note ?? ''}
          onClose={() => setNoteFor(null)}
          onSave={(note) => {
            edit((d) => {
              const cur = d?.[noteStudent.student_id];
              return d && cur ? { ...d, [noteStudent.student_id]: { ...cur, note } } : d;
            });
            setNoteFor(null);
          }}
        />
      )}
      {historyOpen && <HistorySheet r={r} onClose={() => setHistoryOpen(false)} />}
      {correcting && (
        <CorrectionDialog
          pending={correct.isPending}
          error={correct.error}
          onClose={() => setCorrecting(false)}
          onSubmit={(reason) => correct.mutate(reason)}
        />
      )}
    </Page>
  );
}
