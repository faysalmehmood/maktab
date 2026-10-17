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
 * PUT /api/groups/:id/subjects. That PUT replaces the group's whole subject list, so the list is
 * read fresh from the group just before and only the one subject's teacher changes: a subject added
 * meanwhile on the class side is never dropped.
 */
export type AssignChange =
  | { kind: 'class'; grpId: string; staffId: string | null }
  | { kind: 'subject'; grpId: string; grpSubjectId: string; staffId: string | null };

export async function applyAssignment(change: AssignChange): Promise<GroupDto> {
  if (change.kind === 'class')
    return sendJson<GroupDto>('PATCH', `/api/groups/${change.grpId}`, {
      class_teacher_id: change.staffId,
    });
  const g = await getJson<GroupDetailDto>(`/api/groups/${change.grpId}`);
  // Removed from the group meanwhile (class side): nothing to change, say so.
  if (!g.subjects.some((s) => s.id === change.grpSubjectId)) throw new Error('not_found');
  return sendJson<GroupDto>('PUT', `/api/groups/${change.grpId}/subjects`, {
    subjects: g.subjects.map((s) => ({
      subject_id: s.subject_id,
      teacher_id: s.id === change.grpSubjectId ? change.staffId : s.teacher_id,
    })),
  });
}

/** The mutation every allocation control uses; refreshes the groups and teachers lists. */
export function useAssign(onDone?: (change: AssignChange) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: applyAssignment,
    onSuccess: async (_g, change) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['groups'] }),
        qc.invalidateQueries({ queryKey: ['teachers'] }),
        qc.invalidateQueries({ queryKey: ['group', change.grpId] }),
      ]);
      onDone?.(change);
    },
  });
}
