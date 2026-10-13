import type { AppDb } from '@maktab/db';
import { type Context, Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { createJwksClient, type JwksClient } from './auth/google';
import type { AppEnv, Bindings } from './env';
import { notFound, onError } from './lib/errors';
import { denyUndeclared, RouteTable } from './perm/routes';
import { admissionRoutes } from './routes/admissions';
import { attendanceRoutes } from './routes/attendance';
import { authRoutes } from './routes/auth';
import { backupRoutes } from './routes/backup';
import { cashRoutes } from './routes/cash';
import { catalogRoutes } from './routes/catalog';
import { coreRoutes } from './routes/core';
import { feeRoutes } from './routes/fees';
import { groupRoutes } from './routes/groups';
import { importRoutes } from './routes/imports';
import { messageRoutes } from './routes/messages';
import { moneyRoutes } from './routes/money';
import { PARENT_HEADERS, parentRoutes } from './routes/parent';
import { peopleRoutes } from './routes/people';
import { receiptRoutes } from './routes/receipts';
import { settingsRoutes } from './routes/settings';
import { staffRoutes } from './routes/staff';

export type AppDeps = {
  getDb: (env: Bindings) => AppDb;
  /** Injected so tests can run without the network; defaults to Google's live JWKS. */
  jwks?: JwksClient;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

/** Same as apps/web/public/_headers (an asset fetched by the Worker does not get those rules). */
const SPA_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

/** Module scope so the JWKS cache survives across requests in one isolate. */
const defaultJwks = createJwksClient();

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const routes = new RouteTable();

  app.onError(onError);
  app.notFound(notFound);
  app.use('/api/*', secureHeaders(), async (c, next) => {
    c.set('db', deps.getDb(c.env));
    c.set('principal', undefined);
    await next();
  });
  app.use('/api/*', (c, next) => csrf({ origin: c.env.APP_ORIGIN })(c, next));
  app.use('/api/*', denyUndeclared(routes));

  coreRoutes(app, routes);
  authRoutes(app, routes, {
    jwks: deps.jwks ?? defaultJwks,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
  });
  catalogRoutes(app, routes);
  groupRoutes(app, routes);
  staffRoutes(app, routes);
  peopleRoutes(app, routes);
  admissionRoutes(app, routes);
  importRoutes(app, routes);
  attendanceRoutes(app, routes);
  feeRoutes(app, routes);
  receiptRoutes(app, routes);
  cashRoutes(app, routes);
  moneyRoutes(app, routes);
  messageRoutes(app, routes);
  parentRoutes(app, routes);
  settingsRoutes(app, routes);
  backupRoutes(app, routes);

  // The parent page itself (PLAN §14.10): `/p#<token>`, the SPA's index.html served by the Worker
  // (wrangler.toml run_worker_first "/p", "/p/*") so it always carries noindex / no-referrer /
  // no-store and the SPA's security headers. Not an API route: it returns no data; the page reads the
  // fragment and calls /api/p with the token in X-Parent-Token. Anything under /p/ gets the same
  // shell (the page then says the link is not valid): a token never belongs in a path.
  const parentShell = async (c: Context<AppEnv>) => {
    const res = c.env.ASSETS
      ? await c.env.ASSETS.fetch(new Request(new URL('/', c.req.url)))
      : new Response('<!doctype html><meta name="robots" content="noindex"><title>Maktab</title>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries({ ...PARENT_HEADERS, ...SPA_HEADERS }))
      out.headers.set(k, v);
    return out;
  };
  app.get('/p', parentShell);
  app.get('/p/*', parentShell);

  return { app, routes };
}
