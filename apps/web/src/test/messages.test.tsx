import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_TEMPLATES,
  type MessageListDto,
  type MessageOpenDto,
  type ParentPageDto,
  type ParentReceiptDto,
  type QueueMessageDto,
  RECEIPT_LABELS,
  renderTemplate,
  waUrl,
} from '@maktab/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { MessagesPage } from '@/pages/Messages';
import { ComposePage } from '@/pages/messages/Compose';
import { ParentPage } from '@/pages/parent/ParentPage';
import { group, mockApi, renderAt, session } from './api-mock';

const ORIGIN = 'https://school.example';
const TOKEN = 'A'.repeat(43);
const LINK = `${ORIGIN}/p#${TOKEN}`;

function row(id: string, over: Partial<QueueMessageDto> = {}): QueueMessageDto {
  return {
    id,
    family_id: `F-${id}`,
    family_name: `Family ${id}`,
    guardian_id: `G-${id}`,
    guardian_name: `Guardian ${id}`,
    guardian_phone: '923001234567',
    wa_number: '923001234567',
    number: '923001234567',
    channel: 'wa_manual',
    template_key: 'absence',
    lang: 'en',
    status: 'queued',
    payload: { grp_id: group.id, grp_name: 'Class 5 A' },
    created_at: '2026-10-11T04:00:00Z',
    preview: `Preview ${id}\n{link}`,
    grp_id: group.id,
    grp_name: 'Class 5 A',
    opened_at: null,
    sent_at: null,
    sent_by_name: null,
    skipped_reason: null,
    ...over,
  };
}

const ROWS = [
  row('m1', { lang: 'ur', guardian_name: 'رضا' }),
  row('m2'),
  row('m3', {
    channel: 'call',
    template_key: 'fee_due',
    wa_number: null,
    number: '923001234567',
    grp_id: null,
  }),
  row('m4', {
    template_key: 'fee_due',
    guardian_phone: '0421234567',
    wa_number: null,
    number: null,
  }),
];

const counts = { queued: 4, sent_today: 1, skipped_today: 0, by_template: { absence: 2 } };
const list: MessageListDto = { items: ROWS, total: ROWS.length, counts };

const urText = renderTemplate(DEFAULT_TEMPLATES.absence.ur, {
  children: 'احمد اور فاطمہ',
  date: '11/10/2026',
  school: 'مکتب اسکول',
  link: LINK,
});

const openOk: MessageOpenDto = {
  id: 'm1',
  status: 'queued',
  skipped_reason: null,
  channel: 'wa_manual',
  lang: 'ur',
  text: urText,
  wa_url: waUrl('923001234567', urText),
  tel_url: 'tel:+923001234567',
  number: '923001234567',
  children: ['احمد', 'فاطمہ'],
};

const queueApi = (over: Record<string, unknown> = {}) => ({
  'GET /api/messages': list,
  'GET /api/messages/counts': counts,
  'GET /api/sessions': { items: [session] },
  'GET /api/groups': { items: [group] },
  'POST /api/messages/m1/open': openOk,
  'POST /api/messages/m1/sent': { id: 'm1', status: 'sent', replayed: false },
  'POST /api/messages/m2/skip': { id: 'm2', status: 'skipped', replayed: false },
  'POST /api/messages/m3/open': { ...openOk, id: 'm3', channel: 'call', wa_url: null },
  'POST /api/messages/m3/sent': { id: 'm3', status: 'sent', replayed: false },
  ...over,
});

type FakeWin = { opener: unknown; location: { href: string }; close: () => void };
function stubWindowOpen() {
  const win: FakeWin = { opener: {}, location: { href: '' }, close: vi.fn() };
  const open = vi.fn(() => win as unknown as Window);
  vi.stubGlobal('open', open);
  window.open = open;
  return { win, open };
}

const renderQueue = () => renderAt('/messages', '/messages', <MessagesPage />);

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
  await act(() => setLanguage('en'));
});

