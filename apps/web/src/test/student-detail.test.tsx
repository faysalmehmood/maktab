import type { EnrolmentDto, StudentDetailDto } from '@maktab/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { StudentDetail } from '@/pages/students/StudentDetail';
import { group, ids, mockApi, renderAt, session } from './api-mock';

const enrolmentId = '01JAAAAAAAAAAAAAAAAAAAAAE1';
const otherGroup = { ...group, id: '01JAAAAAAAAAAAAAAAAAAAAAG2', name: 'B' };
const enrolment: EnrolmentDto = {
  id: enrolmentId,
  student_id: ids.student,
  grp_id: ids.group,
  grp_name: '5-A',
  programme_name: 'Class 5',
  session_id: ids.session,
  is_primary: true,
  roll_no: '1',
  start_date: '2026-04-01',
  end_date: null,
  status: 'active',
  end_reason: null,
  prev_enrolment_id: null,
};
const detail: StudentDetailDto = {
  id: ids.student,
  family_id: ids.family,
  admission_no: '2026-0001',
  name: 'Ali',
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
  family: { id: ids.family, name: 'Khan', address: null, area: null },
  guardians: [],
  enrolments: [enrolment],
};

function setup(roles: Parameters<typeof renderAt>[3] = ['owner']) {
  const api = mockApi({
    [`GET /api/students/${ids.student}`]: detail,
    [`GET /api/families/${ids.family}`]: { ...detail.family, guardians: [], students: [] },
    'GET /api/custom-fields': { items: [] },
    'GET /api/groups': { items: [group, otherGroup] },
    'GET /api/sessions': { items: [session] },
    [`POST /api/enrolments/${enrolmentId}/transfer`]: { ...enrolment, id: 'NEW' },
    [`POST /api/enrolments/${enrolmentId}/end`]: { ...enrolment, status: 'withdrawn' },
  });
  renderAt(`/students/${ids.student}`, '/students/:id', <StudentDetail />, roles);
  return api;
}

describe('student detail: enrolment actions', () => {
  beforeAll(async () => {
    await initI18n('en');
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(() => setLanguage('en'));
  });

  it('transfers to another group through the transfer route', async () => {
    const api = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Transfer' }));
    // The current group is not offered as a target.
    const picker = await screen.findByLabelText(/New group/);
    await screen.findByRole('option', { name: /B/ });
    expect(screen.queryByRole('option', { name: /⁨A⁩/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findAllByText('Required')).not.toHaveLength(0);
    fireEvent.change(picker, { target: { value: otherGroup.id } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'section change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === `/api/enrolments/${enrolmentId}/transfer`)).toBe(
        true,
      ),
    );
    const call = api.calls.find((c) => c.path === `/api/enrolments/${enrolmentId}/transfer`);
    expect(call?.body).toMatchObject({ grp_id: otherGroup.id, reason: 'section change' });
  });

  it('ends an enrolment with an outcome, in Urdu too', async () => {
    await act(() => setLanguage('ur'));
    const api = setup();
    expect(await screen.findByRole('button', { name: 'منتقل کریں' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ختم کریں' }));
    fireEvent.change(await screen.findByLabelText(/نتیجہ/), { target: { value: 'completed' } });
    fireEvent.change(screen.getByLabelText(/وجہ/), { target: { value: 'course done' } });
    fireEvent.click(screen.getByRole('button', { name: 'محفوظ کریں' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path.endsWith('/end'))?.body).toMatchObject({
        status: 'completed',
        reason: 'course done',
      }),
    );
  });

  it('a teacher sees no enrolment actions', async () => {
    setup(['teacher']);
    await screen.findByText('Ali', { selector: 'h1' });
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();
  });
});
