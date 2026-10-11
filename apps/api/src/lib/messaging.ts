import type { AppDb } from '@maktab/db';
import {
  DEFAULT_TEMPLATES,
  firstName,
  formatDmy,
  formatRs,
  joinNames,
  type MessageLang,
  monthLabel,
  newId,
  PARENT_GATES,
  type ParentGate,
  parentLinkUrl,
  renderTemplate,
  TEMPLATE_KEYS,
  type TemplateKey,
  type TemplateVars,
  wasFor,
  wrapNotice,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { GroupScope } from '../perm/scope';
import { b64urlEncode, utf8 } from './b64';
import { ApiError } from './errors';

/**
 * Messaging helpers (PLAN §7, §14.9, §14.10): school/template lookups, the per-row renderer, the
 * absence rebuild, and parent-link tokens.
 */

// ---- Crypto ----------------------------------------------------------------------------------------

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', utf8(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    hmacKeys.set(secret, k);
  }
  return k;
}

const hmac = async (secret: string, msg: string): Promise<ArrayBuffer> =>
  crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(msg));
const hex = (b: ArrayBuffer): string =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * PARENT_LINK_SECRET (a Worker secret of its own, never SESSION_SECRET): parent-link tokens, the
 * access log's IP hashes, PIN hashes and gate tokens all derive from it. Missing → the parent-link
 * routes answer 503 `misconfigured` (and the Worker logs a config warning at start).
 */
export function parentSecret(env: { PARENT_LINK_SECRET?: string | undefined }): string {
  const s = env.PARENT_LINK_SECRET?.trim() ?? '';
  if (s.length < 32)
    throw new ApiError(503, 'misconfigured', 'Parent links are not set up on this server yet');
  return s;
}

/**
 * The parent-link token: HMAC-SHA256(PARENT_LINK_SECRET, "link:" + salt), base64url (43 chars,
 * 256 bits; the salt is 128 random bits). Only its SHA-256 is stored, so a database leak alone does
 * not give working links; the Worker can recompute it to put the current link into a message.
 * Rotating PARENT_LINK_SECRET makes every stored link unrecomputable: run
 * POST /api/parent-links/rotate-all afterwards (it revokes them all; new ones are made on demand).
 */
export async function linkToken(secret: string, salt: string): Promise<string> {
  return b64urlEncode(await hmac(secret, `link:${salt}`));
}

/** `https://host/p#<token>` (shared with the web app). */
export const linkUrl = parentLinkUrl;

/** Hashed client IP for the access log: HMAC(PARENT_LINK_SECRET, ip), so it cannot be reversed by lookup. */
export async function ipHash(
  secret: string,
  ip: string | null | undefined,
): Promise<string | null> {
  if (!ip) return null;
  return hex(await hmac(secret, `ip:${ip}`));
}

/** PIN hash: keyed, so a database leak alone cannot brute-force a 4–6 digit PIN offline. */
export const pinHash = async (secret: string, linkId: string, pin: string): Promise<string> =>
  hex(await hmac(secret, `pin:${linkId}:${pin}`));

/** Constant-time string comparison (same length leaks nothing but the length). */
export function safeEqual(a: string, b: string): boolean {
  const x = utf8(a);
  const y = utf8(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---- School and templates ----------------------------------------------------------------------------

export type SchoolMsg = {
  name: string;
  name_ur: string | null;
  phone: string | null;
  parent_gate: ParentGate;
  reminder_cooldown_days: number;
  announcement_groups_note: string | null;
};

export async function schoolMsg(db: AppDb): Promise<SchoolMsg> {
  const [s] = await db.all<SchoolMsg>(
    sql`SELECT name, name_ur, phone, parent_gate, reminder_cooldown_days, announcement_groups_note
        FROM school ORDER BY created_at LIMIT 1`,
  );
  return {
    name: s?.name ?? '',
    name_ur: s?.name_ur ?? null,
    phone: s?.phone ?? null,
    parent_gate: PARENT_GATES.includes(s?.parent_gate as ParentGate)
      ? (s?.parent_gate as ParentGate)
      : 'birth_year',
    reminder_cooldown_days: Number(s?.reminder_cooldown_days ?? 7),
    announcement_groups_note: s?.announcement_groups_note ?? null,
  };
}

export type Templates = Record<TemplateKey, Record<MessageLang, string>>;

/** Stored bodies over the defaults (one read). */
export async function loadTemplates(db: AppDb): Promise<Templates> {
  const rows = await db.all<{ key: string; lang: MessageLang; body: string }>(
    sql`SELECT key, lang, body FROM message_template`,
  );
  const out = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)) as Templates;
  for (const r of rows) {
    if (
      (TEMPLATE_KEYS as readonly string[]).includes(r.key) &&
      (r.lang === 'en' || r.lang === 'ur')
    )
      out[r.key as TemplateKey][r.lang] = r.body;
  }
  return out;
}

