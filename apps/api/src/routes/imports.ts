import { type AppDb, customField, grp, guardian, programme, session, student } from '@maktab/db';
import {
  customValueError,
  IMPORT_CHUNK_ROWS,
  IMPORT_COLUMNS,
  IMPORT_MAX_ROWS,
  type ImportReport,
  type ImportRowReport,
  importHeaderKey,
  importTemplateHeader,
  isoDateSchema,
  newId,
  normalizePkMobile,
  normalizePkPhone,
  parseCsv,
  parseGender,
  parseYesNo,
  toCsvLine,
} from '@maktab/shared';
import { asc, eq, ne, type SQL, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../env';
import { b64urlEncode, utf8 } from '../lib/b64';
import { ApiError, dbConflict } from '../lib/errors';
import { todayPk, userId } from '../lib/http';
import { auditSql, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { bumpAdmissionSeries } from './admissions';

const MAX_CSV_BYTES = 2 * 1024 * 1024;

type Extra = Record<string, string | number | boolean | null>;

/** A validated row, ready to insert. Ids are minted at planning time (before any batch). */
type Planned = {
  hash: string;
  row_no: number;
  family_id: string;
  new_family: 0 | 1;
  family_name: string;
  address: string | null;
  area: string | null;
  guardian_id: string;
  g_name: string;
  g_relation: string | null;
  g_phone: string;
  g_whatsapp: string | null;
  g_consent: 0 | 1;
  student_id: string;
  name: string;
  father_name: string | null;
  dob: string | null;
  gender: 'm' | 'f' | null;
  b_form_no: string | null;
  admission_no: string | null;
  admission_date: string;
  extra: Extra | null;
  year: string;
  enrolment_id: string;
  grp_id: string;
  roll_no: string | null;
  audit_id: string;
  import_row_id: string;
  // Filled per chunk: k-th auto number of n in its year; roll ordinal within its group.
  n: number;
  k: number;
  roll_k: number;
};

async function sha256(text: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', utf8(text)));
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

async function readCsvText(c: Context<AppEnv>): Promise<{ text: string; fileName: string | null }> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_CSV_BYTES) throw new ApiError(413, 'too_large', 'CSV must be at most 2 MB');
  const type = c.req.header('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File))
      throw new ApiError(400, 'invalid', 'Expected a multipart field "file"');
    if (file.size > MAX_CSV_BYTES) throw new ApiError(413, 'too_large', 'CSV must be at most 2 MB');
    return { text: await file.text(), fileName: file.name || null };
  }
  const text = await c.req.text();
  if (text.length > MAX_CSV_BYTES) throw new ApiError(413, 'too_large', 'CSV must be at most 2 MB');
  return { text, fileName: null };
}

/** Group lookup by "name" or "programme name" (any of ' ', '-', '/' between) in open groups. */
async function groupIndex(db: AppDb) {
  const rows = await db
    .select({
      id: grp.id,
      name: grp.name,
      programmeName: programme.name,
      sessionStart: session.startDate,
      isCurrent: session.isCurrent,
      capacity: grp.capacity,
    })
    .from(grp)
    .innerJoin(programme, eq(programme.id, grp.programmeId))
    .leftJoin(session, eq(session.id, grp.sessionId))
    .where(ne(grp.status, 'closed'));
  // Groups of other (past/future) sessions only match when nothing in the current one does.
  const current = rows.filter((r) => r.isCurrent || r.sessionStart === null);
  const pool = current.length ? current : rows;
  const index = new Map<string, typeof rows>();
  for (const r of pool) {
    const keys = new Set([
      norm(r.name),
      ...[' ', '-', '/', ' - ', ' / '].map((sep) => norm(`${r.programmeName}${sep}${r.name}`)),
    ]);
    for (const k of keys) index.set(k, [...(index.get(k) ?? []), r]);
  }
  return index;
}

/** Validates every row and plans what commit would do. Pure reads; dry run stops here. */
async function plan(db: AppDb, text: string) {
  const table = parseCsv(text);
  const [header, ...body] = table;
  if (!header) throw new ApiError(400, 'invalid', 'The CSV is empty');
  if (body.length > IMPORT_MAX_ROWS) {
    throw new ApiError(400, 'invalid', `At most ${IMPORT_MAX_ROWS} rows per file; split it`);
  }
  const keys = header.map(importHeaderKey);
  const fields = await db.select().from(customField).where(eq(customField.entity, 'student'));
  const known = new Set<string>(IMPORT_COLUMNS.map((c) => c.key));
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  const unknownCols = keys.filter((k) => k && !known.has(k) && !fieldByKey.has(k));
  if (unknownCols.length) {
    throw new ApiError(400, 'invalid', `Unknown columns: ${unknownCols.join(', ')}`);
  }
  const missing = IMPORT_COLUMNS.filter((c) => c.required && !keys.includes(c.key));
  if (missing.length) {
    throw new ApiError(400, 'invalid', `Missing columns: ${missing.map((c) => c.key).join(', ')}`);
  }

  const groups = await groupIndex(db);
  const [cur] = await db
    .select({ start: session.startDate })
    .from(session)
    .where(eq(session.isCurrent, true));
  const today = todayPk();
  const seenAdmissionNos = new Map<string, number>();
  const seenHashes = new Set<string>();

  type Draft = {
    report: ImportRowReport;
    planned?: Omit<Planned, 'family_id' | 'new_family' | 'n' | 'k' | 'roll_k'>;
  };
  const drafts: Draft[] = [];

  for (const [i, cells] of body.entries()) {
    const rowNo = i + 1;
    const get = (k: string) => (cells[keys.indexOf(k)] ?? '').trim();
    const errors: string[] = [];
    const warnings: string[] = [];
    const name = get('student_name');
    if (!name) errors.push('student_name: required');
    const fatherName = get('father_name') || null;
    const gender = parseGender(get('gender'));
    if (gender === undefined) errors.push('gender: use m or f');
    const dateCell = (k: string) => {
      const v = get(k);
      if (!v) return null;
      if (!isoDateSchema.safeParse(v).success) {
        errors.push(`${k}: use YYYY-MM-DD`);
        return null;
      }
      return v;
    };
    const dob = dateCell('dob');
    const admissionDate = dateCell('admission_date') ?? today;
    const bForm = get('b_form_no').replace(/-/g, '');
    if (bForm && !/^\d{13}$/.test(bForm)) errors.push('b_form_no: 13 digits');
    const admissionNo = get('admission_no') || null;
    if (admissionNo) {
      const first = seenAdmissionNos.get(admissionNo);
      if (first) errors.push(`admission_no: same as row ${first}`);
      else seenAdmissionNos.set(admissionNo, rowNo);
    }
    const groupCell = get('group');
    const matches = groupCell ? (groups.get(norm(groupCell)) ?? []) : [];
    if (!groupCell) errors.push('group: required');
    else if (matches.length === 0) errors.push(`group: "${groupCell}" not found`);
    else if (matches.length > 1)
      errors.push(`group: "${groupCell}" is ambiguous; write "programme / group"`);
    const g = matches.length === 1 ? matches[0] : undefined;
    const gName = get('guardian_name');
    if (!gName) errors.push('guardian_name: required');
    const phone = normalizePkPhone(get('guardian_phone'));
    if (!phone) errors.push('guardian_phone: not a Pakistani number');
    const waCell = get('guardian_whatsapp');
    let whatsapp: string | null = null;
    if (waCell) {
      whatsapp = normalizePkMobile(waCell);
      if (!whatsapp) errors.push('guardian_whatsapp: not a mobile number');
    } else if (phone?.mobile) whatsapp = phone.number;
    else if (phone) warnings.push('guardian_phone is a landline: no WhatsApp');
    const consent = parseYesNo(get('consent_whatsapp'));
    if (consent === null) errors.push('consent_whatsapp: use yes or no');
    const extra: Extra = {};
    for (const [k, f] of fieldByKey) {
      if (!keys.includes(k)) continue;
      const raw = get(k);
      if (!raw) continue;
      let v: string | number | boolean | null = raw;
      if (f.type === 'number') v = Number(raw);
      if (f.type === 'bool') v = parseYesNo(raw);
      const err = v === null ? 'expected_bool' : customValueError(f.type, v);
      if (err) errors.push(`${k}: ${err}`);
      else extra[k] = v;
    }

    const report: ImportRowReport = {
      row: rowNo,
      student_name: name,
      errors,
      warnings,
      action: errors.length ? 'error' : 'create',
      family: null,
    };
    if (errors.length || !g || !phone) {
      drafts.push({ report });
      continue;
    }
    if (g.capacity != null) warnings.push('check group capacity after import');
    const normalized = {
      name,
      fatherName,
      gender,
      dob,
      bForm: bForm || null,
      admissionNo,
      admissionDate,
      grp: g.id,
      roll: get('roll_no') || null,
      family: get('family_name'),
      address: get('address') || null,
      area: get('area') || null,
      gName,
      gRelation: get('guardian_relation') || null,
      phone: phone.number,
      whatsapp,
      consent,
      extra,
    };
    const hash = await sha256(JSON.stringify(normalized));
    if (seenHashes.has(hash)) {
      report.action = 'skip';
      report.warnings.push('duplicate of an earlier row in this file');
      drafts.push({ report });
      continue;
    }
    seenHashes.add(hash);
    drafts.push({
      report,
      planned: {
        hash,
        row_no: rowNo,
        family_name: normalized.family || fatherName || gName,
        address: normalized.address,
        area: normalized.area,
        guardian_id: newId(),
        g_name: gName,
        g_relation: normalized.gRelation,
        g_phone: phone.number,
        g_whatsapp: whatsapp,
        g_consent: consent ? 1 : 0,
        student_id: newId(),
        name,
        father_name: fatherName,
        dob,
        gender: gender ?? null,
        b_form_no: normalized.bForm,
        admission_no: admissionNo,
        admission_date: admissionDate,
        extra: Object.keys(extra).length ? extra : null,
        year: (g.sessionStart ?? cur?.start ?? admissionDate).slice(0, 4),
        enrolment_id: newId(),
        grp_id: g.id,
        roll_no: normalized.roll,
        audit_id: newId(),
        import_row_id: newId(),
      },
    });
  }

  // What already exists: imported hashes, admission numbers, families by guardian phone,
  // same-name students (a warning, never a block). Looked up in bulk via json_each.
  const planned = drafts.flatMap((d) => (d.planned ? [d.planned] : []));
  const asJson = (xs: string[]) => JSON.stringify([...new Set(xs)]);
  const imported = new Set(
    (
      await db.all<{ h: string }>(
        sql`SELECT row_hash AS h FROM import_row WHERE row_hash IN (SELECT value FROM json_each(${asJson(planned.map((p) => p.hash))}))`,
      )
    ).map((r) => r.h),
  );
  const takenNos = new Set(
    (
      await db.all<{ n: string }>(
        sql`SELECT admission_no AS n FROM student WHERE admission_no IN (SELECT value FROM json_each(${asJson(planned.flatMap((p) => (p.admission_no ? [p.admission_no] : [])))}))`,
      )
    ).map((r) => r.n),
  );
  const phones = planned.map((p) => p.g_phone);
  const famByPhone = new Map<string, string>();
  if (phones.length) {
    const rows = await db
      .select({ phone: guardian.phone, familyId: guardian.familyId })
      .from(guardian)
      .where(sql`${guardian.phone} IN (SELECT value FROM json_each(${asJson(phones)}))`)
      .orderBy(asc(guardian.createdAt));
    for (const r of rows)
      if (r.phone && !famByPhone.has(r.phone)) famByPhone.set(r.phone, r.familyId);
  }
  const names = await db
    .select({ name: student.name, father: student.fatherName })
    .from(student)
    .where(
      sql`lower(${student.name}) IN (SELECT value FROM json_each(${asJson(planned.map((p) => p.name.toLowerCase()))}))`,
    );
  const sameName = new Set(
    names.map((n) => `${n.name.toLowerCase()}|${(n.father ?? '').toLowerCase()}`),
  );

  const ready: Planned[] = [];
  const newFamilyByPhone = new Map<string, string>();
  for (const d of drafts) {
    const p = d.planned;
    if (!p) continue;
    if (imported.has(p.hash)) {
      d.report.action = 'skip';
      d.report.warnings.push('already imported');
      continue;
    }
    if (p.admission_no && takenNos.has(p.admission_no)) {
      d.report.action = 'error';
      d.report.errors.push('admission_no: already used');
      continue;
    }
    if (sameName.has(`${p.name.toLowerCase()}|${(p.father_name ?? '').toLowerCase()}`)) {
      d.report.warnings.push('a student with this name and father name exists');
    }
    // Siblings: same guardian phone → same family, whether the family is old or earlier in the file.
    const existing = famByPhone.get(p.g_phone);
    const inFile = newFamilyByPhone.get(p.g_phone);
    let familyId: string;
    let isNew: 0 | 1 = 0;
    if (existing) {
      familyId = existing;
      d.report.family = 'existing';
    } else if (inFile) {
      familyId = inFile;
      d.report.family = 'csv';
    } else {
      familyId = newId();
      isNew = 1;
      newFamilyByPhone.set(p.g_phone, familyId);
      d.report.family = 'new';
    }
    ready.push({ ...p, family_id: familyId, new_family: isNew, n: 0, k: 0, roll_k: 0 });
  }
  const reports = drafts.map((d) => d.report);
  return { reports, ready };
}

function summarize(reports: ImportRowReport[], ready: Planned[]): ImportReport['summary'] {
  return {
    families: ready.filter((p) => p.new_family).length,
    guardians: ready.filter((p) => p.new_family).length,
    students: ready.length,
    enrolments: ready.length,
    skipped: reports.filter((r) => r.action === 'skip').length,
    errors: reports.filter((r) => r.action === 'error').length,
  };
}

const j = (k: string) => sql.raw(`json_extract(j.value, '$.${k}')`);
const notImported = sql`NOT EXISTS (SELECT 1 FROM import_row r WHERE r.row_hash = ${j('hash')})`;

/** One chunk = one D1 batch: every table filled from one json_each parameter (PLAN §8). */
function chunkStatements(rows: Planned[], uid: string, runId: string): SQL[] {
  const years = new Map<string, number>();
  const rolls = new Map<string, number>();
  for (const p of rows) {
    if (!p.admission_no) {
      const k = (years.get(p.year) ?? 0) + 1;
      years.set(p.year, k);
      p.k = k;
    }
    if (!p.roll_no) {
      const k = (rolls.get(p.grp_id) ?? 0) + 1;
      rolls.set(p.grp_id, k);
      p.roll_k = k;
    }
  }
  for (const p of rows) if (!p.admission_no) p.n = years.get(p.year) ?? 0;
  const data = JSON.stringify(rows);
  const src = sql`FROM json_each(${data}) j`;
  return [
    ...[...years].map(([year, n]) => bumpAdmissionSeries(year, n)),
    sql`INSERT INTO family (id, name, address, area, created_by)
        SELECT ${j('family_id')}, ${j('family_name')}, ${j('address')}, ${j('area')}, ${uid} ${src}
        WHERE ${j('new_family')} = 1 AND ${notImported}
          AND NOT EXISTS (SELECT 1 FROM family f WHERE f.id = ${j('family_id')})`,
    sql`INSERT INTO guardian (id, family_id, name, relation, phone, whatsapp, priority,
          consent_whatsapp, consent_sms, lang, created_by)
        SELECT ${j('guardian_id')}, ${j('family_id')}, ${j('g_name')}, ${j('g_relation')}, ${j('g_phone')},
          ${j('g_whatsapp')}, 1, ${j('g_consent')}, 0, 'ur', ${uid} ${src}
        WHERE ${j('new_family')} = 1 AND ${notImported}`,
    sql`INSERT INTO student (id, family_id, admission_no, name, father_name, dob, gender, b_form_no,
          admission_date, status, extra, created_by)
        SELECT ${j('student_id')}, ${j('family_id')},
          COALESCE(${j('admission_no')},
            (SELECT printf('%s-%04d', s.series, s.last_no - ${j('n')} + ${j('k')})
             FROM admission_series s WHERE s.series = ${j('year')})),
          ${j('name')}, ${j('father_name')}, ${j('dob')}, ${j('gender')}, ${j('b_form_no')},
          ${j('admission_date')}, 'active', ${j('extra')}, ${uid} ${src}
        WHERE ${notImported}`,
    sql`INSERT INTO enrolment (id, student_id, grp_id, is_primary, roll_no, start_date, status, created_by)
        SELECT ${j('enrolment_id')}, ${j('student_id')}, g.id, g.is_primary,
          COALESCE(${j('roll_no')},
            CAST((SELECT COALESCE(MAX(CAST(e.roll_no AS INTEGER)), 0) FROM enrolment e WHERE e.grp_id = g.id)
                 + ${j('roll_k')} AS TEXT)),
          ${j('admission_date')}, 'active', ${uid} ${src}
        JOIN grp g ON g.id = ${j('grp_id')}
        WHERE ${notImported}`,
    sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
        SELECT ${j('audit_id')}, ${uid}, 'student', ${j('student_id')}, 'import',
          json_object('before', NULL, 'after', json_object('run_id', ${runId}, 'row', ${j('row_no')},
            'family_id', ${j('family_id')}, 'grp_id', ${j('grp_id')}, 'name', ${j('name')})) ${src}
        WHERE ${notImported}`,
    // Last: every statement above filters on the hash not being recorded yet.
    sql`INSERT INTO import_row (id, run_id, row_no, row_hash, student_id, created_by)
        SELECT ${j('import_row_id')}, ${runId}, ${j('row_no')}, ${j('hash')}, ${j('student_id')}, ${uid} ${src}
        WHERE ${notImported}`,
  ];
}

export function importRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const write = requires('student', 'write');

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/imports/students/template.csv', access: write },
    async (c) => {
      const fields = await c
        .get('db')
        .select({ key: customField.key })
        .from(customField)
        .where(eq(customField.entity, 'student'));
      // BOM: Excel opens UTF-8 (Urdu) correctly only with it.
      const body = `﻿${toCsvLine(importTemplateHeader(fields.map((f) => f.key)))}\r\n`;
      return c.body(body, 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="maktab-students-template.csv"',
      });
    },
  );

  /**
   * `?dry_run=1` validates and reports what would happen; without it the valid rows are written in
   * chunks of ≤ 25 rows per batch. Idempotent: a row whose hash was imported before is skipped, so
   * a re-upload or a retry after a failed chunk never duplicates anyone.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/imports/students', access: write },
    async (c) => {
      const dryRun = ['1', 'true'].includes(c.req.query('dry_run') ?? '');
      const db = c.get('db');
      const uid = userId(c);
      const { text, fileName } = await readCsvText(c);
      const { reports, ready } = await plan(db, text);
      const summary = summarize(reports, ready);
      if (dryRun || ready.length === 0) {
        const body: ImportReport = {
          dry_run: dryRun,
          run_id: null,
          total: reports.length,
          summary,
          rows: reports,
        };
        return c.json(body);
      }
      const runId = newId();
      await tx(db, [
        sql`INSERT INTO import_run (id, kind, file_name, status, total, created_by)
            VALUES (${runId}, 'students', ${fileName}, 'running', ${reports.length}, ${uid})`,
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'import_run',
          entityId: runId,
          action: 'create',
          after: { file_name: fileName, total: reports.length },
        }),
      ]);
      let done = 0;
      try {
        for (let i = 0; i < ready.length; i += IMPORT_CHUNK_ROWS) {
          const chunk = ready.slice(i, i + IMPORT_CHUNK_ROWS);
          await tx(db, chunkStatements(chunk, uid, runId));
          done += chunk.length;
        }
      } catch (err) {
        await db.run(
          sql`UPDATE import_run SET status = 'failed', created = ${done} WHERE id = ${runId}`,
        );
        const rowsFrom = ready[done]?.row_no ?? 0;
        const reason = dbConflict(err)?.message;
        if (!reason) console.error(err);
        // Rows before the failing chunk are in; re-uploading the same file resumes safely.
        throw new ApiError(
          409,
          'import_failed',
          `Stopped at row ${rowsFrom} (${reason ?? 'database error'}); ${done} rows were imported. Fix the file and upload it again.`,
        );
      }
      const body: ImportReport = {
        dry_run: false,
        run_id: runId,
        total: reports.length,
        summary,
        rows: reports,
      };
      await db.run(
        sql`UPDATE import_run SET status = 'committed', created = ${done}, skipped = ${summary.skipped},
              report = ${JSON.stringify(summary)} WHERE id = ${runId}`,
      );
      return c.json(body, 201);
    },
  );
}
