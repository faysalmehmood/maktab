import { formatPkPhone, type Paged, STUDENT_STATUSES, type StudentListItem } from '@maktab/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Search, Upload, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { Num } from '@/components/form';
import { EmptyState, ListSkeleton, Page, PageHeader, Panel, StatusBadge } from '@/components/page';
import { isolate } from '@/components/students/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getJson } from '@/lib/api';
import { useGroups } from '@/lib/queries';
import { canWriteStudents, useRoles } from '@/lib/roles';

type Status = (typeof STUDENT_STATUSES)[number];

/** Search by name, admission no. or guardian phone; filter by group and status; 50 per page. */
export function StudentsList() {
  const { t } = useTranslation();
  const roles = useRoles();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const group = params.get('group') ?? '';
  // Default view is active students; 'all' lifts the filter.
  const statusParam = params.get('status') ?? 'active';
  const status = (statusParam === 'all' ? '' : statusParam) as Status | '';
  const page = Number(params.get('page') ?? '1') || 1;
  const [text, setText] = useState(q);
  const groups = useGroups().data?.items ?? [];

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (group) qs.set('group', group);
  if (status) qs.set('status', status);
  qs.set('page', String(page));
  const list = useQuery({
    queryKey: ['students', qs.toString()],
    queryFn: () => getJson<Paged<StudentListItem>>(`/api/students?${qs}`),
    placeholderData: keepPreviousData,
  });

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const filtered = !!(q || group || statusParam !== 'active');

  return (
    <Page width="full" className="max-w-[1240px]">
      <PageHeader
        title={t('student.title')}
        subtitle={data ? <Num>{t('common.total', { n: data.total })}</Num> : undefined}
        actions={
          canWriteStudents(roles) && (
            <>
              <Button asChild variant="outline">
                <Link to="/students/import">
                  <Upload aria-hidden />
                  {t('student.import')}
                </Link>
              </Button>
              <Button asChild>
                <Link to="/students/new">
                  <Plus aria-hidden />
                  {t('student.admit')}
                </Link>
              </Button>
            </>
          )
        }
      />

      <div className="flex flex-col gap-2 md:flex-row">
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: text.trim() });
          }}
        >
          <Input
            type="search"
            aria-label={t('common.search')}
            placeholder={t('student.searchPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" size="icon" aria-label={t('common.search')}>
            <Search aria-hidden />
          </Button>
        </form>
        <div className="grid grid-cols-2 gap-2 md:w-[26rem]">
          <Select
            aria-label={t('student.group')}
            value={group}
            onChange={(e) => update({ group: e.target.value })}
          >
            <option value="">{t('student.allGroups')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {isolate(g.programme_name)} · {isolate(g.name)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t('student.status')}
            value={statusParam}
            onChange={(e) => update({ status: e.target.value })}
          >
            <option value="all">{t('student.allStatuses')}</option>
            {STUDENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`student.statuses.${s}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Panel bodyClassName="flex flex-col">
        {/* Column heads (desktop): one row markup serves both the table and the phone list. */}
        <div
          aria-hidden
          className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_7rem] gap-4 border-b px-4 py-2 text-meta font-semibold text-muted-foreground md:grid"
        >
          <span>{t('student.title')}</span>
          <span>{t('student.group')}</span>
          <span>{t('student.fatherName')}</span>
          <span>{t('guardian.phone')}</span>
          <span className="text-end">{t('student.admissionNo')}</span>
        </div>
        {list.isPending ? (
          <ListSkeleton rows={8} />
        ) : list.isError ? (
          <p role="alert" className="p-4">
            {t('common.error')}
          </p>
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={UserRound}
            title={filtered ? t('student.emptyFilter') : t('student.empty')}
            action={
              !filtered &&
              canWriteStudents(roles) && (
                <Button asChild variant="outline">
                  <Link to="/students/new">{t('student.admit')}</Link>
                </Button>
              )
            }
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {data?.items.map((s) => (
              <li key={s.id}>
                <Link
                  to={`/students/${s.id}`}
                  className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2 hover:bg-accent md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_7rem]"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    {s.has_photo ? (
                      <img
                        src={`/api/students/${s.id}/photo`}
                        alt=""
                        loading="lazy"
                        className="size-9 shrink-0 rounded-full object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand"
                      >
                        {initials(s.name)}
                      </span>
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        <bdi>{s.name}</bdi>
                      </span>
                      {/* Phone: the class and guardian under the name. */}
                      <span className="truncate text-meta text-muted-foreground md:hidden">
                        {s.group_name ? <bdi>{s.group_name}</bdi> : '—'}
                        {s.father_name && (
                          <>
                            {' · '}
                            <bdi>{s.father_name}</bdi>
                          </>
                        )}
                      </span>
                    </span>
                  </span>
                  <span className="hidden truncate text-sm md:block">
                    {s.group_name ? <bdi>{s.group_name}</bdi> : '—'}
                  </span>
                  <span className="hidden truncate text-sm md:block">
                    {s.father_name ? <bdi>{s.father_name}</bdi> : '—'}
                  </span>
                  <span className="hidden truncate text-sm text-muted-foreground md:block">
                    {s.guardian_phone ? <Num>{formatPkPhone(s.guardian_phone)}</Num> : '—'}
                  </span>
                  <span className="flex flex-col items-end gap-1 text-sm">
                    <Num>{s.admission_no}</Num>
                    {s.status !== 'active' && (
                      <StatusBadge tone="neutral">{t(`student.statuses.${s.status}`)}</StatusBadge>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {data && data.total > data.page_size && (
        <nav className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => update({ page: String(page - 1) })}
          >
            <ChevronLeft aria-hidden className="rtl:-scale-x-100" />
            {t('common.prev')}
          </Button>
          <span className="flex-1 text-center text-sm text-muted-foreground">
            {t('common.pageOf', { page, pages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => update({ page: String(page + 1) })}
          >
            {t('common.nextPage')}
            <ChevronRight aria-hidden className="rtl:-scale-x-100" />
          </Button>
        </nav>
      )}
    </Page>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
