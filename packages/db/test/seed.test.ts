import { newId } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { seedData } from '../scripts/seed-data';
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
