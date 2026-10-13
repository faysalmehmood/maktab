import { type BrandColor, brandColor } from '@maktab/shared';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Light / dark theme and the school colour on <html> (M7b, UI plan §5.2). The theme follows the
 * phone's setting unless someone picks one in the account menu; that choice is remembered per
 * device (`maktab.theme`). The last school colour seen is kept too (`maktab.brand`) so a reload does
 * not flash teal before /api/school answers. Both are conveniences: storage may be unavailable.
 */
export const THEME_KEY = 'maktab.theme';
export const BRAND_KEY = 'maktab.brand';
export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemePref = (typeof THEMES)[number];

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: the choice lasts until reload.
  }
}

let pref: ThemePref = 'system';

const systemDark = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export const resolvedTheme = (p: ThemePref = pref): 'light' | 'dark' =>
  p === 'system' ? (systemDark() ? 'dark' : 'light') : p;

function apply(): void {
  const dark = resolvedTheme() === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  // The browser chrome follows the page (address bar on Android).
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--side').trim();
    if (bg) meta.setAttribute('content', bg);
  }
}

export const getThemePref = (): ThemePref => pref;

export function setThemePref(next: ThemePref): void {
  pref = next;
  write(THEME_KEY, next);
  apply();
  emit();
}

/** Once, before the first render: the saved choice, and a listener for the system setting. */
export function initTheme(): void {
  const saved = read(THEME_KEY);
  pref = (THEMES as readonly string[]).includes(saved ?? '') ? (saved as ThemePref) : 'system';
  const savedBrand = read(BRAND_KEY);
  if (savedBrand) setBrand(savedBrand, false);
  apply();
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', () => {
      if (pref === 'system') {
        apply();
        emit();
      }
    });
  }
}

/** The school colour (a curated key; anything else is teal). `remember` keeps it for next load. */
export function setBrand(color: string | null | undefined, remember = true): BrandColor {
  const key = brandColor(color);
  const root = document.documentElement;
  if (key === 'teal') root.removeAttribute('data-brand');
  else root.setAttribute('data-brand', key);
  if (remember) write(BRAND_KEY, key);
  apply();
  return key;
}

export function useThemePref(): [ThemePref, 'light' | 'dark'] {
  const p = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pref,
  );
  return [p, resolvedTheme(p)];
}

/** Paint the shell in this school's colour while mounted (null = keep the current one). */
export function useBrand(color: string | null | undefined): void {
  useEffect(() => {
    if (color !== undefined) setBrand(color);
  }, [color]);
}
