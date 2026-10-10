import {
  accountList,
  closeSession,
  drawerAccountOf,
  openSession,
  recordTransfer,
  reopenSession,
  type SessionRow,
  sessionFor,
  setAccountOpening,
  updateAccount,
} from '@maktab/db';
import {
  accountInputSchema,
  accountOpeningSchema,
  accountUpdateSchema,
  newId,
  sessionCloseSchema,
  sessionOpenSchema,
  sessionReopenSchema,
  transferInputSchema,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { principalRoles } from '../auth/principal';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { sessionDtos } from '../lib/fees';
import { idParam, jsonBody, notFoundError, queryParams, todayPk, userId } from '../lib/http';
import { auditSql, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';

/**
 * Cash sessions (PLAN §14.6): one per collector per day, opened by the first receipt or here,
 * closed with a count (expected derived inside the closing statement), reopened only by an
 * owner/admin with a reason. Transfers move money between accounts (never income or expense).
 */
export function cashRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/cash/sessions', access: requires('cash_session', 'read') },
    async (c) => {
      const q = queryParams(
        c,
        z.object({
          date: z.iso.date().optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          collector_id: z.string().optional(),
          status: z.enum(['open', 'closed']).optional(),
        }),
      );
      const db = c.get('db');
      // own_only (accountant): their own drawer, whatever collector_id says.
      const collector = c.get('grant') === 'all' ? (q.collector_id ?? null) : userId(c);
      const from = q.date ?? q.from ?? null;
      const to = q.date ?? q.to ?? null;
      const rows = await db.all<SessionRow>(sql`SELECT * FROM cash_session WHERE 1
        ${collector ? sql`AND collector_id = ${collector}` : sql``}
        ${from ? sql`AND business_date >= ${from}` : sql``}
        ${to ? sql`AND business_date <= ${to}` : sql``}
        ${q.status === 'open' ? sql`AND closed_at IS NULL` : q.status === 'closed' ? sql`AND closed_at IS NOT NULL` : sql``}
        ORDER BY business_date DESC, collector_id LIMIT 100`);
      return c.json({ sessions: await sessionDtos(db, rows) });
    },
  );

  /** Opens the caller's own drawer for a day (with an opening float); returns it if already open. */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/cash/sessions', access: requires('cash_session', 'close_own') },
    async (c) => {
      const input = await jsonBody(c, sessionOpenSchema);
      const date = input.business_date ?? todayPk();
      if (date > todayPk()) throw new ApiError(400, 'invalid', 'business_date: in the future');
      // A drawer is never opened for a past day (M3 fix pass); an existing one is returned as is.
      if (date < todayPk() && !(await sessionFor(c.get('db'), userId(c), date)))
        throw new ApiError(400, 'bad_business_date', 'A cash session can only be opened for today');
      const s = await openSession(c.get('db'), {
        collectorId: userId(c),
        businessDate: date,
        opening: input.opening,
      });
      const [dto] = await sessionDtos(c.get('db'), [s]);
      return c.json({ session: dto }, 201);
    },
  );

  defineRoute(
    app,
    table,
    {
      method: 'POST',
      path: '/api/cash/sessions/:id/close',
      access: requires('cash_session', 'close_own'),
    },
    async (c) => {
      const input = await jsonBody(c, sessionCloseSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [s] = await db.all<{ collector_id: string }>(
        sql`SELECT collector_id FROM cash_session WHERE id = ${id}`,
      );
      if (!s) throw notFoundError('Cash session');
      if (s.collector_id !== userId(c))
        throw new ApiError(403, 'forbidden', 'You can close only your own cash session');
      const closed = await closeSession(db, {
        sessionId: id,
        counted: input.counted,
        by: userId(c),
      });
      const [dto] = await sessionDtos(db, [closed]);
      return c.json({ session: dto });
    },
  );

  defineRoute(
    app,
    table,
    {
      method: 'POST',
      path: '/api/cash/sessions/:id/reopen',
      access: requires('cash_session', 'reopen_any'),
    },
    async (c) => {
      const input = await jsonBody(c, sessionReopenSchema);
      const db = c.get('db');
      const s = await reopenSession(db, {
        sessionId: idParam(c),
        reason: input.reason,
        by: userId(c),
      });
      const [dto] = await sessionDtos(db, [s]);
      return c.json({ session: dto });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/transfers', access: requires('cash_session', 'transfer') },
    async (c) => {
      const input = await jsonBody(c, transferInputSchema);
      const db = c.get('db');
      const date = input.date ?? todayPk();
      if (date > todayPk()) throw new ApiError(400, 'invalid', 'date: in the future');
      const id = await recordTransfer(db, {
        id: input.id ?? newId(),
        fromAccount: input.from_account,
        toAccount: input.to_account,
        amount: input.amount,
        date,
        note: input.note ?? null,
        by: userId(c),
      });
      const [row] = await db.all(sql`SELECT * FROM transfer WHERE id = ${id}`);
      return c.json({ transfer: row }, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/accounts', access: requires('cash_session', 'transfer') },
    async (c) => {
      // `my_drawer`: the caller's own drawer — the only cash account they can pay out of or move
      // cash from (M4 fix pass, F3); pickers offer it and the bank/wallet accounts.
      const db = c.get('db');
      const rows = await accountList(db);
      return c.json({
        accounts: rows.map((r) => ({ ...r, has_movements: !!r.has_movements })),
        my_drawer: await drawerAccountOf(db, userId(c)),
      });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/accounts/:id', access: requires('settings', 'manage') },
    async (c) => {
      const input = await jsonBody(c, accountUpdateSchema);
      const db = c.get('db');
      const id = idParam(c);
      await updateAccount(db, {
        accountId: id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.holder_staff_id !== undefined ? { holderStaffId: input.holder_staff_id } : {}),
        by: userId(c),
      });
      const [row] = (await accountList(db)).filter((a) => a.id === id);
      return c.json({ account: row ? { ...row, has_movements: !!row.has_movements } : null });
    },
  );

  /**
   * Pre-pilot opening balance: owners only (settings.manage, then the owner role here), once, before
   * any money moved through the account (409 opening_already_set / account_has_movements).
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/accounts/:id/opening', access: requires('settings', 'manage') },
    async (c) => {
      const p = c.get('principal');
      if (!p || !principalRoles(p).includes('owner'))
        throw new ApiError(403, 'forbidden', 'Only an owner sets an opening balance');
      const input = await jsonBody(c, accountOpeningSchema);
      const db = c.get('db');
      const id = idParam(c);
      await setAccountOpening(db, {
        accountId: id,
        amount: input.amount,
        asOf: input.as_of,
        today: todayPk(),
        by: userId(c),
      });
      const [row] = (await accountList(db)).filter((a) => a.id === id);
      return c.json({ account: row ? { ...row, has_movements: !!row.has_movements } : null });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/accounts', access: requires('settings', 'manage') },
    async (c) => {
      const input = await jsonBody(c, accountInputSchema);
      const db = c.get('db');
      const id = input.id ?? newId();
      const after = {
        name: input.name,
        kind: input.kind,
        holder_staff_id: input.holder_staff_id ?? null,
      };
      await tx(db, [
        sql`INSERT INTO account (id, name, kind, holder_staff_id, created_by)
            VALUES (${id}, ${after.name}, ${after.kind}, ${after.holder_staff_id}, ${userId(c)})`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'account',
          entityId: id,
          action: 'create',
          after,
        }),
      ]);
      return c.json({ account: { id, ...after } }, 201);
    },
  );
}
