import { describe, expect, it } from 'vitest';
import {
  BRAND_COLOR_KEYS,
  BRAND_COLORS,
  badgeFontSize,
  badgeLetters,
  badgeSvg,
  brandColor,
  contrastRatio,
  STATUS_TOKENS,
  schoolInputSchema,
  suggestShortName,
} from '../src';

// M7b (UI plan §6.2–6.3): the generated badge and the curated colours.

const contrast = contrastRatio;

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

describe('status tokens and the destructive button (light + dark)', () => {
  const tones = ['ok', 'bad', 'warn', 'info'] as const;
  for (const theme of ['light', 'dark'] as const) {
    const k = STATUS_TOKENS[theme];
    it(`${theme}: each status reads as text on the card and on its own soft badge`, () => {
      for (const s of tones) {
        expect(contrast(k[s], k.card), `${s} on card`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(k[s], k.background), `${s} on page`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(k[s], k[`${s}Soft`]), `${s} on ${s}Soft`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(k.mutedForeground, k.card), 'muted text').toBeGreaterThanOrEqual(4.5);
      expect(contrast(k.foreground, k.card), 'body text').toBeGreaterThanOrEqual(7);
    });
    it(`${theme}: solid fills (register mark, destructive button) carry white text ≥ 4.5:1`, () => {
      for (const s of tones)
        expect(contrast(k[`${s}Solid`], k.onSolid), `${s} solid`).toBeGreaterThanOrEqual(4.5);
      // The destructive variant is bg-bad-solid + text-on-solid (ui/button.tsx).
      expect(contrast(k.badSolid, k.onSolid), 'destructive').toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: the input border is ≥ 3:1 against the card and the page`, () => {
      expect(contrast(k.input, k.card)).toBeGreaterThanOrEqual(3);
      expect(contrast(k.input, k.background)).toBeGreaterThanOrEqual(3);
    });
  }
});
