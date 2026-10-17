import type { GroupDto, TeacherRowDto, TeacherSubjectRef, TeachersDto } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEOPLE_ROUTES } from '@/App';
import { navFor } from '@/components/AppShell';
import { initI18n, setLanguage } from '@/i18n';
import { holds } from '@/lib/roles';
import { applyAssignment, ChangedError } from '@/lib/teachers';
import { setShellTitle } from '@/lib/title';
import { TeachersPage } from '@/pages/Teachers';
import { group, mockApi, renderAt, session } from './api-mock';

/*
 * Teachers page (2026-10-17): the teacher side of class and subject assignments. Table + phone
 * cards, the warnings strip, the allocation sheet writing through the group endpoints (with a
 * fresh read and a "changed meanwhile" check), the A4 printout's title, and the nav entry only for
 * owner/admin.
 */

const A = '01JTEACHERAAAAAAAAAAAAAAA1';
const B = '01JTEACHERAAAAAAAAAAAAAAB1';
const N = '01JTEACHERAAAAAAAAAAAAAAN1';
const G5 = '01JGRPAAAAAAAAAAAAAAAAAA05';
const G6 = '01JGRPAAAAAAAAAAAAAAAAAA06';
const G7 = '01JGRPAAAAAAAAAAAAAAAAAA07';
const G8 = '01JGRPAAAAAAAAAAAAAAAAAA08';
const MATHS = '01JSUBAAAAAAAAAAAAAAAAAAM1';
const ENGLISH = '01JSUBAAAAAAAAAAAAAAAAAAE1';
const URDU = '01JSUBAAAAAAAAAAAAAAAAAAU1';
const GS6M = '01JGSAAAAAAAAAAAAAAAAAA6M1';
const GS6E = '01JGSAAAAAAAAAAAAAAAAAA6E1';
const GS6U = '01JGSAAAAAAAAAAAAAAAAAA6U1';
const GS7M = '01JGSAAAAAAAAAAAAAAAAAA7M1';
const GS7E = '01JGSAAAAAAAAAAAAAAAAAA7E1';
const S2 = '01JAAAAAAAAAAAAAAAAAAAAAS2';

const grp = (id: string, n: number, over: Partial<GroupDto> = {}): GroupDto =>
  ({
    ...group,
    id,
    programme_name: `Class ${n}`,
    name: 'A',
    ...over,
  }) as GroupDto;

const sub = (
  id: string,
  subject_id: string,
  subject_name: string,
  teacher?: [string, string],
): GroupDto['subjects'][number] => ({
  id,
  subject_id,
  subject_name,
  teacher_id: teacher?.[0] ?? null,
  teacher_name: teacher?.[1] ?? null,
});

const groups: GroupDto[] = [
  grp(G5, 5, { class_teacher_id: A, class_teacher_name: 'Amina' }),
  grp(G6, 6, {
    class_teacher_id: B,
    class_teacher_name: 'Bilal',
    subjects: [sub(GS6M, MATHS, 'Maths', [A, 'Amina']), sub(GS6E, ENGLISH, 'English')],
  }),
  grp(G7, 7, {
    class_teacher_id: B,
    class_teacher_name: 'Bilal',
    subjects: [
      sub(GS7M, MATHS, 'Maths', [A, 'Amina']),
      sub(GS7E, ENGLISH, 'English', [B, 'Bilal']),
    ],
  }),
  grp(G8, 8),
];
const detail = (g: GroupDto, over: Partial<GroupDto> = {}) => ({ ...g, ...over, roster: [] });

const ref = (g: string, n: number, gs: string, subject: string): TeacherSubjectRef => ({
  grp_id: g,
  grp_name: `Class ${n} A`,
  programme_name: `Class ${n}`,
  group_name: 'A',
  grp_subject_id: gs,
  subject_name: subject,
});

