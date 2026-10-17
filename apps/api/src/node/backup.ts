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
 * The self-hosted nightly backup (docs/self-host.md §7, PLAN §9 layer 2 on the homelab):
 *
 * 1. SQLite's online backup API (`db.backup()`) copies the live database to `DATA_DIR/tmp/`, a
 *    consistent snapshot while the app keeps serving (no lock held for the whole copy).
 * 2. gzip -9, then age-encrypted to `AGE_RECIPIENT` (the same `age1…` public key the GitHub workflow
 *    encrypts to; the private key stays with the trustees). Unencrypted (`.sqlite.gz`) only when the
 *    owner set ALLOW_UNENCRYPTED_BACKUPS=1 (the server refuses to start otherwise).
 * 3. Written atomically to the BACKUPS store as `daily/<Karachi date>.sqlite.gz.age` plus a
 *    `sha256sum`-format `.sha256`; the first backup of a month is also copied to `monthly/`.
 * 4. daily/ files older than 95 days are pruned (like the R2 lifecycle rule); monthly/ is kept.
 * 5. The run is recorded with `recordBackupRun`, the function behind `POST /api/backup/runs`, so
 *    Settings → Backup shows "Last nightly backup" and the alarms see it. Status `ok` only when the
 *    host's off-site copy (rclone from the host's cron, docs/self-host.md §7) confirmed itself in the
 *    last 48 hours through the `OFFSITE_OK` marker it writes into the backups folder; otherwise
 *    `partial` with the note "no off-site copy"; `failed` (with the error) when a step fails.
 *
 * The plain snapshot never leaves DATA_DIR/tmp and is deleted in every case.
 */

export const DAILY_KEEP_DAYS = 95;
/** The host's off-site copy counts while its marker is at most this old. */
export const OFFSITE_FRESH_MS = 48 * 3_600_000;
/** Written by the host's cron after a successful `rclone copy` (first token: an ISO timestamp). */
export const OFFSITE_MARKER = 'OFFSITE_OK';

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

/** age recipients are bech32 (`age1…`, lower case); the real check is an encryption (below). */
const RECIPIENT_RE = /^age1[0-9a-z]{20,200}$/;

/**
 * Throws unless `recipient` is a usable age recipient: the right shape and one byte actually
 * encrypts to it. Run at start, so a typo stops the server instead of failing every night.
 */
export async function checkAgeRecipient(recipient: string): Promise<void> {
  if (!RECIPIENT_RE.test(recipient))
    throw new Error('AGE_RECIPIENT is not an age public key (age1…)');
  try {
    const e = new Encrypter();
    e.addRecipient(recipient);
    await e.encrypt(Uint8Array.of(0));
  } catch {
    throw new Error('AGE_RECIPIENT is not a valid age public key (encryption to it failed)');
  }
}

export type SnapshotDeps = {
  sqlite: Database.Database;
  backups: DirBucket;
  /** DATA_DIR/tmp: the plain snapshot, on the same volume, never inside the BACKUPS store. */
  tmpDir: string;
  /** Empty = unencrypted (only with ALLOW_UNENCRYPTED_BACKUPS=1, enforced at start). */
  ageRecipient?: string;
};

export type Snapshot = {
  key: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  encrypted: boolean;
};

let warnedUnencrypted = false;

/**
 * One consistent copy of the live database, gzip'd and (normally) age-encrypted, stored atomically
 * at `<base>.sqlite.gz[.age]` with a `.sha256` next to it. The nightly backup and the pre-migration
 * backup both use this.
 */
