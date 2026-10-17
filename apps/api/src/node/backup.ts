import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import type { AppDb } from '@maktab/db';
import { type BackupRunInput, backupRunInputSchema } from '@maktab/shared';
import { Encrypter } from 'age-encryption';
import type Database from 'better-sqlite3';
import { recordBackupRun } from '../routes/backup';
import type { DirBucket } from './dir-bucket';

const gzip = promisify(gzipCb);

/**
 * The self-hosted nightly backup (docs/self-host.md, PLAN §9 layer 2 on the homelab):
 *
 * 1. SQLite's online backup API (`db.backup()`) copies the live database to `DATA_DIR/tmp/`, a
 *    consistent snapshot while the app keeps serving (no lock held for the whole copy).
 * 2. gzip -9, then age-encrypted to `AGE_RECIPIENT` (the same `age1…` public key the GitHub workflow
 *    encrypts to; the private key stays with the trustees). Without a recipient the file is stored
 *    unencrypted (`.sqlite.gz`) and a warning is logged once.
 * 3. Written atomically to the BACKUPS store as `daily/<Karachi date>.sqlite.gz.age` plus a
 *    `sha256sum`-format `.sha256`; on the 1st (Karachi) also `monthly/<date>…`.
 * 4. daily/ files older than 95 days are pruned (like the R2 lifecycle rule); monthly/ is kept.
 * 5. The run is recorded with `recordBackupRun`, the function behind `POST /api/backup/runs`, so
 *    Settings → Backup shows "Last nightly backup" and the backup_stale alarm knows it is running.
 *    Status `partial`: one copy on the same machine until an off-site copy exists (BACKUP_RCLONE_REMOTE,
 *    later); `failed` (with the error) when any step fails.
 *
 * The plain snapshot never leaves DATA_DIR/tmp and is deleted in every case.
 */

export const DAILY_KEEP_DAYS = 95;

/** Asia/Karachi is UTC+5 all year (no DST). */
const PKT_MS = 5 * 3_600_000;
export const karachiDay = (nowMs: number) => new Date(nowMs + PKT_MS).toISOString().slice(0, 10);

/** The next 02:30 Karachi (21:30 UTC) strictly after `nowMs`. */
export function nextBackupAt(nowMs: number): number {
  const d = new Date(nowMs);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21, 30);
  if (at <= nowMs) at += 86_400_000;
  return at;
}

/** Today's (Karachi) 02:30 has passed: `nowMs` is at or after it. */
export function backupDueToday(nowMs: number): boolean {
  const day = karachiDay(nowMs);
  const dueAt = Date.parse(`${day}T02:30:00+05:00`);
  return nowMs >= dueAt;
}

export type BackupDeps = {
  sqlite: Database.Database;
  db: AppDb;
  backups: DirBucket;
  /** DATA_DIR/tmp: the plain snapshot, on the same volume, never inside the BACKUPS store. */
  tmpDir: string;
  ageRecipient?: string;
  /** Later: an rclone remote for the off-site copy. Logged as "not configured" for now. */
  rcloneRemote?: string;
  now?: () => number;
  log?: (msg: string) => void;
};

let warnedUnencrypted = false;

export type BackupResult = {
  status: 'ok' | 'partial' | 'failed';
  key: string | null;
  bytes: number;
  sha256: string | null;
  encrypted: boolean;
  pruned: string[];
  runId: string | null;
  error?: string;
};

const dateOfKey = (key: string) =>
  /^(?:daily|monthly)\/(\d{4}-\d{2}-\d{2})\./.exec(key)?.[1] ?? null;

/** daily/ objects older than DAILY_KEEP_DAYS before `today` (Karachi date); monthly/ is never pruned. */
export async function pruneDaily(backups: DirBucket, today: string): Promise<string[]> {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - DAILY_KEEP_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { objects } = await backups.list({ prefix: 'daily/', limit: 1000 });
  const old = objects
    .map((o) => o.key)
    .filter((k) => {
      const d = dateOfKey(k);
      return d !== null && d < cutoff;
    });
  if (old.length) await backups.delete(old);
  return old;
}

