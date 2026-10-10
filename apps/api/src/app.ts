import type { AppDb } from '@maktab/db';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { createJwksClient, type JwksClient } from './auth/google';
import type { AppEnv, Bindings } from './env';
import { notFound, onError } from './lib/errors';
import { denyUndeclared, RouteTable } from './perm/routes';
import { admissionRoutes } from './routes/admissions';
import { attendanceRoutes } from './routes/attendance';
import { authRoutes } from './routes/auth';
import { cashRoutes } from './routes/cash';
import { catalogRoutes } from './routes/catalog';
import { coreRoutes } from './routes/core';
import { feeRoutes } from './routes/fees';
import { groupRoutes } from './routes/groups';
import { importRoutes } from './routes/imports';
import { moneyRoutes } from './routes/money';
import { peopleRoutes } from './routes/people';
import { receiptRoutes } from './routes/receipts';
import { staffRoutes } from './routes/staff';

export type AppDeps = {
  getDb: (env: Bindings) => AppDb;
  /** Injected so tests can run without the network; defaults to Google's live JWKS. */
  jwks?: JwksClient;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
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

  return { app, routes };
}
