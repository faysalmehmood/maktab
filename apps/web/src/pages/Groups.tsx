import type { GroupDetailDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { Num, PageTitle } from '@/components/form';
import { GroupCard } from '@/components/setup/groups';
import { Select } from '@/components/ui/select';
import { getJson } from '@/lib/api';
import { useCurrentSession, useGroups, useSessions } from '@/lib/queries';
import { isTeacherOnly, useRoles } from '@/lib/roles';

/** Groups by session with seats left; teachers get only their own (the API scopes the list). */
export function GroupsPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const sessions = useSessions().data?.items ?? [];
  const current = useCurrentSession();
  const [picked, setPicked] = useState<string | null>(null);
  const sessionId = picked ?? current?.id ?? null;
  const groups = useGroups({ session_id: sessionId });
  const items = groups.data?.items ?? [];
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle>{isTeacherOnly(roles) ? t('nav.myGroups') : t('group.title')}</PageTitle>
      {sessions.length > 1 && (
        <Select
          aria-label={t('group.session')}
          value={sessionId ?? ''}
          onChange={(e) => setPicked(e.target.value)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
      {groups.isPending ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">{t('group.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((g) => (
            <li key={g.id}>
              <Link to={`/groups/${g.id}`} className="block hover:bg-accent/50">
                <GroupCard g={g} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function GroupDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const group = useQuery({
    queryKey: ['group', id],
    queryFn: () => getJson<GroupDetailDto>(`/api/groups/${id}`),
    enabled: !!id,
  });
  if (group.isPending) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  if (!group.data) return <p role="alert">{t('common.notFound')}</p>;
  const g = group.data;
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle>
        {g.programme_name} · <bdi>{g.name}</bdi>
      </PageTitle>
      <GroupCard g={g} />
      <h2 className="font-medium">{t('group.roster')}</h2>
      {g.roster.length === 0 ? (
        <p className="text-muted-foreground">{t('group.emptyRoster')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {g.roster.map((r) => (
            <li key={r.enrolment_id}>
              <Link
                to={`/students/${r.student_id}`}
                className="flex min-h-12 items-center gap-3 px-3 hover:bg-accent"
              >
                <span className="w-10 text-muted-foreground">
                  <Num>{r.roll_no ?? '—'}</Num>
                </span>
                <span className="flex-1">
                  {r.name}
                  {r.father_name && (
                    <span className="text-sm text-muted-foreground"> · {r.father_name}</span>
                  )}
                </span>
                <span className="text-sm text-muted-foreground">
                  <Num>{r.admission_no}</Num>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
