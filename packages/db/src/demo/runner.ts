import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { runBatch } from '../ledger/util';
import { type Step, type StepCtx, seedSteps } from './steps';
import { estimateUndo, installUndoLog, UNDO_TABLE, undoChunk, undoHead } from './undo';
import { demoCalendar, demoToday, world } from './world';

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
const LEASE_MS = 45_000;
export const DEMO_SCHOOL_NAME = 'Al-Noor Community School';

/**
 * The D1 write budget (docs/demo.md). The account's free plan allows 100,000 rows written a day,
 * shared with the GSA pilot. A row write is the row plus one per index on its table.
 * DEMO_SEED_WRITES is a full reseed, measured on the local seed (rows × (1 + indexes) + updates);
 * demo-seed.test.ts recomputes it and fails if the dataset grows past it.
 */
export const DEMO_SEED_WRITES = 33_000;
/** No full reseed may be planned above this. */
export const DEMO_SEED_WRITE_CAP = 35_000;
/** The nightly undo is skipped (and an alarm logged) when playing the log back would cost more. */
export const DEMO_UNDO_WRITE_CAP = 20_000;

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
        AND name NOT LIKE '!_demo!_%' ESCAPE '!' AND tbl_name NOT LIKE '!_demo!_%' ESCAPE '!'
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
    // The undo log (its triggers went with their tables): the reseed must not be logged.
    stmts.push(sql.raw(`DROP TABLE IF EXISTS ${UNDO_TABLE}`));
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

/** Last: from now on every change is logged, so the nightly reset can undo just that (undo.ts). */
const undoInstallStep: Step = {
  name: 'undo:install',
  run: async ({ db }) => {
    await installUndoLog(db);
    return null;
  },
};

const plans = new Map<string, Step[]>();
/**
 * The reset for a seed day (`anchor`, YYYY-MM-DD in Asia/Karachi; default today). The anchor is
 * fixed when a reset starts (`_demo_state.anchor`), so a reset that runs past midnight keeps
 * building the same dataset.
 */
export function demoPlan(anchor = demoToday()): Step[] {
  let p = plans.get(anchor);
  if (!p) {
    p = [...WIPE, ...seedSteps(demoCalendar(anchor)), undoInstallStep];
    plans.set(anchor, p);
  }
  return p;
}

const signatures = new Map<string, string>();
/**
 * Names of every step, hashed: stored when a reset starts. A deploy that changes the plan while a
 * reset is running would make the saved step index point at another step, so the runner restarts
 * the reset from the wipe instead (every step is idempotent, nothing is lost but time).
 */
export function demoPlanSignature(anchor = demoToday()): string {
  let sig = signatures.get(anchor);
  if (!sig) {
    let h = 2166136261;
    for (const c of demoPlan(anchor)
      .map((s) => s.name)
      .join('|'))
      h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    sig = `${demoPlan(anchor).length}:${(h >>> 0).toString(36)}`;
    signatures.set(anchor, sig);
  }
  return sig;
}

// ---- state ----------------------------------------------------------------------------------------

export type DemoStatus = {
  /**
   * idle = never seeded here; running = a full reseed is under way; undoing = the nightly undo of
   * visitors' changes is under way; done = seeded.
   */
  phase: 'idle' | 'running' | 'undoing' | 'done';
  step: number;
  total: number;
  step_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** Someone changed data since the last seed (the nightly reset only runs then). */
  dirty: boolean;
  last_error: string | null;
  /** Set after D1 refused a write for the account's daily limit: nothing runs before then. */
  backoff_until: string | null;
};

export async function demoStatus(db: AppDb): Promise<DemoStatus> {
  await ensureState(db);
  const st = await getState(db);
  const plan = demoPlan(st.anchor ?? demoToday());
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
    backoff_until: st.backoff_until ?? null,
  };
}

// ---- the daily budget guards --------------------------------------------------------------------

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = (ms: number) =>
  new Date(Date.parse(`${utcDay(ms)}T00:00:00Z`) + 86_400_000).toISOString();

/** D1's answer once the account's daily rows read / written are used up (or the DB is full). */
export function isQuotaError(err: unknown): boolean {
  const msgs: string[] = [];
  for (let e: unknown = err, i = 0; e && i < 5; i++) {
    msgs.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  }
  return /exceeded|quota|daily limit|limit (?:has been )?reached|usage limit/i.test(msgs.join(' '));
}

/** Per isolate: the state write below fails too while the quota is used up. */
let memBackoff = 0;

