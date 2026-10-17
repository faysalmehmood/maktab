/**
 * Self-hosted runtime (PLAN §8 portability, M8a; docs/self-host.md): the same Hono app as the Worker
 * (`createApp`), on Node with @hono/node-server, SQLite on disk (better-sqlite3, one connection) and
 * files in a directory. Never imported by the Worker (src/index.ts): this module pulls in native
 * better-sqlite3 and node:fs, which the Workers bundle must not contain.
 *
 * Start: `npm run build:node -w @maktab/api && npm run start:node -w @maktab/api` (or the Docker
 * image). Layout under DATA_DIR: maktab.sqlite (+ -wal/-shm), files/, backups/{daily,monthly}/, tmp/.
 */
import { mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HttpBindings, type ServerType, serve } from '@hono/node-server';
import type { AppDb } from '@maktab/db';
import { applyD1Migrations, drizzleOver, openSqlite, verifySchema } from '@maktab/db/node';
import type Database from 'better-sqlite3';
import { createApp } from './app';
import type { Bindings } from './env';
import { configWarning } from './lib/config';
import { errorBody } from './lib/errors';
import { runLocalBackup } from './node/backup';
import { DirBucket } from './node/dir-bucket';
import { type Scheduler, startScheduler } from './node/scheduler';
import { createStaticHandler, type StaticHandler } from './node/static';

/** apps/api/src/node.ts and apps/api/dist-node/node.mjs are both two levels under apps/api. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * wrangler.toml `run_worker_first`: these go to the app before any static file (a test keeps the two
 * lists equal). `/__scheduled` is answered 404 here before that: there is no cron trigger over HTTP.
 */
export const RUN_WORKER_FIRST = ['/api/*', '/__scheduled', '/p', '/p/*'] as const;

export const runsWorkerFirst = (path: string) =>
  RUN_WORKER_FIRST.some((p) => (p.endsWith('/*') ? path.startsWith(p.slice(0, -1)) : path === p));

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type NodeConfig = {
  port: number;
  host: string;
  dataDir: string;
  webDir: string;
  migrationsDir: string;
  sqlDir: string;
  version: string;
  /** Behind the Cloudflare Tunnel: take the client IP from CF-Connecting-IP / X-Forwarded-For. */
  trustProxy: boolean;
  scheduler: boolean;
  ageRecipient?: string;
  rcloneRemote?: string;
  /** The Worker's string bindings, from the environment. */
  vars: Pick<
    Bindings,
    | 'SESSION_SECRET'
    | 'PARENT_LINK_SECRET'
    | 'GOOGLE_CLIENT_ID'
    | 'GOOGLE_CLIENT_SECRET'
    | 'APP_ORIGIN'
    | 'OWNER_EMAIL'
    | 'TURNSTILE_SITE_KEY'
    | 'TURNSTILE_SECRET'
    | 'BACKUP_REPORT_TOKEN'
  >;
};

type Env = Record<string, string | undefined>;

const opt = (env: Env, k: string) => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};

