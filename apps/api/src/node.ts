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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HttpBindings, type ServerType, serve } from '@hono/node-server';
import type { AppDb } from '@maktab/db';
import {
  applyD1Migrations,
  d1MigrationState,
  drizzleOver,
  openSqlite,
  verifySchema,
} from '@maktab/db/node';
import type Database from 'better-sqlite3';
import { createApp } from './app';
import type { Bindings } from './env';
import { configWarning } from './lib/config';
import { errorBody } from './lib/errors';
import { checkAgeRecipient, encryptedSnapshot, runLocalBackup } from './node/backup';
import { DirBucket } from './node/dir-bucket';
import { logErrorLine } from './node/log';
import { chooseClientIp, isLoopback, parseTrustedProxies, type TrustedProxies } from './node/proxy';
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
  /** Peers whose CF-Connecting-IP is believed (TRUST_PROXY_FROM); empty = the socket peer only. */
  trustedProxies: TrustedProxies;
  scheduler: boolean;
  /** Required unless allowUnencrypted (checked again at start by encrypting one byte). */
  ageRecipient?: string;
  allowUnencrypted: boolean;
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
  const parent = opt(env, 'PARENT_LINK_SECRET');
  if (parent && parent.length < 32)
    throw new ConfigError('PARENT_LINK_SECRET is shorter than 32 characters');
  const ageRecipient = opt(env, 'AGE_RECIPIENT');
  const allowUnencrypted = env.ALLOW_UNENCRYPTED_BACKUPS === '1';
  if (!ageRecipient && !allowUnencrypted)
    throw new ConfigError(
      'AGE_RECIPIENT is missing: set the backup public key (age1…), or ALLOW_UNENCRYPTED_BACKUPS=1 to store backups unencrypted',
    );
  if (ageRecipient && !/^age1[0-9a-z]{20,200}$/.test(ageRecipient))
    throw new ConfigError('AGE_RECIPIENT is not an age public key (age1…)');
  if (env.TRUST_PROXY !== undefined)
    throw new ConfigError('TRUST_PROXY was replaced by TRUST_PROXY_FROM (docs/self-host.md §5)');
  let trustedProxies: TrustedProxies;
  try {
    trustedProxies = parseTrustedProxies(env.TRUST_PROXY_FROM);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  return {
    port,
    host: opt(env, 'HOST') ?? '0.0.0.0',
    dataDir,
    webDir: resolve(opt(env, 'WEB_DIR') ?? join(REPO_ROOT, 'apps/web/dist')),
    migrationsDir: resolve(opt(env, 'MIGRATIONS_DIR') ?? join(REPO_ROOT, 'packages/db/migrations')),
    sqlDir: resolve(opt(env, 'SQL_DIR') ?? join(REPO_ROOT, 'packages/db/sql')),
    version: opt(env, 'MAKTAB_VERSION') ?? 'dev',
    trustedProxies,
    scheduler: env.MAKTAB_SCHEDULER !== '0',
    ageRecipient,
    allowUnencrypted,
    rcloneRemote: opt(env, 'BACKUP_RCLONE_REMOTE'),
    vars: {
      SESSION_SECRET: session,
      PARENT_LINK_SECRET: parent,
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

export { chooseClientIp };

/**
 * The request the app sees: exactly one `cf-connecting-ip` (the value chosen by `chooseClientIp`)
 * and no X-Forwarded-For / X-Real-IP / True-Client-IP, so `clientIp()` in the app cannot be fed a
 * header a client set.
 */
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
  /** The pre-migration backup's key in BACKUPS (null when nothing was migrated on an old db). */
  preMigrate: string | null;
  close: () => Promise<void>;
};

/**
 * Opens (backs up, migrates, verifies) the database, then listens. Throws on any start-up problem.
 * Before applying migrations to a database that already has some (an upgrade), a full encrypted
 * copy goes to `backups/pre-migrate/`; if that copy fails nothing is migrated.
 */
export async function startServer(config: NodeConfig): Promise<RunningServer> {
  if (config.ageRecipient) {
    try {
      await checkAgeRecipient(config.ageRecipient);
    } catch (err) {
      throw new ConfigError(err instanceof Error ? err.message : String(err));
    }
  }
  if (!config.vars.PARENT_LINK_SECRET)
    console.warn(
      '[maktab] WARNING: PARENT_LINK_SECRET is not set. Parent links cannot be made or opened until it is (docs/self-host.md §5).',
    );
  if (!config.trustedProxies.entries.length)
    console.warn(
      '[maktab] TRUST_PROXY_FROM is empty: every request counts as coming from the tunnel container, so the per-IP limits apply to the whole school at once (docs/self-host.md §5).',
    );
  for (const d of ['files', 'backups', 'tmp'])
    mkdirSync(join(config.dataDir, d), { recursive: true, mode: 0o700 });
  const backups = new DirBucket(join(config.dataDir, 'backups'));
  const tmpDir = join(config.dataDir, 'tmp');
  const sqlite = openSqlite(join(config.dataDir, 'maktab.sqlite'));
  let migrationsApplied: string[];
  let preMigrate: string | null = null;
  try {
    const state = d1MigrationState(sqlite, config.migrationsDir);
    if (state.pending.length && state.applied.length) {
      const last = (state.applied.at(-1) ?? 'none').replace(/\.sql$/, '');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        const snap = await encryptedSnapshot(
          { sqlite, backups, tmpDir, ageRecipient: config.ageRecipient },
          `pre-migrate/${stamp}-${last}`,
        );
        preMigrate = snap.key;
      } catch (err) {
        throw new Error(
          `the backup before migrating failed, so nothing was migrated: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.log(
        `[maktab] ${state.pending.length} migration(s) to apply; database saved first to backups/${preMigrate}`,
      );
    }
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

  const { app } = createApp({ getDb: () => db, logError: logErrorLine });

  /** Status and database only; the version only for a peer inside the container. */
  const health = (peer: string | undefined) => {
    let dbOk = false;
    try {
      dbOk = (sqlite.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined)?.ok === 1;
    } catch {
      dbOk = false;
    }
    return Response.json(
      {
        status: dbOk ? 'ok' : 'error',
        db: dbOk ? 'ok' : 'error',
        ...(isLoopback(peer) ? { version: config.version } : {}),
      },
      { status: dbOk ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    );
  };

  const fetchHandler = async (raw: Request, env: HttpBindings): Promise<Response> => {
    const path = new URL(raw.url).pathname;
    const peer = env.incoming.socket.remoteAddress;
    if (path === '/healthz') return health(peer);
    if (path === '/__scheduled')
      return Response.json(errorBody('not_found', `No route for ${raw.method} ${path}`), {
        status: 404,
      });
    const req = withClientIp(raw, chooseClientIp(raw.headers, peer, config.trustedProxies));
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
            tmpDir,
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
    preMigrate,
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
