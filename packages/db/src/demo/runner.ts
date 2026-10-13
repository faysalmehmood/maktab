import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { runBatch } from '../ledger/util';
import { type Step, type StepCtx, seedSteps } from './steps';
import { world } from './world';

/**
 * The demo reset (docs/demo.md): wipe → reseed, as a list of resumable steps driven by the cron (and
 * by POST /api/demo/step) a few at a time, so it fits the free plan's per-invocation budget.
 *
 * Wipe = DROP and re-CREATE every table, index, view and trigger from a snapshot of
 * `sqlite_master` taken at the start of the reset. Not DELETE: D1 counts each deleted row (and
 * index entry) against the account's 100k rows-written a day, a DROP costs a handful (measured
 * 2026-10-13: DELETE of 1,000 indexed rows = 1,000+, DROP TABLE = 4). The money triggers are
 * re-created with the schema, so they are never off while data exists. Two tables survive: the
 * migration journal (`d1_migrations` / drizzle's) and `_demo_state` (this runner's own state).
 *
 * The reset only ever runs where the caller checked DEMO_MODE; `startDemoReset` additionally refuses
 * a database whose school is not the demo school (a production database pointed at by mistake).
 */

export const DEMO_STATE_TABLE = '_demo_state';
const KEEP = ['d1_migrations', '__drizzle_migrations', DEMO_STATE_TABLE];
const LEASE_MS = 90_000;
export const DEMO_SCHOOL_NAME = 'Al-Noor Community School';

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string };

const ensureState = (db: AppDb) =>
  db.run(sql`CREATE TABLE IF NOT EXISTS _demo_state (key TEXT PRIMARY KEY, value TEXT)`);

async function getState(db: AppDb): Promise<Record<string, string>> {
  const rows = await db.all<{ key: string; value: string }>(
    sql`SELECT key, value FROM _demo_state`,
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const setState = (kv: Record<string, string | null>): SQL[] =>
  Object.entries(kv).map(([k, v]) =>
    v === null
      ? sql`DELETE FROM _demo_state WHERE key = ${k}`
      : sql`INSERT INTO _demo_state (key, value) VALUES (${k}, ${v})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );

// ---- wipe ---------------------------------------------------------------------------------------

const snapshotStep: Step = {
  name: 'wipe:snapshot',
  run: async ({ db }) => {
    const st = await getState(db);
    if (st.schema) return null;
    const rows = await db.all<SchemaRow>(sql`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        AND tbl_name NOT IN (SELECT value FROM json_each(${JSON.stringify(KEEP)}))
      ORDER BY rowid`);
    if (!rows.some((r) => r.type === 'table' && r.name === 'school'))
      throw new Error('demo wipe: no schema to snapshot (migrations not applied?)');
    await runBatch(db, setState({ schema: JSON.stringify(rows) }));
    return null;
  },
};

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

const dropStep: Step = {
  name: 'wipe:drop',
  run: async ({ db }) => {
    const rows = JSON.parse((await getState(db)).schema ?? '[]') as SchemaRow[];
    const stmts: SQL[] = [sql`PRAGMA defer_foreign_keys = ON`];
    for (const r of rows.filter((x) => x.type === 'trigger'))
      stmts.push(sql.raw(`DROP TRIGGER IF EXISTS ${q(r.name)}`));
    for (const r of [...rows].reverse().filter((x) => x.type === 'view'))
      stmts.push(sql.raw(`DROP VIEW IF EXISTS ${q(r.name)}`));
    for (const r of [...rows].reverse().filter((x) => x.type === 'table'))
      stmts.push(sql.raw(`DROP TABLE IF EXISTS ${q(r.name)}`));
    await runBatch(db, stmts);
    return null;
  },
};

const createStep: Step = {
  name: 'wipe:create',
  run: async ({ db }) => {
    const rows = JSON.parse((await getState(db)).schema ?? '[]') as SchemaRow[];
    const present = new Set(
      (await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master`)).map((r) => r.name),
    );
    const order = ['table', 'index', 'view', 'trigger'];
    const todo = order.flatMap((t) => rows.filter((r) => r.type === t && !present.has(r.name)));
    if (todo.length)
      await runBatch(
        db,
        todo.map((r) => sql.raw(r.sql)),
      );
    return null;
  },
};

const WIPE: Step[] = [snapshotStep, dropStep, createStep];

let all: Step[] | null = null;
export function demoPlan(): Step[] {
  if (!all) all = [...WIPE, ...seedSteps()];
  return all;
}

// ---- state ----------------------------------------------------------------------------------------

export type DemoStatus = {
  /** idle = never seeded here; running = a reset is under way; done = seeded. */
  phase: 'idle' | 'running' | 'done';
  step: number;
  total: number;
  step_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** Someone changed data since the last seed (the nightly reset only runs then). */
  dirty: boolean;
  last_error: string | null;
};

export async function demoStatus(db: AppDb): Promise<DemoStatus> {
  await ensureState(db);
  const st = await getState(db);
  const plan = demoPlan();
  const step = Number(st.step ?? 0);
  const phase = (st.phase as DemoStatus['phase']) ?? 'idle';
  return {
    phase,
    step,
    total: plan.length,
    step_name: phase === 'running' ? (plan[step]?.name ?? null) : null,
    started_at: st.started_at ?? null,
    finished_at: st.finished_at ?? null,
    dirty: st.dirty === '1',
    last_error: st.last_error ?? null,
  };
}

