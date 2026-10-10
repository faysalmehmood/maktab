import type { PHOTO_TYPES } from '@maktab/shared';
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

/**
 * Reads the multipart field `file`, enforces the size cap server-side (the client resizes first,
 * but the server never trusts that) and the image type by content, and returns the bytes.
 */
export async function readImageUpload(
  c: Context<AppEnv>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: ImageType }> {
  // Refuse obviously oversized bodies before buffering them (multipart adds ~1 KB of framing).
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > maxBytes + 16 * 1024) {
    throw new ApiError(413, 'too_large', `File must be at most ${Math.floor(maxBytes / 1024)} KB`);
  }
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File))
    throw new ApiError(400, 'invalid', 'Expected a multipart field "file"');
  if (file.size > maxBytes) {
    throw new ApiError(413, 'too_large', `File must be at most ${Math.floor(maxBytes / 1024)} KB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniff(bytes);
  if (!type) throw new ApiError(415, 'unsupported_type', 'Only JPEG, PNG or WebP images');
  return { bytes, type };
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
