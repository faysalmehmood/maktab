import { Route, Routes } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { Login } from '@/pages/Login';
import { Placeholder } from '@/pages/Placeholder';
import { SettingsPage } from '@/pages/Settings';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Placeholder title="nav.dashboard" />} />
        <Route path="students" element={<Placeholder title="nav.students" />} />
        <Route path="attendance" element={<Placeholder title="nav.attendance" />} />
        <Route path="fees" element={<Placeholder title="nav.fees" />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Placeholder title="common.error" />} />
    </Routes>
  );
}
