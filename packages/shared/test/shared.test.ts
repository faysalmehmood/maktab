import { describe, expect, it } from 'vitest';
import { attendanceSubmissionSchema, firstName, formatPKR, newId, parsePKR } from '../src';

describe('formatPKR', () => {
  it('formats whole rupees with Latin digits and grouping', () => {
    expect(formatPKR(570000)).toBe('PKR 5,700');
    expect(formatPKR(0)).toBe('PKR 0');
    expect(formatPKR(123456789)).toBe('PKR 1,234,567.89');
  });
  it('keeps the minus sign in front of the currency so it renders as one unit', () => {
    expect(formatPKR(-50000)).toBe('-PKR 500');
    expect(formatPKR(-50050)).toBe('-PKR 500.50');
  });
  it('rejects non-integer paisa', () => {
    expect(() => formatPKR(1.5)).toThrow(RangeError);
  });
});

describe('parsePKR', () => {
  it('round-trips common inputs', () => {
    expect(parsePKR('5,700')).toBe(570000);
    expect(parsePKR('5700.5')).toBe(570050);
    expect(parsePKR('-500')).toBe(-50000);
    expect(parsePKR('5,70')).toBeNull();
    expect(parsePKR('abc')).toBeNull();
  });
});

describe('attendanceSubmissionSchema', () => {
  const base = {
    client_id: newId(),
    grp_id: newId(),
    date: '2026-10-10',
    taken_at: '2026-10-10T03:00:00.000Z',
  };
  it('accepts a whole-day register and defaults the subject', () => {
    const s = attendanceSubmissionSchema.parse({
      ...base,
      marks: [{ student_id: newId(), status: 'A' }],
    });
    expect(s.grp_subject_id).toBe('');
  });
  it('rejects duplicate students', () => {
    const id = newId();
    const r = attendanceSubmissionSchema.safeParse({
      ...base,
      marks: [
        { student_id: id, status: 'P' },
        { student_id: id, status: 'A' },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe('firstName (the parent page calling name)', () => {
  it('is the first word, or Muhammad + the next name', () => {
    expect(firstName('Ali Khan')).toBe('Ali');
    expect(firstName('  Ayesha   Siddiqa ')).toBe('Ayesha');
    expect(firstName('Muhammad Ali Khan')).toBe('Muhammad Ali');
    for (const m of ['Mohammad', 'Muhammed', 'Mohammed', 'Mohd', 'Mohd.', 'Md', 'MD.', 'MUHAMMAD'])
      expect(firstName(`${m} Hamza Butt`), m).toBe(`${m} Hamza`);
    expect(firstName('محمد علی خان')).toBe('محمد علی');
    expect(firstName('علی خان')).toBe('علی');
    // Two words keep one (the second may be the surname); Muhammad alone, or a name that only
    // starts with the letters, stays one word.
    expect(firstName('Muhammad Bilal')).toBe('Muhammad');
    expect(firstName('Muhammad Khan')).toBe('Muhammad');
    expect(firstName('محمد خان')).toBe('محمد');
    expect(firstName('Muhammad')).toBe('Muhammad');
    expect(firstName('Mohdish Raza')).toBe('Mohdish');
    expect(firstName('')).toBe('');
  });
});
