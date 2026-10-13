import 'fake-indexeddb/auto';
import type { StudentDetailDto } from '@maktab/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeesTabs } from '@/components/fees/FeesTabs';
import { Tabs } from '@/components/segmented';
import { initI18n, setLanguage } from '@/i18n';
import { CounterPage, oneMonthAmount } from '@/pages/fees/Counter';
import { GroupsPage } from '@/pages/Groups';
import { StudentDetail } from '@/pages/students/StudentDetail';
import { group, ids, mockApi, renderAt, session } from './api-mock';
import { accounts, fam, familyLines, familyStatement, line } from './fee-fixtures';

/*
 * M7b part 2 fix pass: the review items (live regions, side-list orientation, honest loading
 * figures, "One month", Fees tabs on the More pages) and the rebuilt Fee register, Concessions,
 * Advances and Billing screens.
 */

const RS = (n: number) => n * 100;
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
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('"One month" quick amount', () => {
  it("is the oldest open month's dues, and absent when one month is open", () => {
    // Open: Sept (Sara 3,150 + Ali 2,200) and Oct; Aug is paid.
    expect(oneMonthAmount({ lines: familyLines, net_due: RS(100000) })).toBe(RS(5350));
    // Never more than the net due (credit held).
    expect(oneMonthAmount({ lines: familyLines, net_due: RS(4000) })).toBe(RS(4000));
    const sept = familyLines.filter((l) => l.period_key === '2026-09');
    expect(oneMonthAmount({ lines: sept, net_due: RS(5350) })).toBe(0);
    expect(oneMonthAmount({ lines: [line({ id: 'X', due: 0 })], net_due: 0 })).toBe(0);
  });

  it('sits next to "Full due" on the counter and fills the amount', async () => {
    mockApi({ [`GET /api/fees/family/${fam}`]: familyStatement(), 'GET /api/accounts': accounts });
    renderAt(`/fees/counter?family=${fam}`, '/fees/counter', <CounterPage />, ['owner']);
    const amount = (await screen.findByLabelText(/Amount/)) as HTMLInputElement;
    const one = await byId('counter-one-month');
    expect(one.previousElementSibling?.id).toBe('counter-full-due');
    expect(one.textContent).toContain('PKR 5,350');
    fireEvent.click(one);
    expect(amount.value).toBe('5,350');
  });
});

describe('live regions and the side list', () => {
  function SideTabs() {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a');
    return (
      <Tabs
        side
        label="Sections"
        idBase="t"
        value={v}
        onChange={setV}
        items={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
        ]}
      />
    );
  }

  it('the side list states its orientation and moves with either arrow pair', () => {
    const mq = (matches: boolean) =>
      vi.stubGlobal('matchMedia', (q: string) => ({
        matches: q.includes('min-width: 64rem') ? matches : false,
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
    mq(true);
    const { unmount } = render(<SideTabs />);
    const list = screen.getByRole('tablist');
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    const selected = () => screen.getByRole('tab', { selected: true }).textContent;
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(selected()).toBe('B');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(selected()).toBe('C');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(selected()).toBe('B');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(selected()).toBe('A');
    unmount();
    mq(false);
    render(<SideTabs />);
    expect(screen.getByRole('tablist').getAttribute('aria-orientation')).toBe('horizontal');
  });
});

describe('Fees tabs on the "More" pages', () => {
  it.each(['/fees/concessions', '/fees/register', '/fees/sponsors', '/fees/sponsors/SP1'])(
    '%s shows the strip with "More" as the current tab',
    (path) => {
      renderAt(path, '*', <FeesTabs />, ['owner']);
      const nav = screen.getByRole('navigation');
      const current = within(nav).getByRole('link', { current: 'page' });
      expect(current.textContent).toBe('More');
      expect(current.getAttribute('href')).toBe('/fees');
    },
  );

  it('a main tab is current on its own page; the strip is not marked as faded when it fits', () => {
    renderAt('/fees/billing', '*', <FeesTabs />, ['owner']);
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByRole('link', { current: 'page' }).getAttribute('href')).toBe(
      '/fees/billing',
    );
    expect(nav.dataset.fadeEnd).toBeUndefined();
  });
});

describe('student profile summary: no false figures while loading', () => {
  const detail = (status: StudentDetailDto['status']): StudentDetailDto => ({
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
    status,
    left_date: status === 'active' ? null : '2026-09-01',
    left_reason: null,
    extra: {},
    family: { id: ids.family, name: 'Raza', address: null, area: null },
    guardians: [],
    enrolments: [],
  });

  it('dues and siblings are placeholders (not "—" / "0 siblings") until their reads answer', async () => {
    const never = () => new Promise<never>(() => undefined);
    mockApi({
      [`GET /api/students/${ids.student}`]: detail('active'),
      [`GET /api/families/${ids.family}`]: never,
      'GET /api/custom-fields': { items: [] },
      [`GET /api/attendance/student/${ids.student}`]: never,
      [`GET /api/fees/student/${ids.student}`]: never,
    });
    renderAt(`/students/${ids.student}`, '/students/:id', <StudentDetail />, ['owner']);
    const dues = await byId('sum-dues');
    expect(dues.textContent).not.toContain('—');
    expect(dues.textContent).toContain('Loading');
    expect(document.getElementById('sum-attendance')?.textContent).not.toContain('—');
    expect(document.getElementById('sum-admitted')?.textContent).not.toMatch(/sibling/);
  });

  it('a student who left has one Re-admit (the header button), not a second in the menu', async () => {
    mockApi({
      [`GET /api/students/${ids.student}`]: detail('left'),
      [`GET /api/families/${ids.family}`]: {
        ...detail('left').family,
        guardians: [],
        students: [],
      },
      'GET /api/custom-fields': { items: [] },
    });
    renderAt(`/students/${ids.student}`, '/students/:id', <StudentDetail />, ['owner']);
    expect(await screen.findAllByRole('link', { name: 'Re-admit' })).toHaveLength(1);
    const menu = await openMenu('More actions: Ali Raza');
    expect(within(menu).queryByRole('menuitem', { name: 'Re-admit' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
  });
});

describe('classes: seats left', () => {
  it('is "—" in the strip and the column when no class has a capacity', async () => {
    const open = { ...group, capacity: null, seats_left: null };
    mockApi({ 'GET /api/sessions': { items: [session] }, 'GET /api/groups': { items: [open] } });
    renderAt('/groups', '/groups', <GroupsPage />, ['owner']);
    await screen.findByText('Class 5 A');
    expect(document.getElementById('grp-seats')?.textContent).toBe('Seats left—');
  });
});