/**
 * Starts a reset (or the first seed). Refuses a database that holds another school unless it is
 * empty of people — the guard against pointing the demo at a real installation by mistake;
 * `force` is for a fresh demo database that still has another school's setup rows (docs/demo.md).
 */
export async function startDemoReset(
  db: AppDb,
  o: { reason: string; now?: Date; force?: boolean },
): Promise<DemoStatus> {
  await ensureState(db);
  let school: { name: string } | undefined;
  try {
    [school] = await db.all<{ name: string }>(sql`SELECT name FROM school LIMIT 1`);
  } catch {
    school = undefined; // no school table yet
  }
  const force = o.force || (await getState(db)).force === '1';
  if (school && school.name !== DEMO_SCHOOL_NAME && !force)
    throw new Error(`demo reset refused: this database belongs to "${school.name}"`);
  const now = (o.now ?? new Date()).toISOString();
  await runBatch(
    db,
    setState({
      phase: 'running',
      step: '0',
      sub: '0',
      started_at: now,
      finished_at: null,
      schema: null,
      last_error: null,
      reason: o.reason,
      dirty: '0',
      force: null,
    }),
  );
  return demoStatus(db);
}

/**
 * Set by hand (`INSERT INTO _demo_state VALUES ('force', '1')`, docs/demo.md) to let the next reset
 * take over a database that still holds another school's rows.
 */
export async function demoForcePending(db: AppDb): Promise<boolean> {
  await ensureState(db);
  return (await getState(db)).force === '1';
}

/** Marks the demo as changed by a visitor (cheap: a no-op write once it is already set). */
export async function markDemoDirty(db: AppDb): Promise<void> {
  await db.run(sql`UPDATE _demo_state SET value = '1' WHERE key = 'dirty' AND value <> '1'`);
}

export type AdvanceResult = DemoStatus & { calls: number; leased: boolean };

/**
 * Runs steps until `deadline` (ms since epoch) or `maxCalls` step calls, holding a lease so a cron
 * tick and an HTTP step never run the same step at once. Progress is saved after every finished
 * step and at the end; a call cut off in the middle is repeated next time (steps are idempotent).
 */
export async function advanceDemoSeed(
  db: AppDb,
  o: {
    deadline: number;
    maxCalls?: number;
    parentSecret?: string;
    ownerEmail?: string;
    now?: () => number;
  },
): Promise<AdvanceResult> {
  await ensureState(db);
  const now = o.now ?? Date.now;
  const st0 = await getState(db);
  if (st0.phase !== 'running') return { ...(await demoStatus(db)), calls: 0, leased: false };
  const token = `${new Date(now() + LEASE_MS).toISOString()}|${Math.random().toString(36).slice(2)}`;
  await db.run(
    sql`INSERT INTO _demo_state (key, value) VALUES ('lease', '0') ON CONFLICT (key) DO NOTHING`,
  );
  await db.run(sql`UPDATE _demo_state SET value = ${token}
    WHERE key = 'lease' AND substr(value, 1, 24) < ${new Date(now()).toISOString()}`);
  const [lease] = await db.all<{ value: string }>(
    sql`SELECT value FROM _demo_state WHERE key = 'lease'`,
  );
  if (lease?.value !== token) return { ...(await demoStatus(db)), calls: 0, leased: false };

  const plan = demoPlan();
  const ctx: StepCtx = { db, w: world(), parentSecret: o.parentSecret, ownerEmail: o.ownerEmail };
  let step = Number(st0.step ?? 0);
  let sub = Number(st0.sub ?? 0);
  let calls = 0;
  const save = (extra: Record<string, string | null> = {}) =>
    runBatch(db, setState({ step: String(step), sub: String(sub), ...extra }));
  try {
    while (step < plan.length && now() < o.deadline && calls < (o.maxCalls ?? Infinity)) {
      const s = plan[step] as Step;
      const next = await s.run(ctx, sub);
      calls++;
      if (next === null) {
        step++;
        sub = 0;
        await save();
      } else sub = next;
    }
    if (step >= plan.length)
      await save({
        phase: 'done',
        finished_at: new Date(now()).toISOString(),
        schema: null,
        dirty: '0',
      });
    else await save();
  } catch (err) {
    const msg = `${plan[step]?.name ?? '?'}#${sub}: ${err instanceof Error ? err.message : String(err)}`;
    await save({ last_error: msg.slice(0, 1000) }).catch(() => {});
    throw err;
  } finally {
    await db.run(sql`UPDATE _demo_state SET value = '0' WHERE key = 'lease' AND value = ${token}`);
  }
  return { ...(await demoStatus(db)), calls, leased: true };
}

/** The whole reset in one process (local script and tests): no deadline. */
export async function seedDemo(
  db: AppDb,
  o: { parentSecret?: string; ownerEmail?: string; force?: boolean } = {},
): Promise<AdvanceResult> {
  await startDemoReset(db, { reason: 'local seed', force: o.force });
  let r: AdvanceResult;
  do r = await advanceDemoSeed(db, { deadline: Number.POSITIVE_INFINITY, ...o });
  while (r.phase === 'running' && r.leased);
  return r;
}
