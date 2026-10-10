import { type AppDb, atomic, rawStatement } from '@maktab/db';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { withD1Retry } from './retry';

/**
 * One user action = one atomic unit (a D1 batch; ADR 0001). Every item goes through
 * `rawStatement` — query builders included (they are SQLWrappers) — so items run in the order
 * listed on both drivers. Ids and audit ids must be minted by the caller *before* this call, so the
 * single transient retry replays byte-identical statements (lib/retry.ts).
 */
export async function tx(db: AppDb, items: SQLWrapper[]): Promise<void> {
  const [first, ...rest] = items;
  if (!first) return;
  await withD1Retry(() =>
    atomic(db, () => [rawStatement(db, first), ...rest.map((q) => rawStatement(db, q))]),
  );
}

type Json = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only the fields that changed, before and after; null when nothing did. */
export function changed(before: Json, after: Json): { before: Json; after: Json } | null {
  const b: Json = {};
  const a: Json = {};
  for (const k of Object.keys(after)) {
    if (after[k] === undefined || same(before[k], after[k])) continue;
    b[k] = before[k] ?? null;
    a[k] = after[k];
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

export type AuditEntry = {
  id: string;
  userId: string;
  entity: string;
  entityId: string;
  action: string;
  before?: Json | null;
  after?: Json | null;
};

/** A value another statement of the same batch wrote (e.g. an auto admission or roll number). */
export const readBack = (
  table: 'student' | 'enrolment',
  column: 'admission_no' | 'roll_no',
  id: string,
): SQL => sql`(SELECT ${sql.identifier(column)} FROM ${sql.identifier(table)} WHERE id = ${id})`;

/**
 * PLAN §5.4 "audit everything": who, what, before/after — written in the same batch as the change.
 * `allocated` adds `after.<key>` values computed inside the batch (list this after the writes).
 */
export function auditSql(e: AuditEntry, allocated: Record<string, SQL> = {}): SQL {
  const diff = JSON.stringify({ before: e.before ?? null, after: e.after ?? {} });
  const sets = Object.entries(allocated);
  if (!sets.length) {
    const plain = JSON.stringify({ before: e.before ?? null, after: e.after ?? null });
    return sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
               VALUES (${e.id}, ${e.userId}, ${e.entity}, ${e.entityId}, ${e.action}, ${plain})`;
  }
  const args = sql.join(
    sets.map(([k, v]) => sql`${`$.after.${k}`}, ${v}`),
    sql`, `,
  );
  return sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
             VALUES (${e.id}, ${e.userId}, ${e.entity}, ${e.entityId}, ${e.action}, json_set(${diff}, ${args}))`;
}
