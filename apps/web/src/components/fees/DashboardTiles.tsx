import type { FeeDashboardDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { getJson } from '@/lib/api';

/**
 * Today's fee figures for Home (PLAN §14.11; M7b: the today card and "Needs attention" rows,
 * pages/Dashboard.tsx): collected by method, dues, defaulters, billing failures.
 */
export const useFeeDashboard = (enabled = true) =>
  useQuery({
    queryKey: ['fee-dashboard'],
    queryFn: () => getJson<FeeDashboardDto>('/api/dashboard/fees'),
    enabled,
  });
