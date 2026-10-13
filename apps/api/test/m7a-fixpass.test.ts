import { role, user, userSession } from '@maktab/db';
import { newId } from '@maktab/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwksClient } from '../src/auth/google';
import { signLogout } from '../src/auth/signed';
import type { Bindings } from '../src/env';
import { rateClass } from '../src/lib/ratelimit';
import { TURNSTILE_VERIFY_URL, verifyTurnstile } from '../src/lib/turnstile';
import { LOGOUT_PENDING_COOKIE } from '../src/routes/auth';
import {
  env as baseEnv,
  fakeJwksServer,
  makeKey,
  mintIdToken,
  SECRET,
  type TestKey,
  testApp,
} from './helpers';

// M7a fix pass (API): a queued sign-out revokes only the session it names (logout token, and the
// pending-logout cookie at the OAuth callback); exact rate-limit path classes; Turnstile fail-open
// on sign-in / fail-closed on the gate, hostname and remoteip.

let key: TestKey;
beforeAll(async () => {
  key = await makeKey('kid-m7a');
});

/** One phone (cookie jar of one) signing in as different Google accounts over time. */
function phone() {
  const jwks = createJwksClient({ fetch: fakeJwksServer([key]).fetch });
  let nonce = '';
  let claims: Record<string, unknown> = {};
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    expect(String(input)).toBe('https://oauth2.googleapis.com/token');
    return Response.json({ id_token: await mintIdToken(key, { nonce, ...claims }) });
  };
  const t = testApp({ jwks, fetch });
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = (pair ?? '').split('=') as [string, string];
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === '') jar.delete(k);
      else jar.set(k, v);
    }
  };
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await t.request(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), cookie: cookieHeader() },
    });
    take(res);
    return res;
  };
  const signIn = async (email: string, sub: string) => {
    claims = { email, sub };
    const start = await req('/api/auth/google/start');
    const google = new URL(start.headers.get('location') ?? '');
    nonce = google.searchParams.get('nonce') ?? '';
    const res = await req(
      `/api/auth/google/callback?code=abc&state=${google.searchParams.get('state')}`,
    );
    expect(res.headers.get('location')).toBe('http://localhost:5173/');
    return jar.get('maktab_sid') as string;
  };
  const me = async () => {
    const r = await req('/api/me');
    return {
      status: r.status,
      body: (await r.json()) as { logout_token?: string; user?: { email: string } },
    };
  };
  /** What the web app does when the sign-out request cannot be sent: keep the token, set the cookie. */
  const signOutOffline = (token: string) => jar.set(LOGOUT_PENDING_COOKIE, token);
  const flush = (token: string) =>
    req('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logout_token: token }),
    });
  return { ...t, jar, req, signIn, me, signOutOffline, flush };
}

const sessions = async (db: ReturnType<typeof testApp>['db']) =>
  (await db.select({ id: userSession.id }).from(userSession)).map((r) => r.id).sort();

async function invite(db: ReturnType<typeof testApp>['db'], email: string) {
  const id = newId();
  await db.insert(user).values({ id, email, name: email, status: 'invited' });
  await db.insert(role).values({ userId: id, role: 'teacher' });
}

