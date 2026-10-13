import { familyStatement } from '@maktab/db';
import {
  firstName,
  formatDmy,
  joinNames,
  type MessageLang,
  monthLabel,
  newId,
  PARENT_TOKEN_HEADER,
  type ParentChildDto,
  type ParentGate,
  type ParentGateResultDto,
  type ParentPageDto,
  type ParentReceiptDto,
  parentGateInputSchema,
  presentPct,
  RECEIPT_LABELS,
  renderTemplate,
  wasFor,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { sign, verify } from '../auth/signed';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { receiptPrint } from '../lib/fees';
import { jsonBody, todayPk } from '../lib/http';
import {
  ipHash,
  type LinkRow,
  linkExpired,
  parentSecret,
  pinHash,
  safeEqual,
  schoolMsg,
  sha256Hex,
} from '../lib/messaging';
import { PARENT_RATE, RateLimiter } from '../lib/ratelimit';
import { clientIp, type Fetch, turnstileSiteKey, verifyTurnstile } from '../lib/turnstile';
import { tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';

/**
 * The parent page API (PLAN §7, §14.10): public, reached with a magic-link token, never a session.
 * The token travels only in the `X-Parent-Token` header (the page's URL carries it as a fragment,
 * `/p#<token>`), so it never lands in a URL path, a server log or a Referer.
 *
 * Responses are whitelists (M5 fix pass): first names, class, attendance, dues lines, receipt numbers
 * and notices of the guardian's own family. No database ids (a child is an opaque per-link index, a
 * receipt is its number), never CNIC, B-form, dates of birth, phone numbers, staff names or other
 * families. The gate (birth year or PIN) guards dues, receipts and results; attendance and notices
 * show without it. The birth-year gate is a speed bump against a forwarded link, not a secret: a
 * relative may know the year, and there are only ~20 plausible ones — hence 5 attempts per window.
 * Every response: noindex, no referrer, no store. Rate-limited per token (lib/ratelimit.ts).
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const GATE_HOURS = 12;
const GATE_MAX_FAILURES = 5;
const GATE_LOCK_MINUTES = 15;
/** A count of attempts restarts after this long without one (each attempt slides the window). */
const GATE_WINDOW_MINUTES = 15;
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

export function parentRoutes(app: Hono<AppEnv>, table: RouteTable, deps: { fetch: Fetch }): void {
  const view = requires('parent_page', 'view');
  const limiter = new RateLimiter(PARENT_RATE.limit, PARENT_RATE.windowMs);

  const headers = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    await next();
    // The logo is the one cacheable answer here (versioned URL, no personal data).
    const cacheable = c.req.path === '/api/p/logo' && c.res.status === 200;
    for (const [k, v] of Object.entries(PARENT_HEADERS))
      if (!(cacheable && k === 'Cache-Control')) c.res.headers.set(k, v);
  };
  app.use('/api/p', headers);
  app.use('/api/p/*', headers);

  async function resolve(c: Context<AppEnv>): Promise<Resolved> {
    const token = c.req.header(PARENT_TOKEN_HEADER) ?? '';
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
      parentSecret(c.env),
      c.req.header('x-parent-gate'),
      'pgate',
      gateClaims,
      Math.floor(Date.now() / 1000),
    );
    return claims?.lid === l.id;
  }

  /**
   * The family's children in admission order; `index` (1-based, over every child of the family, so
   * it does not shift when one leaves) is the only handle the page gets — never the student id.
   */
  async function familyChildren(c: Context<AppEnv>, familyId: string) {
    const rows = await c.get('db').all<{
      id: string;
      name: string;
      status: string;
      grp: string | null;
    }>(
      sql`SELECT st.id, st.name, st.status,
            (SELECT trim(p.name || ' ' || g.name) FROM enrolment e JOIN grp g ON g.id = e.grp_id
               JOIN programme p ON p.id = g.programme_id
             WHERE e.student_id = st.id AND e.status = 'active' ORDER BY e.is_primary DESC LIMIT 1) AS grp
          FROM student st WHERE st.family_id = ${familyId}
          ORDER BY st.admission_date, st.name, st.id`,
    );
    return rows.map((r, i) => ({ ...r, index: i + 1 }));
  }

  async function children(
    c: Context<AppEnv>,
    family: Awaited<ReturnType<typeof familyChildren>>,
    today: string,
  ) {
    const db = c.get('db');
    const kids = family.filter((k) => k.status === 'active');
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
        index: k.index,
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
      parentSecret(c.env),
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

  defineRoute(app, table, { method: 'GET', path: '/api/p', access: view }, async (c) => {
    const l = await resolve(c);
    parentSecret(c.env);
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
            receipt_no: r.receipt_no,
            amount: r.amount,
            business_date: r.business_date,
          }));
      }
    }
    const notices = await db.all<{ at: string; payload: string | null }>(
      sql`SELECT created_at AS at, payload FROM message
          WHERE family_id = ${l.family_id} AND template_key = 'notice' AND status IN ('queued', 'sent')
          ORDER BY created_at DESC LIMIT 10`,
    );
    const kids = await children(c, await familyChildren(c, l.family_id), today);
    // Notices are shown filled in (school, first names, date) and without the link: the reader is
    // already on the page the link points to.
    const fill = (text: string, lang: MessageLang) =>
      renderTemplate(text, {
        children: joinNames(
          kids.map((k) => k.first_name),
          lang,
        ),
        child: kids[0]?.first_name ?? '',
        was: wasFor(kids.length, lang),
        date: formatDmy(today),
        month: monthLabel(today, lang),
        school: lang === 'ur' ? s.name_ur || s.name : s.name,
        link: '',
      });
    const body: ParentPageDto = {
      school: { name: s.name, name_ur: s.name_ur, phone: s.phone },
      guardian: { first_name: firstName(l.guardian_name), lang: l.guardian_lang },
      date: today,
      gate: { kind: gateKind(l), passed },
      // The gate form shows the Turnstile widget only when it is on (and only while needed).
      turnstile_site_key: passed ? null : turnstileSiteKey(c.env),
      children: kids,
      dues,
      receipts,
      notices: notices.map((n) => {
        const p = (n.payload ? JSON.parse(n.payload) : {}) as Record<string, unknown>;
        return {
          at: n.at,
          body_en: typeof p.body_en === 'string' ? fill(p.body_en, 'en') : '',
          body_ur: typeof p.body_ur === 'string' ? fill(p.body_ur, 'ur') : '',
        };
      }),
    };
    await logAccess(c, l);
    return c.json(body);
  });

  /**
   * Birth year of any of the family's children, or the link's PIN. Each attempt is claimed (counted)
   * in one atomic UPDATE before the answer is checked, so parallel guesses cannot all slip in under
   * the limit: the 5th claim in a window locks the gate for 15 minutes and later claims find nothing
   * to update (429). A right answer resets the count. Compared in constant time.
   */
  defineRoute(app, table, { method: 'POST', path: '/api/p/gate', access: view }, async (c) => {
    const l = await resolve(c);
    const secret = parentSecret(c.env);
    const input = await jsonBody(c, parentGateInputSchema);
    // Before an attempt is counted: a failed Turnstile check never burns one of the 5 tries.
    if (
      gateKind(l) !== 'none' &&
      !(await verifyTurnstile(
        c.env,
        deps.fetch,
        input.turnstile_token,
        clientIp((h) => c.req.header(h)),
      ))
    )
      throw new ApiError(400, 'turnstile_failed', 'Please complete the check and try again');
    const db = c.get('db');
    const now = new Date();
    const nowIso = now.toISOString();
    const kind = gateKind(l);
    let years: string[] = [];
    if (kind === 'birth_year') {
      years = (
        await db.all<{ y: string }>(
          sql`SELECT DISTINCT substr(dob, 1, 4) AS y FROM student
              WHERE family_id = ${l.family_id} AND status = 'active' AND dob IS NOT NULL`,
        )
      ).map((y) => y.y);
      if (!years.length)
        throw new ApiError(409, 'gate_unavailable', 'Ask the school to open this page for you');
    } else if (kind === 'pin' && !l.pin_hash)
      throw new ApiError(409, 'gate_unavailable', 'Ask the school to open this page for you');

    if (kind !== 'none') {
      const windowStart = new Date(now.getTime() - GATE_WINDOW_MINUTES * 60_000).toISOString();
      const lockUntil = new Date(now.getTime() + GATE_LOCK_MINUTES * 60_000).toISOString();
      const counted = sql`(CASE WHEN gate_last_attempt_at IS NULL OR gate_last_attempt_at < ${windowStart}
                             THEN 1 ELSE gate_failures + 1 END)`;
      const claimed = await db.all<{ gate_failures: number }>(
        sql`UPDATE parent_link SET gate_failures = ${counted},
              gate_locked_until = CASE WHEN ${counted} >= ${GATE_MAX_FAILURES} THEN ${lockUntil} ELSE NULL END,
              gate_last_attempt_at = ${nowIso}
            WHERE id = ${l.id} AND revoked_at IS NULL
              AND (gate_locked_until IS NULL OR gate_locked_until < ${nowIso})
            RETURNING gate_failures`,
      );
      if (!claimed.length)
        throw new ApiError(429, 'gate_locked', 'Too many wrong answers; try again later');
      let ok = false;
      if (kind === 'birth_year') {
        const answer = input.birth_year === undefined ? '' : String(input.birth_year);
        // Every candidate is compared (no early exit), each in constant time.
        for (const y of years) ok = safeEqual(y, answer) || ok;
      } else if (l.pin_hash) {
        ok = safeEqual(await pinHash(secret, l.id, input.pin ?? ''), l.pin_hash);
      }
      if (!ok) throw new ApiError(400, 'gate_failed', 'That does not match');
      await tx(db, [
        sql`UPDATE parent_link SET gate_failures = 0, gate_locked_until = NULL,
              gate_last_attempt_at = NULL WHERE id = ${l.id}`,
      ]);
    }
    const exp = Math.floor(now.getTime() / 1000) + GATE_HOURS * 3600;
    const body: ParentGateResultDto = {
      gate_token: await sign(secret, { typ: 'pgate', exp, lid: l.id }),
      expires_at: new Date(exp * 1000).toISOString(),
    };
    return c.json(body);
  });

  /** A short, stable version of the current logo object key (it changes on every upload). */
  async function logoVersion(c: Context<AppEnv>): Promise<string | null> {
    const [row] = await c
      .get('db')
      .all<{ k: string | null }>(sql`SELECT logo_key AS k FROM school ORDER BY created_at LIMIT 1`);
    return row?.k ? (await sha256Hex(row.k)).slice(0, 16) : null;
  }

  /**
   * The school logo for the parent receipt (M5 gap, M7): token-gated like every /api/p route (no
   * gate answer needed — it is the school's, not the family's), image types only, and cacheable
   * by the browser for a week under its versioned URL (`?v=` from the receipt). No session.
   */
  defineRoute(app, table, { method: 'GET', path: '/api/p/logo', access: view }, async (c) => {
    await resolve(c);
    const [row] = await c
      .get('db')
      .all<{ k: string | null }>(sql`SELECT logo_key AS k FROM school ORDER BY created_at LIMIT 1`);
    const notFound = () => new ApiError(404, 'not_found', 'No logo');
    if (!row?.k || !c.env.FILES) throw notFound();
    const obj = await c.env.FILES.get(row.k);
    const type = obj?.httpMetadata?.contentType ?? '';
    if (!obj || !/^image\/(png|jpeg|webp)$/.test(type)) throw notFound();
    return new Response(obj.body, {
      headers: {
        'content-type': type,
        'cache-control': 'private, max-age=604800, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });

  /**
   * A payment receipt of this family by its number, as a whitelist: school header, first names, the
   * lines and totals. No ids, no collector or account, no note or reference, no admission numbers.
   */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/p/receipt/:no', access: view },
    async (c) => {
      const l = await resolve(c);
      if (!(await gatePassed(c, l)))
        throw new ApiError(403, 'gate_required', 'Answer the check first');
      const db = c.get('db');
      const notFound = () => new ApiError(404, 'not_found', 'Receipt not found');
      const [row] = await db.all<{ id: string }>(
        sql`SELECT id FROM receipt WHERE receipt_no = ${c.req.param('no') ?? ''}
              AND payer_type = 'family' AND payer_id = ${l.family_id} AND kind = 'payment'`,
      );
      const p = row ? await receiptPrint(db, row.id) : null;
      if (!p) throw notFound();
      const family = await familyChildren(c, l.family_id);
      const index = new Map(family.map((k) => [k.id, k.index]));
      const body: ParentReceiptDto = {
        school: {
          name: p.school.name,
          name_ur: p.school.name_ur,
          address: p.school.address,
          phone: p.school.phone,
          logo_v: await logoVersion(c),
        },
        labels: RECEIPT_LABELS,
        lang: p.lang,
        receipt: {
          receipt_no: p.receipt.receipt_no,
          business_date: p.receipt.business_date,
          amount: p.receipt.amount,
          method: p.receipt.method,
          payer_name: firstName(l.guardian_name),
        },
        students: p.students.map((st) => ({
          child: index.get(st.student_id) ?? 0,
          first_name: firstName(st.student_name),
          lines: st.lines.map((x) => ({
            period_key: x.period_key,
            head_name: x.head_name,
            head_name_ur: x.head_name_ur,
            amount: x.amount,
          })),
          subtotal: st.subtotal,
        })),
        totals: {
          amount: p.totals.amount,
          allocated: p.totals.allocated,
          credit_added: p.totals.credit_added,
          payer_due: p.totals.payer_due,
          payer_credit: p.totals.payer_credit,
        },
        reversed: p.reversed,
      };
      return c.json(body);
    },
  );
}
