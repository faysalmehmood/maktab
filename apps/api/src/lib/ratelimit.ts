/**
 * Fixed-window counter per key, in the isolate's memory. Best effort by design: a Worker runs many
 * isolates, so this stops a single client hammering one isolate (and keeps one parent link from
 * burning the D1 budget), while the hard limit is a Cloudflare rate-limiting rule on /api/p/* (M7).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** true = allowed; false = over the limit for this window. */
  take(key: string, now = Date.now()): boolean {
    const w = this.hits.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.sweep(now);
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    w.n += 1;
    return w.n <= this.limit;
  }

  private sweep(now: number): void {
    for (const [k, w] of this.hits) if (now - w.start >= this.windowMs) this.hits.delete(k);
  }
}

/** Parent page: 60 requests a minute per link token (PLAN §7 "rate-limited"). */
export const PARENT_RATE = { limit: 60, windowMs: 60_000 } as const;
