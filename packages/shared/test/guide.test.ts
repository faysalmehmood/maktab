import { describe, expect, it } from 'vitest';
import {
  GUIDE_ROLES,
  GUIDE_SECTIONS,
  GUIDE_TASKS,
  GUIDE_UI,
  type L,
  labelKeys,
  lookup,
  plain,
  runs,
  say,
  taskById,
  tasksFor,
} from '../src/guide';
import { BEFORE_YOU_START, md, renderOnboardingMarkdown } from '../src/guide/markdown';
import { en } from '../src/i18n';
import { screensEn } from '../src/i18n-screens';
import { ur } from '../src/i18n-ur';
import { strayLatin } from '../src/latin';

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

const EN = { ...en, screens: screensEn };

/** Bold names that are not Maktab's labels (Chrome's own menu and print window). */
const NOT_OURS = new Set(['Add to Home screen', 'Install app', 'Save as PDF', 'Default', 'None']);

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
      // Urdu is Urdu, unless the whole text is quoted labels (resolved from the Urdu dictionary).
      const own = l.ur.replace(/\[\[[\w.]+\]\]/g, '').replace(/[\s،۔.,:←()]/g, '');
      if (own) expect(/[\u0600-\u06FF]/.test(own), `${path}: ${l.ur}`).toBe(true);
    }
  });

  it('quotes button names from the UI dictionaries, the same ones in both languages', () => {
    let quoted = 0;
    for (const [path, l] of pairs()) {
      const ke = labelKeys(l.en);
      const ku = labelKeys(l.ur);
      quoted += ke.length;
      expect([...ku].sort(), `${path}: labels differ between en and ur`).toEqual([...ke].sort());
      for (const k of ke) {
        expect(lookup(EN, k), `${path}: [[${k}]] not in en`).toBeTypeOf('string');
        expect(lookup(ur, k), `${path}: [[${k}]] not in ur`).toBeTypeOf('string');
      }
      for (const lang of ['en', 'ur'] as const)
        for (const r of runs(l[lang]))
          if (r.kind === 'strong')
            expect(NOT_OURS.has(r.text), `${path}: **${r.text}** should be a [[label]]`).toBe(true);
    }
    expect(quoted).toBeGreaterThan(100);
    // Each language quotes its own screen: the Urdu doc shows the Urdu button.
    expect(md('Press [[attendance.save]].', 'en')).toBe('Press **Save attendance**.');
    expect(md('Press [[attendance.save]].', 'ur')).toBe(
      `Press **${lookup(ur, 'attendance.save')}**.`,
    );
    expect(md('[[import.commit_other]]', 'en')).toBe('**Import N students**');
  });

  it('gives each role its own trimmed list', () => {
    const ids = (r: string) => tasksFor([r]).map((t) => t.id);
    expect(ids('owner')).toContain('backups');
    expect(ids('owner')).toContain('first-week');
    expect(ids('admin')).not.toContain('backups');
    // Only an owner can run setup or invite staff.
    expect(ids('admin')).not.toContain('first-week');
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

  it("writes Urdu in Urdu: the app's own words, right-to-left arrows, no stray English", () => {
    const all: [string, L][] = [
      ...pairs(),
      ...BEFORE_YOU_START.map((l, i): [string, L] => [`before.${i}`, l]),
    ];
    // Labels resolve from the Urdu dictionary; **…** is Chrome's own menu; `…` is code.
    const own = (s: string) =>
      s
        .replace(/\[\[[\w.]+\]\]/g, ' ')
        .replace(/\*\*[^*]+\*\*/g, ' ')
        .replace(/`[^`]+`/g, ' ');
    for (const [path, l] of all) {
      expect(strayLatin(own(l.ur)), `${path}: ${l.ur}`).toEqual([]);
      expect(l.ur, `${path}: Urdu paths read right to left`).not.toContain('→');
      // One vocabulary: the words the Urdu screens use (منتظم, جماعت, نرخ, سابقہ, تاخیر).
      expect(l.ur, path).not.toMatch(/ایڈمن|ریٹ|پری فکس|لیٹ|کلاس(?! ٹیچر)|چھٹی/);
      // English names a button by its label, never by a bare word the screen does not show.
      expect(own(l.en), path).not.toMatch(
        /\b(?:tap|press|then) (?:Sent|Print)\b|\bsays? (?:OK|Saved)\b/,
      );
    }
  });

  it('fills placeholders and splits bold runs', () => {
    expect(say(GUIDE_UI.counter, 'en', { i: 2, n: 5 })).toBe('Step 2 of 5');
    expect(say(GUIDE_UI.counter, 'ur', { i: 2, n: 5 })).toBe('قدم 2 از 5');
    expect(runs('Press [[attendance.save]] or **Install app** in `ANS`')).toEqual([
      { text: 'Press ', kind: 'plain' },
      { text: 'attendance.save', kind: 'label' },
      { text: ' or ', kind: 'plain' },
      { text: 'Install app', kind: 'strong' },
      { text: ' in ', kind: 'plain' },
      { text: 'ANS', kind: 'code' },
    ]);
    expect(plain('Tap [[attendance.save]].', (k) => k.toUpperCase())).toBe('Tap ATTENDANCE.SAVE.');
    expect(taskById('collect-fee')?.section).toBe('office');
    expect(taskById('nope')).toBeUndefined();
  });
});

describe('docs:guide (docs/onboarding.md from the guide content)', () => {
  it('is deterministic and covers every task in both languages', () => {
    const a = renderOnboardingMarkdown();
    expect(renderOnboardingMarkdown()).toBe(a);
    for (const t of GUIDE_TASKS) {
      expect(a).toContain(md(t.title.en, 'en'));
      expect(a).toContain(md(t.title.ur, 'ur'));
      for (const s of t.steps) {
        expect(a).toContain(md(s.text.en, 'en'));
        expect(a).toContain(md(s.text.ur, 'ur'));
      }
    }
  });
});
