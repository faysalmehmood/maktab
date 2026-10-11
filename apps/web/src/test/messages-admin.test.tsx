import {
  DEFAULT_TEMPLATES,
  MESSAGE_LANGS,
  type MessageTemplateDto,
  type ParentLinkStatusDto,
  TEMPLATE_KEYS,
} from '@maktab/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageSettings } from '@/components/messages/MessageSettings';
import { MessagesTile } from '@/components/messages/MessagesTile';
import { ParentLinkPanel } from '@/components/messages/ParentLinkPanel';
import { initI18n, setLanguage } from '@/i18n';
import { visibleSections } from '@/pages/Settings';
import { mockApi, renderAt } from './api-mock';

const G = 'G1';
const URL_ONCE = `https://school.example/p/${'B'.repeat(43)}`;
const guardian = {
  id: G,
  name: 'Imran Raza',
  phone: '03001234567',
  whatsapp: null,
  lang: 'ur' as const,
};

const noLink: ParentLinkStatusDto = { guardian_id: G, link: null, access: [] };
const liveLink: ParentLinkStatusDto = {
  guardian_id: G,
  link: {
    id: 'L1',
    created_at: '2026-10-11T04:00:00Z',
    created_by_name: 'Owner',
    expires_at: '2027-10-11T04:00:00Z',
    last_seen_at: null,
    gate: 'pin',
    status: 'active',
  },
  access: [{ at: '2026-10-11T05:00:00Z', ip_hash: 'h', ua: 'Mozilla/5.0 (Linux; Android 13)' }],
};

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

