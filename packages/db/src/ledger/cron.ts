import type { AppDb } from '../client';
import { applyLateFines, type FinesResult } from './fines';
import {
  failedChunkStatements,
  type GenerateResult,
  generateCharges,
  generationCursor,
} from './generate';
import { errorCode, feeSettings, karachiToday, periodOf, rootMessage, runBatch } from './util';

/**
 * The scheduled job (PLAN §8 Workers cron, §14.5). Runs every 30 minutes; each invocation does at
 * most `maxChunks` chunks (one batch each), so it stays inside the free plan's per-invocation
 * budget, and resumes where the last one stopped (cursor = billing_chunk rows):
 *   1. generate the current Karachi month, group by group, until every group has a finished chunk
 *      ("catch-up": a missed 1st is finished by the next invocation, any day of the month);
 *   2. apply late fines to every overdue tuition root of any period (due date passed), oldest first,
 *      200 roots per chunk, until none remain.
 * Both steps are idempotent; nothing runs before the setup wizard is finished.
 *
 * It never sticks and never starves (M3a closing pass): a group whose chunk throws is logged as a
 * failed chunk (status 'failed', error code, `fail_streak`, `retry_after`) and skipped for the rest of
 * the tick. Healthy and unattempted groups always go first and failing groups last; a failure does
 * not use the tick's budget (`maxChunks` counts successful chunks; `maxFailures` separately bounds the
 * failed attempts per tick, so one tick stays within the D1 query budget). After its n-th consecutive
 * failure a group waits 2^n ticks (capped at 24 h) before it is retried; at 3 in a row it is
 * `attention_required` (GET /api/fees/runs `failing`, dashboard `billing_alerts`). The other groups and
 * the fines always run.
 */
export type CronReport = {
  today: string;
  period: string;
  skipped?: 'setup_incomplete';
  generated: Pick<GenerateResult, 'grp_id' | 'counts' | 'group_done' | 'next_student_id'>[];
  failed: { grp_id: string; code: string; message: string }[];
  fines: Pick<FinesResult, 'applied' | 'done'>[];
};

/**
 * One group chunk; on failure the chunk is logged as failed and the error returned instead of thrown
 * (shared by the cron and the "Generate" button so neither can stick on one group).
 */
export async function generateChunkOrLog(
  db: AppDb,
  input: {
    period: string;
    grpId: string;
    afterStudentId: string | null;
    by: string | null;
    proRata?: boolean;
    /** Clock for the backoff window (ms since epoch); default Date.now(). */
    now?: number;
    /** Row budget for the chunk (default 200); the demo seed uses a smaller one for the CPU limit. */
    maxRows?: number;
  },
): Promise<{ ok: true; result: GenerateResult } | { ok: false; code: string; message: string }> {
  try {
    const result = await generateCharges(db, {
      period: input.period,
      scope: { grpId: input.grpId, afterStudentId: input.afterStudentId },
      by: input.by,
      proRata: input.proRata,
      maxRows: input.maxRows,
    });
    return { ok: true, result };
  } catch (err) {
    const code = errorCode(err);
    const message = rootMessage(err).replace(/\s+/g, ' ').slice(0, 500);
    try {
      await runBatch(
        db,
        failedChunkStatements({
          period: input.period,
          grpId: input.grpId,
          afterStudentId: input.afterStudentId,
          code,
          message,
          by: input.by,
          now: new Date(input.now ?? Date.now()).toISOString(),
        }),
      );
    } catch (logErr) {
      console.error('could not log failed billing chunk', logErr);
    }
    return { ok: false, code, message };
  }
}

export async function runScheduled(
  db: AppDb,
  o: { now?: number; maxChunks?: number; maxFailures?: number } = {},
): Promise<CronReport> {
  const nowMs = o.now ?? Date.now();
  const today = karachiToday(nowMs);
  const period = periodOf(today);
  const report: CronReport = { today, period, generated: [], failed: [], fines: [] };
  const settings = await feeSettings(db);
  if (!settings.setupCompleted) return { ...report, skipped: 'setup_incomplete' };
  const maxChunks = o.maxChunks ?? 3;
  const maxFailures = o.maxFailures ?? 3;
  const nowIso = new Date(nowMs).toISOString();
  const failed: string[] = [];
  let successes = 0;
  while (successes < maxChunks && failed.length < maxFailures) {
    const cur = await generationCursor(db, period, { exclude: failed, now: nowIso });
    if (!cur) break;
    const r = await generateChunkOrLog(db, {
      period,
      grpId: cur.grp_id,
      afterStudentId: cur.after_student_id,
      by: null,
      now: nowMs,
    });
    if (!r.ok) {
      failed.push(cur.grp_id);
      report.failed.push({ grp_id: cur.grp_id, code: r.code, message: r.message });
      console.error(
        JSON.stringify({ cron_chunk_failed: { period, grp_id: cur.grp_id, code: r.code } }),
      );
      continue;
    }
    successes++;
    report.generated.push({
      grp_id: r.result.grp_id,
      counts: r.result.counts,
      group_done: r.result.group_done,
      next_student_id: r.result.next_student_id,
    });
  }
  const budget = maxChunks - successes;
  // Fines run whatever happened above (a failed group must not hold back everyone else's fines):
  // every overdue tuition root of any period up to this month (its due date is the grace day), so a
  // month the cron missed is still fined; at least one fines chunk per tick.
  const rule = settings.fineRule;
  if (rule?.enabled) {
    let fineBudget = Math.max(1, budget);
    while (fineBudget > 0) {
      fineBudget--;
      try {
        const f = await applyLateFines(db, { asOf: today, by: null });
        report.fines.push({ applied: f.applied, done: f.done });
        if (f.done || f.applied === 0) break;
      } catch (err) {
        console.error('cron fines failed', err);
        break;
      }
    }
  }
  return report;
}
