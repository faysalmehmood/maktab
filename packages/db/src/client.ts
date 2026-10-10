import { type SQLWrapper, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';

export type Schema = typeof schema;

/**
 * The one database type route code sees. D1 (async) in the Worker, better-sqlite3 (sync) in Node;
 * drizzle queries are awaitable on both, so handlers are written once.
 */
export type AppDb = BaseSQLiteDatabase<'sync' | 'async', unknown, Schema>;

/** Minimal shape of a D1 binding, so this file does not depend on Workers ambient types. */
export type D1Like = Parameters<typeof drizzleD1>[0];

export type D1Env = { DB: D1Like };

/** Worker-safe factory: never imports better-sqlite3, which cannot be bundled for Workers. */
export function getDb(env: D1Env): AppDb {
  return drizzleD1(env.DB, { schema }) as unknown as AppDb;
}

type Batchable = { batch: (items: BatchItem<'sqlite'>[]) => Promise<unknown> };
const isBatchable = (db: object): db is Batchable =>
  'batch' in db && typeof (db as { batch: unknown }).batch === 'function';

/**
 * A raw statement usable inside `atomic`. The union DB type erases `run`'s return type; on D1 it is
 * a lazy batchable query, on better-sqlite3 it has already executed (inside atomic's BEGIN).
 */
export const rawStatement = (db: AppDb, query: SQLWrapper): BatchItem<'sqlite'> =>
  db.run(query) as unknown as BatchItem<'sqlite'>;

type Items = [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]];

/**
 * Runs statements as one atomic unit. On D1 that is `batch()` (an implicit transaction — the only
 * kind D1 offers). On better-sqlite3 it is BEGIN/COMMIT on the single local connection.
 * Takes a builder because sync drivers execute raw `db.run(sql…)` items at construction time, so it
 * must be called after BEGIN. Consequence: on better-sqlite3 raw items run before query-builder
 * items, so list raw statements first.
 */
export async function atomic(db: AppDb, build: () => Items): Promise<void> {
  if (isBatchable(db)) {
    await db.batch(build());
    return;
  }
  await db.run(sql`BEGIN IMMEDIATE`);
  try {
    for (const item of build()) await item;
    await db.run(sql`COMMIT`);
  } catch (err) {
    await db.run(sql`ROLLBACK`);
    throw err;
  }
}

export { schema };
