import { TASKS_A } from './tasks-a';
import { TASKS_B } from './tasks-b';
import type { GuideLang, GuideRole, GuideTask, L } from './types';
import { GUIDE_SECTIONS, GUIDE_UI } from './ui';

export type * from './types';
export { GUIDE_SECTIONS, GUIDE_UI };

/*
 * The app imports this module (lazily) for the guide pages and tours. The markdown generator lives
 * in ./markdown (it needs the Urdu dictionary, which must stay out of the guide chunk).
 */

/** Every task, in section order (the order of GUIDE_SECTIONS, then the order written). */
export const GUIDE_TASKS: readonly GuideTask[] = GUIDE_SECTIONS.flatMap((s) =>
  [...TASKS_A, ...TASKS_B].filter((t) => t.section === s.id),
);

export const GUIDE_ROLES: readonly GuideRole[] = ['owner', 'admin', 'accountant', 'teacher'];

export const taskById = (id: string): GuideTask | undefined => GUIDE_TASKS.find((t) => t.id === id);

/** May someone with these roles open this task? */
export const taskFor = (task: GuideTask, roles: readonly string[]): boolean =>
  task.roles.some((r) => roles.includes(r));

/** The tasks a set of roles sees, in order. */
export const tasksFor = (roles: readonly string[]): GuideTask[] =>
  GUIDE_TASKS.filter((t) => taskFor(t, roles));

/** The text in a language, with {{x}} filled in. */
export function say(l: L, lang: GuideLang, vars: Record<string, string | number> = {}): string {
  return l[lang].replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/**
 * A guide text in runs: plain text, `**bold**` (a label that is not Maktab's, e.g. Chrome's menu)
 * and `[[i18n.key]]` (a Maktab button or screen name, looked up in the UI's own dictionary so each
 * language quotes exactly what its screen shows). Code spans in backticks are kept as `code`.
 */
export type Run = { text: string; kind: 'plain' | 'strong' | 'label' | 'code' };

const RUN = /\[\[([\w.]+)\]\]|\*\*([^*]+)\*\*|`([^`]+)`/g;

export function runs(text: string): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const m of text.matchAll(RUN)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), kind: 'plain' });
    if (m[1]) out.push({ text: m[1], kind: 'label' });
    else if (m[2]) out.push({ text: m[2], kind: 'strong' });
    else if (m[3]) out.push({ text: m[3], kind: 'code' });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: 'plain' });
  return out;
}

/** The i18n keys a text quotes. */
export const labelKeys = (text: string): string[] =>
  runs(text)
    .filter((r) => r.kind === 'label')
    .map((r) => r.text);

/** Vars for a quoted label with a count ("Import N students"). */
export const LABEL_VARS = { count: 'N', n: 'N' } as const;

/** Look a dotted key up in a nested dictionary (undefined when missing or not a string). */
export function lookup(dict: unknown, key: string): string | undefined {
  let v: unknown = dict;
  for (const part of key.split('.')) {
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return typeof v === 'string' ? v : undefined;
}

/** A text with labels resolved (`resolve(key)`), bold and code marks dropped: plain text. */
export function plain(text: string, resolve: (key: string) => string): string {
  return runs(text)
    .map((r) => (r.kind === 'label' ? resolve(r.text) : r.text))
    .join('');
}
