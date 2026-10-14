import { describe, expect, it } from 'vitest';
import { dateTime, longDate, monthLabel, monthName, shortDate } from '@/lib/dates';

describe('date formatting never throws on a malformed stored value', () => {
  it('formats good values', () => {
    expect(shortDate('2026-10-14', 'en')).toBe('14 Oct 2026');
    expect(monthLabel('2026-10', 'en')).toBe('Oct 2026');
  });

  it('shows a bad value as stored', () => {
    for (const bad of ['', 'not a date', '2026-13-45', '14/10/2026']) {
      expect(shortDate(bad, 'en')).toBe(bad);
      expect(longDate(bad, 'ur')).toBe(bad);
      expect(monthLabel(bad, 'en')).toBe(bad);
      expect(dateTime(bad, 'en')).toBe(bad);
    }
    expect(monthName(Number.NaN, 'en')).toBe('NaN');
  });
});
