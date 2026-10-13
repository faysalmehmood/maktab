/**
 * Nightly read-only Google Sheet copy (PLAN §9 layer 3), run by .github/workflows/nightly-backup.yml
 * when the GOOGLE_SA_JSON and SHEET_ID secrets exist. School-side setup: docs/backup.md.
 *
 *   node --experimental-strip-types packages/db/scripts/sheet-export.ts --dump dump.sql [--dry-run]
 *   (or npx tsx …). Env: GOOGLE_SA_JSON (the service-account key JSON), SHEET_ID.
 *
 * Reads the plain-text D1 dump the workflow just exported (before it is encrypted) into an in-memory
 * SQLite (`node:sqlite`, no native module, no extra D1 reads), builds five tabs and writes each with
 * `values.clear` + `values.update` (valueInputOption RAW: a cell is never parsed as a formula),
 * in requests of at most 2 MB. Tabs: students, guardians (no CNIC), dues_summary, receipts_month,
 * attendance_month. The sheet is a copy for reading; D1 stays the system of record.
 *
 * No dependencies beyond Node 22: the service-account JWT is signed with node:crypto (RS256).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export type Tab = { name: string; header: string[]; rows: Cell[][] };
export type Query = (sql: string) => Row[] | Promise<Row[]>;

/** Paisa → rupees (2 decimals only when there are paisa). */
const rs = (p: unknown) => {
  const n = Number(p ?? 0) / 100;
  return Number.isInteger(n) ? n : Math.round(n * 100) / 100;
};

/** "This month" in Asia/Karachi (UTC+5): the receipts and attendance tabs cover it. */
export const karachiMonth = (now = Date.now()) =>
  new Date(now + 5 * 3_600_000).toISOString().slice(0, 7);

const asRows = (rows: Row[], cols: string[]): Cell[][] =>
  rows.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c]) as Cell));

/** The five tabs, from any SQLite holding the Maktab schema (the dump, or a test database). */
export async function buildTabs(query: Query, month = karachiMonth()): Promise<Tab[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`bad month ${month}`);
  const students = await query(`
    SELECT s.admission_no, s.name, s.father_name, s.gender, s.status, f.name AS family,
           (SELECT p.name || ' · ' || g.name FROM enrolment e JOIN grp g ON g.id = e.grp_id
              JOIN programme p ON p.id = g.programme_id
            WHERE e.student_id = s.id AND e.status = 'active' AND e.is_primary = 1 LIMIT 1) AS class,
           s.admission_date, s.left_date
    FROM student s JOIN family f ON f.id = s.family_id
    WHERE f.deleted_at IS NULL
    ORDER BY s.status, class, s.name`);
  const guardians = await query(`
    SELECT f.name AS family, g.name, g.relation, g.phone, g.whatsapp,
           CASE g.consent_whatsapp WHEN 1 THEN 'yes' ELSE 'no' END AS whatsapp_consent, g.lang
    FROM guardian g JOIN family f ON f.id = g.family_id
    WHERE f.deleted_at IS NULL ORDER BY f.name, g.priority, g.name`);
  const dues = await query(`
    SELECT f.name AS family,
           (SELECT count(*) FROM student s WHERE s.family_id = f.id AND s.status = 'active') AS students,
           coalesce((SELECT sum(cs.due) FROM charge_status cs
                     WHERE cs.payer_type = 'family' AND cs.payer_id = f.id AND cs.due > 0), 0) AS due,
           coalesce((SELECT pc.credit FROM payer_credit pc
                     WHERE pc.payer_type = 'family' AND pc.payer_id = f.id), 0) AS credit
    FROM family f WHERE f.deleted_at IS NULL ORDER BY f.name`);
  const receipts = await query(`
    SELECT r.receipt_no, r.business_date, r.kind, r.method, r.amount,
           coalesce(f.name, sp.name, r.payer_id) AS payer, r.payer_type, u.name AS collector
    FROM receipt r
    LEFT JOIN family f ON r.payer_type = 'family' AND f.id = r.payer_id
    LEFT JOIN sponsor sp ON r.payer_type = 'sponsor' AND sp.id = r.payer_id
    LEFT JOIN user u ON u.id = r.collector_id
    WHERE substr(r.business_date, 1, 7) = '${month}'
    ORDER BY r.business_date, r.receipt_no`);
  const attendance = await query(`
    SELECT s.admission_no, s.name, p.name || ' · ' || g.name AS class,
           sum(m.status = 'P') AS present, sum(m.status = 'A') AS absent,
           sum(m.status = 'L') AS late, sum(m.status = 'E') AS leave, count(*) AS marked
    FROM current_register c
    JOIN att_mark m ON m.register_id = c.register_id
    JOIN student s ON s.id = m.student_id
    JOIN grp g ON g.id = c.grp_id JOIN programme p ON p.id = g.programme_id
    WHERE substr(c.date, 1, 7) = '${month}' AND c.grp_subject_id = ''
    GROUP BY s.id, g.id ORDER BY class, s.name`);

  return [
    {
      name: 'students',
      header: [
        'admission_no',
        'name',
        'father_name',
        'gender',
        'status',
        'family',
        'class',
        'admission_date',
        'left_date',
      ],
      rows: asRows(students, [
        'admission_no',
        'name',
        'father_name',
        'gender',
        'status',
        'family',
        'class',
        'admission_date',
        'left_date',
      ]),
    },
    {
      name: 'guardians',
      header: ['family', 'name', 'relation', 'phone', 'whatsapp', 'whatsapp_consent', 'lang'],
      rows: asRows(guardians, [
        'family',
        'name',
        'relation',
        'phone',
        'whatsapp',
        'whatsapp_consent',
        'lang',
      ]),
    },
    {
      name: 'dues_summary',
      header: ['family', 'active_students', 'due_rs', 'credit_rs', 'net_due_rs'],
      rows: dues.map((d) => [
        d.family ?? null,
        Number(d.students ?? 0),
        rs(d.due),
        rs(d.credit),
        rs(Math.max(0, Number(d.due ?? 0) - Number(d.credit ?? 0))),
      ]),
    },
    {
      name: 'receipts_month',
      header: [
        'receipt_no',
        'date',
        'kind',
        'method',
        'amount_rs',
        'payer',
        'payer_type',
        'collector',
      ],
      rows: receipts.map((r) => [
        r.receipt_no ?? null,
        r.business_date ?? null,
        r.kind ?? null,
        r.method ?? null,
        rs(r.amount),
        r.payer ?? null,
        r.payer_type ?? null,
        r.collector ?? null,
      ]),
    },
    {
      name: 'attendance_month',
      header: ['admission_no', 'name', 'class', 'present', 'absent', 'late', 'leave', 'marked'],
      rows: asRows(attendance, [
        'admission_no',
        'name',
        'class',
        'present',
        'absent',
        'late',
        'leave',
        'marked',
      ]),
    },
  ];
}

