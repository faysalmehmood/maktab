import type { GuideRole } from './types';

/**
 * Who each guide task is for. Tiny and on its own so a screen's "?" button can decide whether to
 * show (the task text itself loads only when the button is pressed).
 */
export const TASK_ROLES = {
  'first-week': ['owner'],
  'take-attendance': ['owner', 'admin', 'teacher'],
  'send-messages': ['owner', 'admin', 'accountant', 'teacher'],
  'admit-student': ['owner', 'admin', 'accountant'],
  'admit-sibling': ['owner', 'admin', 'accountant'],
  'collect-fee': ['owner', 'admin', 'accountant'],
  'reduce-fee': ['owner', 'admin'],
  'close-cash': ['owner', 'admin', 'accountant'],
  'generate-fees': ['owner', 'admin'],
  'apply-fines': ['owner', 'admin'],
  defaulters: ['owner', 'admin', 'accountant'],
  'income-expense': ['owner', 'admin', 'accountant'],
  'parent-links': ['owner', 'admin', 'accountant'],
  'parent-view': ['owner', 'admin', 'accountant', 'teacher'],
  'invite-staff': ['owner'],
  roles: ['owner', 'admin'],
  'who-teaches': ['owner', 'admin'],
  payslips: ['owner', 'admin', 'accountant'],
  'my-payslips': ['teacher'],
  backups: ['owner'],
  'restore-drill': ['owner'],
  'download-everything': ['owner'],
  'install-app': ['owner', 'admin', 'accountant', 'teacher'],
  offline: ['owner', 'admin', 'accountant', 'teacher'],
  printing: ['owner', 'admin', 'accountant'],
  whatsapp: ['owner', 'admin', 'accountant', 'teacher'],
} as const satisfies Record<string, readonly GuideRole[]>;

export type GuideTaskId = keyof typeof TASK_ROLES;

/** Is this task for any of these roles? */
export const helpFor = (id: GuideTaskId, roles: readonly string[]): boolean =>
  TASK_ROLES[id].some((r) => roles.includes(r));
