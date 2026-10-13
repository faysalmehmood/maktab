/**
 * The fixed (non-school) colour tokens of `apps/web/src/styles.css`, light and dark (M7b, UI plan
 * §5.1–5.2). Status colours never follow the school colour. Kept here so `brand.test` can assert
 * contrast and the web test can pin styles.css to these values. Nothing at runtime imports this.
 *
 * - `ok|bad|warn|info`: the strong text tone (on the card and on its own soft background).
 * - `*Soft`: the badge background.
 * - `*Solid` + `onSolid`: a solid fill with white text (the register's current mark, the
 *   destructive button). The same fills in both themes: they are read in sunlight on a cheap
 *   screen and must not wash out in dark mode either.
 * - `input`: the border of text fields and selects, ≥ 3:1 against the card (WCAG 1.4.11).
 */
export const STATUS_TOKENS = {
  light: {
    card: '#ffffff',
    background: '#f3f6f5',
    foreground: '#14211f',
    mutedForeground: '#586966',
    input: '#7d8e8a',
    ok: '#19704a',
    okSoft: '#e1f3e8',
    bad: '#b23a2e',
    badSoft: '#fbe8e5',
    warn: '#875800',
    warnSoft: '#fbeed2',
    info: '#2a5d9c',
    infoSoft: '#e5eef9',
    okSolid: '#19704a',
    badSolid: '#b23a2e',
    warnSolid: '#a34a06',
    infoSolid: '#2a5d9c',
    onSolid: '#ffffff',
  },
  dark: {
    card: '#151f1e',
    background: '#0c1413',
    foreground: '#e6efed',
    mutedForeground: '#93a5a1',
    input: '#62746f',
    ok: '#5fcf97',
    okSoft: '#12301f',
    bad: '#f08a7e',
    badSoft: '#3a1a16',
    warn: '#e8b75a',
    warnSoft: '#33270d',
    info: '#8db8ee',
    infoSoft: '#14263d',
    okSolid: '#19704a',
    badSolid: '#b23a2e',
    warnSolid: '#a34a06',
    infoSolid: '#2a5d9c',
    onSolid: '#ffffff',
  },
} as const;

/** CSS custom property for a token key ("okSoft" → "--ok-soft"). */
export const tokenVar = (key: string): string =>
  `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
