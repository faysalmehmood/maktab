import type { GroupDetailDto, GroupDto, TeachersDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getJson, sendJson } from './api';

export const teachersKey = (sessionId: string | null) => ['teachers', sessionId] as const;

/** GET /api/teachers for a session (null: the API's current session). */
export function useTeachers(sessionId: string | null, enabled = true) {
  const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
  return useQuery({
    queryKey: teachersKey(sessionId),
    queryFn: () => getJson<TeachersDto>(`/api/teachers${qs}`),
    enabled,
  });
}

/**
 * One assignment change, always through the group endpoints (the class side's own write path, with
 * its audit row): class teacher via PATCH /api/groups/:id, a subject's teacher via
 * PUT /api/groups/:id/subjects. `expect` is the teacher the user was shown there (null: nobody):
 * the group is read fresh first, and if someone changed it meanwhile the write stops with a
 * ChangedError carrying who is there now, so the user is asked again with the right name. The
 * PUT replaces the group's whole subject list, so it is built from that fresh read and only the
 * one subject's teacher changes: a subject added meanwhile on the class side is never dropped.
 */
export type AssignChange =
  | { kind: 'class'; grpId: string; staffId: string | null; expectClassTeacherId: string | null }
  | {
      kind: 'subject';
      grpId: string;
      grpSubjectId: string;
      staffId: string | null;
      expectTeacherId: string | null;
    };

/** The target changed since the user saw it: who holds it now. */
export class ChangedError extends Error {
  constructor(
    readonly change: AssignChange,
    readonly current: { id: string | null; name: string | null },
  ) {
    super('changed');
  }
}

export async function applyAssignment(change: AssignChange): Promise<GroupDto> {
  const g = await getJson<GroupDetailDto>(`/api/groups/${change.grpId}`);
  if (change.kind === 'class') {
    if (g.class_teacher_id !== change.expectClassTeacherId)
      throw new ChangedError(change, { id: g.class_teacher_id, name: g.class_teacher_name });
    return sendJson<GroupDto>('PATCH', `/api/groups/${change.grpId}`, {
      class_teacher_id: change.staffId,
    });
  }
  const target = g.subjects.find((s) => s.id === change.grpSubjectId);
  // Removed from the group meanwhile (class side): nothing to change, say so.
  if (!target) throw new Error('not_found');
  if (target.teacher_id !== change.expectTeacherId)
    throw new ChangedError(change, { id: target.teacher_id, name: target.teacher_name });
  return sendJson<GroupDto>('PUT', `/api/groups/${change.grpId}/subjects`, {
    subjects: g.subjects.map((s) => ({
      subject_id: s.subject_id,
      teacher_id: s.id === change.grpSubjectId ? change.staffId : s.teacher_id,
    })),
  });
}

/**
 * The mutation every allocation control uses; refreshes the groups and teachers lists after a
 * write, and after a ChangedError too (the screen is out of date).
 */
export function useAssign(
  onDone?: (change: AssignChange) => void,
  onChanged?: (e: ChangedError) => void,
) {
  const qc = useQueryClient();
  const refresh = (grpId: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['groups'] }),
      qc.invalidateQueries({ queryKey: ['teachers'] }),
      qc.invalidateQueries({ queryKey: ['group', grpId] }),
    ]);
  return useMutation({
    mutationFn: applyAssignment,
    onSuccess: async (_g, change) => {
      await refresh(change.grpId);
      onDone?.(change);
    },
    onError: async (e, change) => {
      if (!(e instanceof ChangedError)) return;
      await refresh(change.grpId);
      onChanged?.(e);
    },
  });
}
