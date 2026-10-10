import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { type AppDb, type D1Env, getDb as getD1Db } from './client';
import * as schema from './schema';

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

/** Fresh migrated in-memory database for tests. */
export function createTestDb(): AppDb {
  const db = getDb({ SQLITE_PATH: ':memory:' });
  migrateLocal(db);
  return db;
}
