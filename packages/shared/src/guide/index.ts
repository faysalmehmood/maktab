import { TASKS_A } from './tasks-a';
import { TASKS_B } from './tasks-b';
import type { GuideLang, GuideRole, GuideTask, L } from './types';
import { GUIDE_SECTIONS, GUIDE_UI } from './ui';

export type * from './types';
export { GUIDE_SECTIONS, GUIDE_UI };

/** Every task, in section order (the order of GUIDE_SECTIONS, then the order written). */
export const GUIDE_TASKS: readonly GuideTask[] = GUIDE_SECTIONS.flatMap((s) =>
  [...TASKS_A, ...TASKS_B].filter((t) => t.section === s.id),
);

export const GUIDE_ROLES: readonly GuideRole[] = ['owner', 'admin', 'accountant', 'teacher'];

export const taskById = (id: string): GuideTask | undefined =>
  GUIDE_TASKS.find((t) => t.id === id);

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

/** Split "Press **Save** now" into plain and bold runs (button names are the bold runs). */
export function runs(text: string): { text: string; strong: boolean }[] {
  return text
    .split('**')
    .map((part, i) => ({ text: part, strong: i % 2 === 1 }))
    .filter((r) => r.text.length > 0);
}

export { renderOnboardingMarkdown } from './markdown';
