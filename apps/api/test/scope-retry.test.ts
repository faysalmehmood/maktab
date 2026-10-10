import { grp, grpSubject, programme, staff, subject } from '@maktab/db';
import { createTestDb } from '@maktab/db/node';
import type { Grant } from '@maktab/shared';
import { describe, expect, it } from 'vitest';
import { isTransientD1Error, withD1Retry } from '../src/lib/retry';
import { groupFilter, mayWriteRegister, scopeToGroups } from '../src/perm/scope';
import { signedInAs } from './helpers';

describe('scopeToGroups', () => {
  it('derives scope from the resolved grant, not from roles', async () => {
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

    const scope = (userId: string, grant: Grant) => scopeToGroups(db, userId, grant);
    // A reaches G3 only as the maths teacher: writes there are limited to that subject.
    const aGroups = await scope(a.userId, 'own_groups');
    expect(aGroups).toEqual({ kind: 'groups', ids: ['G1', 'G3'], subjectsOnly: { G3: ['GS'] } });
    expect(await scope(b.userId, 'own_groups')).toEqual({ kind: 'groups', ids: ['G2', 'G3'] });
    expect(await scope(a.userId, 'own_subjects')).toEqual({
      kind: 'groups',
      ids: ['G3'],
      subjectsOnly: { G3: ['GS'] },
    });
    expect(mayWriteRegister(aGroups, 'G1', '')).toBe(true);
    expect(mayWriteRegister(aGroups, 'G3', 'GS')).toBe(true);
    expect(mayWriteRegister(aGroups, 'G3', '')).toBe(false);
    expect(mayWriteRegister(aGroups, 'G2', '')).toBe(false);
    expect(mayWriteRegister({ kind: 'all' }, 'G2', '')).toBe(true);
    expect(await scope('nobody', 'own_groups')).toEqual({ kind: 'groups', ids: [] });
    expect(await scope(a.userId, 'all')).toEqual({ kind: 'all' });
    // A teacher whose route grants `all` (e.g. a future school-wide notice) sees all groups;
    // a deny or a non-group scope sees none, whatever roles the user holds.
    expect(await scope(a.userId, false)).toEqual({ kind: 'groups', ids: [] });
    expect(await scope(a.userId, 'own_only')).toEqual({ kind: 'groups', ids: [] });

    const visible = async (userId: string, grant: Grant) =>
      (
        await db
          .select({ id: grp.id })
          .from(grp)
          .where(groupFilter(grp.id, await scopeToGroups(db, userId, grant)))
      ).map((r) => r.id);
    expect(await visible(a.userId, 'own_groups')).toEqual(['G1', 'G3']);
    expect(await visible('nobody', 'own_groups')).toEqual([]);
    expect((await visible(a.userId, 'all')).length).toBe(3);
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
