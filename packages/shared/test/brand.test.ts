import { describe, expect, it } from 'vitest';
import {
  BRAND_COLOR_KEYS,
  BRAND_COLORS,
  badgeFontSize,
  badgeLetters,
  badgeSvg,
  brandColor,
  schoolInputSchema,
  suggestShortName,
} from '../src';

// M7b (UI plan §6.2–6.3): the generated badge and the curated colours.

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
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

describe('school badge', () => {
  it('suggests 2–3 initials from the name, skipping small words', () => {
    expect(suggestShortName('Global Science Academy')).toBe('GSA');
    expect(suggestShortName('Al-Noor Community School')).toBe('ANC');
    expect(suggestShortName('Academy of Science')).toBe('AS');
    expect(suggestShortName('Maktab')).toBe('MA');
    expect(suggestShortName('The City School of Lahore Pakpattan')).toBe('CSL');
    expect(suggestShortName('گلوبل سائنس اکیڈمی')).toBe('');
    for (const n of ['Global Science Academy', 'Al-Noor', 'Iqra Model High School', 'Maktab'])
      expect(suggestShortName(n).length).toBeGreaterThanOrEqual(2);
  });

  it('draws the saved short name, else the initials, else "M"', () => {
    expect(badgeLetters('gsa', 'Whatever')).toBe('GSA');
    expect(badgeLetters(null, 'Al-Noor')).toBe('AN');
    expect(badgeLetters('', 'گلوبل')).toBe('M');
    expect(badgeLetters('ABCDE')).toBe('ABCD');
    expect(badgeFontSize('AN')).toBeGreaterThan(badgeFontSize('GSA'));
    expect(badgeFontSize('GSA')).toBeGreaterThan(badgeFontSize('ABCD'));
  });

  it('is an SVG roundel in the school colour, teal by default, with escaped text', () => {
    const svg = badgeSvg({ shortName: 'GSA', color: 'blue', name: 'Global <Science>' });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('>GSA</text>');
    expect(svg.match(/#1e40af/g)?.length).toBe(2); // ring + letters
    expect(svg).toContain('aria-label="Global &#60;Science&#62;"');
    expect(badgeSvg({ name: 'Al-Noor' })).toContain(BRAND_COLORS.teal.light.brand);
    expect(badgeSvg({ name: 'X', color: '#ff0000' })).toContain(BRAND_COLORS.teal.light.brand);
  });

  it('every curated colour reads as a button and as text, in light and dark', () => {
    expect(BRAND_COLOR_KEYS).toEqual(['teal', 'blue', 'maroon', 'purple', 'green']);
    for (const k of BRAND_COLOR_KEYS) {
      const { light, dark } = BRAND_COLORS[k];
      expect(contrast(light.brand, light.fg), `${k} button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(light.brand, '#ffffff'), `${k} text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark.brand, dark.fg), `${k} dark button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark.brand, '#151f1e'), `${k} dark text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#ffffff', light.side), `${k} sidebar`).toBeGreaterThanOrEqual(7);
    }
    expect(brandColor('nope')).toBe('teal');
  });

  it('the school form accepts only curated colours and 1–4 letter short names', () => {
    const base = { name: 'GSA', mode: 'school' as const };
    expect(schoolInputSchema.parse({ ...base, short_name: 'gsa' }).short_name).toBe('GSA');
    expect(schoolInputSchema.parse({ ...base, short_name: '' }).short_name).toBeNull();
    expect(schoolInputSchema.parse(base).short_name).toBeUndefined();
    expect(schoolInputSchema.safeParse({ ...base, short_name: 'G S' }).success).toBe(false);
    expect(schoolInputSchema.safeParse({ ...base, brand_color: 'pink' }).success).toBe(false);
    expect(schoolInputSchema.parse({ ...base, brand_color: 'maroon' }).brand_color).toBe('maroon');
  });
});