/** Stop every demo write until the next UTC midnight, when D1's daily counters reset. */
export async function demoQuotaBackoff(db: AppDb, nowMs = Date.now()): Promise<string> {
  const until = nextUtcMidnight(nowMs);
  memBackoff = Date.parse(until);
  console.error(JSON.stringify({ demo_alarm: 'd1_quota', backoff_until: until }));
  await runBatch(db, setState({ backoff_until: until })).catch(() => {});
  return until;
}

export function demoBackedOff(s: Pick<DemoStatus, 'backoff_until'>, nowMs = Date.now()): boolean {
  return nowMs < memBackoff || (!!s.backoff_until && nowMs < Date.parse(s.backoff_until));
}

/** A reset (full or undo) already started this UTC day: at most one a day. */
const resetToday = (st: Record<string, string>, nowMs: number) =>
  st.last_reset_day === utcDay(nowMs);

/**
 * Starts a reset (or the first seed). Refuses a database that holds another school unless it is
 * empty of people — the guard against pointing the demo at a real installation by mistake;
 * `force` is for a fresh demo database that still has another school's setup rows (docs/demo.md).
 */
export async function startDemoReset(
  db: AppDb,
  o: {
    reason: string;
    now?: Date;
    force?: boolean;
    daily?: boolean;
    /** The seed day (YYYY-MM-DD); default today in Asia/Karachi. Tests pin it. */
    today?: string;
  },
): Promise<DemoStatus> {
  await ensureState(db);
  if (DEMO_SEED_WRITES > DEMO_SEED_WRITE_CAP)
    throw new Error(`demo reset refused: a reseed would write ~${DEMO_SEED_WRITES} rows`);
  const nowMs = (o.now ?? new Date()).getTime();
  if (o.daily !== false && resetToday(await getState(db), nowMs))
    throw new Error('demo reset refused: one reset a UTC day (the D1 write budget)');
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
  const anchor = o.today ?? demoToday(nowMs);
  demoCalendar(anchor); // refuses a malformed date before anything is wiped
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
      anchor,
      plan: demoPlanSignature(anchor),
      last_reset_day: utcDay(nowMs),
    }),
  );
  console.log(JSON.stringify({ demo_reset: o.reason, anchor, planned_writes: DEMO_SEED_WRITES }));
  return demoStatus(db);
}

export type UndoStart =
  | { started: true; entries: number; writes: number }
  | { started: false; reason: 'empty' | 'today' | 'over_budget' | 'busy'; writes?: number };

/**
 * The nightly reset: plays the undo log back (undo.ts). Never more than one reset a UTC day, and
 * never above DEMO_UNDO_WRITE_CAP: then it logs an alarm and leaves the demo as it is (the owner can
 * reseed by hand on a quiet day).
 */
