import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { runBatch } from '../ledger/util';

/**
 * The demo's cheap nightly reset (docs/demo.md): an undo log instead of a full reseed.
 *
 * After a full seed, every data table gets three `_demo_undo_<table>_{i,u,d}` triggers that write
 * one row to `_demo_undo` per visitor change: the key of an inserted row, the old values of an
 * updated or deleted one. The nightly reset plays the log backwards (delete what was inserted, put
 * back what was changed or deleted), so it costs about what the visitors wrote — not the ~32k row
 * writes of a full reseed. Each chunk is one D1 batch (one transaction): the chunk's tables lose
 * their guard and undo triggers, the rows are restored, the triggers come back, and the log rows
 * are deleted, so the money guards are never off between batches.
 *
 * Not logged: the migration journal, the demo's own state, and sign-in sessions (`user_session`:
 * not school data, and the demo buttons would fill the log). A sign-in session of a user the undo
 * removes is deleted with it.
 */

export const UNDO_TABLE = '_demo_undo';
const UNTRACKED = ['d1_migrations', '__drizzle_migrations', 'user_session'];
/** Log rows played back per D1 batch. */
export const UNDO_CHUNK = 100;

type Col = { tbl: string; col: string; pk: number };
export type Tracked = { name: string; cols: string[]; pk: string[] };

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const path = (c: string) => lit(`$.${q(c)}`);

/** The tables the undo log covers, with their columns (generated columns excluded) and keys. */
export async function trackedTables(db: AppDb, only?: string[]): Promise<Tracked[]> {
  // `only`: the columns of just those tables (one read of sqlite_master, not a table_info of all).
  const rows = await db.all<Col>(sql`SELECT m.name AS tbl, p.name AS col, p.pk AS pk
    FROM sqlite_master m, pragma_table_info(m.name) p
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite!_%' ESCAPE '!'
      AND m.name NOT LIKE '!_cf!_%' ESCAPE '!' AND m.name NOT LIKE '!_demo!_%' ESCAPE '!'
      AND m.name NOT IN (SELECT value FROM json_each(${JSON.stringify(UNTRACKED)}))
      AND (${only ? 1 : 0} = 0 OR m.name IN (SELECT value FROM json_each(${JSON.stringify(only ?? [])})))
    ORDER BY m.name, p.cid`);
  const by = new Map<string, Tracked>();
  for (const r of rows) {
    let t = by.get(r.tbl);
    if (!t) {
      t = { name: r.tbl, cols: [], pk: [] };
      by.set(r.tbl, t);
    }
    t.cols.push(r.col);
    if (r.pk > 0) t.pk.push(r.col);
  }
  for (const t of by.values()) if (!t.pk.length) t.pk = ['rowid'];
  return [...by.values()];
}

const triggerNames = (t: string) => ['i', 'u', 'd'].map((k) => `_demo_undo_${t}_${k}`);
const jsonOf = (row: 'NEW' | 'OLD', cols: string[]) =>
  `json_object(${cols.map((c) => `${lit(c)}, ${row}.${q(c)}`).join(', ')})`;

/** CREATE TRIGGER statements that log one table's changes. */
export function undoTriggers(t: Tracked): string[] {
  const [i, u, d] = triggerNames(t.name).map(q);
  const name = lit(t.name);
  const ins = (op: string, pk: string, old: string) =>
    `INSERT INTO ${UNDO_TABLE} (tbl, op, pk, old) VALUES (${name}, '${op}', ${pk}, ${old})`;
  return [
    `CREATE TRIGGER ${i} AFTER INSERT ON ${q(t.name)} BEGIN ${ins('I', jsonOf('NEW', t.pk), 'NULL')}; END`,
    `CREATE TRIGGER ${u} AFTER UPDATE ON ${q(t.name)} BEGIN ${ins('U', jsonOf('NEW', t.pk), jsonOf('OLD', t.cols))}; END`,
    `CREATE TRIGGER ${d} AFTER DELETE ON ${q(t.name)} BEGIN ${ins('D', 'NULL', jsonOf('OLD', t.cols))}; END`,
  ];
}

const dropUndoTriggers = (t: string, ops: Op[] = ['I', 'U', 'D']) =>
  triggerNames(t)
    .filter((_, i) => ops.includes((['I', 'U', 'D'] as const)[i] as Op))
    .map((n) => sql.raw(`DROP TRIGGER IF EXISTS ${q(n)}`));

/** Turns the undo log on (the last step of a full seed). About 200 schema writes, once. */
export async function installUndoLog(db: AppDb): Promise<void> {
  const tables = await trackedTables(db);
  await runBatch(db, [
    sql.raw(`DROP TABLE IF EXISTS ${UNDO_TABLE}`),
    sql.raw(
      `CREATE TABLE ${UNDO_TABLE} (id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, op TEXT NOT NULL, pk TEXT, old TEXT)`,
    ),
  ]);
  // Ten tables (60 statements) a batch; re-running is harmless (drop if exists, then create).
  for (let i = 0; i < tables.length; i += 10)
    await runBatch(
      db,
      tables
        .slice(i, i + 10)
        .flatMap((t) => [...dropUndoTriggers(t.name), ...undoTriggers(t).map(sql.raw)]),
    );
}

