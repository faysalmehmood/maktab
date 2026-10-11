import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { family, guardian } from './academic';
import { user } from './auth';
import { id, integerMoney, nowIso, oneOf, paisa } from './common';

/**
 * 'call': no WhatsApp consent (or no number to message) — the office phones the family instead
 * (PLAN §14.3, §14.9). Finalised before the pilot (PLAN §15 enum rule).
 */
export const MESSAGE_CHANNELS = ['wa_manual', 'wa_api', 'sms', 'push', 'email', 'call'] as const;
export const MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
] as const;

export const message = sqliteTable(
  'message',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => family.id),
    guardianId: text('guardian_id').references(() => guardian.id),
    channel: text('channel', { enum: MESSAGE_CHANNELS }).notNull(),
    templateKey: text('template_key').notNull(),
    lang: text('lang', { enum: ['en', 'ur'] }).notNull(),
    payload: text('payload', { mode: 'json' }),
    /** SHA-256 of the parent-link token, like parent_link.token_hash; the token itself is never stored. */
    linkTokenHash: text('link_token_hash'),
    status: text('status', { enum: MESSAGE_STATUSES }).notNull().default('queued'),
    providerRef: text('provider_ref'),
    rawResponse: text('raw_response'),
    costEstimate: paisa('cost_estimate'),
    costActual: paisa('cost_actual'),
    createdAt: text('created_at').notNull().default(nowIso),
    createdBy: text('created_by'),
    sentAt: text('sent_at'),
    error: text('error'),
    /** M5: the exact text staff opened in WhatsApp (rebuilt at open time; PLAN §14.9). */
    renderedText: text('rendered_text'),
    /** M5: when "Open WhatsApp" (or the call script) was last opened. */
    openedAt: text('opened_at'),
    /** M5: who tapped "Sent" / "Called" (explicit, never inferred from opening). */
    sentBy: text('sent_by').references(() => user.id),
    /** M5: why a row was skipped (staff reason, or no_longer_absent / already_paid at open time). */
    skippedReason: text('skipped_reason'),
    skippedAt: text('skipped_at'),
  },
  (t) => [
    check('message_channel', oneOf('channel', MESSAGE_CHANNELS)),
    check('message_status', oneOf('status', MESSAGE_STATUSES)),
    index('message_queue').on(t.status, t.templateKey),
    /** The queue counters (sent / skipped today) read a time range per status (M5 fix pass). */
    index('message_sent_at').on(t.status, t.sentAt),
    index('message_skipped_at').on(t.status, t.skippedAt),
    index('message_family').on(t.familyId, t.templateKey),
    integerMoney('message', 'cost_estimate', true),
    integerMoney('message', 'cost_actual', true),
  ],
);

/** Cooldown so a household gets at most one reminder per template per window. */
export const reminderState = sqliteTable(
  'reminder_state',
  {
    familyId: text('family_id')
      .notNull()
      .references(() => family.id),
    templateKey: text('template_key').notNull(),
    lastSentOn: text('last_sent_on').notNull(),
  },
  (t) => [primaryKey({ columns: [t.familyId, t.templateKey] })],
);

/**
 * Message texts per template and language (PLAN §14.12), seeded with the defaults in
 * `@maktab/shared` DEFAULT_TEMPLATES by migration 0019. Placeholders are validated by the API.
 */
export const messageTemplate = sqliteTable(
  'message_template',
  {
    key: text('key').notNull(),
    lang: text('lang', { enum: ['en', 'ur'] }).notNull(),
    body: text('body').notNull(),
    updatedBy: text('updated_by').references(() => user.id),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (t) => [primaryKey({ columns: [t.key, t.lang] })],
);

/**
 * Parent magic link (PLAN §7, §14.10). Only the SHA-256 of the token is stored, so a DB leak does
 * not leak working links. The token itself is HMAC(PARENT_LINK_SECRET, token_salt): 128 random bits of
 * salt, recomputable by the Worker so a queued message can carry the guardian's current link without
 * the link ever being stored in clear. One live link per guardian (rotate = revoke + new row).
 * `gate` NULL follows the school default (school.parent_gate); values are validated by the API.
 */
export const parentLink = sqliteTable(
  'parent_link',
  {
    id: id(),
    guardianId: text('guardian_id')
      .notNull()
      .references(() => guardian.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull().default(nowIso),
    createdBy: text('created_by'),
    tokenSalt: text('token_salt'),
    gate: text('gate'),
    pinHash: text('pin_hash'),
    /**
     * Gate attempts counted in the current window: each attempt is claimed (counted) atomically
     * before it is checked; a right answer resets it. At 5 the gate locks for 15 minutes.
     */
    gateFailures: integer('gate_failures').notNull().default(0),
    gateLockedUntil: text('gate_locked_until'),
    /** Last counted attempt: the count restarts after 15 minutes without one (sliding window). */
    gateLastAttemptAt: text('gate_last_attempt_at'),
  },
  (t) => [index('parent_link_guardian').on(t.guardianId)],
);

/** Staff-visible access log of a parent link (hashed IP, user agent); capped per link by the API. */
export const parentLinkAccess = sqliteTable(
  'parent_link_access',
  {
    id: id(),
    linkId: text('link_id')
      .notNull()
      .references(() => parentLink.id),
    at: text('at').notNull().default(nowIso),
    ipHash: text('ip_hash'),
    ua: text('ua'),
  },
  (t) => [index('parent_link_access_link').on(t.linkId, t.at)],
);
