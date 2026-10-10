import {
  type AdvanceListDto,
  type ExpenseCategoryDto,
  hasGrant,
  type PayrollStaffDto,
  type PayslipDetailDto,
  type PayslipListDto,
  type StaffRole,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { getJson } from './api';
import type { Account } from './fees';

/**
 * Money out (M4) on the web: queries and the UI-side grant checks, all derived from the shared MATRIX
 * (the API enforces the same rules; these only hide what a role cannot do).
 */

export const canReadExpenses = (r: readonly StaffRole[]) => hasGrant(r, 'expense', 'read');
export const canCreateExpense = (r: readonly StaffRole[]) => hasGrant(r, 'expense', 'create');
export const canVoidExpense = (r: readonly StaffRole[]) => hasGrant(r, 'expense', 'void');
export const canPreparePayroll = (r: readonly StaffRole[]) => hasGrant(r, 'payslip', 'prepare');
export const canApprovePayslip = (r: readonly StaffRole[]) => hasGrant(r, 'payslip', 'approve');
export const canPaySalary = (r: readonly StaffRole[]) => hasGrant(r, 'payslip', 'pay');
export const canReadAudit = (r: readonly StaffRole[]) => hasGrant(r, 'audit', 'read');
export const canReadMoneyReports = (r: readonly StaffRole[]) => hasGrant(r, 'receipt', 'read');
/** Holds payslip.read only for themself (teachers): "My payslips" instead of the office payroll. */
export const ownPayslipsOnly = (r: readonly StaffRole[]) =>
  hasGrant(r, 'payslip', 'read') && !hasGrant(r, 'payslip', 'prepare');

export const useExpenseCategories = (enabled = true) =>
  useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => getJson<{ categories: ExpenseCategoryDto[] }>('/api/expenses/categories'),
    enabled,
    staleTime: 5 * 60_000,
  });

export const usePayslips = (period: string) =>
  useQuery({
    queryKey: ['payslips', period],
    queryFn: () => getJson<PayslipListDto>(`/api/payslips?period=${period}`),
    enabled: /^\d{4}-\d{2}$/.test(period),
  });

export const payslipKey = (id: string | undefined) => ['payslip', id] as const;

export const usePayslip = (id: string | undefined) =>
  useQuery({
    queryKey: payslipKey(id),
    queryFn: () => getJson<{ payslip: PayslipDetailDto }>(`/api/payslips/${id}`),
    enabled: !!id,
  });

export const useMyPayslips = () =>
  useQuery({
    queryKey: ['payslips', 'mine'],
    queryFn: () => getJson<{ payslips: PayslipDetailDto[] }>('/api/payslips/mine'),
  });

export const usePayrollStaff = (enabled = true) =>
  useQuery({
    queryKey: ['payroll-staff'],
    queryFn: () => getJson<{ staff: PayrollStaffDto[] }>('/api/payroll/staff'),
    enabled,
  });

export const useAdvances = () =>
  useQuery({
    queryKey: ['advances'],
    queryFn: () => getJson<AdvanceListDto>('/api/advances'),
  });

/** "HBL (bank)" — the account's own name is data (isolated by the caller), the kind translated. */
export const accountKindKey = (kind: Account['kind'] | string | null) =>
  kind === 'cash'
    ? ('money.common.drawer' as const)
    : kind === 'wallet'
      ? ('money.common.wallet' as const)
      : ('money.common.bank' as const);

/** Category (or fee head) label in the UI language. */
export const nameIn = (row: { name: string; name_ur: string | null }, lang: string) =>
  lang === 'ur' && row.name_ur ? row.name_ur : row.name;

/** The month a date falls in, and the month list for a picker. */
export const monthOf = (date: string) => date.slice(0, 7);