/** Reads and checks the environment; throws ConfigError (never printing a secret) when it is unusable. */
export function loadConfig(env: Env = process.env): NodeConfig {
  // The public demo is a Cloudflare-only installation (docs/demo.md): its reset and sign-in buttons
  // must never exist on a real school's server.
  if (env.DEMO_MODE !== undefined && env.DEMO_MODE !== '')
    throw new ConfigError('DEMO_MODE is set: the self-hosted server never runs the demo; unset it');
  const session = env.SESSION_SECRET?.trim() ?? '';
  if (session.length < 32)
    throw new ConfigError('SESSION_SECRET is missing or shorter than 32 characters');
  const origin = opt(env, 'APP_ORIGIN');
  if (!origin) throw new ConfigError('APP_ORIGIN is missing (e.g. https://gsap.conceptlix.com)');
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ConfigError('APP_ORIGIN is not a URL');
  }
  if (parsed.origin !== origin.replace(/\/$/, ''))
    throw new ConfigError('APP_ORIGIN must be an origin only (scheme://host[:port]), no path');
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))
    throw new ConfigError('APP_ORIGIN must be https:// (http only for localhost)');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ConfigError('PORT is not a port');
  const dataDir = resolve(opt(env, 'DATA_DIR') ?? '/data');
  return {
    port,
    host: opt(env, 'HOST') ?? '0.0.0.0',
    dataDir,
    webDir: resolve(opt(env, 'WEB_DIR') ?? join(REPO_ROOT, 'apps/web/dist')),
    migrationsDir: resolve(opt(env, 'MIGRATIONS_DIR') ?? join(REPO_ROOT, 'packages/db/migrations')),
    sqlDir: resolve(opt(env, 'SQL_DIR') ?? join(REPO_ROOT, 'packages/db/sql')),
    version: opt(env, 'MAKTAB_VERSION') ?? 'dev',
    trustProxy: env.TRUST_PROXY !== '0',
    scheduler: env.MAKTAB_SCHEDULER !== '0',
    ageRecipient: opt(env, 'AGE_RECIPIENT'),
    rcloneRemote: opt(env, 'BACKUP_RCLONE_REMOTE'),
    vars: {
      SESSION_SECRET: session,
      PARENT_LINK_SECRET: opt(env, 'PARENT_LINK_SECRET'),
      GOOGLE_CLIENT_ID: opt(env, 'GOOGLE_CLIENT_ID') ?? '',
      GOOGLE_CLIENT_SECRET: opt(env, 'GOOGLE_CLIENT_SECRET') ?? '',
      APP_ORIGIN: parsed.origin,
      OWNER_EMAIL: opt(env, 'OWNER_EMAIL'),
      TURNSTILE_SITE_KEY: opt(env, 'TURNSTILE_SITE_KEY'),
      TURNSTILE_SECRET: opt(env, 'TURNSTILE_SECRET'),
      BACKUP_REPORT_TOKEN: opt(env, 'BACKUP_REPORT_TOKEN'),
    },
  };
}

const normIp = (ip: string | undefined) => {
  const v = ip?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return v && isIP(v) ? v : undefined;
};

/**
 * The client IP the app sees (rate limits, audit, the parent access log, Turnstile's remoteip): the
 * only thing the proxy headers are trusted for. Behind the tunnel (trustProxy) CF-Connecting-IP,
 * then the first X-Forwarded-For entry, then the socket; otherwise the socket only. The request
 * then carries exactly one `cf-connecting-ip` (the value chosen here) and no X-Forwarded-For, so
 * `clientIp()` in the app cannot be fed a different header than the one chosen.
 */
export function chooseClientIp(
  headers: Headers,
  socketAddr: string | undefined,
  trustProxy: boolean,
): string | undefined {
  if (trustProxy) {
    const cf = normIp(headers.get('cf-connecting-ip') ?? undefined);
    if (cf) return cf;
    const xff = normIp(headers.get('x-forwarded-for')?.split(',')[0]);
    if (xff) return xff;
  }
  return normIp(socketAddr);
}