describe('queued sign-out is bound to the old session', () => {
  it('offline sign-out → online sign-in as the same user: old session revoked, new one intact', async () => {
    const p = phone();
    await p.signIn('owner@example.com', 'g-owner');
    const old = await p.me();
    expect(old.status).toBe(200);
    const token = old.body.logout_token as string;
    expect(token).toBeTruthy();
    const [oldSid] = await sessions(p.db);
    p.signOutOffline(token);
    await p.signIn('owner@example.com', 'g-owner');
    // The callback revoked the old session and consumed the cookie.
    expect(p.jar.has(LOGOUT_PENDING_COOKIE)).toBe(false);
    const after = await sessions(p.db);
    expect(after).toHaveLength(1);
    expect(after).not.toContain(oldSid);
    // The late flush (back online) is a no-op for the new session.
    const f = await p.flush(token);
    expect(f.status).toBe(200);
    expect(await f.json()).toEqual({ ok: true, revoked: true });
    expect((await p.me()).status).toBe(200);
    expect(await sessions(p.db)).toEqual(after);
  });

  it('the same with a different user', async () => {
    const p = phone();
    await p.signIn('owner@example.com', 'g-owner');
    const token = (await p.me()).body.logout_token as string;
    await invite(p.db, 'teacher@example.com');
    p.signOutOffline(token);
    await p.signIn('teacher@example.com', 'g-teacher');
    expect(await p.flush(token).then((r) => r.status)).toBe(200);
    const me = await p.me();
    expect(me.status).toBe(200);
    expect(me.body.user?.email).toBe('teacher@example.com');
    const rows = await p.db.select({ userId: userSession.userId }).from(userSession);
    expect(rows).toHaveLength(1);
  });

  it('flush fails with 5xx at sign-in time (cookie never consumed by D1): the new session stays intact', async () => {
    const p = phone();
    await p.signIn('owner@example.com', 'g-owner');
    const token = (await p.me()).body.logout_token as string;
    // No pending cookie reached the server (say it was cleared) and the pre-sign-in flush got a 5xx:
    // the app goes on to Google anyway.
    await p.signIn('owner@example.com', 'g-owner');
    expect(await sessions(p.db)).toHaveLength(2);
    // Later the flush gets through: only the old one goes.
    await p.flush(token);
    expect(await sessions(p.db)).toHaveLength(1);
    expect((await p.me()).status).toBe(200);
  });

  it('a forged / foreign token revokes nothing; a token never ends the cookie of another session', async () => {
    const p = phone();
    await p.signIn('owner@example.com', 'g-owner');
    const before = await sessions(p.db);
    const forged = await signLogout(
      'another-secret-that-is-32-characters-long!!',
      before[0] as string,
      9e9,
    );
    const r = await p.flush(forged);
    expect(await r.json()).toEqual({ ok: true, revoked: false });
    expect(await sessions(p.db)).toEqual(before);
    const other = await signLogout(SECRET, newId(), Math.floor(Date.now() / 1000) + 60);
    await p.flush(other);
    expect(p.jar.has('maktab_sid')).toBe(true);
    expect((await p.me()).status).toBe(200);
    // Its own token: revoked, and the cookie goes too.
    const own = (await p.me()).body.logout_token as string;
    expect(await (await p.flush(own)).json()).toEqual({ ok: true, revoked: true });
    expect(p.jar.has('maktab_sid')).toBe(false);
    // Idempotent.
    expect((await p.flush(own)).status).toBe(200);
    expect(
      (
        await p.req('/api/auth/logout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ logout_token: 42 }),
        })
      ).status,
    ).toBe(400);
  });

  it('a session-type token cannot be replayed as a logout token', async () => {
    const p = phone();
    const sid = await p.signIn('owner@example.com', 'g-owner');
    const r = await p.flush(decodeURIComponent(sid));
    expect(await r.json()).toEqual({ ok: true, revoked: false });
    expect((await p.me()).status).toBe(200);
    const [row] = await p.db
      .select()
      .from(userSession)
      .where(eq(userSession.userId, (await p.db.select().from(user))[0]?.id as string));
    expect(row).toBeTruthy();
  });
});

