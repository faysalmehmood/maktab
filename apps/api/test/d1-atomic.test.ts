import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic, family, getDb, rawStatement } from '@maktab/db';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import { newId } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { type ApplyInput, applySubmissions } from '../src/lib/attendance';
import { todayPk } from '../src/lib/http';

/**
 * The D1 path of atomic() (packages/db/src/client.ts) against workerd's real D1 implementation via
 * wrangler's getPlatformProxy (in-memory, nothing persisted). better-sqlite3 tests never reach this
 * branch, and it is the one that broke on real D1 before (raw statements had no `.bind`).
 */
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;

const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(import.meta.dirname, '../wrangler.toml'),
    persist: false,
  });
  // Every migration, one batch each (as `wrangler d1 migrations apply` does): this also proves the
  // migrations themselves run on D1.
  for (const f of migrationFiles()) {
    const stmts = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gm, '').trim() !== '');
    await proxy.env.DB.batch(stmts.map((s) => proxy.env.DB.prepare(s)));
  }
  // School open every day, so any date the tests pick is a school day.
  await proxy.env.DB.prepare(
    `INSERT INTO school (id, name, weekly_off) VALUES ('SCH', 'Test', '[]')`,
  ).run();
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe('atomic() on D1', () => {
  it('runs raw SQL with params, a drizzle builder and a json_each insert in one batch', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const progs = JSON.stringify([
      { id: 'P1', name: 'Class 1' },
      { id: 'P2', name: 'Class 2' },
    ]);
    await atomic(db, () => [
      rawStatement(
        db,
        sql`INSERT INTO family (id, name, area) VALUES (${'F1'}, ${'Khan'}, ${'Gulberg'})`,
      ),
      db.insert(family).values({ id: 'F2', name: 'Ahmed' }),
      rawStatement(
        db,
        sql`INSERT INTO programme (id, name, kind)
            SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), 'grade'
            FROM json_each(${progs})`,
      ),
    ]);
    const fams = await proxy.env.DB.prepare('SELECT id, area FROM family ORDER BY id').all();
    expect(fams.results).toEqual([
      { id: 'F1', area: 'Gulberg' },
      { id: 'F2', area: null },
    ]);
    const n = await proxy.env.DB.prepare('SELECT count(*) AS n FROM programme').first<{
      n: number;
    }>();
    expect(n?.n).toBe(2);
  });

  it('a failing last statement rolls back everything before it', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const err = await atomic(db, () => [
      rawStatement(db, sql`INSERT INTO family (id, name) VALUES (${'F3'}, ${'Rolled back'})`),
      db.insert(family).values({ id: 'F4', name: 'Also rolled back' }),
      rawStatement(
        db,
        sql`INSERT INTO programme (id, name, kind)
            SELECT 'P3', 'X', 'grade' FROM json_each(${'[1]'})`,
      ),
      // Duplicate primary key: the batch must fail as a whole.
      rawStatement(db, sql`INSERT INTO family (id, name) VALUES (${'F1'}, ${'dup'})`),
    ]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    const left = await proxy.env.DB.prepare(
      `SELECT (SELECT count(*) FROM family WHERE id IN ('F3', 'F4')) AS f,
              (SELECT count(*) FROM programme WHERE id = 'P3') AS p`,
    ).first<{ f: number; p: number }>();
    expect(left).toEqual({ f: 0, p: 0 });
  });

  it('the attendance sync batch (upsert pointer, json_each marks, absence queue) runs on D1', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const today = todayPk();
    const [u, g, f, s1, s2] = [newId(), newId(), newId(), newId(), newId()];
    await proxy.env.DB.batch(
      [
        `INSERT INTO "user" (id, email, status) VALUES ('${u}', 't@x.pk', 'active')`,
        `INSERT INTO programme (id, name, kind) VALUES ('PA', 'Class 5', 'grade')`,
        `INSERT INTO grp (id, programme_id, name) VALUES ('${g}', 'PA', 'A')`,
        `INSERT INTO family (id, name) VALUES ('${f}', 'Khan')`,
        `INSERT INTO guardian (id, family_id, name, phone, consent_whatsapp) VALUES ('G1', '${f}', 'Imran', '923001234567', 1)`,
        `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('${s1}', '${f}', 'A1', 'Ali', '2026-01-01'), ('${s2}', '${f}', 'A2', 'Sara', '2026-01-01')`,
        `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('E1', '${s1}', '${g}', 1, '2026-01-01'), ('E2', '${s2}', '${g}', 1, '2026-01-01')`,
      ].map((q) => proxy.env.DB.prepare(q)),
    );
    const sub = (min: number, absent: string[]) => ({
      client_id: newId(),
      grp_id: g,
      date: today,
      grp_subject_id: '',
      taken_at: new Date(Date.UTC(2026, 0, 1, 8, min)).toISOString(),
      marks: [s1, s2].map((id) => ({
        student_id: id,
        status: absent.includes(id) ? ('A' as const) : ('P' as const),
      })),
    });
    const opts = { uid: u, scope: { kind: 'all' } as const, kind: 'sync' as const };
    const a = sub(10, [s1, s2]);
    const [r1, r2, r3] = await applySubmissions(db, [a, sub(20, [s1]), sub(15, [])], opts);
    expect([r1?.status, r2?.status, r3?.status]).toEqual(['applied', 'replaced', 'stale']);
    expect(r1?.queued_messages).toBe(1);
    const [dup] = await applySubmissions(db, [a], opts);
    expect(dup).toMatchObject({ status: 'duplicate', register_id: r1?.register_id });
    const cur = await proxy.env.DB.prepare('SELECT register_id FROM current_register').all();
    expect(cur.results).toEqual([{ register_id: r2?.register_id }]);
    const msg = await proxy.env.DB.prepare(
      `SELECT json_extract(payload, '$.student_names') AS names FROM message`,
    ).all<{ names: string }>();
    expect(msg.results.map((m) => JSON.parse(m.names).sort())).toEqual([['Ali', 'Sara']]);
    const corr = await applySubmissions(
      db,
      [{ ...sub(0, []), taken_at: new Date().toISOString(), reason: 'fix' }],
      { ...opts, kind: 'correct' },
    );
    expect(corr[0]?.status).toBe('replaced');
  });
});

