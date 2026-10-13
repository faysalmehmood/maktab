import 'fake-indexeddb/auto';
import type { RegisterResponse } from '@maktab/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import * as ob from '@/offline/outbox';
import { _reset } from '@/offline/sync';
import { RegisterPage } from '@/pages/attendance/Register';
import { ids, meAs, mockApi, renderAt } from './api-mock';

/*
 * M7b part 2 (screens): the key interactions of each restyled screen. Money, permission and
 * offline rules are covered by their own suites; these pin what the new layouts add.
 */

let n = 0;
beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  ob._close();
  ob.configure({ dbName: `m7b2-${n++}`, now: () => Date.now(), userId: meAs(['admin']).user.id });
  _reset();
});

describe('attendance register (M7b-2)', () => {
  const date = '2026-10-08';
  const row = (id: string, name: string, roll: string) => ({
    student_id: id,
    name,
    roll_no: roll,
    admission_no: `2026-${roll}`,
    has_photo: false,
    status: null,
    note: null,
  });
  const register = (over: Partial<RegisterResponse> = {}): RegisterResponse => ({
    grp_id: ids.group,
    grp_name: 'A',
    programme_name: 'Class 5',
    date,
    grp_subject_id: '',
    day_off: null,
    rows: [
      row('01JAAAAAAAAAAAAAAAAAAAAAS1', 'Ali Khan', '1'),
      row('01JAAAAAAAAAAAAAAAAAAAAAS2', 'Sara Khan', '2'),
      row('01JAAAAAAAAAAAAAAAAAAAAAS3', 'Omar Ali', '3'),
    ],
    current: null,
    history: [],
    ...over,
  });
  const path = `/attendance/register/${ids.group}?date=${date}`;
  const pattern = '/attendance/register/:grpId';

  it('shows progress first and keeps it live as marks cycle P → A → L → E', async () => {
    mockApi({ 'GET /api/attendance/register': register() });
    renderAt(path, pattern, <RegisterPage />, ['teacher']);
    await screen.findByText('3 of 3 present');
    const bar = document.querySelector('[data-action-bar]') as HTMLElement;
    const sara = () => screen.getByRole('button', { name: /^Sara Khan:/ });
    expect(sara().getAttribute('aria-label')).toBe('Sara Khan: Present');
    fireEvent.click(sara());
    expect(sara().getAttribute('aria-label')).toBe('Sara Khan: Absent');
    expect(screen.getByText('2 of 3 present')).toBeTruthy();
    // The row is tinted for its exception; the live counts in the save bar move with it.
    expect(sara().closest('li')?.dataset.status).toBe('A');
    expect(within(bar).getByTitle('Absent').textContent).toBe('A 1');
    fireEvent.click(sara());
    fireEvent.click(sara());
    expect(sara().getAttribute('aria-label')).toBe('Sara Khan: Leave');
    fireEvent.click(sara());
    expect(sara().getAttribute('aria-label')).toBe('Sara Khan: Present');
    expect(screen.getByText('3 of 3 present')).toBeTruthy();
    // A back link to the day's list; nothing says "correction" for a teacher's first register.
    expect(screen.getByRole('link', { name: 'Attendance' }).getAttribute('href')).toBe(
      '/attendance',
    );
    expect(document.getElementById('correction-mode')).toBeNull();
  });

  it('an admin opening a taken register sees correction mode before saving, and Save asks for a reason', async () => {
    const current = {
      register_id: 'R1',
      taken_by_name: 'Ms Sana',
      taken_at: '2026-10-08T03:00:00Z',
    };
    mockApi({
      'GET /api/attendance/register': register({
        current,
        history: [
          {
            ...current,
            received_at: current.taken_at,
            is_current: true,
            kind: 'sync',
            reason: null,
            counts: { P: 3, A: 0, L: 0, E: 0 },
          },
        ],
      }),
    });
    renderAt(path, pattern, <RegisterPage />, ['admin']);
    expect(await screen.findByText(/Saving makes a correction/)).toBeTruthy();
    // Back goes to the same day (an earlier date) on the office list.
    expect(screen.getByRole('link', { name: 'Attendance' }).getAttribute('href')).toBe(
      `/attendance?date=${date}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Correct this register' }));
    expect(await screen.findByLabelText('Reason for the correction')).toBeTruthy();
  });
});
