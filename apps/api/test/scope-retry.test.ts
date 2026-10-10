import { grp, grpSubject, programme, staff, subject } from '@maktab/db';
import { createTestDb } from '@maktab/db/node';
import type { StaffRole } from '@maktab/shared';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/auth/principal';
import { isTransientD1Error, withD1Retry } from '../src/lib/retry';
import { groupFilter, scopeToGroups } from '../src/perm/scope';
import { signedInAs } from './helpers';

const principal = (id: string, roles: StaffRole[]): Principal => ({
  kind: 'staff',
  user: { id, email: `${id}@x.pk`, name: id, status: 'active' },
  roles,
});

describe('scopeToGroups', () => {
  it('limits teachers to groups they teach; office roles see all', async () => {
    const db = createTestDb();
    const a = await signedInAs(db, ['teacher']);
    const b = await signedInAs(db, ['teacher']);
    await db.insert(staff).values([
      { id: 'T-A', userId: a.userId, name: 'A' },
      { id: 'T-B', userId: b.userId, name: 'B' },
    ]);
    await db.insert(programme).values({ id: 'P', name: 'Class 5', kind: 'grade' });
    await db.insert(subject).values({ id: 'MATH', name: 'Maths' });
    await db.insert(grp).values([
      { id: 'G1', programmeId: 'P', name: '5-A', classTeacherId: 'T-A' },
      { id: 'G2', programmeId: 'P', name: '5-B', classTeacherId: 'T-B' },
      { id: 'G3', programmeId: 'P', name: '5-C', classTeacherId: 'T-B' },
    ]);
    await db
      .insert(grpSubject)
      .values({ id: 'GS', grpId: 'G3', subjectId: 'MATH', teacherId: 'T-A' });

    expect(await scopeToGroups(db, principal(a.userId, ['teacher']))).toEqual({
      kind: 'groups',
      ids: ['G1', 'G3'],
    });
    expect(await scopeToGroups(db, principal(b.userId, ['teacher']))).toEqual({
      kind: 'groups',
      ids: ['G2', 'G3'],
    });
    expect(await scopeToGroups(db, principal('nobody', ['teacher']))).toEqual({
      kind: 'groups',
      ids: [],
    });
    expect(await scopeToGroups(db, principal(a.userId, ['accountant']))).toEqual({ kind: 'all' });

    const visible = async (p: Principal) =>
      (
        await db
          .select({ id: grp.id })
          .from(grp)
          .where(groupFilter(grp.id, await scopeToGroups(db, p)))
      ).map((r) => r.id);
    expect(await visible(principal(a.userId, ['teacher']))).toEqual(['G1', 'G3']);
    expect(await visible(principal('nobody', ['teacher']))).toEqual([]);
    expect((await visible(principal(a.userId, ['admin']))).length).toBe(3);
  });
});

describe('withD1Retry', () => {
  const noSleep = { sleep: async () => {} };

  it('retries once on D1 7500 and SQLITE_BUSY', async () => {
    for (const msg of [
      'D1_ERROR: internal error; reference = 7500',
      'SQLITE_BUSY: database is locked',
    ]) {
      let calls = 0;
      const result = await withD1Retry(async () => {
        calls++;
        if (calls === 1) throw new Error('Failed query', { cause: new Error(msg) });
        return 'ok';
      }, noSleep);
      expect(result).toBe('ok');
      expect(calls).toBe(2);
    }
  });

  it('does not retry other errors, and gives up after one retry', async () => {
    let calls = 0;
    await expect(
      withD1Retry(async () => {
        calls++;
        throw new Error('UNIQUE constraint failed');
      }, noSleep),
    ).rejects.toThrow(/UNIQUE/);
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      withD1Retry(async () => {
        calls++;
        throw new Error('7500');
      }, noSleep),
    ).rejects.toThrow('7500');
    expect(calls).toBe(2);
    expect(isTransientD1Error('allocation exceeds charge net')).toBe(false);
  });
});
