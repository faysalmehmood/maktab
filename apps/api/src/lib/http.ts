import type { Context } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError } from './errors';

const describe = (error: z.ZodError): string =>
  error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');

/** Validates a JSON body with a shared Zod schema; anything malformed is a 400, never a 500. */
export async function jsonBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'invalid', describe(parsed.error));
  return parsed.data;
}

/**
 * jsonBody with a hard size cap: a body over `maxBytes` is refused (400 too_large), never truncated.
 * The cap is checked on the bytes received, before parsing.
 */
export async function boundedJsonBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
  maxBytes: number,
): Promise<z.output<S>> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > maxBytes) throw new ApiError(400, 'too_large', `Body over ${maxBytes} bytes`);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw new ApiError(400, 'too_large', `Body over ${maxBytes} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'invalid', describe(parsed.error));
  return parsed.data;
}

export function queryParams<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(400, 'invalid', describe(parsed.error));
  return parsed.data;
}

export const notFoundError = (what: string) => new ApiError(404, 'not_found', `${what} not found`);

/** The signed-in user's id; routes behind requires() always have one. */
export function userId(c: Context<AppEnv>): string {
  const p = c.get('principal');
  if (!p) throw new ApiError(401, 'unauthenticated', 'Sign in first');
  return p.user.id;
}

/** Masks all but the last 4 digits (CNIC / B-form in lists and for teachers, PLAN §5.4). */
export const mask = (v: string | null): string | null =>
  v ? `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}` : null;

/** Today in Asia/Karachi (the school day; PLAN §8 timezone rule). */
export function todayPk(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The `:id` path segment. Handlers are typed without their path, so Hono cannot narrow it. */
export function idParam(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (!id) throw new ApiError(400, 'invalid', 'Missing id');
  return id;
}
