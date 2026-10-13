import type { MeResponse } from '@maktab/shared';
import type { Hono } from 'hono';
import { loadPrincipal } from '../auth/principal';
import { signLogout } from '../auth/signed';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { defineRoute, publicRoute, type RouteTable, requires } from '../perm/routes';

export const API_VERSION = '0.0.0';

export function coreRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  // Deliberately touches no database: the nightly export makes D1 briefly unavailable (PLAN §12 exp5).
  defineRoute(app, table, { method: 'GET', path: '/api/health', access: publicRoute }, (c) =>
    c.json({ status: 'ok', version: API_VERSION }),
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/me', access: requires('self', 'read') },
    async (c) => {
      const p = await loadPrincipal(c);
      if (!p) throw new ApiError(401, 'unauthenticated', 'Sign in first');
      const body: MeResponse = {
        user: p.user,
        roles: p.roles,
        logout_token: await signLogout(c.env.SESSION_SECRET, p.session.id, p.session.exp),
      };
      return c.json(body);
    },
  );
}
