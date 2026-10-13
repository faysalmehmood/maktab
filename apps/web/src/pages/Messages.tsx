import {
  type BulkTextDto,
  formatPkPhone,
  MESSAGE_STATUS_FILTER,
  type MessageListDto,
  type MessageOpenDto,
  normalizePkPhone,
  type QueueMessageDto,
  SKIP_REASONS,
  type SkipReason,
  TEMPLATE_KEYS,
  type TemplateKey,
  telUrl,
} from '@maktab/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardCopy, MessageCircle, Phone, Send, SkipForward } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ErrorNote, Num, PageTitle, useErrorText } from '@/components/form';
import { MARK, MessageText, WithValue } from '@/components/messages/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { getJson, sendJson } from '@/lib/api';
import { canCompose, canSendMessages, copyText, countsKey, useMessageCounts } from '@/lib/messages';
import { useCurrentSession, useGroups } from '@/lib/queries';
import { useRoles } from '@/lib/roles';

type RowState =
  | { kind: 'idle'; error?: unknown }
  | { kind: 'busy' }
  | { kind: 'opened'; open: MessageOpenDto; blocked: boolean; error?: unknown }
  | { kind: 'auto'; reason: string }
  | { kind: 'done'; status: 'sent' | 'skipped' };

const IDLE: RowState = { kind: 'idle' };

/** Rows whose actions are still open (not sent, skipped, or skipped by the system at open). */
const isPending = (m: QueueMessageDto, s: RowState | undefined) =>
  m.status === 'queued' && s?.kind !== 'done' && s?.kind !== 'auto';

function useLabels() {
  const { t, i18n } = useTranslation();
  return {
    template: (k: string) =>
      (TEMPLATE_KEYS as readonly string[]).includes(k) ? t(`msg.templates.${k as TemplateKey}`) : k,
    reason: (r: string | null) => {
      const key = `msg.skipReasons.${r ?? 'other'}`;
      return i18n.exists(key) ? t(key as `msg.skipReasons.${SkipReason}`) : (r ?? '');
    },
    status: (s: string) => {
      const key = `msg.statuses.${s}`;
      return i18n.exists(key) ? t(key as 'msg.statuses.queued') : s;
    },
  };
}

function Counter({ label, n, id }: { label: string; n: number | undefined; id: string }) {
  return (
    <Card className="gap-1 py-3">
      <CardContent className="flex flex-col px-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span id={id} className="text-2xl font-semibold">
          <Num>{n ?? '–'}</Num>
        </span>
      </CardContent>
    </Card>
  );
}

function SkipPicker({
  id,
  busy,
  onSkip,
  onCancel,
}: {
  id: string;
  busy: boolean;
  onSkip: (r: (typeof SKIP_REASONS)[number]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<(typeof SKIP_REASONS)[number]>(SKIP_REASONS[0]);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSkip(reason);
      }}
    >
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <Label htmlFor={`skip-reason-${id}`}>{t('msg.queue.skipReason')}</Label>
        <Select
          id={`skip-reason-${id}`}
          value={reason}
          autoFocus
          onChange={(e) => setReason(e.target.value as (typeof SKIP_REASONS)[number])}
        >
          {SKIP_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`msg.skipReasons.${r}`)}
            </option>
          ))}
        </Select>
      </div>
      <Button id={`msg-skip-confirm-${id}`} type="submit" variant="secondary" disabled={busy}>
        {t('msg.queue.confirmSkip')}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </form>
  );
}

