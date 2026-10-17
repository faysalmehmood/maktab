import 'fake-indexeddb/auto';
import type { StaffRole, StudentDetailDto } from '@maktab/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { karachiToday, registerGroupKey } from '@/lib/fees';
import { FeeRegisterPage } from '@/pages/fees/Reports';
import { ComposePage } from '@/pages/messages/Compose';
import { StudentDetail } from '@/pages/students/StudentDetail';
import { group, ids, meAs, mockApi, renderAt } from './api-mock';

vi.mock('@/lib/image', async (orig) => ({
  ...(await orig<typeof import('@/lib/image')>()),
  resizeToJpeg: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
}));

/*
 * Gaps closed 2026-10-17: the student profile header's "Message family" (compose grant) and
 * avatar "Change photo" (student edit grant), and the Fee register opening on a class.
 */

const SCHOOL = '01JSCHOOLAAAAAAAAAAAAAAAA1';
const G2 = '01JAAAAAAAAAAAAAAAAAAAAAB3';
const stubResizeObserver = () =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
const byId = (id: string) =>
  waitFor(() => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  });
const openMenu = async (name: string | RegExp) => {
  fireEvent.keyDown(await screen.findByRole('button', { name }), { key: 'Enter' });
  return screen.findByRole('menu');
};

beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  stubResizeObserver();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const detail = (over: Partial<StudentDetailDto> = {}): StudentDetailDto => ({
  id: ids.student,
  family_id: ids.family,
  admission_no: '2026-0001',
  name: 'Ali Raza',
  father_name: 'Imran',
  dob: null,
  gender: 'm',
  b_form_no: null,
  has_photo: false,
  admission_date: '2026-04-01',
  status: 'active',
  left_date: null,
  left_reason: null,
  extra: {},
  family: { id: ids.family, name: 'Raza family', address: null, area: null },
  guardians: [],
  enrolments: [],
  ...over,
});
const familyDetail = { ...detail().family, guardians: [], students: [] };

const profileApi = (over: Partial<StudentDetailDto> = {}) =>
  mockApi({
    [`GET /api/students/${ids.student}`]: detail(over),
    [`GET /api/families/${ids.family}`]: familyDetail,
    'GET /api/custom-fields': { items: [] },
    [`POST /api/students/${ids.student}/photo`]: { ok: true },
  });

function Where() {
  const l = useLocation();
  return <p id="where">{l.pathname + l.search}</p>;
}

