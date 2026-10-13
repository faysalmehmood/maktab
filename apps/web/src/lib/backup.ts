import {
  type AlarmDto,
  type AlarmEventDto,
  type AlarmsDto,
  type BackupStatusDto,
  type ExportJobDto,
  type ExportPartDto,
  formatDmy,
  hasGrant,
  type RecycleBinDto,
  type RetentionDto,
  type StaffRole,
  toCsvLine,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { ApiError, getJson, sendJson } from './api';

/** An alarm's plain-language hint; backup_stale names the day of the last good backup. */
export function alarmHint(t: TFunction, a: AlarmDto): string {
  return t(`backup.alarms.hints.${a.kind}`, {
    date: a.since ? formatDmy(a.since.slice(0, 10)) : '—',
  });
}

export const canManageBackup = (r: readonly StaffRole[]) => hasGrant(r, 'backup', 'manage');

export const useBackupStatus = () =>
  useQuery({
    queryKey: ['backup-status'],
    queryFn: () => getJson<BackupStatusDto>('/api/backup/status'),
  });

export const useAlarms = () =>
  useQuery({ queryKey: ['alarms'], queryFn: () => getJson<AlarmsDto>('/api/alarms') });

/** The dashboard banner reads the last daily pass (one row), never a live evaluation. */
export const useLatestAlarm = (enabled: boolean) =>
  useQuery({
    queryKey: ['alarms-latest'],
    queryFn: () => getJson<{ event: AlarmEventDto | null }>('/api/alarms/latest'),
    enabled,
  });

export const useRecycleBin = () =>
  useQuery({
    queryKey: ['recycle-bin'],
    queryFn: () => getJson<RecycleBinDto>('/api/recycle-bin'),
  });

export const useRetention = () =>
  useQuery({
    queryKey: ['retention'],
    queryFn: () => getJson<RetentionDto>('/api/settings/retention'),
  });

/** README.txt in the ZIP: what is inside, in English and Urdu. */
export function readmeText(o: { at: string; tables: string[]; rows: number }): string {
  return [
    'Maktab — full export ("Download everything")',
    `Made: ${o.at}`,
    `Files: ${o.tables.length} tables, one CSV each named after the table (tables/student.csv, tables/receipt.csv, …; UTF-8 with BOM, opens in Excel or Google Sheets), schema.sql (the database structure), this README. Rows: ${o.rows}.`,
    '',
    'Keep this file safe: it holds every family, phone number and CNIC. Not included: sign-in sessions, the parent-page access log and the database migration log (d1_migrations). Parent links appear only as hashes (no working link). Message texts carry a {link} placeholder.',
    'Amounts are in paisa (100 paisa = 1 rupee). Dates and times are UTC unless the column says otherwise.',
    "Formula guard: a text cell that starts with = + - or @ is written with a leading apostrophe ('=SUM(...) instead of =SUM(...)) so a spreadsheet shows it as text and never runs it. Remove that apostrophe if you load the CSV into a database.",
    'To rebuild a database, use the encrypted nightly backup (docs/restore.md); this ZIP is a readable copy.',
    '',
    'مکتب — مکمل ڈاؤن لوڈ ("سب کچھ ڈاؤن لوڈ کریں")',
    `فائلیں: ہر ٹیبل کی ایک CSV فائل، ٹیبل کے نام پر (مثلاً tables/student.csv، ایکسل یا گوگل شیٹس میں کھلتی ہے)، schema.sql (ڈیٹا بیس کا ڈھانچہ) اور یہ README۔`,
    "جو خانہ = + - یا @ سے شروع ہو اس کے آگے ' لگا ہوتا ہے تاکہ اسپریڈشیٹ اسے فارمولا سمجھ کر نہ چلائے۔",
    'اس فائل کو محفوظ رکھیں: اس میں ہر خاندان، فون نمبر اور شناختی کارڈ نمبر ہے۔ سائن اِن سیشن اور والدین کے صفحے کا رسائی ریکارڈ شامل نہیں۔ والدین کے لنک صرف ہیش کی صورت میں ہیں۔',
    'رقوم پیسوں میں ہیں (100 پیسے = 1 روپیہ)۔',
    '',
  ].join('\r\n');
}

/**
 * UTF-8 bytes in this realm's Uint8Array: fflate tells files from folders with `instanceof
 * Uint8Array`, which a TextEncoder result from another realm (jsdom) would fail.
 */
/** Byte-order mark: Excel's "CSV UTF-8", so Urdu names survive a double-click open. */
const BOM = String.fromCharCode(0xfeff);
const utf8 = (s: string) => new Uint8Array(new TextEncoder().encode(s));

export type ExportProgress = { table: string; index: number; total: number; rows: number };

export type ExportResult = {
  /** The ZIP, assembled from fflate's streamed output chunks (never one big in-memory copy). */
  blob: Blob;
  fileName: string;
  files: number;
  rows: number;
};

/** Attempts per export part: the first try plus up to three retries. */
export const PART_RETRIES = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Worth another try: no answer at all (offline, a dropped connection) or a server-side hiccup
 * (5xx, 429). A 4xx such as `export_expired` is a real answer and is never retried.
 */
const retryable = (err: unknown) =>
  !(err instanceof ApiError) || err.status >= 500 || err.status === 429;

/** Runs `fn`, retrying a transient failure up to `retries` times with doubling backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  o: { retries?: number; baseMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = o.retries ?? PART_RETRIES;
  const wait = o.wait ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !retryable(err)) throw err;
      await wait((o.baseMs ?? 1000) * 2 ** attempt);
    }
  }
}

/**
 * "Download everything" (PLAN §9 layer 5): the Worker hands out ≤ 200 rows of one table per request;
 * the browser writes the formula-safe CSVs (@maktab/shared toCsvLine) and streams them into the ZIP
 * part by part (fflate's streaming `Zip`), so only one part of text is held at a time; then it
 * reports the totals so the export is audited. Nothing is stored server-side. Each part is retried
 * up to 3 times (1 s, 2 s, 4 s) before the export gives up.
 */
export async function buildExport(
  onProgress: (p: ExportProgress) => void = () => {},
  o: { wait?: (ms: number) => Promise<void> } = {},
): Promise<ExportResult> {
  const job = await sendJson<ExportJobDto>('POST', '/api/backup/export');
  // Loaded on demand: the dashboard (which imports this module for the alarm banner) stays light.
  const { Zip, ZipDeflate } = await import('fflate');
  const chunks: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) zipError = err;
    else chunks.push(chunk);
  });
  const mtime = new Date();
  const open = (name: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    f.mtime = mtime;
    zip.add(f);
    return f;
  };
  let files = 0;
  let rows = 0;
  for (const [i, table] of job.tables.entries()) {
    onProgress({ table, index: i + 1, total: job.tables.length, rows });
    const file = open(`tables/${table}.csv`);
    let after = 0;
    let first = true;
    for (;;) {
      const part = await withRetry(
        () =>
          getJson<ExportPartDto>(
            `/api/backup/export/${job.id}/part?table=${encodeURIComponent(table)}&after=${after}`,
          ),
        { wait: o.wait },
      );
      const lines: string[] = [];
      // BOM: Excel's "CSV UTF-8", so Urdu names survive a double-click open.
      if (first) lines.push(`${BOM}${toCsvLine(part.columns)}`);
      first = false;
      for (const r of part.rows) lines.push(toCsvLine(r));
      if (lines.length) file.push(utf8(`${lines.join('\r\n')}\r\n`));
      rows += part.rows.length;
      if (part.next === null) break;
      after = part.next;
    }
    file.push(new Uint8Array(0), true);
    files++;
  }
  const at = new Date().toISOString();
  open('schema.sql').push(utf8(job.schema), true);
  open('README.txt').push(utf8(`${BOM}${readmeText({ at, tables: job.tables, rows })}`), true);
  files += 2;
  zip.end();
  if (zipError) throw zipError;
  await sendJson('POST', `/api/backup/export/${job.id}/finish`, { rows, files });
  return {
    blob: new Blob(chunks as BlobPart[], { type: 'application/zip' }),
    fileName: `maktab-export-${at.slice(0, 10)}.zip`,
    files,
    rows,
  };
}

/** Hands the bytes to the browser as a file download. */
export function saveFile(data: Blob | Uint8Array, name: string, type = 'application/zip'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

declare const __APP_VERSION__: string | undefined;
declare const __APP_COMMIT__: string | undefined;

/** Set by vite.config.ts `define` at build time; 'dev' in tests and plain dev. */
export const BUILD = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
  commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev',
};
