import {
  newId,
  RECYCLE_KINDS,
  type RecycleBinDto,
  type RecycleItemDto,
  type RecycleKind,
  type RetentionDto,
  retentionSchema,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { idParam, jsonBody, notFoundError, userId } from '../lib/http';
import { auditSql, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';

/**
 * Settings completeness (M6, PLAN §14.12): the recycle bin for reference data and data retention.
 * Nothing here deletes a row: programmes and subjects are soft-deleted (deleted_at), fee heads and
 * groups archived (archived_at), so every foreign key that points at them stays valid and a restore is
 * a single UPDATE.
 */
const restoreSchema = z.object({ kind: z.enum(RECYCLE_KINDS), id: z.string().min(1).max(64) });

export function settingsRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const manage = requires('settings', 'manage');

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/recycle-bin', access: manage },
    async (c) => {
      const rows = await c.get('db').all<RecycleItemDto>(sql`
        SELECT * FROM (
          SELECT 'programme' AS kind, id, name, deleted_at AS removed_at FROM programme WHERE deleted_at IS NOT NULL
          UNION ALL
          SELECT 'subject', id, name, deleted_at FROM subject WHERE deleted_at IS NOT NULL
          UNION ALL
          SELECT 'fee_head', id, name, archived_at FROM fee_head WHERE archived_at IS NOT NULL
          UNION ALL
          SELECT 'group', g.id, p.name || ' · ' || g.name, g.archived_at FROM grp g
            JOIN programme p ON p.id = g.programme_id WHERE g.archived_at IS NOT NULL
        ) ORDER BY removed_at DESC LIMIT 500`);
      const body: RecycleBinDto = { items: rows };
      return c.json(body);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/recycle-bin/restore', access: manage },
    async (c) => {
      const input = await jsonBody(c, restoreSchema);
      const db = c.get('db');
      const t: Record<RecycleKind, { table: string; col: string }> = {
        programme: { table: 'programme', col: 'deleted_at' },
        subject: { table: 'subject', col: 'deleted_at' },
        fee_head: { table: 'fee_head', col: 'archived_at' },
        group: { table: 'grp', col: 'archived_at' },
      };
      const { table: tbl, col } = t[input.kind];
      const [row] = await db.all<{ name: string; removed: string | null; programme_id?: string }>(
        sql`SELECT name, ${sql.identifier(col)} AS removed
            ${input.kind === 'group' ? sql`, programme_id` : sql``}
            FROM ${sql.identifier(tbl)} WHERE id = ${input.id}`,
      );
      if (!row?.removed) throw notFoundError('Item in the recycle bin');
      if (input.kind === 'programme' || input.kind === 'subject') {
        // The pickers and the PK seed treat names as unique among live rows.
        const [dup] = await db.all<{ id: string }>(
          sql`SELECT id FROM ${sql.identifier(tbl)} WHERE deleted_at IS NULL
              AND lower(name) = lower(${row.name}) LIMIT 1`,
        );
        if (dup)
          throw new ApiError(
            409,
            'name_taken',
            'Another item with this name is in use; rename it first',
          );
      }
      if (input.kind === 'group') {
        const [p] = await db.all<{ deleted_at: string | null }>(
          sql`SELECT deleted_at FROM programme WHERE id = ${row.programme_id ?? ''}`,
        );
        if (!p || p.deleted_at)
          throw new ApiError(409, 'parent_removed', 'Restore its programme first');
      }
      await tx(db, [
        sql`UPDATE ${sql.identifier(tbl)} SET ${sql.identifier(col)} = NULL WHERE id = ${input.id}`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: tbl,
          entityId: input.id,
          action: 'restore',
          before: { [col]: row.removed },
          after: { [col]: null },
        }),
      ]);
      return c.json({ ok: true });
    },
  );

  /**
   * Archive a group (recycle bin). Only a group no student was ever enrolled in: one with history
   * stays visible (set it to "closed" instead), so registers, charges and reports keep their group.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/groups/:id/archive', access: manage },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [g] = await db.all<{ archived_at: string | null }>(
        sql`SELECT archived_at FROM grp WHERE id = ${id}`,
      );
      if (!g) throw notFoundError('Group');
      if (g.archived_at) return c.json({ ok: true });
      const [used] = await db.all<{ n: number }>(sql`
        SELECT (SELECT count(*) FROM enrolment WHERE grp_id = ${id})
             + (SELECT count(*) FROM att_register WHERE grp_id = ${id}) AS n`);
      if (Number(used?.n ?? 0) > 0)
        throw new ApiError(409, 'in_use', 'This group has enrolments; close it instead');
      const now = new Date().toISOString();
      await tx(db, [
        sql`UPDATE grp SET archived_at = ${now} WHERE id = ${id} AND archived_at IS NULL`,
        // Promotion pointers to it would lead nowhere visible.
        sql`UPDATE grp SET next_grp_id = NULL WHERE next_grp_id = ${id}`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'grp',
          entityId: id,
          action: 'archive',
          after: { archived_at: now },
        }),
      ]);
      return c.json({ ok: true });
    },
  );

  // ---- Data retention --------------------------------------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/settings/retention', access: manage },
    async (c) => {
      const [row] = await c
        .get('db')
        .all<RetentionDto>(sql`SELECT access_log_days FROM school ORDER BY created_at LIMIT 1`);
      return c.json({ access_log_days: Number(row?.access_log_days ?? 90) } satisfies RetentionDto);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/settings/retention', access: manage },
    async (c) => {
      const input = await jsonBody(c, retentionSchema);
      const db = c.get('db');
      const [row] = await db.all<{ id: string; access_log_days: number }>(
        sql`SELECT id, access_log_days FROM school ORDER BY created_at LIMIT 1`,
      );
      if (!row) throw notFoundError('School');
      if (row.access_log_days !== input.access_log_days)
        await tx(db, [
          sql`UPDATE school SET access_log_days = ${input.access_log_days} WHERE id = ${row.id}`,
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'school',
            entityId: row.id,
            action: 'update',
            before: { access_log_days: row.access_log_days },
            after: { access_log_days: input.access_log_days },
          }),
        ]);
      return c.json(input satisfies RetentionDto);
    },
  );
}
