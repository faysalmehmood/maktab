import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useMe } from '@/lib/api';
import { useSchool } from '@/lib/queries';

/**
 * First run (PLAN §14.1): an owner whose school is not set up yet lands in the wizard. Everyone
 * else gets the app; the dashboard tells them setup is unfinished.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const owner = useMe().data?.roles.includes('owner') ?? false;
  const school = useSchool();
  if (owner && school.isSuccess && !school.data.school?.setup_completed_at) {
    return <Navigate to="/setup" replace />;
  }
  return children;
}
