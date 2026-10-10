import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../src/node';

// Milestone 2 migration (0006): holidays and the school's attendance settings, on top of the M0
// attendance tables (att_register / att_mark / current_register + current_register_forward).

describe('attendance migration', () => {
  it('creates holiday and the attendance tables, with taken_at on the pointer', async () => {
    const db = createTestDb();
    const tables = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'holiday',
        'att_register',
        'att_mark',
        'current_register',
        'message',
        'reminder_state',
      ]),
    );
    const pointer = await db.all<{ name: string }>(sql`PRAGMA table_info(current_register)`);
    expect(pointer.map((c) => c.name)).toEqual(
      expect.arrayContaining(['grp_id', 'date', 'grp_subject_id', 'register_id', 'taken_at']),
    );
    const triggers = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'current_register'`,
    );
    expect(triggers.map((t) => t.name)).toContain('current_register_forward');
  });

  it('defaults a school to daily registers with Sunday off', async () => {
    const db = createTestDb();
    await db.run(sql`INSERT INTO school (id, name) VALUES ('S', 'Al-Noor')`);
    const [row] = await db.all<{ attendance_mode: string; weekly_off: string }>(
      sql`SELECT attendance_mode, weekly_off FROM school`,
    );
    expect(row).toEqual({ attendance_mode: 'daily', weekly_off: '[0]' });
  });

  it('keys holidays by date', async () => {
    const db = createTestDb();
    await db.run(
      sql`INSERT INTO holiday (date, name_en) VALUES ('2026-08-14', 'Independence Day')`,
    );
    // better-sqlite3 runs synchronously, so the failure throws instead of rejecting.
    await expect(async () =>
      db.run(sql`INSERT INTO holiday (date, name_en) VALUES ('2026-08-14', 'Again')`),
    ).rejects.toThrow(/Failed to run the query/);
    const [n] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM holiday`);
    expect(n?.n).toBe(1);
  });
});