describe('send queue', () => {
  it('groups rows by template with counters', async () => {
    mockApi(queueApi());
    renderQueue();
    expect(await screen.findByRole('heading', { name: /Absent today/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Fee due/ })).toBeTruthy();
    await waitFor(() => expect(document.getElementById('count-pending')?.textContent).toBe('4'));
    expect(document.getElementById('count-sent')?.textContent).toBe('1');
  });

  it('Open WhatsApp → wa.me with the rebuilt Urdu text → Sent & next focuses the next row', async () => {
    const { calls } = mockApi(queueApi());
    const { win, open } = stubWindowOpen();
    renderQueue();
    await screen.findByRole('heading', { name: /Absent today/ });
    fireEvent.click(document.getElementById('msg-primary-m1') as HTMLElement);
    // The window is opened inside the tap, then pointed at wa.me after /open answers.
    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(win.location.href).toBe(openOk.wa_url));
    expect(win.opener).toBeNull();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/messages/m1/open')).toBe(true);

    // The tap-again link carries the same URL; its text param is exactly the rendered text, with
    // the parent link alone on the last line.
    const again = (await screen.findByRole('link', {
      name: /Open WhatsApp again/,
    })) as HTMLAnchorElement;
    const url = new URL(again.href);
    expect(url.origin + url.pathname).toBe('https://wa.me/923001234567');
    const text = url.searchParams.get('text') ?? '';
    expect(text).toBe(urText);
    const lines = text.split('\n');
    expect(lines[lines.length - 1]).toBe(LINK);
    expect(lines.slice(0, -1).join('\n')).not.toContain(LINK);
    expect(text).toContain('احمد اور فاطمہ');
    // The preview now shows the rebuilt text, right-to-left.
    const preview = document.getElementById('msg-text-m1');
    expect(preview?.getAttribute('dir')).toBe('rtl');
    expect(preview?.textContent).toBe(urText);

    // Nothing is marked sent by opening it.
    expect(calls.some((c) => c.path.endsWith('/sent'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Sent & next/ }));
    await waitFor(() =>
      expect(document.getElementById('msg-row-m1')?.getAttribute('data-status')).toBe('sent'),
    );
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/messages/m1/sent')).toBe(true);
    await waitFor(() => expect(document.activeElement?.id).toBe('msg-primary-m2'));
  });

  it('an absence that /open finds no longer absent shows the reason and moves on', async () => {
    mockApi(
      queueApi({
        'POST /api/messages/m1/open': {
          ...openOk,
          status: 'skipped',
          skipped_reason: 'no_longer_absent',
          wa_url: null,
        },
      }),
    );
    const { win } = stubWindowOpen();
    renderQueue();
    await screen.findByRole('heading', { name: /Absent today/ });
    fireEvent.click(document.getElementById('msg-primary-m1') as HTMLElement);
    expect(
      await screen.findByText(/Skipped automatically: No longer absent \(register corrected\)/),
    ).toBeTruthy();
    expect(win.close).toHaveBeenCalled();
    expect(win.location.href).toBe('');
    expect(document.getElementById('msg-row-m1')?.getAttribute('data-status')).toBe('skipped');
    await waitFor(() => expect(document.activeElement?.id).toBe('msg-primary-m2'));
  });

  it('a blocked popup leaves a link to tap', async () => {
    mockApi(queueApi());
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );
    window.open = vi.fn(() => null);
    renderQueue();
    await screen.findByRole('heading', { name: /Absent today/ });
    fireEvent.click(document.getElementById('msg-primary-m1') as HTMLElement);
    expect(await screen.findByText(/blocked the new window/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open WhatsApp again/ }) as HTMLAnchorElement;
    expect(link.href).toBe(openOk.wa_url);
    expect(link.rel).toContain('noopener');
  });

  it('Skip asks for a reason and posts it', async () => {
    const { calls } = mockApi(queueApi());
    renderQueue();
    await screen.findByRole('heading', { name: /Absent today/ });
    fireEvent.click(document.getElementById('msg-skip-m2') as HTMLElement);
    fireEvent.change(screen.getByLabelText('Why skip?'), { target: { value: 'duplicate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Skip this message' }));
    await waitFor(() =>
      expect(document.getElementById('msg-row-m2')?.getAttribute('data-status')).toBe('skipped'),
    );
    const skip = calls.find((c) => c.path === '/api/messages/m2/skip');
    expect(skip?.body).toEqual({ reason: 'duplicate' });
  });

  it('a call row shows a tel: link and "Called"', async () => {
    const { calls } = mockApi(queueApi());
    renderQueue();
    const tel = (await screen.findByRole('link', { name: /Call/ })) as HTMLAnchorElement;
    expect(tel.getAttribute('href')).toBe('tel:+923001234567');
    expect(screen.getByText(/call instead/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Called' }));
    await waitFor(() =>
      expect(document.getElementById('msg-row-m3')?.getAttribute('data-status')).toBe('sent'),
    );
    expect(calls.some((c) => c.path === '/api/messages/m3/sent')).toBe(true);
  });

  it('a row without a valid mobile says "Fix number" and offers only Skip', async () => {
    mockApi(queueApi());
    renderQueue();
    await screen.findByRole('heading', { name: /Fee due/ });
    const rowEl = document.getElementById('msg-row-m4') as HTMLElement;
    expect(rowEl.textContent).toContain('Fix number');
    const buttons = [...rowEl.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Skip']);
  });

  it('copies all texts of a class to the clipboard', async () => {
    const { calls } = mockApi(
      queueApi({
        'POST /api/messages/bulk-text': { text: 'one\n\ntwo', count: 2, grp_name: 'Class 5 A' },
      }),
    );
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderQueue();
    fireEvent.click(await screen.findByRole('button', { name: /Copy all texts/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('one\n\ntwo'));
    expect(calls.find((c) => c.path.startsWith('/api/messages/bulk-text'))?.path).toBe(
      `/api/messages/bulk-text?grp_id=${group.id}&template_key=absence`,
    );
  });

  it('Urdu previews read right-to-left as Urdu; the copy fallback gives each text its own direction', async () => {
    mockApi(
      queueApi({
        'POST /api/messages/bulk-text': {
          text: 'السلام علیکم\n\nHello',
          count: 2,
          grp_name: 'Class 5 A',
        },
      }),
    );
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    renderQueue();
    const ur = await waitFor(() => {
      const el = document.getElementById('msg-text-m1');
      if (!el) throw new Error('row m1 not rendered');
      return el;
    });
    expect(ur.getAttribute('dir')).toBe('rtl');
    expect(ur.getAttribute('lang')).toBe('ur');
    const en = document.getElementById('msg-text-m2');
    expect(en?.getAttribute('dir')).toBe('ltr');
    expect(en?.getAttribute('lang')).toBe('en');
    fireEvent.click(await screen.findByRole('button', { name: /Copy all texts/ }));
    const area = (await screen.findByLabelText(/copy/i, {
      selector: 'textarea',
    })) as HTMLTextAreaElement;
    expect(area.getAttribute('dir')).toBe('auto');
    expect(area.style.unicodeBidi).toBe('plaintext');
  });

  it('shows Compose only to message.compose roles', async () => {
    mockApi(queueApi());
    renderAt('/messages', '/messages', <MessagesPage />, ['accountant']);
    await screen.findByRole('heading', { name: /Absent today/ });
    expect(document.getElementById('msg-compose')).toBeNull();
  });
});

describe('compose notice', () => {
  it('previews placeholders per language and loops on `next` until done', async () => {
    let n = 0;
    const { calls } = mockApi({
      'GET /api/sessions': { items: [session] },
      'GET /api/groups': { items: [group] },
      'GET /api/school': { school: { name: 'Maktab School', name_ur: 'مکتب اسکول' } },
      'POST /api/messages/compose': () => {
        n += 1;
        return n === 1
          ? { queued: 200, skipped: 0, next: 'F200', total: 250 }
          : { queued: 49, skipped: 1, next: null, total: 250 };
      },
    });
    renderAt('/messages/compose', '/messages/compose', <ComposePage />);
    fireEvent.change(screen.getByLabelText('Notice in English'), {
      target: { value: 'School is closed tomorrow for {children}.' },
    });
    fireEvent.change(screen.getByLabelText('Notice in Urdu'), {
      target: { value: 'کل {children} کی چھٹی ہے۔' },
    });
    // The preview is the notice as sent: greeting, the text, the school, then the link alone last.
    const en = document.getElementById('compose-en-preview')?.textContent ?? '';
    expect(en).toContain('Assalamu alaikum.');
    expect(en).toContain('School is closed tomorrow for Ahmed and Fatima.');
    expect(en).toMatch(/\/p#[A-Za-z0-9_-]{43}$/);
    const ur = document.getElementById('compose-ur-preview');
    expect(ur?.textContent).toContain('کل احمد اور فاطمہ کی چھٹی ہے۔');
    expect(ur?.getAttribute('dir')).toBe('rtl');

    fireEvent.click(screen.getByRole('button', { name: 'Queue notice' }));
    expect(await screen.findByText('Done: 249 queued, 1 skipped.')).toBeTruthy();
    const posts = calls.filter((c) => c.path === '/api/messages/compose');
    expect(posts).toHaveLength(2);
    const [a, b] = posts.map((p) => p.body as Record<string, unknown>);
    expect(a?.after).toBeUndefined();
    expect(b?.after).toBe('F200');
    expect(a?.notice_id).toBeTruthy();
    expect(b?.notice_id).toBe(a?.notice_id);
    expect(a?.audience).toEqual({ kind: 'all' });
    expect(a?.body_en).toBe('School is closed tomorrow for {children}.');
  });

  it('inserts a placeholder chip and warns about unknown ones', async () => {
    mockApi({ 'GET /api/sessions': { items: [session] }, 'GET /api/groups': { items: [group] } });
    renderAt('/messages/compose', '/messages/compose', <ComposePage />);
    fireEvent.click(document.getElementById('compose-en-ph-school') as HTMLElement);
    expect((screen.getByLabelText('Notice in English') as HTMLTextAreaElement).value).toBe(
      '{school}',
    );
    fireEvent.change(screen.getByLabelText('Notice in English'), {
      target: { value: 'Hi {parent}' },
    });
    expect(screen.getByText(/Unknown placeholder/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Queue notice' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('a one-class notice needs a class', async () => {
    const { calls } = mockApi({
      'GET /api/sessions': { items: [session] },
      'GET /api/groups': { items: [group] },
    });
    renderAt('/messages/compose', '/messages/compose', <ComposePage />);
    fireEvent.click(screen.getByRole('button', { name: 'One class' }));
    fireEvent.change(screen.getByLabelText('Notice in English'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue notice' }));
    expect(await screen.findByText('Choose a class.')).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/messages/compose')).toBe(false);
  });
});

// ---- Parent page ----------------------------------------------------------------------------------

function parentPage(over: Partial<ParentPageDto> = {}): ParentPageDto {
  return {
    school: {
      name: 'Maktab School',
      name_ur: 'مکتب اسکول',
      phone: '923001112223',
      logo_v: null,
      badge_v: null,
    },
    guardian: { first_name: 'Imran', lang: 'ur' },
    turnstile_site_key: null,
    date: '2026-10-11',
    gate: { kind: 'none', passed: true },
    children: [
      {
        index: 1,
        first_name: 'Ahmed',
        group: 'Class 5 A',
        today: 'A',
        month: { present: 7, absent: 1, late: 0, excused: 0, pct: 87.5 },
      },
    ],
    dues: {
      lines: [
        {
          child: 'Ahmed',
          head_name: 'Tuition',
          head_name_ur: 'ٹیوشن',
          period_key: '2026-10',
          due_date: '2026-10-10',
          net: 500000,
          paid: 100000,
          due: 400000,
          status: 'overdue',
        },
      ],
      total_before_credit: 400000,
      credit: 50000,
      total: 350000,
      overdue: 350000,
    },
    receipts: [{ receipt_no: 'R-2026-00001', amount: 100000, business_date: '2026-10-05' }],
    notices: [{ at: '2026-10-09T05:00:00Z', body_en: 'Closed on {date}', body_ur: '' }],
    ...over,
  };
}

function parentReceipt(): ParentReceiptDto {
  return {
    school: {
      name: 'Maktab School',
      name_ur: null,
      address: null,
      phone: null,
      logo_v: null,
      badge_v: null,
    },
    labels: RECEIPT_LABELS,
    lang: 'en',
    receipt: {
      receipt_no: 'R-2026-00001',
      business_date: '2026-10-05',
      amount: 100000,
      method: 'cash',
      payer_name: 'Imran',
    },
    students: [
      {
        child: 1,
        first_name: 'Ahmed',
        lines: [
          { period_key: '2026-10', head_name: 'Tuition', head_name_ur: null, amount: 100000 },
        ],
        subtotal: 100000,
      },
    ],
    totals: { amount: 100000, allocated: 100000, credit_added: 0, payer_due: 0, payer_credit: 0 },
    reversed: false,
  };
}

/** The real page reads its token from window.location's fragment (/p#<token>). */
const renderParent = (hash = `#${TOKEN}`) => {
  window.history.replaceState(null, '', `/p${hash}`);
  return renderAt('/p', '/p/*', <ParentPage />);
};

function stubSpeech(voices: { lang: string }[] = []) {
  const speak = vi.fn();
  vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn(), getVoices: () => voices });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      lang = '';
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    },
  );
  return speak;
}

describe('parent page', () => {
  it('opens in Urdu (dir=rtl) for an Urdu guardian, with noindex and the Listen button', async () => {
    const speak = stubSpeech([]);
    mockApi({ ['GET /api/p']: parentPage() });
    renderParent();
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    await screen.findByText('ٹیوشن');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    expect(document.getElementById('parent-private')?.textContent).toContain('آگے نہ بھیجیں');
    // "How it's calculated": head in Urdu, credit subtracted.
    expect(screen.getByText('ٹیوشن')).toBeTruthy();
    expect(document.getElementById('parent-total')?.textContent).toBe('PKR 3,500');

    const listen = document.getElementById('parent-listen') as HTMLElement;
    expect(listen).toBeTruthy();
    fireEvent.click(listen);
    expect(speak).toHaveBeenCalledTimes(1);
    // No Urdu voice on this phone: the English summary in the default voice.
    const u = speak.mock.calls[0]?.[0] as { text: string; lang: string };
    expect(u.lang).toBe('en');
    expect(u.text).toContain('Ahmed: Absent today.');
    expect(u.text).toContain('3,500');
  });

  it('speaks Urdu when the phone has an Urdu voice', async () => {
    const speak = stubSpeech([{ lang: 'ur-PK' }]);
    mockApi({ ['GET /api/p']: parentPage() });
    renderParent();
    fireEvent.click(await screen.findByRole('button', { name: /سنیں/ }));
    const u = speak.mock.calls[0]?.[0] as { text: string; lang: string };
    expect(u.lang).toBe('ur-PK');
    expect(u.text).toContain('غیر حاضر');
  });

  it('hides Listen without speechSynthesis', async () => {
    mockApi({ ['GET /api/p']: parentPage({ guardian: { first_name: 'I', lang: 'en' } }) });
    renderParent();
    await screen.findByText(/Assalamu alaikum,/);
    expect(document.getElementById('parent-listen')).toBeNull();
  });

  it('asks the gate, then re-fetches with x-parent-gate', async () => {
    const seen: (string | null)[] = [];
    const { calls } = mockApi({
      ['GET /api/p']: (_url: URL, init: RequestInit) => {
        const h = new Headers(init.headers);
        seen.push(h.get('x-parent-gate'));
        return h.get('x-parent-gate') === 'GT'
          ? parentPage({
              guardian: { first_name: 'I', lang: 'en' },
              gate: { kind: 'birth_year', passed: true },
            })
          : parentPage({
              guardian: { first_name: 'I', lang: 'en' },
              gate: { kind: 'birth_year', passed: false },
              dues: null,
              receipts: null,
            });
      },
      ['POST /api/p/gate']: (_url: URL, init: RequestInit) =>
        JSON.parse(String(init.body)).birth_year === 2015
          ? { gate_token: 'GT', expires_at: '2026-10-11T20:00:00Z' }
          : new Response(JSON.stringify({ error: { code: 'gate_failed', message: 'x' } }), {
              status: 400,
            }),
    });
    renderParent();
    const input = await screen.findByLabelText(/Birth year/);
    expect(document.getElementById('parent-total')).toBeNull();
    fireEvent.change(input, { target: { value: '2014' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('That does not match. Try again.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '2015' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(document.getElementById('parent-total')).toBeTruthy());
    expect(seen[seen.length - 1]).toBe('GT');
    expect(calls.filter((c) => c.path === '/api/p/gate').map((c) => c.body)).toEqual([
      { birth_year: 2014 },
      { birth_year: 2015 },
    ]);
    expect(sessionStorage.getItem(`maktab.pgate.${TOKEN.slice(0, 12)}`)).toBe('GT');
  });

  it('Turnstile on: the gate waits for the widget, sends its token, gets a fresh one per try', async () => {
    let n = 0;
    const rendered: string[] = [];
    window.turnstile = {
      render: (_el, opts) => {
        rendered.push(opts.sitekey);
        n += 1;
        const tok = `tok-${n}`;
        setTimeout(() => opts.callback(tok), 0);
        return `w${n}`;
      },
      remove: () => undefined,
    };
    const { calls } = mockApi({
      ['GET /api/p']: parentPage({
        guardian: { first_name: 'I', lang: 'en' },
        gate: { kind: 'birth_year', passed: false },
        turnstile_site_key: 'SITE',
        dues: null,
        receipts: null,
      }),
      ['POST /api/p/gate']: () =>
        new Response(JSON.stringify({ error: { code: 'gate_failed', message: 'x' } }), {
          status: 400,
        }),
    });
    try {
      renderParent();
      const input = await screen.findByLabelText(/Birth year/);
      fireEvent.change(input, { target: { value: '2014' } });
      const open = screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement;
      await waitFor(() => expect(open.disabled).toBe(false));
      fireEvent.click(open);
      expect(await screen.findByText('That does not match. Try again.')).toBeTruthy();
      await waitFor(() => expect(rendered).toHaveLength(2));
      await waitFor(() => expect(open.disabled).toBe(false));
      fireEvent.click(open);
      await waitFor(() => expect(calls.filter((c) => c.path === '/api/p/gate')).toHaveLength(2));
      const bodies = calls
        .filter((c) => c.path === '/api/p/gate')
        .map((c) => c.body as { birth_year: number; turnstile_token: string });
      expect(bodies.map((b) => b.birth_year)).toEqual([2014, 2014]);
      // Each answer carried a token, and never the same one twice (single-use).
      expect(bodies.every((b) => /^tok-\d+$/.test(b.turnstile_token))).toBe(true);
      expect(bodies[0]?.turnstile_token).not.toBe(bodies[1]?.turnstile_token);
      expect(new Set(rendered)).toEqual(new Set(['SITE']));
    } finally {
      window.turnstile = undefined;
    }
  });

  it('sends the token only in X-Parent-Token, never in a URL', async () => {
    const tokens: (string | null)[] = [];
    const { calls } = mockApi({
      'GET /api/p': (_url: URL, init: RequestInit) => {
        tokens.push(new Headers(init.headers).get('x-parent-token'));
        return parentPage({ guardian: { first_name: 'I', lang: 'en' } });
      },
    });
    renderParent();
    await screen.findByText(/Assalamu alaikum,/);
    expect(tokens[0]).toBe(TOKEN);
    for (const c of calls) expect(c.path).not.toContain(TOKEN);
  });

  it('without a token in the fragment it shows the invalid page and calls nothing', async () => {
    const { calls } = mockApi({ 'GET /api/p': parentPage() });
    renderParent('');
    expect(await screen.findByText('This link is not valid any more')).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('the language toggle never saves to localStorage (shared phones, staff app)', async () => {
    localStorage.setItem('maktab.lang', 'en');
    mockApi({ 'GET /api/p': parentPage() });
    renderParent();
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(localStorage.getItem('maktab.lang')).toBe('en');
    fireEvent.click(screen.getByText('English').closest('button') as HTMLElement);
    await waitFor(() => expect(document.documentElement.dir).toBe('ltr'));
    fireEvent.click(screen.getByText('اردو').closest('button') as HTMLElement);
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(localStorage.getItem('maktab.lang')).toBe('en');
  });

  it('an invalid link gets a friendly page', async () => {
    mockApi({});
    renderParent();
    expect(await screen.findByText('This link is not valid any more')).toBeTruthy();
  });

  it('opens a receipt in print view and goes back', async () => {
    mockApi({
      ['GET /api/p']: parentPage({ guardian: { first_name: 'I', lang: 'en' } }),
      'GET /api/p/receipt/R-2026-00001': () => parentReceipt(),
    });
    renderParent();
    fireEvent.click(await screen.findByRole('button', { name: /Open receipt R-2026-00001/ }));
    await waitFor(() => expect(document.querySelector('.receipt')).toBeTruthy());
    expect(document.querySelector('img.receipt-logo')).toBeNull();
    // The public copy shows no collector and no admission number.
    const paper = document.getElementById('receipt-paper')?.textContent ?? '';
    expect(paper).toContain('Ahmed');
    expect(paper).not.toMatch(/Collected by|Collector|Adm/i);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText(/Assalamu alaikum,/)).toBeTruthy();
  });

  it('the receipt shows the school logo from /api/p/logo (token header, versioned URL, blob)', async () => {
    const created: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (b: Blob) => {
          created.push(b);
          return 'blob:logo-1';
        },
        revokeObjectURL: () => undefined,
      }),
    );
    const seen: (string | null)[] = [];
    mockApi({
      ['GET /api/p']: parentPage({ guardian: { first_name: 'I', lang: 'en' } }),
      'GET /api/p/receipt/R-2026-00001': () => ({
        ...parentReceipt(),
        school: { ...parentReceipt().school, logo_v: 'abc123' },
      }),
      'GET /api/p/logo': (_url: URL, init: RequestInit) => {
        seen.push(new Headers(init.headers).get('x-parent-token'));
        return new Response(new Uint8Array([0x89, 0x50]), {
          headers: { 'content-type': 'image/png' },
        });
      },
    });
    renderParent();
    fireEvent.click(await screen.findByRole('button', { name: /Open receipt R-2026-00001/ }));
    await waitFor(() =>
      expect(document.querySelector('img.receipt-logo')?.getAttribute('src')).toBe('blob:logo-1'),
    );
    expect(seen).toEqual([TOKEN]);
    expect(created).toHaveLength(1);
  });

  it('M7b: no logo → the generated badge from /api/p/badge, on the page header and the receipt', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: () => 'blob:badge-1',
        revokeObjectURL: () => undefined,
      }),
    );
    const seen: string[] = [];
    mockApi({
      ['GET /api/p']: parentPage({
        guardian: { first_name: 'I', lang: 'en' },
        school: { ...parentPage().school, badge_v: 'b1' },
      }),
      'GET /api/p/receipt/R-2026-00001': () => ({
        ...parentReceipt(),
        school: { ...parentReceipt().school, badge_v: 'b1' },
      }),
      'GET /api/p/badge': (url: URL, init: RequestInit) => {
        seen.push(`${url.search} ${new Headers(init.headers).get('x-parent-token')}`);
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
          headers: { 'content-type': 'image/svg+xml' },
        });
      },
    });
    renderParent();
    await waitFor(() =>
      expect(document.getElementById('parent-school-mark')?.getAttribute('src')).toBe(
        'blob:badge-1',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Open receipt R-2026-00001/ }));
    await waitFor(() =>
      expect(document.querySelector('img.receipt-logo')?.getAttribute('src')).toBe('blob:badge-1'),
    );
    expect(seen[0]).toBe(`?v=b1 ${TOKEN}`);
  });
});

