import { type SQL, sql } from 'drizzle-orm';
import { type AppDb, atomic, rawStatement } from '../client';

/**
 * Small pieces every fee helper shares: periods (`YYYY-MM`), rupee rounding, the school's fee
 * settings, and the one-batch runner. Money is integer paisa throughout (PLAN §5).
 */

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FeeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(message);
    this.name = 'FeeError';
  }
}

export function assertPeriod(p: string): void {
  if (!PERIOD_RE.test(p)) throw new FeeError('invalid', 'period must be YYYY-MM', 400);
}

export const periodOf = (date: string): string => date.slice(0, 7);

export function daysInPeriod(p: string): number {
  const [y, m] = p.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const periodStart = (p: string): string => `${p}-01`;
export const periodEnd = (p: string): string => `${p}-${String(daysInPeriod(p)).padStart(2, '0')}`;

/** Day `d` of the period, clamped to its last day (a grace day of 28 always exists). */
export const dayOf = (p: string, d: number): string =>
  `${p}-${String(Math.min(Math.max(1, d), daysInPeriod(p))).padStart(2, '0')}`;

export function addPeriods(p: string, n: number): string {
  const [y, m] = p.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Whole days from a to b inclusive (ISO dates); 0 when b < a. */
export function daysInclusive(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return ms < 0 ? 0 : Math.round(ms / 86_400_000) + 1;
}

/** ISO date `n` days after `d` (negative = before). */
export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** A free-text reason compared for "same reason again": case, outer and repeated blanks ignored. */
export const normaliseReason = (s: string | null | undefined): string =>
  (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export const maxDate = (a: string, b: string): string => (a > b ? a : b);
export const minDate = (a: string, b: string): string => (a < b ? a : b);

/**
 * num/den paisa, rounded half-up to the whole rupee (PLAN: concessions and fines in rupees).
 * Integer arithmetic only; num and den must be ≥ 0 and den > 0.
 */
export function roundRupee(num: number, den: number): number {
  if (num <= 0) return 0;
  return Math.floor((2 * num + den * 100) / (2 * den * 100)) * 100;
}

/** "Today" for the school (Asia/Karachi is UTC+5, no DST). */
export const karachiToday = (now = Date.now()): string =>
  new Date(now + 5 * 3_600_000).toISOString().slice(0, 10);

export type FineRule = {
  enabled: boolean;
  /** 1–28: the monthly due day; fines apply from the next day. */
  grace_day: number;
  type: 'fixed' | 'pct';
  /** paisa (fixed) or percent of the remaining due (pct). */
  value: number;
  /** paisa; null = no cap. */
  cap: number | null;
};
export type SiblingRule = { nth: number; pct: number }[];

export const DEFAULT_DUE_DAY = 10;

export type FeeSettings = {
  schoolId: string | null;
  setupCompleted: boolean;
  fineRule: FineRule | null;
  siblingRule: SiblingRule;
  cooldownDays: number;
  receiptPrefix: string;
  /** Day of the month charges fall due (the fine rule's grace day, else the 10th). */
  dueDay: number;
};

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseFineRule(raw: string | null | undefined): FineRule | null {
  const v = parseJson(raw) as Partial<FineRule> | null;
  if (!v || typeof v !== 'object') return null;
  const grace = Number(v.grace_day);
  const value = Number(v.value);
  if (!Number.isInteger(grace) || grace < 1 || grace > 28) return null;
  if (v.type !== 'fixed' && v.type !== 'pct') return null;
  if (!Number.isInteger(value) || value < 0) return null;
  const cap = v.cap == null ? null : Number(v.cap);
  return {
    enabled: v.enabled === true,
    grace_day: grace,
    type: v.type,
    value,
    cap: cap != null && Number.isInteger(cap) && cap > 0 ? cap : null,
  };
}

export function parseSiblingRule(raw: string | null | undefined): SiblingRule {
  const v = parseJson(raw);
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (r): r is { nth: number; pct: number } =>
        !!r &&
        Number.isInteger(r.nth) &&
        r.nth >= 2 &&
        Number.isInteger(r.pct) &&
        r.pct >= 1 &&
        r.pct <= 100,
    )
    .sort((a, b) => a.nth - b.nth);
}

/** The pct the nth child of a family gets: the rule with the largest nth ≤ n (0 = none). */
export function siblingPct(rule: SiblingRule, n: number): number {
  let pct = 0;
  for (const r of rule) if (r.nth <= n) pct = r.pct;
  return pct;
}

export async function feeSettings(db: AppDb): Promise<FeeSettings> {
  const [row] = await db.all<{
    id: string;
    setup_completed_at: string | null;
    fine_rule: string | null;
    sibling_rule: string | null;
    reminder_cooldown_days: number;
    receipt_prefix: string | null;
  }>(sql`SELECT id, setup_completed_at, fine_rule, sibling_rule, reminder_cooldown_days, receipt_prefix
         FROM school ORDER BY created_at LIMIT 1`);
  const fineRule = parseFineRule(row?.fine_rule);
  return {
    schoolId: row?.id ?? null,
    setupCompleted: !!row?.setup_completed_at,
    fineRule,
    siblingRule: parseSiblingRule(row?.sibling_rule),
    cooldownDays: row?.reminder_cooldown_days ?? 7,
    receiptPrefix: row?.receipt_prefix || 'R',
    dueDay: fineRule?.grace_day ?? DEFAULT_DUE_DAY,
  };
}

/**
 * A stable code for an error that stopped a generation chunk (billing_chunk.error_code): a FeeError's
 * own code, else the kind of constraint that refused the batch.
 */
export function errorCode(err: unknown): string {
  if (err instanceof FeeError) return err.code;
  const codes: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') codes.push(c);
    e = e instanceof Error ? e.cause : undefined;
  }
  const text = `${errorText(err)} ${codes.join(' ')}`;
  if (/UNIQUE constraint failed: charge/.test(text)) return 'duplicate_charge';
  if (/UNIQUE constraint failed/.test(text)) return 'conflict';
  if (/FOREIGN KEY constraint failed/.test(text)) return 'foreign_key';
  if (/CHECK constraint failed|SQLITE_CONSTRAINT|RAISE|constraint/i.test(text)) return 'constraint';
  return 'internal';
}

/** One user action = one atomic batch (ADR 0001/0002). */
export async function runBatch(db: AppDb, stmts: SQL[]): Promise<void> {
  const [first, ...rest] = stmts;
  if (!first) return;
  await atomic(db, () => [rawStatement(db, first), ...rest.map((q) => rawStatement(db, q))]);
}

/** `col IN (SELECT value FROM json_each(?))` — one bound parameter however long the list. */
export const inJson = (col: SQL, values: readonly string[]): SQL =>
  sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

/**
 * `col IN (?, ?, …)`, one bound value each (≤ IN_LIST_MAX: D1 binds at most 100 a statement). Unlike
 * inJson, SQLite pushes this into an aggregate view (payer_credit) as index lookups; an
 * `IN (SELECT … json_each)` term makes it aggregate every payer first (D1 bills each row read).
 */
export const IN_LIST_MAX = 90;
export const inList = (col: SQL, values: readonly string[]): SQL =>
  sql`${col} IN (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;

/** The innermost cause's message: SQLite's own text, without drizzle's echo of the query. */
export function rootMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof Error) msg = e.message;
    e = e instanceof Error ? e.cause : undefined;
  }
  return msg;
}

/** Message text through the cause chain (drizzle wraps driver errors). */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return parts.join(' | ');
}

export const auditStatement = (o: {
  id: string;
  userId: string | null;
  entity: string;
  entityId: string;
  action: string;
  diff: unknown;
}): SQL => sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
  VALUES (${o.id}, ${o.userId}, ${o.entity}, ${o.entityId}, ${o.action}, ${JSON.stringify(o.diff)})`;
