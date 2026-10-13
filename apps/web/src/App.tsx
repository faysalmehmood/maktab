import { type ComponentType, lazy, type ReactNode, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { RequireGrant } from '@/components/RequireGrant';
import { SetupGate } from '@/components/SetupGate';
import type { GrantRef } from '@/lib/roles';
import { Login } from '@/pages/Login';
import { Placeholder } from '@/pages/Placeholder';

// Office screens are split out so the teacher's phone does not download them up front; the dashboard
// too (M7: it pulls the fee and attendance widgets, which the login screen never needs).
const Dashboard = lazy(() => import('@/pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const DiagPage = lazy(() => import('@/pages/Diag').then((m) => ({ default: m.DiagPage })));
const SetupWizard = lazy(() => import('@/pages/Setup').then((m) => ({ default: m.SetupWizard })));
const SettingsPage = lazy(() =>
  import('@/pages/Settings').then((m) => ({ default: m.SettingsPage })),
);
const StudentsList = lazy(() =>
  import('@/pages/students/StudentsList').then((m) => ({ default: m.StudentsList })),
);
const StudentDetail = lazy(() =>
  import('@/pages/students/StudentDetail').then((m) => ({ default: m.StudentDetail })),
);
const StudentEdit = lazy(() =>
  import('@/pages/students/StudentEdit').then((m) => ({ default: m.StudentEdit })),
);
const AdmissionPage = lazy(() =>
  import('@/pages/students/Admission').then((m) => ({ default: m.AdmissionPage })),
);
const ImportPage = lazy(() =>
  import('@/pages/students/Import').then((m) => ({ default: m.ImportPage })),
);
const TodayPage = lazy(() =>
  import('@/pages/attendance/Today').then((m) => ({ default: m.TodayPage })),
);
const RegisterPage = lazy(() =>
  import('@/pages/attendance/Register').then((m) => ({ default: m.RegisterPage })),
);
const ReportPage = lazy(() =>
  import('@/pages/attendance/Report').then((m) => ({ default: m.ReportPage })),
);
const MessagesPage = lazy(() =>
  import('@/pages/Messages').then((m) => ({ default: m.MessagesPage })),
);
const ComposePage = lazy(() =>
  import('@/pages/messages/Compose').then((m) => ({ default: m.ComposePage })),
);
const ParentPage = lazy(() =>
  import('@/pages/parent/ParentPage').then((m) => ({ default: m.ParentPage })),
);
const GroupsPage = lazy(() => import('@/pages/Groups').then((m) => ({ default: m.GroupsPage })));
const GroupDetail = lazy(() => import('@/pages/Groups').then((m) => ({ default: m.GroupDetail })));

const lazyFees = <K extends string>(load: () => Promise<Record<K, () => ReactNode>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const FeesHome = lazyFees(() => import('@/pages/fees/FeesHome'), 'FeesHome');
const CounterPage = lazyFees(() => import('@/pages/fees/Counter'), 'CounterPage');
const ReceiptPage = lazyFees(() => import('@/pages/fees/Receipt'), 'ReceiptPage');
const FamilyStatementPage = lazyFees(
  () => import('@/pages/fees/FamilyStatement'),
  'FamilyStatementPage',
);
const DefaultersPage = lazyFees(() => import('@/pages/fees/Defaulters'), 'DefaultersPage');
const BillingPage = lazyFees(() => import('@/pages/fees/Billing'), 'BillingPage');
const CashPage = lazyFees(() => import('@/pages/fees/Cash'), 'CashPage');
const FeeRegisterPage = lazyFees(() => import('@/pages/fees/Reports'), 'FeeRegisterPage');
const ConcessionRegisterPage = lazyFees(
  () => import('@/pages/fees/Reports'),
  'ConcessionRegisterPage',
);
const SponsorsPage = lazyFees(() => import('@/pages/fees/Sponsors'), 'SponsorsPage');
const SponsorDetail = lazyFees(() => import('@/pages/fees/Sponsors'), 'SponsorDetail');

const ExpensesPage = lazyFees(() => import('@/pages/money/Expenses'), 'ExpensesPage');
const AdvancesPage = lazyFees(() => import('@/pages/money/Advances'), 'AdvancesPage');
const SalaryPage = lazyFees(() => import('@/pages/money/Salary'), 'SalaryPage');
const PayslipPage = lazyFees(() => import('@/pages/money/Salary'), 'PayslipPage');
const PayslipPrintPage = lazyFees(() => import('@/pages/money/Salary'), 'PayslipPrintPage');
const MyPayslipsPage = lazyFees(() => import('@/pages/money/Salary'), 'MyPayslipsPage');
const SalaryRegisterPage = lazyFees(() => import('@/pages/money/Salary'), 'SalaryRegisterPage');
const ReportsHub = lazyFees(() => import('@/pages/money/Reports'), 'ReportsHub');
const IncomeExpensePage = lazyFees(() => import('@/pages/money/Reports'), 'IncomeExpensePage');
const CashbookPage = lazyFees(() => import('@/pages/money/Reports'), 'CashbookPage');
const AccountsPage = lazyFees(() => import('@/pages/money/Reports'), 'AccountsPage');
const ExpenseRegisterPage = lazyFees(() => import('@/pages/money/Reports'), 'ExpenseRegisterPage');
const AdvanceRegisterPage = lazyFees(() => import('@/pages/money/Reports'), 'AdvanceRegisterPage');
const AuditPage = lazyFees(() => import('@/pages/money/Audit'), 'AuditPage');

/**
 * Money-out routes (M4), same shape as FEE_ROUTES: each page's main API call decides its grant.
 * The office payroll needs payslip.prepare (a teacher's payslip.read is own-only: "My payslips").
 */
export const MONEY_ROUTES: [string, ComponentType, GrantRef][] = [
  ['expenses', ExpensesPage, ['expense', 'read']],
  ['salary', SalaryPage, ['payslip', 'prepare']],
  ['salary/:id', PayslipPage, ['payslip', 'prepare']],
  ['payslips/:id/print', PayslipPrintPage, ['payslip', 'read']],
  ['my/payslips', MyPayslipsPage, ['payslip', 'read']],
  ['advances', AdvancesPage, ['payslip', 'pay']],
  ['reports', ReportsHub, ['receipt', 'read']],
  ['reports/income-expense', IncomeExpensePage, ['receipt', 'read']],
  ['reports/cashbook', CashbookPage, ['receipt', 'read']],
  ['reports/accounts', AccountsPage, ['receipt', 'read']],
  ['reports/expenses', ExpenseRegisterPage, ['expense', 'read']],
  ['reports/salaries', SalaryRegisterPage, ['payslip', 'prepare']],
  ['reports/advances', AdvanceRegisterPage, ['payslip', 'pay']],
  ['audit', AuditPage, ['audit', 'read']],
];

/** Messaging routes (M5): the send queue for message readers, compose for message.compose. */
export const MESSAGE_ROUTES: [string, ComponentType, GrantRef][] = [
  ['messages', MessagesPage, ['message', 'read']],
  ['messages/compose', ComposePage, ['message', 'compose']],
];

/**
 * Fee routes (M3b): path → page → the MATRIX grant its main API call needs. Each is lazily loaded
 * behind the shared Suspense and guarded: without the grant the URL redirects home with a toast.
 */
export const FEE_ROUTES: [string, ComponentType, GrantRef][] = [
  ['fees', FeesHome, ['receipt', 'read']],
  ['fees/counter', CounterPage, ['receipt', 'create']],
  ['fees/family/:id', FamilyStatementPage, ['receipt', 'read']],
  ['fees/defaulters', DefaultersPage, ['fee', 'read']],
  ['fees/billing', BillingPage, ['fee', 'generate']],
  ['fees/register', FeeRegisterPage, ['receipt', 'read']],
  ['fees/concessions', ConcessionRegisterPage, ['receipt', 'read']],
  ['fees/sponsors', SponsorsPage, ['receipt', 'read']],
  ['fees/sponsors/:id', SponsorDetail, ['receipt', 'read']],
  ['receipts/:id', ReceiptPage, ['receipt', 'read']],
  ['cash', CashPage, ['cash_session', 'read']],
];

function Loading({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<p className="p-4 text-muted-foreground">{t('common.loading')}</p>}>
      {children}
    </Suspense>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* The parent page (PLAN §14.10): public, no session, no app shell. */}
      <Route
        path="/p/*"
        element={
          <Loading>
            <ParentPage />
          </Loading>
        }
      />
      <Route
        path="/setup"
        element={
          <RequireAuth>
            <Loading>
              <SetupWizard />
            </Loading>
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <SetupGate>
              <AppShell />
            </SetupGate>
          </RequireAuth>
        }
      >
        <Route
          index
          element={
            <Loading>
              <Dashboard />
            </Loading>
          }
        />
        <Route
          path="students"
          element={
            <Loading>
              <StudentsList />
            </Loading>
          }
        />
        <Route
          path="students/new"
          element={
            <Loading>
              <AdmissionPage />
            </Loading>
          }
        />
        <Route
          path="students/import"
          element={
            <Loading>
              <ImportPage />
            </Loading>
          }
        />
        <Route
          path="students/:id"
          element={
            <Loading>
              <StudentDetail />
            </Loading>
          }
        />
        <Route
          path="students/:id/edit"
          element={
            <Loading>
              <StudentEdit />
            </Loading>
          }
        />
        <Route
          path="groups"
          element={
            <Loading>
              <GroupsPage />
            </Loading>
          }
        />
        <Route
          path="groups/:id"
          element={
            <Loading>
              <GroupDetail />
            </Loading>
          }
        />
        <Route
          path="attendance"
          element={
            <Loading>
              <TodayPage />
            </Loading>
          }
        />
        <Route
          path="attendance/register/:grpId"
          element={
            <Loading>
              <RegisterPage />
            </Loading>
          }
        />
        <Route
          path="attendance/report"
          element={
            <Loading>
              <ReportPage />
            </Loading>
          }
        />
        {[...FEE_ROUTES, ...MONEY_ROUTES, ...MESSAGE_ROUTES].map(([path, Page, grant]) => (
          <Route
            key={path}
            path={path}
            element={
              <RequireGrant grant={grant}>
                <Loading>
                  <Page />
                </Loading>
              </RequireGrant>
            }
          />
        ))}
        {/* Hidden device-check page (docs/android-checks.md): owner only, not in the nav. */}
        <Route
          path="diag"
          element={
            <RequireGrant grant={['role', 'manage']}>
              <Loading>
                <DiagPage />
              </Loading>
            </RequireGrant>
          }
        />
        <Route
          path="settings"
          element={
            <Loading>
              <SettingsPage />
            </Loading>
          }
        />
      </Route>
      <Route path="*" element={<Placeholder title="common.error" />} />
    </Routes>
  );
}
