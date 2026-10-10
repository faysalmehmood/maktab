import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { SetupWizard } from '@/pages/Setup';
import { mockApi, renderAt } from './api-mock';

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
    setup_completed_at: null,
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
});
