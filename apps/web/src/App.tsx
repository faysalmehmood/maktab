import { lazy, type ReactNode, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { SetupGate } from '@/components/SetupGate';
import { Dashboard } from '@/pages/Dashboard';
import { Login } from '@/pages/Login';
import { Placeholder } from '@/pages/Placeholder';

// Office screens are split out so the teacher's phone does not download them up front.
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
const GroupsPage = lazy(() => import('@/pages/Groups').then((m) => ({ default: m.GroupsPage })));
const GroupDetail = lazy(() => import('@/pages/Groups').then((m) => ({ default: m.GroupDetail })));

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
        <Route index element={<Dashboard />} />
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
        <Route path="attendance" element={<Placeholder title="nav.attendance" />} />
        <Route path="fees" element={<Placeholder title="nav.fees" />} />
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