/** A group of `n` students, each in their own family with a consenting guardian; unique per call. */
async function seedGroup(n: number) {
  const tag = newId();
  const u = `U${tag}`;
  const g = `G${tag}`;
  const p = `P${tag}`;
  const nums = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})`;
  await proxy.env.DB.batch(
    [
      `INSERT INTO "user" (id, email, status) VALUES ('${u}', '${tag}@x.pk', 'active')`,
      `INSERT INTO programme (id, name, kind) VALUES ('${p}', 'Class ${tag}', 'grade')`,
      `INSERT INTO grp (id, programme_id, name) VALUES ('${g}', '${p}', 'A')`,
      `INSERT INTO family (id, name) ${nums} SELECT '${tag}F' || i, 'Family ' || i FROM n`,
      `INSERT INTO guardian (id, family_id, name, phone, consent_whatsapp)
       ${nums} SELECT '${tag}G' || i, '${tag}F' || i, 'Guardian ' || i,
                      '92300' || printf('%07d', i), 1 FROM n`,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date)
       ${nums} SELECT '${tag}S' || printf('%03d', i), '${tag}F' || i, '${tag}-' || i,
                      'Student ' || i, '2026-01-01' FROM n`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date)
       ${nums} SELECT '${tag}E' || i, '${tag}S' || printf('%03d', i), '${g}', 1, '2026-01-01' FROM n`,
    ].map((q) => proxy.env.DB.prepare(q)),
  );
  const students = Array.from({ length: n }, (_, i) => `${tag}S${String(i + 1).padStart(3, '0')}`);
  return {
    u,
    g,
    students,
    opts: { uid: u, scope: { kind: 'all' } as const, kind: 'sync' as const },
  };
}

const daysAgo = (k: number) => {
  const d = new Date(`${todayPk()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - k);
  return d.toISOString().slice(0, 10);
};

const register = (
  g: string,
  students: string[],
  over: Partial<ApplyInput> & { absent?: number } = {},
): ApplyInput => {
  const { absent = 0, ...rest } = over;
  return {
    client_id: newId(),
    grp_id: g,
    date: daysAgo(1),
    grp_subject_id: '',
    taken_at: new Date(Date.now() - 3_600_000).toISOString(),
    marks: students.map((id, i) => ({ student_id: id, status: i < absent ? 'A' : 'P' })),
    ...rest,
  };
};

const count = async (q: string) =>
  (await proxy.env.DB.prepare(`SELECT count(*) AS n FROM (${q})`).first<{ n: number }>())?.n ?? -1;

const currentClientId = async (g: string, date: string) =>
  (
    await proxy.env.DB.prepare(
      `SELECT r.client_id FROM current_register c JOIN att_register r ON r.id = c.register_id
       WHERE c.grp_id = ? AND c.date = ?`,
    )
      .bind(g, date)
      .first<{ client_id: string }>()
  )?.client_id;