function QueueRow({
  m,
  state,
  canSend,
  onOpen,
  onSent,
  onSkip,
}: {
  m: QueueMessageDto;
  state: RowState;
  canSend: boolean;
  onOpen: (m: QueueMessageDto, popup: boolean) => void;
  onSent: (m: QueueMessageDto) => void;
  onSkip: (m: QueueMessageDto, r: (typeof SKIP_REASONS)[number]) => void;
}) {
  const { t } = useTranslation();
  const label = useLabels();
  const errorText = useErrorText();
  const [skipping, setSkipping] = useState(false);
  const busy = state.kind === 'busy';
  const opened = state.kind === 'opened' ? state.open : null;
  const actionable = canSend && isPending(m, state);
  const isCall = m.channel === 'call';
  // `number` is the API's normalised number for this row (wa: the mobile; call: what to dial), so a
  // row needing a fixed number shows before it is opened.
  const callNumber =
    (isCall ? m.number : null) ?? normalizePkPhone(m.guardian_phone ?? '')?.number ?? null;
  const tel = opened?.tel_url ?? (callNumber ? telUrl(callNumber) : null);
  const noNumber = !isCall && !(m.number ?? m.wa_number);
  const finalStatus =
    state.kind === 'done' ? state.status : state.kind === 'auto' ? 'skipped' : m.status;
  const finalReason = state.kind === 'auto' ? state.reason : m.skipped_reason;

  return (
    <li id={`msg-row-${m.id}`} data-status={finalStatus} className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <bdi className="font-medium">{m.guardian_name ?? m.family_name}</bdi>
        {m.guardian_phone && (
          <span className="text-sm text-muted-foreground">
            <Num>{formatPkPhone(m.guardian_phone)}</Num>
          </span>
        )}
        <Badge variant="outline">{t(`msg.langs.${m.lang}`)}</Badge>
        {m.grp_name && (
          <span className="text-sm text-muted-foreground">
            <bdi>{m.grp_name}</bdi>
          </span>
        )}
        {finalStatus !== 'queued' && (
          <Badge
            variant={finalStatus === 'sent' ? 'default' : 'secondary'}
            className="ms-auto"
            data-testid="row-status"
          >
            {finalStatus === 'sent' && <Check aria-hidden className="size-3" />}
            {label.status(finalStatus)}
          </Badge>
        )}
      </div>

      <MessageText
        id={`msg-text-${m.id}`}
        text={opened?.text ?? m.preview}
        lang={m.lang}
        className="rounded-md bg-muted/50 p-2 text-sm"
      />

      {finalStatus === 'skipped' && finalReason && (
        <p
          className="text-sm text-muted-foreground"
          role={state.kind === 'auto' ? 'status' : undefined}
        >
          {state.kind === 'auto'
            ? t('msg.queue.autoSkipped', { reason: label.reason(finalReason) })
            : label.reason(finalReason)}
        </p>
      )}
      {finalStatus === 'sent' && m.sent_by_name && (
        <p className="text-sm text-muted-foreground">
          <WithValue sentence={t('msg.queue.sentBy', { name: MARK })}>{m.sent_by_name}</WithValue>
        </p>
      )}

      {actionable && (
        <div className="flex flex-col gap-2">
          {isCall && <p className="text-sm text-amber-800">{t('msg.queue.callInstead')}</p>}
          {noNumber && (
            <p className="text-sm text-amber-800" id={`msg-fix-${m.id}`}>
              <strong>{t('msg.queue.fixNumber')}</strong> · {t('msg.queue.fixNumberHint')}
            </p>
          )}
          {opened?.wa_url && (
            <p className="text-sm text-muted-foreground" role="status">
              {state.kind === 'opened' && state.blocked
                ? t('msg.queue.popupBlocked')
                : t('msg.queue.opened')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {isCall ? (
              tel ? (
                <Button asChild variant="outline">
                  <a
                    id={`msg-primary-${m.id}`}
                    href={tel}
                    onClick={() => {
                      if (!opened) onOpen(m, false);
                    }}
                  >
                    <Phone aria-hidden />
                    {t('msg.queue.call')} <Num>{formatPkPhone(m.guardian_phone)}</Num>
                  </a>
                </Button>
              ) : (
                <span className="flex min-h-11 items-center text-sm text-muted-foreground">
                  {t('msg.queue.noNumber')}
                </span>
              )
            ) : noNumber ? null : opened?.wa_url ? (
              <Button asChild variant="outline">
                <a
                  id={`msg-wa-${m.id}`}
                  href={opened.wa_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MessageCircle aria-hidden />
                  {t('msg.queue.openAgain')}
                </a>
              </Button>
            ) : (
              <Button id={`msg-primary-${m.id}`} disabled={busy} onClick={() => onOpen(m, true)}>
                <MessageCircle aria-hidden />
                {t('msg.queue.openWa')}
              </Button>
            )}
            {(isCall || opened) && (
              <Button id={`msg-sent-${m.id}`} disabled={busy} onClick={() => onSent(m)}>
                <Send aria-hidden className="rtl:-scale-x-100" />
                {isCall ? t('msg.queue.called') : t('msg.queue.sentNext')}
              </Button>
            )}
            {!skipping && (
              <Button
                id={noNumber ? `msg-primary-${m.id}` : `msg-skip-${m.id}`}
                variant="ghost"
                disabled={busy}
                onClick={() => setSkipping(true)}
              >
                <SkipForward aria-hidden className="rtl:-scale-x-100" />
                {t('msg.queue.skip')}
              </Button>
            )}
          </div>
          {skipping && (
            <SkipPicker
              id={m.id}
              busy={busy}
              onSkip={(r) => onSkip(m, r)}
              onCancel={() => setSkipping(false)}
            />
          )}
          {(state.kind === 'idle' || state.kind === 'opened') && state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorText(state.error)}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** "Copy all texts" for one class: the whole class's absence texts, for its announcement group. */
function CopyClassTexts({ grpId, grpName }: { grpId: string; grpName: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendJson<BulkTextDto>(
        'POST',
        `/api/messages/bulk-text?grp_id=${encodeURIComponent(grpId)}&template_key=absence`,
      );
      if (await copyText(r.text)) {
        setFallback(null);
        toast.success(t('msg.queue.copied', { n: r.count }));
      } else setFallback(r.text);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={busy}
        aria-label={t('msg.queue.copyAllGroup')}
        onClick={() => void run()}
      >
        <ClipboardCopy aria-hidden />
        {t('msg.queue.copyAll')} · <bdi>{grpName}</bdi>
      </Button>
      {fallback !== null && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`bulk-${grpId}`}>{t('msg.queue.copyFallback')}</Label>
          <Textarea
            id={`bulk-${grpId}`}
            readOnly
            value={fallback}
            rows={8}
            // One class's texts in each guardian's language, one per paragraph: each paragraph takes
            // its own direction (Urdu right-to-left, English left-to-right) — UI plan 4.6.4.
            dir="auto"
            style={{ unicodeBidi: 'plaintext' }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

/**
 * The send queue (PLAN §14.9, exp4): pending messages grouped by template; Open WhatsApp → send in
 * WhatsApp → back → an explicit "Sent & next" (nothing is marked sent by opening it), or Skip with a
 * reason. Absence rows are rebuilt by the API at open time and may come back skipped.
 */
export function MessagesPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const qc = useQueryClient();
  const label = useLabels();
  const canSend = canSendMessages(roles);
  const session = useCurrentSession();
  const groups = useGroups({ session_id: session?.id ?? null });
  const [status, setStatus] = useState<string>('queued');
  const [template, setTemplate] = useState('');
  const [grp, setGrp] = useState('');
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [focusId, setFocusId] = useState<string | null>(null);

  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (template) qs.set('template_key', template);
  if (grp) qs.set('grp_id', grp);
  const list = useQuery({
    queryKey: ['messages', status, template, grp],
    queryFn: () => getJson<MessageListDto>(`/api/messages?${qs.toString()}`),
  });
  const counts = useMessageCounts();
  const shownCounts = counts.data ?? list.data?.counts;

  const items = list.data?.items ?? [];
  const sections = useMemo(() => {
    const keys = [
      ...TEMPLATE_KEYS,
      ...new Set(
        items
          .map((m) => m.template_key)
          .filter((k) => !(TEMPLATE_KEYS as readonly string[]).includes(k)),
      ),
    ];
    return keys
      .map((k) => ({ key: k, items: items.filter((m) => m.template_key === k) }))
      .filter((s) => s.items.length > 0);
  }, [items]);
  const ordered = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const setRow = useCallback(
    (id: string, s: RowState) => setRows((prev) => ({ ...prev, [id]: s })),
    [],
  );

  // Focus moves after the row's new state has rendered.
  useEffect(() => {
    if (!focusId) return;
    const el =
      document.getElementById(`msg-primary-${focusId}`) ??
      document.getElementById(`msg-skip-${focusId}`);
    el?.focus();
    setFocusId(null);
  }, [focusId]);

  const focusNext = (fromId: string, after: Record<string, RowState>) => {
    const at = ordered.findIndex((m) => m.id === fromId);
    const rest = [...ordered.slice(at + 1), ...ordered.slice(0, Math.max(at, 0))];
    const next = rest.find((m) => isPending(m, after[m.id]));
    if (next) setFocusId(next.id);
  };

  const refreshCounts = () => void qc.invalidateQueries({ queryKey: countsKey });

  const finish = (id: string, s: RowState) => {
    const after = { ...rows, [id]: s };
    setRows(after);
    refreshCounts();
    focusNext(id, after);
  };

  const open = async (m: QueueMessageDto, popup: boolean) => {
    // The window opens inside the tap (popup blockers allow only that); it is pointed at wa.me once
    // the API has rebuilt the text. If the phone blocks it, the row shows a link to tap instead.
    let win: Window | null = null;
    if (popup) {
      try {
        win = window.open('', '_blank');
      } catch {
        win = null;
      }
    }
    setRow(m.id, { kind: 'busy' });
    try {
      const o = await sendJson<MessageOpenDto>('POST', `/api/messages/${m.id}/open`);
      if (o.status === 'skipped') {
        win?.close();
        finish(m.id, { kind: 'auto', reason: o.skipped_reason ?? 'other' });
        return;
      }
      let blocked = !!o.wa_url;
      if (o.wa_url && win) {
        try {
          win.opener = null;
          win.location.href = o.wa_url;
          blocked = false;
        } catch {
          blocked = true;
        }
      } else win?.close();
      setRow(m.id, { kind: 'opened', open: o, blocked });
      if (popup) setTimeout(() => document.getElementById(`msg-sent-${m.id}`)?.focus(), 0);
    } catch (e) {
      win?.close();
      setRow(m.id, { kind: 'idle', error: e });
    }
  };

  const markSent = async (m: QueueMessageDto) => {
    const prev = rows[m.id] ?? IDLE;
    setRow(m.id, { kind: 'busy' });
    try {
      await sendJson('POST', `/api/messages/${m.id}/sent`);
      finish(m.id, { kind: 'done', status: 'sent' });
    } catch (e) {
      setRow(m.id, prev.kind === 'opened' ? { ...prev, error: e } : { kind: 'idle', error: e });
    }
  };

  const skip = async (m: QueueMessageDto, reason: (typeof SKIP_REASONS)[number]) => {
    setRow(m.id, { kind: 'busy' });
    try {
      await sendJson('POST', `/api/messages/${m.id}/skip`, { reason });
      finish(m.id, { kind: 'done', status: 'skipped' });
    } catch (e) {
      setRow(m.id, { kind: 'idle', error: e });
    }
  };

  // Classes in today's queued absence rows: one "copy all texts" button each.
  const absenceGroups = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of items)
      if (m.template_key === 'absence' && m.status === 'queued' && m.grp_id)
        seen.set(m.grp_id, m.grp_name ?? '');
    return [...seen];
  }, [items]);

  const groupOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups.data?.items ?? []) map.set(g.id, `${g.programme_name} ${g.name}`.trim());
    for (const m of items) if (m.grp_id && !map.has(m.grp_id)) map.set(m.grp_id, m.grp_name ?? '');
    return [...map];
  }, [groups.data, items]);

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle
        actions={
          canCompose(roles) && (
            <Button asChild variant="outline" size="sm" id="msg-compose">
              <Link to="/messages/compose">{t('msg.queue.compose')}</Link>
            </Button>
          )
        }
      >
        {t('msg.queue.title')}
      </PageTitle>
      <p className="text-sm text-muted-foreground">{t('msg.queue.intro')}</p>

      <div className="grid grid-cols-3 gap-2">
        <Counter id="count-pending" label={t('msg.queue.pending')} n={shownCounts?.queued} />
        <Counter id="count-sent" label={t('msg.queue.sentToday')} n={shownCounts?.sent_today} />
        <Counter
          id="count-skipped"
          label={t('msg.queue.skippedToday')}
          n={shownCounts?.skipped_today}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="msg-filter-status">{t('msg.queue.status')}</Label>
          <Select id="msg-filter-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {MESSAGE_STATUS_FILTER.map((s) => (
              <option key={s} value={s}>
                {label.status(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="msg-filter-template">{t('msg.queue.template')}</Label>
          <Select
            id="msg-filter-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="">{t('msg.queue.allTemplates')}</option>
            {TEMPLATE_KEYS.map((k) => (
              <option key={k} value={k}>
                {label.template(k)}
                {shownCounts?.by_template[k] ? ` (${shownCounts.by_template[k]})` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="msg-filter-group">{t('msg.queue.group')}</Label>
          <Select id="msg-filter-group" value={grp} onChange={(e) => setGrp(e.target.value)}>
            <option value="">{t('msg.queue.allGroups')}</option>
            {groupOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {list.isPending && <p className="text-muted-foreground">{t('common.loading')}</p>}
      <ErrorNote error={list.error} />
      {list.data && items.length === 0 && (
        <div className="rounded-md border p-4">
          <p className="font-medium">{t('msg.queue.empty')}</p>
          <p className="text-sm text-muted-foreground">{t('msg.queue.emptyHint')}</p>
        </div>
      )}
      {list.data && list.data.total > items.length && (
        <p className="text-sm text-muted-foreground">
          {t('msg.queue.capped', { n: items.length })}
        </p>
      )}

      {sections.map((s) => (
        <section key={s.key} className="flex flex-col gap-2" aria-labelledby={`sec-${s.key}`}>
          <h2 id={`sec-${s.key}`} className="flex items-center gap-2 font-semibold">
            {label.template(s.key)} · <Num>{s.items.length}</Num>
          </h2>
          {s.key === 'absence' && canSend && status === 'queued' && absenceGroups.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {absenceGroups.map(([id, name]) => (
                <CopyClassTexts key={id} grpId={id} grpName={name} />
              ))}
            </div>
          )}
          <ul className="flex flex-col divide-y rounded-md border">
            {s.items.map((m) => (
              <QueueRow
                key={m.id}
                m={m}
                state={rows[m.id] ?? IDLE}
                canSend={canSend}
                onOpen={(x, popup) => void open(x, popup)}
                onSent={(x) => void markSent(x)}
                onSkip={(x, r) => void skip(x, r)}
              />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
