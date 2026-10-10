import { role, user } from '@maktab/db';
import { newId } from '@maktab/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwksClient } from '../src/auth/google';
import { CLIENT_ID, fakeJwksServer, makeKey, mintIdToken, type TestKey, testApp } from './helpers';

let key: TestKey;
beforeAll(async () => {
  key = await makeKey('kid-1');
});

/** Drives start -> Google (simulated) -> callback, returning the callback response. */
function googleFlow(claims: Record<string, unknown>) {
  const jwks = createJwksClient({ fetch: fakeJwksServer([key]).fetch });
  let nonce = '';
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    expect(String(input)).toBe('https://oauth2.googleapis.com/token');
    return Response.json({ id_token: await mintIdToken(key, { nonce, ...claims }) });
  };
  const t = testApp({ jwks, fetch });
  const signIn = async () => {
    const start = await t.request('/api/auth/google/start');
    expect(start.status).toBe(302);
    const google = new URL(start.headers.get('location') ?? '');
    expect(google.origin).toBe('https://accounts.google.com');
    expect(google.searchParams.get('client_id')).toBe(CLIENT_ID);
    nonce = google.searchParams.get('nonce') ?? '';
    const state = google.searchParams.get('state') ?? '';
    const oauthCookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return t.request(`/api/auth/google/callback?code=abc&state=${state}`, {
      headers: { cookie: oauthCookie },
    });
  };
  return { ...t, signIn };
}

const sessionCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith('maktab_sid='))
    ?.split(';')[0];

describe('Google sign-in', () => {
  it('first sign-in on an empty install becomes owner; /api/me then works; logout revokes', async () => {
    const flow = googleFlow({ email: 'Owner@Example.com' });
    const res = await flow.signIn();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:5173/');
    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();

    const me = await flow.request('/api/me', { headers: { cookie: cookie ?? '' } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { email: 'owner@example.com', status: 'active' },
      roles: ['owner'],
    });

    const out = await flow.request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: cookie ?? '' },
    });
    expect(out.status).toBe(200);
    expect((await flow.request('/api/me', { headers: { cookie: cookie ?? '' } })).status).toBe(401);
  });

  it('rejects an uninvited email once an owner exists', async () => {
    const flow = googleFlow({ email: 'stranger@example.com', sub: 'other-sub' });
    await flow.db
      .insert(user)
      .values({ id: newId(), email: 'owner@example.com', status: 'active' });
    const res = await flow.signIn();
    expect(res.headers.get('location')).toBe('http://localhost:5173/login?error=not_invited');
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('activates an invited user and links their Google subject', async () => {
    const flow = googleFlow({ email: 'teacher@example.com', sub: 'teacher-sub' });
    const id = newId();
    await flow.db.insert(user).values([
      { id: newId(), email: 'owner@example.com', status: 'active' },
      { id, email: 'teacher@example.com', status: 'invited' },
    ]);
    await flow.db.insert(role).values({ userId: id, role: 'teacher' });
    const res = await flow.signIn();
    expect(sessionCookie(res)).toBeDefined();
    const [row] = await flow.db.select().from(user).where(eq(user.id, id));
    expect(row).toMatchObject({ status: 'active', googleSub: 'teacher-sub' });
  });

  it('rejects a cross-site form POST (CSRF)', async () => {
    const { request } = googleFlow({});
    const res = await request('/api/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a callback whose state does not match the browser cookie', async () => {
    const { request } = googleFlow({});
    const res = await request('/api/auth/google/callback?code=abc&state=forged');
    expect(res.headers.get('location')).toBe('http://localhost:5173/login?error=invalid_state');
  });
});
