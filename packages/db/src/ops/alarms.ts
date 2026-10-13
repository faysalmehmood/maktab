import { ALARM_RULES, type AlarmDto, type AlarmsDto } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { failingGroups } from '../ledger/generate';
import { karachiToday, periodOf } from '../ledger/util';

/**
 * The alarms panel and the daily alarm pass (M6, PLAN §15 "M6 must remember"). Each check is one
 * bounded read; together ≈ 10 queries, so GET /api/alarms and the cron stay inside the free plan's
 * per-request budget. Samples carry ids and codes only, never names or phone numbers.
 */
const SAMPLE = 5;

const iso = (ms: number) => new Date(ms).toISOString();

export async function evaluateAlarms(db: AppDb, nowMs = Date.now()): Promise<AlarmsDto> {
  const alarms: AlarmDto[] = [];

  // 1. ledger_consistency (sql/30_ledger.sql): empty when healthy. Includes receipt number / series
  //    mismatches (receipt_no_format) and cash receipts outside a drawer session.
  const issues = await db.all<{ issue: string; n: number; receipt_id: string | null }>(sql`
    SELECT issue, count(*) AS n, min(receipt_id) AS receipt_id FROM ledger_consistency GROUP BY issue
    ORDER BY issue`);
  alarms.push({
    kind: 'ledger_consistency',
    count: issues.reduce((a, r) => a + Number(r.n), 0),
    sample: issues
      .slice(0, SAMPLE)
      .map((r) => ({ id: r.receipt_id, label: `${r.issue} × ${Number(r.n)}` })),
  });

  // 2. Messages queued for more than 3 days (nobody is working the send queue).
  const stuckBefore = iso(nowMs - ALARM_RULES.stuckDays * 86_400_000);
  const stuck = await db.all<{ template_key: string; n: number; id: string }>(sql`
    SELECT template_key, count(*) AS n, min(id) AS id FROM message
    WHERE status = 'queued' AND created_at < ${stuckBefore}
    GROUP BY template_key ORDER BY n DESC`);
  alarms.push({
    kind: 'messages_stuck',
    count: stuck.reduce((a, r) => a + Number(r.n), 0),
    sample: stuck.slice(0, SAMPLE).map((r) => ({ id: r.id, label: `${r.template_key} × ${r.n}` })),
  });

  // 3. Failed messages in the last 7 days (wa_api / sms adapters later; none on the manual queue).
  const failedSince = iso(nowMs - ALARM_RULES.failedDays * 86_400_000);
  const failed = await db.all<{ channel: string; n: number; id: string }>(sql`
    SELECT channel, count(*) AS n, min(id) AS id FROM message
    WHERE status = 'failed' AND created_at >= ${failedSince}
    GROUP BY channel ORDER BY n DESC`);
  alarms.push({
    kind: 'messages_failed',
    count: failed.reduce((a, r) => a + Number(r.n), 0),
    sample: failed.slice(0, SAMPLE).map((r) => ({ id: r.id, label: `${r.channel} × ${r.n}` })),
  });

  // 4. Parent-page gate lockouts in the last 24 h: a lock lasts 15 minutes from its last counted
  //    attempt, so "locked until" after (now − 24 h) means the lock happened within the window.
  const lockSince = iso(nowMs - ALARM_RULES.lockoutHours * 3_600_000);
  const locks = await db.all<{ id: string }>(sql`
    SELECT id FROM parent_link WHERE gate_locked_until IS NOT NULL AND gate_locked_until > ${lockSince}
    ORDER BY gate_locked_until DESC LIMIT 200`);
  alarms.push({
    kind: 'gate_lockouts',
    count: locks.length,
    sample: locks.slice(0, SAMPLE).map((r) => ({ id: r.id, label: 'parent_link' })),
  });

  // 5. Monthly fee generation needing attention (3+ failures in a row for a group, M3a).
  const billing = (await failingGroups(db, periodOf(karachiToday(nowMs)))).filter(
    (f) => f.attention_required,
  );
  alarms.push({
    kind: 'billing_attention',
    count: billing.length,
    sample: billing
      .slice(0, SAMPLE)
      .map((f) => ({ id: f.grp_id, label: `${f.error_code ?? 'error'} × ${f.fail_streak}` })),
  });

  // 6. Nightly backup stale or failing.
  alarms.push(await backupStale(db, nowMs));

  return { at: iso(nowMs), total: alarms.filter((a) => a.count > 0).length, alarms };
}

/**
 * backup_stale (two reads): fires when no nightly backup finished `ok`/`partial` within the last
 * 36 hours, or the latest nightly report is `failed`. Grace, so a school that has not set backups up
 * yet never sees it: silent until a successful nightly run exists at all AND the latest nightly report
 * says `details.backup_enabled = true` (nightly-backup.yml sends it on every run; a run only happens
 * while the repository variable BACKUP_ENABLED is true).
 */
