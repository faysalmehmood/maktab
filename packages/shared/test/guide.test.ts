import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GUIDE_ROLES,
  GUIDE_SECTIONS,
  GUIDE_TASKS,
  GUIDE_UI,
  type L,
  renderOnboardingMarkdown,
  runs,
  say,
  taskById,
  tasksFor,
} from '../src/guide';
import { en } from '../src/i18n';
import { screensEn } from '../src/i18n-screens';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every { en, ur } pair in the content, with a readable path. */
function pairs(): [string, L][] {
  const out: [string, L][] = [];
  const walk = (v: unknown, path: string) => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if ('en' in o && 'ur' in o && Object.keys(o).length === 2) {
      out.push([path, o as unknown as L]);
      return;
    }
    for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`);
  };
  walk({ ui: GUIDE_UI, sections: GUIDE_SECTIONS, tasks: GUIDE_TASKS }, 'guide');
  return out;
}

/** Every English UI label (the button names the guide may quote). */
const UI_LABELS = (() => {
  const set = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') set.add(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(en);
  walk(screensEn);
  return set;
})();

/**
 * Bold names that are not Maktab labels: Chrome's own menu items, the import button's count form,
 * and role names / tab names written as the UI shows them.
 */
const NOT_OURS = new Set([
  'Add to Home screen',
  'Install app',
  'Save as PDF',
  'Import N students',
  'Present',
]);

describe('guide content', () => {
  it('has unique task ids, known sections and roles, and every section has tasks', () => {
    const ids = GUIDE_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of GUIDE_TASKS) {
      expect(GUIDE_SECTIONS.map((s) => s.id)).toContain(t.section);
      expect(t.roles.length).toBeGreaterThan(0);
      for (const r of t.roles) expect(GUIDE_ROLES).toContain(r);
      expect(t.steps.length).toBeGreaterThan(0);
    }
    for (const s of GUIDE_SECTIONS) expect(GUIDE_TASKS.some((t) => t.section === s.id)).toBe(true);
    expect(GUIDE_TASKS.length).toBeGreaterThanOrEqual(24);
  });

  it('has every text in English and Urdu, Latin digits only, placeholders matching', () => {
    const list = pairs();
    expect(list.length).toBeGreaterThan(300);
    for (const [path, l] of list) {
      expect(l.en.trim(), path).not.toBe('');
      expect(l.ur.trim(), path).not.toBe('');
      expect(/[٠-٩۰-۹]/.test(l.ur), `${path} has Arabic-Indic digits`).toBe(false);
      const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
      expect(ph(l.ur), path).toEqual(ph(l.en));
      // Urdu is Urdu, unless the whole text is an English button name the screen shows.
      if (!UI_LABELS.has(l.ur)) expect(/[؀-ۿ]/.test(l.ur), `${path}: ${l.ur}`).toBe(true);
    }
  });

  it('quotes button names exactly as the app shows them, the same in both languages', () => {
    for (const [path, l] of pairs()) {
      const enBold = runs(l.en)
        .filter((r) => r.strong)
        .map((r) => r.text);
      const urBold = runs(l.ur)
        .filter((r) => r.strong)
        .map((r) => r.text);
      for (const b of enBold)
        expect(UI_LABELS.has(b) || NOT_OURS.has(b), `${path}: **${b}** is not a UI label`).toBe(
          true,
        );
      // Urdu keeps the English button names (they are English on the screen).
      for (const b of urBold) expect(enBold, `${path}: **${b}** only in Urdu`).toContain(b);
    }
  });

  it('gives each role its own trimmed list', () => {
    const ids = (r: string) => tasksFor([r]).map((t) => t.id);
    expect(ids('owner')).toContain('backups');
    expect(ids('owner')).toContain('first-week');
    expect(ids('admin')).not.toContain('backups');
    expect(ids('teacher')).toEqual(
      expect.arrayContaining(['take-attendance', 'send-messages', 'my-payslips', 'offline']),
    );
    expect(ids('teacher')).not.toContain('collect-fee');
    expect(ids('teacher')).not.toContain('first-week');
    expect(ids('accountant')).toEqual(
      expect.arrayContaining(['collect-fee', 'close-cash', 'defaulters', 'income-expense']),
    );
    expect(ids('accountant')).not.toContain('generate-fees');
    expect(ids('accountant')).not.toContain('take-attendance');
    for (const r of GUIDE_ROLES) expect(ids(r).length).toBeGreaterThan(4);
  });

  it('has well-formed tours: targets are data-tour names, paths are app routes', () => {
    let steps = 0;
    for (const t of GUIDE_TASKS)
      for (const s of t.tour ?? []) {
        steps++;
        expect(s.target, t.id).toMatch(/^[a-z0-9-]+$/);
        if (s.path) expect(s.path, t.id).toMatch(/^\/[a-zA-Z0-9/:-]*$/);
      }
    expect(steps).toBeGreaterThanOrEqual(40);
  });

  it('fills placeholders and splits bold runs', () => {
    expect(say(GUIDE_UI.counter, 'en', { i: 2, n: 5 })).toBe('Step 2 of 5');
    expect(say(GUIDE_UI.counter, 'ur', { i: 2, n: 5 })).toBe('قدم 2 از 5');
    expect(runs('Press **Save** now')).toEqual([
      { text: 'Press ', strong: false },
      { text: 'Save', strong: true },
      { text: ' now', strong: false },
    ]);
    expect(taskById('collect-fee')?.section).toBe('office');
    expect(taskById('nope')).toBeUndefined();
  });
});

describe('docs:guide (docs/onboarding.md from the guide content)', () => {
  it('is deterministic and covers every task in both languages', () => {
    const a = renderOnboardingMarkdown();
    expect(renderOnboardingMarkdown()).toBe(a);
    for (const t of GUIDE_TASKS) {
      expect(a).toContain(t.title.en);
      expect(a).toContain(t.title.ur);
      for (const s of t.steps) {
        expect(a).toContain(s.text.en);
        expect(a).toContain(s.text.ur);
      }
    }
  });

  it('matches the committed docs/onboarding.md (run `npm run docs:guide` after editing)', () => {
    expect(readFileSync(join(root, 'docs', 'onboarding.md'), 'utf8')).toBe(
      renderOnboardingMarkdown(),
    );
  });

  it('the script is idempotent and --check passes on the committed file', () => {
    const run = (...args: string[]) =>
      execFileSync('npx', ['tsx', 'scripts/docs-guide.ts', ...args], {
        cwd: root,
        encoding: 'utf8',
      });
    expect(run()).toContain('unchanged');
    expect(run('--check')).toContain('up to date');
  });
});
