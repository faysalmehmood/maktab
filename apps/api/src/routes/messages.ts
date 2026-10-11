import { school } from '@maktab/db';
import {
  type BulkTextDto,
  COMPOSE_BATCH,
  type ComposeResultDto,
  composeInputSchema,
  csvSafeCell,
  DEFAULT_TEMPLATES,
  formatDmy,
  isoDateSchema,
  joinNames,
  MESSAGE_LANGS,
  type MessageCountsDto,
  type MessageLang,
  type MessageListDto,
  type MessageOpenDto,
  type MessageSettingsDto,
  type MessageTemplateDto,
  messageSettingsSchema,
  messageSkipSchema,
  monthLabel,
  newId,
  normalizePkMobile,
  normalizePkPhone,
  type ParentGate,
  type ParentLinkCreatedDto,
  type ParentLinkStatusDto,
  parentLinkCreateSchema,
  type QueueMessageDto,
  renderTemplate,
  TEMPLATE_KEYS,
  type TemplateKey,
  telUrl,
  templatePreviewSchema,
  templateUpdateSchema,
  unknownPlaceholders,
  waUrl,
} from '@maktab/shared';
import { asc, eq, type SQL, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { familyMessageStatements } from '../lib/fees';
import { idParam, jsonBody, notFoundError, queryParams, todayPk, userId } from '../lib/http';
import {
  familyDueNow,
  type LinkRow,
  linkExpired,
  linkToken,
  linkUrl,
  liveLink,
  loadTemplates,
  messageScopeSql,
  newLinkStatements,
  renderRow,
  type SchoolMsg,
  type StillAbsent,
  schoolMsg,
  sha256Hex,
  stillAbsent,
  type Templates,
} from '../lib/messaging';
import { auditSql, changed, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { type GroupScope, scopeToGroups } from '../perm/scope';

const scopeOf = (c: Context<AppEnv>) => scopeToGroups(c.get('db'), userId(c), c.get('grant'));
const nowIso = () => new Date().toISOString();

const listQuery = z.object({
  status: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'skipped']).optional(),
  template_key: z.string().max(40).optional(),
  grp_id: z.string().max(64).optional(),
  date: isoDateSchema.optional(),
});

type Row = {
  id: string;
  family_id: string;
  family_name: string;
  guardian_id: string | null;
  guardian_name: string | null;
  guardian_whatsapp: string | null;
  guardian_phone: string | null;
  channel: string;
  template_key: string;
  lang: MessageLang;
  status: string;
  payload: string | null;
  created_at: string;
  opened_at: string | null;
  sent_at: string | null;
  sent_by_name: string | null;
  skipped_reason: string | null;
  rendered_text: string | null;
};

const ROW_SELECT = sql`SELECT msg.id, msg.family_id, f.name AS family_name, msg.guardian_id,
    gd.name AS guardian_name, gd.whatsapp AS guardian_whatsapp, gd.phone AS guardian_phone,
    msg.channel, msg.template_key, msg.lang, msg.status, msg.payload, msg.created_at, msg.opened_at,
    msg.sent_at, u.name AS sent_by_name, msg.skipped_reason, msg.rendered_text
  FROM message msg JOIN family f ON f.id = msg.family_id
  LEFT JOIN guardian gd ON gd.id = msg.guardian_id
  LEFT JOIN "user" u ON u.id = msg.sent_by`;