// ---- RTL and untranslated text --------------------------------------------------------------------

/** Visible text that is not data (same rule as fees-rtl.test.tsx). */
function uiText(root: Element): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(n.textContent ?? '');
      return;
    }
    if (!(n instanceof Element)) return;
    // Form values (a textarea's text) are what the user typed: data.
    if (['BDI', 'OPTION', 'SCRIPT', 'STYLE', 'TEXTAREA'].includes(n.tagName)) return;
    if (n.classList.contains('num') || n.getAttribute('lang') === 'en') return;
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out.join(' ');
}

describe('RTL smoke: messaging screens in Urdu', () => {
  it('send queue', async () => {
    await act(() => setLanguage('ur'));
    mockApi(queueApi());
    const { container } = renderQueue();
    await screen.findByRole('heading', { name: /آج غیر حاضر/ });
    expect(document.documentElement.dir).toBe('rtl');
    const latin = uiText(container).match(/[A-Za-z]{2,}/g) ?? [];
    expect(latin, `untranslated: ${latin.join(', ')}`).toEqual([]);
  });

  it('parent page', async () => {
    stubSpeech([]);
    mockApi({ ['GET /api/p']: parentPage() });
    const { container } = renderParent();
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    await screen.findByText('ٹیوشن');
    const latin = uiText(container).match(/[A-Za-z]{2,}/g) ?? [];
    expect(latin, `untranslated: ${latin.join(', ')}`).toEqual([]);
  });

  it('compose', async () => {
    await act(() => setLanguage('ur'));
    mockApi({ 'GET /api/sessions': { items: [session] }, 'GET /api/groups': { items: [group] } });
    const { container } = renderAt('/messages/compose', '/messages/compose', <ComposePage />);
    fireEvent.change(screen.getByLabelText('اردو میں اطلاع'), {
      target: { value: 'کل {children} کی چھٹی ہے۔' },
    });
    const latin = uiText(container).match(/[A-Za-z]{2,}/g) ?? [];
    expect(latin, `untranslated: ${latin.join(', ')}`).toEqual([]);
  });
});

