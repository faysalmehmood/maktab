import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InstallBanner } from '@/components/InstallBanner';
import { initI18n, setLanguage } from '@/i18n';
import { printWhenReady } from '@/lib/print';
import { isOfflineApi } from '@/offline/api-cache';
import { collectDiag, DiagPage, diagReport } from '@/pages/Diag';
import { manifest } from '../../pwa-manifest';
import { mockApi, renderAt } from './api-mock';

// M7 PWA polish: installability basics (what Lighthouse checks), the offline read cache, the
// Android install banner, the /diag page and the fonts guard on print.

const web = (p: string) => resolve(__dirname, '../..', p);
const pngSize = (file: string) => {
  const b = readFileSync(file);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  await act(() => setLanguage('en'));
});

describe('installability basics', () => {
  it('manifest: name, start_url, scope, standalone, theme colour, 192/512 + maskable icons that exist', () => {
    expect(manifest).toMatchObject({
      id: '/',
      name: 'Maktab',
      short_name: 'Maktab',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    const icons = manifest.icons ?? [];
    for (const want of ['192x192', '512x512'])
      expect(icons.some((i) => i.sizes === want && !i.purpose)).toBe(true);
    const maskable = icons.find((i) => i.purpose === 'maskable');
    expect(maskable?.sizes).toBe('512x512');
    for (const i of icons.filter((x) => x.type === 'image/png'))
      expect(pngSize(web(`public${i.src}`)), i.src).toBe(i.sizes);
  });

  it('index.html: theme-color matches the manifest, viewport, apple-touch-icon, description', () => {
    const html = readFileSync(web('index.html'), 'utf8');
    expect(html).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1/);
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    expect(pngSize(web('public/icons/apple-touch-icon.png'))).toBe('180x180');
    expect(html).toMatch(/<meta name="description" content="[^"]+"/);
    expect(html).toMatch(/<html lang="en"/);
  });
});

describe('offline read cache (NetworkFirst)', () => {
  const at = (p: string) => isOfflineApi({ url: new URL(p, 'https://s.pk'), sameOrigin: true });
  it("keeps a teacher's class roster and the counter's family view; never writes or lists", () => {
    expect(at('/api/groups/01JAAAAAAAAAAAAAAAAAAAAAG1')).toBe(true);
    expect(at('/api/fees/family/01JAAAAAAAAAAAAAAAAAAAAAF1')).toBe(true);
    for (const p of [
      '/api/groups',
      '/api/groups/01JAAAAAAAAAAAAAAAAAAAAAG1/archive',
      '/api/fees/family/x',
      '/api/fees/search',
      '/api/receipts',
      '/api/fees/defaulters',
    ])
      expect(at(p), p).toBe(false);
  });
});

describe('install banner (Android)', () => {
  const fire = () => {
    const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    e.prompt = vi.fn(async () => undefined);
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    act(() => {
      window.dispatchEvent(e);
    });
    return e;
  };

  it('holds the browser prompt and offers it in the UI language; Install calls prompt()', async () => {
    render(<InstallBanner />);
    expect(document.getElementById('install-banner')).toBeNull();
    const e = fire();
    expect(e.defaultPrevented).toBe(true);
    expect(await screen.findByText('Install Maktab on this phone')).toBeTruthy();
    expect(screen.getByText(/works without internet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(e.prompt).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.getElementById('install-banner')).toBeNull());
  });

  it('Urdu explanation in Urdu; "Not now" snoozes it', async () => {
    await act(() => setLanguage('ur'));
    const { unmount } = render(<InstallBanner />);
    fire();
    expect(await screen.findByText('مکتب کو اس فون پر انسٹال کریں')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ابھی نہیں' }));
    expect(document.getElementById('install-banner')).toBeNull();
    unmount();
    render(<InstallBanner />);
    fire();
    expect(document.getElementById('install-banner')).toBeNull();
  });

  it('never when already installed (display-mode standalone)', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('standalone') }));
    render(<InstallBanner />);
    fire();
    expect(document.getElementById('install-banner')).toBeNull();
  });
});

describe('/diag (owner device check)', () => {
  it('collects every probe without throwing, and the report is copyable text', async () => {
    const rows = await collectDiag();
    const keys = rows.map((r) => r.key);
    for (const k of [
      'online',
      'outbox pending',
      'service worker',
      'storage persisted',
      'speech voices',
      'web share',
      'canShare(files: PDF)',
      'display mode',
    ])
      expect(keys).toContain(k);
    expect(rows.find((r) => r.key === 'service worker')?.value).toBe('unsupported');
    expect(diagReport(rows).split('\n')[0]).toBe('Maktab /diag');
  });

  it('is owner-only (role.manage)', async () => {
    mockApi({});
    const { App } = await import('@/App');
    renderAt('/diag', '/*', <App />, ['admin']);
    await waitFor(() => expect(document.getElementById('diag')).toBeNull());
    renderAt('/diag', '/*', <DiagPage />, ['owner']);
    await waitFor(() => expect(document.getElementById('diag')).toBeTruthy());
  });
});

describe('print waits for fonts, but never forever', () => {
  it('prints after fonts.ready, or after the timeout if fonts never settle', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    Object.defineProperty(document, 'fonts', {
      value: { ready: new Promise(() => undefined) },
      configurable: true,
    });
    await printWhenReady(20);
    expect(print).toHaveBeenCalledOnce();
    Object.defineProperty(document, 'fonts', { value: undefined, configurable: true });
    await printWhenReady(20);
    expect(print).toHaveBeenCalledTimes(2);
  });
});
