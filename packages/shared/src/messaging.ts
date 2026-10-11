import { z } from 'zod';
import { formatPKR } from './money';
import { toLatinDigits } from './phone';

/**
 * Messaging (PLAN §5.3, §7, §14.9, §14.10): templates, the renderer and the wa.me URL builder settled
 * by experiment 4, and the send-queue / parent-page contracts. The renderer runs on the API (the
 * text a staff phone opens) and on the web (template preview), so both always agree.
 */

export const TEMPLATE_KEYS = [
  'absence',
  'fee_due',
  'fee_overdue',
  'payment_received',
  'notice',
  'result',
] as const;
export const templateKeySchema = z.enum(TEMPLATE_KEYS);
export type TemplateKey = z.infer<typeof templateKeySchema>;

export const MESSAGE_LANGS = ['en', 'ur'] as const;
export type MessageLang = (typeof MESSAGE_LANGS)[number];

/** Every placeholder a template may use. Anything else in braces is refused on save. */
export const PLACEHOLDERS = [
  'child',
  'children',
  'date',
  'amount',
  'month',
  'link',
  'school',
  'receipt_no',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type TemplateVars = Partial<Record<Placeholder, string>>;

export const MAX_TEMPLATE_LENGTH = 1000;

/**
 * Defaults, seeded into `message_template` by migration 0019 (a test keeps the two equal). `{link}`
 * always ends up alone on the last line (see renderTemplate), so a tap on it in WhatsApp opens the
 * parent page and the text above it stays readable in both directions.
 */
export const DEFAULT_TEMPLATES: Record<TemplateKey, Record<MessageLang, string>> = {
  absence: {
    en: 'Assalamu alaikum. {children} was absent from school today, {date}. If this is a mistake, please tell us. — {school}\nDetails:\n{link}',
    ur: 'السلام علیکم۔ آپ کے بچے {children} آج {date} کو اسکول میں غیر حاضر تھے۔ اگر یہ غلطی ہے تو ہمیں بتائیں۔ — {school}\nتفصیل:\n{link}',
  },
  fee_due: {
    en: 'Assalamu alaikum. The fee of {amount} for {children} ({month}) is due. — {school}\nDetails:\n{link}',
    ur: 'السلام علیکم۔ {children} کی {month} کی فیس {amount} واجب الادا ہے۔ — {school}\nتفصیل:\n{link}',
  },
  fee_overdue: {
    en: 'Assalamu alaikum. The fee of {amount} for {children} is overdue. Please pay soon. — {school}\nDetails:\n{link}',
    ur: 'السلام علیکم۔ {children} کی فیس {amount} کی ادائیگی باقی ہے، براہ کرم جلد ادا کریں۔ — {school}\nتفصیل:\n{link}',
  },
  payment_received: {
    en: 'Assalamu alaikum. We received {amount} for {children} (receipt {receipt_no}). JazakAllah. — {school}\nReceipt:\n{link}',
    ur: 'السلام علیکم۔ {children} کی فیس {amount} موصول ہو گئی (رسید {receipt_no})۔ جزاک اللہ۔ — {school}\nرسید:\n{link}',
  },
  notice: {
    en: 'Assalamu alaikum.\n\n— {school}\n{link}',
    ur: 'السلام علیکم۔\n\n— {school}\n{link}',
  },
  result: {
    en: 'Assalamu alaikum. Results for {children} are ready. — {school}\nDetails:\n{link}',
    ur: 'السلام علیکم۔ {children} کا نتیجہ تیار ہے۔ — {school}\nتفصیل:\n{link}',
  },
};

const TOKEN = /\{(\w+)\}/g;

/** Placeholders in `body` that the renderer does not know (shown to the editor, refused on save). */
export function unknownPlaceholders(body: string): string[] {
  const known = new Set<string>(PLACEHOLDERS);
  return [...new Set([...body.matchAll(TOKEN)].map((m) => m[1] ?? ''))].filter(
    (k) => !known.has(k),
  );
}

/**
 * Fills a template. Rules from experiment 4: Latin digits only (an Urdu keyboard's ۱۲۳ become 123);
 * a missing value renders empty; and `{link}`, wherever the body puts it, is moved to a line of its
 * own at the very end (no link → no line), so WhatsApp shows it as one clean tappable URL.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  const hasLink = body.includes('{link}');
  let text = hasLink ? body.replace(/[ \t]*\{link\}/g, '') : body;
  text = text.replace(TOKEN, (m, k: string) =>
    (PLACEHOLDERS as readonly string[]).includes(k) ? (vars[k as Placeholder] ?? '') : m,
  );
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
  const link = vars.link?.trim();
  if (hasLink && link) text = `${text}\n${link}`;
  return toLatinDigits(text);
}

/** `https://wa.me/923001234567?text=…` — the number is already normalised (no plus). */
export function waUrl(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

export const telUrl = (number: string): string => `tel:+${number}`;

/** Message amounts read "Rs 8,000" (exp4), Latin digits. */
export const formatRs = (paisa: number): string => formatPKR(paisa).replace('PKR', 'Rs');

/** `2026-10-11` → `11/10/2026` (day first, as Pakistani schools write it). */
export function formatDmy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

export const MONTH_NAMES: Record<MessageLang, readonly string[]> = {
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  ur: [
    'جنوری',
    'فروری',
    'مارچ',
    'اپریل',
    'مئی',
    'جون',
    'جولائی',
    'اگست',
    'ستمبر',
    'اکتوبر',
    'نومبر',
    'دسمبر',
  ],
};

/** `2026-10` (or a full date) → "October 2026" / "اکتوبر 2026". */
export function monthLabel(periodOrDate: string, lang: MessageLang): string {
  const [y, m] = periodOrDate.split('-');
  const name = MONTH_NAMES[lang][Number(m) - 1];
  return name && y ? `${name} ${y}` : periodOrDate;
}

/** "Ali", "Ali and Sara", "Ali, Sara and Zain" — in Urdu with ، and اور. */
export function joinNames(names: readonly string[], lang: MessageLang): string {
  const and = lang === 'ur' ? ' اور ' : ' and ';
  const comma = lang === 'ur' ? '، ' : ', ';
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(comma)}${and}${names[names.length - 1]}`;
}

/** First word of a name: the parent page shows first names only (PLAN §7). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? '';

// ---- Send queue -----------------------------------------------------------------------------------

/** Reasons staff pick when skipping a row. */
export const SKIP_REASONS = [
  'wrong_number',
  'informed_in_person',
  'duplicate',
  'no_whatsapp',
  'other',
] as const;
/** Reasons the system records by itself at open time. */
export const SYSTEM_SKIP_REASONS = ['no_longer_absent', 'already_paid', 'no_guardian'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number] | (typeof SYSTEM_SKIP_REASONS)[number];

export const messageSkipSchema = z.object({ reason: z.enum(SKIP_REASONS) });

export const MESSAGE_STATUS_FILTER = ['queued', 'sent', 'skipped', 'failed'] as const;

const idSchema = z.string().min(1).max(64);

export const COMPOSE_BATCH = 200;

export const composeAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('group'), grp_id: idSchema }),
  z.object({
    kind: z.literal('families'),
    family_ids: z.array(idSchema).min(1).max(COMPOSE_BATCH),
  }),
]);
export type ComposeAudience = z.infer<typeof composeAudienceSchema>;

export const composeInputSchema = z
  .object({
    /** Client-minted once per notice; each loop call repeats it, so retries never double-queue. */
    notice_id: idSchema,
    audience: composeAudienceSchema,
    body_en: z.string().trim().max(MAX_TEMPLATE_LENGTH).default(''),
    body_ur: z.string().trim().max(MAX_TEMPLATE_LENGTH).default(''),
    /** Cursor from the previous call's `next` (family id); absent on the first call. */
    after: idSchema.optional(),
  })
  .refine((v) => v.body_en.length > 0 || v.body_ur.length > 0, {
    message: 'Write the notice in English or Urdu',
    path: ['body_en'],
  })
  .refine((v) => !unknownPlaceholders(`${v.body_en}\n${v.body_ur}`).length, {
    message: 'Unknown placeholder',
    path: ['body_en'],
  });
export type ComposeInput = z.input<typeof composeInputSchema>;

export type ComposeResultDto = {
  queued: number;
  /** Families already holding this notice (a retried call) or with no guardian at all. */
  skipped: number;
  /** Pass back as `after` to queue the next ≤ 200 families; null when done. */
  next: string | null;
  /** Families in the audience (for the progress bar). */
  total: number;
};

export const templateUpdateSchema = z.object({
  /** null restores the default text. */
  body: z
    .string()
    .trim()
    .min(1)
    .max(MAX_TEMPLATE_LENGTH)
    .refine((b) => !unknownPlaceholders(b).length, 'Unknown placeholder')
    .nullable(),
});
export const templatePreviewSchema = z.object({
  key: templateKeySchema,
  lang: z.enum(MESSAGE_LANGS),
  body: z.string().max(MAX_TEMPLATE_LENGTH),
});

export const PARENT_GATES = ['none', 'birth_year', 'pin'] as const;
export type ParentGate = (typeof PARENT_GATES)[number];

export const messageSettingsSchema = z.object({
  reminder_cooldown_days: z.number().int().min(1).max(90),
  parent_gate: z.enum(PARENT_GATES),
  announcement_groups_note: z.string().trim().max(2000).nullable(),
});
export type MessageSettingsDto = z.output<typeof messageSettingsSchema>;

export type MessageTemplateDto = {
  key: TemplateKey;
  lang: MessageLang;
  body: string;
  default_body: string;
  is_default: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
};

/** A queue row. `preview` is rendered from the stored payload; `open` rebuilds it for real. */
export type QueueMessageDto = {
  id: string;
  family_id: string;
  family_name: string;
  guardian_id: string | null;
  guardian_name: string | null;
  /** Raw stored number (display); `wa_number` is the normalised mobile wa.me needs, if valid. */
  guardian_phone: string | null;
  wa_number: string | null;
  channel: string;
  template_key: string;
  lang: MessageLang;
  status: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  preview: string;
  grp_id: string | null;
  grp_name: string | null;
  opened_at: string | null;
  sent_at: string | null;
  sent_by_name: string | null;
  skipped_reason: string | null;
};

export type MessageListDto = {
  items: QueueMessageDto[];
  total: number;
  counts: MessageCountsDto;
};

export type MessageCountsDto = {
  queued: number;
  sent_today: number;
  skipped_today: number;
  by_template: Record<string, number>;
};

export type MessageOpenDto = {
  id: string;
  status: 'queued' | 'skipped';
  skipped_reason: string | null;
  channel: string;
  lang: MessageLang;
  text: string;
  /** wa.me link for a wa_manual row with a valid mobile number; else null (fix the number). */
  wa_url: string | null;
  tel_url: string | null;
  number: string | null;
  /** Children named in the rebuilt text (absence: still absent today, siblings merged). */
  children: string[];
};

export type BulkTextDto = { text: string; count: number; grp_name: string };

// ---- Parent links and the parent page --------------------------------------------------------------

export const PARENT_LINK_DAYS = 365;

export const parentLinkCreateSchema = z.object({
  /** 'default' follows the school setting. */
  gate: z.enum(['default', ...PARENT_GATES]).default('default'),
  pin: z
    .string()
    .regex(/^\d{4,6}$/, '4 to 6 digits')
    .optional(),
  days: z.number().int().min(1).max(730).default(PARENT_LINK_DAYS),
});
export type ParentLinkCreateInput = z.input<typeof parentLinkCreateSchema>;

export type ParentLinkStatusDto = {
  guardian_id: string;
  link: {
    id: string;
    created_at: string;
    created_by_name: string | null;
    expires_at: string | null;
    last_seen_at: string | null;
    gate: ParentGate;
    status: 'active' | 'expired' | 'revoked';
  } | null;
  access: { at: string; ip_hash: string | null; ua: string | null }[];
};

/** The URL is returned only by create/rotate; it is never stored in clear. */
export type ParentLinkCreatedDto = ParentLinkStatusDto & { url: string };

export const parentGateInputSchema = z.object({
  birth_year: z.number().int().min(1900).max(2100).optional(),
  pin: z
    .string()
    .regex(/^\d{4,6}$/)
    .optional(),
});

export type ParentDueLineDto = {
  child: string;
  head_name: string;
  head_name_ur: string | null;
  period_key: string;
  due_date: string;
  net: number;
  paid: number;
  due: number;
  status: 'partial' | 'overdue' | 'due';
};

export type ParentChildDto = {
  id: string;
  first_name: string;
  group: string | null;
  today: 'P' | 'A' | 'L' | 'E' | null;
  month: { present: number; absent: number; late: number; excused: number; pct: number | null };
};

export type ParentPageDto = {
  school: { name: string; name_ur: string | null; phone: string | null };
  guardian: { first_name: string; lang: MessageLang };
  date: string;
  gate: { kind: ParentGate; passed: boolean };
  children: ParentChildDto[];
  /** Absent until the gate is passed (when the link has one). */
  dues: {
    lines: ParentDueLineDto[];
    /** Σ due before credit, the family's unallocated credit, and what is left to pay. */
    total_before_credit: number;
    credit: number;
    total: number;
    overdue: number;
  } | null;
  receipts: { id: string; receipt_no: string; amount: number; business_date: string }[] | null;
  notices: { id: string; at: string; body_en: string; body_ur: string }[];
};

export type ParentGateResultDto = { gate_token: string; expires_at: string };
