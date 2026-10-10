import type { AppDb } from '../src/client';
import * as t from '../src/schema';

/**
 * One school, 2 staff users, 3 programmes, 2 groups, 10 students in 6 families.
 * `ownerEmail` lets a developer sign in locally with their own Google account.
 */
export async function seedData(
  db: AppDb,
  newId: () => string,
  ownerEmail = 'owner@example.com',
): Promise<void> {
  const ownerId = newId();
  const teacherUserId = newId();
  await db.insert(t.user).values([
    { id: ownerId, email: ownerEmail.toLowerCase(), name: 'Owner (dev)', status: 'active' },
    {
      id: teacherUserId,
      email: 'teacher@example.com',
      name: 'Teacher (dev)',
      status: 'invited',
      createdBy: ownerId,
    },
  ]);
  await db.insert(t.role).values([
    { userId: ownerId, role: 'owner' },
    { userId: teacherUserId, role: 'teacher', createdBy: ownerId },
  ]);
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
    { id: teacherStaff, userId: teacherUserId, name: 'Teacher (dev)', role: 'teacher', ...by },
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