// ---- Rendering --------------------------------------------------------------------------------------

type Payload = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** What a template needs from a message payload; `children` / `amount` override (rebuilt values). */
export function messageVars(
  key: string,
  lang: MessageLang,
  payload: Payload,
  ctx: { school: SchoolMsg; link: string; today: string; children?: string[]; amount?: number },
): TemplateVars {
  const names = ctx.children ?? strs(payload.student_names);
  const amount =
    ctx.amount ??
    (key === 'fee_overdue'
      ? num(payload.overdue)
      : key === 'fee_due'
        ? num(payload.due)
        : num(payload.amount));
  const when = str(payload.date) ?? str(payload.business_date) ?? str(payload.as_of) ?? ctx.today;
  return {
    child: names[0] ?? '',
    children: joinNames(names, lang),
    was: wasFor(names.length, lang),
    date: formatDmy(when),
    amount: amount === undefined ? '' : formatRs(amount),
    month: monthLabel(when, lang),
    receipt_no: str(payload.receipt_no) ?? '',
    school: lang === 'ur' ? ctx.school.name_ur || ctx.school.name : ctx.school.name,
    link: ctx.link,
  };
}

/** The body for a row: a notice carries its own text (per language, falling back to the other). */
export function bodyFor(
  key: string,
  lang: MessageLang,
  payload: Payload,
  templates: Templates,
): string {
  if (key === 'notice') {
    // The composed text sits in the notice template's {body} slot, so the template's {link} is still
    // alone on the last line (M5 fix pass).
    const en = str(payload.body_en) ?? '';
    const ur = str(payload.body_ur) ?? '';
    return wrapNotice(templates.notice[lang], lang === 'ur' ? ur || en : en || ur);
  }
  const t = (templates as Record<string, Record<MessageLang, string>>)[key];
  return t?.[lang] ?? '';
}

export function renderRow(
  row: { template_key: string; lang: MessageLang; payload: Payload | null },
  ctx: {
    school: SchoolMsg;
    templates: Templates;
    link: string;
    today: string;
    children?: string[];
    amount?: number;
  },
): string {
  const payload = row.payload ?? {};
  return renderTemplate(
    bodyFor(row.template_key, row.lang, payload, ctx.templates),
    messageVars(row.template_key, row.lang, payload, ctx),
  );
}

// ---- Scope and rebuilds --------------------------------------------------------------------------------

/**
 * Which messages a scope may see or send: everything for `all`; a teacher only their own groups'
 * absence rows (fee and notice rows are office work; PLAN §14.9).
 */
export function messageScopeSql(scope: GroupScope): ReturnType<typeof sql> {
  if (scope.kind === 'all') return sql`1`;
  if (!scope.ids.length) return sql`0`;
  return sql`(msg.template_key = 'absence' AND json_extract(msg.payload, '$.grp_id') IN
              (SELECT value FROM json_each(${JSON.stringify(scope.ids)})))`;
}

export type StillAbsent = { student_id: string; name: string; grp_id: string; grp_name: string };

/**
 * PLAN §14.9 "M5 must remember": an absence row is a prompt. At send time the family's children who
 * are absent in the *current* registers of that date are the message — a correction to present drops
 * a child (none left → skip), and a sibling absent in another group joins the same message.
 */
