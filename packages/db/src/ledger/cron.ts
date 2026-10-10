import type { AppDb } from '../client';
import { applyLateFines, type FinesResult } from './fines';
import { type GenerateResult, generateCharges, generationCursor } from './generate';
import { dayOf, feeSettings, karachiToday, periodOf } from './util';

/**
 * The scheduled job (PLAN §8 Workers cron, §14.5). Runs every 30 minutes; each invocation does at
 * most `maxChunks` chunks (one batch each), so it stays inside the free plan's per-invocation
 * budget, and resumes where the last one stopped (cursor = billing_chunk rows):
 *   1. generate the current Karachi month, group by group, until every group has a finished chunk
 *      ("catch-up": a missed 1st is finished by the next invocation, any day of the month);
 *   2. after the grace day, apply late fines for the month, 200 roots per chunk, until none remain.
 * Both steps are idempotent; nothing runs before the setup wizard is finished.
 */
export type CronReport = {
  today: string;
  period: string;
  skipped?: 'setup_incomplete';
  generated: Pick<GenerateResult, 'grp_id' | 'counts' | 'group_done' | 'next_student_id'>[];
  fines: Pick<FinesResult, 'applied' | 'done'>[];
};

export async function runScheduled(
  db: AppDb,
  o: { now?: number; maxChunks?: number } = {},
): Promise<CronReport> {
  const today = karachiToday(o.now);
  const period = periodOf(today);
  const report: CronReport = { today, period, generated: [], fines: [] };
  const settings = await feeSettings(db);
  if (!settings.setupCompleted) return { ...report, skipped: 'setup_incomplete' };
  let budget = o.maxChunks ?? 3;
  while (budget > 0) {
    const cur = await generationCursor(db, period);
    if (!cur) break;
    const r = await generateCharges(db, {
      period,
      scope: { grpId: cur.grp_id, afterStudentId: cur.after_student_id },
      by: null,
    });
    report.generated.push({
      grp_id: r.grp_id,
      counts: r.counts,
      group_done: r.group_done,
      next_student_id: r.next_student_id,
    });
    budget--;
  }
  const rule = settings.fineRule;
  if (budget > 0 && rule?.enabled && today > dayOf(period, rule.grace_day)) {
    while (budget > 0) {
      const f = await applyLateFines(db, { period, asOf: today, by: null });
      report.fines.push({ applied: f.applied, done: f.done });
      budget--;
      if (f.done || f.applied === 0) break;
    }
  }
  return report;
}
