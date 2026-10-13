// `npm run i18n:check`: is the Urdu UI complete and safe to ship?
//
// Compares every English string with its Urdu twin, by dotted key, across:
//   - the UI dictionaries (`en` in i18n.ts, `ur` in i18n-ur.ts, sub-dictionaries merged in),
//   - the default WhatsApp templates (DEFAULT_TEMPLATES in messaging.ts),
//   - the printed receipt labels (RECEIPT_LABELS in fees.ts),
//   - month names (MONTH_NAMES in messaging.ts).
// It fails (exit 1) on: a key missing or empty in Urdu, an Urdu string identical to the English one
// (unless allowed below), an Urdu key with no English twin, placeholder sets that differ
// ({{x}} and {x}), Arabic-Indic or Extended Arabic-Indic digits in Urdu (we print 0-9 only), and an
// Urdu string with Latin words but no Arabic-script letter at all (English left in by mistake, even
// when it differs from the English twin), unless its words are all technical tokens (LATIN_OK) or
// the key is in ALLOW.

import { RECEIPT_LABELS } from '../packages/shared/src/fees';
import { GUIDE_SECTIONS, GUIDE_TASKS, GUIDE_UI } from '../packages/shared/src/guide';
import { en } from '../packages/shared/src/i18n';
import { screensEn } from '../packages/shared/src/i18n-screens';
import { ur } from '../packages/shared/src/i18n-ur';
import { DEFAULT_TEMPLATES, MONTH_NAMES } from '../packages/shared/src/messaging';

type Tree = { readonly [k: string]: unknown };

/**
 * Keys whose Urdu text is meant to equal the English text. Strings with no Latin letter outside
 * placeholders (e.g. "{{n}}", "%", "{{group}} · {{date}}") are allowed by rule and need no entry.
 */
const ALLOW = new Set<string>([
  // Register letters stay Latin: the paper register and the printed monthly sheet use P/A/L/E.
  'ui.attendance.letter.P',
  'ui.attendance.letter.A',
  'ui.attendance.letter.L',
  'ui.attendance.letter.E',
]);

/** Latin tokens that are fine to leave untranslated (brand, formats, codes, units). */
const LATIN_OK =
  /^(?:Maktab|CNIC|PDF|CSV|JSON|ZIP|WhatsApp|SMS|Rs\.?|PKR|KB|MB|GB|mm|cm|JPEG|PNG|WebP|URL|ID|OK|IBAN|JazzCash|EasyPaisa|Google|[A-Z]\d*|\d+[A-Za-z]*|https?:\/\/\S+)$/;

