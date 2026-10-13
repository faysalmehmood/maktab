import { createVerify, generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  buildTabs,
  chunkRows,
  karachiMonth,
  type Row,
  serviceAccountJwt,
} from '../scripts/sheet-export';
import { atomic, rawStatement } from '../src/client';
import { createTestDb } from '../src/node';

// M6: the nightly Google Sheet copy. Tabs from a fixture school; no CNIC / B-form ever leaves.

async function fixture() {
  const db = createTestDb();
  const qs = [
    `INSERT INTO user (id, email, name, status) VALUES ('U1', 'o@x.pk', 'Owner', 'active')`,
    `INSERT INTO family (id, name) VALUES ('F1', 'Khan')`,
    `INSERT INTO guardian (id, family_id, name, phone, cnic, consent_whatsapp) VALUES ('G1', 'F1', 'Imran', '923001234567', '35202-1234567-1', 1)`,
    `INSERT INTO programme (id, name, kind) VALUES ('P1', 'Class 1', 'grade')`,
    `INSERT INTO grp (id, programme_id, name) VALUES ('GA', 'P1', 'A')`,
    `INSERT INTO student (id, family_id, admission_no, name, admission_date, b_form_no) VALUES ('S1', 'F1', '2026-0001', 'Ali', '2026-04-01', '35202-7654321-1')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('E1', 'S1', 'GA', 1, '2026-04-01')`,
  ];
  await atomic(
    db,
    () => qs.map((q) => rawStatement(db, sql.raw(q))) as [ReturnType<typeof rawStatement>],
  );
  return db;
}

describe('sheet export', () => {
  it('builds the five tabs; guardians carry no CNIC, students no B-form', async () => {
    const db = await fixture();
    const tabs = await buildTabs((q) => db.all<Row>(sql.raw(q)), '2026-10');
    expect(tabs.map((t) => t.name)).toEqual([
      'students',
      'guardians',
      'dues_summary',
      'receipts_month',
      'attendance_month',
    ]);
    const [students, guardians, dues] = tabs;
    expect(students?.rows).toEqual([
      ['2026-0001', 'Ali', null, null, 'active', 'Khan', 'Class 1 · A', '2026-04-01', null],
    ]);
    expect(guardians?.header).not.toContain('cnic');
    expect(guardians?.rows).toEqual([['Khan', 'Imran', null, '923001234567', null, 'yes', 'ur']]);
    expect(dues?.rows).toEqual([['Khan', 1, 0, 0, 0]]);
    const all = JSON.stringify(tabs);
    expect(all).not.toContain('35202-1234567-1');
    expect(all).not.toContain('35202-7654321-1');
  });

  it('chunks rows so no request passes 2 MB', () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => [i, 'x'.repeat(200), null]);
    const parts = chunkRows(rows);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat().length).toBe(30_000);
    for (const p of parts)
      expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(2 * 1024 * 1024);
  });

  it('signs a service-account JWT that verifies with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = serviceAccountJwt(
      {
        client_email: 'sa@p.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      1_700_000_000,
    );
    const [h, c, s] = jwt.split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s ?? '', 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(c ?? '', 'base64url').toString())).toMatchObject({
      iss: 'sa@p.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      exp: 1_700_003_600,
    });
  });

  it('this month is the Karachi month', () => {
    expect(karachiMonth(Date.parse('2026-10-31T20:00:00Z'))).toBe('2026-11');
  });
});
