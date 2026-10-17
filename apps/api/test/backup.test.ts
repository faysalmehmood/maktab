import type { AppDb } from '@maktab/db';
import { createTestDb } from '@maktab/db/node';
import {
  type AlarmsDto,
  type BackupStatusDto,
  EXPORT_PART_ROWS,
  type ExportJobDto,
  type ExportPartDto,
  type RecycleBinDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PARENT_SECRET, REPORT_TOKEN, SECRET, signedInAs, testApp } from './helpers';

type Res<T> = { status: number; body: T; text: string };

function client(request: ReturnType<typeof testApp>['request'], cookie: string | null) {
  return async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> => {
    const res = await request(path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed as T, text };
  };
}

/** Counts the raw reads a handler makes (the per-request budget, PLAN §15). */
function counting(db: AppDb) {
  const state = { reads: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'all')
        return (...args: Parameters<AppDb['all']>) => {
          state.reads++;
          return target.all(...args);
        };
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy as AppDb, state };
}

const exec = (db: AppDb, q: string) => db.run(sql.raw(q));

/** The database's refusal text (better-sqlite3 throws synchronously, wrapped by drizzle). */
async function refusal(db: AppDb, q: string): Promise<string> {
  try {
    await exec(db, q);
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} ${e.cause?.message ?? ''}`;
  }
  return 'no error';
}

let base: AppDb;
let counter: ReturnType<typeof counting>;
let t: ReturnType<typeof testApp>;
let owner: { userId: string; cookie: string };
let ownerApi: ReturnType<typeof client>;

beforeEach(async () => {
  base = createTestDb();
  counter = counting(base);
  t = testApp({ db: counter.db });
  owner = await signedInAs(base, ['owner']);
  ownerApi = client(t.request, owner.cookie);
  await exec(base, `INSERT INTO school (id, name, weekly_off) VALUES ('SCH', 'Test', '[]')`);
  await exec(base, `INSERT INTO family (id, name) VALUES ('F1', 'Khan')`);
  await exec(
    base,
    `INSERT INTO guardian (id, family_id, name, phone, cnic) VALUES ('G1', 'F1', 'Imran', '923001234567', '35202-1234567-1')`,
  );
  await exec(
    base,
    `INSERT INTO parent_link (id, guardian_id, token_hash, token_salt, pin_hash)
     VALUES ('L1', 'G1', 'hash-of-token', 'SECRET-SALT-VALUE', 'pin-hmac')`,
  );
  await exec(
    base,
    `INSERT INTO parent_link_access (id, link_id, ip_hash, ua) VALUES ('A1', 'L1', 'iphash', 'Android')`,
  );
});

async function pullAll(api: ReturnType<typeof client>, job: ExportJobDto) {
  const out = new Map<string, { columns: string[]; rows: unknown[][]; parts: number }>();
  for (const table of job.tables) {
    let after = 0;
    const acc = { columns: [] as string[], rows: [] as unknown[][], parts: 0 };
    for (;;) {
      const r = await api<ExportPartDto>(
        'GET',
        `/api/backup/export/${job.id}/part?table=${table}&after=${after}`,
      );
      expect(r.status, `${table} ${r.text}`).toBe(200);
      expect(r.body.rows.length).toBeLessThanOrEqual(EXPORT_PART_ROWS);
      acc.columns = r.body.columns;
      acc.rows.push(...r.body.rows);
      acc.parts++;
      if (r.body.next === null) break;
      after = r.body.next;
    }
    out.set(table, acc);
  }
  return out;
}

describe('download everything', () => {
  it('owner only; never sessions or the access log; parent links as hashes only', async () => {
    const admin = await signedInAs(base, ['admin']);
    expect((await client(t.request, admin.cookie)('POST', '/api/backup/export')).status).toBe(403);

    const start = await ownerApi<ExportJobDto>('POST', '/api/backup/export');
    expect(start.status).toBe(201);
    const job = start.body;
    expect(job.tables).not.toContain('user_session');
    expect(job.tables).not.toContain('parent_link_access');
    for (const tbl of [
      'student',
      'guardian',
      'receipt',
      'message',
      'message_template',
      'parent_link',
      'audit',
    ])
      expect(job.tables).toContain(tbl);
    expect(job.tables.some((x) => x.startsWith('sqlite_') || x.startsWith('_cf_'))).toBe(false);
    expect(job.schema).toContain('CREATE TABLE');
    expect(job.schema).toContain('CREATE VIEW');
    expect(job.schema).toContain('CREATE TRIGGER');

    // A table outside the job (here: the excluded ones) is refused, never read.
    for (const tbl of [
      'user_session',
      'parent_link_access',
      'sqlite_master',
      'x"; DROP TABLE student; --',
    ]) {
      const r = await ownerApi(
        'GET',
        `/api/backup/export/${job.id}/part?table=${encodeURIComponent(tbl)}`,
      );
      expect(r.status, tbl).toBe(400);
    }

    const data = await pullAll(ownerApi, job);
    const link = data.get('parent_link');
    expect(link?.columns).toContain('token_hash');
    expect(link?.columns).toContain('pin_hash');
    expect(link?.columns).not.toContain('token_salt');
    // The owner gets the full CNIC (backup.manage is owner-only).
    const g = data.get('guardian');
    const cnicAt = g?.columns.indexOf('cnic') ?? -1;
    expect(g?.rows[0]?.[cnicAt]).toBe('35202-1234567-1');

    const everything = JSON.stringify([...data.values()]);
    for (const secret of [SECRET, PARENT_SECRET, REPORT_TOKEN, 'SECRET-SALT-VALUE', 'iphash'])
      expect(everything.includes(secret), secret).toBe(false);
    const [sessionRow] = await base.all<{ id: string }>(sql`SELECT id FROM user_session LIMIT 1`);
    expect(sessionRow).toBeDefined();
    expect(everything.includes(sessionRow?.id ?? '???')).toBe(false);

    // Audited, start and finish; a finished job serves no more parts.
    const fin = await ownerApi('POST', `/api/backup/export/${job.id}/finish`, {
      rows: 10,
      files: 3,
    });
    expect(fin.status).toBe(200);
    const audit = await base.all<{ action: string }>(
      sql`SELECT action FROM audit WHERE entity = 'export_job' ORDER BY at, id`,
    );
    expect(audit.map((a) => a.action)).toEqual(['start', 'finish']);
    const again = await ownerApi('GET', `/api/backup/export/${job.id}/part?table=family`);
    expect(again.status).toBe(409);
  });

  it('pages by rowid in parts of ≤ 200 rows with a bounded number of reads each', async () => {
    await exec(
      base,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 450)
       INSERT INTO family (id, name) SELECT printf('FAM%04d', i), 'F' || i FROM n`,
    );
    const job = (await ownerApi<ExportJobDto>('POST', '/api/backup/export')).body;
    const seen: string[] = [];
    let after = 0;
    let parts = 0;
    for (;;) {
      counter.state.reads = 0;
      const r = await ownerApi<ExportPartDto>(
        'GET',
        `/api/backup/export/${job.id}/part?table=family&after=${after}`,
      );
      expect(r.status).toBe(200);
      // job + columns + one page; the session lookup goes through the query builder.
      expect(counter.state.reads).toBeLessThanOrEqual(3);
      const idAt = r.body.columns.indexOf('id');
      seen.push(...r.body.rows.map((row) => String(row[idAt])));
      parts++;
      if (r.body.next === null) break;
      after = r.body.next;
    }
    expect(parts).toBe(3); // 451 rows: 200 + 200 + 51
    expect(new Set(seen).size).toBe(451);
  });

  it("another owner's job is not found, an expired one is refused", async () => {
    const job = (await ownerApi<ExportJobDto>('POST', '/api/backup/export')).body;
    const other = await signedInAs(base, ['owner']);
    const r = await client(t.request, other.cookie)(
      'GET',
      `/api/backup/export/${job.id}/part?table=family`,
    );
    expect(r.status).toBe(404);
    await exec(base, `UPDATE export_job SET created_at = '2020-01-01T00:00:00.000Z'`);
    expect((await ownerApi('GET', `/api/backup/export/${job.id}/part?table=family`)).status).toBe(
      409,
    );
  });
});

