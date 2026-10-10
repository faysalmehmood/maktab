import type { AuditListDto, AuditRowDto } from '@maktab/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field, PageTitle } from '@/components/form';
import { MoneyErrorNote } from '@/components/money/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getJson } from '@/lib/api';

/**
 * PLAN §5.4 "audit everything … show the audit trail to owner": who, what, when, before/after.
 * Filters by record type, record id and school day; keyset pages of 100.
 */

const show = (v: unknown): string =>
  v === undefined ? '' : v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

type DiffRow = { field: string; before: unknown; after: unknown };

/**
 * Record types and actions in words (en/ur, verify pass); an unknown code shows as itself. The raw
 * code stays available as the tooltip (title) for whoever needs to search for it.
 */
export function useAuditLabels() {
  const { t, i18n } = useTranslation();
  const label = (group: 'entities' | 'actions', code: string) => {
    const key = `money.audit.${group}.${code}`;
    return i18n.exists(key) ? String(t(key as 'money.audit.title')) : code;
  };
  return {
    entity: (code: string) => label('entities', code),
    action: (code: string) => label('actions', code),
  };
}

/** Any diff shape → field rows: {before, after} objects are compared key by key. */
export function diffRows(diff: unknown): DiffRow[] {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff))
    return diff == null ? [] : [{ field: '', before: undefined, after: diff }];
  const d = diff as Record<string, unknown>;
  const isObj = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === 'object' && !Array.isArray(x);
  if ('before' in d || 'after' in d) {
    const b = isObj(d.before) ? d.before : {};
    const a = isObj(d.after) ? d.after : {};
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
    if (!keys.length && (d.before != null || d.after != null))
      return [{ field: '', before: d.before ?? undefined, after: d.after ?? undefined }];
    return keys.map((k) => ({ field: k, before: b[k], after: a[k] }));
  }
  return Object.entries(d).map(([k, v]) => ({ field: k, before: undefined, after: v }));
}

function AuditEntry({ row }: { row: AuditRowDto }) {
  const { t } = useTranslation();
  const label = useAuditLabels();
  const [open, setOpen] = useState(false);
  const rows = diffRows(row.diff);
  return (
    <Card className="gap-1 py-3" data-audit={row.id}>
      <CardContent className="flex flex-col gap-1 px-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <bdi className="num text-muted-foreground">{row.at.replace('T', ' ').slice(0, 19)}</bdi>
          <span className="font-medium" title={row.entity} data-code={row.entity}>
            {label.entity(row.entity)}
          </span>
          <span title={row.action} data-code={row.action}>
            {label.action(row.action)}
          </span>
          <span className="ms-auto">
            {t('money.audit.user')}: <bdi>{row.user_name ?? row.user_id ?? '—'}</bdi>
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('money.audit.entityId')}: <bdi className="num">{row.entity_id}</bdi>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 self-start"
          aria-expanded={open}
          id={`audit-toggle-${row.id}`}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('money.audit.hide') : t('money.audit.show')}
        </Button>
        {open &&
          (rows.length === 0 ? (
            <p className="text-muted-foreground">{t('money.audit.noDiff')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" id={`audit-diff-${row.id}`}>
                <thead>
                  <tr className="text-start text-muted-foreground">
                    <th className="p-1 text-start">{t('money.audit.field')}</th>
                    <th className="p-1 text-start">{t('money.audit.before')}</th>
                    <th className="p-1 text-start">{t('money.audit.after')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.field} className="border-t align-top">
                      <td className="p-1 font-medium">
                        <bdi>{r.field}</bdi>
                      </td>
                      <td className="p-1 text-destructive">
                        <bdi className="break-all">{show(r.before)}</bdi>
                      </td>
                      <td className="p-1 text-emerald-700 dark:text-emerald-400">
                        <bdi className="break-all">{show(r.after)}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

export function AuditPage() {
  const { t } = useTranslation();
  const label = useAuditLabels();
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const entities = useQuery({
    queryKey: ['audit', 'entities'],
    queryFn: () => getJson<{ entities: { entity: string; n: number }[] }>('/api/audit/entities'),
  });
  const qs = new URLSearchParams();
  if (entity) qs.set('entity', entity);
  if (entityId.trim()) qs.set('entity_id', entityId.trim());
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const q = useInfiniteQuery({
    queryKey: ['audit', qs.toString()],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(qs);
      if (pageParam) p.set('before', pageParam);
      return getJson<AuditListDto>(`/api/audit?${p}`);
    },
    getNextPageParam: (last) => last.next,
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle>{t('money.audit.title')}</PageTitle>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="audit-entity" label="money.audit.entity">
          <Select id="audit-entity" value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">{t('money.common.all')}</option>
            {(entities.data?.entities ?? []).map((e) => (
              <option key={e.entity} value={e.entity} title={e.entity}>
                {label.entity(e.entity)} ({e.n})
              </option>
            ))}
          </Select>
        </Field>
        <Field id="audit-entity-id" label="money.audit.entityId">
          <Input
            id="audit-entity-id"
            dir="ltr"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          />
        </Field>
        <Field id="audit-from" label="money.common.from">
          <Input
            id="audit-from"
            type="date"
            className="num"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field id="audit-to" label="money.common.to">
          <Input
            id="audit-to"
            type="date"
            className="num"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <MoneyErrorNote error={q.error} />
      {q.data && rows.length === 0 && (
        <p className="text-muted-foreground">{t('money.audit.empty')}</p>
      )}
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <AuditEntry key={r.id} row={r} />
        ))}
      </div>
      {q.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          id="audit-more"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          {t('money.audit.more')}
        </Button>
      )}
    </section>
  );
}
