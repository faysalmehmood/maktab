import { PHOTO_TYPES } from '@maktab/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from './errors';

type ImageType = (typeof PHOTO_TYPES)[number];

/** Magic bytes, so a renamed file or a script posing as image/png is refused. */
function sniff(b: Uint8Array): ImageType | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function bucket(c: Context<AppEnv>): R2Bucket {
  const files = c.env.FILES;
  if (!files) {
    throw new ApiError(501, 'no_storage', 'File storage (R2 binding FILES) is not configured');
  }
  return files;
}

const isImageType = (t: string): t is ImageType => (PHOTO_TYPES as readonly string[]).includes(t);

/** Multipart framing allowance on top of the file's own cap. */
const FRAMING_BYTES = 16 * 1024;

const tooLarge = (maxBytes: number) =>
  new ApiError(413, 'too_large', `File must be at most ${Math.floor(maxBytes / 1024)} KB`);

/**
 * Reads a body of unknown length (chunked: no Content-Length) and stops with 413 as soon as it
 * passes `cap` bytes, so an endless stream is never buffered past the limit.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number, maxBytes: number) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Reads the multipart field `file`, enforces the size cap server-side (the client resizes first,
 * but the server never trusts that) and the image type twice: the declared part type must be
 * JPEG/PNG/WebP and the bytes must actually be that type (magic numbers). With a Content-Length an
 * oversized body is refused before anything is read; without one (chunked) the body is read with a
 * running byte count and refused (413) the moment it passes the same limit.
 */
export async function readImageUpload(
  c: Context<AppEnv>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: ImageType }> {
  const length = c.req.header('content-length');
  const cap = maxBytes + FRAMING_BYTES;
  let form: Record<string, unknown> | null;
  if (length !== undefined) {
    if (!/^\d+$/.test(length)) throw new ApiError(400, 'invalid', 'Bad Content-Length');
    // Refuse obviously oversized bodies before buffering them (multipart adds ~1 KB of framing).
    if (Number(length) > cap) throw tooLarge(maxBytes);
    form = await c.req.parseBody().catch(() => null);
  } else {
    const raw = await readCapped(c.req.raw.body, cap, maxBytes);
    const type = c.req.header('content-type') ?? '';
    const parsed = await new Response(raw, { headers: { 'content-type': type } })
      .formData()
      .catch(() => null);
    form = parsed ? Object.fromEntries(parsed.entries()) : null;
  }
  const file = form?.file;
  if (!(file instanceof File))
    throw new ApiError(400, 'invalid', 'Expected a multipart field "file"');
  if (file.size > maxBytes) throw tooLarge(maxBytes);
  const declared = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isImageType(declared)) {
    throw new ApiError(415, 'unsupported_type', 'Only JPEG, PNG or WebP images');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniff(bytes) !== declared) {
    throw new ApiError(415, 'unsupported_type', 'The file is not the image type it claims to be');
  }
  return { bytes, type: declared };
}

/**
 * After a replace has committed, the old object is garbage: delete it (best effort; a failure only
 * leaves an orphan in R2, so it is logged, never surfaced).
 */
export async function deleteReplaced(
  files: R2Bucket,
  oldKey: string | null,
  newKey: string,
): Promise<void> {
  if (!oldKey || oldKey === newKey) return;
  try {
    await files.delete(oldKey);
  } catch (err) {
    console.error(`r2: could not delete replaced object ${oldKey}`, err);
  }
}

/** Streams a stored object back; images are private (no public bucket, PLAN §10). */
export async function serveObject(c: Context<AppEnv>, key: string | null): Promise<Response> {
  if (!key) throw new ApiError(404, 'not_found', 'No file');
  const obj = await bucket(c).get(key);
  if (!obj) throw new ApiError(404, 'not_found', 'No file');
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
