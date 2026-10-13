import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { SetupWizard } from '@/pages/Setup';
import { mockApi, renderAt, session } from './api-mock';

const saved = (body: { name: string; mode: string }) => ({
  school: {
    id: '01JAAAAAAAAAAAAAAAAAAAAAC1',
    name: body.name,
    name_ur: null,
    mode: body.mode,
    address: null,
    phone: null,
    default_lang: 'ur',
    receipt_prefix: null,
    has_logo: false,
    setup_completed_at: null as string | null,
  },
});

/**
 * M7b: five stages over the same eight WIZARD_STEPS — school | mode, session, classes, groups
 * (parts 1–4 of "Classes and sections") | fees | staff | done. One marker per Next press.
 */
const STEP_MARKERS = [
  'Step 1 of 5',
  'Part 1 of 4',
  'Part 2 of 4',
  'Part 3 of 4',
  'Part 4 of 4',
  'Step 3 of 5',
  'Step 4 of 5',
];

describe('setup wizard', () => {
  beforeAll(async () => {
    await initI18n('en');
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(() => setLanguage('en'));
  });

  it('moves forward only after a step saves, and back without losing data', async () => {
    let school: ReturnType<typeof saved> = { school: null } as unknown as ReturnType<typeof saved>;
    const api = mockApi({
      'GET /api/school': () => school,
      'PUT /api/school': (_url: URL, init: RequestInit) => {
        school = saved(JSON.parse(String(init.body)) as { name: string; mode: string });
        return school;
      },
      'POST /api/school/logo': () => {
        school = { school: { ...school.school, has_logo: true } } as typeof school;
        return school;
      },
      'GET /api/sessions': { items: [] },
    });
    renderAt('/setup', '/setup', <SetupWizard />);

    expect(await screen.findByText('Step 1 of 5')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your school', level: 1 })).toBeTruthy();

    // Next with an empty name stays put and says why.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Required')).toBeTruthy();
    expect(screen.getByText('Step 1 of 5')).toBeTruthy();

    // The logo control is there on the first visit (defect 4.6): the file is staged and uploaded
    // right after the first save creates the school.
    const input = document.getElementById('school-logo') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(screen.getByText('PNG, JPEG or WebP, up to 512 KB.')).toBeTruthy();
    const logo = new File([new Uint8Array(1000)], 'logo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [logo] } });
    expect(await screen.findByText('The logo is uploaded when you press Next.')).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/school/logo')).toBe(false);
    fireEvent.change(screen.getByLabelText(/School name/), { target: { value: 'Al-Noor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 2 of 5')).toBeTruthy();
    expect(screen.getByText('Part 1 of 4')).toBeTruthy();
    const order = api.calls.map((c) => `${c.method} ${c.path}`).filter((c) => !c.startsWith('GET'));
    expect(order).toEqual(['PUT /api/school', 'POST /api/school/logo']);
    expect(screen.getByRole('heading', { name: 'Type' })).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Step 1 of 5')).toBeTruthy();
    expect((screen.getByLabelText(/School name/) as HTMLInputElement).value).toBe('Al-Noor');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 2 of 5')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Academy/));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Part 2 of 4')).toBeTruthy();
    expect(screen.getByText('Step 2 of 5')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Session' })).toBeTruthy();
    const modePut = api.calls.filter((c) => c.method === 'PUT').at(-1);
    expect(modePut?.body).toMatchObject({ mode: 'academy', name: 'Al-Noor' });
    // ↑ the mode step must not blank the profile saved in step 1.
  });

  it('finishes with POST /api/school/complete-setup, not a profile save', async () => {
    let school = saved({ name: 'Al-Noor', mode: 'both' });
    const api = mockApi({
      'GET /api/school': () => school,
      'PUT /api/school': (_url: URL, init: RequestInit) => {
        school = saved(JSON.parse(String(init.body)) as { name: string; mode: string });
        return school;
      },
      'POST /api/school/complete-setup': () => {
        school = { school: { ...school.school, setup_completed_at: '2026-10-10T00:00:00Z' } };
        return school;
      },
      'GET /api/sessions': { items: [session] },
      'GET /api/programmes': { items: [] },
      'GET /api/subjects': { items: [] },
      'GET /api/groups': { items: [{ id: 'G1', name: '5-A' }] },
      'GET /api/staff': { items: [] },
      'GET /api/fees/heads': { heads: [] },
      'GET /api/fees/rates': { rates: [] },
    });
    renderAt('/setup', '/setup', <SetupWizard />);
    for (const marker of STEP_MARKERS) {
      expect(await screen.findByText(marker)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(await screen.findByText('Step 5 of 5')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Maktab' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/api/school/complete-setup')).toBe(true),
    );
    // The Fees step came between Groups and Staff; no rates yet is a note, not a block.
    expect(screen.queryByText(/No fee rates yet/)).toBeNull();
    // No PUT carried a completion flag.
    for (const c of api.calls.filter((x) => x.method === 'PUT'))
      expect(c.body).not.toHaveProperty('setup_completed');
  });

  it('Fees step between Groups and Staff; Done refuses to finish with no class group', async () => {
    const school = saved({ name: 'Al-Noor', mode: 'both' });
    const api = mockApi({
      'GET /api/school': () => school,
      'PUT /api/school': () => school,
      'GET /api/sessions': { items: [session] },
      'GET /api/programmes': { items: [] },
      'GET /api/subjects': { items: [] },
      'GET /api/groups': { items: [] },
      'GET /api/staff': { items: [] },
      'GET /api/fees/heads': { heads: [] },
      'GET /api/fees/rates': { rates: [] },
    });
    renderAt('/setup', '/setup', <SetupWizard />);
    for (const marker of STEP_MARKERS.slice(0, 5)) {
      expect(await screen.findByText(marker)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(await screen.findByText('Step 3 of 5')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Fees' })).toBeTruthy();
    expect(screen.getByText(/monthly rate for each class/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Staff' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/Add at least one class group first/)).toBeTruthy();
    const open = screen.getByRole('button', { name: 'Open Maktab' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    // The stale "Fees come in a later update" copy is gone (defect 4.6.3).
    expect(screen.queryByText(/later update/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to groups' }));
    expect(await screen.findByText('Part 4 of 4')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Groups' })).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/school/complete-setup')).toBe(false);
  });
});
