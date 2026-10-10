import {
  assertSessionOpen,
  collect,
  collectionByCollector,
  duesAfterUnwind,
  ensureSeries,
  ensureSessionStatement,
  familyStatement,
  feeSettings,
  oldestFirst,
  receiptDetail,
  refund,
  reverseReceipt,
  searchFamilies,
  seriesFor,
  sessionIdFor,
} from '@maktab/db';
import {
  type CollectResultDto,
  collectInputSchema,
  collectionQuerySchema,
  type FamilyStatementDto,
  newId,
  type ReceiptDetailDto,
  refundInputSchema,
  reverseInputSchema,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { defaultAccount, familyMessageStatements, receiptPrint } from '../lib/fees';
import { idParam, jsonBody, notFoundError, queryParams, todayPk, userId } from '../lib/http';
import { withD1Retry } from '../lib/retry';
import { tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';

async function payerExists(
  c: { get: (k: 'db') => import('@maktab/db').AppDb },
  type: 'family' | 'sponsor',
  id: string,
): Promise<void> {
  const [row] = await c
    .get('db')
    .all(
      type === 'family'
        ? sql`SELECT id FROM family WHERE id = ${id}`
        : sql`SELECT id FROM sponsor WHERE id = ${id}`,
    );
  if (!row) throw new ApiError(400, 'invalid', `Unknown ${type}`);
}

/** Owner/admin may enter a receipt for yesterday (with a reason); everyone else, today only. */
const mayBackdate = (c: { get: (k: 'principal') => Principal | null | undefined }) =>
  !!c.get('principal')?.roles.some((r) => r === 'owner' || r === 'admin');

async function accountFor(
  db: import('@maktab/db').AppDb,
  method: string,
  given: string | null | undefined,
): Promise<string | null> {
  if (method === 'cash') return null;
  if (given) {
    const [a] = await db.all(sql`SELECT id FROM account WHERE id = ${given}`);
    if (!a) throw new ApiError(400, 'invalid', 'Unknown account');
    return given;
  }
  const id = await defaultAccount(db, method);
  if (!id)
    throw new ApiError(
      400,
      'account_required',
      'Add a bank or wallet account (Settings) or name account_id for a non-cash payment',
    );
  return id;
}

export function receiptRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const money = requires('receipt', 'read');

  /** PLAN §14.4 step 1: name, admission no. or guardian phone → families with dues. */
  defineRoute(app, table, { method: 'GET', path: '/api/fees/search', access: money }, async (c) => {
    const q = queryParams(c, z.object({ q: z.string().trim().min(2).max(60) }));
    return c.json({ families: await searchFamilies(c.get('db'), q.q) });
  });

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/family/:id', access: money },
    async (c) => {
      const st: FamilyStatementDto | null = await familyStatement(
        c.get('db'),
        idParam(c),
        todayPk(),
      );
      if (!st) throw notFoundError('Family');
      return c.json(st);
    },
  );

  /**
   * The fee counter (PLAN §14.4): one receipt per visit, oldest dues first across the family (or
   * `directed`), remainder as credit; the collector's cash session (today's) opens on the first cash
   * receipt. business_date: today, or yesterday for an owner/admin with `backdate_reason` (audited);
   * else 400 bad_business_date. `expected_due_hash` (the family view's dues_hash) turns a changed
   * family into 409 stale_dues. Retry-safe: the same user's idempotency_key returns the same receipt
   * (`replayed: true`); another user's is 409 idempotency_conflict.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/receipts', access: requires('receipt', 'create') },
    async (c) => {
      const input = await jsonBody(c, collectInputSchema);
      const db = c.get('db');
      await payerExists(c, input.payer_type, input.payer_id);
      const receiptId = newId();
      const accountId = await accountFor(db, input.method, input.account_id);
      const r = await withD1Retry(() =>
        collect(db, {
          receiptId,
          payerType: input.payer_type,
          payerId: input.payer_id,
          amount: input.amount,
          method: input.method,
          reference: input.reference ?? null,
          accountId,
          note: input.note ?? null,
          businessDate: input.business_date,
          today: todayPk(),
          allowYesterday: mayBackdate(c),
          backdateReason: input.backdate_reason ?? null,
          collectorId: userId(c),
          idempotencyKey: input.idempotency_key,
          directed: input.directed?.map((d) => ({ chargeId: d.charge_id, amount: d.amount })),
          expectedDueHash: input.expected_due_hash ?? null,
        }),
      );
      const receipt = (await receiptDetail(db, r.receipt_id)) as ReceiptDetailDto;
      const body: CollectResultDto = { receipt, replayed: r.replayed };
      return c.json(body, r.replayed ? 200 : 201);
    },
  );

  /** `?format=print` → the print-ready JSON (school header, ur/en labels, one block per child). */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/receipts/:id', access: money },
    async (c) => {
      const q = queryParams(c, z.object({ format: z.enum(['json', 'print']).default('json') }));
      const db = c.get('db');
      const id = idParam(c);
      if (q.format === 'print') {
        const p = await receiptPrint(db, id);
        if (!p) throw notFoundError('Receipt');
        return c.json(p);
      }
      const r = await receiptDetail(db, id);
      if (!r) throw notFoundError('Receipt');
      return c.json({ receipt: r });
    },
  );

  /**
   * Reversal with reason (admin/owner; PLAN §5.4 separation of duties) and the optional
   * "re-enter correctly" payment, one batch via reverseReceipt. Both land in the reverser's cash
   * session for today (the original day may be closed — PLAN §14.6).
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/receipts/:id/reverse', access: requires('receipt', 'reverse') },
    async (c) => {
      const input = await jsonBody(c, reverseInputSchema);
      const db = c.get('db');
      const uid = userId(c);
      const id = idParam(c);
      const orig = await receiptDetail(db, id);
      if (!orig) throw notFoundError('Receipt');
      if (orig.kind !== 'payment')
        throw new ApiError(409, 'not_a_payment', 'Only a payment can be reversed');
      if (orig.reversed_by) throw new ApiError(409, 'already_reversed', 'Already reversed');
      const today = todayPk();
      const reenterMethod = input.reenter ? (input.reenter.method ?? orig.method) : null;
      const touchesDrawer = orig.method === 'cash' || reenterMethod === 'cash';
      if (touchesDrawer) await assertSessionOpen(db, uid, today);
      const settings = await feeSettings(db);
      const series = seriesFor(settings.receiptPrefix, today);
      let reenter: Parameters<typeof reverseReceipt>[1]['reenter'];
      if (input.reenter) {
        const re = input.reenter;
        let rows: { chargeId: string; amount: number }[];
        if (re.directed?.length) {
          rows = re.directed.map((d) => ({ chargeId: d.charge_id, amount: d.amount }));
          if (rows.reduce((a, r) => a + r.amount, 0) > re.amount)
            throw new ApiError(400, 'invalid', 'directed: more than the amount');
        } else {
          rows = oldestFirst(
            await duesAfterUnwind(db, orig.payer_type, orig.payer_id, id),
            re.amount,
          ).rows;
        }
        reenter = {
          amount: re.amount,
          method: re.method,
          accountId:
            reenterMethod && reenterMethod !== orig.method
              ? await accountFor(db, reenterMethod, null)
              : undefined,
          reference: re.reference ?? null,
          allocations: rows.map((r) => ({ id: newId(), chargeId: r.chargeId, amount: r.amount })),
        };
      }
      const reversalId = newId();
      const reentryId = newId();
      const result = await withD1Retry(() =>
        reverseReceipt(db, {
          receiptId: id,
          byUserId: uid,
          reason: input.reason,
          series,
          reversalId,
          businessDate: today,
          prelude: [
            ensureSeries(series),
            ...(touchesDrawer ? [ensureSessionStatement(uid, today)] : []),
          ],
          cashSessionId: touchesDrawer ? sessionIdFor(uid, today) : null,
          reenter: reenter ? { ...reenter, id: reentryId } : undefined,
        }),
      );
      return c.json(
        {
          reversal: await receiptDetail(db, result.reversalId),
          reentry: result.reentryId ? await receiptDetail(db, result.reentryId) : null,
        },
        201,
      );
    },
  );

  /** Money paid back out of credit only (PLAN §5.2); a money-out action, so admin/owner. */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/refunds', access: requires('receipt', 'reverse') },
    async (c) => {
      const input = await jsonBody(c, refundInputSchema);
      const db = c.get('db');
      await payerExists(c, input.payer_type, input.payer_id);
      const id = newId();
      const accountId = await accountFor(db, input.method, null);
      const r = await withD1Retry(() =>
        refund(db, {
          id,
          payerType: input.payer_type,
          payerId: input.payer_id,
          amount: input.amount,
          method: input.method,
          accountId,
          reason: input.reason,
          reference: input.reference ?? null,
          by: userId(c),
          businessDate: todayPk(),
          idempotencyKey: input.idempotency_key,
        }),
      );
      return c.json(
        { receipt: await receiptDetail(db, r.receipt_id), replayed: r.replayed },
        r.replayed ? 200 : 201,
      );
    },
  );

  /** "Send on WhatsApp" (PLAN §14.4 step 4): one payment_received message per receipt. */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/receipts/:id/notify', access: requires('receipt', 'create') },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const r = await receiptDetail(db, id);
      if (!r) throw notFoundError('Receipt');
      if (r.payer_type !== 'family' || r.kind !== 'payment')
        throw new ApiError(409, 'not_notifiable', 'Only a family payment can be sent');
      const [existing] = await db.all<{ id: string }>(sql`SELECT id FROM message
        WHERE template_key = 'payment_received' AND json_extract(payload, '$.receipt_id') = ${id}`);
      if (existing) return c.json({ message_id: existing.id, queued: false });
      const m = newId();
      await tx(
        db,
        familyMessageStatements({
          template: 'payment_received',
          today: todayPk(),
          by: userId(c),
          cooldownDays: null,
          rows: [
            {
              m,
              f: r.payer_id,
              p: {
                receipt_id: r.id,
                receipt_no: r.receipt_no,
                amount: r.amount,
                business_date: r.business_date,
                student_names: [...new Set(r.allocations.map((a) => a.student_name))],
                due_after: r.payer_due,
                credit_after: r.payer_credit,
              },
            },
          ],
        }),
      );
      return c.json({ message_id: m, queued: true }, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/fees/collection', access: money },
    async (c) => {
      const q = queryParams(c, collectionQuerySchema);
      if (q.to < q.from) throw new ApiError(400, 'invalid', 'to: before from');
      const rows = await collectionByCollector(c.get('db'), { from: q.from, to: q.to });
      return c.json({ from: q.from, to: q.to, rows, total: rows.reduce((a, r) => a + r.net, 0) });
    },
  );
}
