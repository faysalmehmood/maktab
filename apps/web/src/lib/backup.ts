import {
  type AlarmEventDto,
  type AlarmsDto,
  type BackupStatusDto,
  type ExportJobDto,
  type ExportPartDto,
  hasGrant,
  type RecycleBinDto,
  type RetentionDto,
  type StaffRole,
  toCsvLine,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { getJson, sendJson } from './api';

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
    `Files: ${o.tables.length} tables (tables/<name>.csv, UTF-8 with BOM, opens in Excel or Google Sheets), schema.sql (the database structure), this README. Rows: ${o.rows}.`,
    '',
    'Keep this file safe: it holds every family, phone number and CNIC. Not included: sign-in sessions and the parent-page access log. Parent links appear only as hashes (no working link). Message texts carry a {link} placeholder.',
    'Amounts are in paisa (100 paisa = 1 rupee). Dates and times are UTC unless the column says otherwise.',
    'Cells that start with = + - @ are prefixed with an apostrophe so a spreadsheet never runs them.',
    'To rebuild a database, use the encrypted nightly backup (docs/restore.md); this ZIP is a readable copy.',
    '',
    'مکتب — مکمل ڈاؤن لوڈ ("سب کچھ ڈاؤن لوڈ کریں")',
    `فائلیں: ہر ٹیبل کی ایک CSV فائل (tables/ میں، ایکسل یا گوگل شیٹس میں کھلتی ہے)، schema.sql (ڈیٹا بیس کا ڈھانچہ) اور یہ README۔`,
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
  zip: Uint8Array;
  fileName: string;
  files: number;
  rows: number;
};

/**
 * "Download everything" (PLAN §9 layer 5): the Worker hands out ≤ 200 rows of one table per request;
 * the browser writes the formula-safe CSVs (@maktab/shared toCsvLine) and the ZIP (fflate), then
 * reports the totals so the export is audited. Nothing is stored server-side.
 */
export async function buildExport(
  onProgress: (p: ExportProgress) => void = () => {},
): Promise<ExportResult> {
  const job = await sendJson<ExportJobDto>('POST', '/api/backup/export');
  const files: Record<string, Uint8Array> = {};
  let rows = 0;
  for (const [i, table] of job.tables.entries()) {
    onProgress({ table, index: i + 1, total: job.tables.length, rows });
    const lines: string[] = [];
    let after = 0;
    for (;;) {
      const part = await getJson<ExportPartDto>(
        `/api/backup/export/${job.id}/part?table=${encodeURIComponent(table)}&after=${after}`,
      );
      if (!lines.length) lines.push(toCsvLine(part.columns));
      for (const r of part.rows) lines.push(toCsvLine(r));
      rows += part.rows.length;
      if (part.next === null) break;
      after = part.next;
    }
    // BOM: Excel's "CSV UTF-8", so Urdu names survive a double-click open.
    files[`tables/${table}.csv`] = utf8(`${BOM}${lines.join('\r\n')}\r\n`);
  }
  const at = new Date().toISOString();
  files['schema.sql'] = utf8(job.schema);
  files['README.txt'] = utf8(`${BOM}${readmeText({ at, tables: job.tables, rows })}`);
  // Loaded on demand: the dashboard (which imports this module for the alarm banner) stays light.
  const { zipSync } = await import('fflate');
  const zip = zipSync(files, { level: 6, mtime: new Date() });
  const count = Object.keys(files).length;
  await sendJson('POST', `/api/backup/export/${job.id}/finish`, { rows, files: count });
  return { zip, fileName: `maktab-export-${at.slice(0, 10)}.zip`, files: count, rows };
}

/** Hands the bytes to the browser as a file download. */
export function saveFile(bytes: Uint8Array, name: string, type = 'application/zip'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
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