describe('backup runs (GitHub Actions report)', () => {
  const run = {
    kind: 'nightly',
    status: 'partial',
    object_key: 'daily/2026-10-13.sql.gz.age',
    bytes: 123456,
    sha256: 'a'.repeat(64),
    targets: [
      { name: 'r2', ok: true },
      { name: 'b2', ok: false, detail: 'skipped: no B2 secrets' },
    ],
  };

  it('needs the token: no session, wrong token, or no secret on the Worker are refused', async () => {
    const anon = client(t.request, null);
    expect((await anon('POST', '/api/backup/runs', run)).status).toBe(401);
    expect(
      (await anon('POST', '/api/backup/runs', run, { authorization: 'Bearer wrong-token' })).status,
    ).toBe(401);
    // An owner's session is not the token.
    expect((await ownerApi('POST', '/api/backup/runs', run)).status).toBe(401);
    const closed = testApp({ db: base, env: { BACKUP_REPORT_TOKEN: '' } });
    const r = await client(closed.request, null)('POST', '/api/backup/runs', run, {
      authorization: `Bearer ${REPORT_TOKEN}`,
    });
    expect(r.status).toBe(503);
    expect(
      (
        await anon(
          'POST',
          '/api/backup/runs',
          { ...run, status: 'great' },
          {
            authorization: `Bearer ${REPORT_TOKEN}`,
          },
        )
      ).status,
    ).toBe(400);
  });

  it('records a run the status page then shows, with the R2 listing and a manual drill', async () => {
    const ok = await client(t.request, null)('POST', '/api/backup/runs', run, {
      authorization: `Bearer ${REPORT_TOKEN}`,
    });
    expect(ok.status).toBe(201);
    const objects = [
      { key: 'daily/2026-10-12.sql.gz.age', size: 10, uploaded: new Date('2026-10-12T21:40:00Z') },
      {
        key: 'daily/2026-10-12.sql.gz.age.sha256',
        size: 1,
        uploaded: new Date('2026-10-12T21:40:00Z'),
      },
      { key: 'daily/2026-10-13.sql.gz.age', size: 11, uploaded: new Date('2026-10-13T21:40:00Z') },
    ];
    const bucket = { list: async () => ({ objects, truncated: false }) } as unknown as R2Bucket;
    const withR2 = testApp({ db: base, env: { BACKUPS: bucket } });
    const api = client(withR2.request, owner.cookie);
    const drill = await api('POST', '/api/backup/drills', { date: '2026-10-01', note: 'term 1' });
    expect(drill.status).toBe(201);
    const s = await api<BackupStatusDto>('GET', '/api/backup/status');
    expect(s.status).toBe(200);
    expect(s.body.last_nightly).toMatchObject({ status: 'partial', bytes: 123456 });
    expect(s.body.last_nightly?.targets).toHaveLength(2);
    expect(s.body.last_drill).toMatchObject({ kind: 'manual_drill', note: 'term 1' });
    expect(s.body.objects?.map((o) => o.key)).toEqual([
      'daily/2026-10-13.sql.gz.age',
      'daily/2026-10-12.sql.gz.age',
    ]);
    expect(s.body.report_configured).toBe(true);
    // No binding: objects null, not an error.
    const plain = await ownerApi<BackupStatusDto>('GET', '/api/backup/status');
    expect(plain.body.objects).toBeNull();
  });
});