/** Lint-style: no hard-coded English in the messaging JSX (same check as the fee screens). */
describe('no hard-coded English in messaging JSX', () => {
  const dirs = ['src/pages/messages', 'src/pages/parent', 'src/components/messages'];
  const single = ['src/pages/Messages.tsx', 'src/pages/Settings.tsx', 'src/pages/Dashboard.tsx'];
  const files = [
    ...dirs.flatMap((r) => {
      const dir = join(process.cwd(), r);
      return readdirSync(dir)
        .map((f) => join(dir, f))
        .filter((f) => statSync(f).isFile() && f.endsWith('.tsx'));
    }),
    ...single.map((f) => join(process.cwd(), f)),
  ];
  it('finds the files', () => {
    // M7b: the messages tile moved into Home, so pages/Dashboard.tsx is scanned too (9 files).
    expect(files.length).toBeGreaterThanOrEqual(9);
  });
  it.each(files.map((f) => [f.slice(f.indexOf('src/')), f]))('%s', (_short, file) => {
    expect(literals(readFileSync(file, 'utf8'))).toEqual([]);
  });
});

function literals(src: string): string[] {
  const ALLOWED = new Set(['English', 'اردو']);
  const bad: string[] = [];
  for (const m of src.matchAll(/>(\s*)([^<>{}\n]*[A-Za-z؀-ۿ][^<>{}\n]*?)(\s*)([<{])/g)) {
    const text = (m[2] ?? '').trim();
    if (!text || ALLOWED.has(text)) continue;
    const start = m.index ?? 0;
    if (src[start - 1] === '=') continue;
    if (m[4] === '<' && !m[3] && src[start + m[0].length] !== '/' && /^[\w.]+$/.test(text))
      continue;
    if (/[=;()]|&&|\|\|/.test(text)) continue;
    bad.push(text);
  }
  for (const m of src.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-z][^"]*)"/g))
    bad.push(`${m[1]}="${m[2]}"`);
  return bad;
}
