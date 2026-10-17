import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { type AppDb, type D1Env, getDb as getD1Db } from './client';
import * as schema from './schema';
import {
  compareObjects,
  expectedObjectsFrom,
  MASTER_QUERY,
  type SchemaObject,
} from './schema-check';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export type NodeEnv = { SQLITE_PATH: string };

/**
 * Node-side factory: D1 when a binding is present, otherwise a better-sqlite3 file (':memory:' in
 * tests). Lives in its own entry so the Worker bundle never pulls in a native module.
 */
export function getDb(env: D1Env | NodeEnv): AppDb {
  if ('DB' in env) return getD1Db(env);
  const sqlite = new Database(env.SQLITE_PATH);
  // Same guarantees D1 gives by default (PLAN §12 exp1: foreign_keys = 1 on D1).
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema }) as unknown as AppDb;
}

/** Applies every migration (Drizzle-generated + hand-written SQL) to a local database. */
export function migrateLocal(db: AppDb): void {
  migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_DIR });
}

// ---- Self-hosted runtime (apps/api/src/node.ts, docs/self-host.md) ------------------------------

export const SQL_DIR = fileURLToPath(new URL('../sql', import.meta.url));

/** wrangler's migrations table (`d1 migrations apply`), so a database can move to D1 and back. */
export const D1_MIGRATIONS_TABLE = 'd1_migrations';

/**
 * One better-sqlite3 connection for a long-running server: WAL (readers never block the writer),
 * a 5 s busy timeout (the backup or a CLI `sqlite3` holding a lock briefly), foreign keys on as on D1
 * and in the tests.
 */
export function openSqlite(path: string): Database.Database {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  return sqlite;
}

/** A drizzle database over an open connection (the same schema the Worker uses). */
export function drizzleOver(sqlite: Database.Database): AppDb {
  return drizzle(sqlite, { schema }) as unknown as AppDb;
}

/**
 * wrangler's migration order (`compareMigrationPaths`): by the leading number before the first `_`,
 * numbered names first, then by name. Only top-level `*.sql` files, like wrangler's default pattern.
 */
export function migrationNames(dir: string): string[] {
  const lead = (n: string) => Number.parseInt(n.split('_')[0] ?? '', 10);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => {
      const x = lead(a);
      const y = lead(b);
      if (x !== y) {
        if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
        if (Number.isFinite(x)) return -1;
        if (Number.isFinite(y)) return 1;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/**
 * Applies the migrations `wrangler d1 migrations apply` has not recorded, with its semantics: the
 * same table and columns, the file name (with `.sql`) as `name`, files in wrangler's order, and each
 * file plus its `INSERT INTO d1_migrations` as one unit. D1 runs that unit as one transaction with
 * foreign keys enforced (PRAGMA foreign_keys=OFF is a no-op inside it), and so does this: BEGIN
 * IMMEDIATE … COMMIT, ROLLBACK on any error, so a failed migration leaves nothing behind and is
 * retried on the next start. Idempotent: a second call applies nothing.
 */
export function applyD1Migrations(sqlite: Database.Database, dir = MIGRATIONS_DIR): string[] {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${D1_MIGRATIONS_TABLE}(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`);
  const applied = new Set(
    (
      sqlite.prepare(`SELECT name FROM ${D1_MIGRATIONS_TABLE} ORDER BY id`).all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  const done: string[] = [];
  const record = sqlite.prepare(`INSERT INTO ${D1_MIGRATIONS_TABLE} (name) VALUES (?)`);
  for (const name of migrationNames(dir)) {
    if (applied.has(name)) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(text);
      record.run(name);
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      throw new Error(
        `migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    done.push(name);
  }
  return done;
}

/** packages/db/sql/*.sql as `db:verify` reads it (file name -> trimmed text). */
export function readSqlFiles(dir = SQL_DIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    out[f] = readFileSync(join(dir, f), 'utf8').trim();
  return out;
}

/** `db:verify` against a local file: missing/extra triggers, views and indexes (empty = healthy). */
export function verifySchema(sqlite: Database.Database, sqlDir = SQL_DIR) {
  const actual = sqlite.prepare(MASTER_QUERY).all() as SchemaObject[];
  const expected = expectedObjectsFrom(readSqlFiles(sqlDir));
  const count = (t: string, list: readonly SchemaObject[]) =>
    list.filter((o) => o.type === t).length;
  return {
    ...compareObjects(actual, expected),
    triggers: count('trigger', actual),
    views: count('view', actual),
    expectedTriggers: count('trigger', expected),
    expectedViews: count('view', expected),
  };
}

/** Fresh migrated in-memory database for tests. */
export function createTestDb(): AppDb {
  const db = getDb({ SQLITE_PATH: ':memory:' });
  migrateLocal(db);
  return db;
}
