import { familyStatement } from '@maktab/db';
import {
  firstName,
  type MessageLang,
  newId,
  type ParentChildDto,
  type ParentGate,
  type ParentGateResultDto,
  type ParentPageDto,
  parentGateInputSchema,
  presentPct,
  type ReceiptPrintDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { sign, verify } from '../auth/signed';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { receiptPrint } from '../lib/fees';
import { jsonBody, todayPk } from '../lib/http';
import { ipHash, type LinkRow, linkExpired, pinHash, schoolMsg, sha256Hex } from '../lib/messaging';
import { PARENT_RATE, RateLimiter } from '../lib/ratelimit';
import { tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';

/**
 * The parent page API (PLAN §7, §14.10): public, reached with a magic-link token, never a session.
 * Shows first names, class, attendance, dues (net of credit, with the lines behind them), receipts and
 * notices of the guardian's own family — never CNIC, B-form, dates of birth, phone numbers, other
 * families or anything about staff. Optional gate (birth year or PIN) before dues and receipts.
 * Every response: noindex, no referrer, no store. Rate-limited per token (lib/ratelimit.ts).
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const GATE_HOURS = 12;
const GATE_MAX_FAILURES = 5;
const GATE_LOCK_MINUTES = 15;
/** Access-log rows kept per link, and the window in which a repeat visit from one IP is not logged. */
const ACCESS_KEEP = 50;
const ACCESS_DEDUPE_MINUTES = 10;

type Resolved = LinkRow & {
  guardian_name: string;
  guardian_lang: MessageLang;
  family_id: string;
};

const gateClaims = z.object({ typ: z.literal('pgate'), exp: z.number(), lid: z.string() });

export const PARENT_HEADERS: Record<string, string> = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const invalid = () => new ApiError(404, 'not_found', 'This link is not valid any more');

export function parentRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const view = requires('parent_page', 'view');
  const limiter = new RateLimiter(PARENT_RATE.limit, PARENT_RATE.windowMs);

  app.use('/api/p/*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(PARENT_HEADERS)) c.res.headers.set(k, v);
  });

  async function resolve(c: Context<AppEnv>): Promise<Resolved> {
    const token = c.req.param('token') ?? '';
    if (!limiter.take(`p:${token.slice(0, 64)}`))
      throw new ApiError(429, 'rate_limited', 'Too many requests; wait a minute');
    if (!TOKEN_RE.test(token)) throw invalid();
    const hash = await sha256Hex(token);
    const [l] = await c.get('db').all<Resolved & { family_deleted: string | null }>(
      sql`SELECT pl.*, g.name AS guardian_name, g.lang AS guardian_lang, g.family_id,
            f.deleted_at AS family_deleted
          FROM parent_link pl JOIN guardian g ON g.id = pl.guardian_id
          JOIN family f ON f.id = g.family_id
          WHERE pl.token_hash = ${hash}`,
    );
    if (!l || l.revoked_at || linkExpired(l, new Date().toISOString()) || l.family_deleted)
      throw invalid();
    return l;
  }

  const gateKind = (l: LinkRow): ParentGate =>
    l.gate === 'birth_year' || l.gate === 'pin' ? l.gate : 'none';

  async function gatePassed(c: Context<AppEnv>, l: LinkRow): Promise<boolean> {
    if (gateKind(l) === 'none') return true;
    const claims = await verify(
      c.env.SESSION_SECRET,
      c.req.header('x-parent-gate'),
      'pgate',
      gateClaims,
      Math.floor(Date.now() / 1000),
    );
    return claims?.lid === l.id;
  }

  async function children(c: Context<AppEnv>, familyId: string, today: string) {
    const db = c.get('db');
    const kids = await db.all<{ id: string; name: string; grp: string | null }>(
      sql`SELECT st.id, st.name,
            (SELECT trim(p.name || ' ' || g.name) FROM enrolment e JOIN grp g ON g.id = e.grp_id
               JOIN programme p ON p.id = g.programme_id
             WHERE e.student_id = st.id AND e.status = 'active' ORDER BY e.is_primary DESC LIMIT 1) AS grp
          FROM student st WHERE st.family_id = ${familyId} AND st.status = 'active'
          ORDER BY st.admission_date, st.name`,
    );
    const ids = JSON.stringify(kids.map((k) => k.id));
    const marks = kids.length
      ? await db.all<{
          student_id: string;
          date: string;
          status: 'P' | 'A' | 'L' | 'E';
          n: number;
        }>(
          sql`SELECT m.student_id, c.date = ${today} AS date, m.status, count(*) AS n
              FROM current_register c JOIN att_mark m ON m.register_id = c.register_id
              WHERE c.date BETWEEN ${`${today.slice(0, 7)}-01`} AND ${today}
                AND m.student_id IN (SELECT value FROM json_each(${ids}))
              GROUP BY m.student_id, c.date = ${today}, m.status`,
        )
      : [];
    return kids.map((k): ParentChildDto => {
      const mine = marks.filter((m) => m.student_id === k.id);
      const counts = { P: 0, A: 0, L: 0, E: 0 };
      for (const m of mine) counts[m.status] += Number(m.n);
      const todays = new Set(mine.filter((m) => Number(m.date) === 1).map((m) => m.status));
      const today_ = (['A', 'L', 'E', 'P'] as const).find((s) => todays.has(s)) ?? null;
      return {
        id: k.id,
        first_name: firstName(k.name),
        group: k.grp,
        today: today_,
        month: {
          present: counts.P,
          absent: counts.A,
          late: counts.L,
          excused: counts.E,
          pct: presentPct(counts),
        },
      };
    });
  }

  /** Last-seen and the access log; a repeat visit from the same IP within 10 minutes is not a row. */
  async function logAccess(c: Context<AppEnv>, l: LinkRow): Promise<void> {
    const now = new Date().toISOString();
    const ip = await ipHash(
      c.env.SESSION_SECRET,
      c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
    );
    const ua = (c.req.header('user-agent') ?? '').slice(0, 200) || null;
    const since = new Date(Date.now() - ACCESS_DEDUPE_MINUTES * 60_000).toISOString();
    await tx(c.get('db'), [
      sql`UPDATE parent_link SET last_seen_at = ${now} WHERE id = ${l.id}`,
      sql`INSERT INTO parent_link_access (id, link_id, at, ip_hash, ua)
          SELECT ${newId()}, ${l.id}, ${now}, ${ip}, ${ua}
          WHERE NOT EXISTS (SELECT 1 FROM parent_link_access WHERE link_id = ${l.id}
                            AND ip_hash IS ${ip} AND at >= ${since})`,
      sql`DELETE FROM parent_link_access WHERE link_id = ${l.id} AND id NOT IN
            (SELECT id FROM parent_link_access WHERE link_id = ${l.id} ORDER BY at DESC, id DESC LIMIT ${ACCESS_KEEP})`,
    ]);
  }

  defineRoute(app, table, { method: 'GET', path: '/api/p/:token', access: view }, async (c) => {
    const l = await resolve(c);
    const db = c.get('db');
    const today = todayPk();
    const s = await schoolMsg(db);
    const passed = await gatePassed(c, l);
    let dues: ParentPageDto['dues'] = null;
    let receipts: ParentPageDto['receipts'] = null;
    if (passed) {
      const st = await familyStatement(db, l.family_id, today);
      if (st) {
        const names = new Map(st.students.map((x) => [x.id, firstName(x.name)]));
        dues = {
          lines: st.charges
            .filter((x) => x.due > 0)
            .map((x) => ({
              child: names.get(x.student_id) ?? '',
              head_name: x.head_name,
              head_name_ur: x.head_name_ur,
              period_key: x.period_key,
              due_date: x.due_date,
              net: x.net,
              paid: x.paid,
              due: x.due,
              status: x.status === 'paid' ? 'due' : x.status,
            })),
          total_before_credit: st.totals.due_before_credit,
          credit: st.credit,
          total: st.totals.due,
          overdue: st.totals.overdue,
        };
        receipts = st.receipts
          .filter((r) => r.kind === 'payment' && !r.reversed_by)
          .slice(0, 20)
          .map((r) => ({
            id: r.id,
            receipt_no: r.receipt_no,
            amount: r.amount,
            business_date: r.business_date,
          }));
      }
    }
    const notices = await db.all<{ id: string; at: string; payload: string | null }>(
      sql`SELECT id, created_at AS at, payload FROM message
          WHERE family_id = ${l.family_id} AND template_key = 'notice' AND status IN ('queued', 'sent')
          ORDER BY created_at DESC LIMIT 10`,
    );
    const body: ParentPageDto = {
      school: { name: s.name, name_ur: s.name_ur, phone: s.phone },
      guardian: { first_name: firstName(l.guardian_name), lang: l.guardian_lang },
      date: today,
      gate: { kind: gateKind(l), passed },
      children: await children(c, l.family_id, today),
      dues,
      receipts,
      notices: notices.map((n) => {
        const p = (n.payload ? JSON.parse(n.payload) : {}) as Record<string, unknown>;
        return {
          id: n.id,
          at: n.at,
          body_en: typeof p.body_en === 'string' ? p.body_en : '',
          body_ur: typeof p.body_ur === 'string' ? p.body_ur : '',
        };
      }),
    };
    await logAccess(c, l);
    return c.json(body);
  });

  /** Birth year of any of the family's children, or the link's PIN. 5 wrong answers lock it 15 min. */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/p/:token/gate', access: view },
    async (c) => {
      const l = await resolve(c);
      const input = await jsonBody(c, parentGateInputSchema);
      const db = c.get('db');
      const now = new Date();
      const kind = gateKind(l);
      if (l.gate_locked_until && l.gate_locked_until > now.toISOString())
        throw new ApiError(429, 'gate_locked', 'Too many wrong answers; try again later');
      let ok = kind === 'none';
      if (kind === 'birth_year') {
        const years = await db.all<{ y: string }>(
          sql`SELECT DISTINCT substr(dob, 1, 4) AS y FROM student
              WHERE family_id = ${l.family_id} AND status = 'active' AND dob IS NOT NULL`,
        );
        if (!years.length)
          throw new ApiError(409, 'gate_unavailable', 'Ask the school to open this page for you');
        ok = input.birth_year !== undefined && years.some((y) => y.y === String(input.birth_year));
      } else if (kind === 'pin') {
        if (!l.pin_hash)
          throw new ApiError(409, 'gate_unavailable', 'Ask the school to open this page for you');
        ok = input.pin !== undefined && (await pinHash(l.id, input.pin)) === l.pin_hash;
      }
      if (!ok) {
        const lockUntil = new Date(now.getTime() + GATE_LOCK_MINUTES * 60_000).toISOString();
        await tx(db, [
          sql`UPDATE parent_link SET
                gate_locked_until = CASE WHEN gate_failures + 1 >= ${GATE_MAX_FAILURES} THEN ${lockUntil} ELSE gate_locked_until END,
                gate_failures = CASE WHEN gate_failures + 1 >= ${GATE_MAX_FAILURES} THEN 0 ELSE gate_failures + 1 END
              WHERE id = ${l.id}`,
        ]);
        throw new ApiError(400, 'gate_failed', 'That does not match');
      }
      if (l.gate_failures)
        await tx(db, [sql`UPDATE parent_link SET gate_failures = 0 WHERE id = ${l.id}`]);
      const exp = Math.floor(now.getTime() / 1000) + GATE_HOURS * 3600;
      const body: ParentGateResultDto = {
        gate_token: await sign(c.env.SESSION_SECRET, { typ: 'pgate', exp, lid: l.id }),
        expires_at: new Date(exp * 1000).toISOString(),
      };
      return c.json(body);
    },
  );

  /** A receipt of this family, as the staff print JSON minus internal fields. */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/p/:token/receipt/:id', access: view },
    async (c) => {
      const l = await resolve(c);
      if (!(await gatePassed(c, l)))
        throw new ApiError(403, 'gate_required', 'Answer the check first');
      const p = await receiptPrint(c.get('db'), c.req.param('id') ?? '');
      if (
        p?.receipt.payer_type !== 'family' ||
        p.receipt.payer_id !== l.family_id ||
        p.receipt.kind !== 'payment'
      )
        throw new ApiError(404, 'not_found', 'Receipt not found');
      const body: ReceiptPrintDto = {
        ...p,
        receipt: {
          ...p.receipt,
          collector_id: '',
          account_id: null,
          cash_session_id: null,
          note: null,
          reference: null,
        },
      };
      return c.json(body);
    },
  );
}