describe('attendance sync on D1 (workerd)', () => {
  it('a 150-mark register (two json_each slices) is all-or-nothing; 60 absentees go in a second batch', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const { g, students, opts } = await seedGroup(150);
    const sub = register(g, students, { date: todayPk(), absent: 60 });
    // A failure on the very last mark (second slice) rolls back the register and every mark.
    await proxy.env.DB.prepare(
      `CREATE TRIGGER boom BEFORE INSERT ON att_mark WHEN NEW.student_id = '${students[149]}'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    ).run();
    const [failed] = await applySubmissions(db, [sub], opts);
    await proxy.env.DB.prepare('DROP TRIGGER boom').run();
    expect([failed?.status, failed?.error]).toEqual(['rejected', 'db_error']);
    expect(await count(`SELECT 1 FROM att_register WHERE grp_id = '${g}'`)).toBe(0);
    expect(await count(`SELECT 1 FROM att_mark WHERE student_id LIKE '${g.slice(1)}%'`)).toBe(0);
    expect(
      await count(`SELECT 1 FROM message WHERE json_extract(payload, '$.grp_id') = '${g}'`),
    ).toBe(0);

    // 150 marks + 60 absentees = 210 rows: registers first, the absence queue in batch two.
    const [ok] = await applySubmissions(db, [{ ...sub, client_id: newId() }], opts);
    expect(ok).toMatchObject({ status: 'applied', queued_messages: 60 });
    expect(await count(`SELECT 1 FROM att_mark WHERE register_id = '${ok?.register_id}'`)).toBe(
      150,
    );
    expect(
      await count(
        `SELECT 1 FROM message WHERE channel = 'wa_manual' AND json_extract(payload, '$.grp_id') = '${g}'`,
      ),
    ).toBe(60);
  });

  it('two racing requests for one register: the later taken_at wins whatever the arrival order', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const { g, students, opts } = await seedGroup(3);
    for (const [k, lateFirst] of [
      [2, false],
      [3, true],
    ] as const) {
      const date = daysAgo(k);
      const early = register(g, students, { date, taken_at: '2026-01-01T08:00:00.000Z' });
      const late = register(g, students, { date, taken_at: '2026-01-01T08:00:01.000Z', absent: 1 });
      const order = lateFirst ? [late, early] : [early, late];
      const results = await Promise.all(order.map((s) => applySubmissions(db, [s], opts)));
      expect(results.flat().every((r) => r.status !== 'rejected')).toBe(true);
      expect(await currentClientId(g, date)).toBe(late.client_id);
      expect(
        await count(`SELECT 1 FROM att_register WHERE grp_id = '${g}' AND date = '${date}'`),
      ).toBe(2);
    }
  });

  it('one of three registers failing leaves the other two applied', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const { g, students, opts } = await seedGroup(2);
    const subs = [4, 5, 6].map((k) => register(g, students, { date: daysAgo(k) }));
    const bad = subs[1]?.client_id ?? '';
    await proxy.env.DB.prepare(
      `CREATE TRIGGER boom_reg BEFORE INSERT ON att_register WHEN NEW.client_id = '${bad}'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    ).run();
    const results = await applySubmissions(db, subs, opts);
    await proxy.env.DB.prepare('DROP TRIGGER boom_reg').run();
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['applied', undefined],
      ['rejected', 'db_error'],
      ['applied', undefined],
    ]);
    expect(await currentClientId(g, daysAgo(4))).toBe(subs[0]?.client_id);
    expect(await currentClientId(g, daysAgo(5))).toBeUndefined();
    expect(await currentClientId(g, daysAgo(6))).toBe(subs[2]?.client_id);
  });

  /**
   * Wraps the D1 binding: records every batch's (sql, params) and throws D1's transient 7500 on the
   * first batch — before running it, or after committing it (the response was lost).
   */
  function flakyD1(real: D1Database, mode: 'before' | 'after') {
    const bound = new WeakMap<object, { sql: string; params: unknown[] }>();
    const batches: ({ sql: string; params: unknown[] } | undefined)[][] = [];
    let failNext = true;
    const forward = (t: object, p: string | symbol) => {
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    };
    const DB = new Proxy(real, {
      get(t, p) {
        if (p === 'prepare')
          return (q: string) => {
            const st = t.prepare(q);
            return new Proxy(st, {
              get(s2, p2) {
                if (p2 !== 'bind') return forward(s2, p2);
                return (...params: unknown[]) => {
                  const b = s2.bind(...params);
                  bound.set(b, { sql: q, params });
                  return b;
                };
              },
            });
          };
        if (p === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            batches.push(stmts.map((s) => bound.get(s)));
            if (failNext) {
              failNext = false;
              if (mode === 'after') await t.batch(stmts);
              throw new Error('D1_ERROR: internal error; reference = 7500');
            }
            return t.batch(stmts);
          };
        return forward(t, p);
      },
    });
    return { DB, batches };
  }

  it('a transient error is retried once with byte-identical statements, whether or not the first attempt landed', async () => {
    for (const mode of ['before', 'after'] as const) {
      const flaky = flakyD1(proxy.env.DB, mode);
      const db = getDb({ DB: flaky.DB });
      const { g, students, opts } = await seedGroup(3);
      const sub = register(g, students, { date: todayPk(), absent: 2 });
      const [r] = await applySubmissions(db, [sub], opts);
      expect(r, mode).toMatchObject({ status: 'applied', queued_messages: 2 });
      expect(flaky.batches.length).toBe(2);
      expect(flaky.batches[0]?.every(Boolean)).toBe(true);
      expect(flaky.batches[1]).toEqual(flaky.batches[0]);
      expect(await count(`SELECT 1 FROM att_register WHERE grp_id = '${g}'`)).toBe(1);
      expect(await count(`SELECT 1 FROM att_mark WHERE register_id = '${r?.register_id}'`)).toBe(3);
      expect(await count(`SELECT 1 FROM audit WHERE entity_id = '${r?.register_id}'`)).toBe(1);
      expect(
        await count(`SELECT 1 FROM message WHERE json_extract(payload, '$.grp_id') = '${g}'`),
      ).toBe(2);
    }
  });
});
