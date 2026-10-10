import { describe, expect, it } from 'vitest';
import { oauthClaims, sign, signSession, verify, verifySession } from '../src/auth/signed';
import { SECRET } from './helpers';

const now = 1_800_000_000;

describe('HMAC session tokens', () => {
  it('round-trips', async () => {
    const t = await signSession(SECRET, 'sid-1', now + 60);
    expect(await verifySession(SECRET, t, now)).toEqual({
      typ: 'session',
      sid: 'sid-1',
      exp: now + 60,
    });
  });

  it('rejects expiry, tampering, a different secret and garbage', async () => {
    const t = await signSession(SECRET, 'sid-1', now + 60);
    expect(await verifySession(SECRET, t, now + 60)).toBeNull();
    const [payload, mac] = t.split('.');
    const forged = `${btoa(JSON.stringify({ typ: 'session', sid: 'admin', exp: now + 60 })).replace(/=+$/, '')}.${mac}`;
    expect(await verifySession(SECRET, forged, now)).toBeNull();
    expect(await verifySession(SECRET, `${payload}.${mac}x`, now)).toBeNull();
    expect(await verifySession(`${SECRET}-other`, t, now)).toBeNull();
    expect(await verifySession(SECRET, 'not-a-token', now)).toBeNull();
    expect(await verifySession(SECRET, undefined, now)).toBeNull();
  });

  it('will not accept an OAuth state token as a session, or vice versa', async () => {
    const state = await sign(SECRET, { typ: 'oauth', state: 's', nonce: 'n', exp: now + 60 });
    expect(await verifySession(SECRET, state, now)).toBeNull();
    const session = await signSession(SECRET, 'sid', now + 60);
    expect(await verify(SECRET, session, 'oauth', oauthClaims, now)).toBeNull();
  });

  it('refuses a short secret', async () => {
    await expect(signSession('short', 'sid', now)).rejects.toThrow(/32 characters/);
  });
});
