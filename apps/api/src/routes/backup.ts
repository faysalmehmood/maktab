import { evaluateAlarms } from '@maktab/db';
import {
  type AlarmDto,
  type AlarmEventDto,
  type BackupObjectDto,
  type BackupRunDto,
  type BackupRunKind,
  type BackupRunStatus,
  type BackupStatusDto,
  backupRunInputSchema,
  EXPORT_EXCLUDED_TABLES,
  EXPORT_PART_ROWS,
  EXPORT_REDACTED_COLUMNS,
  type ExportCell,
  type ExportJobDto,
  type ExportPartDto,
  exportFinishSchema,
  manualDrillSchema,
  newId,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { utf8 } from '../lib/b64';
import { ApiError } from '../lib/errors';
import { jsonBody, notFoundError, queryParams, userId } from '../lib/http';
import { auditSql, tx } from '../lib/tx';
import { defineRoute, publicRoute, type RouteTable, requires } from '../perm/routes';

/** An export job is usable for this long after it was created (a big school takes minutes). */
const JOB_TTL_MS = 24 * 3_600_000;

/** sqlite_master names that are never the school's data (SQLite and D1 internals). */
const INTERNAL = sql`substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'`;

type RunRow = {
  id: string;
  kind: BackupRunKind;
  status: BackupRunStatus;
  started_at: string | null;
  finished_at: string;
  object_key: string | null;
  bytes: number | null;
  sha256: string | null;
  targets: string | null;
  details: string | null;
  run_url: string | null;
  note: string | null;
  created_by_name: string | null;
};

const parseJson = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const runDto = (r: RunRow): BackupRunDto => ({
  ...r,
  targets: parseJson(r.targets, []),
  details: parseJson(r.details, null),
});

const RUN_SELECT = sql`SELECT b.id, b.kind, b.status, b.started_at, b.finished_at, b.object_key, b.bytes,
  b.sha256, b.targets, b.details, b.run_url, b.note, u.name AS created_by_name
  FROM backup_run b LEFT JOIN user u ON u.id = b.created_by`;

/** Constant-time comparison of two secrets (hashed first so lengths never leak). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', utf8(a)),
    crypto.subtle.digest('SHA-256', utf8(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= (xa[i] ?? 0) ^ (ya[i] ?? 0);
  return diff === 0;
}

async function loadJob(c: Context<AppEnv>, id: string): Promise<{ tables: string[] }> {
  const [job] = await c.get('db').all<{
    created_by: string;
    created_at: string;
    tables: string;
    finished_at: string | null;
  }>(sql`SELECT created_by, created_at, tables, finished_at FROM export_job WHERE id = ${id}`);
  // Someone else's job is "not found" too: an export belongs to the owner who started it.
  if (!job || job.created_by !== userId(c)) throw notFoundError('Export');
  if (job.finished_at) throw new ApiError(409, 'export_finished', 'This export is finished');
  if (Date.parse(job.created_at) < Date.now() - JOB_TTL_MS)
    throw new ApiError(409, 'export_expired', 'This export has expired; start a new one');
  return { tables: parseJson<string[]>(job.tables, []) };
}

export function backupRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const manage = requires('backup', 'manage');

  // ---- Download everything (PLAN §9 layer 5) --------------------------------------------------
  // The Worker cannot build a ZIP of the whole database inside 10 ms CPU, so the browser does:
  // POST starts a job (table list + schema.sql), then GET …/part pulls ≤ 200 rows of one table per
  // request (keyset on rowid: each part reads only its own rows, never an OFFSET scan), and POST
  // …/finish records what was saved. CSV (formula-safe) and the ZIP are made in the browser.
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/backup/export', access: manage },
    async (c) => {
      const db = c.get('db');
      const master = await db.all<{ type: string; name: string; sql: string }>(sql`
        SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND ${INTERNAL}
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`);
      const excluded = new Set<string>(EXPORT_EXCLUDED_TABLES);
      const tables = master
        .filter((m) => m.type === 'table' && !excluded.has(m.name))
        .map((m) => m.name);
      const schemaSql = master.map((m) => `${m.sql.trim()};`).join('\n\n');
      const id = newId();
      const uid = userId(c);
      await tx(db, [
        sql`INSERT INTO export_job (id, created_by, tables) VALUES (${id}, ${uid}, ${JSON.stringify(tables)})`,
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'export_job',
          entityId: id,
          action: 'start',
          after: { tables: tables.length, excluded: [...excluded] },
        }),
      ]);
      const [row] = await db.all<{ created_at: string }>(
        sql`SELECT created_at FROM export_job WHERE id = ${id}`,
      );
      const body: ExportJobDto = {
        id,
        created_at: row?.created_at ?? new Date().toISOString(),
        tables,
        schema: `-- Maktab schema (sqlite_master), ${new Date().toISOString()}\n\n${schemaSql}\n`,
      };
      return c.json(body, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/backup/export/:id/part', access: manage },
    async (c) => {
      const q = queryParams(
        c,
        z.object({
          table: z.string().min(1).max(64),
          after: z.coerce.number().int().min(0).default(0),
        }),
      );
      const job = await loadJob(c, c.req.param('id') ?? '');
      // Only names fixed at job creation (from sqlite_master): never an arbitrary identifier.
      if (!job.tables.includes(q.table))
        throw new ApiError(400, 'invalid', 'table: not part of this export');
      const db = c.get('db');
      const cols = await db.all<{ name: string }>(
        sql`SELECT name FROM pragma_table_info(${q.table}) ORDER BY cid`,
      );
      const redacted = new Set(EXPORT_REDACTED_COLUMNS[q.table] ?? []);
      const columns = cols.map((x) => x.name).filter((n) => !redacted.has(n));
      const list = sql.join(
        columns.map((n) => sql.identifier(n)),
        sql`, `,
      );
      const rows = await db.all<Record<string, ExportCell> & { __rowid__: number }>(sql`
        SELECT rowid AS __rowid__${columns.length ? sql`, ${list}` : sql``}
        FROM ${sql.identifier(q.table)} WHERE rowid > ${q.after} ORDER BY rowid
        LIMIT ${EXPORT_PART_ROWS + 1}`);
      const page = rows.slice(0, EXPORT_PART_ROWS);
      const body: ExportPartDto = {
        table: q.table,
        columns,
        rows: page.map((r) => columns.map((n) => r[n] ?? null)),
        next: rows.length > EXPORT_PART_ROWS ? Number(page.at(-1)?.__rowid__ ?? 0) : null,
      };
      return c.json(body);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/backup/export/:id/finish', access: manage },
    async (c) => {
      const input = await jsonBody(c, exportFinishSchema);
      const id = c.req.param('id') ?? '';
      await loadJob(c, id);
      const db = c.get('db');
      await tx(db, [
        sql`UPDATE export_job SET finished_at = ${new Date().toISOString()}, row_count = ${input.rows},
            file_count = ${input.files} WHERE id = ${id} AND finished_at IS NULL`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'export_job',
          entityId: id,
          action: 'finish',
          after: input,
        }),
      ]);
      return c.json({ ok: true });
    },
  );

  // ---- Nightly runs (GitHub Actions) ----------------------------------------------------------
  // Not a session route: the workflow authenticates with BACKUP_REPORT_TOKEN (a Worker secret and a
  // GitHub secret of the same value). Without the secret the route is closed (503).
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/backup/runs', access: publicRoute },
    async (c) => {
      const expected = c.env.BACKUP_REPORT_TOKEN?.trim() ?? '';
      if (expected.length < 32)
        throw new ApiError(503, 'misconfigured', 'Backup reporting is not set up');
      const auth = c.req.header('authorization') ?? '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!given || !(await sameSecret(given, expected)))
        throw new ApiError(401, 'unauthenticated', 'Bad or missing backup report token');
      const input = await jsonBody(c, backupRunInputSchema);
      const id = newId();
      const details = input.details ? JSON.stringify(input.details).slice(0, 8000) : null;
      await tx(c.get('db'), [
        sql`INSERT INTO backup_run (id, kind, status, started_at, finished_at, object_key, bytes, sha256,
              targets, details, run_url, note)
            VALUES (${id}, ${input.kind}, ${input.status}, ${input.started_at ?? null},
              ${input.finished_at ?? new Date().toISOString()}, ${input.object_key ?? null},
              ${input.bytes ?? null}, ${input.sha256 ?? null},
              ${input.targets ? JSON.stringify(input.targets) : null}, ${details},
              ${input.run_url ?? null}, ${input.note ?? null})`,
        // System row (no user): the workflow, not a person, reported it.
        sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
            VALUES (${newId()}, NULL, 'backup_run', ${id}, 'report',
              ${JSON.stringify({ before: null, after: { kind: input.kind, status: input.status, bytes: input.bytes ?? null } })})`,
      ]);
      return c.json({ id }, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/backup/status', access: manage },
    async (c) => {
      const db = c.get('db');
      const runs = (
        await db.all<RunRow>(sql`${RUN_SELECT} ORDER BY b.finished_at DESC, b.id DESC LIMIT 20`)
      ).map(runDto);
      const [nightly] = await db.all<RunRow>(
        sql`${RUN_SELECT} WHERE b.kind = 'nightly' ORDER BY b.finished_at DESC, b.id DESC LIMIT 1`,
      );
      const [drill] = await db.all<RunRow>(
        sql`${RUN_SELECT} WHERE b.kind IN ('drill', 'manual_drill') AND b.status = 'ok'
            ORDER BY b.finished_at DESC, b.id DESC LIMIT 1`,
      );
      let objects: BackupObjectDto[] | null = null;
      let objectsError: string | null = null;
      if (c.env.BACKUPS) {
        try {
          const listed = await c.env.BACKUPS.list({ limit: 1000 });
          objects = listed.objects
            .filter((o) => o.key.endsWith('.age'))
            .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() }))
            .sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1))
            .slice(0, 10);
        } catch (err) {
          objectsError = err instanceof Error ? err.message.slice(0, 200) : 'list failed';
        }
      }
      const body: BackupStatusDto = {
        last_nightly: nightly ? runDto(nightly) : null,
        last_drill: drill ? runDto(drill) : null,
        runs,
        objects,
        objects_error: objectsError,
        time_travel_days: 7,
        report_configured: (c.env.BACKUP_REPORT_TOKEN?.trim().length ?? 0) >= 32,
      };
      return c.json(body);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/backup/drills', access: manage },
    async (c) => {
      const input = await jsonBody(c, manualDrillSchema);
      const db = c.get('db');
      const id = newId();
      const uid = userId(c);
      await tx(db, [
        sql`INSERT INTO backup_run (id, kind, status, finished_at, note, created_by)
            VALUES (${id}, 'manual_drill', 'ok', ${`${input.date}T00:00:00.000Z`}, ${input.note ?? null}, ${uid})`,
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'backup_run',
          entityId: id,
          action: 'drill_done',
          after: input,
        }),
      ]);
      const [row] = await db.all<RunRow>(sql`${RUN_SELECT} WHERE b.id = ${id}`);
      if (!row) throw notFoundError('Drill');
      return c.json(runDto(row), 201);
    },
  );

  // ---- Alarms (PLAN §15 "M6 must remember") ---------------------------------------------------
  defineRoute(app, table, { method: 'GET', path: '/api/alarms', access: manage }, async (c) =>
    c.json(await evaluateAlarms(c.get('db'))),
  );

  /** The dashboard banner: the latest daily pass (one read), not a live evaluation. */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/alarms/latest', access: manage },
    async (c) => {
      const [row] = await c.get('db').all<{
        day: string;
        at: string;
        total: number;
        alarms: string;
        acknowledged_at: string | null;
      }>(
        sql`SELECT day, at, total, alarms, acknowledged_at FROM alarm_event ORDER BY day DESC LIMIT 1`,
      );
      const event: AlarmEventDto | null = row
        ? { ...row, alarms: parseJson<AlarmDto[]>(row.alarms, []) }
        : null;
      return c.json({ event });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/alarms/:day/ack', access: manage },
    async (c) => {
      const day = c.req.param('day') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError(400, 'invalid', 'day: YYYY-MM-DD');
      const db = c.get('db');
      const [row] = await db.all<{ day: string }>(
        sql`SELECT day FROM alarm_event WHERE day = ${day}`,
      );
      if (!row) throw notFoundError('Alarm');
      const uid = userId(c);
      await tx(db, [
        sql`UPDATE alarm_event SET acknowledged_at = ${new Date().toISOString()}, acknowledged_by = ${uid}
            WHERE day = ${day} AND acknowledged_at IS NULL`,
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'alarm_event',
          entityId: day,
          action: 'acknowledge',
        }),
      ]);
      return c.json({ ok: true });
    },
  );
}
