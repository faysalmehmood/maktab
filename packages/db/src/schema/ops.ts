import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { nowIso } from './common';

/**
 * Operations tables (M6: settings & backup). Statuses and kinds here are validated by the API, not by
 * CHECKs, so a new value never forces a table rebuild (PLAN §15 schema-enum rule).
 */

/**
 * One owner "Download everything" (PLAN §9 layer 5). The browser pulls the tables part by part
 * (GET /api/backup/export/:id/part) and builds the ZIP itself; the Worker never holds the whole file.
 * `tables` is the JSON list fixed when the job was created; parts outside it are refused.
 */
export const exportJob = sqliteTable(
  'export_job',
  {
    id: text('id').primaryKey(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: text('created_at').notNull().default(nowIso),
    tables: text('tables').notNull(),
    finishedAt: text('finished_at'),
    /** Reported by the browser at the end (rows written into the ZIP, file count). */
    rowCount: integer('row_count'),
    fileCount: integer('file_count'),
  },
  (t) => [index('export_job_created').on(t.createdAt)],
);

/**
 * A backup run reported by GitHub Actions (POST /api/backup/runs, BACKUP_REPORT_TOKEN), or a restore
 * drill: `kind` 'nightly' | 'drill' (the restore-drill workflow) | 'manual_drill' (the owner's
 * "drill done on <date>" record). `status` 'ok' | 'partial' | 'failed'. `targets` JSON
 * `[{name, ok, key?}]`; `details` JSON (counts, verify output, errors).
 */
export const backupRun = sqliteTable(
  'backup_run',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at').notNull().default(nowIso),
    objectKey: text('object_key'),
    bytes: integer('bytes'),
    sha256: text('sha256'),
    targets: text('targets'),
    details: text('details'),
    runUrl: text('run_url'),
    note: text('note'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: text('created_at').notNull().default(nowIso),
  },
  (t) => [index('backup_run_kind').on(t.kind, t.finishedAt)],
);

/**
 * The daily alarm pass (Worker cron, after 03:00 Asia/Karachi): one row per Karachi day, written
 * even when nothing fired (`total` 0) so the pass runs once a day. `alarms` JSON is the AlarmsDto
 * list; a non-zero total shows the owner's dashboard banner until acknowledged.
 */
export const alarmEvent = sqliteTable('alarm_event', {
  day: text('day').primaryKey(),
  at: text('at').notNull().default(nowIso),
  total: integer('total').notNull(),
  alarms: text('alarms').notNull(),
  /** Retention clean-up done in the same pass (rows deleted), for the log. */
  cleanup: text('cleanup'),
  acknowledgedAt: text('acknowledged_at'),
  acknowledgedBy: text('acknowledged_by').references(() => user.id),
});