export async function stillAbsent(
  db: AppDb,
  familyId: string,
  date: string,
): Promise<StillAbsent[]> {
  return db.all<StillAbsent>(
    sql`SELECT st.id AS student_id, st.name, c.grp_id,
          trim(p.name || ' ' || g.name) AS grp_name
        FROM current_register c
        JOIN att_mark m ON m.register_id = c.register_id AND m.status = 'A'
        JOIN student st ON st.id = m.student_id
        JOIN grp g ON g.id = c.grp_id JOIN programme p ON p.id = g.programme_id
        WHERE c.date = ${date} AND st.family_id = ${familyId}
        GROUP BY st.id ORDER BY st.admission_date, st.name`,
  );
}

/** What a family owes now, net of its unallocated credit (fee reminders are re-checked at send). */
export async function familyDueNow(
  db: AppDb,
  familyId: string,
  today: string,
): Promise<{ due: number; overdue: number }> {
  const [r] = await db.all<{ due: number; overdue: number; credit: number }>(
    sql`SELECT coalesce(sum(CASE WHEN cs.due > 0 THEN cs.due END), 0) AS due,
          coalesce(sum(CASE WHEN cs.due > 0 AND cs.due_date < ${today} THEN cs.due END), 0) AS overdue,
          coalesce((SELECT credit FROM payer_credit WHERE payer_type = 'family' AND payer_id = ${familyId}), 0) AS credit
        FROM charge_status cs
        WHERE cs.payer_type = 'family' AND cs.payer_id = ${familyId}`,
  );
  const credit = Math.max(0, Number(r?.credit ?? 0));
  return {
    due: Math.max(0, Number(r?.due ?? 0) - credit),
    overdue: Math.max(0, Number(r?.overdue ?? 0) - credit),
  };
}

// ---- Parent links ---------------------------------------------------------------------------------------

export type LinkRow = {
  id: string;
  guardian_id: string;
  token_hash: string;
  token_salt: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  created_by: string | null;
  gate: string | null;
  pin_hash: string | null;
  gate_failures: number;
  gate_locked_until: string | null;
  gate_last_attempt_at?: string | null;
};

export const linkExpired = (l: LinkRow, nowIso: string): boolean =>
  !!l.expires_at && l.expires_at <= nowIso;

export async function liveLink(db: AppDb, guardianId: string): Promise<LinkRow | null> {
  const [l] = await db.all<LinkRow>(
    sql`SELECT * FROM parent_link WHERE guardian_id = ${guardianId} AND revoked_at IS NULL`,
  );
  return l ?? null;
}

export const randomSalt = (): string => b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

/**
 * Statements that end a guardian's live link (if any) and start a new one. Rotation and expiry
 * renewal are the same thing: the old token stops working in the same batch the new one starts.
 */
export async function newLinkStatements(o: {
  /** PARENT_LINK_SECRET. */
  secret: string;
  guardianId: string;
  by: string | null;
  now: string;
  days: number;
  gate: ParentGate;
  pin?: string;
}): Promise<{ id: string; token: string; stmts: ReturnType<typeof sql>[] }> {
  const id = newId();
  const salt = randomSalt();
  const token = await linkToken(o.secret, salt);
  const hash = await sha256Hex(token);
  const expires = new Date(Date.parse(o.now) + o.days * 86_400_000).toISOString();
  const pin = o.gate === 'pin' && o.pin ? await pinHash(o.secret, id, o.pin) : null;
  return {
    id,
    token,
    stmts: [
      sql`UPDATE parent_link SET revoked_at = ${o.now}
          WHERE guardian_id = ${o.guardianId} AND revoked_at IS NULL`,
      sql`INSERT INTO parent_link (id, guardian_id, token_hash, token_salt, expires_at, gate, pin_hash, created_by, created_at)
          VALUES (${id}, ${o.guardianId}, ${hash}, ${salt}, ${expires}, ${o.gate}, ${pin}, ${o.by}, ${o.now})`,
    ],
  };
}

/** The guardian's display first name on the parent page. */
export const guardianFirstName = (name: string): string => firstName(name);
