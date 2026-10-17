import type { GroupDto, TeacherRowDto, TeachersDto } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEOPLE_ROUTES } from '@/App';
import { navFor } from '@/components/AppShell';
import { initI18n, setLanguage } from '@/i18n';
import { holds } from '@/lib/roles';
import { TeachersPage } from '@/pages/Teachers';
import { group, mockApi, renderAt, session } from './api-mock';

/*
 * Teachers page (2026-10-17): the teacher side of class and subject assignments. Table + phone
 * cards, the warnings strip, the allocation sheet writing through the group endpoints, the A4
 * printout's title, and the nav entry only for owner/admin.
 */

const A = '01JTEACHERAAAAAAAAAAAAAAA1';
const B = '01JTEACHERAAAAAAAAAAAAAAB1';
const G5 = '01JGRPAAAAAAAAAAAAAAAAAA05';
const G6 = '01JGRPAAAAAAAAAAAAAAAAAA06';
const G7 = '01JGRPAAAAAAAAAAAAAAAAAA07';
const G8 = '01JGRPAAAAAAAAAAAAAAAAAA08';
const MATHS = '01JSUBAAAAAAAAAAAAAAAAAAM1';
const ENGLISH = '01JSUBAAAAAAAAAAAAAAAAAAE1';
const GS6M = '01JGSAAAAAAAAAAAAAAAAAA6M1';
const GS6E = '01JGSAAAAAAAAAAAAAAAAAA6E1';
const GS7M = '01JGSAAAAAAAAAAAAAAAAAA7M1';

const grp = (id: string, n: number, over: Partial<GroupDto> = {}): GroupDto =>
  ({
    ...group,
    id,
    programme_name: `Class ${n}`,
    name: 'A',
    ...over,
  }) as GroupDto;

const groups: GroupDto[] = [
  grp(G5, 5, { class_teacher_id: A, class_teacher_name: 'Amina' }),
  grp(G6, 6, {
    class_teacher_id: B,
    class_teacher_name: 'Bilal',
    subjects: [
      { id: GS6M, subject_id: MATHS, subject_name: 'Maths', teacher_id: A, teacher_name: 'Amina' },
      {
        id: GS6E,
        subject_id: ENGLISH,
        subject_name: 'English',
        teacher_id: null,
        teacher_name: null,
      },
    ],
  }),
  grp(G7, 7, {
    class_teacher_id: B,
    class_teacher_name: 'Bilal',
    subjects: [
      { id: GS7M, subject_id: MATHS, subject_name: 'Maths', teacher_id: A, teacher_name: 'Amina' },
    ],
  }),
  grp(G8, 8),
];

const amina: TeacherRowDto = {
  staff_id: A,
  name: 'Amina',
  roles: ['teacher'],
  staff_status: 'active',
  class_teacher_of: [{ grp_id: G5, name: 'Class 5 A' }],
  subjects: [
    { grp_id: G6, grp_name: 'Class 6 A', grp_subject_id: GS6M, subject_name: 'Maths' },
    { grp_id: G7, grp_name: 'Class 7 A', grp_subject_id: GS7M, subject_name: 'Maths' },
  ],
  load: { groups: 3, subjects: 2 },
};
const bilal: TeacherRowDto = {
  staff_id: B,
  name: 'Bilal',
  roles: ['teacher'],
  staff_status: 'active',
  class_teacher_of: [
    { grp_id: G6, name: 'Class 6 A' },
    { grp_id: G7, name: 'Class 7 A' },
  ],
  subjects: [],
  load: { groups: 2, subjects: 0 },
};
const teachers = (items: TeacherRowDto[] = [amina, bilal]): TeachersDto => ({
  session_id: session.id,
  items,
  warnings: items.length
    ? {
        groups_without_class_teacher: [{ grp_id: G8, name: 'Class 8 A' }],
        subjects_without_teacher: [
          { grp_id: G6, grp_name: 'Class 6 A', grp_subject_id: GS6E, subject_name: 'English' },
        ],
        double_class_teachers: [{ staff_id: B, name: 'Bilal', groups: bilal.class_teacher_of }],
      }
    : { groups_without_class_teacher: [], subjects_without_teacher: [], double_class_teachers: [] },
});

const school = {
  school: {
    id: '01JSCHOOLAAAAAAAAAAAAAAAA1',
    name: 'Al-Noor School',
    name_ur: null,
    mode: 'school',
    address: 'Main Road',
    phone: null,
    default_lang: 'en',
    receipt_prefix: 'AN',
    has_logo: false,
    short_name: 'ANS',
    city: null,
    brand_color: null,
    setup_completed_at: '2026-04-01',
    attendance_mode: 'daily',
    weekly_off: [0],
  },
};

function api(items?: TeacherRowDto[]) {
  return mockApi({
    'GET /api/sessions': { items: [session] },
    'GET /api/school': school,
    'GET /api/teachers': teachers(items),
    'GET /api/groups': { items: groups },
    [`GET /api/groups/${G6}`]: { ...groups[1], roster: [] },
    [`PATCH /api/groups/${G8}`]: groups[3],
    [`PATCH /api/groups/${G6}`]: groups[1],
    [`PATCH /api/groups/${G5}`]: groups[0],
    [`PUT /api/groups/${G6}/subjects`]: groups[1],
  });
}

