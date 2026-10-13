import { type AlarmDto, type BackupRunDto, formatDmy } from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, TriangleAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field, Num } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { sendJson } from '@/lib/api';
import {
  alarmHint,
  buildExport,
  type ExportProgress,
  saveFile,
  useAlarms,
  useBackupStatus,
} from '@/lib/backup';
import { karachiToday } from '@/lib/fees';

const H = ({ children }: { children: ReactNode }) => (
  <h3 className="text-base font-semibold">{children}</h3>
);

const kb = (n: number | null) => (n == null ? '—' : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string | null) =>
  iso ? `${formatDmy(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC` : '—';

function StatusBadge({ status }: { status: BackupRunDto['status'] }) {
  const { t } = useTranslation();
  const variant = status === 'ok' ? 'default' : status === 'partial' ? 'secondary' : 'destructive';
  return <Badge variant={variant}>{t(`backup.status.statuses.${status}`)}</Badge>;
}

function NightlyStatus() {
  const { t } = useTranslation();
  const q = useBackupStatus();
  const s = q.data;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!s) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  const last = s.last_nightly;
  return (
    <div className="flex flex-col gap-3" id="backup-status">
      <H>{t('backup.status.title')}</H>
      {!s.report_configured && (
        <p className="rounded-md bg-warn-soft0/10 p-3 text-sm">
          {t('backup.status.notConfigured')}
        </p>
      )}
      {last ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('backup.status.lastRun')}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <StatusBadge status={last.status} />
            <Num>{when(last.finished_at)}</Num>
          </dd>
          <dt className="text-muted-foreground">{t('backup.status.size')}</dt>
          <dd>
            <Num>{kb(last.bytes)}</Num>
          </dd>
          <dt className="text-muted-foreground">{t('backup.status.targets')}</dt>
          <dd className="flex flex-wrap gap-1">
            {last.targets.map((x) => (
              <Badge key={x.name} variant={x.ok ? 'outline' : 'destructive'} title={x.detail}>
                <bdi>
                  {x.name} {x.ok ? '✓' : '✗'}
                </bdi>
              </Badge>
            ))}
          </dd>
          {last.object_key && (
            <>
              <dt className="text-muted-foreground">{t('backup.status.file')}</dt>
              <dd className="break-all">
                <Num>{last.object_key}</Num>
              </dd>
            </>
          )}
          {last.run_url && (
            <>
              <dt className="sr-only">{t('backup.status.viewRun')}</dt>
              <dd className="col-span-2">
                <a
                  href={last.run_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center underline"
                >
                  {t('backup.status.viewRun')}
                </a>
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{t('backup.status.never')}</p>
      )}
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium">{t('backup.status.objects')}</p>
        {s.objects === null ? (
          <p className="text-muted-foreground">{s.objects_error ?? t('backup.status.noBucket')}</p>
        ) : s.objects.length === 0 ? (
          <p className="text-muted-foreground">{t('backup.status.noObjects')}</p>
        ) : (
          <ul className="flex flex-col divide-y" id="backup-objects">
            {s.objects.map((o) => (
              <li key={o.key} className="flex flex-wrap items-center gap-2 py-1">
                <Num>{o.key}</Num>
                <span className="ms-auto text-muted-foreground">
                  <Num>
                    {kb(o.size)} · {when(o.uploaded)}
                  </Num>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TimeTravelNote() {
  const { t } = useTranslation();
  const days = useBackupStatus().data?.time_travel_days ?? 7;
  return (
    <div className="flex flex-col gap-1">
      <H>{t('backup.timeTravel.title')}</H>
      <p className="text-sm">{t('backup.timeTravel.body', { days })}</p>
      <p className="text-xs text-muted-foreground">{t('backup.timeTravel.how')}</p>
    </div>
  );
}

export function DownloadEverything() {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const run = useMutation({
    mutationFn: () => buildExport(setProgress),
    onSuccess: (r) => {
      saveFile(r.blob, r.fileName);
      toast.success(
        t('backup.everything.done', { file: r.fileName, files: r.files, rows: r.rows }),
      );
    },
    onSettled: () => setProgress(null),
  });
  return (
    <div className="flex flex-col gap-2">
      <H>{t('backup.everything.title')}</H>
      <p className="text-sm">{t('backup.everything.body')}</p>
      <Button
        type="button"
        id="download-everything"
        className="self-start"
        disabled={run.isPending}
        onClick={() => run.mutate()}
      >
        <Download aria-hidden />
        {t('backup.everything.start')}
      </Button>
      {progress && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('backup.everything.working', {
            table: progress.table,
            n: progress.index,
            total: progress.total,
          })}
        </p>
      )}
      <ErrorNote error={run.error} />
    </div>
  );
}

const DRILL_STEPS = ['key', 'run', 'check', 'compare', 'record'] as const;

function RestoreDrill() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const last = useBackupStatus().data?.last_drill ?? null;
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [date, setDate] = useState(karachiToday());
  const [note, setNote] = useState('');
  const record = useMutation({
    mutationFn: () =>
      sendJson('POST', '/api/backup/drills', { date, ...(note.trim() ? { note } : {}) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['backup-status'] });
      setDone({});
      setNote('');
      toast.success(t('backup.drill.recorded'));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    record.mutate();
  };
  return (
    <div className="flex flex-col gap-2" id="restore-drill">
      <H>{t('backup.drill.title')}</H>
      <p className="text-sm">
        {last ? (
          <Num>{t('backup.drill.last', { date: formatDmy(last.finished_at.slice(0, 10)) })}</Num>
        ) : (
          t('backup.drill.never')
        )}
      </p>
      <p className="text-sm text-muted-foreground">{t('backup.drill.intro')}</p>
      <ol className="flex flex-col">
        {DRILL_STEPS.map((s) => (
          <li key={s}>
            <Checkbox
              checked={!!done[s]}
              onChange={(e) => setDone({ ...done, [s]: e.target.checked })}
              label={t(`backup.drill.steps.${s}`)}
              // The whole row (≥ 44 px tall, full width) is the touch target, also for wrapped text.
              className="w-full py-2"
            />
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field id="drill-date" label="backup.drill.date">
          <Input
            id="drill-date"
            type="date"
            dir="ltr"
            className="num w-44"
            value={date}
            max={karachiToday()}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field id="drill-note" label="backup.drill.note" className="min-w-48 flex-1">
          <Input
            id="drill-note"
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={record.isPending || !date}>
          {t('backup.drill.record')}
        </Button>
      </form>
      <ErrorNote error={record.error} />
    </div>
  );
}

export function AlarmList({ alarms }: { alarms: AlarmDto[] }) {
  const { t } = useTranslation();
  const firing = alarms.filter((a) => a.count > 0);
  if (!firing.length) return <p className="text-sm">{t('backup.alarms.allClear')}</p>;
  return (
    <ul className="flex flex-col gap-2" id="alarm-list">
      {firing.map((a) => (
        <li key={a.kind} className="rounded-md border border-destructive/40 p-3">
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 text-destructive" aria-hidden />
            {t(`backup.alarms.kinds.${a.kind}`)} · <Num>{a.count}</Num>
          </p>
          <p className="text-sm text-muted-foreground">
            <Num>{alarmHint(t, a)}</Num>
          </p>
          {a.sample.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <Num>{a.sample.map((s) => s.label).join(' · ')}</Num>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function AlarmsPanel() {
  const { t } = useTranslation();
  const q = useAlarms();
  return (
    <div className="flex flex-col gap-2" id="alarms">
      <div className="flex flex-wrap items-center gap-2">
        <H>{t('backup.alarms.title')}</H>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ms-auto"
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          <RefreshCw aria-hidden />
          {t('backup.alarms.refresh')}
        </Button>
      </div>
      <ErrorNote error={q.error} />
      {q.data && (
        <>
          <AlarmList alarms={q.data.alarms} />
          <p className="text-xs text-muted-foreground">
            <Num>{t('backup.alarms.checked', { at: when(q.data.at) })}</Num>
          </p>
        </>
      )}
    </div>
  );
}

/** Settings → Backup (owner): PLAN §9 and §14.12. */
export function BackupPanel() {
  return (
    <div className="flex flex-col gap-6">
      <AlarmsPanel />
      <NightlyStatus />
      <DownloadEverything />
      <TimeTravelNote />
      <RestoreDrill />
    </div>
  );
}
