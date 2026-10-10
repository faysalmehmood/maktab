import { type SQL, sql } from 'drizzle-orm';
import { integer, text } from 'drizzle-orm/sqlite-core';

/** ISO-8601 UTC with milliseconds, matching what the client sends. */
export const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const id = () => text('id').primaryKey();

/** PLAN §5: every row records when and by whom. `created_by` is null only for system/seed rows. */
export const stamps = () => ({
  createdAt: text('created_at').notNull().default(nowIso),
  createdBy: text('created_by'),
});

/** Money is INTEGER paisa; the name makes intent obvious at each call site. */
export const paisa = (name: string) => integer(name);

export const bool = (name: string) => integer(name, { mode: 'boolean' });

/** Renders `col IN ('a','b')` for CHECK constraints; values are code constants, never user input. */
export const oneOf = (column: string, values: readonly string[]): SQL =>
  sql.raw(`"${column}" IN (${values.map((v) => `'${v}'`).join(',')})`);
