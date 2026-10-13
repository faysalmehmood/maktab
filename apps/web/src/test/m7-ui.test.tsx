import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FeeLinesTable } from '@/components/fees/common';
import { LogoUpload } from '@/components/setup/school';
import { initI18n, setLanguage } from '@/i18n';
import { mockApi, renderAt } from './api-mock';
import { familyLines } from './fee-fixtures';

// M7 UI defects (docs/ui-enhancement-plan.md §4.6) not covered by their screens' own tests.

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

const headers = () => [...document.querySelectorAll('th')].map((th) => th.textContent ?? '');

describe('student / family fee table', () => {
  it('has no duplicate column header, in English or Urdu (4.6.5)', async () => {
    render(<FeeLinesTable lines={familyLines} />);
    const en = headers().filter(Boolean);
    expect(new Set(en).size).toBe(en.length);
    expect(en).toContain('Full fee');
    await act(() => setLanguage('ur'));
    const ur = headers().filter(Boolean);
    expect(new Set(ur).size).toBe(ur.length);
  });
});

describe('logo upload (4.6.7)', () => {
  const school = {
    id: 'S',
    name: 'Al-Noor',
    name_ur: null,
    mode: 'school' as const,
    address: null,
    phone: null,
    default_lang: 'ur' as const,
    receipt_prefix: null,
    has_logo: false,
    short_name: null,
    city: null,
    brand_color: null,
    setup_completed_at: null,
    attendance_mode: 'daily' as const,
    weekly_off: [0],
  };

  it('the hint states the API limit, and a larger file is refused before upload', async () => {
    const api = mockApi({ 'POST /api/school/logo': { school } });
    renderAt('/', '/', <LogoUpload school={school} />);
    expect(screen.getByText('PNG, JPEG or WebP, up to 512 KB.')).toBeTruthy();
    const input = document.getElementById('school-logo') as HTMLInputElement;
    const big = new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [big] } });
    expect(
      await screen.findByText('This file is larger than 512 KB. Choose a smaller image.'),
    ).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/school/logo')).toBe(false);
    const ok = new File([new Uint8Array(1000)], 'ok.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [ok] } });
    await vi.waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/school/logo')).toBe(
        true,
      ),
    );
  });
});
