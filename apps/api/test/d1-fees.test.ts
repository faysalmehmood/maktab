import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AppDb,
  addConcession,
  applyLateFines,
  closeSession,
  collect,
  ensureSeries,
  ensureSessionStatement,
  generateCharges,
  getDb,
  recordOpeningBalance,
  regenerateForStudent,
  reverseReceipt,
  runScheduled,
  sessionIdFor,
  waiveFine,
} from '@maktab/db';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import { type AdmissionResult, type CollectResultDto, newId } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { todayPk } from '../src/lib/http';
import { signedInAs, testApp } from './helpers';

/**
 * M3 on workerd's real D1 (PLAN §15 standing rule: D1 behaviour is proven here, not on
 * better-sqlite3 alone): every fee helper's batch shape (json_each inserts, in-batch session and
 * series, subqueries in UPDATE, window functions in the cursor), and receipt numbering under 10
 * parallel collections.
 */
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
let db: AppDb;

const RS = (n: number) => n * 100;
const one = async <T>(q: ReturnType<typeof sql>) => (await db.all<T>(q))[0] as T;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(import.meta.dirname, '../wrangler.toml'),
    persist: false,
  });
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    const stmts = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gm, '').trim() !== '');
    await proxy.env.DB.batch(stmts.map((s) => proxy.env.DB.prepare(s)));
  }
  db = getDb({ DB: proxy.env.DB });
  const fams = Array.from({ length: 10 }, (_, i) => `F${i}`);
  await proxy.env.DB.batch(
    [
      `INSERT INTO "user" (id, email, name, status) VALUES ('U1', 'a@x.pk', 'Admin', 'active')`,
      `INSERT INTO school (id, name, receipt_prefix, setup_completed_at, fine_rule) VALUES ('SCH', 'T', 'R', '2026-01-01', '{"enabled":true,"grace_day":10,"type":"pct","value":10,"cap":25000}')`,
      `INSERT INTO session (id, name, start_date, end_date, is_current) VALUES ('SES', 'S', '2026-01-01', '2027-12-31', 1)`,
      `INSERT INTO programme (id, name, kind) VALUES ('P', 'Class 5', 'grade')`,
      `INSERT INTO grp (id, programme_id, session_id, name) VALUES ('G', 'P', 'SES', 'A')`,
      `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI', 'Tuition', 'tuition', 'monthly')`,
      `INSERT INTO fee_rate (id, fee_head_id, programme_id, amount, effective_from) VALUES ('r', 'TUI', 'P', ${RS(3000)}, '2026-01-01')`,
      `INSERT INTO family (id, name) VALUES ${fams.map((f) => `('${f}', '${f}')`).join(',')}`,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ${fams.map((f, i) => `('S${i}', '${f}', 'A${i}', 'Kid ${i}', '2026-01-01')`).join(',')}, ('S10', 'F0', 'A10', 'Sib', '2026-01-01')`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ${[...fams.map((_, i) => `('E${i}', 'S${i}', 'G', 1, '2026-01-01')`), `('E10', 'S10', 'G', 1, '2026-01-01')`].join(',')}`,
      `INSERT INTO sponsor (id, name) VALUES ('SP', 'Trust')`,
      `INSERT INTO sponsorship (id, sponsor_id, student_id, share_pct, valid_from) VALUES ('SH', 'SP', 'S9', 50, '2026-01-01')`,
    ].map((q) => proxy.env.DB.prepare(q)),
  );
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

const consistency = () => db.all(sql`SELECT * FROM ledger_consistency`);

