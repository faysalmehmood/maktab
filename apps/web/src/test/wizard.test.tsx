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
      'GET /api/sessions': { items: [] },
    });
    renderAt('/setup', '/setup', <SetupWizard />);

    expect(await screen.findByText('Step 1 of 7')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'School' })).toBeTruthy();

    // Next with an empty name stays put and says why.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Required')).toBeTruthy();
    expect(screen.getByText('Step 1 of 7')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/School name/), { target: { value: 'Al-Noor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 2 of 7')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Type' })).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Step 1 of 7')).toBeTruthy();
    expect((screen.getByLabelText(/School name/) as HTMLInputElement).value).toBe('Al-Noor');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 2 of 7')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Academy/));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Step 3 of 7')).toBeTruthy();
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
      'GET /api/groups': { items: [] },
      'GET /api/staff': { items: [] },
    });
    renderAt('/setup', '/setup', <SetupWizard />);
    for (let step = 1; step <= 6; step++) {
      expect(await screen.findByText(`Step ${step} of 7`)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Open Maktab' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/api/school/complete-setup')).toBe(true),
    );
    // No PUT carried a completion flag.
    for (const c of api.calls.filter((x) => x.method === 'PUT'))
      expect(c.body).not.toHaveProperty('setup_completed');
  });
});