describe('backup report payloads (strict, 8 KB)', () => {
  const auth = { authorization: `Bearer ${REPORT_TOKEN}` };
  const good = {
    kind: 'nightly',
    status: 'ok',
    started_at: '2026-10-13T21:30:00Z',
    finished_at: '2026-10-13T21:41:07.123Z',
    object_key: 'daily/2026-10-14.sql.gz.age',
    bytes: 1000,
    sha256: 'b'.repeat(64),
    details: { backup_enabled: true, size_check: 'ok', counts: { students: 3 } },
  };
  const post = (body: unknown, h: Record<string, string> = auth) =>
    client(t.request, null)<{ error?: { code: string } }>('POST', '/api/backup/runs', body, h);

  it('accepts a well-formed run and stores details whole', async () => {
    expect((await post(good)).status).toBe(201);
    const [row] = await base.all<{ details: string }>(sql`SELECT details FROM backup_run`);
    expect(JSON.parse(row?.details ?? 'null')).toEqual(good.details);
  });

  it('refuses non-ISO datetimes, unknown keys, out-of-range sizes and bad keys', async () => {
    for (const bad of [
      { ...good, started_at: '13/10/2026 21:30' },
      { ...good, finished_at: '2026-10-13' },
      { ...good, extra: 1 },
      { ...good, bytes: -1 },
      { ...good, bytes: 20_000_000_000 },
      { ...good, bytes: 1.5 },
      { ...good, object_key: '../etc/passwd x' },
      { ...good, targets: [{ name: 'r2', ok: true, surprise: 1 }] },
    ]) {
      const r = await post(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await base.all(sql`SELECT id FROM backup_run`)).toEqual([]);
  });

  it('a body over 8 KB is a 400, never a truncated row', async () => {
    const big = { ...good, details: { blob: 'x'.repeat(400), more: 'y'.repeat(8000) } };
    const r = await post(big);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('too_large');
    expect(await base.all(sql`SELECT id FROM backup_run`)).toEqual([]);
    // The manual drill too (owner session), and a date that is not on the calendar.
    expect(
      (await ownerApi('POST', '/api/backup/drills', { date: '2026-10-01', note: 'n'.repeat(9000) }))
        .status,
    ).toBe(400);
    expect((await ownerApi('POST', '/api/backup/drills', { date: '2026-02-30' })).status).toBe(400);
  });
});

describe('alarms endpoints', () => {
  it('backup_stale shows in the live panel once backups are set up', async () => {
    const auth = { authorization: `Bearer ${REPORT_TOKEN}` };
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const r = await client(t.request, null)(
      'POST',
      '/api/backup/runs',
      { kind: 'nightly', status: 'ok', finished_at: old, details: { backup_enabled: true } },
      auth,
    );
    expect(r.status).toBe(201);
    const live = await ownerApi<AlarmsDto>('GET', '/api/alarms');
    expect(live.body.alarms.find((a) => a.kind === 'backup_stale')).toMatchObject({
      count: 1,
      since: old,
    });
  });

  it('live evaluation, latest daily event and acknowledge', async () => {
    const live = await ownerApi<AlarmsDto>('GET', '/api/alarms');
    expect(live.status).toBe(200);
    expect(live.body.total).toBe(0);
    expect(live.body.alarms).toHaveLength(7);
    expect((await ownerApi<{ event: null }>('GET', '/api/alarms/latest')).body.event).toBeNull();
    await exec(
      base,
      `INSERT INTO alarm_event (day, total, alarms) VALUES ('2026-10-13', 1, '[{"kind":"messages_stuck","count":2,"sample":[]}]')`,
    );
    const latest = await ownerApi<{ event: { total: number; acknowledged_at: string | null } }>(
      'GET',
      '/api/alarms/latest',
    );
    expect(latest.body.event).toMatchObject({ total: 1, acknowledged_at: null });
    expect((await ownerApi('POST', '/api/alarms/2026-10-13/ack')).status).toBe(200);
    const after = await ownerApi<{ event: { acknowledged_at: string | null } }>(
      'GET',
      '/api/alarms/latest',
    );
    expect(after.body.event.acknowledged_at).not.toBeNull();
    expect((await ownerApi('POST', '/api/alarms/2026-10-14/ack')).status).toBe(404);
  });
});

describe('recycle bin', () => {
  beforeEach(async () => {
    await exec(base, `INSERT INTO programme (id, name, kind) VALUES ('P1', 'Class 1', 'grade')`);
    await exec(
      base,
      `INSERT INTO grp (id, programme_id, name) VALUES ('GA', 'P1', 'A'), ('GB', 'P1', 'B')`,
    );
    await exec(
      base,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S1', 'F1', 'A1', 'Ali', '2026-04-01')`,
    );
    await exec(
      base,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('E1', 'S1', 'GB', 1, '2026-04-01')`,
    );
  });

  it('archives an empty group, refuses one with enrolments, and restores it (FK safe)', async () => {
    expect((await ownerApi('POST', '/api/groups/GB/archive')).status).toBe(409);
    expect((await ownerApi('POST', '/api/groups/GA/archive')).status).toBe(200);
    const list = await ownerApi<{ items: { id: string }[] }>('GET', '/api/groups');
    expect(list.body.items.map((g) => g.id)).toEqual(['GB']);
    const bin = await ownerApi<RecycleBinDto>('GET', '/api/recycle-bin');
    expect(bin.body.items).toEqual([
      expect.objectContaining({ kind: 'group', id: 'GA', name: 'Class 1 · A' }),
    ]);
    // Its programme in the bin too: the group cannot come back before it.
    expect((await ownerApi('DELETE', '/api/programmes/P1')).status).toBe(200);
    expect(
      (await ownerApi('POST', '/api/recycle-bin/restore', { kind: 'group', id: 'GA' })).status,
    ).toBe(409);
    // The enrolled group still points at the soft-deleted programme: nothing dangles.
    const [fk] = await base.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM pragma_foreign_key_check`,
    );
    expect(Number(fk?.n)).toBe(0);
    expect(
      (await ownerApi('POST', '/api/recycle-bin/restore', { kind: 'programme', id: 'P1' })).status,
    ).toBe(200);
    expect(
      (await ownerApi('POST', '/api/recycle-bin/restore', { kind: 'group', id: 'GA' })).status,
    ).toBe(200);
    expect((await ownerApi<RecycleBinDto>('GET', '/api/recycle-bin')).body.items).toEqual([]);
    const actions = await base.all<{ action: string }>(
      sql`SELECT action FROM audit WHERE entity IN ('grp', 'programme') ORDER BY at, id`,
    );
    expect(actions.map((a) => a.action)).toEqual(['archive', 'delete', 'restore', 'restore']);
  });

  it('restores subjects and fee heads; a name already in use blocks a restore', async () => {
    await exec(
      base,
      `INSERT INTO subject (id, name, deleted_at) VALUES ('SUB1', 'Maths', '2026-10-01')`,
    );
    await exec(base, `INSERT INTO subject (id, name) VALUES ('SUB2', 'maths')`);
    await exec(
      base,
      `INSERT INTO fee_head (id, name, kind, cadence, archived_at) VALUES ('H1', 'Lab', 'misc', 'once', '2026-10-01')`,
    );
    const bin = await ownerApi<RecycleBinDto>('GET', '/api/recycle-bin');
    expect(bin.body.items.map((i) => `${i.kind}:${i.id}`).sort()).toEqual([
      'fee_head:H1',
      'subject:SUB1',
    ]);
    const dup = await ownerApi<{ error: { code: string } }>('POST', '/api/recycle-bin/restore', {
      kind: 'subject',
      id: 'SUB1',
    });
    expect(dup.body.error.code).toBe('name_taken');
    expect(
      (await ownerApi('POST', '/api/recycle-bin/restore', { kind: 'fee_head', id: 'H1' })).status,
    ).toBe(200);
    expect(
      (await ownerApi('POST', '/api/recycle-bin/restore', { kind: 'fee_head', id: 'H1' })).status,
    ).toBe(404);
  });

  it('archive race: an enrolment landing after the check makes it a 409, nothing archived', async () => {
    // Between the "in use?" read and the guarded UPDATE, an admission enrols a student into GA.
    const racing = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'all')
          return async (...args: Parameters<AppDb['all']>) => {
            const out = await target.all(...args);
            const q = JSON.stringify(args[0]);
            if (q.includes('att_register') && q.includes('count(*)'))
              await exec(
                target,
                `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, status)
                 VALUES ('E9', 'S1', 'GA', 0, '2026-04-01', 'active')`,
              );
            return out;
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const app = testApp({ db: racing as AppDb });
    const r = await client(app.request, owner.cookie)<{ error: { code: string } }>(
      'POST',
      '/api/groups/GA/archive',
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('in_use');
    const [g] = await base.all<{ archived_at: string | null }>(
      sql`SELECT archived_at FROM grp WHERE id = 'GA'`,
    );
    expect(g?.archived_at).toBeNull();
    expect(await base.all(sql`SELECT id FROM audit WHERE entity = 'grp'`)).toEqual([]);
    // The trigger is the backstop for any other writer.
    expect(
      await refusal(base, `UPDATE grp SET archived_at = '2026-10-13' WHERE id = 'GA'`),
    ).toMatch(/group_in_use/);
  });

  it('an archived group takes no enrolment: API paths, promotion target and the trigger', async () => {
    // API bodies take ULIDs: a group, a student and an enrolment of our own.
    const G = '01K0000000000000000000GRPA';
    const G2 = '01K0000000000000000000GRPB';
    const ST = '01K00000000000000000000STA';
    const EN = '01K00000000000000000000ENA';
    const PR = '01K00000000000000000000PRA';
    await exec(base, `INSERT INTO programme (id, name, kind) VALUES ('${PR}', 'Class 9', 'grade')`);
    await exec(
      base,
      `INSERT INTO grp (id, programme_id, name) VALUES ('${G}', '${PR}', 'A'), ('${G2}', '${PR}', 'B')`,
    );
    await exec(
      base,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('${ST}', 'F1', 'A9', 'Sara', '2026-04-01')`,
    );
    await exec(
      base,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('${EN}', '${ST}', '${G2}', 1, '2026-04-01')`,
    );
    expect((await ownerApi('POST', `/api/groups/${G}/archive`)).status).toBe(200);
    type Err = { error: { code: string; message: string } };
    const enrol = await ownerApi<Err>('POST', '/api/enrolments', {
      student_id: ST,
      grp_id: G,
      start_date: '2026-10-01',
    });
    expect(enrol.status).toBe(400);
    expect(enrol.body.error.message).toBe('Unknown group');
    const transfer = await ownerApi<Err>('POST', `/api/enrolments/${EN}/transfer`, {
      grp_id: G,
      date: '2026-10-01',
      reason: 'section change',
    });
    expect(transfer.status, transfer.text).toBe(400);
    expect(transfer.body.error.message).toBe('Unknown group');
    const patch = await ownerApi<Err>('PATCH', `/api/groups/${G2}`, { next_grp_id: G });
    expect(patch.status).toBe(400);
    expect(patch.body.error.message).toMatch(/archived/);
    const create = await ownerApi<Err>('POST', '/api/groups', {
      programme_id: PR,
      name: 'C',
      next_grp_id: G,
    });
    expect(create.status).toBe(400);
    expect(create.body.error.message).toMatch(/archived/);
    expect(
      await refusal(
        base,
        `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('E8', 'S1', '${G}', 0, '2026-10-01')`,
      ),
    ).toMatch(/group_archived/);
    expect(await refusal(base, `UPDATE enrolment SET grp_id = '${G}' WHERE id = 'E1'`)).toMatch(
      /group_archived/,
    );
    // Restored, it takes enrolments and promotions again.
    expect(
      (await ownerApi('POST', '/api/recycle-bin/restore', { kind: 'group', id: G })).status,
    ).toBe(200);
    expect((await ownerApi('PATCH', `/api/groups/${G2}`, { next_grp_id: G })).status).toBe(200);
    const moved = await ownerApi('POST', `/api/enrolments/${EN}/transfer`, {
      grp_id: G,
      date: '2026-10-01',
      reason: 'section change',
    });
    expect(moved.status, moved.text).toBe(201);
  });

  it('restoring a fee head or group whose name is now in use is refused (groups per programme)', async () => {
    await exec(
      base,
      `INSERT INTO fee_head (id, name, kind, cadence, archived_at) VALUES ('H1', 'Lab', 'misc', 'once', '2026-10-01')`,
    );
    await exec(
      base,
      `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('H2', ' lab ', 'misc', 'once')`,
    );
    const fh = await ownerApi<{ error: { code: string } }>('POST', '/api/recycle-bin/restore', {
      kind: 'fee_head',
      id: 'H1',
    });
    expect(fh.status).toBe(409);
    expect(fh.body.error.code).toBe('name_taken');

    expect((await ownerApi('POST', '/api/groups/GA/archive')).status).toBe(200);
    await exec(base, `INSERT INTO programme (id, name, kind) VALUES ('P2', 'Class 2', 'grade')`);
    // Same name in another programme: no clash.
    await exec(base, `INSERT INTO grp (id, programme_id, name) VALUES ('GC', 'P2', 'A')`);
    expect(
      (await ownerApi('POST', '/api/recycle-bin/restore', { kind: 'group', id: 'GA' })).status,
    ).toBe(200);
    expect((await ownerApi('POST', '/api/groups/GA/archive')).status).toBe(200);
    // Same programme (and session): clash.
    await exec(base, `INSERT INTO grp (id, programme_id, name) VALUES ('GD', 'P1', 'a')`);
    const g = await ownerApi<{ error: { code: string } }>('POST', '/api/recycle-bin/restore', {
      kind: 'group',
      id: 'GA',
    });
    expect(g.status).toBe(409);
    expect(g.body.error.code).toBe('name_taken');
  });

  it('lists receipt series with the last number issued', async () => {
    await exec(base, `INSERT INTO receipt_series (series, year, next_no) VALUES ('R', 2026, 43)`);
    expect((await ownerApi('GET', '/api/receipt-series')).body).toEqual({
      items: [{ series: 'R', year: 2026, last_no: 42 }],
    });
  });

  it('retention setting round trip with bounds', async () => {
    expect((await ownerApi('GET', '/api/settings/retention')).body).toEqual({
      access_log_days: 90,
    });
    expect((await ownerApi('PUT', '/api/settings/retention', { access_log_days: 3 })).status).toBe(
      400,
    );
    expect(
      (await ownerApi('PUT', '/api/settings/retention', { access_log_days: 30 })).body,
    ).toEqual({ access_log_days: 30 });
    expect((await ownerApi('GET', '/api/settings/retention')).body).toEqual({
      access_log_days: 30,
    });
  });
});
