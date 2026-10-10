import {
  type AppDb,
  addConcession,
  applyLateFines,
  collectionByCollector,
  concessionRegister,
  defaulters,
  endConcession,
  type FeeSettings,
  failingGroups,
  familyStatement,
  feeRegister,
  feeSettings,
  generateCharges,
  generateChunkOrLog,
  generationCursor,
  netOfCredit,
  nextGroup,
  recordOpeningBalance,
  regenerateForStudent,
  school,
  sponsorStatement,
  voidCharge,
  waiveFine,
} from '@maktab/db';
import {
  type ConcessionDto,
  concessionEndSchema,
  concessionInputSchema,
  concessionRegisterQuerySchema,
  type DefaulterDto,
  defaultersQuerySchema,
  type FeeDashboardDto,
  type FeeHeadDto,
  type FeeRateDto,
  type FeeSettingsDto,
  feeHeadInputSchema,
  feeHeadPatchSchema,
  feeRateInputSchema,
  feeSettingsSchema,
  finesApplyInputSchema,
  type GenerateResultDto,
  generateInputSchema,
  newId,
  openingBalanceInputSchema,
  periodSchema,
  regenerateInputSchema,
  registerQuerySchema,
  remindInputSchema,
  type SponsorshipDto,
  type StudentFeesDto,
  sponsorInputSchema,
  sponsorPatchSchema,
  sponsorshipEndSchema,
  sponsorshipInputSchema,
  toCsvLine,
  voidChargeSchema,
  waiveInputSchema,
} from '@maktab/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { familyMessageStatements, toPlannedDto } from '../lib/fees';
import { idParam, jsonBody, notFoundError, queryParams, todayPk, userId } from '../lib/http';
import { withD1Retry } from '../lib/retry';
import { auditSql, changed, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { scopeToGroups, studentFilter } from '../perm/scope';

type HeadRow = {
  id: string;
  name: string;
  name_ur: string | null;
  kind: FeeHeadDto['kind'];
  cadence: FeeHeadDto['cadence'];
  archived_at: string | null;
};
const headDto = (h: HeadRow): FeeHeadDto => ({
  id: h.id,
  name: h.name,
  name_ur: h.name_ur,
  kind: h.kind,
  cadence: h.cadence,
  archived: !!h.archived_at,
});

/** The fee settings plus the receipt series state (the prefix locks once a receipt exists). */
async function settingsBody(db: AppDb): Promise<FeeSettingsDto> {
  const s: FeeSettings = await feeSettings(db);
  const [r] = await db.all<{ n: number }>(sql`SELECT EXISTS (SELECT 1 FROM receipt) AS n`);
  return {
    fine_rule: s.fineRule,
    sibling_rule: s.siblingRule,
    reminder_cooldown_days: s.cooldownDays,
    due_day: s.dueDay,
    receipt_prefix: s.receiptPrefix,
    receipts_issued: !!r?.n,
  };
}

/** Rupees with paisa for CSV (spreadsheets want numbers, not "PKR 5,700"). */
const rupees = (paisa: number) => paisa / 100;

export function feeRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const read = requires('fee', 'read');
  const manage = requires('fee', 'manage');
  const generate = requires('fee', 'generate');
  const concession = requires('fee', 'concession');
  const money = requires('receipt', 'read');

  // ---- settings (fine rule, sibling rule, reminder cooldown) ----

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/school/fees', access: requires('catalog', 'read') },
    async (c) => c.json({ fees: await settingsBody(c.get('db')) }),
  );

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/school/fees', access: requires('settings', 'manage') },
    async (c) => {
      const input = await jsonBody(c, feeSettingsSchema);
      const db = c.get('db');
      const [row] = await db.select().from(school).orderBy(asc(school.createdAt)).limit(1);
      if (!row) throw new ApiError(409, 'no_school', 'Save the school profile first');
      const values = {
        fineRule: input.fine_rule ? JSON.stringify(input.fine_rule) : null,
        siblingRule: JSON.stringify([...input.sibling_rule].sort((a, b) => a.nth - b.nth)),
        reminderCooldownDays: input.reminder_cooldown_days,
      };
      const diff = changed(row, values);
      if (diff)
        await tx(db, [
          db.update(school).set(values).where(eq(school.id, row.id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'school',
            entityId: row.id,
            action: 'fee_settings',
            ...diff,
          }),
        ]);
      return c.json({ fees: await settingsBody(db) });
    },
  );

  // ---- fee heads and rates ----

  defineRoute(app, table, { method: 'GET', path: '/api/fees/heads', access: read }, async (c) => {
    const rows = await c
      .get('db')
      .all<HeadRow>(
        sql`SELECT id, name, name_ur, kind, cadence, archived_at FROM fee_head ORDER BY archived_at IS NOT NULL, created_at, id`,
      );
    return c.json({ heads: rows.map(headDto) });
  });

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/heads', access: manage },
    async (c) => {
      const input = await jsonBody(c, feeHeadInputSchema);
      const db = c.get('db');
      const id = input.id ?? newId();
      const after = {
        name: input.name,
        name_ur: input.name_ur ?? null,
        kind: input.kind,
        cadence: input.cadence,
      };
      await tx(db, [
        sql`INSERT INTO fee_head (id, name, name_ur, kind, cadence, created_by)
          VALUES (${id}, ${after.name}, ${after.name_ur}, ${after.kind}, ${after.cadence}, ${userId(c)})`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'fee_head',
          entityId: id,
          action: 'create',
          after,
        }),
      ]);
      return c.json({ head: headDto({ id, ...after, archived_at: null }) }, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/fees/heads/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, feeHeadPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [h] = await db.all<HeadRow>(
        sql`SELECT id, name, name_ur, kind, cadence, archived_at FROM fee_head WHERE id = ${id}`,
      );
      if (!h) throw notFoundError('Fee head');
      const next = {
        name: input.name ?? h.name,
        name_ur: input.name_ur === undefined ? h.name_ur : input.name_ur,
        archived_at:
          input.archived === undefined
            ? h.archived_at
            : input.archived
              ? (h.archived_at ?? new Date().toISOString())
              : null,
      };
      const diff = changed(h, next);
      if (diff)
        await tx(db, [
          sql`UPDATE fee_head SET name = ${next.name}, name_ur = ${next.name_ur}, archived_at = ${next.archived_at}
              WHERE id = ${id}`,
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'fee_head',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      return c.json({ head: headDto({ ...h, ...next }) });
    },
  );

  defineRoute(app, table, { method: 'GET', path: '/api/fees/rates', access: read }, async (c) => {
    const q = queryParams(c, z.object({ fee_head_id: z.string().optional() }));
    const rows = await c
      .get('db')
      .all<FeeRateDto>(sql`SELECT id, fee_head_id, programme_id, grp_id, amount,
        effective_from, created_at FROM fee_rate
      ${q.fee_head_id ? sql`WHERE fee_head_id = ${q.fee_head_id}` : sql``}
      ORDER BY fee_head_id, programme_id, grp_id, effective_from DESC, created_at DESC`);
    return c.json({ rates: rows });
  });

  /** A rate change is a new row effective from a date; the old row is never edited (PLAN §14.12). */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/rates', access: manage },
    async (c) => {
      const input = await jsonBody(c, feeRateInputSchema);
      const db = c.get('db');
      const [h] = await db.all<{ kind: string }>(
        sql`SELECT kind FROM fee_head WHERE id = ${input.fee_head_id}`,
      );
      if (!h) throw new ApiError(400, 'invalid', 'Unknown fee head');
      const id = input.id ?? newId();
      const after = {
        fee_head_id: input.fee_head_id,
        programme_id: input.programme_id ?? null,
        grp_id: input.grp_id ?? null,
        amount: input.amount,
        effective_from: input.effective_from,
      };
      await tx(db, [
        sql`INSERT INTO fee_rate (id, fee_head_id, programme_id, grp_id, amount, effective_from, created_by)
          VALUES (${id}, ${after.fee_head_id}, ${after.programme_id}, ${after.grp_id}, ${after.amount},
                  ${after.effective_from}, ${userId(c)})`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'fee_rate',
          entityId: id,
          action: 'create',
          after,
        }),
      ]);
      const [rate] =
        await db.all<FeeRateDto>(sql`SELECT id, fee_head_id, programme_id, grp_id, amount,
        effective_from, created_at FROM fee_rate WHERE id = ${id}`);
      return c.json({ rate }, 201);
    },
  );

  // ---- concessions ----

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/concessions', access: money },
    async (c) => {
      const q = queryParams(c, z.object({ student_id: z.string().optional() }));
      const rows = await c
        .get('db')
        .all(sql`SELECT k.*, st.name AS student_name, h.name AS head_name
      FROM concession k JOIN student st ON st.id = k.student_id LEFT JOIN fee_head h ON h.id = k.fee_head_id
      ${q.student_id ? sql`WHERE k.student_id = ${q.student_id}` : sql``}
      ORDER BY k.created_at DESC LIMIT 500`);
      return c.json({ concessions: rows });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/concessions', access: concession },
    async (c) => {
      const input = await jsonBody(c, concessionInputSchema);
      const db = c.get('db');
      const [st] = await db.all(sql`SELECT id FROM student WHERE id = ${input.student_id}`);
      if (!st) throw new ApiError(400, 'invalid', 'Unknown student');
      const id = input.id ?? newId();
      await withD1Retry(() =>
        addConcession(db, {
          id,
          studentId: input.student_id,
          feeHeadId: input.fee_head_id,
          type: input.type,
          value: input.value,
          reason: input.reason,
          note: input.note ?? null,
          approvedBy: userId(c),
          validFrom: input.valid_from,
          validTo: input.valid_to ?? null,
        }),
      );
      const [row] = await db.all(sql`SELECT * FROM concession WHERE id = ${id}`);
      return c.json({ concession: row }, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/concessions/:id/end', access: concession },
    async (c) => {
      const input = await jsonBody(c, concessionEndSchema);
      const db = c.get('db');
      const id = idParam(c);
      await endConcession(db, { id, endedAt: input.ended_at, reason: input.reason, by: userId(c) });
      const [row] = await db.all(sql`SELECT * FROM concession WHERE id = ${id}`);
      return c.json({ concession: row });
    },
  );

  // ---- sponsors ----

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/sponsors', access: money },
    async (c) => {
      const db = c.get('db');
      const sponsors = await db.all(sql`SELECT s.id, s.name, s.phone,
        (SELECT count(*) FROM sponsorship sp WHERE sp.sponsor_id = s.id AND (sp.valid_to IS NULL OR sp.valid_to >= ${todayPk()})) AS active_students,
        (SELECT coalesce(sum(due), 0) FROM charge_status WHERE payer_type = 'sponsor' AND payer_id = s.id AND due > 0) AS due
      FROM sponsor s ORDER BY s.name`);
      return c.json({ sponsors });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/sponsors', access: manage },
    async (c) => {
      const input = await jsonBody(c, sponsorInputSchema);
      const db = c.get('db');
      const id = input.id ?? newId();
      const after = { name: input.name, phone: input.phone ?? null, cnic: input.cnic ?? null };
      await tx(db, [
        sql`INSERT INTO sponsor (id, name, phone, cnic, created_by) VALUES (${id}, ${after.name}, ${after.phone}, ${after.cnic}, ${userId(c)})`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'sponsor',
          entityId: id,
          action: 'create',
          after,
        }),
      ]);
      return c.json({ sponsor: { id, ...after } }, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/fees/sponsors/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, sponsorPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [s] = await db.all<{ name: string; phone: string | null; cnic: string | null }>(
        sql`SELECT name, phone, cnic FROM sponsor WHERE id = ${id}`,
      );
      if (!s) throw notFoundError('Sponsor');
      const next = {
        name: input.name ?? s.name,
        phone: input.phone === undefined ? s.phone : input.phone,
        cnic: input.cnic === undefined ? s.cnic : input.cnic,
      };
      const diff = changed(s, next);
      if (diff)
        await tx(db, [
          sql`UPDATE sponsor SET name = ${next.name}, phone = ${next.phone}, cnic = ${next.cnic} WHERE id = ${id}`,
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'sponsor',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      return c.json({ sponsor: { id, ...next } });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/sponsorships', access: manage },
    async (c) => {
      const input = await jsonBody(c, sponsorshipInputSchema);
      const db = c.get('db');
      const [ok] = await db.all<{ s: number; st: number }>(sql`SELECT
          (SELECT count(*) FROM sponsor WHERE id = ${input.sponsor_id}) AS s,
          (SELECT count(*) FROM student WHERE id = ${input.student_id}) AS st`);
      if (!ok?.s || !ok.st) throw new ApiError(400, 'invalid', 'Unknown sponsor or student');
      if (input.valid_to && input.valid_to < input.valid_from)
        throw new ApiError(400, 'invalid', 'valid_to: before valid_from');
      // One sponsor, one student, one head (a NULL head covers every head): validity may not overlap.
      // End the old row and add a new one to change a share (PLAN §14.7).
      const [clash] = await db.all<{ id: string }>(sql`SELECT id FROM sponsorship
        WHERE sponsor_id = ${input.sponsor_id} AND student_id = ${input.student_id}
          AND (fee_head_id IS NULL OR ${input.fee_head_id ?? null} IS NULL OR fee_head_id = ${input.fee_head_id ?? null})
          AND valid_from <= ${input.valid_to ?? '9999-12-31'}
          AND (valid_to IS NULL OR valid_to >= ${input.valid_from})
        LIMIT 1`);
      if (clash)
        throw new ApiError(
          409,
          'sponsorship_overlap',
          'This sponsor already covers this student for these dates; end that sponsorship first',
        );
      const id = input.id ?? newId();
      const after = {
        sponsor_id: input.sponsor_id,
        student_id: input.student_id,
        fee_head_id: input.fee_head_id,
        share_pct: input.share_pct,
        valid_from: input.valid_from,
        valid_to: input.valid_to ?? null,
      };
      await tx(db, [
        sql`INSERT INTO sponsorship (id, sponsor_id, student_id, fee_head_id, share_pct, valid_from, valid_to, created_by)
            VALUES (${id}, ${after.sponsor_id}, ${after.student_id}, ${after.fee_head_id}, ${after.share_pct},
                    ${after.valid_from}, ${after.valid_to}, ${userId(c)})`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'sponsorship',
          entityId: id,
          action: 'create',
          after,
        }),
      ]);
      return c.json({ sponsorship: { id, ...after } }, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/sponsorships/:id/end', access: manage },
    async (c) => {
      const input = await jsonBody(c, sponsorshipEndSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [s] = await db.all<{ valid_to: string | null; valid_from: string }>(
        sql`SELECT valid_to, valid_from FROM sponsorship WHERE id = ${id}`,
      );
      if (!s) throw notFoundError('Sponsorship');
      if (s.valid_to) throw new ApiError(409, 'already_ended', 'Sponsorship already ended');
      if (input.valid_to < s.valid_from)
        throw new ApiError(400, 'invalid', 'valid_to: before valid_from');
      await tx(db, [
        sql`UPDATE sponsorship SET valid_to = ${input.valid_to} WHERE id = ${id}`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'sponsorship',
          entityId: id,
          action: 'end',
          after: { valid_to: input.valid_to },
        }),
      ]);
      return c.json({ sponsorship: { id, valid_to: input.valid_to } });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/sponsors/:id/statement', access: money },
    async (c) => {
      const st = await sponsorStatement(c.get('db'), idParam(c));
      if (!st) throw notFoundError('Sponsor');
      return c.json(st);
    },
  );

  // ---- opening balances ----

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/opening-balances', access: manage },
    async (c) => {
      const input = await jsonBody(c, openingBalanceInputSchema);
      const r = await recordOpeningBalance(c.get('db'), {
        studentId: input.student_id,
        amount: input.amount,
        asOf: input.as_of,
        note: input.note ?? null,
        by: userId(c),
      });
      return c.json(r, 201);
    },
  );

  // ---- generation, fines, regenerate ----

  /**
   * One chunk per request (PLAN §15 budget: ≤ 200 rows): the client sends `next` back until it is
   * null. Without grp_id a commit resumes where the period stands; a dry run starts at the first
   * group. Idempotent: re-sending a chunk inserts nothing.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/generate', access: generate },
    async (c) => {
      const input = await jsonBody(c, generateInputSchema);
      const db = c.get('db');
      let grpId = input.grp_id ?? null;
      let after = input.after_student_id ?? null;
      if (!grpId) {
        if (input.dry_run) grpId = await nextGroup(db, input.period, null);
        else {
          const cur = await generationCursor(db, input.period);
          grpId = cur?.grp_id ?? null;
          after = cur?.after_student_id ?? null;
        }
      }
      if (!grpId) {
        const body: GenerateResultDto = {
          period: input.period,
          grp_id: null,
          dry_run: input.dry_run,
          planned: [],
          counts: { fees: 0, concessions: 0, sponsored: 0, allocations: 0 },
          group_done: true,
          next: null,
          done: true,
          failed: null,
        };
        return c.json(body);
      }
      const g = grpId;
      if (!input.dry_run) {
        // A group that cannot be billed is logged (GET /api/fees/runs) and skipped, never a wall.
        const out = await withD1Retry(() =>
          generateChunkOrLog(db, {
            period: input.period,
            grpId: g,
            afterStudentId: after,
            by: userId(c),
            proRata: input.pro_rata,
          }),
        );
        if (!out.ok) {
          const nextGrp = await nextGroup(db, input.period, g);
          const body: GenerateResultDto = {
            period: input.period,
            grp_id: g,
            dry_run: false,
            planned: [],
            counts: { fees: 0, concessions: 0, sponsored: 0, allocations: 0 },
            group_done: false,
            next: nextGrp ? { grp_id: nextGrp, after_student_id: null } : null,
            done: nextGrp === null,
            failed: { grp_id: g, code: out.code, message: out.message },
          };
          return c.json(body);
        }
      }
      const r = await withD1Retry(() =>
        generateCharges(db, {
          period: input.period,
          scope: { grpId: g, afterStudentId: after },
          by: userId(c),
          dryRun: input.dry_run,
          proRata: input.pro_rata,
        }),
      );
      const next = !r.group_done
        ? { grp_id: g, after_student_id: r.next_student_id }
        : r.next_grp_id
          ? { grp_id: r.next_grp_id, after_student_id: null }
          : null;
      const body: GenerateResultDto = {
        period: r.period,
        grp_id: r.grp_id,
        dry_run: r.dry_run,
        planned: r.planned.map(toPlannedDto),
        counts: r.counts,
        group_done: r.group_done,
        next,
        done: next === null,
        failed: null,
      };
      return c.json(body);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/runs', access: generate },
    async (c) => {
      const q = queryParams(c, z.object({ period: periodSchema }));
      const db = c.get('db');
      const chunks = await db.all<{
        id: string;
        grp_id: string | null;
        status: string;
        error_code: string | null;
        error_message: string | null;
        created_at: string;
      }>(sql`SELECT k.id, k.kind, k.grp_id, k.student_id, k.next_student_id, k.done, k.status,
        k.error_code, k.error_message,
        k.fees, k.concessions, k.sponsored, k.fines, k.allocations, k.created_at, k.created_by
      FROM billing_chunk k JOIN billing_run r ON r.id = k.run_id WHERE r.period_key = ${q.period}
      ORDER BY k.created_at, k.id`);
      const cursor = await generationCursor(db, q.period);
      // Groups whose latest chunk failed: still to be billed (the cron retries them with backoff);
      // `attention_required` after three failures in a row (the M3b banner).
      const failing = await failingGroups(db, q.period);
      return c.json({
        period: q.period,
        complete: cursor === null,
        cursor,
        failing,
        attention_required: failing.filter((f) => f.attention_required).length,
        chunks,
      });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/fines/apply', access: generate },
    async (c) => {
      const input = await jsonBody(c, finesApplyInputSchema);
      const r = await withD1Retry(() =>
        applyLateFines(c.get('db'), {
          period: input.period,
          asOf: input.as_of ?? todayPk(),
          by: userId(c),
          dryRun: input.dry_run,
        }),
      );
      return c.json(r);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/fines/:id/waive', access: concession },
    async (c) => {
      const input = await jsonBody(c, waiveInputSchema);
      const r = await waiveFine(c.get('db'), {
        fineId: idParam(c),
        reason: input.reason,
        amount: input.amount,
        by: userId(c),
      });
      return c.json(r, 201);
    },
  );

  /**
   * Void a charge billed by mistake (PLAN §14.5): a `reversal` line zeroes the fee (or what is left
   * of a fine), with a required reason; paid money is released first and becomes credit, which is
   * then applied to the payer's other dues.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/charges/:id/void', access: manage },
    async (c) => {
      const input = await jsonBody(c, voidChargeSchema);
      const r = await withD1Retry(() =>
        voidCharge(c.get('db'), { chargeId: idParam(c), reason: input.reason, by: userId(c) }),
      );
      return c.json(r, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/regenerate', access: generate },
    async (c) => {
      const input = await jsonBody(c, regenerateInputSchema);
      const db = c.get('db');
      const [st] = await db.all(sql`SELECT id FROM student WHERE id = ${input.student_id}`);
      if (!st) throw new ApiError(400, 'invalid', 'Unknown student');
      const r = await withD1Retry(() =>
        regenerateForStudent(db, {
          studentId: input.student_id,
          period: input.period,
          by: userId(c),
          dryRun: input.dry_run,
          proRata: input.pro_rata,
        }),
      );
      return c.json({ ...r, planned: r.planned.map(toPlannedDto) });
    },
  );

  // ---- reports ----

  /**
   * PLAN §14.5 defaulters. Teachers (fee.read own_groups) get their groups' students only, and a
   * dues summary only: no family, no payment detail.
   */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/defaulters', access: read },
    async (c) => {
      const q = queryParams(c, defaultersQuerySchema);
      const db = c.get('db');
      const grant = c.get('grant');
      const scope = await scopeToGroups(db, userId(c), grant);
      const rows = await defaulters(db, {
        today: todayPk(),
        grpId: q.grp_id ?? null,
        minMonths: q.min_months,
        minAmount: q.min_amount,
        excludeSponsored: q.exclude_sponsored,
        studentScope: studentFilter(sql`st.id`, scope),
      });
      if (scope.kind !== 'all')
        return c.json({
          summary_only: true,
          defaulters: rows.map((r) => ({
            student_id: r.student_id,
            student_name: r.student_name,
            admission_no: r.admission_no,
            grp_id: r.grp_id,
            group: r.group,
            months_overdue: r.months_overdue,
            overdue: r.overdue,
          })),
        });
      const total = rows.reduce((a, r) => a + r.overdue, 0);
      // The first guardian by priority, for the office's call / WhatsApp (M3b rows show the phone).
      const fams = [...new Set(rows.map((r) => r.family_id))];
      const guardians = fams.length
        ? await db.all<{ family_id: string; name: string; phone: string | null }>(sql`
            SELECT g.family_id, g.name, COALESCE(g.whatsapp, g.phone) AS phone FROM guardian g
            WHERE g.id = (SELECT g2.id FROM guardian g2 WHERE g2.family_id = g.family_id
                          ORDER BY g2.priority, g2.created_at, g2.id LIMIT 1)
              AND g.family_id IN (SELECT value FROM json_each(${JSON.stringify(fams)}))`)
        : [];
      const byFamily = new Map(guardians.map((g) => [g.family_id, g]));
      const out: DefaulterDto[] = rows.map((r) => ({
        ...r,
        guardian_name: byFamily.get(r.family_id)?.name ?? null,
        guardian_phone: byFamily.get(r.family_id)?.phone ?? null,
      }));
      return c.json({ summary_only: false, defaulters: out, total_overdue: total });
    },
  );

  /**
   * "Remind all" (PLAN §14.5): one fee_due/fee_overdue message per family into the outbox, with a
   * cooldown per family and template. ≤ 200 families per request; `more` = call again.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/fees/defaulters/remind', access: requires('send_queue', 'use') },
    async (c) => {
      const input = await jsonBody(c, remindInputSchema);
      const db = c.get('db');
      const uid = userId(c);
      const today = todayPk();
      const settings = await feeSettings(db);
      const scope = await scopeToGroups(db, uid, c.get('grant'));
      const cooled = sql`st.family_id NOT IN (SELECT family_id FROM reminder_state
        WHERE template_key = ${input.template} AND last_sent_on > date(${today}, ${`-${settings.cooldownDays} days`}))`;
      const scoped = studentFilter(sql`st.id`, scope);
      const studentScope = scoped ? sql`${scoped} AND ${cooled}` : cooled;
      let rows: {
        student_id: string;
        student_name: string;
        family_id: string;
        overdue: number;
        due: number;
        months_overdue: number;
      }[];
      if (input.template === 'fee_overdue') {
        rows = await defaulters(db, {
          today,
          grpId: input.grp_id ?? null,
          minMonths: input.min_months,
          minAmount: input.min_amount,
          excludeSponsored: input.exclude_sponsored,
          studentScope,
          limit: 5000,
        });
      } else {
        rows = await db.all(sql`SELECT st.id AS student_id, st.name AS student_name, st.family_id,
            0 AS overdue, sum(cs.due) AS due, 0 AS months_overdue
          FROM charge_status cs JOIN student st ON st.id = cs.student_id
          WHERE cs.payer_type = 'family' AND cs.due > 0 AND cs.due_date >= ${today} AND ${studentScope}
            ${input.grp_id ? sql`AND st.id IN (SELECT student_id FROM enrolment WHERE grp_id = ${input.grp_id} AND status = 'active')` : sql``}
          GROUP BY st.id ORDER BY st.family_id LIMIT 5000`);
      }
      if (input.template === 'fee_due' && rows.length) {
        // What is due is net of the family's unallocated credit (defaulters() already nets).
        const credits = new Map(
          (
            await db.all<{
              payer_id: string;
              credit: number;
            }>(sql`SELECT payer_id, credit FROM payer_credit
              WHERE payer_type = 'family' AND credit > 0
                AND payer_id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(rows.map((r) => r.family_id))])}))`)
          ).map((r) => [r.payer_id, r.credit]),
        );
        rows = rows
          .map((r) => {
            const left = credits.get(r.family_id) ?? 0;
            credits.set(r.family_id, Math.max(0, left - r.due));
            return { ...r, due: netOfCredit(r.due, left) };
          })
          .filter((r) => r.due > 0);
      }
      const byFamily = new Map<string, typeof rows>();
      for (const r of rows) byFamily.set(r.family_id, [...(byFamily.get(r.family_id) ?? []), r]);
      const families = [...byFamily.entries()].slice(0, 200);
      const msgRows = families.map(([f, list]) => ({
        m: newId(),
        f,
        p: {
          student_ids: list.map((r) => r.student_id),
          student_names: list.map((r) => r.student_name),
          overdue: list.reduce((a, r) => a + r.overdue, 0),
          due: list.reduce((a, r) => a + r.due, 0),
          months_overdue: Math.max(...list.map((r) => r.months_overdue)),
          as_of: today,
        },
      }));
      const stmts = familyMessageStatements({
        template: input.template,
        today,
        by: uid,
        cooldownDays: settings.cooldownDays,
        rows: msgRows,
      });
      if (stmts.length) await tx(db, stmts);
      const ids = msgRows.map((m) => m.m);
      const [n] = ids.length
        ? await db.all<{ n: number }>(
            sql`SELECT count(*) AS n FROM message WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
          )
        : [{ n: 0 }];
      return c.json({ queued: n?.n ?? 0, more: byFamily.size > families.length });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/register', access: money },
    async (c) => {
      const q = queryParams(c, registerQuerySchema);
      const rows = await feeRegister(c.get('db'), { grpId: q.grp_id, period: q.period });
      if (q.format === 'csv') {
        const head = [
          'Roll no',
          'Admission no',
          'Student',
          'Father',
          'Fee',
          'Payer',
          'Gross',
          'Concession',
          'Fine',
          'Net',
          'Paid',
          'Due',
          'Status',
        ];
        const lines = [
          toCsvLine(head),
          ...rows.map((r) =>
            toCsvLine([
              r.roll_no,
              r.admission_no,
              r.student_name,
              r.father_name,
              r.head_name,
              r.payer_type,
              rupees(r.gross),
              rupees(r.concession),
              rupees(r.fine),
              rupees(r.net),
              rupees(r.paid),
              rupees(r.due),
              r.status,
            ]),
          ),
        ];
        return c.body(`﻿${lines.join('\r\n')}\r\n`, 200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="fee-register-${q.period}.csv"`,
        });
      }
      const totals = rows.reduce(
        (t, r) => ({
          gross: t.gross + r.gross,
          concession: t.concession + r.concession,
          fine: t.fine + r.fine,
          net: t.net + r.net,
          paid: t.paid + r.paid,
          due: t.due + r.due,
        }),
        { gross: 0, concession: 0, fine: 0, net: 0, paid: 0, due: 0 },
      );
      return c.json({ period: q.period, grp_id: q.grp_id, rows, totals });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/concessions/register', access: money },
    async (c) => {
      const q = queryParams(c, concessionRegisterQuerySchema);
      const rows = await concessionRegister(c.get('db'), {
        from: q.from ?? null,
        to: q.to ?? null,
        reason: q.reason ?? null,
        activeOn: q.active_on ?? null,
      });
      return c.json({
        concessions: rows,
        total_given: rows.reduce((a, r) => a + r.amount_given, 0),
      });
    },
  );

  // ---- M3b read endpoints (thin; no money writes) ----

  /** The student detail "Fees" tab: this child's lines, concessions, sponsorships, opening balance. */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/student/:id', access: money },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [st] = await db.all<{
        id: string;
        name: string;
        admission_no: string;
        family_id: string;
      }>(sql`SELECT id, name, admission_no, family_id FROM student WHERE id = ${id}`);
      if (!st) throw notFoundError('Student');
      const fam = await familyStatement(db, st.family_id, todayPk());
      if (!fam) throw notFoundError('Family');
      const lines = fam.charges.filter((l) => l.student_id === id);
      const concessions = await db.all<ConcessionDto>(sql`SELECT k.id, k.student_id,
          st.name AS student_name, k.fee_head_id, h.name AS head_name, k.type, k.value, k.reason,
          k.note, k.valid_from, k.valid_to, k.ended_at, k.end_reason, k.created_at
        FROM concession k JOIN student st ON st.id = k.student_id
        LEFT JOIN fee_head h ON h.id = k.fee_head_id
        WHERE k.student_id = ${id} ORDER BY k.valid_from DESC, k.created_at DESC`);
      const sponsorships = await db.all<SponsorshipDto>(sql`SELECT sp.id, sp.sponsor_id,
          s.name AS sponsor_name, sp.student_id, sp.fee_head_id, h.name AS head_name, sp.share_pct,
          sp.valid_from, sp.valid_to
        FROM sponsorship sp JOIN sponsor s ON s.id = sp.sponsor_id
        LEFT JOIN fee_head h ON h.id = sp.fee_head_id
        WHERE sp.student_id = ${id} ORDER BY sp.valid_from DESC`);
      const [ob] = await db.all<{ amount: number; as_of: string; note: string | null }>(
        sql`SELECT amount, as_of, note FROM opening_balance WHERE student_id = ${id}`,
      );
      const body: StudentFeesDto = {
        student: st,
        family_name: fam.family.name,
        lines,
        sponsored: fam.sponsored.filter((l) => l.student_id === id),
        due: lines.reduce((a, l) => a + Math.max(0, l.due), 0),
        family_due: fam.totals.due,
        family_credit: fam.credit,
        concessions,
        sponsorships,
        opening_balance: ob ?? null,
        receipts: fam.receipts,
      };
      return c.json(body);
    },
  );

  /** Office fee tiles (PLAN §14.11): today's collection, dues, defaulters, alerts, queued messages. */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/dashboard/fees', access: money },
    async (c) => {
      const db = c.get('db');
      const today = todayPk();
      const rows = await collectionByCollector(db, { from: today, to: today });
      const byMethod = new Map<string, { amount: number; count: number }>();
      for (const r of rows) {
        const m = byMethod.get(r.method) ?? { amount: 0, count: 0 };
        byMethod.set(r.method, { amount: m.amount + r.net, count: m.count + r.payments });
      }
      const [dues] = await db.all<{
        n: number;
      }>(sql`SELECT coalesce(sum(max(0, d.due - coalesce(pc.credit, 0))), 0) AS n
        FROM (SELECT payer_id, sum(due) AS due FROM charge_status
              WHERE payer_type = 'family' AND due > 0 GROUP BY payer_id) d
        LEFT JOIN payer_credit pc ON pc.payer_type = 'family' AND pc.payer_id = d.payer_id`);
      const [queued] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM message
        WHERE status = 'queued' AND template_key IN ('fee_due', 'fee_overdue', 'payment_received')`);
      const late = await defaulters(db, { today, limit: 5000 });
      const collected = [...byMethod.entries()].map(([method, v]) => ({
        method: method as FeeDashboardDto['collected'][number]['method'],
        ...v,
      }));
      const body: FeeDashboardDto = {
        date: today,
        collected,
        collected_total: collected.reduce((a, r) => a + r.amount, 0),
        dues_outstanding: Number(dues?.n ?? 0),
        defaulters: late.length,
        billing_alerts: (await failingGroups(db, today.slice(0, 7))).filter(
          (f) => f.attention_required,
        ).length,
        queued_fee_messages: Number(queued?.n ?? 0),
      };
      return c.json(body);
    },
  );
}
