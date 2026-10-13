import {
  type AdmissionResult,
  type GroupDto,
  PARENT_TOKEN_HEADER,
  type ParentLinkCreatedDto,
  type ParentPageDto,
  type ProgrammeDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/env';
import { RateLimiter } from '../src/lib/ratelimit';
import { TURNSTILE_VERIFY_URL } from '../src/lib/turnstile';
import { signedInAs, testApp } from './helpers';

// M7 hardening over HTTP: the per-IP limiter on /api/p* and /api/auth/* (headers, 429), and
// optional Turnstile on the parent gate and in front of Google sign-in — off unless both keys are
// set, in which case behaviour is unchanged.

const TS_ON: Partial<Bindings> = {
  TURNSTILE_SITE_KEY: '0x4AAAAAAAtestsitekey',
  TURNSTILE_SECRET: '0x4AAAAAAAtestsecret',
};

/** Fake siteverify: tokens starting "good" pass. Records what the Worker sent. */
function fakeTurnstile() {
  const calls: { secret: string; response: string }[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    if (input !== TURNSTILE_VERIFY_URL) return new Response('{}', { status: 404 });
    const form = init?.body as FormData;
    const response = String(form.get('response'));
    calls.push({ secret: String(form.get('secret')), response });
    return Response.json({ success: response.startsWith('good') });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

async function parentFixture(env: Partial<Bindings> = {}, fetch?: typeof globalThis.fetch) {
  const t = testApp({ env, ...(fetch ? { fetch } : {}) });
  const owner = await signedInAs(t.db, ['owner']);
  const api = async <T>(method: string, path: string, body?: unknown) => {
    const res = await t.request(path, {
      method,
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  await api('PUT', '/api/school', { name: 'Al-Noor', mode: 'school' });
  await api('POST', '/api/sessions', {
    name: 'S',
    start_date: '2026-01-01',
    end_date: '2027-12-31',
  });
  const progs = await api<{ items: ProgrammeDto[] }>('POST', '/api/programmes/seed-pk');
  const p5 = progs.body.items.find((p) => p.name === 'Class 5')?.id as string;
  const g = (await api<GroupDto>('POST', '/api/groups', { programme_id: p5, name: '5-A' })).body;
  const a = await api<AdmissionResult>('POST', '/api/admissions', {
    family: { name: 'Khan' },
    guardians: [{ name: 'Imran', relation: 'father', phone: '0300-1234567' }],
    student: { name: 'Ali', admission_date: '2026-04-01', dob: '2015-03-01' },
    enrolment: { grp_id: g.id },
  });
  const link = await api<ParentLinkCreatedDto>(
    'POST',
    `/api/guardians/${a.body.guardian_ids[0]}/parent-link`,
    { gate: 'birth_year' },
  );
  expect(link.status).toBe(201);
  const token = link.body.url.split('#')[1] ?? '';
  const asParent = (method: string, path: string, body?: unknown, ip = '203.0.113.7') =>
    t.request(path, {
      method,
      headers: {
        [PARENT_TOKEN_HEADER]: token,
        'cf-connecting-ip': ip,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...t, asParent };
}

describe('per-IP rate limiting (defence in depth)', () => {
  it('/api/auth/*: 20 a minute per IP with RateLimit headers, then 429 + Retry-After', async () => {
    const t = testApp();
    const hit = (ip: string) =>
      t.request('/api/auth/google/start', { headers: { 'cf-connecting-ip': ip } });
    for (let i = 0; i < 20; i++) {
      const r = await hit('198.51.100.1');
      expect(r.status).toBe(302);
      expect(r.headers.get('ratelimit-limit')).toBe('20');
      expect(r.headers.get('ratelimit-remaining')).toBe(String(19 - i));
    }
    const over = await hit('198.51.100.1');
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(over.headers.get('ratelimit-remaining')).toBe('0');
    // Another IP is not affected.
    expect((await hit('198.51.100.2')).status).toBe(302);
  });

  it('/api/p*: 60 a minute per IP', async () => {
    const f = await parentFixture();
    for (let i = 0; i < 60; i++) {
      const r = await f.asParent('GET', '/api/p', undefined, `10.0.0.${i % 2}`);
      if (i < 2) expect(r.headers.get('ratelimit-limit')).toBe('60');
    }
    // 30 each from two IPs: both still under; the token limiter (60/token) is now spent though.
    const r = await f.asParent('GET', '/api/p', undefined, '10.0.0.9');
    expect(r.status).toBe(429);
    const t2 = await parentFixture();
    for (let i = 0; i < 60; i++) {
      const res = await t2.asParent('GET', '/api/p', undefined, '10.9.9.9');
      expect(res.status, `${i} ${await res.text()}`).toBe(200);
    }
    const over = await t2.asParent('GET', '/api/p', undefined, '10.9.9.9');
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
  });

  it('the limiter window resets', () => {
    const l = new RateLimiter(2, 1000);
    expect(l.hit('k', 0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(l.hit('k', 10).allowed).toBe(true);
    expect(l.hit('k', 20)).toMatchObject({ allowed: false, remaining: 0, resetMs: 980 });
    expect(l.hit('k', 1000).allowed).toBe(true);
  });
});

describe('Turnstile on the parent gate', () => {
  it('off (no keys): the gate takes no token and the page offers no widget', async () => {
    const f = await parentFixture();
    const page = (await (await f.asParent('GET', '/api/p')).json()) as ParentPageDto;
    expect(page.turnstile_site_key).toBeNull();
    expect((await f.asParent('POST', '/api/p/gate', { birth_year: 2015 })).status).toBe(200);
    const shell = await f.request('/p');
    expect(shell.headers.get('content-security-policy')).not.toContain('challenges.cloudflare.com');
  });

  it('on: needs a verified token before an attempt is even counted', async () => {
    const ts = fakeTurnstile();
    const f = await parentFixture(TS_ON, ts.fetch);
    const page = (await (await f.asParent('GET', '/api/p')).json()) as ParentPageDto;
    expect(page.turnstile_site_key).toBe(TS_ON.TURNSTILE_SITE_KEY);
    for (const body of [{ birth_year: 2015 }, { birth_year: 2015, turnstile_token: 'bot' }]) {
      const r = await f.asParent('POST', '/api/p/gate', body);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: { code: 'turnstile_failed' } });
    }
    const [row] = await f.db.all<{ gate_failures: number }>(
      sql`SELECT gate_failures FROM parent_link`,
    );
    expect(row?.gate_failures).toBe(0);
    const wrong = await f.asParent('POST', '/api/p/gate', {
      birth_year: 2001,
      turnstile_token: 'good-1',
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: { code: 'gate_failed' } });
    const ok = await f.asParent('POST', '/api/p/gate', {
      birth_year: 2015,
      turnstile_token: 'good-2',
    });
    expect(ok.status).toBe(200);
    expect(ts.calls.map((c) => c.secret)).toEqual(Array(3).fill(TS_ON.TURNSTILE_SECRET));
    // The /p shell lets the widget load.
    const shell = await f.request('/p');
    const csp = shell.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
  });

  it('only one key set counts as off', async () => {
    const f = await parentFixture({ TURNSTILE_SITE_KEY: 'x' });
    expect((await f.asParent('POST', '/api/p/gate', { birth_year: 2015 })).status).toBe(200);
  });
});

describe('Turnstile in front of Google sign-in', () => {
  it('off: straight to Google', async () => {
    const r = await testApp().request('/api/auth/google/start');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('accounts.google.com');
  });

  it('on: a check page first, then Google only with a verified token', async () => {
    const ts = fakeTurnstile();
    const t = testApp({ env: TS_ON, fetch: ts.fetch });
    const page = await t.request('/api/auth/google/start');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`data-sitekey="${TS_ON.TURNSTILE_SITE_KEY}"`);
    const csp = page.headers.get('content-security-policy') ?? '';
    const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(csp).toContain("default-src 'none'");
    const bad = await t.request('/api/auth/google/start?ts=bot');
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toContain('/login?error=turnstile_failed');
    const good = await t.request('/api/auth/google/start?ts=good-x');
    expect(good.status).toBe(302);
    expect(good.headers.get('location')).toContain('accounts.google.com');
    expect(good.headers.get('set-cookie')).toContain('maktab_oauth=');
  });
});
