import { z } from 'zod';

/**
 * Settings & backup (M6, PLAN §9, §14.12): the "Download everything" export, nightly backup runs
 * reported by GitHub Actions, restore drills, the alarms panel and the recycle bin.
 */

// ---- Download everything ----------------------------------------------------------------------

/**
 * Never exported: sign-in sessions (live credentials) and the parent-link access log (hashed IPs and
 * user agents of parents' phones). Everything else is the school's own data and goes in the ZIP.
 */
export const EXPORT_EXCLUDED_TABLES = ['user_session', 'parent_link_access'] as const;

/**
 * Columns left out of a table's CSV. `parent_link.token_salt` is what a live link is made from (with
 * PARENT_LINK_SECRET): the export carries only the hashes (token_hash, pin_hash).
 */
export const EXPORT_REDACTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  parent_link: ['token_salt'],
};

/** Rows per part: one bounded read per request on the free plan (PLAN §15 budget rule). */
export const EXPORT_PART_ROWS = 200;

export type ExportCell = string | number | null;

export type ExportJobDto = {
  id: string;
  created_at: string;
  /** Tables in export order, one CSV each. */
  tables: string[];
  /** `CREATE …` statements from sqlite_master (tables, indexes, triggers, views), for schema.sql. */
  schema: string;
};

export type ExportPartDto = {
  table: string;
  columns: string[];
  rows: ExportCell[][];
  /** Cursor for the next part (pass as `after`); null = this table is done. */
  next: number | null;
};

export const exportFinishSchema = z.object({
  rows: z.number().int().min(0),
  files: z.number().int().min(0),
});

// ---- Backup runs and drills -----------------------------------------------------------------

export const BACKUP_RUN_KINDS = ['nightly', 'drill', 'manual_drill'] as const;
export type BackupRunKind = (typeof BACKUP_RUN_KINDS)[number];
export const BACKUP_RUN_STATUSES = ['ok', 'partial', 'failed'] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

const isoish = z.string().min(10).max(40);

/** What the nightly and restore-drill workflows POST to /api/backup/runs (BACKUP_REPORT_TOKEN). */
export const backupRunInputSchema = z.object({
  kind: z.enum(['nightly', 'drill']),
  status: z.enum(BACKUP_RUN_STATUSES),
  started_at: isoish.optional(),
  finished_at: isoish.optional(),
  object_key: z.string().max(300).optional(),
  bytes: z.number().int().min(0).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  targets: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        ok: z.boolean(),
        detail: z.string().max(300).optional(),
      }),
    )
    .max(10)
    .optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  run_url: z.string().url().max(300).optional(),
  note: z.string().max(1000).optional(),
});
export type BackupRunInput = z.infer<typeof backupRunInputSchema>;

/** The owner's "restore drill done on <date>" record. */
export const manualDrillSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(1000).optional(),
});

export type BackupRunDto = {
  id: string;
  kind: BackupRunKind;
  status: BackupRunStatus;
  started_at: string | null;
  finished_at: string;
  object_key: string | null;
  bytes: number | null;
  sha256: string | null;
  targets: { name: string; ok: boolean; detail?: string }[];
  details: Record<string, unknown> | null;
  run_url: string | null;
  note: string | null;
  created_by_name: string | null;
};

export type BackupObjectDto = { key: string; size: number; uploaded: string };

export type BackupStatusDto = {
  last_nightly: BackupRunDto | null;
  last_drill: BackupRunDto | null;
  runs: BackupRunDto[];
  /** Newest first, at most 10; null when the Worker has no BACKUPS binding. */
  objects: BackupObjectDto[] | null;
  objects_error: string | null;
  /** D1 Time Travel window on the free plan. */
  time_travel_days: number;
  /** BACKUP_REPORT_TOKEN is set on the Worker (the nightly job can report). */
  report_configured: boolean;
};

// ---- Alarms ----------------------------------------------------------------------------------

export const ALARM_KINDS = [
  'ledger_consistency',
  'messages_stuck',
  'messages_failed',
  'gate_lockouts',
  'billing_attention',
] as const;
export type AlarmKind = (typeof ALARM_KINDS)[number];

/** Thresholds, shared with the copy on the alarms panel. */
export const ALARM_RULES = {
  /** A queued message older than this many days is stuck. */
  stuckDays: 3,
  /** Failed messages counted over this many days. */
  failedDays: 7,
  /** Parent-page gate lockouts counted over this many hours. */
  lockoutHours: 24,
} as const;

export type AlarmDto = {
  kind: AlarmKind;
  count: number;
  /** A few examples (ids and a short label) to start looking from; never personal data. */
  sample: { id: string | null; label: string }[];
};

export type AlarmsDto = {
  at: string;
  /** Number of alarm kinds that fired (count > 0). */
  total: number;
  alarms: AlarmDto[];
};

export type AlarmEventDto = {
  day: string;
  at: string;
  total: number;
  alarms: AlarmDto[];
  acknowledged_at: string | null;
};

// ---- Recycle bin, retention ---------------------------------------------------------------------

export const RECYCLE_KINDS = ['programme', 'subject', 'fee_head', 'group'] as const;
export type RecycleKind = (typeof RECYCLE_KINDS)[number];

export type RecycleItemDto = {
  kind: RecycleKind;
  id: string;
  name: string;
  removed_at: string;
};

export type RecycleBinDto = { items: RecycleItemDto[] };

export const RETENTION_LIMITS = { min: 7, max: 3650 } as const;

export const retentionSchema = z.object({
  access_log_days: z.number().int().min(RETENTION_LIMITS.min).max(RETENTION_LIMITS.max),
});

export type RetentionDto = { access_log_days: number };

// ---- About -------------------------------------------------------------------------------------

export const ABOUT = {
  repo: 'https://github.com/faysalmehmood/maktab',
  contact: 'maktab@conceptlix.com',
  licence: 'AGPL-3.0-only',
} as const;