export async function startDemoUndo(
  db: AppDb,
  o: { now?: number; daily?: boolean } = {},
): Promise<UndoStart> {
  await ensureState(db);
  const nowMs = o.now ?? Date.now();
  const st = await getState(db);
  if (st.phase === 'running' || st.phase === 'undoing') return { started: false, reason: 'busy' };
  if (o.daily !== false && resetToday(st, nowMs)) return { started: false, reason: 'today' };
  const upTo = await undoHead(db);
  if (!upTo) return { started: false, reason: 'empty' };
  const est = await estimateUndo(db, upTo);
  if (est.writes > DEMO_UNDO_WRITE_CAP) {
    const msg = `undo skipped: ${est.entries} changes would cost ~${est.writes} row writes (cap ${DEMO_UNDO_WRITE_CAP})`;
    console.error(JSON.stringify({ demo_alarm: 'undo_over_budget', ...est }));
    await runBatch(db, setState({ last_error: msg, last_reset_day: utcDay(nowMs) }));
    return { started: false, reason: 'over_budget', writes: est.writes };
  }
  await runBatch(
    db,
    setState({
      phase: 'undoing',
      undo_upto: String(upTo),
      started_at: new Date(nowMs).toISOString(),
      finished_at: null,
      last_error: null,
      reason: 'nightly undo',
      last_reset_day: utcDay(nowMs),
    }),
  );
  console.log(JSON.stringify({ demo_undo: est }));
  return { started: true, entries: est.entries, writes: est.writes };
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

type AdvanceOpts = {
  deadline: number;
  maxCalls?: number;
  parentSecret?: string;
  ownerEmail?: string;
  now?: () => number;
};

/** A heavy undo chunk (one batch of up to UNDO_CHUNK restores) counts as this many step calls. */
const UNDO_CHUNK_COST = 4;

/**
 * Runs a reset forward until `deadline` (ms since epoch) or `maxCalls` step calls, holding a lease
 * so a cron tick and an HTTP step never run the same work at once: the full reseed's steps
 * (phase running) or the undo log's chunks (phase undoing). Progress is saved after every finished
 * step and at the end; a call cut off in the middle is repeated next time (steps are idempotent,
 * an undo chunk is one transaction). A D1 quota error stops everything until the next UTC midnight.
 */
export async function advanceDemoSeed(db: AppDb, o: AdvanceOpts): Promise<AdvanceResult> {
  await ensureState(db);
  const now = o.now ?? Date.now;
  const st0 = await getState(db);
  const idle = async () => ({ ...(await demoStatus(db)), calls: 0, leased: false });
  if (st0.phase !== 'running' && st0.phase !== 'undoing') return idle();
  if (demoBackedOff({ backoff_until: st0.backoff_until ?? null }, now())) return idle();
  const token = `${new Date(now() + LEASE_MS).toISOString()}|${Math.random().toString(36).slice(2)}`;
  await db.run(
    sql`INSERT INTO _demo_state (key, value) VALUES ('lease', '0') ON CONFLICT (key) DO NOTHING`,
  );
  await db.run(sql`UPDATE _demo_state SET value = ${token}
    WHERE key = 'lease' AND substr(value, 1, 24) < ${new Date(now()).toISOString()}`);
  const [lease] = await db.all<{ value: string }>(
    sql`SELECT value FROM _demo_state WHERE key = 'lease'`,
  );
  if (lease?.value !== token) return idle();
  let calls = 0;
  try {
    calls =
      st0.phase === 'undoing' ? await runUndo(db, st0, o, now) : await runSeed(db, st0, o, now);
  } catch (err) {
    if (isQuotaError(err)) await demoQuotaBackoff(db, now());
    throw err;
  } finally {
    try {
      await db.run(
        sql`UPDATE _demo_state SET value = '0' WHERE key = 'lease' AND value = ${token}`,
      );
    } catch {
      // Quota or a lost connection: the lease expires by itself (LEASE_MS).
    }
  }
  return { ...(await demoStatus(db)), calls, leased: true };
}

async function runSeed(
  db: AppDb,
  st0: Record<string, string>,
  o: AdvanceOpts,
  now: () => number,
): Promise<number> {
  // A reset started before the anchor existed is re-planned for today (and so restarts below).
  const anchor = st0.anchor ?? demoToday(now());
  const plan = demoPlan(anchor);
  if (st0.plan !== demoPlanSignature(anchor)) {
    // Started by another version of the plan: begin again from the wipe (see demoPlanSignature).
    st0.step = '0';
    st0.sub = '0';
    await runBatch(
      db,
      setState({ step: '0', sub: '0', schema: null, anchor, plan: demoPlanSignature(anchor) }),
    );
  }
  const cal = demoCalendar(anchor);
  const ctx: StepCtx = {
    db,
    w: world(cal),
    cal,
    parentSecret: o.parentSecret,
    ownerEmail: o.ownerEmail,
  };
  let step = Number(st0.step ?? 0);
  let sub = Number(st0.sub ?? 0);
  let calls = 0;
  const save = (extra: Record<string, string | null> = {}) =>
    runBatch(db, setState({ step: String(step), sub: String(sub), ...extra }));
  try {
    while (step < plan.length && now() < o.deadline && calls < (o.maxCalls ?? Infinity)) {
      const s = plan[step] as Step;
      const next = await s.run(ctx, sub);
      calls += s.cost ?? 1;
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
  }
  return calls;
}

async function runUndo(
  db: AppDb,
  st0: Record<string, string>,
  o: AdvanceOpts,
  now: () => number,
): Promise<number> {
  const upTo = Number(st0.undo_upto ?? 0);
  let calls = 0;
  try {
    while (now() < o.deadline && calls < (o.maxCalls ?? Infinity)) {
      const n = await undoChunk(db, upTo);
      calls += UNDO_CHUNK_COST;
      if (n === 0) {
        await runBatch(
          db,
          setState({
            phase: 'done',
            finished_at: new Date(now()).toISOString(),
            undo_upto: null,
            dirty: '0',
          }),
        );
        break;
      }
    }
  } catch (err) {
    const msg = `undo: ${err instanceof Error ? err.message : String(err)}`;
    await runBatch(db, setState({ last_error: msg.slice(0, 1000) })).catch(() => {});
    throw err;
  }
  return calls;
}

/** The whole reset in one process (local script and tests): no deadline. */
export async function seedDemo(
  db: AppDb,
  o: { parentSecret?: string; ownerEmail?: string; force?: boolean; today?: string } = {},
): Promise<AdvanceResult> {
  await startDemoReset(db, { reason: 'local seed', force: o.force, daily: false, today: o.today });
  let r: AdvanceResult;
  do r = await advanceDemoSeed(db, { deadline: Number.POSITIVE_INFINITY, ...o });
  while (r.phase === 'running' && r.leased);
  return r;
}
