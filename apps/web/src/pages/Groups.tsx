import type { GroupDetailDto, GroupDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ClipboardCheck, FileSpreadsheet, Layers } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { todayPk } from '@/components/attendance/common';
import { Avatar } from '@/components/avatar';
import { type Column, DataTable } from '@/components/data-table';
import { ErrorNote, Num } from '@/components/form';
import {
  ConfirmDialog,
  EmptyState,
  ListRow,
  ListSkeleton,
  Page,
  PageHeader,
  Panel,
  RowList,
  StatStrip,
  StatusBadge,
} from '@/components/page';
import { RowMenu } from '@/components/row-menu';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import '@/i18n/screens';
import { getJson, sendJson } from '@/lib/api';
import { canMark, registerPath } from '@/lib/attendance';
import { useCurrentSession, useGroups, useSessions } from '@/lib/queries';
import { canManageSettings, isTeacherOnly, useRoles } from '@/lib/roles';
import { isolate } from '@/lib/utils';

const groupName = (g: Pick<GroupDto, 'programme_name' | 'name'>) => `${g.programme_name} ${g.name}`;

/**
 * Move a group to the recycle bin from its row menu (UI plan §5.5). The API refuses a group anyone
 * was ever enrolled in (it keeps its history; close it instead); that refusal shows as an error.
 */
function useArchive(onDone?: () => void) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sendJson('POST', `/api/groups/${id}/archive`),
    onSuccess: async () => {
      await Promise.all(
        ['groups', 'recycle-bin'].map((k) => qc.invalidateQueries({ queryKey: [k] })),
      );
      toast.success(t('backup.recycle.archived'));
      onDone?.();
    },
  });
}

function ArchiveDialog({
  group,
  onClose,
  onDone,
}: {
  group: GroupDto;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const archive = useArchive(() => {
    onClose();
    onDone?.();
  });
  return (
    <ConfirmDialog
      open
      destructive
      title={t('screens.groups.archiveTitle', { name: isolate(groupName(group)) })}
      body={t('backup.recycle.archiveHint')}
      confirm={t('backup.recycle.archiveGroup')}
      pending={archive.isPending}
      onCancel={onClose}
      onConfirm={() => archive.mutate(group.id)}
    >
      <ErrorNote error={archive.error} />
    </ConfirmDialog>
  );
}

/** Groups by session with seats left; teachers get only their own (the API scopes the list). */
export function GroupsPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const sessions = useSessions().data?.items ?? [];
  const current = useCurrentSession();
  const [picked, setPicked] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<GroupDto | null>(null);
  const sessionId = picked ?? current?.id ?? null;
  const groups = useGroups({ session_id: sessionId });
  const items = groups.data?.items ?? [];
  const teacher = isTeacherOnly(roles);
  const manage = canManageSettings(roles);
  const students = items.reduce((n, g) => n + g.active_count, 0);
  const seats = items.reduce((n, g) => n + Math.max(0, g.seats_left ?? 0), 0);
  const noTeacher = items.filter((g) => !g.class_teacher_name).length;

  const columns: Column<GroupDto>[] = [
    {
      id: 'name',
      header: t('screens.groups.class'),
      primary: true,
      cell: (g) => (
        <span className="flex flex-wrap items-center gap-2">
          <bdi>{groupName(g)}</bdi>
          {!g.is_primary && <StatusBadge tone="info">{t('group.batchBadge')}</StatusBadge>}
          {g.status !== 'open' && (
            <StatusBadge tone="neutral">{t(`group.statuses.${g.status}`)}</StatusBadge>
          )}
        </span>
      ),
    },
    {
      id: 'teacher',
      header: t('group.classTeacher'),
      cell: (g) =>
        g.class_teacher_name ? (
          <bdi>{g.class_teacher_name}</bdi>
        ) : (
          <span className="text-muted-foreground">{t('screens.att.noClassTeacher')}</span>
        ),
    },
    {
      id: 'students',
      header: t('group.roster'),
      numeric: true,
      cell: (g) => <Num>{g.active_count}</Num>,
    },
    {
      id: 'seats',
      header: t('screens.groups.seats'),
      numeric: true,
      cell: (g) =>
        g.seats_left == null ? (
          '—'
        ) : g.seats_left > 0 ? (
          <Num>{g.seats_left}</Num>
        ) : (
          <StatusBadge tone="warn">{t('group.full')}</StatusBadge>
        ),
    },
    {
      id: 'subjects',
      header: t('screens.groups.subjects'),
      numeric: true,
      cell: (g) => <Num>{g.subjects.length}</Num>,
    },
  ];

  return (
    <Page width="full" className="max-w-[1200px]">
      <PageHeader
        title={teacher ? t('nav.myGroups') : t('shell.nav.classes')}
        actions={
          sessions.length > 1 && (
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
          )
        }
      />
      {items.length > 0 && (
        <StatStrip
          items={[
            {
              id: 'grp-count',
              label: t('screens.groups.groups'),
              value: <Num>{items.length}</Num>,
            },
            { id: 'grp-students', label: t('group.roster'), value: <Num>{students}</Num> },
            {
              id: 'grp-seats',
              label: t('screens.groups.seatsLeft'),
              value: <Num>{seats}</Num>,
            },
            {
              id: 'grp-no-teacher',
              label: t('screens.groups.noTeacher'),
              value: <Num>{noTeacher}</Num>,
            },
          ]}
        />
      )}
      <Panel>
        <DataTable
          id="groups-table"
          caption={teacher ? t('nav.myGroups') : t('shell.nav.classes')}
          columns={columns}
          rows={items}
          rowKey={(g) => g.id}
          rowHref={(g) => `/groups/${g.id}`}
          loading={groups.isPending}
          error={groups.error ? <ErrorNote error={groups.error} /> : undefined}
          rowActions={
            manage
              ? (g) => (
                  <RowMenu
                    label={t('screens.groups.more', { name: groupName(g) })}
                    actions={[
                      {
                        id: `archive-${g.id}`,
                        label: t('backup.recycle.archiveGroup'),
                        icon: Archive,
                        destructive: true,
                        onSelect: () => setArchiving(g),
                      },
                    ]}
                  />
                )
              : undefined
          }
          empty={<EmptyState icon={Layers} title={t('group.empty')} />}
        />
      </Panel>
      {archiving && <ArchiveDialog group={archiving} onClose={() => setArchiving(null)} />}
    </Page>
  );
}