describe('parent link panel', () => {
  it('creates a PIN link, shows the URL once with a wa.me send, then revokes', async () => {
    const { calls } = mockApi({
      [`GET /api/guardians/${G}/parent-link`]: noLink,
      [`POST /api/guardians/${G}/parent-link`]: { ...liveLink, url: URL_ONCE },
      [`POST /api/guardians/${G}/parent-link/revoke`]: {
        ...liveLink,
        link: { ...liveLink.link, status: 'revoked' },
      },
    });
    renderAt('/s', '/s', <ParentLinkPanel guardian={guardian} />);
    fireEvent.click(screen.getByRole('button', { name: /Parent page link/ }));
    expect(await screen.findByText('No link yet.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Check before dues'), { target: { value: 'pin' } });
    const create = screen.getByRole('button', { name: /Create link/ }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/PIN \(4/), { target: { value: '12a34' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() =>
      expect(document.getElementById(`plink-url-${G}`)?.textContent).toBe(URL_ONCE),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ gate: 'pin', pin: '1234' });

    // Sent in the guardian's language (Urdu), to the normalised mobile, the URL alone at the end.
    const wa = document.getElementById(`plink-wa-${G}`) as HTMLAnchorElement;
    const u = new URL(wa.href);
    expect(u.pathname).toBe('/923001234567');
    const lines = (u.searchParams.get('text') ?? '').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('السلام علیکم');
    expect(lines[1]).toBe(URL_ONCE);

    // Now live: rotate, access log, revoke behind a confirm.
    expect(screen.getByRole('button', { name: /New link/ })).toBeTruthy();
    expect(screen.getByText('Mozilla/5.0 (Linux; Android 13)')).toBeTruthy();
    fireEvent.click(document.getElementById(`plink-revoke-${G}`) as HTMLElement);
    expect(calls.some((c) => c.path.endsWith('/revoke'))).toBe(false);
    fireEvent.click(document.getElementById(`plink-revoke-confirm-${G}`) as HTMLElement);
    await waitFor(() =>
      expect(document.getElementById(`plink-status-${G}`)?.textContent).toBe('Revoked'),
    );
    expect(document.getElementById(`plink-url-${G}`)).toBeNull();
  });

  it('shows pin_required from the API', async () => {
    mockApi({
      [`GET /api/guardians/${G}/parent-link`]: noLink,
      [`POST /api/guardians/${G}/parent-link`]: new Response(
        JSON.stringify({ error: { code: 'pin_required', message: 'x' } }),
        { status: 400 },
      ),
    });
    renderAt('/s', '/s', <ParentLinkPanel guardian={guardian} />);
    fireEvent.click(screen.getByRole('button', { name: /Parent page link/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Create link/ }));
    expect(await screen.findByText('Choose a 4 to 6 digit PIN for this link.')).toBeTruthy();
  });
});

const templates = (): { items: MessageTemplateDto[] } => ({
  items: TEMPLATE_KEYS.flatMap((key) =>
    MESSAGE_LANGS.map((lang) => ({
      key,
      lang,
      body: DEFAULT_TEMPLATES[key][lang],
      default_body: DEFAULT_TEMPLATES[key][lang],
      is_default: true,
      updated_at: null,
      updated_by_name: null,
    })),
  ),
});

describe('settings → messages', () => {
  it('is a settings tab for owner/admin only', () => {
    expect(visibleSections(['owner'])).toContain('messages');
    expect(visibleSections(['admin'])).toContain('messages');
    expect(visibleSections(['accountant'])).not.toContain('messages');
  });

  it('edits a template with live preview, warns on unknown placeholders, saves and resets', async () => {
    const { calls } = mockApi({
      'GET /api/messages/templates': templates(),
      'GET /api/school/messages': {
        reminder_cooldown_days: 7,
        parent_gate: 'none',
        announcement_groups_note: null,
      },
      'PUT /api/school/messages': (_u: URL, init: RequestInit) => JSON.parse(String(init.body)),
      'GET /api/school': { school: { name: 'Maktab School', name_ur: null } },
      'PUT /api/messages/templates/absence/en': (_u: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)).body as string | null;
        return {
          item: {
            ...templates().items[0],
            body: body ?? DEFAULT_TEMPLATES.absence.en,
            is_default: body === null,
          },
        };
      },
    });
    renderAt('/settings', '/settings', <MessageSettings />);
    const en = (await screen.findByLabelText('English')) as HTMLTextAreaElement;
    expect(en.value).toBe(DEFAULT_TEMPLATES.absence.en);
    expect(document.getElementById('tpl-absence-en-preview')?.textContent).toContain(
      'Ahmed and Fatima was absent',
    );
    fireEvent.change(en, { target: { value: 'Hi {parent}, {children} absent. {link}' } });
    expect(screen.getByText(/Unknown placeholder/)).toBeTruthy();
    expect((document.getElementById('tpl-absence-en-save') as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(en, { target: { value: '{children} absent today. {link}' } });
    const preview = document.getElementById('tpl-absence-en-preview')?.textContent ?? '';
    expect(preview.split('\n').pop()).toMatch(/\/p\/\w{43}$/);
    fireEvent.click(document.getElementById('tpl-absence-en-save') as HTMLElement);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.path.includes('templates'))?.body).toEqual({
        body: '{children} absent today. {link}',
      }),
    );
    await waitFor(() =>
      expect((document.getElementById('tpl-absence-en-reset') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(document.getElementById('tpl-absence-en-reset') as HTMLElement);
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'PUT' && c.path.includes('templates')).at(-1)?.body,
      ).toEqual({ body: null }),
    );

    fireEvent.change(screen.getByLabelText(/Days between fee reminders/), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText(/Parent page check/), {
      target: { value: 'birth_year' },
    });
    fireEvent.click(document.querySelector('#msg-settings button[type=submit]') as HTMLElement);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'PUT' && c.path === '/api/school/messages')?.body,
      ).toEqual({
        reminder_cooldown_days: 10,
        parent_gate: 'birth_year',
        announcement_groups_note: null,
      }),
    );
  });
});

describe('dashboard tile', () => {
  it('shows the queued count linking to the queue', async () => {
    mockApi({
      'GET /api/messages/counts': { queued: 12, sent_today: 0, skipped_today: 0, by_template: {} },
    });
    renderAt('/', '/', <MessagesTile />);
    const link = (await screen.findByRole('link', {
      name: /Messages waiting/,
    })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/messages');
    expect(link.textContent).toContain('12');
  });
});