describe('fees on D1', () => {
  it('generation: dry run, commit in chunks, idempotent re-run, cursor done', async () => {
    const dry = await generateCharges(db, {
      period: '2026-10',
      scope: { grpId: 'G' },
      by: 'U1',
      dryRun: true,
    });
    expect(dry.planned).toHaveLength(12); // 11 family roots + 1 sponsor root
    const first = await generateCharges(db, {
      period: '2026-10',
      scope: { grpId: 'G' },
      by: 'U1',
      maxRows: 25,
    });
    expect(first.group_done).toBe(false);
    const rest = await generateCharges(db, {
      period: '2026-10',
      scope: { grpId: 'G', afterStudentId: first.next_student_id },
      by: 'U1',
    });
    expect(rest.group_done).toBe(true);
    expect(first.counts.fees + rest.counts.fees).toBe(11);
    const again = await generateCharges(db, { period: '2026-10', scope: { grpId: 'G' }, by: 'U1' });
    expect(again.counts).toEqual({ fees: 0, concessions: 0, sponsored: 0, allocations: 0 });
    expect(await one(sql`SELECT count(*) AS n FROM charge WHERE kind = 'fee'`)).toEqual({ n: 12 });
    // The cron's cursor (window function) agrees that the period is done.
    const cron = await runScheduled(db, { now: Date.UTC(2026, 9, 2) });
    expect(cron.generated).toEqual([]);
  });

  it('10 parallel collections: all succeed, receipt numbers contiguous, no gaps', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        collect(db, {
          payerType: 'family',
          // Two payments race on family F0 (two children), the rest on their own families.
          payerId: i < 2 ? 'F0' : `F${i - 1}`,
          amount: RS(2000),
          method: 'cash',
          businessDate: '2026-10-05',
          collectorId: 'U1',
          idempotencyKey: `k-${i}`,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.receipt_id)).size).toBe(10);
    const nos = (
      await db.all<{ receipt_no: string }>(sql`SELECT receipt_no FROM receipt ORDER BY receipt_no`)
    ).map((r) => r.receipt_no);
    expect(nos).toEqual(
      Array.from({ length: 10 }, (_, i) => `R-2026-${String(i + 1).padStart(5, '0')}`),
    );
    expect(
      await one(sql`SELECT next_no FROM receipt_series WHERE series = 'R' AND year = 2026`),
    ).toEqual({ next_no: 11 });
    expect(await one(sql`SELECT count(*) AS n FROM cash_session`)).toEqual({ n: 1 });
    // Replays return the same receipt and use no number.
    const replay = await collect(db, {
      payerType: 'family',
      payerId: 'F0',
      amount: RS(2000),
      method: 'cash',
      businessDate: '2026-10-05',
      collectorId: 'U1',
      idempotencyKey: 'k-0',
    });
    expect(replay).toEqual({ receipt_id: results[0]?.receipt_id, replayed: true });
    expect(await consistency()).toEqual([]);
  });

  it('reversal with session/series in the batch, fines + waiver, regenerate, opening credit, close', async () => {
    const [p] = await db.all<{ id: string }>(
      sql`SELECT id FROM receipt WHERE idempotency_key = 'k-2'`,
    );
    const series = { series: 'R', year: 2026 };
    const r = await reverseReceipt(db, {
      receiptId: p?.id as string,
      byUserId: 'U1',
      reason: 'wrong family',
      series,
      businessDate: '2026-10-06',
      prelude: [ensureSeries(series), ensureSessionStatement('U1', '2026-10-06')],
      cashSessionId: sessionIdFor('U1', '2026-10-06'),
    });
    expect(
      await one(
        sql`SELECT receipt_no, cash_session_id IS NOT NULL AS s FROM receipt WHERE id = ${r.reversalId}`,
      ),
    ).toEqual({ receipt_no: 'R-2026-00011', s: 1 });
    const f = await applyLateFines(db, { period: '2026-10', asOf: '2026-10-11', by: 'U1' });
    expect(f.applied).toBeGreaterThan(0);
    expect(await one(sql`SELECT max(amount) AS m FROM charge WHERE kind = 'fine'`)).toEqual({
      m: RS(250),
    }); // 10% capped
    const [fine] = await db.all<{ id: string }>(
      sql`SELECT id FROM charge WHERE kind = 'fine' ORDER BY id LIMIT 1`,
    );
    await waiveFine(db, { fineId: fine?.id as string, reason: 'ok', by: 'U1' });
    await addConcession(db, {
      studentId: 'S3',
      feeHeadId: null,
      type: 'pct',
      value: 50,
      reason: 'needy',
      approvedBy: 'U1',
      validFrom: '2026-10-01',
    });
    const rg = await regenerateForStudent(db, { studentId: 'S3', period: '2026-10', by: 'U1' });
    expect(rg.counts.late_concessions).toBe(1);
    await recordOpeningBalance(db, {
      studentId: 'S4',
      amount: -RS(700),
      asOf: '2026-09-30',
      by: 'U1',
    });
    expect(await one(sql`SELECT kind, amount FROM receipt WHERE kind = 'opening'`)).toEqual({
      kind: 'opening',
      amount: RS(700),
    });
    const [s] = await db.all<{ id: string }>(
      sql`SELECT id FROM cash_session WHERE business_date = '2026-10-05'`,
    );
    const closed = await closeSession(db, {
      sessionId: s?.id as string,
      counted: RS(19000),
      by: 'U1',
    });
    expect([closed.expected, closed.variance]).toEqual([RS(20000), -RS(1000)]);
    expect(await one(sql`SELECT count(*) AS n FROM audit WHERE action = 'close'`)).toEqual({
      n: 1,
    });
    expect(await consistency()).toEqual([]);
  });

  it('the routes run on D1: admission with fees in the batch, the counter, the print JSON', async () => {
    const t = testApp({ db });
    const owner = await signedInAs(db, ['owner']);
    const api = async <T>(method: string, path: string, body?: unknown) => {
      const res = await t.request(path, {
        method,
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as T };
    };
    const today = todayPk();
    const g = newId();
    await db.run(
      sql`INSERT INTO grp (id, programme_id, session_id, name) VALUES (${g}, 'P', 'SES', 'B')`,
    );
    const adm = await api<AdmissionResult>('POST', '/api/admissions', {
      family: { name: 'New' },
      guardians: [{ name: 'Abu', phone: '03001234567', consent_whatsapp: true }],
      student: { name: 'Newbie', admission_date: today },
      enrolment: { grp_id: g, start_date: today },
    });
    expect(adm.status).toBe(201);
    expect(adm.body.fees?.charges).toHaveLength(1);
    const r = await api<CollectResultDto>('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: adm.body.family_id,
      amount: RS(3500),
      method: 'cash',
    });
    expect(r.status).toBe(201);
    expect(r.body.receipt).toMatchObject({ allocated: RS(3000), unallocated: RS(500) });
    const print = await api<{
      labels: { ur: { title: string } };
      totals: { credit_added: number };
    }>('GET', `/api/receipts/${r.body.receipt.id}?format=print`);
    expect(print.body.labels.ur.title).toBe('فیس رسید');
    expect(print.body.totals.credit_added).toBe(RS(500));
    const rem = await api<{ queued: number }>('POST', '/api/fees/defaulters/remind', {});
    expect(rem.status).toBe(200);
    expect(await consistency()).toEqual([]);
  });
});