export async function backupStale(db: AppDb, nowMs = Date.now()): Promise<AlarmDto> {
  const quiet: AlarmDto = { kind: 'backup_stale', count: 0, sample: [], since: null };
  const [good] = await db.all<{ id: string; finished_at: string }>(sql`
    SELECT id, finished_at FROM backup_run WHERE kind = 'nightly' AND status IN ('ok', 'partial')
    ORDER BY finished_at DESC, rowid DESC LIMIT 1`);
  if (!good) return quiet;
  const [latest] = await db.all<{
    id: string;
    status: string;
    finished_at: string;
    enabled: number | null;
  }>(sql`
    SELECT id, status, finished_at,
      CASE WHEN json_valid(details) THEN json_extract(details, '$.backup_enabled') END AS enabled
    FROM backup_run WHERE kind = 'nightly' ORDER BY finished_at DESC, rowid DESC LIMIT 1`);
  if (!latest || Number(latest.enabled) !== 1) return quiet;
  const goodAt = Date.parse(good.finished_at);
  const stale =
    !Number.isFinite(goodAt) || goodAt < nowMs - ALARM_RULES.backupStaleHours * 3_600_000;
  const failed = latest.status === 'failed';
  if (!stale && !failed) return { ...quiet, since: good.finished_at };
  return {
    kind: 'backup_stale',
    count: 1,
    since: good.finished_at,
    sample: [
      failed
        ? { id: latest.id, label: `failed ${latest.finished_at.slice(0, 16)}` }
        : { id: good.id, label: `last ok ${good.finished_at.slice(0, 16)}` },
    ],
  };
}

export type DailyOpsReport =
  | { day: string; skipped: 'before_03' | 'done' }
  | { day: string; total: number; cleanup: { access_log: number; export_jobs: number } };

/** Karachi hour (UTC+5, no DST). */
const karachiHour = (nowMs: number) => new Date(nowMs + 5 * 3_600_000).getUTCHours();

/** Export jobs (the owner's "Download everything") are kept this long, for the audit trail's sake. */
export const EXPORT_JOB_KEEP_DAYS = 30;

/**
 * Daily pass from the Worker cron (every 30 minutes; acts once per Karachi day from 03:00, after the
 * 02:30 nightly export has released the database). Idempotent: one `alarm_event` row per day (also
 * when nothing fired), checked first and inserted with ON CONFLICT DO NOTHING, so a repeated or
 * concurrent tick does nothing twice. If D1 is still busy (error 7500) the pass throws and the next
 * tick tries again. Also applies data retention: parent-link access log rows older than
 * `school.access_log_days`, export jobs older than 30 days (batches of 200 within a time budget).
 */
export async function runDailyOps(db: AppDb, o: { now?: number } = {}): Promise<DailyOpsReport> {
  const nowMs = o.now ?? Date.now();
  const day = karachiToday(nowMs);
  if (karachiHour(nowMs) < 3) return { day, skipped: 'before_03' };
  const [done] = await db.all<{ day: string }>(sql`SELECT day FROM alarm_event WHERE day = ${day}`);
  if (done) return { day, skipped: 'done' };

  const result = await evaluateAlarms(db, nowMs);
  const cleanup = await applyRetention(db, nowMs);
  await db.run(sql`INSERT INTO alarm_event (day, at, total, alarms, cleanup)
    VALUES (${day}, ${iso(nowMs)}, ${result.total}, ${JSON.stringify(result.alarms)}, ${JSON.stringify(cleanup)})
    ON CONFLICT(day) DO NOTHING`);
  return { day, total: result.total, cleanup };
}

/** Retention deletes this many rows per statement, and stops at either bound below. */
export const RETENTION_BATCH = 200;
/** Statements per table per pass: keeps the cron inside the 50-subrequest budget with the alarms. */
export const RETENTION_MAX_BATCHES = 8;
/** Wall-clock budget for the whole retention pass; what is left waits for tomorrow's pass. */
export const RETENTION_BUDGET_MS = 10_000;

/**
 * Deletes in batches of RETENTION_BATCH (`DELETE … RETURNING`, so the count is exact on D1 and on
 * better-sqlite3) until a batch comes back short, the batch cap is hit or the time budget runs out.
 */
async function deleteInBatches(
  db: AppDb,
  batch: () => ReturnType<typeof sql>,
  deadline: number,
  clock: () => number,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES && clock() < deadline; i++) {
    const rows = await db.all<{ id: string }>(batch());
    total += rows.length;
    if (rows.length < RETENTION_BATCH) break;
  }
  return total;
}

/** Data retention (Settings → Backup): deletes what has outlived its keep period. */
export async function applyRetention(
  db: AppDb,
  nowMs = Date.now(),
  o: { clock?: () => number; budgetMs?: number } = {},
): Promise<{ access_log: number; export_jobs: number }> {
  const clock = o.clock ?? Date.now;
  const deadline = clock() + (o.budgetMs ?? RETENTION_BUDGET_MS);
  const [school] = await db.all<{ access_log_days: number }>(
    sql`SELECT access_log_days FROM school ORDER BY created_at LIMIT 1`,
  );
  const keep = Number(school?.access_log_days ?? 90);
  const logCutoff = iso(nowMs - keep * 86_400_000);
  const jobCutoff = iso(nowMs - EXPORT_JOB_KEEP_DAYS * 86_400_000);
  const access_log = await deleteInBatches(
    db,
    () => sql`DELETE FROM parent_link_access WHERE id IN
      (SELECT id FROM parent_link_access WHERE at < ${logCutoff} LIMIT ${RETENTION_BATCH}) RETURNING id`,
    deadline,
    clock,
  );
  const export_jobs = await deleteInBatches(
    db,
    () => sql`DELETE FROM export_job WHERE id IN
      (SELECT id FROM export_job WHERE created_at < ${jobCutoff} LIMIT ${RETENTION_BATCH}) RETURNING id`,
    deadline,
    clock,
  );
  return { access_log, export_jobs };
}
