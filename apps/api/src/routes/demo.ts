import {
  type AppDb,
  advanceDemoSeed,
  DEMO_USERS,
  type DemoLogin,
  demoForcePending,
  demoStatus,
  markDemoDirty,
  startDemoReset,
} from '@maktab/db';
import { newId } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { loadPrincipal, SESSION_TTL_SEC, sessionCookieName } from '../auth/principal';
import { signSession } from '../auth/signed';
import { createSession } from '../auth/signin';
import type { AppEnv, Bindings } from '../env';
import { ApiError } from '../lib/errors';
import { jsonBody } from '../lib/http';
import { RateLimiter } from '../lib/ratelimit';
import { clientIp } from '../lib/turnstile';
import { defineRoute, publicRoute, type RouteTable, requires } from '../perm/routes';

/**
 * Demo mode (docs/demo.md). Mounted only when the Worker runs with DEMO_MODE=1 (index.ts builds the
 * app with `demo: true`); without it none of these routes exist (404) and nothing here runs.
 *
 *   POST /api/auth/demo   {as: principal|accountant|teacher} → a session for the fixed demo user
 *   GET  /api/demo        status of the demo (phase, reset progress) for the banner
 *   POST /api/demo/reset  the installation owner (OWNER_EMAIL, not a demo login) starts a reset
 *   POST /api/demo/step   advances a reset that is already running (public; it can only move a
 *                         scheduled reset forward, or seed an empty database)
 *
 * And the demo guard: routes that change the installation itself answer 403 `demo_locked`; uploads
 * are capped; any other successful write marks the demo "dirty" so the nightly reset runs.
 */

export const isDemo = (env: Pick<Bindings, 'DEMO_MODE'>): boolean => env.DEMO_MODE?.trim() === '1';

/** Routes a demo visitor may not use: they change the installation, not the demo school's data. */
export const DEMO_LOCKED: { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/staff\/invite$/ },
  { method: 'POST', path: /^\/api\/users\/[^/]+\/(disable|enable)$/ },
  { method: 'PUT', path: /^\/api\/users\/[^/]+\/roles$/ },
  { method: 'POST', path: /^\/api\/backup\/(export|drills)(\/.*)?$/ },
  { method: 'GET', path: /^\/api\/backup\/export\/.+$/ },
  { method: 'POST', path: /^\/api\/parent-links\/rotate-all$/ },
];
const UPLOADS = [
  /^\/api\/school\/logo$/,
  /^\/api\/students\/[^/]+\/photo$/,
  /^\/api\/expenses\/[^/]+\/photo$/,
];
export const DEMO_UPLOAD_MAX_BYTES = 200 * 1024;

const signInLimit = new RateLimiter(10, 60_000);
const uploadLimit = new RateLimiter(10, 60 * 60_000);
const stepLimit = new RateLimiter(60, 60_000);
const resetLimit = new RateLimiter(2, 60 * 60_000);

/** A read that answers [] when the table does not exist (between the wipe's drop and create). */
async function safeAll<T>(db: AppDb, q: ReturnType<typeof sql>): Promise<T[]> {
  try {
    return await db.all<T>(q);
  } catch {
    return [];
  }
}

const ip = (c: Context<AppEnv>) => clientIp((h) => c.req.header(h)) ?? '';

/** The demo guard (runs before the routes; demo mode only). */
export function demoGuard(): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if (DEMO_LOCKED.some((r) => r.method === method && r.path.test(path)))
      throw new ApiError(403, 'demo_locked', 'Not available in the demo');
    if (method === 'POST' && UPLOADS.some((r) => r.test(path))) {
      const len = Number(c.req.header('content-length') ?? 'NaN');
      if (!Number.isFinite(len) || len > DEMO_UPLOAD_MAX_BYTES)
        throw new ApiError(413, 'demo_upload_cap', 'Demo uploads are limited to 200 KB');
      if (!uploadLimit.take(`up:${ip(c)}`))
        throw new ApiError(429, 'rate_limited', 'Demo uploads are limited to 10 an hour');
    }
    await next();
    const write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const ours = /^\/api\/(auth|demo|p)(\/|$)/.test(path);
    if (write && !ours && c.res.status < 400) {
      const db = c.get('db');
      const mark = markDemoDirty(db).catch((err: unknown) => console.warn('demo: mark dirty', err));
      try {
        c.executionCtx.waitUntil(mark);
      } catch {
        await mark; // no execution context (tests)
      }
    }
  });
}

const signInSchema = z.object({ as: z.enum(['principal', 'accountant', 'teacher']) });