const flat = (s: string | null | undefined) => (s ?? '').replace(/[⁨⁩]/g, '');
const teacherCalls = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/teachers')).length;
/** An accessible-name matcher that ignores the isolates around data names. */
const nm = (want: string) => (name: string) => flat(name) === want;
const openMenu = async (name: string | RegExp | ((n: string) => boolean)) => {
  fireEvent.keyDown(await screen.findByRole('button', { name }), { key: 'Enter' });
  return screen.findByRole('menu');
};
const stubMedia = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const page = (path = '/teachers') => renderAt(path, '/teachers', <TeachersPage />);

describe('Teachers page', () => {
  it('lists each teacher with class teacher of, subjects and load', async () => {
    api();
    page();
    const table = await screen.findByRole('table', { name: 'Teachers' });
    const row = within(table).getByRole('row', { name: /Amina/ });
    const cells = within(row)
      .getAllByRole('cell')
      .map((c) => flat(c.textContent));
    expect(cells).toEqual([
      'Class 5 A',
      'Class 6 A Maths, Class 7 A Maths',
      '3 groups · 2 subjects',
    ]);
    const b = within(table).getByRole('row', { name: /Bilal/ });
    expect(flat(b.textContent)).toContain('Class 6 A, Class 7 A');
    expect(flat(b.textContent)).toContain('2 groups · 0 subjects');
    // The row opens the allocation card.
    expect(within(row).getByRole('link', { name: 'Amina' }).getAttribute('href')).toBe(
      `/teachers?teacher=${A}`,
    );
  });

  it('shows the warning counts, each linking to the rows concerned', async () => {
    api();
    page();
    const strip = await waitFor(() => {
      const el = document.getElementById('teachers-warn-class');
      if (!el) throw new Error('no strip');
      return el;
    });
    expect(flat(strip.textContent)).toContain('1');
    fireEvent.click(within(strip).getByRole('link'));
    const panel = await screen.findByRole('region', { name: 'Groups without a class teacher' });
    expect(
      within(panel)
        .getByRole('link', { name: /Class 8 A/ })
        .getAttribute('href'),
    ).toBe(`/groups/${G8}`);
    // Subjects without a teacher: the group's page.
    fireEvent.click(
      within(document.getElementById('teachers-warn-subject') as HTMLElement).getByRole('link'),
    );
    const sp = await screen.findByRole('region', { name: 'Subjects without a teacher' });
    expect(within(sp).getByRole('link', { name: /English/ })).toBeTruthy();
    // Class teacher of two groups: the table narrows to those teachers.
    fireEvent.click(
      within(document.getElementById('teachers-warn-double') as HTMLElement).getByRole('link'),
    );
    await screen.findByRole('region', { name: 'Class teacher of two or more groups' });
    const table = screen.getByRole('table', { name: 'Teachers' });
    await waitFor(() => expect(within(table).queryByRole('row', { name: /Amina/ })).toBeNull());
    expect(within(table).getByRole('row', { name: /Bilal/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Show all teachers' }));
    await waitFor(() => expect(within(table).getByRole('row', { name: /Amina/ })).toBeTruthy());
  });

  it('shows cards on a phone', async () => {
    stubMedia(true);
    api();
    page();
    const cards = await screen.findByRole('list', { name: 'Teachers' });
    expect(cards.getAttribute('data-layout')).toBe('cards');
    expect(flat(cards.textContent)).toContain('3 groups · 2 subjects');
  });

  it('empty school: teaches where to invite teachers', async () => {
    api([]);
    page();
    expect(await screen.findByText('No teachers yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Invite staff' }).getAttribute('href')).toBe(
      '/settings?section=staff',
    );
    expect((screen.getByRole('button', { name: 'Print' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('is in Urdu too', async () => {
    api();
    await act(() => setLanguage('ur'));
    page();
    expect(await screen.findByRole('heading', { name: 'اساتذہ' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'اساتذہ' });
    expect(flat(table.textContent)).toContain('3 گروپ · 2 مضامین');
    expect(flat(table.textContent)).toContain('Class 6 A Maths، Class 7 A Maths');
  });
});

describe('allocation sheet', () => {
  it('sets a class teacher through PATCH /api/groups/:id and refreshes the lists', async () => {
    const { calls } = api();
    page(`/teachers?teacher=${A}`);
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    const before = teacherCalls(calls);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set as class teacher of…' }));
    const pick = within(sheet).getByLabelText('Class or batch') as HTMLSelectElement;
    // Her own class is not offered; a group with a class teacher says who.
    const options = [...pick.options].map((o) => flat(o.textContent));
    expect(options).toEqual([
      'Choose…',
      'Class 6 A (now Bilal)',
      'Class 7 A (now Bilal)',
      'Class 8 A',
    ]);
    fireEvent.change(pick, { target: { value: G8 } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `/api/groups/${G8}`,
        body: { class_teacher_id: A },
      }),
    );
    await waitFor(() => expect(teacherCalls(calls)).toBeGreaterThan(before));
    expect(calls.filter((c) => c.path.startsWith('/api/groups?')).length).toBeGreaterThan(1);
  });

  it('asks before replacing another class teacher', async () => {
    const { calls } = api();
    page(`/teachers?teacher=${A}`);
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set as class teacher of…' }));
    fireEvent.change(within(sheet).getByLabelText('Class or batch'), { target: { value: G6 } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    const confirm = await screen.findByRole('dialog', { name: nm('Replace Bilal?') });
    expect(flat(confirm.textContent)).toContain(
      'Class 6 A already has Bilal as class teacher. Amina will take their place.',
    );
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `/api/groups/${G6}`,
        body: { class_teacher_id: A },
      }),
    );
  });

  it('adds a subject through PUT /api/groups/:id/subjects with the fresh full list', async () => {
    const { calls } = api();
    page(`/teachers?teacher=${A}`);
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add subject…' }));
    const g = within(sheet).getByLabelText('Class or batch') as HTMLSelectElement;
    // 7 A has only Maths, which she teaches: not offered.
    expect([...g.options].map((o) => o.textContent)).toEqual(['Choose…', 'Class 6 A']);
    fireEvent.change(g, { target: { value: G6 } });
    const s = within(sheet).getByLabelText('Subject') as HTMLSelectElement;
    expect([...s.options].map((o) => flat(o.textContent))).toEqual(['Choose…', 'English']);
    fireEvent.change(s, { target: { value: GS6E } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/api/groups/${G6}/subjects`,
        body: {
          subjects: [
            { subject_id: MATHS, teacher_id: A },
            { subject_id: ENGLISH, teacher_id: A },
          ],
        },
      }),
    );
    // Read fresh from the group just before the write.
    const i = calls.findIndex((c) => c.method === 'PUT');
    expect(calls.slice(0, i).some((c) => c.path === `/api/groups/${G6}`)).toBe(true);
  });

  it('removes a subject from its row menu after confirming', async () => {
    const { calls } = api();
    page(`/teachers?teacher=${A}`);
    await screen.findByRole('dialog', { name: 'Amina' });
    const before = teacherCalls(calls);
    const menu = await openMenu(nm('More actions: Class 6 A Maths'));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog', {
      name: nm('Remove Amina from Maths in Class 6 A?'),
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/api/groups/${G6}/subjects`,
        body: {
          subjects: [
            { subject_id: MATHS, teacher_id: null },
            { subject_id: ENGLISH, teacher_id: null },
          ],
        },
      }),
    );
    await waitFor(() => expect(teacherCalls(calls)).toBeGreaterThan(before));
  });

  it('removes a class teacher with PATCH class_teacher_id null', async () => {
    const { calls } = api();
    page(`/teachers?teacher=${A}`);
    await screen.findByRole('dialog', { name: 'Amina' });
    const menu = await openMenu(nm('More actions: Class 5 A'));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog', {
      name: nm('Remove Amina as class teacher of Class 5 A?'),
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `/api/groups/${G5}`,
        body: { class_teacher_id: null },
      }),
    );
  });
});

describe('print', () => {
  it('sets the document title and the A4 page while printing, then restores them', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    api();
    page();
    await screen.findByRole('table', { name: 'Teachers' });
    document.title = 'ANS · Maktab';
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(document.title).toBe('Teacher allocation 2026-27');
    const style = document.querySelector('style[data-print-page="teacher-a4"]');
    expect(style?.textContent).toContain('size: A4 portrait');
    await waitFor(() => expect(print).toHaveBeenCalled());
    // The printout: school header, one table, the principal's signature.
    const sheet = document.getElementById('teacher-allocation-print') as HTMLElement;
    expect(sheet.textContent).toContain('Al-Noor School');
    expect(flat(sheet.textContent)).toContain('Teacher allocation 2026-27');
    expect(within(sheet).getAllByRole('row')).toHaveLength(3);
    expect(sheet.textContent).toContain("Principal's signature");
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(document.title).toBe('ANS · Maktab');
    expect(document.querySelector('style[data-print-page="teacher-a4"]')).toBeNull();
  });
});

describe('who sees it', () => {
  it('is in the People menu for owner and admin only', () => {
    const paths = (r: Parameters<typeof navFor>[0]) => navFor(r).map((n) => n.to);
    expect(paths(['owner'])).toContain('/teachers');
    expect(paths(['admin'])).toContain('/teachers');
    expect(navFor(['owner']).find((n) => n.to === '/teachers')?.group).toBe('people');
    expect(paths(['teacher'])).not.toContain('/teachers');
    expect(paths(['accountant'])).not.toContain('/teachers');
    expect(paths(['teacher', 'accountant'])).not.toContain('/teachers');
    const route = PEOPLE_ROUTES.find(([p]) => p === 'teachers');
    expect(route).toBeDefined();
    const grant = route?.[2] as NonNullable<typeof route>[2];
    expect(holds(['owner'], grant)).toBe(true);
    expect(holds(['teacher'], grant)).toBe(false);
    expect(holds(['accountant'], grant)).toBe(false);
  });
});
