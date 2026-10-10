import { z } from 'zod';
import { b64urlDecode, fromUtf8, utf8 } from '../lib/b64';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export class IdTokenError extends Error {}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const jwkSchema = z.looseObject({
  kid: z.string(),
  kty: z.literal('RSA'),
  n: z.string(),
  e: z.string(),
});
const jwksSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string().optional() })) });

export type JwksOptions = {
  url?: string;
  fetch?: Fetch;
  now?: () => number;
  /** Used when the response has no usable Cache-Control max-age. */
  defaultTtlMs?: number;
  /** Unknown-kid refreshes are rate limited so forged tokens cannot make us hammer Google. */
  minRefreshIntervalMs?: number;
};

export type JwksClient = { getKey(kid: string): Promise<CryptoKey>; fetchCount(): number };

/**
 * Google rotates signing keys every few days and publishes the cache lifetime in Cache-Control.
 * Keys are cached until then; a token with an unknown kid triggers one early refresh (rotation).
 */
export function createJwksClient(opts: JwksOptions = {}): JwksClient {
  const url = opts.url ?? GOOGLE_JWKS_URL;
  const doFetch: Fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  const now = opts.now ?? Date.now;
  const defaultTtl = opts.defaultTtlMs ?? 60 * 60 * 1000;
  const minRefresh = opts.minRefreshIntervalMs ?? 60 * 1000;

  let jwks = new Map<string, JsonWebKey>();
  let imported = new Map<string, Promise<CryptoKey>>();
  let expiresAt = 0;
  let lastFetchAt = Number.NEGATIVE_INFINITY;
  let fetches = 0;

  async function refresh(): Promise<void> {
    lastFetchAt = now();
    fetches++;
    const res = await doFetch(url);
    if (!res.ok) throw new IdTokenError(`JWKS fetch failed: HTTP ${res.status}`);
    const body = jwksSchema.parse(await res.json());
    const next = new Map<string, JsonWebKey>();
    for (const k of body.keys) {
      const parsed = jwkSchema.safeParse(k);
      if (parsed.success) next.set(parsed.data.kid, parsed.data as JsonWebKey);
    }
    const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
    expiresAt = now() + (maxAge ? Number(maxAge) * 1000 : defaultTtl);
    jwks = next;
    imported = new Map();
  }

  return {
    fetchCount: () => fetches,
    async getKey(kid) {
      if (now() >= expiresAt) await refresh();
      if (!jwks.has(kid) && now() - lastFetchAt >= minRefresh) await refresh();
      const jwk = jwks.get(kid);
      if (!jwk) throw new IdTokenError('unknown signing key');
      let key = imported.get(kid);
      if (!key) {
        key = crypto.subtle.importKey(
          'jwk',
          { ...jwk, alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        imported.set(kid, key);
      }
      return key;
    },
  };
}

const headerSchema = z.object({ alg: z.string(), kid: z.string() });
export const googleClaimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean(),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  name: z.string().optional(),
});
export type GoogleClaims = z.infer<typeof googleClaimsSchema>;

export type VerifyOptions = {
  jwks: JwksClient;
  audience: string;
  nonce?: string;
  nowSec: number;
  /** Tolerated clock drift between Google and the Worker. */
  skewSec?: number;
};

const decodeJson = (part: string): unknown => JSON.parse(fromUtf8(b64urlDecode(part)));

export async function verifyIdToken(token: string, o: VerifyOptions): Promise<GoogleClaims> {
  const skew = o.skewSec ?? 60;
  const [h, p, s, extra] = token.split('.');
  if (!h || !p || !s || extra !== undefined) throw new IdTokenError('malformed token');
  let header: z.infer<typeof headerSchema>;
  let raw: unknown;
  try {
    header = headerSchema.parse(decodeJson(h));
    raw = decodeJson(p);
  } catch {
    throw new IdTokenError('malformed token');
  }
  // Pin the algorithm: never let the token choose (alg=none / HS256 confusion).
  if (header.alg !== 'RS256') throw new IdTokenError('unexpected alg');
  const key = await o.jwks.getKey(header.kid);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(s),
    utf8(`${h}.${p}`),
  );
  if (!valid) throw new IdTokenError('bad signature');
  const parsed = googleClaimsSchema.safeParse(raw);
  if (!parsed.success) throw new IdTokenError('missing claims');
  const c = parsed.data;
  if (!GOOGLE_ISSUERS.includes(c.iss)) throw new IdTokenError('bad issuer');
  if (c.aud !== o.audience) throw new IdTokenError('bad audience');
  if (c.exp + skew <= o.nowSec) throw new IdTokenError('expired');
  if (c.iat - skew > o.nowSec) throw new IdTokenError('issued in the future');
  if (!c.email_verified) throw new IdTokenError('email not verified');
  if (o.nonce !== undefined && c.nonce !== o.nonce) throw new IdTokenError('nonce mismatch');
  return c;
}

export function googleAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
}) {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: p.state,
    nonce: p.nonce,
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${q}`;
}

const tokenResponseSchema = z.object({ id_token: z.string() });

export async function exchangeCode(
  p: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  doFetch: Fetch,
): Promise<string> {
  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new IdTokenError(`token exchange failed: HTTP ${res.status}`);
  return tokenResponseSchema.parse(await res.json()).id_token;
}
