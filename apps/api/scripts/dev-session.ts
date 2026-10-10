/**
 * DEV ONLY. Prints a session cookie for a user in the local wrangler D1, so the API can be driven
 * with curl (or scripts/smoke-m1.ts) without a Google round-trip. There is deliberately no
 * dev-login route in the Worker (PLAN §10: no debug endpoints).
 *
 *   npm run dev:session -w @maktab/api -- owner@example.com
 *   curl -H "Cookie: $(npm run -s dev:session -w @maktab/api -- owner@example.com)" localhost:8787/api/me
 *
 * On an empty database the email is bootstrapped as the active owner (what OWNER_EMAIL + a first
 * Google sign-in would do). D1_PERSIST_TO=<dir> matches `wrangler dev --persist-to <dir>`.
 * Refuses when NODE_ENV=production, and unless SESSION_SECRET in
 * apps/api/.dev.vars is the example value or ALLOW_DEV_SESSION=1 is set — a real secret means a
 * real deployment's cookies could be forged with this script.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AppDb, role, user, userSession } from '@maktab/db';
import { getDb } from '@maktab/db/node';
import { newId } from '@maktab/shared';
import { eq, sql } from 'drizzle-orm';
import { SESSION_TTL_SEC, sessionCookieName } from '../src/auth/principal';
import { signSession } from '../src/auth/signed';

export const EXAMPLE_SECRET = 'dev-only-secret-change-me-at-least-32-chars';
const apiDir = fileURLToPath(new URL('..', import.meta.url));

/** KEY=value lines; later files override earlier ones, like wrangler does for .dev.vars. */
function readVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  const toml = readFileSync(join(apiDir, 'wrangler.toml'), 'utf8');
  // Top-level [vars] only: stop at the first [env.*] table.
  const top = toml.split(/^\[env\./m)[0] ?? '';
  const origin = /^APP_ORIGIN\s*=\s*"([^"]*)"/m.exec(top)?.[1];
  if (origin) vars.APP_ORIGIN = origin;
  const devVars = join(apiDir, '.dev.vars');
  if (existsSync(devVars)) {
    for (const line of readFileSync(devVars, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m?.[1]) vars[m[1]] = (m[2] ?? '').replace(/^"(.*)"$/, '$1');
    }
  }
  return vars;
}

/** wrangler's default state dir, or D1_PERSIST_TO when wrangler runs with `--persist-to <dir>`. */
export function localD1File(): string {
  const root = process.env.D1_PERSIST_TO ?? join(apiDir, '.wrangler/state');
  const dir = join(root, 'v3/d1/miniflare-D1DatabaseObject');
  const file = existsSync(dir)
    ? readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
    : undefined;
  if (!file) throw new Error('No local D1 database. Run `npm run db:migrate:local` first.');
  return join(dir, file);
}

export type DevSession = { cookie: string; userId: string; bootstrapped: boolean };

export async function mintDevSession(email: string, dbPath = localD1File()): Promise<DevSession> {
  if (process.env.NODE_ENV === 'production') throw new Error('dev-session is dev-only');
  const vars = readVars();
  const secret = vars.SESSION_SECRET ?? '';
  if (secret !== EXAMPLE_SECRET && process.env.ALLOW_DEV_SESSION !== '1') {
    throw new Error(
      'SESSION_SECRET in apps/api/.dev.vars is not the example value; set ALLOW_DEV_SESSION=1 if this really is a local-only secret',
    );
  }
  const db: AppDb = getDb({ SQLITE_PATH: dbPath });
  const addr = email.trim().toLowerCase();
  let bootstrapped = false;
  let [u] = await db.select().from(user).where(eq(user.email, addr));
  if (!u) {
    const [n] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM "user"`);
    if ((n?.n ?? 0) > 0)
      throw new Error(`${addr} is not a user here (and the database is not empty)`);
    const id = newId();
    await db.insert(user).values({ id, email: addr, name: 'Owner (dev)', status: 'active' });
    await db.insert(role).values({ userId: id, role: 'owner' });
    bootstrapped = true;
    [u] = await db.select().from(user).where(eq(user.email, addr));
  }
  if (!u) throw new Error('user lookup failed');
  if (u.status !== 'active')
    throw new Error(`${addr} is ${u.status}; only active users can sign in`);
  const sid = newId();
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  await db.insert(userSession).values({
    id: sid,
    userId: u.id,
    expiresAt: new Date(exp * 1000).toISOString(),
    ua: 'dev-session script',
    createdBy: u.id,
  });
  // On http://localhost the cookie is `maktab_sid`; `__Host-maktab_sid` needs an https origin.
  const name = sessionCookieName(vars.APP_ORIGIN ?? 'http://localhost:5173');
  return { cookie: `${name}=${await signSession(secret, sid, exp)}`, userId: u.id, bootstrapped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: dev-session.ts <email>');
    process.exit(2);
  }
  mintDevSession(email)
    .then((s) => {
      if (s.bootstrapped) console.error(`(bootstrapped ${email} as owner on an empty database)`);
      console.log(s.cookie);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