/** Short, single-line, and never a path under DATA_DIR's secrets: only the message. */
const errText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);

export async function runLocalBackup(deps: BackupDeps): Promise<BackupResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  const startedAt = new Date(now()).toISOString();
  const day = karachiDay(now());
  const recipient = deps.ageRecipient?.trim() || '';
  const encrypted = recipient !== '';
  const name = `${day}.sqlite.gz${encrypted ? '.age' : ''}`;
  mkdirSync(deps.tmpDir, { recursive: true, mode: 0o700 });
  const snapshot = join(deps.tmpDir, `backup-${day}-${process.pid}.sqlite`);
  const result: BackupResult = {
    status: 'failed',
    key: null,
    bytes: 0,
    sha256: null,
    encrypted,
    pruned: [],
    runId: null,
  };
  try {
    if (!encrypted && !warnedUnencrypted) {
      warnedUnencrypted = true;
      console.warn(
        '[maktab] AGE_RECIPIENT is not set: nightly backups are stored UNENCRYPTED (docs/self-host.md)',
      );
    }
    await deps.sqlite.backup(snapshot);
    const gz = await gzip(await readFile(snapshot), { level: 9 });
    let out: Uint8Array = gz;
    if (encrypted) {
      const e = new Encrypter();
      e.addRecipient(recipient);
      out = await e.encrypt(gz);
    }
    const sha = createHash('sha256').update(out).digest('hex');
    const key = `daily/${name}`;
    await deps.backups.put(key, out, {
      httpMetadata: { contentType: encrypted ? 'application/octet-stream' : 'application/gzip' },
    });
    await deps.backups.put(`${key}.sha256`, `${sha}  ${name}\n`, {
      httpMetadata: { contentType: 'text/plain' },
    });
    if (day.endsWith('-01')) {
      await deps.backups.put(`monthly/${name}`, out, {
        httpMetadata: { contentType: encrypted ? 'application/octet-stream' : 'application/gzip' },
      });
      await deps.backups.put(`monthly/${name}.sha256`, `${sha}  ${name}\n`, {
        httpMetadata: { contentType: 'text/plain' },
      });
    }
    result.key = key;
    result.bytes = out.byteLength;
    result.sha256 = sha;
    result.pruned = await pruneDaily(deps.backups, day);
    result.status = 'partial';
  } catch (err) {
    result.error = errText(err);
    console.error(`[maktab] nightly backup failed: ${result.error}`);
  } finally {
    await rm(snapshot, { force: true }).catch(() => {});
    await rm(`${snapshot}-journal`, { force: true }).catch(() => {});
  }

  const input: BackupRunInput = backupRunInputSchema.parse({
    kind: 'nightly',
    status: result.status,
    started_at: startedAt,
    finished_at: new Date(now()).toISOString(),
    ...(result.key && result.sha256
      ? { object_key: result.key, sha256: result.sha256, bytes: result.bytes }
      : {}),
    targets: [
      result.key
        ? {
            name: 'local',
            ok: true,
            ...(encrypted ? {} : { detail: 'not encrypted (AGE_RECIPIENT unset)' }),
          }
        : { name: 'local', ok: false, detail: result.error ?? 'failed' },
      {
        name: 'offsite',
        ok: false,
        detail: deps.rcloneRemote ? 'not implemented yet' : 'not configured',
      },
    ],
    details: { backup_enabled: true, self_hosted: true, encrypted, pruned: result.pruned.length },
    note: result.error
      ? `self-hosted backup failed: ${result.error}`
      : 'self-hosted: local copy only (no off-site copy yet)',
  });
  try {
    result.runId = await recordBackupRun(deps.db, input);
  } catch (err) {
    console.error(`[maktab] could not record the backup run: ${errText(err)}`);
  }
  log(
    JSON.stringify({
      backup: {
        status: result.status,
        key: result.key,
        bytes: result.bytes,
        pruned: result.pruned.length,
      },
    }),
  );
  return result;
}

/** For tests: forget that the unencrypted warning was printed. */
export function resetBackupWarning(): void {
  warnedUnencrypted = false;
}
