import type {
  CustomFieldDto,
  GroupDto,
  ProgrammeDto,
  SchoolResponse,
  SessionDto,
  StaffRowDto,
  SubjectDto,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { getJson } from './api';

type Items<T> = { items: T[] };

/** Reference data shared by many screens; one cache key each so a save refreshes every picker. */
export const useSchool = () =>
  useQuery({ queryKey: ['school'], queryFn: () => getJson<SchoolResponse>('/api/school') });

export const useSessions = () =>
  useQuery({ queryKey: ['sessions'], queryFn: () => getJson<Items<SessionDto>>('/api/sessions') });

export const useCurrentSession = (): SessionDto | null =>
  useSessions().data?.items.find((s) => s.is_current) ?? null;

export const useProgrammes = () =>
  useQuery({
    queryKey: ['programmes'],
    queryFn: () => getJson<Items<ProgrammeDto>>('/api/programmes'),
  });

export const useSubjects = () =>
  useQuery({ queryKey: ['subjects'], queryFn: () => getJson<Items<SubjectDto>>('/api/subjects') });

export const useCustomFields = () =>
  useQuery({
    queryKey: ['custom-fields'],
    queryFn: () => getJson<Items<CustomFieldDto>>('/api/custom-fields'),
  });

export const useStaff = (enabled = true) =>
  useQuery({
    queryKey: ['staff'],
    queryFn: () => getJson<Items<StaffRowDto>>('/api/staff'),
    enabled,
  });

export function useGroups(params: { session_id?: string | null; enabled?: boolean } = {}) {
  const qs = params.session_id ? `?session_id=${encodeURIComponent(params.session_id)}` : '';
  return useQuery({
    queryKey: ['groups', params.session_id ?? null],
    queryFn: () => getJson<Items<GroupDto>>(`/api/groups${qs}`),
    enabled: params.enabled ?? true,
  });
}

/** Groups the caller is class or subject teacher of (`mine=1`), whatever else their roles see. */
export function useMyGroups(enabled = true) {
  return useQuery({
    queryKey: ['groups', 'mine'],
    queryFn: () => getJson<Items<GroupDto>>('/api/groups?mine=1'),
    enabled,
  });
}
