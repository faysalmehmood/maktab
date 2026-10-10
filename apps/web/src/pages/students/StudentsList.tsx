import { formatPkPhone, type Paged, STUDENT_STATUSES, type StudentListItem } from '@maktab/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Search, Upload, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { Num, PageTitle } from '@/components/form';
import { Badge } from '@/components/ui/badge';
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
    <section className="flex flex-col gap-4">
      <PageTitle
        actions={
          canWriteStudents(roles) && (
            <>
              <Button asChild variant="outline" size="sm">
                <Link to="/students/import">
                  <Upload aria-hidden />
                  {t('student.import')}
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/students/new">
                  <Plus aria-hidden />
                  {t('student.admit')}
                </Link>
              </Button>
            </>
          )
        }
      >
        {t('student.title')}
      </PageTitle>

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
      <div className="grid grid-cols-2 gap-2">
        <Select
          aria-label={t('student.group')}
          value={group}
          onChange={(e) => update({ group: e.target.value })}
        >
          <option value="">{t('student.allGroups')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.programme_name} · {g.name}
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

      {list.isPending ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : list.isError ? (
        <p role="alert">{t('common.error')}</p>
      ) : data && data.items.length === 0 ? (
        <p className="text-muted-foreground">
          {filtered ? t('student.emptyFilter') : t('student.empty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {data?.items.map((s) => (
            <li key={s.id}>
              <Link
                to={`/students/${s.id}`}
                className="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-accent"
              >
                {s.has_photo ? (
                  <img
                    src={`/api/students/${s.id}/photo`}
                    alt=""
                    loading="lazy"
                    className="size-10 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <UserRound className="size-10 shrink-0 rounded-full bg-muted p-2" aria-hidden />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{s.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {s.father_name && <>{s.father_name} · </>}
                    {s.group_name ?? '—'}
                    {s.guardian_phone && (
                      <>
                        {' · '}
                        <Num>{formatPkPhone(s.guardian_phone)}</Num>
                      </>
                    )}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Num>{s.admission_no}</Num>
                  {s.status !== 'active' && (
                    <Badge variant="outline">{t(`student.statuses.${s.status}`)}</Badge>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

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
      {data && (
        <p className="text-xs text-muted-foreground">{t('common.total', { n: data.total })}</p>
      )}
    </section>
  );
}
