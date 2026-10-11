import {
  formatDmy,
  hasGrant,
  joinNames,
  type MessageCountsDto,
  type MessageLang,
  monthLabel,
  parentLinkUrl,
  type StaffRole,
  type TemplateVars,
  wasFor,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { getJson } from './api';

export const canReadMessages = (r: readonly StaffRole[]) => hasGrant(r, 'message', 'read');
export const canSendMessages = (r: readonly StaffRole[]) => hasGrant(r, 'message', 'send');
export const canCompose = (r: readonly StaffRole[]) => hasGrant(r, 'message', 'compose');
export const canManageTemplates = (r: readonly StaffRole[]) => hasGrant(r, 'template', 'manage');
/** Parent links hang off the guardian record: whoever writes students manages them. */
export const canManageLinks = (r: readonly StaffRole[]) => hasGrant(r, 'student', 'write');

export const countsKey = ['message-counts'] as const;

export const useMessageCounts = (enabled = true) =>
  useQuery({
    queryKey: countsKey,
    queryFn: () => getJson<MessageCountsDto>('/api/messages/counts'),
    enabled,
  });

const SAMPLE_NAMES: Record<MessageLang, string[]> = {
  en: ['Ahmed', 'Fatima'],
  ur: ['احمد', 'فاطمہ'],
};

/** A link-shaped sample (43 characters like a real token) for previews. */
export const SAMPLE_LINK_TOKEN = 'Xk3f9Qa2LmNpXk3f9Qa2LmNpXk3f9Qa2LmNpXk3f9Qa';

/** The values a preview fills in: the same samples the API's preview endpoint uses. */
export function sampleVars(lang: MessageLang, school: string, today: string): TemplateVars {
  const names = SAMPLE_NAMES[lang];
  const origin = typeof location !== 'undefined' ? location.origin : 'https://school.example';
  return {
    child: names[0] ?? '',
    children: joinNames(names, lang),
    was: wasFor(names.length, lang),
    date: formatDmy(today),
    amount: 'Rs 8,000',
    month: monthLabel(today, lang),
    receipt_no: 'R-2026-00042',
    school,
    body: lang === 'ur' ? 'پیر کو اسکول بند رہے گا۔' : 'School is closed on Monday.',
    link: parentLinkUrl(origin, SAMPLE_LINK_TOKEN),
  };
}

/**
 * Clipboard write that never throws: false when the browser refuses (http, old WebView, denied
 * permission) so the caller can show the text for a manual copy instead.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** `2026-10-11T09:30:00Z` → `11/10/2026 14:30` in Pakistan time, Latin digits. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pk = new Date(d.getTime() + 5 * 3600_000).toISOString();
  return `${formatDmy(pk.slice(0, 10))} ${pk.slice(11, 16)}`;
}

/** Splits a text into plain runs and URLs, so URLs can be isolated as LTR inside Urdu. */
export function splitLinks(text: string): { text: string; url: boolean }[] {
  const out: { text: string; url: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), url: false });
    out.push({ text: m[0], url: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), url: false });
  return out;
}

/**
 * Puts a data value (a name) into a translated sentence: the sentence is rendered with a marker in
 * place of {{name}}, then split, so the caller can wrap the value in <bdi>.
 */
export const MARK = '\u0001';
export function splitAt(sentence: string): [string, string] {
  const i = sentence.indexOf(MARK);
  return i < 0 ? [sentence, ''] : [sentence.slice(0, i), sentence.slice(i + MARK.length)];
}