/** Drops the log and its triggers (the start of a full reset, so the reseed is not logged). */
export function removeUndoLogStatements(tables: string[]): SQL[] {
  return [
    ...tables.flatMap((t) => dropUndoTriggers(t)),
    sql.raw(`DROP TABLE IF EXISTS ${UNDO_TABLE}`),
  ];
}

/**
 * Reads the log, or null when there is none (before the first seed, during a reset). Not a look in
 * sqlite_master: D1 counts every row of a scan as read, and sqlite_master holds ~470 rows (tables,
 * indexes, ~280 triggers) — every minute's tick would read it.
 */
async function fromLog<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    const msgs: string[] = [];
    for (let e: unknown = err, i = 0; e && i < 5; i++) {
      msgs.push(e instanceof Error ? e.message : String(e));
      e = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
    }
    if (msgs.some((m) => m.includes(`no such table: ${UNDO_TABLE}`))) return null;
    throw err;
  }
}

export type UndoEstimate = { entries: number; writes: number; tables: number };

/**
 * What playing the log back would cost in D1 row writes: per entry, the row and each of its
 * table's indexes, plus deleting the log row; per table touched, its triggers dropped and re-made.
 * One grouped read of the log (no table scans of the data).
 */
export async function estimateUndo(db: AppDb, upTo?: number): Promise<UndoEstimate> {
  const log = await fromLog(() =>
    db.all<{ tbl: string; n: number }>(sql`SELECT tbl, count(*) AS n FROM _demo_undo
      WHERE id <= ${upTo ?? Number.MAX_SAFE_INTEGER} GROUP BY tbl`),
  );
  if (!log?.length) return { entries: 0, writes: 0, tables: 0 };
  // One pass over sqlite_master for every table in the log (it has no index on tbl_name).
  const counts = await db.all<{ tbl: string; idx: number; trg: number }>(sql`
    SELECT tbl_name AS tbl, sum(type = 'index') AS idx, sum(type = 'trigger') AS trg
    FROM sqlite_master WHERE type IN ('index', 'trigger')
      AND tbl_name IN (SELECT value FROM json_each(${JSON.stringify(log.map((r) => r.tbl))}))
    GROUP BY tbl_name`);
  const by = new Map(counts.map((c) => [c.tbl, c]));
  const rows = log.map((r) => ({
    ...r,
    idx: Number(by.get(r.tbl)?.idx ?? 0),
    trg: Number(by.get(r.tbl)?.trg ?? 0),
  }));
  let entries = 0;
  let writes = 0;
  for (const r of rows) {
    entries += r.n;
    // PK autoindexes are not in sqlite_master with sql, but are counted by type = 'index'.
    const chunks = Math.ceil(r.n / UNDO_CHUNK);
    writes += r.n * (2 + r.idx) + chunks * 2 * r.trg;
  }
  return { entries, writes, tables: rows.length };
}

/** The highest log id now (the playback stops there; later changes wait for the next night). */
export async function undoHead(db: AppDb): Promise<number> {
  const r = await fromLog(() =>
    db.all<{ m: number | null }>(sql`SELECT max(id) AS m FROM _demo_undo`),
  );
  return Number(r?.[0]?.m ?? 0);
}

type Op = 'I' | 'U' | 'D';
type Entry = {
  id: number;
  tbl: string;
  op: Op;
  pk: string | null;
  old: string | null;
};

type Restore = 'INSERT' | 'UPDATE' | 'DELETE';
/** The statement that undoes each kind of logged change. */
const RESTORE: Record<Op, Restore> = { I: 'DELETE', U: 'UPDATE', D: 'INSERT' };
/** The undo trigger a restore would fire: undoing an insert deletes (the `_d` trigger), … */
const logged = (ops: Op[]): Op[] => ops.map((o) => ({ I: 'D', U: 'U', D: 'I' })[o] as Op);

/** The event a trigger fires on, or null if its text is not understood (then it is dropped). */
export function triggerEvent(text: string): Restore | null {
  const m =
    /^\s*CREATE\s+(?:TEMP\w*\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[\w.]+)\s+(?:BEFORE\s+|AFTER\s+|INSTEAD\s+OF\s+)?(INSERT|UPDATE|DELETE)\b/i.exec(
      text,
    );
  return m ? ((m[1] as string).toUpperCase() as Restore) : null;
}

