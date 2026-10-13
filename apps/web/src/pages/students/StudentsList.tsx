import { formatPkPhone, type Paged, STUDENT_STATUSES, type StudentListItem } from '@maktab/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Search, Upload, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { Avatar } from '@/components/avatar';
import { type Column, DataTable } from '@/components/data-table';
import { type ActiveFilter, FilterBar } from '@/components/filter-bar';
import { Field, Num } from '@/components/form';
import { EmptyState, Page, PageHeader, Panel, StatusBadge } from '@/components/page';
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
  const groupRow = groups.find((g) => g.id === group);
  // Applied filters as chips on a phone (the default "active" status is not a filter).
  const active: ActiveFilter[] = [];
  if (group)
    active.push({
      id: 'group',
      label: (
        <>
          {t('student.group')}: <bdi>{groupRow ? groupRow.name : '…'}</bdi>
        </>
      ),
      onClear: () => update({ group: '' }),
    });
  if (statusParam !== 'active')
    active.push({
      id: 'status',
      label: (
        <>
          {t('student.status')}:{' '}
          {status ? t(`student.statuses.${status}`) : t('student.allStatuses')}
        </>
      ),
      onClear: () => update({ status: '' }),
    });

  const columns: Column<StudentListItem>[] = [
    {
      id: 'name',
      header: t('student.title'),
      primary: true,
      cell: (s) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={s.name} src={s.has_photo ? `/api/students/${s.id}/photo` : null} />
          <span className="flex min-w-0 flex-col">
            <bdi className="truncate">{s.name}</bdi>
            {s.status !== 'active' && (
              <span>
                <StatusBadge tone="neutral">{t(`student.statuses.${s.status}`)}</StatusBadge>
              </span>
            )}
          </span>
        </span>
      ),
    },
    {
      id: 'group',
      header: t('student.group'),
      cell: (s) => (s.group_name ? <bdi>{s.group_name}</bdi> : '—'),
    },
    {
      id: 'father',
      header: t('student.fatherName'),
      cell: (s) => (s.father_name ? <bdi>{s.father_name}</bdi> : '—'),
    },
    {
      id: 'phone',
      header: t('guardian.phone'),
      hideOnPhone: true,
      className: 'text-muted-foreground',
      cell: (s) => (s.guardian_phone ? <Num>{formatPkPhone(s.guardian_phone)}</Num> : '—'),
    },
    {
      id: 'admission',
      header: t('student.admissionNo'),
      numeric: true,
      cell: (s) => <Num>{s.admission_no}</Num>,
    },
  ];

  return (
    <Page width="full" className="max-w-[1240px]">
      <PageHeader
        title={t('student.title')}
        subtitle={data ? <span>{t('common.total', { n: data.total })}</span> : undefined}
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

      <FilterBar
        id="student-filters"
        search={
          <form
            className="flex gap-2"
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
        }
        active={active}
        onClearAll={() => update({ group: '', status: '' })}
      >
        <Field id="student-filter-group" label="student.group">
          <Select
            id="student-filter-group"
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
        </Field>
        <Field id="student-filter-status" label="student.status">
          <Select
            id="student-filter-status"
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
        </Field>
      </FilterBar>

      <Panel bodyClassName="flex flex-col">
        <DataTable
          id="students-table"
          caption={t('student.title')}
          columns={columns}
          rows={data?.items}
          rowKey={(s) => s.id}
          rowHref={(s) => `/students/${s.id}`}
          loading={list.isPending}
          error={list.isError ? t('common.error') : undefined}
          empty={
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
          }
        />
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
