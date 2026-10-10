import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { family, guardian } from './academic';
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
  },
  (t) => [
    check('message_channel', oneOf('channel', MESSAGE_CHANNELS)),
    check('message_status', oneOf('status', MESSAGE_STATUSES)),
    index('message_queue').on(t.status, t.templateKey),
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

/** Only the SHA-256 of the token is stored, so a DB leak does not leak working links. */
export const parentLink = sqliteTable('parent_link', {
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
});