export function GroupDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const roles = useRoles();
  const navigate = useNavigate();
  const [archiving, setArchiving] = useState(false);
  const group = useQuery({
    queryKey: ['group', id],
    queryFn: () => getJson<GroupDetailDto>(`/api/groups/${id}`),
    enabled: !!id,
  });
  if (group.isPending)
    return (
      <Page>
        <Panel>
          <ListSkeleton rows={5} />
        </Panel>
      </Page>
    );
  if (!group.data) return <p role="alert">{t('common.notFound')}</p>;
  const g = group.data;
  const manage = canManageSettings(roles);
  return (
    <Page>
      <PageHeader
        back={{
          to: '/groups',
          label: isTeacherOnly(roles) ? t('nav.myGroups') : t('shell.nav.classes'),
        }}
        title={<bdi>{groupName(g)}</bdi>}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={g.is_primary ? 'neutral' : 'info'}>
              {g.is_primary ? t('group.primaryBadge') : t('group.batchBadge')}
            </StatusBadge>
            {g.status !== 'open' && (
              <StatusBadge tone="neutral">{t(`group.statuses.${g.status}`)}</StatusBadge>
            )}
          </span>
        }
        actions={
          <>
            {canMark(roles) && (
              <Button asChild>
                <Link to={registerPath(g.id, todayPk())} id="group-take">
                  <ClipboardCheck aria-hidden />
                  {t('attendance.takeNow')}
                </Link>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link to={`/attendance/report?grp=${g.id}`}>
                <FileSpreadsheet aria-hidden />
                {t('attendance.report')}
              </Link>
            </Button>
            {manage && (
              <RowMenu
                id="group-more"
                label={t('screens.groups.more', { name: groupName(g) })}
                actions={[
                  {
                    id: 'group-archive',
                    label: t('backup.recycle.archiveGroup'),
                    icon: Archive,
                    destructive: true,
                    onSelect: () => setArchiving(true),
                  },
                ]}
              />
            )}
          </>
        }
      />
      <StatStrip
        items={[
          { id: 'grp-students', label: t('group.roster'), value: <Num>{g.active_count}</Num> },
          {
            id: 'grp-seats',
            label: t('screens.groups.seatsLeft'),
            value:
              g.seats_left == null ? (
                '—'
              ) : g.seats_left > 0 ? (
                <Num>{g.seats_left}</Num>
              ) : (
                t('group.full')
              ),
            note: g.capacity != null ? t('screens.groups.capacity', { n: g.capacity }) : undefined,
          },
          {
            id: 'grp-teacher',
            label: t('group.classTeacher'),
            value: g.class_teacher_name ? (
              <bdi className="text-base">{g.class_teacher_name}</bdi>
            ) : (
              <span className="text-base text-muted-foreground">
                {t('screens.att.noClassTeacher')}
              </span>
            ),
          },
          {
            id: 'grp-subjects',
            label: t('screens.groups.subjects'),
            value: <Num>{g.subjects.length}</Num>,
          },
        ]}
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)] lg:items-start">
        <Panel
          title={t('group.roster')}
          action={
            <span className="text-meta text-muted-foreground">
              {t('group.students', { count: g.roster.length })}
            </span>
          }
        >
          {g.roster.length === 0 ? (
            <EmptyState title={t('group.emptyRoster')} />
          ) : (
            <RowList>
              {g.roster.map((r) => (
                <ListRow
                  key={r.enrolment_id}
                  to={`/students/${r.student_id}`}
                  leading={
                    <>
                      <span className="w-7 shrink-0 text-center text-sm text-muted-foreground">
                        <Num>{r.roll_no ?? '—'}</Num>
                      </span>
                      <Avatar
                        name={r.name}
                        size="sm"
                        src={r.has_photo ? `/api/students/${r.student_id}/photo` : null}
                      />
                    </>
                  }
                  title={<bdi>{r.name}</bdi>}
                  meta={r.father_name ? <bdi>{r.father_name}</bdi> : undefined}
                  trailing={
                    <span className="text-meta text-muted-foreground">
                      <Num>{r.admission_no}</Num>
                    </span>
                  }
                />
              ))}
            </RowList>
          )}
        </Panel>
        <Panel title={t('group.subjects')}>
          {g.subjects.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('screens.groups.noSubjects')}</p>
          ) : (
            <RowList>
              {g.subjects.map((s) => (
                <ListRow
                  key={s.id}
                  title={<bdi>{s.subject_name}</bdi>}
                  meta={
                    s.teacher_name ? (
                      <bdi>{s.teacher_name}</bdi>
                    ) : (
                      t('screens.groups.noSubjectTeacher')
                    )
                  }
                />
              ))}
            </RowList>
          )}
        </Panel>
      </div>
      {archiving && (
        <ArchiveDialog
          group={g}
          onClose={() => setArchiving(false)}
          onDone={() => navigate('/groups')}
        />
      )}
    </Page>
  );
}