describe('rate-limit path classes match docs/deploy.md §7 exactly', () => {
  it.each([
    ['/api/p', 'parent'],
    ['/api/p/gate', 'parent'],
    ['/api/p/receipt/AN-2026-00001', 'parent'],
    ['/api/auth', 'auth'],
    ['/api/auth/logout', 'auth'],
    ['/api/payroll', null],
    ['/api/payslips', null],
    ['/api/parent-links/rotate-all', null],
    ['/api/programmes', null],
    ['/api/people', null],
    ['/api/authority', null],
    ['/api/pX', null],
  ] as const)('%s → %s', (path, cls) => {
    expect(rateClass(path)).toBe(cls);
  });

  it('/api/payroll and /api/payslips are not limited over HTTP', async () => {
    const t = testApp();
    for (let i = 0; i < 25; i++) {
      const r = await t.request('/api/payslips', { headers: { 'cf-connecting-ip': '192.0.2.5' } });
      expect(r.status).not.toBe(429);
      expect(r.headers.get('ratelimit-limit')).toBeNull();
    }
    const r = await t.request('/api/payroll', { headers: { 'cf-connecting-ip': '192.0.2.5' } });
    expect(r.headers.get('ratelimit-limit')).toBeNull();
    const a = await t.request('/api/auth/google/start', {
      headers: { 'cf-connecting-ip': '192.0.2.5' },
    });
    expect(a.headers.get('ratelimit-limit')).toBe('20');
  });
});

describe('Turnstile verification policy', () => {
  const on = {
    ...baseEnv,
    TURNSTILE_SITE_KEY: 'site',
    TURNSTILE_SECRET: 'secret',
    APP_ORIGIN: 'https://maktab.example.com',
  } as Bindings;
  const answer =
    (status: number, body: unknown = {}, seen: FormData[] = []) =>
    async (input: string, init?: RequestInit) => {
      expect(input).toBe(TURNSTILE_VERIFY_URL);
      seen.push(init?.body as FormData);
      return new Response(JSON.stringify(body), { status });
    };
  const down = async () => {
    throw new TypeError('network');
  };

  it('sign-in (open): network error / 5xx pass; success:false, wrong hostname, no token fail', async () => {
    expect(await verifyTurnstile(on, down, 't', undefined, 'open')).toBe(true);
    expect(await verifyTurnstile(on, answer(503), 't', undefined, 'open')).toBe(true);
    expect(await verifyTurnstile(on, answer(200, { success: false }), 't', undefined, 'open')).toBe(
      false,
    );
    expect(
      await verifyTurnstile(
        on,
        answer(200, { success: true, hostname: 'evil.example' }),
        't',
        undefined,
        'open',
      ),
    ).toBe(false);
    expect(await verifyTurnstile(on, answer(200, { success: true }), 't', undefined, 'open')).toBe(
      false,
    );
    expect(await verifyTurnstile(on, down, '', undefined, 'open')).toBe(false);
    expect(
      await verifyTurnstile(
        on,
        answer(200, { success: true, hostname: 'maktab.example.com' }),
        't',
        undefined,
        'open',
      ),
    ).toBe(true);
  });

  it('gate (closed): network error / 5xx fail; a good answer for this host passes; remoteip is sent', async () => {
    expect(await verifyTurnstile(on, down, 't', undefined, 'closed')).toBe(false);
    expect(await verifyTurnstile(on, answer(502), 't', undefined, 'closed')).toBe(false);
    expect(
      await verifyTurnstile(on, answer(200, { success: false }), 't', undefined, 'closed'),
    ).toBe(false);
    const seen: FormData[] = [];
    expect(
      await verifyTurnstile(
        on,
        answer(200, { success: true, hostname: 'MAKTAB.example.com' }, seen),
        't',
        '203.0.113.9',
        'closed',
      ),
    ).toBe(true);
    expect(seen[0]?.get('remoteip')).toBe('203.0.113.9');
    expect(seen[0]?.get('secret')).toBe('secret');
  });

  it('over HTTP: sign-in goes on to Google when siteverify is down', async () => {
    const ts = { TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET: 'secret' };
    const t = testApp({
      env: ts,
      fetch: (async () => new Response('', { status: 500 })) as typeof fetch,
    });
    const r = await t.request('/api/auth/google/start?ts=anything');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('accounts.google.com');
    // The gate's closed policy over HTTP: m7-hardening "fails closed when siteverify is down".
  });
});