function restoreStatement(e: Entry, t: Tracked): string {
  const where = (json: string, alias = '') =>
    t.pk.map((c) => `${alias}${q(c)} IS json_extract(${json}, ${path(c)})`).join(' AND ');
  if (e.op === 'I') return `DELETE FROM ${q(t.name)} WHERE ${where(lit(e.pk ?? '{}'))}`;
  const cols = t.cols;
  if (e.op === 'D')
    return `INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')})
      SELECT ${cols.map((c) => `json_extract(j.v, ${path(c)})`).join(', ')} FROM (SELECT ${lit(e.old ?? '{}')} AS v) j`;
  return `UPDATE ${q(t.name)} SET ${cols.map((c) => `${q(c)} = json_extract(j.v, ${path(c)})`).join(', ')}
    FROM (SELECT ${lit(e.old ?? '{}')} AS v) j WHERE ${where(lit(e.pk ?? '{}'), `${q(t.name)}.`)}`;
}

/**
 * Plays back one chunk (the newest log rows up to `upTo`) in one batch. Returns how many entries
 * it restored (0 = the log is played back up to `upTo`).
 */
export async function undoChunk(db: AppDb, upTo: number): Promise<number> {
  const entries = await fromLog(() =>
    db.all<Entry>(sql`SELECT id, tbl, op, pk, old FROM _demo_undo
      WHERE id <= ${upTo} ORDER BY id DESC LIMIT ${UNDO_CHUNK}`),
  );
  if (!entries?.length) return 0;
  const names = [...new Set(entries.map((e) => e.tbl))];
  // What each table's restores do: an insert is undone by a DELETE, a delete by an INSERT, an
  // update by an UPDATE. Only the triggers on those events are dropped and re-made: each DROP
  // TRIGGER is a scan of sqlite_master (~470 rows read on D1), so dropping every trigger of a table
  // the log touched cost ~20,000 rows read for a handful of changes.
  const events = new Map<string, Set<Restore>>();
  const ops = new Map<string, Op[]>();
  for (const e of entries) {
    const ev = events.get(e.tbl) ?? new Set<Restore>();
    ev.add(RESTORE[e.op]);
    events.set(e.tbl, ev);
    const o = ops.get(e.tbl) ?? [];
    if (!o.includes(e.op)) o.push(e.op);
    ops.set(e.tbl, o);
  }
  const tables = new Map((await trackedTables(db, names)).map((t) => [t.name, t]));
  const guards = (
    await db.all<{ name: string; tbl: string; sql: string }>(sql`SELECT name, tbl_name AS tbl, sql
    FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE '!_demo!_%' ESCAPE '!'
      AND tbl_name IN (SELECT value FROM json_each(${JSON.stringify(names)}))`)
  ).filter((g) => {
    const on = triggerEvent(g.sql);
    return !on || !!events.get(g.tbl)?.has(on);
  });
  const stmts: SQL[] = [sql`PRAGMA defer_foreign_keys = ON`];
  for (const g of guards) stmts.push(sql.raw(`DROP TRIGGER IF EXISTS ${q(g.name)}`));
  for (const n of names) stmts.push(...dropUndoTriggers(n, logged(ops.get(n) ?? [])));
  // Sign-in sessions are not logged: a user the undo removes loses theirs first, so the delete never
  // relies on deferred foreign keys (user_session.user_id is NO ACTION today, which defers; a
  // RESTRICT would be checked at once, before the cleanup after the restores).
  const goneUsers = entries
    .filter((e) => e.tbl === 'user' && e.op === 'I')
    .map((e) => String((JSON.parse(e.pk ?? '{}') as { id?: unknown }).id ?? ''));
  if (goneUsers.length)
    stmts.push(
      sql`DELETE FROM user_session WHERE user_id IN (SELECT value FROM json_each(${JSON.stringify(goneUsers)}))`,
    );
  for (const e of entries) {
    const t = tables.get(e.tbl);
    // A table dropped since (a migration): nothing to restore into.
    if (t) stmts.push(sql.raw(restoreStatement(e, t)));
  }
  // Sign-in sessions are not logged: drop those whose user the undo just removed (deferred FKs).
  if (names.includes('user'))
    stmts.push(sql`DELETE FROM user_session WHERE user_id NOT IN (SELECT id FROM "user")`);
  for (const g of guards) stmts.push(sql.raw(g.sql));
  for (const t of tables.values()) {
    const again = new Set(logged(ops.get(t.name) ?? []));
    stmts.push(
      ...undoTriggers(t)
        .filter((_, i) => again.has((['I', 'U', 'D'] as const)[i] as Op))
        .map(sql.raw),
    );
  }
  const ids = entries.map((e) => e.id);
  stmts.push(
    sql`DELETE FROM _demo_undo WHERE id BETWEEN ${Math.min(...ids)} AND ${Math.max(...ids)}`,
  );
  await runBatch(db, stmts);
  return entries.length;
}
