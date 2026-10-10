import { beforeAll, describe, expect, it } from 'vitest';
import { createJwksClient, verifyIdToken } from '../src/auth/google';
import { CLIENT_ID, fakeJwksServer, makeKey, mintIdToken, type TestKey } from './helpers';

let k1: TestKey;
let k2: TestKey;
beforeAll(async () => {
  [k1, k2] = await Promise.all([makeKey('kid-1'), makeKey('kid-2')]);
});

const nowSec = () => Math.floor(Date.now() / 1000);

describe('verifyIdToken (RS256, locally minted)', () => {
  const setup = () => {
    const server = fakeJwksServer([k1]);
    const jwks = createJwksClient({ fetch: server.fetch });
    return {
      server,
      jwks,
      verify: (t: string, nonce?: string) =>
        verifyIdToken(t, {
          jwks,
          audience: CLIENT_ID,
          nowSec: nowSec(),
          ...(nonce ? { nonce } : {}),
        }),
    };
  };

  it('accepts a valid token and returns its claims', async () => {
    const { verify } = setup();
    const claims = await verify(await mintIdToken(k1, { nonce: 'n1' }), 'n1');
    expect(claims.email).toBe('owner@example.com');
    expect(claims.sub).toBe('1234567890');
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }, /bad audience/],
    ['wrong issuer', { iss: 'https://evil.example' }, /bad issuer/],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }, /expired/],
    ['unverified email', { email_verified: false }, /email not verified/],
    ['wrong nonce', { nonce: 'other' }, /nonce mismatch/],
  ])('rejects %s', async (_name, claims, err) => {
    const { verify } = setup();
    await expect(verify(await mintIdToken(k1, { nonce: 'n1', ...claims }), 'n1')).rejects.toThrow(
      err,
    );
  });

  it('rejects a signature from a key not in the JWKS under a known kid', async () => {
    const { verify } = setup();
    const forged = await mintIdToken({ ...k2, kid: 'kid-1' });
    await expect(verify(forged)).rejects.toThrow(/bad signature/);
  });

  it('rejects alg confusion and malformed tokens', async () => {
    const { verify } = setup();
    await expect(verify(await mintIdToken(k1, {}, { alg: 'HS256' }))).rejects.toThrow(
      /unexpected alg/,
    );
    await expect(verify('a.b')).rejects.toThrow(/malformed/);
    await expect(verify('!!.!!.!!')).rejects.toThrow(/malformed/);
  });
});

describe('JWKS cache', () => {
  it('caches keys for the Cache-Control lifetime, then refetches', async () => {
    let t = 0;
    const server = fakeJwksServer([k1], 'public, max-age=100');
    const jwks = createJwksClient({ fetch: server.fetch, now: () => t });
    await jwks.getKey('kid-1');
    t = 99_000;
    await jwks.getKey('kid-1');
    expect(jwks.fetchCount()).toBe(1);
    t = 100_000;
    await jwks.getKey('kid-1');
    expect(jwks.fetchCount()).toBe(2);
  });

  it('refreshes once on an unknown kid (key rotation), rate limited', async () => {
    let t = 0;
    const server = fakeJwksServer([k1]);
    const jwks = createJwksClient({
      fetch: server.fetch,
      now: () => t,
      minRefreshIntervalMs: 60_000,
    });
    await jwks.getKey('kid-1');
    server.state.keys = [k1, k2];
    // Too soon after the last fetch: a forged kid must not be able to force refetches.
    await expect(jwks.getKey('kid-2')).rejects.toThrow(/unknown signing key/);
    expect(jwks.fetchCount()).toBe(1);
    t = 61_000;
    await expect(jwks.getKey('kid-2')).resolves.toBeDefined();
    expect(jwks.fetchCount()).toBe(2);
    await expect(jwks.getKey('kid-nope')).rejects.toThrow(/unknown signing key/);
    expect(jwks.fetchCount()).toBe(2);
  });

  it('single-flights concurrent fetches when the cache is cold or expired', async () => {
    let t = 0;
    const server = fakeJwksServer([k1], 'public, max-age=100');
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = async () => {
      await gate;
      return server.fetch();
    };
    const jwks = createJwksClient({ fetch: slow, now: () => t });
    const many = Promise.all(Array.from({ length: 20 }, () => jwks.getKey('kid-1')));
    release();
    await many;
    expect(jwks.fetchCount()).toBe(1);
    t = 200_000;
    await Promise.all(Array.from({ length: 20 }, () => jwks.getKey('kid-1')));
    expect(jwks.fetchCount()).toBe(2);
  });

  it('backs off 30 s after a failed fetch, serving stale keys meanwhile', async () => {
    let t = 0;
    let up = true;
    const server = fakeJwksServer([k1], 'public, max-age=100');
    const flaky = async () => (up ? server.fetch() : new Response('down', { status: 503 }));
    const jwks = createJwksClient({ fetch: flaky, now: () => t });
    await jwks.getKey('kid-1');
    up = false;
    t = 100_000; // expired; Google is down
    await expect(jwks.getKey('kid-1')).resolves.toBeDefined(); // stale key still served
    expect(jwks.fetchCount()).toBe(2);
    t = 110_000;
    await jwks.getKey('kid-1');
    expect(jwks.fetchCount()).toBe(2); // inside the backoff: no new fetch
    t = 130_000;
    up = true;
    await jwks.getKey('kid-1');
    expect(jwks.fetchCount()).toBe(3);
  });

  it('fails fast during the backoff when there are no cached keys', async () => {
    let t = 0;
    let calls = 0;
    const down = async () => {
      calls++;
      return new Response('down', { status: 503 });
    };
    const jwks = createJwksClient({ fetch: down, now: () => t });
    await expect(jwks.getKey('kid-1')).rejects.toThrow(/JWKS fetch failed: HTTP 503/);
    await expect(jwks.getKey('kid-1')).rejects.toThrow(/backing off/);
    expect(calls).toBe(1);
    t = 30_000;
    await expect(jwks.getKey('kid-1')).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(2);
  });

  it('falls back to the default TTL without Cache-Control', async () => {
    let t = 0;
    const server = fakeJwksServer([k1], '');
    const jwks = createJwksClient({ fetch: server.fetch, now: () => t, defaultTtlMs: 5_000 });
    await jwks.getKey('kid-1');
    t = 5_000;
    await jwks.getKey('kid-1');
    expect(jwks.fetchCount()).toBe(2);
  });
});
