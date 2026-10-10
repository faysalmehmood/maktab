import { z } from 'zod';
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from '../lib/b64';

/**
 * Compact HMAC-SHA256 tokens: base64url(json).base64url(mac). Used for the session cookie and the
 * short-lived OAuth state cookie; `typ` stops one being replayed as the other.
 */
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    keys.set(secret, key);
  }
  return key;
}

type BaseClaims = { typ: string; exp: number };

export async function sign<T extends BaseClaims>(secret: string, claims: T): Promise<string> {
  const payload = b64urlEncode(utf8(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(payload));
  return `${payload}.${b64urlEncode(mac)}`;
}

/** Returns null for anything wrong: bad shape, bad MAC, wrong type, expired. */
export async function verify<T extends BaseClaims>(
  secret: string,
  token: string | undefined,
  typ: T['typ'],
  schema: z.ZodType<T>,
  nowSec: number,
): Promise<T | null> {
  const [payload, mac, extra] = (token ?? '').split('.');
  if (!payload || !mac || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(mac),
      utf8(payload),
    );
    if (!ok) return null;
    const parsed = schema.safeParse(JSON.parse(fromUtf8(b64urlDecode(payload))));
    if (!parsed.success || parsed.data.typ !== typ || parsed.data.exp <= nowSec) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export const sessionClaims = z.object({
  typ: z.literal('session'),
  exp: z.number().int(),
  sid: z.string(),
});
export type SessionClaims = z.infer<typeof sessionClaims>;

export const oauthClaims = z.object({
  typ: z.literal('oauth'),
  exp: z.number().int(),
  state: z.string(),
  nonce: z.string(),
});
export type OAuthClaims = z.infer<typeof oauthClaims>;

export const signSession = (secret: string, sid: string, exp: number) =>
  sign(secret, { typ: 'session', sid, exp } satisfies SessionClaims);

export const verifySession = (secret: string, token: string | undefined, nowSec: number) =>
  verify(secret, token, 'session', sessionClaims, nowSec);
