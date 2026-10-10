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

type D1Statement = { bind: (...values: unknown[]) => unknown };
type D1Client = {
  prepare: (query: string) => D1Statement;
  batch: (statements: unknown[]) => Promise<unknown>;
};
const isD1Client = (c: unknown): c is D1Client =>
  !!c &&
  typeof (c as D1Client).prepare === 'function' &&
  typeof (c as D1Client).batch === 'function';

/** SQL text + params of a batch item: raw statements expose getQuery(), builders toSQL(). */
function toQuery(item: BatchItem<'sqlite'>): { sql: string; params: unknown[] } {
  const q = item as unknown as {
    getQuery?: () => { sql: string; params: unknown[] };
    toSQL?: () => { sql: string; params: unknown[] };
  };
  const built = q.getQuery?.() ?? q.toSQL?.();
  if (!built) throw new Error('atomic: unsupported batch item');
  return built;
}

/**
 * Runs statements as one atomic unit. On D1 that is `batch()` (an implicit transaction — the only
 * kind D1 offers). On better-sqlite3 it is BEGIN/COMMIT on the single local connection.
 * Takes a builder because sync drivers execute raw `db.run(sql…)` items at construction time, so it
 * must be called after BEGIN. Consequence: on better-sqlite3 raw items run before query-builder
 * items, so list raw statements first.
 *
 * The sync path never yields to the event loop between BEGIN and COMMIT: better-sqlite3 has one
 * connection, so an `await` in the middle would let a concurrent request's statements run inside
 * this transaction (or its BEGIN fail). Query-builder items are run with their synchronous `run()`.
 */
export async function atomic(db: AppDb, build: () => Items): Promise<void> {
  if (isBatchable(db)) {
    const items = build();
    const client = (db as { $client?: unknown }).$client;
    if (isD1Client(client)) {
      // drizzle's D1 batch() binds parameters through `preparedQuery.stmt`, which raw statements
      // (`db.run(sql…)`, i.e. rawStatement) do not have: any parameterised raw item threw
      // "Cannot read properties of undefined (reading 'bind')" on real D1. Prepare and batch on the
      // D1 client directly instead; it is the same single implicit transaction.
      await client.batch(
        items.map((item) => {
          const q = toQuery(item);
          return client.prepare(q.sql).bind(...q.params);
        }),
      );
      return;
    }
    await db.batch(items);
    return;
  }
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    for (const item of build()) {
      const lazy = item as unknown as { run?: () => unknown };
      if (typeof lazy.run === 'function') lazy.run();
    }
    db.run(sql`COMMIT`);
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}

export { schema };