function flatten(tree: unknown, prefix: string, out: Map<string, string>): Map<string, string> {
  if (typeof tree === 'string') {
    out.set(prefix, tree);
    return out;
  }
  if (Array.isArray(tree)) {
    tree.forEach((v, i) => {
      flatten(v, `${prefix}.${i}`, out);
    });
    return out;
  }
  if (tree && typeof tree === 'object') {
    for (const [k, v] of Object.entries(tree as Tree))
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

const DOUBLE = /\{\{\s*(\w+)\s*\}\}/g;
const SINGLE = /\{(\w+)\}/g;

function placeholders(s: string): string[] {
  const set = new Set<string>();
  for (const m of s.matchAll(DOUBLE)) set.add(`{{${m[1]}}}`);
  for (const m of s.replace(DOUBLE, ' ').matchAll(SINGLE)) set.add(`{${m[1]}}`);
  return [...set].sort();
}

/** True when the string needs no translation: nothing Latin left once placeholders and allowed tokens go. */
function languageNeutral(s: string): boolean {
  const stripped = s.replace(DOUBLE, ' ').replace(SINGLE, ' ');
  if (!/[A-Za-z]/.test(stripped)) return true;
  return stripped
    .split(/[\s,.;:()/·%+\-–—|]+/)
    .filter((w) => /[A-Za-z]/.test(w))
    .every((w) => LATIN_OK.test(w));
}

const NON_LATIN_DIGIT = /[٠-٩۰-۹]/;
/** Arabic-script letters (Arabic, Arabic Supplement, Presentation Forms A/B). */
const ARABIC_LETTER =
  /[\u0620-\u064A\u066E-\u06D3\u06D5\u06FA-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

const enFlat = new Map<string, string>();
const urFlat = new Map<string, string>();
const pairs: [string, unknown, unknown][] = [
  ['ui', { ...en, screens: screensEn }, ur],
  ['templates', DEFAULT_TEMPLATES, null],
  ['receipt', RECEIPT_LABELS.en, RECEIPT_LABELS.ur],
  ['months', MONTH_NAMES.en, MONTH_NAMES.ur],
];
for (const [name, e, u] of pairs) {
  if (u === null) {
    // { key: { en, ur } } — split into the two languages.
    for (const [k, v] of Object.entries(e as Record<string, Record<string, string>>)) {
      enFlat.set(`${name}.${k}`, v.en ?? '');
      if (v.ur !== undefined) urFlat.set(`${name}.${k}`, v.ur);
    }
    continue;
  }
  flatten(e, name, enFlat);
  flatten(u, name, urFlat);
}

// The Help & guide content (packages/shared/src/guide): every { en, ur } pair, by its path. A quoted
// UI label `[[a.b]]` must exist in both dictionaries and appear in both texts: it is compared as the
// placeholder {{a_b}}. A text that is only labels needs no Urdu letters of its own.
const urUi = flatten(ur, '', new Map());
const enUi = flatten({ ...en, screens: screensEn }, '', new Map());
const guideAllowed = new Set<string>();
const unknownLabels: string[] = [];
const LABEL = /\[\[([\w.]+)\]\]/g;
const asPlaceholders = (path: string, s: string) =>
  s.replace(LABEL, (_, k: string) => {
    if (!enUi.has(k) || !urUi.has(k)) unknownLabels.push(`${path}  [[${k}]]`);
    return `{{${k.replace(/\./g, '_')}}}`;
  });
function guidePairs(tree: unknown, prefix: string): void {
  if (!tree || typeof tree !== 'object') return;
  const o = tree as Record<string, unknown>;
  if (typeof o.en === 'string' && typeof o.ur === 'string' && Object.keys(o).length === 2) {
    const e = asPlaceholders(prefix, o.en);
    const u = asPlaceholders(prefix, o.ur);
    enFlat.set(prefix, e);
    urFlat.set(prefix, u);
    if (languageNeutral(e.replace(/\*\*[^*]*\*\*/g, ' '))) guideAllowed.add(prefix);
    return;
  }
  for (const [k, v] of Object.entries(o)) {
    const id = Array.isArray(tree) && v && typeof v === 'object' && 'id' in v ? String(v.id) : k;
    guidePairs(v, `${prefix}.${id}`);
  }
}
guidePairs({ ui: GUIDE_UI, sections: GUIDE_SECTIONS, tasks: GUIDE_TASKS }, 'guide');
for (const k of guideAllowed) ALLOW.add(k);

const problems: Record<string, string[]> = {
  missing: [],
  empty: [],
  untranslated: [],
  extra: [],
  placeholders: [],
  digits: [],
  latinOnly: [],
  unknownLabels,
};

for (const [key, enText] of enFlat) {
  const urText = urFlat.get(key);
  if (urText === undefined) {
    problems.missing.push(`${key}  (en: ${JSON.stringify(enText)})`);
    continue;
  }
  if (urText.trim() === '') {
    problems.empty.push(`${key}  (en: ${JSON.stringify(enText)})`);
    continue;
  }
  if (urText === enText && !ALLOW.has(key) && !languageNeutral(enText)) {
    problems.untranslated.push(`${key}  = ${JSON.stringify(enText)}`);
  }
  const pe = placeholders(enText).join(' ');
  const pu = placeholders(urText).join(' ');
  if (pe !== pu) problems.placeholders.push(`${key}  en [${pe}]  ur [${pu}]`);
}
for (const [key, urText] of urFlat) {
  if (!enFlat.has(key)) problems.extra.push(key);
  if (NON_LATIN_DIGIT.test(urText)) problems.digits.push(`${key}  = ${JSON.stringify(urText)}`);
  if (!ARABIC_LETTER.test(urText) && !ALLOW.has(key) && !languageNeutral(urText))
    problems.latinOnly.push(`${key}  = ${JSON.stringify(urText)}`);
}

const labels: Record<string, string> = {
  missing: 'Missing in ur',
  empty: 'Empty in ur',
  untranslated: 'Identical to English in ur (translate, or add to ALLOW with a reason)',
  extra: 'In ur but not in en',
  placeholders: 'Placeholder mismatch',
  digits: 'Arabic-Indic digits in ur (use 0-9)',
  latinOnly: 'No Urdu letters in ur (translate, or add to ALLOW / LATIN_OK if purely technical)',
  unknownLabels: 'Guide quotes a [[label]] missing from the en or ur dictionary',
};

const total = Object.values(problems).reduce((n, list) => n + list.length, 0);
if (total > 0) {
  for (const [cat, list] of Object.entries(problems)) {
    if (!list.length) continue;
    console.error(`\n${labels[cat]}: ${list.length}`);
    for (const line of list) console.error(`  ${line}`);
  }
  console.error(`\ni18n:check: ${total} problem(s) across ${enFlat.size} keys`);
  process.exit(1);
}
console.log(`i18n:check: ${enFlat.size} keys, ur complete`);
