import {
  ABOUT,
  formatDmy,
  RETENTION_LIMITS,
  type ReceiptSeriesDto,
  type RecycleItemDto,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field, Num } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson } from '@/lib/api';
import { BUILD, useRecycleBin, useRetention } from '@/lib/backup';

const H = ({ children }: { children: ReactNode }) => (
  <h3 className="text-base font-semibold">{children}</h3>
);

/** Every list a restore can bring an item back into. */
const RELOAD = ['recycle-bin', 'programmes', 'subjects', 'groups', 'fee-heads'];

function RestoreButton({ item }: { item: RecycleItemDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const restore = useMutation({
    mutationFn: () =>
      sendJson('POST', '/api/recycle-bin/restore', { kind: item.kind, id: item.id }),
    onSuccess: async () => {
      await Promise.all(RELOAD.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast.success(t('backup.recycle.restored'));
    },
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={restore.isPending}
        onClick={() => restore.mutate()}
        aria-label={`${t('backup.recycle.restore')}: ${item.name}`}
      >
        <ArchiveRestore aria-hidden />
        {t('backup.recycle.restore')}
      </Button>
      <ErrorNote error={restore.error} />
    </div>
  );
}

export function RecycleBin() {
  const { t } = useTranslation();
  const q = useRecycleBin();
  return (
    <div className="flex flex-col gap-2" id="recycle-bin">
      <H>{t('backup.recycle.title')}</H>
      <p className="text-sm text-muted-foreground">{t('backup.recycle.intro')}</p>
      <ErrorNote error={q.error} />
      {q.data &&
        (q.data.items.length === 0 ? (
          <p className="text-sm">{t('backup.recycle.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {q.data.items.map((i) => (
              <li key={`${i.kind}:${i.id}`} className="flex flex-wrap items-center gap-2 py-2">
                <div className="flex flex-col">
                  <span className="font-medium">
                    <bdi>{i.name}</bdi>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(`backup.recycle.kinds.${i.kind}`)} ·{' '}
                    <Num>
                      {t('backup.recycle.removedOn', {
                        date: formatDmy(i.removed_at.slice(0, 10)),
                      })}
                    </Num>
                  </span>
                </div>
                <div className="ms-auto">
                  <RestoreButton item={i} />
                </div>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/** "Move to recycle bin" for a group nobody was ever enrolled in (the API refuses others). */
export function ArchiveGroupButton({ grpId, onDone }: { grpId: string; onDone?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const archive = useMutation({
    mutationFn: () => sendJson('POST', `/api/groups/${grpId}/archive`),
    onSuccess: async () => {
      await Promise.all(
        ['groups', 'recycle-bin'].map((k) => qc.invalidateQueries({ queryKey: [k] })),
      );
      toast.success(t('backup.recycle.archived'));
      onDone?.();
    },
  });
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={archive.isPending}
        onClick={() => archive.mutate()}
        title={t('backup.recycle.archiveHint')}
      >
        {t('backup.recycle.archiveGroup')}
      </Button>
      <ErrorNote error={archive.error} />
    </div>
  );
}

export function Retention() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useRetention();
  const [days, setDays] = useState('');
  useEffect(() => {
    if (q.data) setDays(String(q.data.access_log_days));
  }, [q.data]);
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= RETENTION_LIMITS.min && n <= RETENTION_LIMITS.max;
  const save = useMutation({
    mutationFn: () => sendJson('PUT', '/api/settings/retention', { access_log_days: n }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['retention'] });
      toast.success(t('backup.retention.saved'));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" id="retention">
      <H>{t('backup.retention.title')}</H>
      <Field
        id="retention-days"
        label="backup.retention.accessLog"
        hint={t('backup.retention.hint')}
      >
        <Input
          id="retention-days"
          inputMode="numeric"
          dir="ltr"
          className="num w-28"
          value={days}
          onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
      </Field>
      <ErrorNote error={save.error ?? q.error} />
      <Button type="submit" className="self-start" disabled={!valid || save.isPending}>
        {t('common.save')}
      </Button>
    </form>
  );
}

/** Receipt numbering series, read-only (Settings → Fees). */
export function ReceiptSeries() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['receipt-series'],
    queryFn: () => getJson<{ items: ReceiptSeriesDto[] }>('/api/receipt-series'),
  });
  if (!q.data) return null;
  return (
    <div className="flex flex-col gap-1" id="receipt-series">
      <H>{t('backup.series.title')}</H>
      <p className="text-xs text-muted-foreground">{t('backup.series.intro')}</p>
      {q.data.items.length === 0 ? (
        <p className="text-sm">{t('backup.series.none')}</p>
      ) : (
        <ul className="text-sm">
          {q.data.items.map((s) => (
            <li key={`${s.series}-${s.year}`} className="flex gap-2">
              <Num>
                {s.series}-{s.year}
              </Num>
              <span className="text-muted-foreground">{t('backup.series.last')}</span>
              <Num>
                {s.last_no > 0
                  ? `${s.series}-${s.year}-${String(s.last_no).padStart(5, '0')}`
                  : '—'}
              </Num>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Settings → About: every role sees it. */
export function AboutPanel() {
  const { t } = useTranslation();
  const rows: [string, ReactNode][] = [
    [t('backup.about.version'), <Num key="v">{BUILD.version}</Num>],
    [t('backup.about.commit'), <Num key="c">{BUILD.commit}</Num>],
    [
      t('backup.about.source'),
      <a key="s" href={ABOUT.repo} target="_blank" rel="noreferrer" className="underline">
        <bdi>{ABOUT.repo.replace('https://', '')}</bdi>
      </a>,
    ],
    [
      t('backup.about.issues'),
      <a
        key="i"
        href={`${ABOUT.repo}/issues`}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        <bdi>{`${ABOUT.repo.replace('https://', '')}/issues`}</bdi>
      </a>,
    ],
    [
      t('backup.about.contact'),
      <a key="m" href={`mailto:${ABOUT.contact}`} className="underline">
        <bdi>{ABOUT.contact}</bdi>
      </a>,
    ],
    [t('backup.about.licence'), <Num key="l">{ABOUT.licence}</Num>],
  ];
  return (
    <div className="flex flex-col gap-3" id="about">
      <p className="text-sm">{t('backup.about.body')}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="flex min-h-11 items-center text-muted-foreground">{label}</dt>
            <dd className="flex min-h-11 items-center break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t('backup.about.licenceText')}</p>
    </div>
  );
}
