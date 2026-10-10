const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Copy into a fresh ArrayBuffer-backed view: WebCrypto's types reject SharedArrayBuffer-backed ones.
export const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(s));
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

export function b64urlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on malformed input; callers treat that as an invalid token. */
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomToken = (bytes = 16): string =>
  b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