/** Advances a running reset within one request's budget (D1 calls, wall time). */
// 12 step calls stay well inside the free plan's per-invocation CPU (measured 2026-10-13: ~20 calls
// sometimes ended in error 1102, CPU exceeded, which also leaves the lease to expire).
export const advanceOnce = (db: AppDb, env: Bindings, ms = 15_000, maxCalls = 12) =>
  advanceDemoSeed(db, {
    deadline: Date.now() + ms,
    maxCalls,
    parentSecret: env.PARENT_LINK_SECRET,
    ownerEmail: env.OWNER_EMAIL,
  });

export function demoRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/auth/demo', access: publicRoute },
    async (c) => {
      if (!signInLimit.take(`demo:${ip(c)}`))
        throw new ApiError(429, 'rate_limited', 'Too many demo sign-ins; wait a minute');
      const input = await jsonBody(c, signInSchema);
      const db = c.get('db');
      const email = DEMO_USERS[input.as as DemoLogin];
      const [u] = await safeAll<{ id: string; status: string }>(
        db,
        sql`SELECT id, status FROM "user" WHERE email = ${email}`,
      );
      if (!u || u.status !== 'active')
        throw new ApiError(503, 'demo_not_ready', 'The demo is being prepared; try again shortly');
      const s = await createSession(db, newId(), u.id, {
        ua: c.req.header('user-agent') ?? null,
        ip: c.req.header('cf-connecting-ip') ?? null,
        nowMs: Date.now(),
      });
      setCookie(
        c,
        sessionCookieName(c.env.APP_ORIGIN),
        await signSession(c.env.SESSION_SECRET, s.id, s.exp),
        {
          httpOnly: true,
          secure: c.env.APP_ORIGIN.startsWith('https://'),
          sameSite: 'Lax',
          path: '/',
          maxAge: SESSION_TTL_SEC,
        },
      );
      return c.json({ ok: true, as: input.as });
    },
  );

  defineRoute(app, table, { method: 'GET', path: '/api/demo', access: publicRoute }, async (c) => {
    const s = await demoStatus(c.get('db'));
    return c.json({ demo: true, ...s }, 200, { 'cache-control': 'no-store' });
  });

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/demo/reset', access: requires('backup', 'manage') },
    async (c) => {
      const p = await loadPrincipal(c);
      const owner = c.env.OWNER_EMAIL?.trim().toLowerCase();
      // Every demo visitor can be "the principal" (an owner); only the installation's real owner
      // may reset, as a reset costs a night's worth of the D1 write budget.
      if (!p || !owner || p.user.email.toLowerCase() !== owner)
        throw new ApiError(403, 'demo_locked', 'Only the installation owner can reset the demo');
      if (!resetLimit.take('reset'))
        throw new ApiError(429, 'rate_limited', 'The demo was reset recently; wait an hour');
      const db = c.get('db');
      await startDemoReset(db, { reason: `manual by ${p.user.email}` });
      // The owner's own session goes with the wipe; the reset continues on the cron / step calls.
      return c.json(await advanceOnce(db, c.env, 10_000, 10), 202);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/demo/step', access: publicRoute },
    async (c) => {
      if (!stepLimit.take(`step:${ip(c)}`))
        throw new ApiError(429, 'rate_limited', 'Too many requests; wait a minute');
      const db = c.get('db');
      let s = await demoStatus(db);
      if (s.phase !== 'running') {
        const [school] = await safeAll<{ n: number }>(db, sql`SELECT count(*) AS n FROM school`);
        // Nothing to do on a seeded demo; an empty database is seeded.
        const force = await demoForcePending(db);
        if (!force && (s.phase === 'done' || Number(school?.n ?? 0) > 0)) return c.json(s);
        s = await startDemoReset(db, { reason: 'first seed' });
      }
      return c.json(await advanceOnce(db, c.env));
    },
  );
}

/**
 * The demo cron (every minute): continue a running reset; start the nightly one at 02:00 Karachi when
 * a visitor changed something since the last seed; seed an empty database. Returns true while a
 * reset is running (the fee cron and daily pass wait for it).
 */
export async function demoTick(db: AppDb, env: Bindings, nowMs = Date.now()): Promise<boolean> {
  let s = await demoStatus(db);
  if (s.phase !== 'running') {
    const k = new Date(nowMs + 5 * 3_600_000);
    const today = k.toISOString().slice(0, 10);
    const startedToday = s.started_at
      ? new Date(Date.parse(s.started_at) + 5 * 3_600_000).toISOString().slice(0, 10) === today
      : false;
    const [school] = await safeAll<{ n: number }>(db, sql`SELECT count(*) AS n FROM school`);
    const empty = Number(school?.n ?? 0) === 0 || (await demoForcePending(db));
    const nightly = k.getUTCHours() === 2 && s.dirty && !startedToday;
    if (!empty && !nightly) return false;
    s = await startDemoReset(db, {
      reason: empty ? 'first seed' : 'nightly',
      now: new Date(nowMs),
    });
  }
  await advanceOnce(db, env);
  return true;
}