function withClientIp(req: Request, ip: string | undefined): Request {
  const headers = new Headers(req.headers);
  headers.delete('x-forwarded-for');
  headers.delete('x-real-ip');
  headers.delete('true-client-ip');
  if (ip) headers.set('cf-connecting-ip', ip);
  else headers.delete('cf-connecting-ip');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(req.url, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    signal: req.signal,
    redirect: 'manual',
    // Required by undici for a streamed body.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}

export type RunningServer = {
  port: number;
  server: ServerType;
  sqlite: Database.Database;
  db: AppDb;
  scheduler: Scheduler | null;
  statics: StaticHandler;
  migrationsApplied: string[];
  close: () => Promise<void>;
};

/** Opens (and migrates, and verifies) the database, then listens. Throws on any start-up problem. */
export async function startServer(config: NodeConfig): Promise<RunningServer> {
  for (const d of ['files', 'backups', 'tmp'])
    mkdirSync(join(config.dataDir, d), { recursive: true, mode: 0o700 });
  const sqlite = openSqlite(join(config.dataDir, 'maktab.sqlite'));
  let migrationsApplied: string[];
  try {
    migrationsApplied = applyD1Migrations(sqlite, config.migrationsDir);
    const check = verifySchema(sqlite, config.sqlDir);
    if (check.missing.length || check.extra.length) {
      throw new Error(
        `schema check failed (db:verify): missing ${check.missing.join(', ') || 'none'}; unexpected ${check.extra.join(', ') || 'none'}`,
      );
    }
    console.log(
      `[maktab] database ok: ${migrationsApplied.length} migration(s) applied now; ${check.triggers} triggers (expected ${check.expectedTriggers}), ${check.views} views (expected ${check.expectedViews})`,
    );
  } catch (err) {
    sqlite.close();
    throw err;
  }
  const db = drizzleOver(sqlite);
  const files = new DirBucket(join(config.dataDir, 'files'));
  const backups = new DirBucket(join(config.dataDir, 'backups'));
  const statics = createStaticHandler(config.webDir);

  const bindings = {
    ...config.vars,
    FILES: files as unknown as R2Bucket,
    BACKUPS: backups as unknown as R2Bucket,
    ASSETS: {
      fetch: (input: Request | string) => statics.index(new Request(input)),
    } as unknown as Fetcher,
  } as Bindings;
  const warning = configWarning(bindings);
  if (warning) console.warn(warning);

  const { app } = createApp({ getDb: () => db });

  const health = () => {
    let dbOk = false;
    try {
      dbOk = (sqlite.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined)?.ok === 1;
    } catch {
      dbOk = false;
    }
    return Response.json(
      { status: dbOk ? 'ok' : 'error', version: config.version, db: dbOk ? 'ok' : 'error' },
      { status: dbOk ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    );
  };

  const fetchHandler = async (raw: Request, env: HttpBindings): Promise<Response> => {
    const path = new URL(raw.url).pathname;
    if (path === '/healthz') return health();
    if (path === '/__scheduled')
      return Response.json(errorBody('not_found', `No route for ${raw.method} ${path}`), {
        status: 404,
      });
    const req = withClientIp(
      raw,
      chooseClientIp(raw.headers, env.incoming.socket.remoteAddress, config.trustProxy),
    );
    if (runsWorkerFirst(path)) return app.fetch(req, bindings);
    const asset = await statics.serve(req);
    return asset ?? app.fetch(req, bindings);
  };

  const server = await new Promise<{ server: ServerType; port: number }>((done, fail) => {
    const s = serve(
      {
        fetch: fetchHandler as never,
        port: config.port,
        hostname: config.host,
        overrideGlobalObjects: false,
      },
      (info) => done({ server: s, port: info.port }),
    );
    s.once('error', fail);
  });
  console.log(`[maktab] listening on ${config.host}:${server.port} (version ${config.version})`);

  const scheduler = config.scheduler
    ? startScheduler({
        db,
        backup: () =>
          runLocalBackup({
            sqlite,
            db,
            backups,
            tmpDir: join(config.dataDir, 'tmp'),
            ageRecipient: config.ageRecipient,
            rcloneRemote: config.rcloneRemote,
          }),
        hasBackupFor: async (day) =>
          (await backups.list({ prefix: `daily/${day}.`, limit: 10 })).objects.some(
            (o) => !o.key.endsWith('.sha256'),
          ),
      })
    : null;

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      await new Promise<void>((done) => server.server.close(() => done()));
      await scheduler?.stop();
      try {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Closing anyway.
      }
      sqlite.close();
    })();
    return closing;
  };

  return {
    port: server.port,
    server: server.server,
    sqlite,
    db,
    scheduler,
    statics,
    migrationsApplied,
    close,
  };
}

/** The process entry (bin/server.mjs): config errors exit 1 with one line, SIGTERM closes cleanly. */
export async function main(): Promise<void> {
  // The database, its WAL, uploaded photos and backups are readable by this user only.
  process.umask(0o077);
  let running: RunningServer;
  try {
    running = await startServer(loadConfig());
  } catch (err) {
    console.error(
      `[maktab] refusing to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  const stop = (signal: string) => {
    console.log(`[maktab] ${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    running.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('[maktab] shutdown failed', err);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}
