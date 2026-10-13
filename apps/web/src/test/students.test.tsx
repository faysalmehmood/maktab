import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { StudentsList } from '@/pages/students/StudentsList';
import { group, ids, mockApi, renderAt } from './api-mock';

const student = (n: number, name: string) => ({
  id: `01JAAAAAAAAAAAAAAAAAAAAAB${n}`,
  family_id: ids.family,
  family_name: 'Khan',
  admission_no: `2026-000${n}`,
  name,
  father_name: 'Imran',
  gender: 'm',
  status: 'active',
  has_photo: false,
  group_id: ids.group,
  group_name: 'A',
  roll_no: String(n),
  guardian_phone: '923001234567',
});

describe('students list', () => {
  beforeAll(async () => {
    await initI18n('en');
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(() => setLanguage('en'));
  });

  it('renders in Urdu, right to left, with Latin digits isolated', async () => {
    await act(() => setLanguage('ur'));
    const api = mockApi({
      'GET /api/groups': { items: [group] },
      'GET /api/students': {
        items: [student(1, 'علی'), student(2, 'سارہ')],
        total: 2,
        page: 1,
        page_size: 50,
      },
    });
    renderAt('/students', '/students', <StudentsList />);
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ur');
    expect(screen.getByRole('heading', { name: 'طلبہ' })).toBeTruthy();
    expect(await screen.findByText('علی')).toBeTruthy();
    expect(screen.getByText('سارہ')).toBeTruthy();
    const no = screen.getByText('2026-0001');
    expect(no.tagName).toBe('BDI');
    expect(screen.getAllByText('0300 1234567')[0]?.tagName).toBe('BDI');
    // Data-derived names in the mixed-direction subtitle are isolated too ("5-B" never "B-5").
    expect(screen.getAllByText('Imran').every((el) => el.tagName === 'BDI')).toBe(true);
    expect(screen.getAllByText('A').some((el) => el.tagName === 'BDI')).toBe(true);
    expect(screen.getByRole('link', { name: /داخلہ/ })).toBeTruthy();
    // Default view asks for active students only, page 1.
    expect(api.calls.find((c) => c.path.startsWith('/api/students'))?.path).toBe(
      '/api/students?status=active&page=1',
    );
  });

  it('hides admission and import from a teacher', async () => {
    mockApi({
      'GET /api/groups': { items: [] },
      'GET /api/students': { items: [], total: 0, page: 1, page_size: 50 },
    });
    renderAt('/students', '/students', <StudentsList />, ['teacher']);
    await screen.findByText(/No student/);
    expect(screen.queryByRole('link', { name: /Admit/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Import/ })).toBeNull();
  });

  it('desktop: the shared DataTable (captioned, column heads, one link per row) and inline filters', async () => {
    mockApi({
      'GET /api/groups': { items: [group] },
      'GET /api/students': { items: [student(1, 'Ali')], total: 1, page: 1, page_size: 50 },
    });
    renderAt('/students', '/students', <StudentsList />);
    const table = await screen.findByRole('table', { name: 'Students' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Students', 'Class', 'Father name', 'Phone', 'Admission no.']);
    expect(within(table).getByRole('link', { name: /Ali/ }).getAttribute('href')).toBe(
      `/students/${student(1, 'Ali').id}`,
    );
    expect(document.getElementById('student-filters')?.dataset.layout).toBe('inline');
    expect(document.getElementById('student-filter-group')).toBeTruthy();
  });

  it('phone: cards, a Filters sheet and a chip per applied filter that clears it', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const api = mockApi({
      'GET /api/groups': { items: [group] },
      'GET /api/students': { items: [student(1, 'Ali')], total: 1, page: 1, page_size: 50 },
    });
    renderAt(`/students?group=${ids.group}&status=left`, '/students', <StudentsList />);
    await screen.findByText('Ali');
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.getElementById('students-table')?.dataset.layout).toBe('cards');
    expect(document.getElementById('student-filters')?.dataset.layout).toBe('sheet');
    // The selects live in the sheet, not on the page.
    expect(document.getElementById('student-filter-group')).toBeNull();
    const chips = within(screen.getByRole('list', { name: 'Filters applied' })).getAllByRole(
      'button',
    );
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1] as HTMLElement); // status: Left → back to the default (active)
    await screen.findByText('Ali');
    expect(api.calls.at(-1)?.path).toBe(`/api/students?group=${ids.group}&status=active&page=1`);
  });
});