export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** Splits rows so each `values.update` body stays under the limit (JSON size, with headroom). */
export function chunkRows(rows: Cell[][], limit = MAX_REQUEST_BYTES - 64 * 1024): Cell[][][] {
  const out: Cell[][][] = [];
  let cur: Cell[][] = [];
  let size = 0;
  for (const r of rows) {
    const n = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (cur.length && size + n > limit) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---- Google Sheets ---------------------------------------------------------------------------

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function serviceAccountJwt(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: serviceAccountJwt(sa),
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`token: ${res.status} ${body.error ?? ''}`);
  return body.access_token;
}

async function writeTabs(sheetId: string, token: string, tabs: Tab[], stamp: string) {
  const api = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(
        `${method} ${url.replace(api, '')}: ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    return res.json() as Promise<Record<string, unknown>>;
  };
  const meta = (await call('GET', `${api}?fields=sheets.properties.title`)) as {
    sheets?: { properties: { title: string } }[];
  };
  const have = new Set((meta.sheets ?? []).map((s) => s.properties.title));
  const missing = tabs.filter((t) => !have.has(t.name));
  if (missing.length)
    await call('POST', `${api}:batchUpdate`, {
      requests: missing.map((t) => ({ addSheet: { properties: { title: t.name } } })),
    });
  for (const tab of tabs) {
    const range = (a1: string) => encodeURIComponent(`'${tab.name}'!${a1}`);
    await call('POST', `${api}/values/${range('A:ZZ')}:clear`, {});
    const all = [
      [`Maktab copy, read-only. Updated ${stamp}. Edit in Maktab, not here.`],
      tab.header,
      ...tab.rows,
    ];
    let start = 1;
    for (const part of chunkRows(all)) {
      await call('PUT', `${api}/values/${range(`A${start}`)}?valueInputOption=RAW`, {
        values: part.map((r) => r.map((c) => (c === null ? '' : c))),
      });
      start += part.length;
    }
    console.log(`${tab.name}: ${tab.rows.length} rows`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--dump');
  const dumpPath = at >= 0 ? args[at + 1] : undefined;
  if (!dumpPath) throw new Error('usage: sheet-export.ts --dump dump.sql [--dry-run]');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(dumpPath, 'utf8'));
  const tabs = await buildTabs((q) => db.prepare(q).all() as Row[]);
  if (args.includes('--dry-run')) {
    for (const t of tabs) console.log(`${t.name}: ${t.rows.length} rows`);
    return;
  }
  const raw = process.env.GOOGLE_SA_JSON;
  const sheetId = process.env.SHEET_ID;
  if (!raw || !sheetId) throw new Error('GOOGLE_SA_JSON and SHEET_ID are required');
  const sa = JSON.parse(raw) as ServiceAccount;
  await writeTabs(sheetId, await accessToken(sa), tabs, new Date().toISOString());
}

if (process.argv[1]?.endsWith('sheet-export.ts')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
