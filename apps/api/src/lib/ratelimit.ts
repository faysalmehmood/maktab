import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { ApiError } from './errors';
import { clientIp } from './turnstile';

/**
 * Fixed-window counter per key, in the isolate's memory. Best effort by design: a Worker runs many
 * isolates, so this stops a single client hammering one isolate (and keeps one parent link from
 * burning the D1 budget), while the hard limits are Cloudflare rate-limiting rules (docs/deploy.md §7:
 * /p, /p/…, /api/p, /api/p/… 60/min; /api/auth, /api/auth/… 20/min; POST /api/* 300/min, per IP).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** true = allowed; false = over the limit for this window. */
  take(key: string, now = Date.now()): boolean {
    return this.hit(key, now).allowed;
  }

  /** Counts one request and says where the key stands in its window. */
  hit(key: string, now = Date.now()): { allowed: boolean; remaining: number; resetMs: number } {
    let w = this.hits.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.sweep(now);
      w = { start: now, n: 0 };
      this.hits.set(key, w);
    }
    w.n += 1;
    return {
      allowed: w.n <= this.limit,
      remaining: Math.max(0, this.limit - w.n),
      resetMs: w.start + this.windowMs - now,
    };
  }

  private sweep(now: number): void {
    for (const [k, w] of this.hits) if (now - w.start >= this.windowMs) this.hits.delete(k);
  }
}

/** Parent page: 60 requests a minute per link token (PLAN §7 "rate-limited"). */
export const PARENT_RATE = { limit: 60, windowMs: 60_000 } as const;
/** Per client IP, in front of the routes (M7 defence in depth; the same numbers as the WAF rules). */
export const IP_RATES = {
  parent: { limit: 60, windowMs: 60_000 },
  auth: { limit: 20, windowMs: 60_000 },
} as const;

/**
 * Which per-IP limit a path falls under, matched exactly like the WAF expressions in docs/deploy.md
 * §7: the segment itself or anything below it — `/api/payroll`, `/api/payslips`, `/api/parent-links`
 * and `/api/programmes` are not parent routes, `/api/authority` would not be a sign-in route.
 */
export function rateClass(path: string): keyof typeof IP_RATES | null {
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (under('/api/p')) return 'parent';
  if (under('/api/auth')) return 'auth';
  return null;
}

/** One middleware for every limited surface on `/api/*`, routed by `rateClass`. */
export function apiRateLimits(): MiddlewareHandler<AppEnv> {
  const byClass = {
    parent: ipRateLimit('p', IP_RATES.parent),
    auth: ipRateLimit('auth', IP_RATES.auth),
  };
  return async (c, next) => {
    const k = rateClass(c.req.path);
    if (!k) return next();
    return byClass[k](c, next);
  };
}

/**
 * Per-IP limiter middleware. Sets the IETF draft `RateLimit-*` headers on every answer and
 * `Retry-After` on a 429. Without a client IP (local tests, no proxy) the key is the empty string.
 */
export function ipRateLimit(name: string, rate: { limit: number; windowMs: number }) {
  const limiter = new RateLimiter(rate.limit, rate.windowMs);
  const mw: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
    const ip = clientIp((h) => c.req.header(h)) ?? '';
    const r = limiter.hit(`${name}:${ip}`);
    const reset = String(Math.ceil(r.resetMs / 1000));
    const headers = {
      'RateLimit-Limit': String(rate.limit),
      'RateLimit-Remaining': String(r.remaining),
      'RateLimit-Reset': reset,
    };
    if (!r.allowed) {
      c.header('Retry-After', reset);
      for (const [k, v] of Object.entries(headers)) c.header(k, v);
      throw new ApiError(429, 'rate_limited', 'Too many requests; wait a minute');
    }
    await next();
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v);
  });
  return mw;
}
