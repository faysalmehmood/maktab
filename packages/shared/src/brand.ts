/**
 * School identity (M7b, UI plan §6): the curated accent colours and the generated badge. The school
 * is in front, Maktab behind: every installation has a badge from the first minute, drawn from its
 * short name and colour until a logo is uploaded. No zod here: the sign-in page and the shell import
 * this in the first-load bundle.
 */

/**
 * The curated set (§6.3, PLAN decision 2026-10-13): a key, never a free hex value. Each colour is
 * pre-tested as a button background with its `fg` text and as text on the surface (≥ 4.5:1), with
 * a dark-theme twin and the sidebar tones. Status colours never follow the school colour.
 */
export const BRAND_COLORS = {
  teal: {
    light: {
      brand: '#0f766e',
      fg: '#ffffff',
      soft: '#e1f0ed',
      side: '#0d2b28',
      on: '#1a443f',
      mut: '#7fa39c',
    },
    dark: {
      brand: '#3fb8ab',
      fg: '#05201d',
      soft: '#15332f',
      side: '#081110',
      on: '#17302c',
      mut: '#6f8d87',
    },
  },
  blue: {
    light: {
      brand: '#1e40af',
      fg: '#ffffff',
      soft: '#e3eafc',
      side: '#0f1c3f',
      on: '#1d3167',
      mut: '#8a9cc9',
    },
    dark: {
      brand: '#93b4ff',
      fg: '#07153a',
      soft: '#17254a',
      side: '#070d1d',
      on: '#152346',
      mut: '#6f81ad',
    },
  },
  maroon: {
    light: {
      brand: '#8a1c2b',
      fg: '#ffffff',
      soft: '#f8e6e8',
      side: '#2e0c12',
      on: '#4d1620',
      mut: '#c59aa1',
    },
    dark: {
      brand: '#f2a0aa',
      fg: '#33070d',
      soft: '#3a151b',
      side: '#16070a',
      on: '#3a1219',
      mut: '#a37980',
    },
  },
  purple: {
    light: {
      brand: '#5b3aa8',
      fg: '#ffffff',
      soft: '#ece6f8',
      side: '#1d1338',
      on: '#32225c',
      mut: '#a99bcf',
    },
    dark: {
      brand: '#c0a9f5',
      fg: '#1a0d3a',
      soft: '#261b45',
      side: '#0e091c',
      on: '#281c4a',
      mut: '#8778ad',
    },
  },
  green: {
    light: {
      brand: '#166534',
      fg: '#ffffff',
      soft: '#e2f2e7',
      side: '#0b2415',
      on: '#153b24',
      mut: '#8fb59c',
    },
    dark: {
      brand: '#7fd6a0',
      fg: '#062111',
      soft: '#143120',
      side: '#06130b',
      on: '#12301d',
      mut: '#6f957c',
    },
  },
} as const;

export type BrandColor = keyof typeof BRAND_COLORS;
export const BRAND_COLOR_KEYS = Object.keys(BRAND_COLORS) as BrandColor[];
/** Maktab teal: the product default, used when a school has not picked a colour. */
export const DEFAULT_BRAND_COLOR: BrandColor = 'teal';

export const isBrandColor = (v: unknown): v is BrandColor =>
  typeof v === 'string' && Object.hasOwn(BRAND_COLORS, v);
export const brandColor = (v: string | null | undefined): BrandColor =>
  isBrandColor(v) ? v : DEFAULT_BRAND_COLOR;

/** Short names are Latin letters and digits, up to 4 (badge, browser tab, phone icon). */
export const SHORT_NAME_MAX = 4;
export const SHORT_NAME_RE = /^[A-Za-z0-9]{1,4}$/;

/** Small words that do not earn a letter in the initials ("Academy of Science" → "AS"). */
const SKIP = new Set(['of', 'the', 'and', 'for', 'in', 'a', 'an', '&']);

/**
 * Initials suggested from a school name: 2–3 letters. Several words give their first letters
 * ("Global Science Academy" → "GSA"); one word gives its first two letters ("Maktab" → "MA").
 * Only Latin letters and digits count, so an Urdu-only name gives "" (the caller falls back).
 */
export function suggestShortName(name: string | null | undefined): string {
  const words = (name ?? '')
    .split(/[\s\-–—_.,/]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter((w) => w && !SKIP.has(w.toLowerCase()));
  if (words.length === 0) return '';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** The letters a badge shows: the saved short name, else initials of the name, else "M". */
export function badgeLetters(shortName: string | null | undefined, name?: string | null): string {
  const s = (shortName ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (s) return s.slice(0, SHORT_NAME_MAX);
  return suggestShortName(name) || 'M';
}

/** Font size in the 64-unit badge box: fewer letters, bigger type. */
export const badgeFontSize = (letters: string): number =>
  letters.length <= 2 ? 23 : letters.length === 3 ? 18 : 14;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The generated badge as a standalone SVG document (the parent page loads it from /api/p/badge,
 * and print uses the same drawing): a white roundel, a ring and the letters in the school colour.
 * Flat colour only, like the Maktab mark. Letters are restricted to [A-Z0-9] and escaped anyway.
 */
export function badgeSvg(opts: {
  shortName?: string | null;
  name?: string | null;
  color?: string | null;
  label?: string;
}): string {
  const letters = badgeLetters(opts.shortName, opts.name);
  const col = BRAND_COLORS[brandColor(opts.color)].light.brand;
  const label = esc(opts.label ?? opts.name ?? letters);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${label}">` +
    `<circle cx="32" cy="32" r="31" fill="#fff"/>` +
    `<circle cx="32" cy="32" r="26.5" fill="none" stroke="${col}" stroke-width="2.5"/>` +
    `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-weight="700" ` +
    `font-size="${badgeFontSize(letters)}" fill="${col}">${esc(letters)}</text></svg>`
  );
}

/**
 * True when the badge needs a typed short name: the school name has no Latin letters or digits to
 * draw initials from (an Urdu-only name), and none was given. The wizard and Settings ask for one
 * instead of letting the badge fall back to "M".
 */
export const needsShortName = (name: string | null | undefined, shortName?: string | null) =>
  !(shortName ?? '').replace(/[^A-Za-z0-9]/g, '') &&
  suggestShortName(name) === '' &&
  !!name?.trim();
