import type { SchoolIdentityDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { getJson } from '@/lib/api';

/** The school's public face (GET /api/identity, no session): null school before setup; `demo` on the demo. */
export const useIdentity = () =>
  useQuery({
    queryKey: ['identity'],
    queryFn: () => getJson<SchoolIdentityDto>('/api/identity'),
    staleTime: 5 * 60_000,
    retry: false,
  });
