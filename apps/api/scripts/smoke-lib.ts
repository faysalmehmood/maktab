/**
 * Shared plumbing for the per-milestone smoke scripts (smoke-m1.ts, smoke-m2.ts): HTTP against
 * `wrangler dev --local`, PASS/FAIL per step, and an exit code. After the first failure the
 * remaining steps are skipped (they usually depend on it).
 *
 * SMOKE_BASE (default http://localhost:$API_PORT, 8787), SMOKE_ORIGIN (default
 * http://localhost:$PORT, 5173) and SMOKE_EMAIL (default owner@example.com) override.
 */
export const BASE = process.env.SMOKE_BASE ?? `http://localhost:${process.env.API_PORT ?? '8787'}`;
export const EMAIL = process.env.SMOKE_EMAIL ?? 'owner@example.com';
// The Worker's CSRF guard compares Origin with APP_ORIGIN for form posts; browsers always send it.
export const ORIGIN = process.env.SMOKE_ORIGIN ?? `http://localhost:${process.env.PORT ?? '5173'}`;

export type Res<T> = { status: number; body: T; text: string };

/** A JSON client bound to whatever cookie `cookie()` returns at call time. */
export function makeApi(cookie: () => string) {
  return async function api<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie: cookie(), origin: ORIGIN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON (CSV, image): keep the text
    }
    return { status: res.status, body: parsed as T, text };
  };
}

export function expectOk(cond: unknown, detail: unknown): void {
  if (!cond)
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400));
}

let failed = 0;
let skipping = false;

export async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (skipping) {
    console.log(`SKIP  ${name}`);
    return;
  }
  try {
    const note = await fn();
    console.log(`PASS  ${name}${typeof note === 'string' ? `  (${note})` : ''}`);
  } catch (err) {
    failed++;
    skipping = true;
    console.log(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Runs cleanup steps even after a failure (they never count as skipped). */
export async function always(name: string, fn: () => Promise<unknown>): Promise<void> {
  const was = skipping;
  skipping = false;
  await step(name, fn);
  skipping = was || skipping;
}

export function finish(): never {
  console.log(failed ? `\nFAIL (${failed} step failed)` : '\nPASS (all steps)');
  process.exit(failed ? 1 : 0);
}

/** Random suffix so a script can run again against the same database. */
export const runId = Math.random().toString(36).slice(2, 7);
