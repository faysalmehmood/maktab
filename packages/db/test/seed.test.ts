import { newId } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { DEMO_TEACHER_EMAIL, seedAtomically, seedData } from '../scripts/seed-data';
import { createTestDb } from '../src/node';

it('seed data satisfies every constraint and has the promised shape', async () => {
  const db = createTestDb();
  await seedData(db, newId);
  const count = async (table: string) =>
    (await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${table}"`)))[0]?.n;
  expect(await count('school')).toBe(1);
  expect(await count('user')).toBe(2);
  expect(await count('programme')).toBe(3);
  expect(await count('grp')).toBe(2);
  expect(await count('family')).toBe(6);
  expect(await count('student')).toBe(10);
});

const count = async (db: ReturnType<typeof createTestDb>, table: string) =>
  (await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${table}"`)))[0]?.n;

it('is one transaction: a failure part-way leaves nothing behind', async () => {
  const db = createTestDb();
  let n = 0;
  // From the 6th id on every id is the same: a primary-key clash part-way into the seed, after the
  // users, roles and school are already written.
  const flaky = () => (++n > 5 ? 'DUP' : newId());
  await expect(seedAtomically(db, flaky)).rejects.toThrow();
  for (const table of ['user', 'role', 'school', 'staff', 'session', 'programme', 'family'])
    expect(await count(db, table), table).toBe(0);
  await seedAtomically(db, newId);
  expect(await count(db, 'school')).toBe(1);
  expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
});

it('SEED_OWNER_EMAIL that is a demo or existing user reuses the row instead of failing', async () => {
  const db = createTestDb();
  const notes: string[] = [];
  await seedAtomically(db, newId, DEMO_TEACHER_EMAIL.toUpperCase(), (m) => notes.push(m));
  expect(await count(db, 'user')).toBe(1);
  expect(await db.all(sql`SELECT role FROM role ORDER BY role`)).toEqual([
    { role: 'owner' },
    { role: 'teacher' },
  ]);
  expect(notes.join(' ')).toMatch(/demo teacher/);

  const db2 = createTestDb();
  await db2.run(
    sql`INSERT INTO "user" (id, email, status) VALUES ('ME', 'me@example.com', 'invited')`,
  );
  await seedAtomically(db2, newId, 'me@example.com');
  expect(await db2.all(sql`SELECT id, status FROM "user" WHERE email = 'me@example.com'`)).toEqual([
    { id: 'ME', status: 'active' },
  ]);
  expect(await db2.all(sql`SELECT role FROM role WHERE user_id = 'ME'`)).toEqual([
    { role: 'owner' },
  ]);
  expect(await db2.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
});