const amina: TeacherRowDto = {
  staff_id: A,
  name: 'Amina',
  roles: ['teacher'],
  staff_status: 'active',
  class_teacher_of: [{ grp_id: G5, name: 'Class 5 A' }],
  subjects: [ref(G6, 6, GS6M, 'Maths'), ref(G7, 7, GS7M, 'Maths')],
  load: { groups: 3, subjects: 1 },
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
  subjects: [ref(G7, 7, GS7E, 'English')],
  load: { groups: 2, subjects: 1 },
};
const teachers = (items: TeacherRowDto[] = [amina, bilal]): TeachersDto => ({
  session_id: session.id,
  items,
  warnings: items.length
    ? {
        groups_without_class_teacher: [{ grp_id: G8, name: 'Class 8 A' }],
        subjects_without_teacher: [ref(G6, 6, GS6E, 'English')],
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

const [g5, g6, g7, g8] = groups as [GroupDto, GroupDto, GroupDto, GroupDto];

function api(items?: TeacherRowDto[], over: Record<string, unknown> = {}) {
  return mockApi({
    'GET /api/sessions': { items: [session] },
    'GET /api/school': school,
    'GET /api/teachers': teachers(items),
    'GET /api/groups': { items: groups },
    [`GET /api/groups/${G5}`]: detail(g5),
    [`GET /api/groups/${G6}`]: detail(g6),
    [`GET /api/groups/${G7}`]: detail(g7),
    [`GET /api/groups/${G8}`]: detail(g8),
    [`PATCH /api/groups/${G8}`]: g8,
    [`PATCH /api/groups/${G6}`]: g6,
    [`PATCH /api/groups/${G5}`]: g5,
    [`PUT /api/groups/${G6}/subjects`]: g6,
    [`PUT /api/groups/${G7}/subjects`]: g7,
    ...over,
  });
}

const flat = (s: string | null | undefined) => (s ?? '').replace(/[⁨⁩]/g, '');
/** An accessible-name matcher that ignores the isolates around data names. */
const nm = (want: string) => (name: string) => flat(name) === want;
const teacherCalls = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/teachers')).length;
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
  it('lists each teacher with class teacher of, subjects by subject, and load', async () => {
    api();
    page();
    const table = await screen.findByRole('table', { name: 'Teachers' });
    const row = within(table).getByRole('row', { name: /Amina/ });
    const cells = within(row)
      .getAllByRole('cell')
      .map((c) => flat(c.textContent));
    expect(cells).toEqual(['Class 5 A', 'Maths (2): Class 6 A, 7 A', '3 classes · 1 subject']);
    const b = within(table).getByRole('row', { name: /Bilal/ });
    expect(flat(b.textContent)).toContain('Class 6 A, Class 7 A');
    expect(flat(b.textContent)).toContain('2 classes · 1 subject');
    // No per-row badge for a double class teacher (the strip and its filter say it).
    expect(b.textContent).not.toContain('Class teacher of two or more classes');
    // The row opens the allocation card.
    expect(within(row).getByRole('link', { name: 'Amina' }).getAttribute('href')).toBe(
      `/teachers?teacher=${A}`,
    );
  });

  it('one line per subject; at most 6 classes on screen, then +N; full list in print', async () => {
    const many: TeacherRowDto = {
      ...amina,
      class_teacher_of: [],
      subjects: [
        ...[4, 5, 6, 7].flatMap((n) => [
          { ...ref(`g${n}a`, n, `s${n}a`, 'Social Studies') },
          {
            ...ref(`g${n}b`, n, `s${n}b`, 'Social Studies'),
            grp_name: `Class ${n} B`,
            group_name: 'B',
          },
        ]),
        ref('g9', 9, 's9', 'Pakistan Studies'),
      ],
      load: { groups: 9, subjects: 2 },
    };
    api([many]);
    page();
    const table = await screen.findByRole('table', { name: 'Teachers' });
    const cell = within(table).getAllByRole('cell')[1] as HTMLElement;
    const lines = [...cell.querySelectorAll('span.block')].map((s) => flat(s.textContent));
    expect(lines).toEqual([
      'Social Studies (8): Class 4 A, 4 B, 5 A, 5 B, 6 A, 6 B +2',
      'Pakistan Studies (1): Class 9 A',
    ]);
    const print = document.getElementById('teacher-allocation-print') as HTMLElement;
    expect(flat(print.textContent)).toContain(
      'Social Studies (8): Class 4 A, 4 B, 5 A, 5 B, 6 A, 6 B, 7 A, 7 B',
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
    const panel = await screen.findByRole('region', { name: 'Classes without a class teacher' });
    expect(
      within(panel)
        .getByRole('link', { name: /Class 8 A/ })
        .getAttribute('href'),
    ).toBe(`/groups/${G8}`);
    fireEvent.click(
      within(document.getElementById('teachers-warn-subject') as HTMLElement).getByRole('link'),
    );
    const sp = await screen.findByRole('region', { name: 'Subjects without a teacher' });
    expect(within(sp).getByRole('link', { name: /English/ })).toBeTruthy();
    // Class teacher of two or more classes: the table narrows to those teachers.
    fireEvent.click(
      within(document.getElementById('teachers-warn-double') as HTMLElement).getByRole('link'),
    );
    const dp = await screen.findByRole('region', { name: 'Class teacher of two or more classes' });
    expect(dp.textContent).toContain('Academy batches are not counted.');
    const table = screen.getByRole('table', { name: 'Teachers' });
    await waitFor(() => expect(within(table).queryByRole('row', { name: /Amina/ })).toBeNull());
    expect(within(table).getByRole('row', { name: /Bilal/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Show all teachers' }));
    await waitFor(() => expect(within(table).getByRole('row', { name: /Amina/ })).toBeTruthy());
  });

  it('the session selector shows another session', async () => {
    const other = { ...session, id: S2, name: '2025-26', is_current: false };
    const { calls } = api(undefined, { 'GET /api/sessions': { items: [session, other] } });
    page();
    await screen.findByRole('table', { name: 'Teachers' });
    // The first fetches wait for the sessions, so no unscoped groups request goes out.
    expect(calls.some((c) => c.path === '/api/groups')).toBe(false);
    fireEvent.change(screen.getByRole('combobox', { name: 'Session' }), { target: { value: S2 } });
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/api/teachers?session_id=${S2}`)).toBe(true),
    );
    expect(calls.some((c) => c.path === `/api/groups?session_id=${S2}`)).toBe(true);
  });

  it('shows cards on a phone', async () => {
    stubMedia(true);
    api();
    page();
    const cards = await screen.findByRole('list', { name: 'Teachers' });
    expect(cards.getAttribute('data-layout')).toBe('cards');
    expect(flat(cards.textContent)).toContain('3 classes · 1 subject');
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
    expect(flat(table.textContent)).toContain('3 جماعتیں · 1 مضمون');
    expect(flat(table.textContent)).toContain('Maths (2): Class 6 A، 7 A');
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

  it('asks before replacing a subject teacher', async () => {
    const { calls } = api();
    page(`/teachers?teacher=${A}`);
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add subject…' }));
    fireEvent.change(within(sheet).getByLabelText('Class or batch'), { target: { value: G7 } });
    const s = within(sheet).getByLabelText('Subject') as HTMLSelectElement;
    expect([...s.options].map((o) => flat(o.textContent))).toEqual([
      'Choose…',
      'English (now Bilal)',
    ]);
    fireEvent.change(s, { target: { value: GS7E } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    const confirm = await screen.findByRole('dialog', { name: nm('Replace Bilal?') });
    expect(flat(confirm.textContent)).toContain(
      'English in Class 7 A is taught by Bilal. Amina will take their place.',
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/api/groups/${G7}/subjects`,
        body: {
          subjects: [
            { subject_id: MATHS, teacher_id: A },
            { subject_id: ENGLISH, teacher_id: A },
          ],
        },
      }),
    );
  });

  it('adds a subject with the fresh full list (a subject added meanwhile is kept)', async () => {
    // The class side added Urdu (taught by Bilal) after the list was loaded.
    const fresh = detail(g6, {
      subjects: [...g6.subjects, sub(GS6U, URDU, 'Urdu', [B, 'Bilal'])],
    });
    const { calls } = api(undefined, { [`GET /api/groups/${G6}`]: fresh });
    page(`/teachers?teacher=${A}`);
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add subject…' }));
    const g = within(sheet).getByLabelText('Class or batch') as HTMLSelectElement;
    expect([...g.options].map((o) => o.textContent)).toEqual(['Choose…', 'Class 6 A', 'Class 7 A']);
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
            { subject_id: URDU, teacher_id: B },
          ],
        },
      }),
    );
  });

  it('changed meanwhile: re-asks with the fresh name, writes nothing until then', async () => {
    // The list says 8 A has no class teacher; the fresh read says Bilal took it meanwhile.
    const { calls } = api(undefined, {
      [`GET /api/groups/${G8}`]: detail(g8, { class_teacher_id: B, class_teacher_name: 'Bilal' }),
    });
    page(`/teachers?teacher=${A}`);
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    const before = teacherCalls(calls);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set as class teacher of…' }));
    fireEvent.change(within(sheet).getByLabelText('Class or batch'), { target: { value: G8 } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    const confirm = await screen.findByRole('dialog', { name: nm('Replace Bilal?') });
    expect(flat(confirm.textContent)).toContain('Class 8 A already has Bilal as class teacher.');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    // The lists were refreshed.
    expect(teacherCalls(calls)).toBeGreaterThan(before);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `/api/groups/${G8}`,
        body: { class_teacher_id: A },
      }),
    );
  });

  it('applyAssignment: not_found when the subject left the group; changed with who is there', async () => {
    api(undefined, { [`GET /api/groups/${G6}`]: detail(g6, { subjects: [] }) });
    await expect(
      applyAssignment({
        kind: 'subject',
        grpId: G6,
        grpSubjectId: GS6E,
        staffId: A,
        expectTeacherId: null,
      }),
    ).rejects.toThrow('not_found');
    api();
    const err = await applyAssignment({
      kind: 'subject',
      grpId: G7,
      grpSubjectId: GS7E,
      staffId: A,
      expectTeacherId: null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChangedError);
    expect((err as ChangedError).current).toEqual({ id: B, name: 'Bilal' });
  });

  it('removes a subject from its row menu after confirming', async () => {
    const { calls } = api();
    page(`/teachers?teacher=${A}`);
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    // Rows grouped under a subject heading.
    expect(flat(within(sheet).getByRole('heading', { name: /Maths/ }).textContent)).toBe(
      'Maths (2)',
    );
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

  it('a teacher who left: can be cleared, not given new work', async () => {
    api([{ ...amina, staff_status: 'left' }]);
    page(`/teachers?teacher=${A}`);
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    expect(within(sheet).getByText('Left the school')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Set as class teacher of…' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Add subject…' })).toBeNull();
    expect(screen.getByRole('button', { name: nm('More actions: Class 5 A') })).toBeTruthy();
  });

  it('a profile with no login yet is listed and can be given a first class', async () => {
    const fresh: TeacherRowDto = {
      staff_id: N,
      name: 'Nadia',
      roles: [],
      staff_status: 'active',
      class_teacher_of: [],
      subjects: [],
      load: { groups: 0, subjects: 0 },
    };
    const { calls } = api([amina, fresh]);
    page();
    const table = await screen.findByRole('table', { name: 'Teachers' });
    fireEvent.click(within(table).getByRole('link', { name: 'Nadia' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nadia' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set as class teacher of…' }));
    fireEvent.change(within(sheet).getByLabelText('Class or batch'), { target: { value: G8 } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `/api/groups/${G8}`,
        body: { class_teacher_id: N },
      }),
    );
  });

  it('opened from a row, Close goes back to the list', async () => {
    api();
    page();
    const table = await screen.findByRole('table', { name: 'Teachers' });
    fireEvent.click(within(table).getByRole('link', { name: 'Amina' }));
    const sheet = await screen.findByRole('dialog', { name: 'Amina' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Amina' })).toBeNull());
  });
});

describe('print', () => {
  it('sets the document title and the A4 page while printing, then restores them', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    api();
    page();
    await screen.findByRole('table', { name: 'Teachers' });
    setShellTitle('ANS · Maktab');
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

  it('without afterprint, focus coming back ends the run; Print works again', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    api();
    page();
    await screen.findByRole('table', { name: 'Teachers' });
    setShellTitle('ANS · Maktab');
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.title).toBe('ANS · Maktab');
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(document.title).toBe('Teacher allocation 2026-27');
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
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
