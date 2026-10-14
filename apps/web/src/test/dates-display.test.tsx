import type { AuditListDto, PayslipDetailDto, StudentDetailDto } from '@maktab/shared';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PayslipPrint } from '@/components/money/payslip';
import { initI18n, setLanguage } from '@/i18n';
import { AuditPage } from '@/pages/money/Audit';
import { StudentDetail } from '@/pages/students/StudentDetail';
import { group, ids, mockApi, renderAt, session } from './api-mock';

/** Raw ISO days ("2026-04-01") and months ("2026-04") must not reach the screen. */
const ISO = /\b\d{4}-\d{2}(-\d{2})?\b/;

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

const student: StudentDetailDto = {
  id: ids.student,
  family_id: ids.family,
  admission_no: '2026-0001',
  name: 'Muhammad Ali Khan',
  father_name: 'Imran',
  dob: '2019-04-11',
  gender: 'm',
  b_form_no: null,
  has_photo: false,
  admission_date: '2023-04-01',
  status: 'active',
  left_date: null,
  left_reason: null,
  extra: {},
  family: { id: ids.family, name: 'Khan', address: null, area: null },
  guardians: [],
  enrolments: [
    {
      id: '01JAAAAAAAAAAAAAAAAAAAAAE1',
      student_id: ids.student,
      grp_id: ids.group,
      grp_name: 'A',
      programme_name: 'Class 2',
      session_id: ids.session,
      is_primary: true,
      roll_no: '1',
      start_date: '2026-04-01',
      end_date: null,
      status: 'active',
      end_reason: null,
      prev_enrolment_id: null,
    },
  ],
};

describe('dates are shown by name, never as ISO text', () => {
  it.each([
    ['en', ['11 Apr 2019', '1 Apr 2023', '1 Apr 2026']],
    ['ur', ['11 اپریل، 2019', '1 اپریل، 2023', '1 اپریل، 2026']],
  ] as const)(
    'student detail in %s: date of birth, admission, class history',
    async (lang, shown) => {
      await act(() => setLanguage(lang));
      mockApi({
        [`GET /api/students/${ids.student}`]: student,
        [`GET /api/families/${ids.family}`]: { ...student.family, guardians: [], students: [] },
        'GET /api/custom-fields': { items: [] },
        'GET /api/groups': { items: [group] },
        'GET /api/sessions': { items: [session] },
      });
      const { container } = renderAt(
        `/students/${ids.student}`,
        '/students/:id',
        <StudentDetail />,
      );
      await screen.findAllByText('Muhammad Ali Khan');
      // The admission number is the only YYYY-NNNN-looking value left on the page.
      const text = (container.textContent ?? '').replaceAll('2026-0001', '');
      for (const d of shown) expect(text).toContain(d);
      expect(text).not.toMatch(ISO);
    },
  );

  it('audit entries show the school clock (Asia/Karachi), not the stored UTC text', async () => {
    const rows: AuditListDto = {
      rows: [
        {
          id: 'A1',
          at: '2026-10-14 04:10:02',
          user_id: 'U1',
          user_name: 'Nasreen',
          entity: 'student',
          entity_id: ids.student,
          action: 'update',
          diff: null,
        },
      ],
      next: null,
    };
    mockApi({ 'GET /api/audit': rows, 'GET /api/audit/entities': { entities: [] } });
    const { container } = renderAt('/audit', '/audit', <AuditPage />);
    await waitFor(() => expect(container.textContent).toContain('14 Oct 2026, 09:10'));
    expect(container.textContent).not.toContain('04:10');
  });

  it.each([
    ['en', 'Apr 2026'],
    ['ur', 'اپریل 2026'],
  ] as const)('payslip print in %s names the month', (lang, month) => {
    const slip: PayslipDetailDto = {
      id: 'S1',
      staff_id: 'ST1',
      staff_name: 'Ayesha Bibi',
      staff_role: 'teacher',
      period_key: '2026-04',
      status: 'paid',
      earnings: 3200000,
      deductions: 0,
      recovery: 0,
      pay: 3200000,
      net: 3200000,
      paid: 3200000,
      paid_partial: false,
      approved_by_name: null,
      approved_at: null,
      void_reason: null,
      lines: [{ id: 'L1', kind: 'basic', amount: 3200000, note: null }],
      payments: [
        {
          id: 'P1',
          date: '2026-05-02',
          amount: 3200000,
          account_id: 'ACC1',
          account_name: 'Drawers',
          note: null,
        },
      ],
      advance: { advanced: 0, recovered: 0, outstanding: 0 },
      can_approve: false,
      school: { name: 'GSA', name_ur: null, address: null, phone: '924235550100' },
    };
    renderAt('/', '/', <PayslipPrint slip={slip} lang={lang} />);
    const paper = document.getElementById('payslip-paper')?.textContent ?? '';
    expect(paper).toContain(month);
    expect(paper).toContain('042 3555 0100');
    expect(paper).not.toMatch(ISO);
  });
});