/** The profile plus a stub Compose route, so the menu's navigation can be read back. */
function renderProfile(roles: StaffRole[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['me'], meAs(roles));
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/students/${ids.student}`]}>
        <Routes>
          <Route path="/students/:id" element={<StudentDetail />} />
          <Route path="/messages/compose" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('profile header: "Message family"', () => {
  it('is in the overflow menu for the compose grant and opens Compose for the family', async () => {
    profileApi();
    renderProfile(['owner']);
    const menu = await openMenu('More actions: Ali Raza');
    const item = within(menu).getByRole('menuitem', { name: 'Message family' });
    // Exactly one entry point: not a header button as well.
    expect(screen.queryByRole('link', { name: 'Message family' })).toBeNull();
    fireEvent.click(item);
    expect((await byId('where')).textContent).toBe(`/messages/compose?family=${ids.family}`);
  });

  it('is absent without the compose grant (accountant) and for a student with no family', async () => {
    profileApi();
    const { unmount } = renderProfile(['accountant']);
    let menu = await openMenu('More actions: Ali Raza');
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Message family' })).toBeNull();
    unmount();
    profileApi({ family_id: '' });
    renderProfile(['owner']);
    menu = await openMenu('More actions: Ali Raza');
    expect(within(menu).queryByRole('menuitem', { name: 'Message family' })).toBeNull();
  });
});

describe('Compose: ?family= preselects that family', () => {
  it('picks the family by its name and switches the audience to chosen families', async () => {
    mockApi({
      'GET /api/sessions': { items: [] },
      'GET /api/groups': { items: [] },
      [`GET /api/families/${ids.family}`]: familyDetail,
    });
    renderAt(`/messages/compose?family=${ids.family}`, '/messages/compose', <ComposePage />);
    expect(await screen.findByText('Raza family')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Raza family' })).toBeTruthy();
    expect(document.getElementById('compose-kind-families')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((document.getElementById('compose-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores an unknown id silently (audience stays "All families", no error)', async () => {
    const api = mockApi({ 'GET /api/sessions': { items: [] }, 'GET /api/groups': { items: [] } });
    renderAt('/messages/compose?family=NOPE', '/messages/compose', <ComposePage />);
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/families/NOPE')).toBe(true));
    const send = (await byId('compose-send')) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(document.getElementById('compose-kind-all')?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('without the parameter asks for no family', async () => {
    const api = mockApi({ 'GET /api/sessions': { items: [] }, 'GET /api/groups': { items: [] } });
    renderAt('/messages/compose', '/messages/compose', <ComposePage />);
    await byId('compose-send');
    expect(api.calls.some((c) => c.path.startsWith('/api/families'))).toBe(false);
  });
});

describe('profile header avatar: "Change photo"', () => {
  it('opens the Overview photo picker, from any tab, and uploads through the same mutation', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:p', revokeObjectURL: () => undefined });
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const api = profileApi();
    renderProfile(['owner']);
    const avatar = await screen.findByRole('button', { name: 'Change photo' });
    expect(avatar.getAttribute('title')).toBe('Change photo');
    // From the Guardians tab: the click returns to Overview and opens the same file input.
    fireEvent.click(screen.getByRole('tab', { name: /Guardians/ }));
    expect(document.getElementById('student-photo')).toBeNull();
    fireEvent.click(avatar);
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(click).toHaveBeenCalledTimes(1);
    expect((click.mock.contexts[0] as HTMLInputElement).id).toBe('student-photo');
    // The Overview control is still there; a picked file goes up with its Upload button.
    expect(screen.getByText('Take or choose photo')).toBeTruthy();
    const input = document.getElementById('student-photo') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'p.jpg')] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Upload photo' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/photo'))).toBe(true),
    );
  });

  it('is a plain avatar without the edit grant', async () => {
    profileApi();
    renderProfile(['teacher']);
    await byId('student-avatar');
    expect(screen.queryByRole('button', { name: 'Change photo' })).toBeNull();
    expect(document.getElementById('student-change-photo')).toBeNull();
    expect(document.getElementById('student-avatar')?.closest('button')).toBeNull();
  });
});

describe('Fee register opens on a class', () => {
  const groups = { items: [group, { ...group, id: G2, name: 'B' }] };
  const register = { rows: [], totals: {} };
  const schoolApi = { school: { id: SCHOOL, name: 'Al-Noor' } };
  const registerCalls = (api: ReturnType<typeof mockApi>) =>
    api.calls.filter((c) => c.path.startsWith('/api/fees/register?')).map((c) => c.path);

  it('defaults to the first group, this month, and remembers a pick per installation', async () => {
    const api = mockApi({
      'GET /api/groups': groups,
      'GET /api/school': schoolApi,
      'GET /api/fees/register': register,
    });
    const { unmount } = renderAt('/fees/register', '/fees/register', <FeeRegisterPage />);
    const select = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(ids.group));
    // No "Choose a class" option once a class is chosen.
    expect(select.options.length).toBe(2);
    const month = karachiToday().slice(0, 7);
    await waitFor(() =>
      expect(registerCalls(api)).toContain(
        `/api/fees/register?grp_id=${ids.group}&period=${month}`,
      ),
    );
    expect(screen.queryByText('Choose a class to see its register')).toBeNull();
    fireEvent.change(select, { target: { value: G2 } });
    expect(localStorage.getItem(registerGroupKey(SCHOOL))).toBe(G2);
    unmount();
    renderAt('/fees/register', '/fees/register', <FeeRegisterPage />);
    const again = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(again.value).toBe(G2));
  });

  it('falls back when the remembered group is gone', async () => {
    localStorage.setItem(registerGroupKey(SCHOOL), 'GONE');
    mockApi({
      'GET /api/groups': groups,
      'GET /api/school': schoolApi,
      'GET /api/fees/register': register,
    });
    renderAt('/fees/register', '/fees/register', <FeeRegisterPage />);
    const select = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(ids.group));
  });

  it('a teacher (with an office role) opens on their first own group, then on what they pick', async () => {
    mockApi({
      'GET /api/groups': (url: URL) =>
        url.searchParams.get('mine') === '1'
          ? { items: [{ ...group, id: G2, name: 'B' }] }
          : groups,
      'GET /api/school': schoolApi,
      'GET /api/fees/register': register,
    });
    const { unmount } = renderAt('/fees/register', '/fees/register', <FeeRegisterPage />, [
      'teacher',
      'accountant',
    ]);
    const select = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(G2));
    fireEvent.change(select, { target: { value: ids.group } });
    unmount();
    renderAt('/fees/register', '/fees/register', <FeeRegisterPage />, ['teacher', 'accountant']);
    const again = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(again.value).toBe(ids.group));
  });

  it('a non-teacher never asks for own groups', async () => {
    const api = mockApi({
      'GET /api/groups': groups,
      'GET /api/school': schoolApi,
      'GET /api/fees/register': register,
    });
    renderAt('/fees/register', '/fees/register', <FeeRegisterPage />, ['accountant']);
    const select = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(ids.group));
    expect(api.calls.some((c) => c.path.includes('mine=1'))).toBe(false);
  });

  it('keeps "Choose a class" only when there are no groups at all', async () => {
    const api = mockApi({ 'GET /api/groups': { items: [] }, 'GET /api/school': schoolApi });
    renderAt('/fees/register', '/fees/register', <FeeRegisterPage />);
    expect(await screen.findByText('Choose a class to see its register')).toBeTruthy();
    expect(registerCalls(api)).toEqual([]);
  });

  it('works when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mockApi({
      'GET /api/groups': groups,
      'GET /api/school': schoolApi,
      'GET /api/fees/register': register,
    });
    renderAt('/fees/register', '/fees/register', <FeeRegisterPage />);
    const select = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(ids.group));
    fireEvent.change(select, { target: { value: G2 } });
    expect(select.value).toBe(G2);
  });
});
