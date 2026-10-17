import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { type AppDb, atomic, rawStatement } from '@maktab/db';
import { applyD1Migrations, drizzleOver, openSqlite } from '@maktab/db/node';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupDueToday,
  encryptedSnapshot,
  karachiDay,
  nextBackupAt,
  OFFSITE_MARKER,
  pruneDaily,
  resetBackupWarning,
  runLocalBackup,
} from '../src/node/backup';
import { DirBucket, InvalidKeyError, keySegments } from '../src/node/dir-bucket';
import { startScheduler } from '../src/node/scheduler';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maktab-store-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('DirBucket (the R2 subset on a directory)', () => {
  it('put / get / head / delete with the content type kept in a sidecar', async () => {
    const b = new DirBucket(join(root, 'files'));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const put = await b.put('students/s1/p1', bytes, {
      httpMetadata: { contentType: 'image/png' },
    });
    expect(put.size).toBe(7);
    const head = await b.head('students/s1/p1');
    expect(head?.httpMetadata.contentType).toBe('image/png');
    const got = await b.get('students/s1/p1');
    expect(got?.httpMetadata.contentType).toBe('image/png');
    expect(new Uint8Array(await new Response(got?.body).arrayBuffer())).toEqual(bytes);
    // The response the app builds from it (lib/files.ts serveObject).
    const again = await b.get('students/s1/p1');
    expect(new Uint8Array((await again?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(bytes);
    // Overwrite without a type drops the old type.
    await b.put('students/s1/p1', 'text');
    expect((await b.head('students/s1/p1'))?.httpMetadata.contentType).toBeUndefined();
    expect(await (await b.get('students/s1/p1'))?.text()).toBe('text');
    await b.delete('students/s1/p1');
    expect(await b.get('students/s1/p1')).toBeNull();
    expect(await b.head('students/s1/p1')).toBeNull();
    expect(readdirSync(join(root, 'files/students/s1'))).toEqual([]);
    // Deleting a missing key is not an error (as on R2).
    await b.delete(['students/none', 'x']);
    expect(await b.get('never/was')).toBeNull();
  });

  it('list: prefix, sorted keys, limit + truncated, never sidecars or temp files', async () => {
    const b = new DirBucket(join(root, 'backups'));
    for (const k of [
      'daily/2026-10-02.x',
      'daily/2026-10-01.x',
      'monthly/2026-10-01.x',
      'dailyish',
    ])
      await b.put(k, k, { httpMetadata: { contentType: 'text/plain' } });
    writeFileSync(join(root, 'backups/daily/.abc.tmp'), 'partial');
    const all = await b.list();
    expect(all.objects.map((o) => o.key)).toEqual([
      'daily/2026-10-01.x',
      'daily/2026-10-02.x',
      'dailyish',
      'monthly/2026-10-01.x',
    ]);
    expect(all.objects[0]?.uploaded).toBeInstanceOf(Date);
    expect(all.objects[0]?.size).toBe('daily/2026-10-01.x'.length);
    expect((await b.list({ prefix: 'daily/' })).objects.map((o) => o.key)).toEqual([
      'daily/2026-10-01.x',
      'daily/2026-10-02.x',
    ]);
    expect((await b.list({ prefix: 'daily' })).objects).toHaveLength(3);
    expect((await b.list({ prefix: 'daily/2026-10-02' })).objects.map((o) => o.key)).toEqual([
      'daily/2026-10-02.x',
    ]);
    const one = await b.list({ limit: 1 });
    expect(one.objects).toHaveLength(1);
    expect(one.truncated).toBe(true);
    expect((await b.list({ prefix: 'nothing/' })).objects).toEqual([]);
  });

  it('refuses every key that could leave the root', async () => {
    const b = new DirBucket(join(root, 'files'));
    writeFileSync(join(root, 'outside'), 'secret');
    const bad = [
      '',
      '/etc/passwd',
      '../outside',
      'a/../../outside',
      'a/./b',
      'a//b',
      'a/',
      '.hidden',
      'a/.meta',
      'a\\..\\outside',
      'a\u0000b',
      'a\nb',
      'x'.repeat(1025),
    ];
    for (const k of bad) {
      expect(() => keySegments(k), JSON.stringify(k)).toThrow(InvalidKeyError);
      await expect(b.put(k, 'x'), JSON.stringify(k)).rejects.toThrow(InvalidKeyError);
      await expect(b.get(k)).rejects.toThrow(InvalidKeyError);
    }
    await expect(b.list({ prefix: '../' })).rejects.toThrow(InvalidKeyError);
    await expect(b.list({ prefix: '/etc' })).rejects.toThrow(InvalidKeyError);
    expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('secret');
    expect(keySegments('students/01J/01K')).toEqual(['students', '01J', '01K']);
    expect(keySegments('school/logo-01J')).toEqual(['school', 'logo-01J']);
  });

  it('never follows a symlink inside the root (file or directory) to read or write outside it', async () => {
    const b = new DirBucket(join(root, 'files'));
    mkdirSync(join(root, 'outside-dir'));
    writeFileSync(join(root, 'outside-dir/secret'), 'secret');
    writeFileSync(join(root, 'outside-file'), 'secret');
    symlinkSync(join(root, 'outside-file'), join(root, 'files/link'));
    symlinkSync(join(root, 'outside-dir'), join(root, 'files/dirlink'));
    expect(await b.get('link')).toBeNull();
    expect(await b.head('link')).toBeNull();
    expect(await b.get('dirlink/secret')).toBeNull();
    expect((await b.list()).objects.map((o) => o.key)).toEqual([]);
    await expect(b.put('dirlink/new', 'x')).rejects.toThrow(InvalidKeyError);
    expect(existsSync(join(root, 'outside-dir/new'))).toBe(false);
    await b.delete('dirlink/secret');
    expect(readFileSync(join(root, 'outside-dir/secret'), 'utf8')).toBe('secret');
    // Putting over the file symlink replaces the link itself, never its target.
    await b.put('link', 'mine');
    expect(readFileSync(join(root, 'outside-file'), 'utf8')).toBe('secret');
    expect(await (await b.get('link'))?.text()).toBe('mine');
  });

  it('writes atomically: a failed write leaves the old object and no temp file', async () => {
    const b = new DirBucket(join(root, 'files'));
    await b.put('a/b', 'old');
    // The target "a/b/c" needs "a/b" to be a directory: the write fails after the temp file.
    await expect(b.put('a/b/c', 'new')).rejects.toThrow();
    expect(await (await b.get('a/b'))?.text()).toBe('old');
    mkdirSync(join(root, 'files/d/target'), { recursive: true });
    // rename() over a directory fails: the temp file is removed, nothing else changes.
    await expect(b.put('d/target', 'x')).rejects.toThrow();
    expect(readdirSync(join(root, 'files/d')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(join(root, 'files/a'))).toEqual(['b']);
  });
});

function migratedDb(): { sqlite: Database.Database; db: AppDb } {
  const sqlite = openSqlite(join(root, 'maktab.sqlite'));
  applyD1Migrations(sqlite);
  return { sqlite, db: drizzleOver(sqlite) };
}

type RunRow = {
  kind: string;
  status: string;
  object_key: string;
  bytes: number;
  sha256: string;
  details: string;
  targets: string;
};

describe('nightly local backup', () => {
  it('snapshot -> gzip -> age, sha256, recorded like POST /api/backup/runs; decrypts to the database', async () => {
    const { sqlite, db } = migratedDb();
    try {
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS _probe (v TEXT); INSERT INTO _probe VALUES ('hello');",
      );
      const identity = await generateX25519Identity();
      const backups = new DirBucket(join(root, 'backups'));
      const now = Date.parse('2026-10-17T21:30:00Z'); // 02:30 on the 18th, Karachi
      const res = await runLocalBackup({
        sqlite,
        db,
        backups,
        tmpDir: join(root, 'tmp'),
        ageRecipient: await identityToRecipient(identity),
        now: () => now,
        log: () => {},
      });
      expect(res.status).toBe('partial');
      expect(res.key).toBe('daily/2026-10-18.sqlite.gz.age');
      const file = readFileSync(join(root, 'backups/daily/2026-10-18.sqlite.gz.age'));
      expect(file.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
      expect(
        readFileSync(join(root, 'backups/daily/2026-10-18.sqlite.gz.age.sha256'), 'utf8'),
      ).toBe(`${res.sha256}  2026-10-18.sqlite.gz.age\n`);
      const d = new Decrypter();
      d.addIdentity(identity);
      const plain = gunzipSync(await d.decrypt(new Uint8Array(file)));
      expect(plain.subarray(0, 15).toString()).toBe('SQLite format 3');
      // The plain snapshot never stays behind.
      expect(readdirSync(join(root, 'tmp'))).toEqual([]);
      // The month's first backup: also kept in monthly/ (not only on the 1st).
      expect(res.monthly).toBe('monthly/2026-10-18.sqlite.gz.age');
      expect(readFileSync(join(root, 'backups/monthly/2026-10-18.sqlite.gz.age'))).toEqual(file);
      // No OFFSITE_OK from the host: partial, and it says why.
      expect(res.offsite).toBe(false);
      const [run] = await db.all<RunRow>(sql`SELECT * FROM backup_run`);
      expect(run).toMatchObject({
        kind: 'nightly',
        status: 'partial',
        object_key: res.key,
        bytes: file.length,
        sha256: res.sha256,
      });
      expect(JSON.parse(run?.details ?? '{}')).toMatchObject({
        backup_enabled: true,
        encrypted: true,
        offsite: false,
      });
      expect(JSON.parse(run?.targets ?? '[]')[1]).toMatchObject({
        name: 'offsite',
        ok: false,
        detail: expect.stringMatching(/no off-site copy/),
      });
      const [note] = await db.all<{ note: string }>(sql`SELECT note FROM backup_run`);
      expect(note?.note).toMatch(/no off-site copy/);
      // A second backup the same month: no second monthly copy.
      const again = await runLocalBackup({
        sqlite,
        db,
        backups,
        tmpDir: join(root, 'tmp'),
        ageRecipient: await identityToRecipient(identity),
        now: () => now + 86_400_000,
        log: () => {},
      });
      expect(again.monthly).toBeNull();
      expect(readdirSync(join(root, 'backups/monthly')).filter((f) => f.endsWith('.age'))).toEqual([
        '2026-10-18.sqlite.gz.age',
      ]);
      const [audit] = await db.all<{ action: string; user_id: string | null }>(
        sql`SELECT action, user_id FROM audit WHERE entity = 'backup_run'`,
      );
      expect(audit).toEqual({ action: 'report', user_id: null });
    } finally {
      sqlite.close();
    }
  });

  it('a new month gets its monthly/ copy; prunes daily/ older than 95 days, keeps monthly/', async () => {
    const { sqlite, db } = migratedDb();
    try {
      const backups = new DirBucket(join(root, 'backups'));
      for (const k of [
        'daily/2026-07-01.sqlite.gz.age',
        'daily/2026-07-01.sqlite.gz.age.sha256',
        'daily/2026-07-28.sqlite.gz.age',
        'daily/2026-08-15.sqlite.gz.age',
        'daily/LATEST',
        'monthly/2025-01-01.sqlite.gz.age',
      ])
        await backups.put(k, 'x');
      resetBackupWarning();
      const now = Date.parse('2026-11-01T02:30:00+05:00');
      const res = await runLocalBackup({
        sqlite,
        db,
        backups,
        tmpDir: join(root, 'tmp'),
        now: () => now,
        log: () => {},
      });
      expect(res.encrypted).toBe(false);
      expect(res.key).toBe('daily/2026-11-01.sqlite.gz');
      // 95 days before 2026-11-01 is 2026-07-29.
      expect(res.pruned.sort()).toEqual([
        'daily/2026-07-01.sqlite.gz.age',
        'daily/2026-07-01.sqlite.gz.age.sha256',
        'daily/2026-07-28.sqlite.gz.age',
      ]);
      const keys = (await backups.list()).objects.map((o) => o.key);
      expect(keys).toEqual([
        'daily/2026-08-15.sqlite.gz.age',
        'daily/2026-11-01.sqlite.gz',
        'daily/2026-11-01.sqlite.gz.sha256',
        'daily/LATEST',
        'monthly/2025-01-01.sqlite.gz.age',
        'monthly/2026-11-01.sqlite.gz',
        'monthly/2026-11-01.sqlite.gz.sha256',
      ]);
      expect(
        gunzipSync(readFileSync(join(root, 'backups/daily/2026-11-01.sqlite.gz')))
          .subarray(0, 15)
          .toString(),
      ).toBe('SQLite format 3');
      const [run] = await db.all<RunRow>(sql`SELECT * FROM backup_run`);
      expect(JSON.parse(run?.targets ?? '[]')[0]).toMatchObject({
        name: 'local',
        ok: true,
        detail: expect.stringMatching(/not encrypted/),
      });
      expect(await pruneDaily(backups, '2026-11-01')).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('status ok once the host confirmed an off-site copy in the last 48 h (OFFSITE_OK)', async () => {
    const { sqlite, db } = migratedDb();
    try {
      const backups = new DirBucket(join(root, 'backups'));
      const now = Date.parse('2026-10-18T02:30:00+05:00');
      await backups.put(
        OFFSITE_MARKER,
        `${new Date(now - 23 * 3_600_000).toISOString()} r2:maktab\n`,
      );
      const deps = {
        sqlite,
        db,
        backups,
        tmpDir: join(root, 'tmp'),
        rcloneRemote: 'r2:maktab-gsap-backups',
        now: () => now,
        log: () => {},
      };
      const ok = await runLocalBackup(deps);
      expect(ok).toMatchObject({ status: 'ok', offsite: true });
      const [run] = await db.all<RunRow>(sql`SELECT * FROM backup_run`);
      expect(JSON.parse(run?.details ?? '{}')).toMatchObject({ offsite: true });
      // Stale marker (3 days): partial again, naming the remote.
      await backups.put(OFFSITE_MARKER, new Date(now - 72 * 3_600_000).toISOString());
      const stale = await runLocalBackup(deps);
      expect(stale).toMatchObject({ status: 'partial', offsite: false });
      const rows = await db.all<RunRow>(sql`SELECT * FROM backup_run ORDER BY rowid`);
      expect(JSON.parse(rows[1]?.targets ?? '[]')[1].detail).toMatch(/r2:maktab-gsap-backups/);
      // Junk in the marker is no confirmation.
      await backups.put(OFFSITE_MARKER, 'yesterday');
      expect((await runLocalBackup(deps)).offsite).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it('a backup runs while atomic() writes keep coming, and the copy is consistent', async () => {
    const { sqlite, db } = migratedDb();
    try {
      sqlite.exec('CREATE TABLE _pairs (a INTEGER NOT NULL, b INTEGER NOT NULL)');
      // Enough pages that the online backup takes several steps.
      sqlite.exec(
        'CREATE TABLE _pad (x TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000) INSERT INTO _pad SELECT hex(randomblob(256)) FROM n;',
      );
      const backups = new DirBucket(join(root, 'backups'));
      let stop = false;
      let writes = 0;
      const writer = (async () => {
        while (!stop) {
          // Two rows that must always appear together.
          await atomic(db, () => [
            rawStatement(db, sql`INSERT INTO _pairs (a, b) VALUES (${writes}, 1)`),
            rawStatement(db, sql`INSERT INTO _pairs (a, b) VALUES (${writes}, 2)`),
          ]);
          writes++;
          await new Promise((r) => setImmediate(r));
        }
      })();
      const snap = await encryptedSnapshot(
        { sqlite, backups, tmpDir: join(root, 'tmp') },
        'daily/x',
      );
      stop = true;
      await writer;
      expect(writes).toBeGreaterThan(0);
      const copyPath = join(root, 'copy.sqlite');
      writeFileSync(copyPath, gunzipSync(snap.bytes));
      const copy = new Database(copyPath, { readonly: true });
      try {
        expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
        const odd = copy.prepare('SELECT a FROM _pairs GROUP BY a HAVING count(*) <> 2').all() as {
          a: number;
        }[];
        expect(odd).toEqual([]);
      } finally {
        copy.close();
      }
    } finally {
      sqlite.close();
    }
  });

  it('a failure is recorded as failed (and nothing is left in tmp)', async () => {
    const { sqlite, db } = migratedDb();
    try {
      const backups = new DirBucket(join(root, 'backups'));
      const res = await runLocalBackup({
        sqlite,
        db,
        backups,
        tmpDir: join(root, 'tmp'),
        ageRecipient: 'age1notarealrecipient',
        log: () => {},
      });
      expect(res.status).toBe('failed');
      const [run] = await db.all<{ status: string; note: string; object_key: string | null }>(
        sql`SELECT status, note, object_key FROM backup_run`,
      );
      expect(run?.status).toBe('failed');
      expect(run?.object_key).toBeNull();
      expect(run?.note).toMatch(/failed/);
      expect(readdirSync(join(root, 'tmp'))).toEqual([]);
      expect((await backups.list()).objects).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('times: 02:30 Karachi is 21:30 UTC', () => {
    expect(karachiDay(Date.parse('2026-10-17T19:00:00Z'))).toBe('2026-10-18');
    expect(new Date(nextBackupAt(Date.parse('2026-10-17T10:00:00Z'))).toISOString()).toBe(
      '2026-10-17T21:30:00.000Z',
    );
    expect(new Date(nextBackupAt(Date.parse('2026-10-17T21:30:00Z'))).toISOString()).toBe(
      '2026-10-18T21:30:00.000Z',
    );
    expect(backupDueToday(Date.parse('2026-10-17T21:29:00Z'))).toBe(false); // 02:29 on the 18th
    expect(backupDueToday(Date.parse('2026-10-17T21:31:00Z'))).toBe(true);
  });
});

describe('scheduler', () => {
  it('runs one job at a time, never stacks ticks, and catches up a missed backup once a day', async () => {
    const { sqlite, db } = migratedDb();
    try {
      let active = 0;
      let maxActive = 0;
      let backups = 0;
      const backup = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        backups++;
        await new Promise((r) => setTimeout(r, 20));
        active--;
      };
      const s = startScheduler(
        {
          db,
          backup,
          hasBackupFor: async () => false,
          now: () => Date.parse('2026-10-18T03:10:00+05:00'),
          log: () => {},
        },
        { autostart: false },
      );
      await Promise.all([s.tick(), s.tick(), s.tick(), s.backupNow(), s.tick()]);
      expect(maxActive).toBe(1);
      // Five calls, two jobs: one tick (its catch-up backup, today's file being absent) and the
      // explicit backupNow; the stacked ticks were dropped.
      expect(backups).toBe(2);
      // Already attempted today: later ticks do not retry it.
      await s.tick();
      expect(backups).toBe(2);
      // The daily pass ran on the first tick (03:10 Karachi) and only then: one row, today's.
      const events = await db.all<{ day: string }>(sql`SELECT day FROM alarm_event`);
      expect(events).toEqual([{ day: '2026-10-18' }]);
      await s.stop();
    } finally {
      sqlite.close();
    }
  });

  it('the 02:30 timer skips a backup already attempted today; backupNow does not', async () => {
    const { sqlite, db } = migratedDb();
    try {
      let backups = 0;
      let at = Date.parse('2026-10-18T02:30:00+05:00');
      const s = startScheduler(
        {
          db,
          backup: async () => {
            backups++;
          },
          hasBackupFor: async () => true,
          now: () => at,
          log: () => {},
        },
        { autostart: false },
      );
      await s.timedBackup();
      expect(backups).toBe(1);
      await s.timedBackup();
      expect(backups).toBe(1);
      await s.backupNow();
      expect(backups).toBe(2);
      at += 86_400_000;
      await s.timedBackup();
      expect(backups).toBe(3);
      await s.stop();
    } finally {
      sqlite.close();
    }
  });

  it('a throwing job is logged, not thrown, and the next one still runs', async () => {
    const { sqlite, db } = migratedDb();
    try {
      let calls = 0;
      const s = startScheduler(
        {
          db,
          backup: async () => {
            calls++;
            throw new Error('disk full');
          },
          hasBackupFor: async () => true,
          log: () => {},
        },
        { autostart: false },
      );
      const errors: unknown[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => errors.push(a);
      try {
        await s.backupNow();
        await s.backupNow();
      } finally {
        console.error = orig;
      }
      expect(calls).toBe(2);
      expect(errors).toHaveLength(2);
      await s.stop();
    } finally {
      sqlite.close();
    }
  });
});
