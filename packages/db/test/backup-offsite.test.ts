import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../src/client';
import { createTestDb } from '../src/node';
import { backupOffsite, evaluateAlarms } from '../src/ops/alarms';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let db: AppDb;
let n = 0;
beforeEach(() => {
  db = createTestDb();
  n = 0;
});

async function school(createdMs: number) {
  await db.run(
    sql`INSERT INTO school (id, name, weekly_off, created_at) VALUES ('SCH', 'T', '[]', ${iso(createdMs)})`,
  );
}

async function run(
  atMs: number,
  o: { status?: string; targets?: unknown[]; details?: Record<string, unknown> } = {},
) {
  n++;
  await db.run(sql`INSERT INTO backup_run (id, kind, status, finished_at, targets, details)
    VALUES (${`R${n}`}, 'nightly', ${o.status ?? 'partial'}, ${iso(atMs)},
      ${o.targets ? JSON.stringify(o.targets) : null},
      ${JSON.stringify({ backup_enabled: true, ...(o.details ?? {}) })})`);
}

const LOCAL = [
  { name: 'local', ok: true },
  { name: 'offsite', ok: false, detail: 'no off-site copy' },
];

describe('backup_offsite alarm', () => {
  it('is silent with no nightly runs, or when the latest run does not say backup_enabled', async () => {
    await school(NOW - 30 * DAY);
    expect(await backupOffsite(db, NOW)).toMatchObject({ count: 0, since: null });
    await db.run(
      sql`INSERT INTO backup_run (id, kind, status, finished_at) VALUES ('X', 'nightly', 'ok', ${iso(NOW - DAY)})`,
    );
    expect((await backupOffsite(db, NOW)).count).toBe(0);
  });

  it('fires when no run ever had an off-site copy and the installation is 7+ days old', async () => {
    await school(NOW - 8 * DAY);
    await run(NOW - DAY, { targets: LOCAL });
    const a = await backupOffsite(db, NOW);
    expect(a).toMatchObject({ kind: 'backup_offsite', count: 1, since: null });
    expect(a.sample[0]?.label).toBe('never off-site');
    expect((await evaluateAlarms(db, NOW)).alarms.map((x) => x.kind)).toContain('backup_offsite');
  });

  it('gives a new installation 7 days of grace', async () => {
    await school(NOW - 3 * DAY);
    await run(NOW - DAY, { targets: LOCAL });
    expect((await backupOffsite(db, NOW)).count).toBe(0);
  });

  it('is quiet while an off-site run is recent; fires once the last one is older than 7 days', async () => {
    await school(NOW - 60 * DAY);
    await run(NOW - 2 * DAY, { status: 'ok', details: { offsite: true } });
    await run(NOW - DAY, { targets: LOCAL });
    expect(await backupOffsite(db, NOW)).toMatchObject({ count: 0, since: iso(NOW - 2 * DAY) });
    const later = NOW + 6 * DAY;
    expect((await backupOffsite(db, later)).count).toBe(1);
    expect((await backupOffsite(db, later)).since).toBe(iso(NOW - 2 * DAY));
  });

  it('counts the GitHub workflow’s R2 / B2 uploads as off-site; a failed upload does not', async () => {
    await school(NOW - 60 * DAY);
    await run(NOW - DAY, {
      targets: [
        { name: 'r2', ok: false },
        { name: 'b2', ok: false },
      ],
    });
    expect((await backupOffsite(db, NOW)).count).toBe(1);
    await run(NOW - 1000, { status: 'ok', targets: [{ name: 'r2', ok: true }] });
    expect((await backupOffsite(db, NOW)).count).toBe(0);
  });
});