export async function encryptedSnapshot(deps: SnapshotDeps, base: string): Promise<Snapshot> {
  const recipient = deps.ageRecipient?.trim() || '';
  const encrypted = recipient !== '';
  if (!encrypted && !warnedUnencrypted) {
    warnedUnencrypted = true;
    console.warn(
      '[maktab] ALLOW_UNENCRYPTED_BACKUPS=1 and no AGE_RECIPIENT: backups are stored UNENCRYPTED',
    );
  }
  mkdirSync(deps.tmpDir, { recursive: true, mode: 0o700 });
  const snapshot = join(
    deps.tmpDir,
    `snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  try {
    await deps.sqlite.backup(snapshot);
    const gz = await gzip(await readFile(snapshot), { level: 9 });
    let out: Uint8Array = gz;
    if (encrypted) {
      const e = new Encrypter();
      e.addRecipient(recipient);
      out = await e.encrypt(gz);
    }
    const sha256 = createHash('sha256').update(out).digest('hex');
    const key = `${base}.sqlite.gz${encrypted ? '.age' : ''}`;
    const name = key.slice(key.lastIndexOf('/') + 1);
    await deps.backups.put(key, out, {
      httpMetadata: { contentType: encrypted ? 'application/octet-stream' : 'application/gzip' },
    });
    await deps.backups.put(`${key}.sha256`, `${sha256}  ${name}\n`, {
      httpMetadata: { contentType: 'text/plain' },
    });
    return { key, bytes: out, size: out.byteLength, sha256, encrypted };
  } finally {
    await rm(snapshot, { force: true }).catch(() => {});
    await rm(`${snapshot}-journal`, { force: true }).catch(() => {});
  }
}

export type BackupDeps = SnapshotDeps & {
  db: AppDb;
  /** The off-site target's name for the notes (the host's rclone remote; the copy runs on the host). */
  rcloneRemote?: string;
  now?: () => number;
  log?: (msg: string) => void;
};

export type BackupResult = {
  status: 'ok' | 'partial' | 'failed';
  key: string | null;
  bytes: number;
  sha256: string | null;
  encrypted: boolean;
  monthly: string | null;
  offsite: boolean;
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

/** When the host last confirmed an off-site copy (OFFSITE_OK), or null. */
export async function offsiteConfirmedAt(backups: DirBucket): Promise<number | null> {
  try {
    const obj = await backups.get(OFFSITE_MARKER);
    if (!obj) return null;
    const first = (await obj.text()).trim().split(/\s+/)[0] ?? '';
    const at = Date.parse(first);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Short and single-line: only the message, never a stack or a path list. */
const errText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);

export async function runLocalBackup(deps: BackupDeps): Promise<BackupResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  const startedAt = new Date(now()).toISOString();
  const day = karachiDay(now());
  const result: BackupResult = {
    status: 'failed',
    key: null,
    bytes: 0,
    sha256: null,
    encrypted: Boolean(deps.ageRecipient?.trim()),
    monthly: null,
    offsite: false,
    pruned: [],
    runId: null,
  };
  try {
    const snap = await encryptedSnapshot(deps, `daily/${day}`);
    result.key = snap.key;
    result.bytes = snap.size;
    result.sha256 = snap.sha256;
    // The month's first backup goes to monthly/ (not only on the 1st: a server that was down on
    // the 1st still keeps one per month).
    const month = day.slice(0, 7);
    const have = await deps.backups.list({ prefix: `monthly/${month}-`, limit: 10 });
    if (!have.objects.some((o) => !o.key.endsWith('.sha256'))) {
      const name = snap.key.slice('daily/'.length);
      await deps.backups.put(`monthly/${name}`, snap.bytes, {
        httpMetadata: {
          contentType: snap.encrypted ? 'application/octet-stream' : 'application/gzip',
        },
      });
      await deps.backups.put(`monthly/${name}.sha256`, `${snap.sha256}  ${name}\n`, {
        httpMetadata: { contentType: 'text/plain' },
      });
      result.monthly = `monthly/${name}`;
    }
    result.pruned = await pruneDaily(deps.backups, day);
    const confirmed = await offsiteConfirmedAt(deps.backups);
    result.offsite = confirmed !== null && confirmed >= now() - OFFSITE_FRESH_MS;
    result.status = result.offsite ? 'ok' : 'partial';
  } catch (err) {
    result.error = errText(err);
    console.error(`[maktab] nightly backup failed: ${result.error}`);
  }

  const remote = deps.rcloneRemote ? ` (${deps.rcloneRemote.slice(0, 60)})` : '';
  const offsiteTarget = result.offsite
    ? { name: 'offsite', ok: true, detail: `confirmed by the host${remote}` }
    : {
        name: 'offsite',
        ok: false,
        detail: deps.rcloneRemote
          ? `no off-site copy confirmed in 48 h${remote}`
          : 'no off-site copy (BACKUP_RCLONE_REMOTE not set)',
      };
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
            ...(result.encrypted ? {} : { detail: 'not encrypted (ALLOW_UNENCRYPTED_BACKUPS=1)' }),
          }
        : { name: 'local', ok: false, detail: result.error ?? 'failed' },
      offsiteTarget,
    ],
    details: {
      backup_enabled: true,
      self_hosted: true,
      encrypted: result.encrypted,
      offsite: result.offsite,
      pruned: result.pruned.length,
    },
    note: result.error
      ? `self-hosted backup failed: ${result.error}`
      : result.offsite
        ? 'self-hosted: local copy, off-site copy confirmed by the host'
        : 'self-hosted: local copy only, no off-site copy',
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
        monthly: result.monthly,
        offsite: result.offsite,
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
