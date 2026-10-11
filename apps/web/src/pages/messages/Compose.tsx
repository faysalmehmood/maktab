import {
  type ComposeAudience,
  type ComposeResultDto,
  type FamilySearchHit,
  newId,
  unknownPlaceholders,
} from '@maktab/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ErrorNote, PageTitle } from '@/components/form';
import { TemplateEditor } from '@/components/messages/TemplateEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getJson, sendJson } from '@/lib/api';
import { countsKey } from '@/lib/messages';
import { useCurrentSession, useGroups } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Kind = ComposeAudience['kind'];
type Picked = { id: string; name: string };
type Progress = { done: number; total: number; queued: number; skipped: number };

const KINDS: Kind[] = ['all', 'group', 'families'];

function FamilyPicker({ picked, onChange }: { picked: Picked[]; onChange: (p: Picked[]) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const term = q.trim();
  const search = useQuery({
    queryKey: ['family-search', term],
    queryFn: () =>
      getJson<{ items: FamilySearchHit[] }>(`/api/families?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
  });
  const hits = (search.data?.items ?? []).filter((f) => !picked.some((p) => p.id === f.id));
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="compose-family-q">{t('msg.compose.searchFamilies')}</Label>
      <Input
        id="compose-family-q"
        type="search"
        value={q}
        placeholder={t('msg.compose.searchHint')}
        onChange={(e) => setQ(e.target.value)}
      />
      {term.length >= 2 && search.data && hits.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('msg.compose.noMatches')}</p>
      )}
      {hits.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {hits.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="flex min-h-11 w-full flex-wrap items-center gap-2 px-3 text-start hover:bg-accent"
                onClick={() => onChange([...picked, { id: f.id, name: f.name }])}
              >
                <bdi className="font-medium">{f.name}</bdi>
                <span className="text-sm text-muted-foreground">
                  <bdi>{f.students.map((s) => s.name).join('، ')}</bdi>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked.length > 0 && (
        <>
          <p className="text-sm font-medium">{t('msg.compose.selected', { n: picked.length })}</p>
          <ul className="flex flex-wrap gap-2">
            {picked.map((p) => (
              <li
                key={p.id}
                className="flex min-h-11 items-center gap-1 rounded-md border ps-3 text-sm"
              >
                <bdi>{p.name}</bdi>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('msg.compose.remove', { name: p.name })}
                  onClick={() => onChange(picked.filter((x) => x.id !== p.id))}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Compose a notice (PLAN §14.9 step 3): once in English and/or Urdu, queued as one message per
 * family in the guardian's language. The API takes ≤ 200 families a call; the page loops on `next`
 * with a progress bar. One `notice_id` per attempt, kept until it is done, so a retry after a lost
 * response never queues a family twice.
 */
export function ComposePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const session = useCurrentSession();
  const groups = useGroups({ session_id: session?.id ?? null });
  const [kind, setKind] = useState<Kind>('all');
  const [grpId, setGrpId] = useState('');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [bodyEn, setBodyEn] = useState('');
  const [bodyUr, setBodyUr] = useState('');
  const [noticeId, setNoticeId] = useState(newId);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState<Progress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState<
    'msg.compose.emptyBody' | 'msg.compose.pickFamilies' | 'msg.compose.pickAGroup' | null
  >(null);

  const en = bodyEn.trim();
  const ur = bodyUr.trim();
  const unknown = unknownPlaceholders(`${en}\n${ur}`);

  const audience = (): ComposeAudience | null => {
    if (kind === 'all') return { kind: 'all' };
    if (kind === 'group') return grpId ? { kind: 'group', grp_id: grpId } : null;
    return picked.length ? { kind: 'families', family_ids: picked.map((p) => p.id) } : null;
  };

  const submit = async () => {
    setError(null);
    setDone(null);
    if (!en && !ur) return setInvalid('msg.compose.emptyBody');
    const a = audience();
    if (!a)
      return setInvalid(kind === 'group' ? 'msg.compose.pickAGroup' : 'msg.compose.pickFamilies');
    if (unknown.length) return;
    setInvalid(null);
    setRunning(true);
    const acc: Progress = { done: 0, total: 0, queued: 0, skipped: 0 };
    let after: string | null = null;
    try {
      for (;;) {
        const r: ComposeResultDto = await sendJson<ComposeResultDto>(
          'POST',
          '/api/messages/compose',
          {
            notice_id: noticeId,
            audience: a,
            body_en: en,
            body_ur: ur,
            ...(after ? { after } : {}),
          },
        );
        acc.queued += r.queued;
        acc.skipped += r.skipped;
        acc.total = r.total;
        acc.done = Math.min(acc.queued + acc.skipped, r.total);
        setProgress({ ...acc });
        if (!r.next) break;
        after = r.next;
      }
      setDone({ ...acc });
      // The next notice is a new one.
      setNoticeId(newId());
      await qc.invalidateQueries({ queryKey: ['messages'] });
      await qc.invalidateQueries({ queryKey: countsKey });
    } catch (e) {
      // Same notice_id on retry: families already queued come back as skipped.
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle>{t('msg.compose.title')}</PageTitle>
      <p className="text-sm text-muted-foreground">{t('msg.compose.intro')}</p>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('msg.compose.audience')}</legend>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              id={`compose-kind-${k}`}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                'min-h-11 rounded-md border px-3 text-sm',
                kind === k && 'border-primary bg-primary/10 font-medium',
              )}
            >
              {t(`msg.compose.${k}`)}
            </button>
          ))}
        </div>
        {kind === 'group' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="compose-group">{t('msg.compose.pickGroup')}</Label>
            <Select id="compose-group" value={grpId} onChange={(e) => setGrpId(e.target.value)}>
              <option value="">{t('admission.pickGroup')}</option>
              {(groups.data?.items ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {`${g.programme_name} ${g.name}`}
                </option>
              ))}
            </Select>
          </div>
        )}
        {kind === 'families' && <FamilyPicker picked={picked} onChange={setPicked} />}
      </fieldset>

      <TemplateEditor
        id="compose-en"
        label={t('msg.compose.bodyEn')}
        previewLabel={t('msg.compose.previewEn')}
        lang="en"
        value={bodyEn}
        onChange={setBodyEn}
        previewBody={en || ur}
      />
      <TemplateEditor
        id="compose-ur"
        label={t('msg.compose.bodyUr')}
        previewLabel={t('msg.compose.previewUr')}
        lang="ur"
        value={bodyUr}
        onChange={setBodyUr}
        previewBody={ur || en}
      />
      <p className="text-xs text-muted-foreground">{t('msg.compose.sampleNote')}</p>

      {invalid && (
        <p role="alert" className="text-sm text-destructive">
          {t(invalid)}
        </p>
      )}
      <ErrorNote error={error} />

      {progress && (running || !done) && (
        <div className="flex flex-col gap-1" aria-live="polite">
          <p className="text-sm">
            {t('msg.compose.willQueue', { n: progress.total })} ·{' '}
            {t('msg.compose.progress', { done: progress.done, total: progress.total })}
          </p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {done && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-3">
          <span>{t('msg.compose.done', { queued: done.queued, skipped: done.skipped })}</span>
          <Button asChild variant="outline" size="sm" className="ms-auto">
            <Link to="/messages">{t('msg.compose.toQueue')}</Link>
          </Button>
        </div>
      )}

      <Button
        id="compose-send"
        className="self-start"
        disabled={running || unknown.length > 0}
        onClick={() => void submit()}
      >
        {running ? t('msg.compose.sending') : t('msg.compose.send')}
      </Button>
    </section>
  );
}