const parse = (p: string | null): Record<string, unknown> => {
  if (!p) return {};
  try {
    const v = JSON.parse(p) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The number wa.me needs: the WhatsApp number if given, else the phone, as a PK mobile. */
const waNumber = (r: Pick<Row, 'guardian_whatsapp' | 'guardian_phone'>): string | null =>
  normalizePkMobile(r.guardian_whatsapp ?? '') ?? normalizePkMobile(r.guardian_phone ?? '');
const callNumber = (r: Pick<Row, 'guardian_whatsapp' | 'guardian_phone'>): string | null =>
  normalizePkPhone(r.guardian_phone ?? '')?.number ??
  normalizePkPhone(r.guardian_whatsapp ?? '')?.number ??
  null;

/** Group filter: absence rows by their register's group; other rows when the family has a child there. */
const groupSql = (grpId: string): SQL =>
  sql`(CASE WHEN msg.template_key = 'absence'
         THEN json_extract(msg.payload, '$.grp_id') = ${grpId}
         ELSE EXISTS (SELECT 1 FROM student s JOIN enrolment e ON e.student_id = s.id
                      WHERE s.family_id = msg.family_id AND e.grp_id = ${grpId} AND e.status = 'active') END)`;

const dateSql = (date: string): SQL =>
  sql`coalesce(json_extract(msg.payload, '$.date'), date(msg.created_at, '+5 hours')) = ${date}`;

function toDto(
  r: Row,
  ctx: { school: SchoolMsg; templates: Templates; origin: string; today: string },
): QueueMessageDto {
  const payload = parse(r.payload);
  const preview =
    r.rendered_text ??
    renderRow(
      { template_key: r.template_key, lang: r.lang, payload },
      { ...ctx, link: r.guardian_id ? `${linkUrl(ctx.origin, '…')}` : '' },
    );
  return {
    id: r.id,
    family_id: r.family_id,
    family_name: r.family_name,
    guardian_id: r.guardian_id,
    guardian_name: r.guardian_name,
    guardian_phone: r.guardian_whatsapp ?? r.guardian_phone,
    wa_number: waNumber(r),
    channel: r.channel,
    template_key: r.template_key,
    lang: r.lang,
    status: r.status,
    payload,
    created_at: r.created_at,
    preview,
    grp_id: typeof payload.grp_id === 'string' ? payload.grp_id : null,
    grp_name: typeof payload.grp_name === 'string' ? payload.grp_name : null,
    opened_at: r.opened_at,
    sent_at: r.sent_at,
    sent_by_name: r.sent_by_name,
    skipped_reason: r.skipped_reason,
  };
}

async function counts(
  c: Context<AppEnv>,
  scope: GroupScope,
  today: string,
): Promise<MessageCountsDto> {
  const db = c.get('db');
  const where = messageScopeSql(scope);
  const rows = await db.all<{
    template_key: string;
    queued: number;
    sent: number;
    skipped: number;
  }>(
    sql`SELECT msg.template_key,
          sum(msg.status = 'queued') AS queued,
          sum(msg.status = 'sent' AND date(msg.sent_at, '+5 hours') = ${today}) AS sent,
          sum(msg.status = 'skipped' AND date(msg.skipped_at, '+5 hours') = ${today}) AS skipped
        FROM message msg WHERE ${where} GROUP BY msg.template_key`,
  );
  const by_template: Record<string, number> = {};
  let queued = 0;
  let sent = 0;
  let skipped = 0;
  for (const r of rows) {
    by_template[r.template_key] = Number(r.queued ?? 0);
    queued += Number(r.queued ?? 0);
    sent += Number(r.sent ?? 0);
    skipped += Number(r.skipped ?? 0);
  }
  return { queued, sent_today: sent, skipped_today: skipped, by_template };
}

async function loadRow(c: Context<AppEnv>, id: string, scope: GroupScope): Promise<Row> {
  const [r] = await c
    .get('db')
    .all<Row>(sql`${ROW_SELECT} WHERE msg.id = ${id} AND ${messageScopeSql(scope)}`);
  // Out of scope looks exactly like "does not exist".
  if (!r) throw notFoundError('Message');
  return r;
}

/** Auto-created links (a message needs one) follow the school gate; a PIN needs staff, so not 'pin'. */
const autoGate = (s: SchoolMsg): ParentGate =>
  s.parent_gate === 'pin' ? 'birth_year' : s.parent_gate;

/** The guardian's current link URL (creating or renewing one if needed) and its token hash. */
async function ensureLink(
  c: Context<AppEnv>,
  guardianId: string,
  s: SchoolMsg,
): Promise<{ url: string; hash: string }> {
  const db = c.get('db');
  const now = nowIso();
  const live = await liveLink(db, guardianId);
  if (live?.token_salt && !linkExpired(live, now)) {
    const token = await linkToken(c.env.SESSION_SECRET, live.token_salt);
    return { url: linkUrl(c.env.APP_ORIGIN, token), hash: live.token_hash };
  }
  const n = await newLinkStatements({
    secret: c.env.SESSION_SECRET,
    guardianId,
    by: userId(c),
    now,
    days: 365,
    gate: autoGate(s),
  });
  await tx(db, n.stmts);
  return { url: linkUrl(c.env.APP_ORIGIN, n.token), hash: await sha256Hex(n.token) };
}

const SAMPLE_NAMES: Record<MessageLang, string[]> = {
  en: ['Ahmed', 'Fatima'],
  ur: ['احمد', 'فاطمہ'],
};

async function templateDtos(c: Context<AppEnv>): Promise<MessageTemplateDto[]> {
  const rows = await c.get('db').all<{
    key: string;
    lang: MessageLang;
    body: string;
    updated_at: string;
    updated_by_name: string | null;
  }>(sql`SELECT t.key, t.lang, t.body, t.updated_at, u.name AS updated_by_name
         FROM message_template t LEFT JOIN "user" u ON u.id = t.updated_by`);
  const out: MessageTemplateDto[] = [];
  for (const key of TEMPLATE_KEYS)
    for (const lang of MESSAGE_LANGS) {
      const r = rows.find((x) => x.key === key && x.lang === lang);
      const def = DEFAULT_TEMPLATES[key][lang];
      out.push({
        key,
        lang,
        body: r?.body ?? def,
        default_body: def,
        is_default: !r || r.body === def,
        updated_at: r?.updated_by_name ? r.updated_at : null,
        updated_by_name: r?.updated_by_name ?? null,
      });
    }
  return out;
}

async function linkStatus(c: Context<AppEnv>, guardianId: string): Promise<ParentLinkStatusDto> {
  const db = c.get('db');
  const [l] = await db.all<LinkRow & { created_by_name: string | null }>(
    sql`SELECT pl.*, u.name AS created_by_name FROM parent_link pl
        LEFT JOIN "user" u ON u.id = pl.created_by
        WHERE pl.guardian_id = ${guardianId} ORDER BY pl.created_at DESC, pl.id DESC LIMIT 1`,
  );
  const access = l
    ? await db.all<{ at: string; ip_hash: string | null; ua: string | null }>(
        sql`SELECT a.at, a.ip_hash, a.ua FROM parent_link_access a
            JOIN parent_link pl ON pl.id = a.link_id
            WHERE pl.guardian_id = ${guardianId} ORDER BY a.at DESC LIMIT 10`,
      )
    : [];
  const now = nowIso();
  return {
    guardian_id: guardianId,
    link: l
      ? {
          id: l.id,
          created_at: l.created_at,
          created_by_name: l.created_by_name,
          expires_at: l.expires_at,
          last_seen_at: l.last_seen_at,
          gate: (l.gate ?? 'none') as ParentGate,
          status: l.revoked_at ? 'revoked' : linkExpired(l, now) ? 'expired' : 'active',
        }
      : null,
    access,
  };
}

async function guardianExists(c: Context<AppEnv>, id: string): Promise<void> {
  const [g] = await c.get('db').all(sql`SELECT id FROM guardian WHERE id = ${id}`);
  if (!g) throw notFoundError('Guardian');
}

/** Drops a trailing "Details:" line left behind when a text is rendered without its link. */
const withoutLinkLead = (text: string): string => text.replace(/\n[^\n]*[:：]\s*$/u, '');

export function messageRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const read = requires('message', 'read');
  const send = requires('message', 'send');
  const compose = requires('message', 'compose');
  const manage = requires('template', 'manage');
  const guardianWrite = requires('student', 'write');

  // ---- Static paths first (they would otherwise also match /api/messages/:id) --------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/messages/counts', access: read },
    async (c) => c.json(await counts(c, await scopeOf(c), todayPk())),
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/messages/templates', access: manage },
    async (c) => c.json({ items: await templateDtos(c) }),
  );

  /** Render any body with sample values: what the editor shows before saving. */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/messages/templates/preview', access: manage },
    async (c) => {
      const input = await jsonBody(c, templatePreviewSchema);
      const s = await schoolMsg(c.get('db'));
      const today = todayPk();
      const names = SAMPLE_NAMES[input.lang];
      const text = renderTemplate(input.body, {
        child: names[0] ?? '',
        children: joinNames(names, input.lang),
        date: formatDmy(today),
        amount: 'Rs 8,000',
        month: monthLabel(today, input.lang),
        receipt_no: 'R-2026-00042',
        school: input.lang === 'ur' ? s.name_ur || s.name : s.name,
        link: linkUrl(c.env.APP_ORIGIN, 'Xk3f9Qa2LmNpXk3f9Qa2LmNp'),
      });
      return c.json({
        text,
        wa_url: waUrl('923001234567', text),
        unknown: unknownPlaceholders(input.body),
      });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/messages/templates/:key/:lang', access: manage },
    async (c) => {
      const key = c.req.param('key') as TemplateKey;
      const lang = c.req.param('lang') as MessageLang;
      if (!TEMPLATE_KEYS.includes(key) || !MESSAGE_LANGS.includes(lang))
        throw notFoundError('Template');
      const input = await jsonBody(c, templateUpdateSchema);
      const body = input.body ?? DEFAULT_TEMPLATES[key][lang];
      const db = c.get('db');
      const [before] = await db.all<{ body: string }>(
        sql`SELECT body FROM message_template WHERE key = ${key} AND lang = ${lang}`,
      );
      if (before?.body !== body)
        await tx(db, [
          sql`INSERT INTO message_template (key, lang, body, updated_by, updated_at)
              VALUES (${key}, ${lang}, ${body}, ${userId(c)}, ${nowIso()})
              ON CONFLICT (key, lang) DO UPDATE SET body = excluded.body,
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'message_template',
            entityId: `${key}:${lang}`,
            action: input.body === null ? 'reset' : 'update',
            before: { body: before?.body ?? null },
            after: { body },
          }),
        ]);
      const item = (await templateDtos(c)).find((t) => t.key === key && t.lang === lang);
      return c.json({ item });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/school/messages', access: manage },
    async (c) => {
      const s = await schoolMsg(c.get('db'));
      const body: MessageSettingsDto = {
        reminder_cooldown_days: s.reminder_cooldown_days,
        parent_gate: s.parent_gate,
        announcement_groups_note: s.announcement_groups_note,
      };
      return c.json(body);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/school/messages', access: manage },
    async (c) => {
      const input = await jsonBody(c, messageSettingsSchema);
      const db = c.get('db');
      const [row] = await db.select().from(school).orderBy(asc(school.createdAt)).limit(1);
      if (!row) throw new ApiError(409, 'no_school', 'Save the school profile first');
      const values = {
        reminderCooldownDays: input.reminder_cooldown_days,
        parentGate: input.parent_gate,
        announcementGroupsNote: input.announcement_groups_note || null,
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
            action: 'message_settings',
            ...diff,
          }),
        ]);
      const s = await schoolMsg(db);
      const body: MessageSettingsDto = {
        reminder_cooldown_days: s.reminder_cooldown_days,
        parent_gate: s.parent_gate,
        announcement_groups_note: s.announcement_groups_note,
      };
      return c.json(body);
    },
  );

  /**
   * Every queued text for one class, for pasting into its WhatsApp announcement group: no phones,
   * no parent links (each family's link is private), each line formula-safe. Absence rows are
   * rebuilt from the current registers like /open (children no longer absent drop out).
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/messages/bulk-text', access: send },
    async (c) => {
      const q = queryParams(
        c,
        z.object({
          grp_id: z.string().min(1).max(64),
          template_key: z.enum(TEMPLATE_KEYS).default('absence'),
          date: isoDateSchema.optional(),
        }),
      );
      const db = c.get('db');
      const scope = await scopeOf(c);
      const today = todayPk();
      const date = q.date ?? today;
      const [g] = await db.all<{ name: string }>(
        sql`SELECT trim(p.name || ' ' || g.name) AS name FROM grp g
            JOIN programme p ON p.id = g.programme_id WHERE g.id = ${q.grp_id}`,
      );
      if (!g || (scope.kind === 'groups' && !scope.ids.includes(q.grp_id)))
        throw notFoundError('Group');
      const rows = await db.all<Row>(
        sql`${ROW_SELECT} WHERE msg.status = 'queued' AND msg.template_key = ${q.template_key}
              AND ${groupSql(q.grp_id)} AND ${messageScopeSql(scope)}
              ${q.template_key === 'absence' ? sql`AND ${dateSql(date)}` : sql``}
            ORDER BY msg.created_at, msg.id LIMIT 200`,
      );
      const absent = new Map<string, StillAbsent[]>();
      if (q.template_key === 'absence' && rows.length) {
        const all = await db.all<StillAbsent & { family_id: string }>(
          sql`SELECT st.family_id, st.id AS student_id, st.name, c.grp_id, '' AS grp_name
              FROM current_register c
              JOIN att_mark m ON m.register_id = c.register_id AND m.status = 'A'
              JOIN student st ON st.id = m.student_id
              WHERE c.date = ${date} AND st.family_id IN
                (SELECT value FROM json_each(${JSON.stringify(rows.map((r) => r.family_id))}))
              GROUP BY st.id ORDER BY st.admission_date, st.name`,
        );
        for (const a of all) absent.set(a.family_id, [...(absent.get(a.family_id) ?? []), a]);
      }
      const s = await schoolMsg(db);
      const templates = await loadTemplates(db);
      const texts: string[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.family_id)) continue;
        seen.add(r.family_id);
        let children: string[] | undefined;
        if (q.template_key === 'absence') {
          children = (absent.get(r.family_id) ?? []).map((a) => a.name);
          if (!children.length) continue;
        }
        const text = renderRow(
          { template_key: r.template_key, lang: r.lang, payload: parse(r.payload) },
          { school: s, templates, link: '', today, ...(children ? { children } : {}) },
        );
        texts.push(
          withoutLinkLead(text)
            .split('\n')
            .map((l) => csvSafeCell(l))
            .join('\n'),
        );
      }
      const body: BulkTextDto = { text: texts.join('\n\n'), count: texts.length, grp_name: g.name };
      return c.json(body);
    },
  );

  /**
   * Notice to families (PLAN §14.9 step 3): one row per family (WhatsApp by consent, else "call"),
   * at most 200 per request; the client loops with `after = next`. `notice_id` makes a retried call
   * a no-op for families that already hold it.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/messages/compose', access: compose },
    async (c) => {
      const input = await jsonBody(c, composeInputSchema);
      const db = c.get('db');
      const a = input.audience;
      const audience =
        a.kind === 'all'
          ? sql`SELECT DISTINCT st.family_id AS id FROM student st JOIN family f ON f.id = st.family_id
                WHERE st.status = 'active' AND f.deleted_at IS NULL`
          : a.kind === 'group'
            ? sql`SELECT DISTINCT st.family_id AS id FROM student st JOIN family f ON f.id = st.family_id
                  JOIN enrolment e ON e.student_id = st.id AND e.status = 'active' AND e.grp_id = ${a.grp_id}
                  WHERE st.status = 'active' AND f.deleted_at IS NULL`
            : sql`SELECT f.id FROM family f WHERE f.deleted_at IS NULL
                  AND f.id IN (SELECT value FROM json_each(${JSON.stringify(a.family_ids)}))`;
      if (a.kind === 'group') {
        const [g] = await db.all(sql`SELECT id FROM grp WHERE id = ${a.grp_id}`);
        if (!g) throw notFoundError('Group');
      }
      const [total] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM (${audience})`);
      const page = await db.all<{ id: string; names: string; held: number }>(
        sql`SELECT x.id,
              (SELECT json_group_array(s.name) FROM (SELECT name FROM student
                 WHERE family_id = x.id AND status = 'active' ORDER BY admission_date, name) s) AS names,
              EXISTS (SELECT 1 FROM message m WHERE m.family_id = x.id AND m.template_key = 'notice'
                      AND json_extract(m.payload, '$.notice_id') = ${input.notice_id}) AS held
            FROM (${audience}) x WHERE x.id > ${input.after ?? ''}
            ORDER BY x.id LIMIT ${COMPOSE_BATCH + 1}`,
      );
      const more = page.length > COMPOSE_BATCH;
      const batch = page.slice(0, COMPOSE_BATCH);
      const rows = batch
        .filter((f) => !f.held)
        .map((f) => ({
          m: newId(),
          f: f.id,
          p: {
            notice_id: input.notice_id,
            body_en: input.body_en,
            body_ur: input.body_ur,
            student_names: JSON.parse(f.names) as string[],
            ...(a.kind === 'group' ? { grp_id: a.grp_id } : {}),
            date: todayPk(),
          },
        }));
      const stmts = familyMessageStatements({
        template: 'notice',
        today: todayPk(),
        by: userId(c),
        cooldownDays: null,
        rows,
      });
      if (stmts.length)
        await tx(db, [
          ...stmts,
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'notice',
            entityId: input.notice_id,
            action: 'queue',
            after: { audience: a.kind, families: rows.length, after: input.after ?? null },
          }),
        ]);
      const body: ComposeResultDto = {
        queued: rows.length,
        skipped: batch.length - rows.length,
        next: more ? (batch[batch.length - 1]?.id ?? null) : null,
        total: Number(total?.n ?? 0),
      };
      return c.json(body, rows.length ? 201 : 200);
    },
  );

  // ---- The queue -----------------------------------------------------------------------------------
  defineRoute(app, table, { method: 'GET', path: '/api/messages', access: read }, async (c) => {
    const db = c.get('db');
    const q = queryParams(c, listQuery);
    const scope = await scopeOf(c);
    const today = todayPk();
    const where = sql.join(
      [
        messageScopeSql(scope),
        q.status ? sql`msg.status = ${q.status}` : sql`1`,
        q.template_key ? sql`msg.template_key = ${q.template_key}` : sql`1`,
        q.grp_id ? groupSql(q.grp_id) : sql`1`,
        q.date ? dateSql(q.date) : sql`1`,
      ],
      sql` AND `,
    );
    const [total] = await db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM message msg WHERE ${where}`,
    );
    const rows = await db.all<Row>(
      sql`${ROW_SELECT} WHERE ${where}
          ORDER BY CASE msg.template_key WHEN 'absence' THEN 0 WHEN 'fee_overdue' THEN 1
                     WHEN 'fee_due' THEN 2 WHEN 'payment_received' THEN 3 ELSE 4 END,
                   msg.created_at, msg.id LIMIT 200`,
    );
    const ctx = {
      school: await schoolMsg(db),
      templates: await loadTemplates(db),
      origin: c.env.APP_ORIGIN,
      today,
    };
    const body: MessageListDto = {
      items: rows.map((r) => toDto(r, ctx)),
      total: Number(total?.n ?? 0),
      counts: await counts(c, scope, today),
    };
    return c.json(body);
  });

  defineRoute(app, table, { method: 'GET', path: '/api/messages/:id', access: read }, async (c) => {
    const db = c.get('db');
    const r = await loadRow(c, idParam(c), await scopeOf(c));
    const ctx = {
      school: await schoolMsg(db),
      templates: await loadTemplates(db),
      origin: c.env.APP_ORIGIN,
      today: todayPk(),
    };
    return c.json({ message: toDto(r, ctx) });
  });

  /**
   * "Open WhatsApp" (PLAN §14.9 step 2): rebuild the text now — absence from the current registers
   * (nobody still absent → skipped `no_longer_absent`; siblings absent in other groups merged), fee
   * reminders from today's dues (nothing owed → skipped `already_paid`) — put the guardian's current
   * parent link on the last line, record it, and return the wa.me URL. Opening never marks a row
   * sent: that is the explicit /sent tap.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/messages/:id/open', access: send },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const r = await loadRow(c, id, await scopeOf(c));
      if (r.status !== 'queued')
        throw new ApiError(409, 'not_queued', 'This message was already sent or skipped');
      const payload = parse(r.payload);
      const today = todayPk();
      const now = nowIso();
      const skip = async (reason: string): Promise<MessageOpenDto> => {
        await tx(db, [
          sql`UPDATE message SET status = 'skipped', skipped_reason = ${reason}, skipped_at = ${now},
                opened_at = ${now} WHERE id = ${id} AND status = 'queued'`,
        ]);
        return {
          id,
          status: 'skipped',
          skipped_reason: reason,
          channel: r.channel,
          lang: r.lang,
          text: '',
          wa_url: null,
          tel_url: null,
          number: null,
          children: [],
        };
      };
      let children: string[] | undefined;
      let amount: number | undefined;
      if (r.template_key === 'absence') {
        const date = typeof payload.date === 'string' ? payload.date : today;
        const still = await stillAbsent(db, r.family_id, date);
        if (!still.length) return c.json(await skip('no_longer_absent'));
        children = still.map((s) => s.name);
      } else if (r.template_key === 'fee_due' || r.template_key === 'fee_overdue') {
        const d = await familyDueNow(db, r.family_id, today);
        amount = r.template_key === 'fee_overdue' ? d.overdue : d.due;
        if (amount <= 0) return c.json(await skip('already_paid'));
      }
      const s = await schoolMsg(db);
      const link = r.guardian_id ? await ensureLink(c, r.guardian_id, s) : null;
      const text = renderRow(
        { template_key: r.template_key, lang: r.lang, payload },
        {
          school: s,
          templates: await loadTemplates(db),
          link: link?.url ?? '',
          today,
          ...(children ? { children } : {}),
          ...(amount !== undefined ? { amount } : {}),
        },
      );
      await tx(db, [
        sql`UPDATE message SET opened_at = ${now}, rendered_text = ${text},
              link_token_hash = ${link?.hash ?? null} WHERE id = ${id} AND status = 'queued'`,
      ]);
      const wa = r.channel === 'wa_manual' ? waNumber(r) : null;
      const call = callNumber(r) ?? wa;
      const names = children ?? (Array.isArray(payload.student_names) ? payload.student_names : []);
      const body: MessageOpenDto = {
        id,
        status: 'queued',
        skipped_reason: null,
        channel: r.channel,
        lang: r.lang,
        text,
        wa_url: wa ? waUrl(wa, text) : null,
        tel_url: call ? telUrl(call) : null,
        number: wa ?? call,
        children: names.filter((n): n is string => typeof n === 'string'),
      };
      return c.json(body);
    },
  );

  /** The explicit "Sent" / "Called" tap: who and when. Repeating it is harmless. */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/messages/:id/sent', access: send },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const r = await loadRow(c, id, await scopeOf(c));
      if (r.status === 'sent') return c.json({ id, status: 'sent', replayed: true });
      if (r.status !== 'queued')
        throw new ApiError(409, 'not_queued', 'This message was already sent or skipped');
      await tx(db, [
        sql`UPDATE message SET status = 'sent', sent_at = ${nowIso()}, sent_by = ${userId(c)}
            WHERE id = ${id} AND status = 'queued'`,
      ]);
      return c.json({ id, status: 'sent', replayed: false });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/messages/:id/skip', access: send },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const input = await jsonBody(c, messageSkipSchema);
      const r = await loadRow(c, id, await scopeOf(c));
      if (r.status === 'skipped') return c.json({ id, status: 'skipped', replayed: true });
      if (r.status !== 'queued')
        throw new ApiError(409, 'not_queued', 'This message was already sent or skipped');
      await tx(db, [
        sql`UPDATE message SET status = 'skipped', skipped_reason = ${input.reason},
              skipped_at = ${nowIso()}, sent_by = ${userId(c)}
            WHERE id = ${id} AND status = 'queued'`,
      ]);
      return c.json({ id, status: 'skipped', replayed: false });
    },
  );

  // ---- Parent links (guardian panel) -----------------------------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/guardians/:id/parent-link', access: guardianWrite },
    async (c) => {
      const id = idParam(c);
      await guardianExists(c, id);
      return c.json(await linkStatus(c, id));
    },
  );

  /** Create or rotate: the old link stops working in the same batch; the URL is returned once. */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/guardians/:id/parent-link', access: guardianWrite },
    async (c) => {
      const id = idParam(c);
      const input = await jsonBody(c, parentLinkCreateSchema);
      await guardianExists(c, id);
      const db = c.get('db');
      const s = await schoolMsg(db);
      const gate: ParentGate = input.gate === 'default' ? s.parent_gate : input.gate;
      if (gate === 'pin' && !input.pin)
        throw new ApiError(400, 'pin_required', 'Choose a 4–6 digit PIN for this link');
      const before = await liveLink(db, id);
      const n = await newLinkStatements({
        secret: c.env.SESSION_SECRET,
        guardianId: id,
        by: userId(c),
        now: nowIso(),
        days: input.days,
        gate,
        ...(input.pin ? { pin: input.pin } : {}),
      });
      await tx(db, [
        ...n.stmts,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'parent_link',
          entityId: n.id,
          action: before ? 'rotate' : 'create',
          before: before ? { link_id: before.id } : null,
          after: { guardian_id: id, gate, days: input.days },
        }),
      ]);
      const body: ParentLinkCreatedDto = {
        ...(await linkStatus(c, id)),
        url: linkUrl(c.env.APP_ORIGIN, n.token),
      };
      return c.json(body, 201);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/guardians/:id/parent-link/revoke', access: guardianWrite },
    async (c) => {
      const id = idParam(c);
      await guardianExists(c, id);
      const db = c.get('db');
      const live = await liveLink(db, id);
      if (!live) throw new ApiError(404, 'not_found', 'No live link for this guardian');
      await tx(db, [
        sql`UPDATE parent_link SET revoked_at = ${nowIso()} WHERE id = ${live.id} AND revoked_at IS NULL`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'parent_link',
          entityId: live.id,
          action: 'revoke',
          after: { guardian_id: id },
        }),
      ]);
      return c.json(await linkStatus(c, id));
    },
  );
}
