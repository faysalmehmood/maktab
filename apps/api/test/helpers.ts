import { type AppDb, role, user } from '@maktab/db';
import { createTestDb } from '@maktab/db/node';
import { newId, type StaffRole } from '@maktab/shared';
import { createApp } from '../src/app';
import { createJwksClient, type JwksClient } from '../src/auth/google';
import { signSession } from '../src/auth/signed';
import { createSession } from '../src/auth/signin';
import type { Bindings } from '../src/env';
import { b64urlEncode, utf8 } from '../src/lib/b64';

export const SECRET = 'test-secret-that-is-at-least-32-characters-long';
export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const ORIGIN = 'http://localhost:5173';

export const env = {
  SESSION_SECRET: SECRET,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  APP_ORIGIN: ORIGIN,
  OWNER_EMAIL: 'owner@example.com',
} as Bindings;

export type TestKey = { kid: string; privateKey: CryptoKey; jwk: JsonWebKey };

export async function makeKey(kid: string): Promise<TestKey> {
  // Workers types widen these returns (key or pair, JWK or buffer); RSA + 'jwk' fixes both.
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const published: JsonWebKey & { kid: string; use: string } = {
    ...jwk,
    kid,
    alg: 'RS256',
    use: 'sig',
  };
  return { kid, privateKey: pair.privateKey, jwk: published };
}

/** Mints a Google-shaped RS256 ID token locally (experiment 2's approach). */
export async function mintIdToken(
  key: TestKey,
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const h = b64urlEncode(
    utf8(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header })),
  );
  const p = b64urlEncode(
    utf8(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: '1234567890',
        email: 'owner@example.com',
        email_verified: true,
        name: 'Owner',
        iat: now,
        exp: now + 3600,
        ...overrides,
      }),
    ),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, utf8(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

/** A fake JWKS endpoint whose key set the test can rotate. */
export function fakeJwksServer(keys: TestKey[], cacheControl = 'public, max-age=3600') {
  const state = { keys, cacheControl };
  const fetch = async (): Promise<Response> =>
    new Response(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }), {
      headers: { 'content-type': 'application/json', 'cache-control': state.cacheControl },
    });
  return { state, fetch };
}

export function testApp(
  opts: { db?: AppDb; jwks?: JwksClient; fetch?: typeof fetch; env?: Partial<Bindings> } = {},
) {
  const db = opts.db ?? createTestDb();
  const jwks = opts.jwks ?? createJwksClient({ fetch: async () => new Response('{"keys":[]}') });
  const { app, routes } = createApp({
    getDb: () => db,
    jwks,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  // Browsers always send Origin on POST; the CSRF guard relies on it.
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== 'GET' && !headers.has('origin'))
      headers.set('origin', ORIGIN);
    return app.request(path, { ...init, headers }, { ...env, ...opts.env });
  };
  return { app, routes, db, request };
}

/** Creates an active user holding `roles` and returns a Cookie header for them. */
export async function signedInAs(db: AppDb, roles: StaffRole[], email = `${newId()}@example.com`) {
  const id = newId();
  await db.insert(user).values({ id, email, name: email, status: 'active' });
  if (roles.length) await db.insert(role).values(roles.map((r) => ({ userId: id, role: r })));
  const s = await createSession(db, newId(), id, { ua: null, ip: null, nowMs: Date.now() });
  return { userId: id, cookie: `maktab_sid=${await signSession(SECRET, s.id, s.exp)}` };
}

/** In-memory stand-in for the R2 binding: just the calls the app makes. */
export function fakeR2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  const bucket = {
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: value, contentType: opts?.httpMetadata?.contentType });
      return {};
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        body: new Blob([new Uint8Array(o.bytes)]).stream(),
        httpMetadata: { contentType: o.contentType },
      };
    },
  };
  return { objects, bucket: bucket as unknown as R2Bucket };
}
