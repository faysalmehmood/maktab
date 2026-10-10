import { sql } from 'drizzle-orm';
import type { AppDb } from '../src/client';
import * as t from '../src/schema';

export const DEMO_TEACHER_EMAIL = 'teacher@example.com';

/**
 * A user row by email, reused if it exists (a developer who signed in before seeding, or
 * SEED_OWNER_EMAIL set to a demo address), else created. `log` says which.
 */
async function ensureUser(
  db: AppDb,
  o: { id: string; email: string; name: string; status: 'active' | 'invited'; createdBy?: string },
  log: (m: string) => void,
): Promise<string> {
  const [row] = await db.all<{ id: string }>(sql`SELECT id FROM "user" WHERE email = ${o.email}`);
  if (row) {
    log(`reusing the existing user ${o.email}`);
    if (o.status === 'active')
      await db.run(sql`UPDATE "user" SET status = 'active' WHERE id = ${row.id}`);
    return row.id;
  }
  await db.insert(t.user).values({ ...o, createdBy: o.createdBy ?? null });
  return o.id;
}

/**
 * One school, 2 staff users, 3 programmes, 2 groups, 10 students in 6 families.
 * `ownerEmail` lets a developer sign in locally with their own Google account. If that address is
 * already a user (or is the demo teacher's), the row is reused: one person, owner (+ teacher) roles.
 */
export async function seedData(
  db: AppDb,
  newId: () => string,
  ownerEmail = 'owner@example.com',
  log: (m: string) => void = () => {},
): Promise<void> {
  const email = ownerEmail.trim().toLowerCase();
  const ownerId = await ensureUser(
    db,
    { id: newId(), email, name: 'Owner (dev)', status: 'active' },
    log,
  );
  const teacherUserId =
    email === DEMO_TEACHER_EMAIL
      ? ownerId
      : await ensureUser(
          db,
          {
            id: newId(),
            email: DEMO_TEACHER_EMAIL,
            name: 'Teacher (dev)',
            status: 'invited',
            createdBy: ownerId,
          },
          log,
        );
  if (teacherUserId === ownerId)
    log(`SEED_OWNER_EMAIL is the demo teacher's address: one user gets both roles`);
  await db.run(
    sql`INSERT INTO role (user_id, role) VALUES (${ownerId}, 'owner') ON CONFLICT DO NOTHING`,
  );
  await db.run(sql`INSERT INTO role (user_id, role, created_by) VALUES (${teacherUserId}, 'teacher', ${ownerId})
    ON CONFLICT DO NOTHING`);
  const by = { createdBy: ownerId };

  await db.insert(t.school).values({
    id: newId(),
    name: 'Al-Noor Community School',
    nameUr: 'النور کمیونٹی اسکول',
    mode: 'both',
    ...by,
  });
  const ownerStaff = newId();
  const teacherStaff = newId();
  await db.insert(t.staff).values([
    { id: ownerStaff, userId: ownerId, name: 'Owner (dev)', role: 'principal', ...by },
    {
      id: teacherStaff,
      // One user cannot be two staff rows' login; the demo teacher stays a staff row without one.
      userId: teacherUserId === ownerId ? null : teacherUserId,
      name: 'Teacher (dev)',
      role: 'teacher',
      ...by,
    },
  ]);

  const sessionId = newId();
  await db.insert(t.session).values({
    id: sessionId,
    name: '2026-27',
    startDate: '2026-04-01',
    endDate: '2027-03-31',
    isCurrent: true,
    ...by,
  });

  const class6 = newId();
  const class5 = newId();
  const fsc = newId();
  await db.insert(t.programme).values([
    { id: class6, name: 'Class 6', kind: 'grade', seq: 6, ...by },
    { id: class5, name: 'Class 5', kind: 'grade', seq: 5, nextProgrammeId: class6, ...by },
    { id: fsc, name: 'FSc Pre-Medical', kind: 'course', seq: 20, durationWeeks: 96, ...by },
  ]);

  const grp5a = newId();
  const morningBatch = newId();
  await db.insert(t.grp).values([
    {
      id: grp5a,
      programmeId: class5,
      sessionId,
      name: '5-A',
      classTeacherId: teacherStaff,
      status: 'running',
      ...by,
    },
    {
      id: morningBatch,
      programmeId: fsc,
      name: 'Morning batch',
      isPrimary: false,
      capacity: 40,
      days: 'Mon-Fri',
      startTime: '08:00',
      endTime: '12:00',
      status: 'running',
      ...by,
    },
  ]);

  // Six families; sizes 3,2,2,1,1,1 = 10 students.
  const families = [
    { name: 'Khan', kids: ['Ali Khan', 'Sara Khan', 'Omar Khan'] },
    { name: 'Ahmed', kids: ['Ayesha Ahmed', 'Bilal Ahmed'] },
    { name: 'Hussain', kids: ['Zainab Hussain', 'Hamza Hussain'] },
    { name: 'Malik', kids: ['Fatima Malik'] },
    { name: 'Qureshi', kids: ['Usman Qureshi'] },
    { name: 'Siddiqui', kids: ['Maryam Siddiqui'] },
  ];
  let admission = 1;
  for (const [i, f] of families.entries()) {
    const familyId = newId();
    await db
      .insert(t.family)
      .values({ id: familyId, name: `${f.name} family`, area: 'Model Town', ...by });
    await db.insert(t.guardian).values({
      id: newId(),
      familyId,
      name: `Mr ${f.name}`,
      relation: 'father',
      phone: `030012345${String(i).padStart(2, '0')}`,
      consentWhatsapp: true,
      ...by,
    });
    for (const name of f.kids) {
      const studentId = newId();
      const no = admission++;
      await db.insert(t.student).values({
        id: studentId,
        familyId,
        admissionNo: `2026-${String(no).padStart(3, '0')}`,
        name,
        fatherName: `Mr ${f.name}`,
        admissionDate: '2026-04-01',
        ...by,
      });
      await db.insert(t.enrolment).values({
        id: newId(),
        studentId,
        grpId: grp5a,
        isPrimary: true,
        rollNo: String(no),
        startDate: '2026-04-01',
        ...by,
      });
      if (no % 4 === 0) {
        await db.insert(t.enrolment).values({
          id: newId(),
          studentId,
          grpId: morningBatch,
          isPrimary: false,
          startDate: '2026-04-01',
          ...by,
        });
      }
    }
  }
}

/**
 * The whole seed as ONE transaction: a failure part-way (a constraint, a bad SEED_OWNER_EMAIL, a
 * crash) leaves the database exactly as it was, so a re-run starts clean. better-sqlite3 runs every
 * statement on one connection, so BEGIN … COMMIT around the async inserts is a real transaction.
 */
export async function seedAtomically(
  db: AppDb,
  newId: () => string,
  ownerEmail?: string,
  log?: (m: string) => void,
): Promise<void> {
  await db.run(sql`BEGIN IMMEDIATE`);
  try {
    await seedData(db, newId, ownerEmail, log);
    const fk = await db.all(sql`PRAGMA foreign_key_check`);
    if (fk.length) throw new Error(`seed left foreign-key violations: ${JSON.stringify(fk)}`);
    await db.run(sql`COMMIT`);
  } catch (err) {
    await db.run(sql`ROLLBACK`);
    throw err;
  }
}
