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
  const rows = await db.all<Col>(sql`SELECT m.name AS tbl, p.name AS col, p.pk AS pk
    FROM sqlite_master m, pragma_table_info(m.name) p
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite!_%' ESCAPE '!'
      AND m.name NOT LIKE '!_cf!_%' ESCAPE '!' AND m.name NOT LIKE '!_demo!_%' ESCAPE '!'
      AND m.name NOT IN (SELECT value FROM json_each(${JSON.stringify(UNTRACKED)}))
    ORDER BY m.name, p.cid`);
  const by = new Map<string, Tracked>();
  for (const r of rows) {
    if (only && !only.includes(r.tbl)) continue;
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

const dropUndoTriggers = (t: string) =>
  triggerNames(t).map((n) => sql.raw(`DROP TRIGGER IF EXISTS ${q(n)}`));

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
  return [...tables.flatMap(dropUndoTriggers), sql.raw(`DROP TABLE IF EXISTS ${UNDO_TABLE}`)];
}

async function undoLogExists(db: AppDb): Promise<boolean> {
  const r = await db.all(
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${UNDO_TABLE}`,
  );
  return r.length > 0;
}

export type UndoEstimate = { entries: number; writes: number; tables: number };

/**
 * What playing the log back would cost in D1 row writes: per entry, the row and each of its
 * table's indexes, plus deleting the log row; per table touched, its triggers dropped and re-made.
 * One grouped read of the log (no table scans of the data).
 */
export async function estimateUndo(db: AppDb, upTo?: number): Promise<UndoEstimate> {
  if (!(await undoLogExists(db))) return { entries: 0, writes: 0, tables: 0 };
  const rows = await db.all<{ tbl: string; n: number; idx: number; trg: number }>(sql`
    SELECT u.tbl, u.n,
      (SELECT count(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = u.tbl) AS idx,
      (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = u.tbl) AS trg
    FROM (SELECT tbl, count(*) AS n FROM _demo_undo WHERE id <= ${upTo ?? Number.MAX_SAFE_INTEGER}
          GROUP BY tbl) u`);
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
  if (!(await undoLogExists(db))) return 0;
  const [r] = await db.all<{ m: number | null }>(sql`SELECT max(id) AS m FROM _demo_undo`);
  return Number(r?.m ?? 0);
}

type Entry = {
  id: number;
  tbl: string;
  op: 'I' | 'U' | 'D';
  pk: string | null;
  old: string | null;
};

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
  if (!(await undoLogExists(db))) return 0;
  const entries = await db.all<Entry>(sql`SELECT id, tbl, op, pk, old FROM _demo_undo
    WHERE id <= ${upTo} ORDER BY id DESC LIMIT ${UNDO_CHUNK}`);
  if (!entries.length) return 0;
  const names = [...new Set(entries.map((e) => e.tbl))];
  const tables = new Map((await trackedTables(db, names)).map((t) => [t.name, t]));
  const guards = await db.all<{ name: string; sql: string }>(sql`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name NOT LIKE '!_demo!_%' ESCAPE '!'
      AND tbl_name IN (SELECT value FROM json_each(${JSON.stringify(names)}))`);
  const stmts: SQL[] = [sql`PRAGMA defer_foreign_keys = ON`];
  for (const g of guards) stmts.push(sql.raw(`DROP TRIGGER IF EXISTS ${q(g.name)}`));
  for (const n of names) stmts.push(...dropUndoTriggers(n));
  for (const e of entries) {
    const t = tables.get(e.tbl);
    // A table dropped since (a migration): nothing to restore into.
    if (t) stmts.push(sql.raw(restoreStatement(e, t)));
  }
  // Sign-in sessions are not logged: drop those whose user the undo just removed (deferred FKs).
  if (names.includes('user'))
    stmts.push(sql`DELETE FROM user_session WHERE user_id NOT IN (SELECT id FROM "user")`);
  for (const g of guards) stmts.push(sql.raw(g.sql));
  for (const t of tables.values()) stmts.push(...undoTriggers(t).map(sql.raw));
  const ids = entries.map((e) => e.id);
  stmts.push(
    sql`DELETE FROM _demo_undo WHERE id BETWEEN ${Math.min(...ids)} AND ${Math.max(...ids)}`,
  );
  await runBatch(db, stmts);
  return entries.length;
}
