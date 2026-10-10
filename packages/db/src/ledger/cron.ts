import type { AppDb } from '../client';
import { applyLateFines, type FinesResult } from './fines';
import {
  failedChunkStatements,
  type GenerateResult,
  generateCharges,
  generationCursor,
} from './generate';
import {
  dayOf,
  errorCode,
  feeSettings,
  karachiToday,
  periodOf,
  rootMessage,
  runBatch,
} from './util';

/**
 * The scheduled job (PLAN §8 Workers cron, §14.5). Runs every 30 minutes; each invocation does at
 * most `maxChunks` chunks (one batch each), so it stays inside the free plan's per-invocation
 * budget, and resumes where the last one stopped (cursor = billing_chunk rows):
 *   1. generate the current Karachi month, group by group, until every group has a finished chunk
 *      ("catch-up": a missed 1st is finished by the next invocation, any day of the month);
 *   2. after the grace day, apply late fines for the month, 200 roots per chunk, until none remain.
 * Both steps are idempotent; nothing runs before the setup wizard is finished.
 *
 * It never sticks (M3 fix pass): a group whose chunk throws is logged as a failed chunk (status
 * 'failed', error code), skipped for the rest of this tick, and retried on the next one; the other
 * groups and the fines still run.
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
  },
): Promise<{ ok: true; result: GenerateResult } | { ok: false; code: string; message: string }> {
  try {
    const result = await generateCharges(db, {
      period: input.period,
      scope: { grpId: input.grpId, afterStudentId: input.afterStudentId },
      by: input.by,
      proRata: input.proRata,
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
  o: { now?: number; maxChunks?: number } = {},
): Promise<CronReport> {
  const today = karachiToday(o.now);
  const period = periodOf(today);
  const report: CronReport = { today, period, generated: [], failed: [], fines: [] };
  const settings = await feeSettings(db);
  if (!settings.setupCompleted) return { ...report, skipped: 'setup_incomplete' };
  let budget = o.maxChunks ?? 3;
  const failed: string[] = [];
  while (budget > 0) {
    const cur = await generationCursor(db, period, { exclude: failed });
    if (!cur) break;
    budget--;
    const r = await generateChunkOrLog(db, {
      period,
      grpId: cur.grp_id,
      afterStudentId: cur.after_student_id,
      by: null,
    });
    if (!r.ok) {
      failed.push(cur.grp_id);
      report.failed.push({ grp_id: cur.grp_id, code: r.code, message: r.message });
      console.error(
        JSON.stringify({ cron_chunk_failed: { period, grp_id: cur.grp_id, code: r.code } }),
      );
      continue;
    }
    report.generated.push({
      grp_id: r.result.grp_id,
      counts: r.result.counts,
      group_done: r.result.group_done,
      next_student_id: r.result.next_student_id,
    });
  }
  // Fines run whatever happened above (a failed group must not hold back everyone else's fines);
  // at least one fines chunk per tick once the grace day has passed.
  const rule = settings.fineRule;
  if (rule?.enabled && today > dayOf(period, rule.grace_day)) {
    let fineBudget = Math.max(1, budget);
    while (fineBudget > 0) {
      fineBudget--;
      try {
        const f = await applyLateFines(db, { period, asOf: today, by: null });
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
