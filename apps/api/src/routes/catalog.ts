import { customField, programme, school, session, subject, term } from '@maktab/db';
import {
  customFieldInputSchema,
  customFieldPatchSchema,
  newId,
  programmeInputSchema,
  programmePatchSchema,
  type SeedResult,
  schoolInputSchema,
  sessionInputSchema,
  sessionPatchSchema,
  subjectInputSchema,
  subjectPatchSchema,
  termInputSchema,
  termPatchSchema,
} from '@maktab/shared';
import { and, asc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { bucket, deleteReplaced, readImageUpload, serveObject } from '../lib/files';
import { idParam, jsonBody, notFoundError, userId } from '../lib/http';
import { auditSql, changed, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { customFieldDto, programmeDto, schoolDto, sessionDto, subjectDto, termDto } from './dto';

const MAX_LOGO_BYTES = 512 * 1024;

/** The Pakistani ladder (PLAN §14.1): grades chained by next_programme_id, then courses. */
export const PK_GRADES = [
  'Nursery',
  'KG',
  ...Array.from({ length: 10 }, (_, i) => `Class ${i + 1}`),
];
export const PK_COURSES: { name: string; weeks: number }[] = [
  { name: 'FSc Pre-Medical', weeks: 104 },
  { name: 'FSc Pre-Engineering', weeks: 104 },
  { name: 'ICS', weeks: 104 },
  { name: 'FA', weeks: 104 },
  { name: 'Matric (repeater)', weeks: 52 },
];
export const PK_SUBJECTS: [string, string][] = [
  ['Urdu', 'URD'],
  ['English', 'ENG'],
  ['Maths', 'MATH'],
  ['Science', 'SCI'],
  ['Islamiat', 'ISL'],
  ['Pak Studies', 'PST'],
  ['Physics', 'PHY'],
  ['Chemistry', 'CHEM'],
  ['Biology', 'BIO'],
  ['Computer', 'COMP'],
];

async function currentSchool(c: Context<AppEnv>) {
  const [row] = await c.get('db').select().from(school).orderBy(asc(school.createdAt)).limit(1);
  return row ?? null;
}

const activeProgrammes = (c: Context<AppEnv>) =>
  c
    .get('db')
    .select()
    .from(programme)
    .where(isNull(programme.deletedAt))
    .orderBy(asc(programme.kind), asc(programme.seq), asc(programme.name));

const activeSubjects = (c: Context<AppEnv>) =>
  c.get('db').select().from(subject).where(isNull(subject.deletedAt)).orderBy(asc(subject.name));

const allSessions = (c: Context<AppEnv>) =>
  c.get('db').select().from(session).orderBy(asc(session.startDate));

export function catalogRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const read = requires('catalog', 'read');
  const manage = requires('settings', 'manage');

  // ---- School profile -------------------------------------------------------------------------
  defineRoute(app, table, { method: 'GET', path: '/api/school', access: read }, async (c) => {
    const row = await currentSchool(c);
    return c.json({ school: row ? schoolDto(row) : null });
  });

  defineRoute(app, table, { method: 'PUT', path: '/api/school', access: manage }, async (c) => {
    const input = await jsonBody(c, schoolInputSchema);
    const db = c.get('db');
    const uid = userId(c);
    const existing = await currentSchool(c);
    const values = {
      name: input.name,
      nameUr: input.name_ur ?? null,
      mode: input.mode,
      address: input.address ?? null,
      phone: input.phone ?? null,
      defaultLang: input.default_lang,
      receiptPrefix: input.receipt_prefix ?? null,
    };
    const auditId = newId();
    if (existing) {
      const diff = changed(existing, values);
      if (diff) {
        await tx(db, [
          db.update(school).set(values).where(eq(school.id, existing.id)),
          auditSql({
            id: auditId,
            userId: uid,
            entity: 'school',
            entityId: existing.id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
    } else {
      const id = newId();
      await tx(db, [
        db.insert(school).values({ id, ...values, createdBy: uid }),
        auditSql({
          id: auditId,
          userId: uid,
          entity: 'school',
          entityId: id,
          action: 'create',
          after: values,
        }),
      ]);
    }
    const row = await currentSchool(c);
    return c.json({ school: row ? schoolDto(row) : null });
  });

  /**
   * The wizard's last step. Owner-only (role.manage is the owner's grant): finishing setup hands
   * the installation over to daily use. Idempotent; the first completion time is kept.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/school/complete-setup', access: requires('role', 'manage') },
    async (c) => {
      const db = c.get('db');
      const existing = await currentSchool(c);
      if (!existing) throw new ApiError(409, 'no_school', 'Save the school profile first');
      if (!existing.setupCompletedAt) {
        const at = new Date().toISOString();
        await tx(db, [
          db.update(school).set({ setupCompletedAt: at }).where(eq(school.id, existing.id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'school',
            entityId: existing.id,
            action: 'complete_setup',
            before: { setup_completed_at: null },
            after: { setup_completed_at: at },
          }),
        ]);
      }
      const row = await currentSchool(c);
      return c.json({ school: row ? schoolDto(row) : null });
    },
  );

  defineRoute(app, table, { method: 'GET', path: '/api/school/logo', access: read }, async (c) => {
    const row = await currentSchool(c);
    return serveObject(c, row?.logoKey ?? null);
  });

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/school/logo', access: manage },
    async (c) => {
      const files = bucket(c);
      const existing = await currentSchool(c);
      if (!existing) throw new ApiError(409, 'no_school', 'Save the school profile first');
      const { bytes, type } = await readImageUpload(c, MAX_LOGO_BYTES);
      // A new key per upload: no stale cached logo; the old object is deleted once the swap commits.
      const key = `school/logo-${newId()}`;
      await files.put(key, bytes, { httpMetadata: { contentType: type } });
      const db = c.get('db');
      await tx(db, [
        db.update(school).set({ logoKey: key }).where(eq(school.id, existing.id)),
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'school',
          entityId: existing.id,
          action: 'logo',
          before: { logo_key: existing.logoKey },
          after: { logo_key: key },
        }),
      ]);
      await deleteReplaced(files, existing.logoKey, key);
      const row = await currentSchool(c);
      return c.json({ school: row ? schoolDto(row) : null });
    },
  );

  // ---- Sessions (academic years) --------------------------------------------------------------
  defineRoute(app, table, { method: 'GET', path: '/api/sessions', access: read }, async (c) =>
    c.json({ items: (await allSessions(c)).map(sessionDto) }),
  );

  /** Clear the old current first: the partial unique index allows one is_current = 1 row. */
  const makeCurrent = (id: string): SQL[] => [
    sql`UPDATE session SET is_current = 0 WHERE is_current = 1 AND id <> ${id}`,
    sql`UPDATE session SET is_current = 1 WHERE id = ${id}`,
  ];

  defineRoute(app, table, { method: 'POST', path: '/api/sessions', access: manage }, async (c) => {
    const input = await jsonBody(c, sessionInputSchema);
    const db = c.get('db');
    const id = input.id ?? newId();
    const [cur] = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.isCurrent, true));
    // The first session becomes current by itself; nothing works without one.
    const current = input.is_current ?? !cur;
    const values = { name: input.name, startDate: input.start_date, endDate: input.end_date };
    await tx(db, [
      db.insert(session).values({ id, ...values, isCurrent: false, createdBy: userId(c) }),
      ...(current ? makeCurrent(id) : []),
      auditSql({
        id: newId(),
        userId: userId(c),
        entity: 'session',
        entityId: id,
        action: 'create',
        after: { ...values, is_current: current },
      }),
    ]);
    const [row] = await db.select().from(session).where(eq(session.id, id));
    if (!row) throw notFoundError('Session');
    return c.json(sessionDto(row), 201);
  });

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/sessions/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, sessionPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(session).where(eq(session.id, id));
      if (!before) throw notFoundError('Session');
      const values = {
        name: input.name,
        startDate: input.start_date,
        endDate: input.end_date,
      };
      const start = values.startDate ?? before.startDate;
      const end = values.endDate ?? before.endDate;
      if (end <= start) throw new ApiError(400, 'invalid', 'end_date: end_before_start');
      const diff = changed(before, { ...values, isCurrent: input.is_current });
      const fields = changed(before, values);
      if (diff) {
        await tx(db, [
          ...(fields ? [db.update(session).set(values).where(eq(session.id, id))] : []),
          ...(input.is_current === true ? makeCurrent(id) : []),
          ...(input.is_current === false
            ? [sql`UPDATE session SET is_current = 0 WHERE id = ${id}`]
            : []),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'session',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      const [row] = await db.select().from(session).where(eq(session.id, id));
      return c.json(sessionDto(row ?? before));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/sessions/:id/current', access: manage },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [row] = await db.select().from(session).where(eq(session.id, id));
      if (!row) throw notFoundError('Session');
      if (!row.isCurrent) {
        const [prev] = await db
          .select({ id: session.id, name: session.name })
          .from(session)
          .where(eq(session.isCurrent, true));
        await tx(db, [
          ...makeCurrent(id),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'session',
            entityId: id,
            action: 'set_current',
            before: { is_current: false, current_session_id: prev?.id ?? null },
            after: { is_current: true, current_session_id: id },
          }),
        ]);
      }
      return c.json({ items: (await allSessions(c)).map(sessionDto) });
    },
  );

  // ---- Terms (optional) ----------------------------------------------------------------------
  defineRoute(app, table, { method: 'GET', path: '/api/terms', access: read }, async (c) => {
    const sid = c.req.query('session_id');
    const rows = await c
      .get('db')
      .select()
      .from(term)
      .where(sid ? eq(term.sessionId, sid) : undefined)
      .orderBy(asc(term.sessionId), asc(term.seq));
    return c.json({ items: rows.map(termDto) });
  });

  defineRoute(app, table, { method: 'POST', path: '/api/terms', access: manage }, async (c) => {
    const input = await jsonBody(c, termInputSchema);
    const db = c.get('db');
    const id = input.id ?? newId();
    const values = {
      sessionId: input.session_id,
      name: input.name,
      seq: input.seq,
      startDate: input.start_date,
      endDate: input.end_date,
    };
    await tx(db, [
      db.insert(term).values({ id, ...values, createdBy: userId(c) }),
      auditSql({
        id: newId(),
        userId: userId(c),
        entity: 'term',
        entityId: id,
        action: 'create',
        after: values,
      }),
    ]);
    const [row] = await db.select().from(term).where(eq(term.id, id));
    if (!row) throw notFoundError('Term');
    return c.json(termDto(row), 201);
  });

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/terms/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, termPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(term).where(eq(term.id, id));
      if (!before) throw notFoundError('Term');
      const values = {
        name: input.name,
        seq: input.seq,
        startDate: input.start_date,
        endDate: input.end_date,
      };
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(term).set(values).where(eq(term.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'term',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      const [row] = await db.select().from(term).where(eq(term.id, id));
      return c.json(termDto(row ?? before));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'DELETE', path: '/api/terms/:id', access: manage },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(term).where(eq(term.id, id));
      if (!before) throw notFoundError('Term');
      // Hard delete is fine for an unused term; an exam pointing at it makes the FK refuse (409 in_use).
      await tx(db, [
        db.delete(term).where(eq(term.id, id)),
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'term',
          entityId: id,
          action: 'delete',
          before: termDto(before),
        }),
      ]);
      return c.json({ ok: true });
    },
  );

  // ---- Programmes -----------------------------------------------------------------------------
  defineRoute(app, table, { method: 'GET', path: '/api/programmes', access: read }, async (c) =>
    c.json({ items: (await activeProgrammes(c)).map(programmeDto) }),
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/programmes', access: manage },
    async (c) => {
      const input = await jsonBody(c, programmeInputSchema);
      const db = c.get('db');
      const id = input.id ?? newId();
      const values = {
        name: input.name,
        kind: input.kind,
        seq: input.seq ?? 0,
        nextProgrammeId: input.next_programme_id ?? null,
        durationWeeks: input.duration_weeks ?? null,
      };
      await tx(db, [
        db.insert(programme).values({ id, ...values, createdBy: userId(c) }),
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'programme',
          entityId: id,
          action: 'create',
          after: values,
        }),
      ]);
      const [row] = await db.select().from(programme).where(eq(programme.id, id));
      if (!row) throw notFoundError('Programme');
      return c.json(programmeDto(row), 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/programmes/seed-pk', access: manage },
    async (c) => {
      const db = c.get('db');
      const uid = userId(c);
      const before = await activeProgrammes(c);
      const have = new Set(before.map((p) => p.name.toLowerCase()));
      const missing = [
        ...PK_GRADES.map((name, i) => ({ name, kind: 'grade' as const, seq: i + 1, weeks: null })),
        ...PK_COURSES.map((p, i) => ({
          name: p.name,
          kind: 'course' as const,
          seq: 101 + i,
          weeks: p.weeks,
        })),
      ].filter((p) => !have.has(p.name.toLowerCase()));
      // Each insert re-checks by name inside the batch, so a double click cannot duplicate a rung.
      const inserts = missing.map(
        (p) => sql`INSERT INTO programme (id, name, kind, seq, duration_weeks, created_by)
                   SELECT ${newId()}, ${p.name}, ${p.kind}, ${p.seq}, ${p.weeks}, ${uid}
                   WHERE NOT EXISTS (SELECT 1 FROM programme
                                     WHERE lower(name) = lower(${p.name}) AND deleted_at IS NULL)`,
      );
      // Chain only rungs that have no next yet, so an owner's own edits survive a re-seed.
      const chain = PK_GRADES.slice(0, -1).map(
        (name, i) => sql`UPDATE programme SET next_programme_id =
                           (SELECT id FROM programme WHERE lower(name) = lower(${PK_GRADES[i + 1] ?? ''})
                              AND deleted_at IS NULL ORDER BY created_at LIMIT 1)
                         WHERE lower(name) = lower(${name}) AND deleted_at IS NULL
                           AND next_programme_id IS NULL`,
      );
      await tx(db, [
        ...inserts,
        ...chain,
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'programme',
          entityId: 'seed-pk',
          action: 'seed',
          after: { created: missing.map((p) => p.name) },
        }),
      ]);
      const items = await activeProgrammes(c);
      const body: SeedResult = {
        created: items.length - before.length,
        existing: PK_GRADES.length + PK_COURSES.length - (items.length - before.length),
      };
      return c.json({ ...body, items: items.map(programmeDto) });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/programmes/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, programmePatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db
        .select()
        .from(programme)
        .where(and(eq(programme.id, id), isNull(programme.deletedAt)));
      if (!before) throw notFoundError('Programme');
      if (input.next_programme_id === id) {
        throw new ApiError(400, 'invalid', 'next_programme_id: cannot point to itself');
      }
      const values = {
        name: input.name,
        kind: input.kind,
        seq: input.seq,
        nextProgrammeId: input.next_programme_id,
        durationWeeks: input.duration_weeks,
      };
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(programme).set(values).where(eq(programme.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'programme',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      const [row] = await db.select().from(programme).where(eq(programme.id, id));
      return c.json(programmeDto(row ?? before));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'DELETE', path: '/api/programmes/:id', access: manage },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db
        .select()
        .from(programme)
        .where(and(eq(programme.id, id), isNull(programme.deletedAt)));
      if (!before) throw notFoundError('Programme');
      // Soft delete (reference data, PLAN §5): existing groups keep pointing at it.
      await tx(db, [
        db
          .update(programme)
          .set({ deletedAt: new Date().toISOString() })
          .where(eq(programme.id, id)),
        sql`UPDATE programme SET next_programme_id = NULL WHERE next_programme_id = ${id}`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'programme',
          entityId: id,
          action: 'delete',
          before: programmeDto(before),
        }),
      ]);
      return c.json({ ok: true });
    },
  );

  // ---- Subjects -------------------------------------------------------------------------------
  defineRoute(app, table, { method: 'GET', path: '/api/subjects', access: read }, async (c) =>
    c.json({ items: (await activeSubjects(c)).map(subjectDto) }),
  );

  defineRoute(app, table, { method: 'POST', path: '/api/subjects', access: manage }, async (c) => {
    const input = await jsonBody(c, subjectInputSchema);
    const db = c.get('db');
    const id = input.id ?? newId();
    const values = { name: input.name, shortName: input.short_name ?? null };
    await tx(db, [
      db.insert(subject).values({ id, ...values, createdBy: userId(c) }),
      auditSql({
        id: newId(),
        userId: userId(c),
        entity: 'subject',
        entityId: id,
        action: 'create',
        after: values,
      }),
    ]);
    const [row] = await db.select().from(subject).where(eq(subject.id, id));
    if (!row) throw notFoundError('Subject');
    return c.json(subjectDto(row), 201);
  });

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/subjects/seed-pk', access: manage },
    async (c) => {
      const db = c.get('db');
      const uid = userId(c);
      const before = await activeSubjects(c);
      const have = new Set(before.map((s) => s.name.toLowerCase()));
      const missing = PK_SUBJECTS.filter(([name]) => !have.has(name.toLowerCase()));
      await tx(db, [
        ...missing.map(
          ([name, short]) => sql`INSERT INTO subject (id, name, short_name, created_by)
                   SELECT ${newId()}, ${name}, ${short}, ${uid}
                   WHERE NOT EXISTS (SELECT 1 FROM subject
                                     WHERE lower(name) = lower(${name}) AND deleted_at IS NULL)`,
        ),
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'subject',
          entityId: 'seed-pk',
          action: 'seed',
          after: { created: missing.map(([n]) => n) },
        }),
      ]);
      const items = await activeSubjects(c);
      const created = items.length - before.length;
      const body: SeedResult = { created, existing: PK_SUBJECTS.length - created };
      return c.json({ ...body, items: items.map(subjectDto) });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/subjects/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, subjectPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db
        .select()
        .from(subject)
        .where(and(eq(subject.id, id), isNull(subject.deletedAt)));
      if (!before) throw notFoundError('Subject');
      const values = { name: input.name, shortName: input.short_name };
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(subject).set(values).where(eq(subject.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'subject',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      const [row] = await db.select().from(subject).where(eq(subject.id, id));
      return c.json(subjectDto(row ?? before));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'DELETE', path: '/api/subjects/:id', access: manage },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db
        .select()
        .from(subject)
        .where(and(eq(subject.id, id), isNull(subject.deletedAt)));
      if (!before) throw notFoundError('Subject');
      await tx(db, [
        db.update(subject).set({ deletedAt: new Date().toISOString() }).where(eq(subject.id, id)),
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'subject',
          entityId: id,
          action: 'delete',
          before: subjectDto(before),
        }),
      ]);
      return c.json({ ok: true });
    },
  );

  // ---- Custom fields (values live in student.extra) -------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/custom-fields', access: read },
    async (c) => {
      const rows = await c.get('db').select().from(customField).orderBy(asc(customField.createdAt));
      return c.json({ items: rows.map(customFieldDto) });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/custom-fields', access: manage },
    async (c) => {
      const input = await jsonBody(c, customFieldInputSchema);
      const db = c.get('db');
      const id = input.id ?? newId();
      const values = {
        entity: input.entity,
        key: input.key,
        labelEn: input.label_en,
        labelUr: input.label_ur ?? null,
        type: input.type,
      };
      await tx(db, [
        db.insert(customField).values({ id, ...values, createdBy: userId(c) }),
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'custom_field',
          entityId: id,
          action: 'create',
          after: values,
        }),
      ]);
      const [row] = await db.select().from(customField).where(eq(customField.id, id));
      if (!row) throw notFoundError('Custom field');
      return c.json(customFieldDto(row), 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/custom-fields/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, customFieldPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(customField).where(eq(customField.id, id));
      if (!before) throw notFoundError('Custom field');
      // Key and type are fixed once created: stored values in `extra` depend on them.
      const values = { labelEn: input.label_en, labelUr: input.label_ur };
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(customField).set(values).where(eq(customField.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'custom_field',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      const [row] = await db.select().from(customField).where(eq(customField.id, id));
      return c.json(customFieldDto(row ?? before));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'DELETE', path: '/api/custom-fields/:id', access: manage },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(customField).where(eq(customField.id, id));
      if (!before) throw notFoundError('Custom field');
      // Values already stored in student.extra stay (history); they are simply no longer shown.
      await tx(db, [
        db.delete(customField).where(eq(customField.id, id)),
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'custom_field',
          entityId: id,
          action: 'delete',
          before: customFieldDto(before),
        }),
      ]);
      return c.json({ ok: true });
    },
  );
}
