import {
  type AttendanceReport,
  type DashboardTodayResponse,
  type HolidayDto,
  hasGrant,
  type MarkStatus,
  type RegisterResponse,
  type StaffRole,
  type StudentAttendanceResponse,
  type TodayResponse,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getJson } from './api';

/**
 * A refused register's reason as a sentence (SyncRejectCode or HTTP error code); the date makes
 * "future date" concrete. Unknown codes fall back to the generic sentence.
 */
export function useRejectionText() {
  const { t, i18n } = useTranslation();
  return (code: string | null | undefined, date?: string): string => {
    if (code === 'future_date' && date) return t('errors.future_date_on', { date });
    const key = `errors.${code ?? 'generic'}`;
    return i18n.exists(key) ? String(t(key as 'errors.generic')) : t('errors.generic');
  };
}

/** Tap order on the register: present → absent → late → leave → present. */
export const STATUS_CYCLE: MarkStatus[] = ['P', 'A', 'L', 'E'];
export const nextStatus = (s: MarkStatus): MarkStatus =>
  STATUS_CYCLE[(STATUS_CYCLE.indexOf(s) + 1) % STATUS_CYCLE.length] ?? 'P';

/** Colour + letter, never colour alone (colour-blind teachers, sunlight on a cheap screen). */
export const STATUS_CLASS: Record<MarkStatus, string> = {
  P: 'bg-ok-soft text-ok ring-1 ring-ok/40',
  A: 'bg-bad-soft text-bad ring-1 ring-bad/40',
  L: 'bg-warn-soft text-warn ring-1 ring-warn/40',
  E: 'bg-info-soft text-info ring-1 ring-info/40',
};

export const canMark = (r: readonly StaffRole[]) => hasGrant(r, 'attendance', 'mark');
export const canCorrect = (r: readonly StaffRole[]) => hasGrant(r, 'attendance', 'correct');
export const canReadAttendance = (r: readonly StaffRole[]) => hasGrant(r, 'attendance', 'read');
export const canReadMessages = (r: readonly StaffRole[]) => hasGrant(r, 'message', 'read');

const qs = (params: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useToday = (date?: string | null, enabled = true) =>
  useQuery({
    queryKey: ['attendance', 'today', date ?? null],
    queryFn: () => getJson<TodayResponse>(`/api/attendance/today${qs({ date })}`),
    enabled,
  });

export const registerPath = (grpId: string, date: string, subject?: string | null) =>
  `/attendance/register/${grpId}${qs({ date, subject })}`;

export const useRegister = (grpId: string | undefined, date: string, subject: string) =>
  useQuery({
    queryKey: ['attendance', 'register', grpId, date, subject],
    queryFn: () =>
      getJson<RegisterResponse>(
        `/api/attendance/register${qs({ grp_id: grpId, date, grp_subject_id: subject })}`,
      ),
    enabled: !!grpId,
    // The roster is what an offline save needs: keep it as long as the tab lives.
    gcTime: Number.POSITIVE_INFINITY,
  });

export const useDashboardToday = (enabled: boolean) =>
  useQuery({
    queryKey: ['attendance', 'dashboard'],
    queryFn: () => getJson<DashboardTodayResponse>('/api/dashboard/today'),
    enabled,
  });

export const useHolidays = () =>
  useQuery({
    queryKey: ['holidays'],
    queryFn: () => getJson<{ items: HolidayDto[] }>('/api/holidays'),
  });

export const useStudentAttendance = (id: string | undefined, month: string, enabled = true) => {
  const from = `${month}-01`;
  const to = monthEnd(month);
  return useQuery({
    queryKey: ['attendance', 'student', id, month],
    queryFn: () =>
      getJson<StudentAttendanceResponse>(`/api/attendance/student/${id}${qs({ from, to })}`),
    enabled: !!id && enabled,
  });
};

export const reportUrl = (grpId: string, month: string, subject: string, format?: 'csv') =>
  `/api/attendance/report${qs({ grp_id: grpId, month, grp_subject_id: subject, format })}`;

export const useReport = (grpId: string | null, month: string, subject: string) =>
  useQuery({
    queryKey: ['attendance', 'report', grpId, month, subject],
    queryFn: () => getJson<AttendanceReport>(reportUrl(grpId ?? '', month, subject)),
    enabled: !!grpId,
  });

/** "2026-10" → "2026-10-31". */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(d).padStart(2, '0')}`;
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/** Time of day of an ISO instant, in the phone's clock (24 h, Latin digits). */
export const timeOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

/** "Ali Khan" → "AK"; works for Urdu names too (first letters). */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
