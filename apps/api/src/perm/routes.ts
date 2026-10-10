import type { Action, Permission, Resource } from '@maktab/shared';
import type { Handler, Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { matchedRoutes } from 'hono/route';
import { loadPrincipal, principalRoles } from '../auth/principal';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { decide } from './matrix';

export type Access = { kind: 'public' } | { kind: 'requires'; permission: Permission };
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RouteSpec = { method: Method; path: string; access: Access };

/** Explicitly public: reachable without a session (health, OAuth, logout). */
export const publicRoute: Access = { kind: 'public' };

export function requires<R extends Resource>(resource: R, action: Action<R>): Access {
  return { kind: 'requires', permission: { resource, action } as Permission };
}

const key = (method: string, path: string) => `${method} ${path}`;

/** Every API endpoint is declared here with its access rule; the guard denies anything else. */
export class RouteTable {
  private readonly specs = new Map<string, RouteSpec>();

  add(spec: RouteSpec): void {
    const k = key(spec.method, spec.path);
    if (this.specs.has(k)) throw new Error(`route declared twice: ${k}`);
    this.specs.set(k, spec);
  }

  has(method: string, path: string): boolean {
    return this.specs.has(key(method, path));
  }

  list(): RouteSpec[] {
    return [...this.specs.values()];
  }
}

function guard(access: Access): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (access.kind === 'public') return next();
    const principal = await loadPrincipal(c);
    if (!principal) throw new ApiError(401, 'unauthenticated', 'Sign in first');
    const grant = decide(principalRoles(principal), access.permission);
    if (grant === false) throw new ApiError(403, 'forbidden', 'You do not have access to this');
    c.set('grant', grant);
    return next();
  });
}

/** The only way handlers get mounted: declaration and guard cannot drift apart. */
export function defineRoute(
  app: Hono<AppEnv>,
  table: RouteTable,
  spec: RouteSpec,
  handler: Handler<AppEnv>,
): void {
  table.add(spec);
  app.on(spec.method, spec.path, guard(spec.access), handler);
}

/**
 * Default deny: if an endpoint was mounted without defineRoute (e.g. a stray `app.get`), refuse it.
 * Runs before handlers; middleware entries have method ALL and are ignored.
 */
export function denyUndeclared(table: RouteTable): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    for (const r of matchedRoutes(c)) {
      if (r.method !== 'ALL' && !table.has(r.method, r.path)) {
        throw new ApiError(403, 'undeclared_route', 'Route has no declared permission');
      }
    }
    return next();
  });
}
