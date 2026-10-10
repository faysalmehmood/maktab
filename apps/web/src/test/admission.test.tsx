import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { AdmissionPage } from '@/pages/students/Admission';
import { group, ids, mockApi, renderAt, session } from './api-mock';

function setup() {
  const api = mockApi({
    'GET /api/groups': { items: [group] },
    'GET /api/sessions': { items: [session] },
    'GET /api/custom-fields': { items: [] },
    'GET /api/families': { items: [] },
    'POST /api/admissions': {
      family_id: ids.family,
      student_id: ids.student,
      enrolment_id: '01JAAAAAAAAAAAAAAAAAAAAAA6',
      guardian_ids: [],
      admission_no: '2026-0001',
      roll_no: '1',
      readmitted: false,
    },
  });
  renderAt('/students/new', '/students/new', <AdmissionPage />);
  return api;
}

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('admission form', () => {
  beforeAll(async () => {
    await initI18n('en');
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(() => setLanguage('en'));
  });

  it('normalises the guardian phone and rejects a non-Pakistani one', async () => {
    setup();
    type(/Guardian phone/, '0300-1234567');
    expect(screen.getByText(/923001234567/)).toBeTruthy();
    type(/Guardian phone/, '12345');
    fireEvent.click(screen.getByRole('button', { name: /Find family/ }));
    expect(screen.getByText(/Not a Pakistani phone number/)).toBeTruthy();
  });

  it('flags required fields, then sends the normalised phone and client-minted ids', async () => {
    const api = setup();
    type(/Guardian phone/, '+92 300 1234567');
    fireEvent.click(screen.getByRole('button', { name: /Find family/ }));
    await screen.findByText(/No family with this phone/);
    fireEvent.click(screen.getByRole('button', { name: /No, new family/ }));
    // The lookup phone carries over to the first guardian.
    expect((screen.getByLabelText(/^Phone/) as HTMLInputElement).value).toBe('+92 300 1234567');

    fireEvent.click(screen.getByRole('button', { name: 'Admit student' }));
    // Family name, guardian name, student name, group.
    expect(screen.getAllByText('Required').length).toBeGreaterThanOrEqual(4);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    type(/Family name/, 'Khan');
    type(/Guardian name/, 'Imran Khan');
    type(/Student name/, 'Ali');
    // Names are bidi-isolated so "5-B" never reorders inside Urdu text.
    await screen.findByRole('option', { name: /Class 5\u2069 · \u2068A/ });
    fireEvent.change(screen.getByLabelText(/Class or batch/), { target: { value: ids.group } });
    fireEvent.click(screen.getByRole('button', { name: 'Admit student' }));

    await screen.findByText('2026-0001');
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/admissions');
    const body = post?.body as {
      family: { id: string; name: string };
      guardians: { phone: string; whatsapp: string | null }[];
      student_id: string;
      student: { name: string };
      enrolment: { grp_id: string; id: string };
    };
    expect(body.guardians[0]?.phone).toBe('923001234567');
    expect(body.family.name).toBe('Khan');
    expect(body.student.name).toBe('Ali');
    expect(body.enrolment.grp_id).toBe(ids.group);
    expect(body.student_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.enrolment.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Admit a sibling/ })).toBeTruthy(),
    );
  });

  it('keeps a full group pickable and warns without blocking (capacity is for planning)', async () => {
    mockApi({
      'GET /api/groups': { items: [{ ...group, active_count: 30, seats_left: 0 }] },
      'GET /api/sessions': { items: [session] },
      'GET /api/custom-fields': { items: [] },
    });
    renderAt('/students/new', '/students/new', <AdmissionPage />);
    const option = (await screen.findByRole('option', { name: /Full/ })) as HTMLOptionElement;
    expect(option.disabled).toBe(false);
    expect(screen.queryByText(/at or over its capacity/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Class or batch/), { target: { value: ids.group } });
    expect(screen.getByRole('status').textContent).toMatch(/at or over its capacity/);
  });

  it('labels every field in Urdu when the language is ur', async () => {
    await act(() => setLanguage('ur'));
    setup();
    expect(screen.getByRole('heading', { name: 'نیا داخلہ' })).toBeTruthy();
    expect(screen.getByLabelText(/سرپرست کا فون/)).toBeTruthy();
    expect(screen.getByLabelText(/طالب علم کا نام/)).toBeTruthy();
    expect(screen.getByLabelText(/تاریخ داخلہ/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'داخلہ کریں' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
  });
});
