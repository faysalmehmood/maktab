import { describe, expect, it } from 'vitest';
import {
  admissionInputSchema,
  formatPkPhone,
  importHeaderKey,
  normalizePkMobile,
  normalizePkPhone,
  parseCsv,
  parseGender,
  parseYesNo,
  toCsvLine,
} from '../src';

describe('PK phone normaliser (PLAN §12 exp4)', () => {
  it.each([
    '03001234567',
    '0300-1234567',
    '0300 123 4567',
    '+92 300 1234567',
    '92 300 1234567',
    '923001234567',
    '3001234567',
    '0092 300 1234567',
    '۰۳۰۰۱۲۳۴۵۶۷',
    '٠٣٠٠١٢٣٤٥٦٧',
    '(0300) 1234567',
  ])('%s → 923001234567', (input) => {
    expect(normalizePkMobile(input)).toBe('923001234567');
  });

  it.each([
    '042-35761234',
    '02134567890',
    '+92 51 1234567',
    '12345',
    '',
    'call me',
    '0300-12345',
    '+1 202 555 0100',
    '0300+1234567',
  ])('rejects %s as a mobile', (input) => {
    expect(normalizePkMobile(input)).toBeNull();
  });

  it('keeps PK landlines for "call", flagged as not mobile', () => {
    expect(normalizePkPhone('042-35761234')).toEqual({ number: '924235761234', mobile: false });
    expect(normalizePkPhone('0300-1234567')).toEqual({ number: '923001234567', mobile: true });
    expect(normalizePkPhone('12345')).toBeNull();
    expect(formatPkPhone('923001234567')).toBe('0300 1234567');
    expect(formatPkPhone('924235761234')).toBe('04235761234');
  });

  it('admission schema normalises guardian phones and defaults consent off', () => {
    const parsed = admissionInputSchema.parse({
      family: { name: 'Khan' },
      guardians: [{ name: 'Imran', phone: '+92 300 1234567', whatsapp: '' }],
      student: { name: 'Ali', admission_date: '2026-04-05', admission_no: '' },
      enrolment: { grp_id: '01J0000000000000000000000A' },
    });
    expect(parsed.guardians[0]).toMatchObject({
      phone: '923001234567',
      whatsapp: null,
      consent_whatsapp: false,
    });
    expect(parsed.student?.admission_no).toBeNull();
    const bad = admissionInputSchema.safeParse({
      family: { name: 'Khan' },
      guardians: [{ name: 'Imran', phone: '042-35761234', whatsapp: '042-35761234' }],
      student: { name: 'Ali', admission_date: '2026-04-05' },
      enrolment: { grp_id: '01J0000000000000000000000A' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('CSV', () => {
  it('parses quotes, doubled quotes, CRLF, BOM and blank lines', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""",علی\r\n\r\n1,,3\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'علی'],
      ['1', '', '3'],
    ]);
  });

  it('round-trips through toCsvLine', () => {
    const cells = ['plain', 'a,b', 'q"uote', 'line\nbreak', ''];
    expect(parseCsv(toCsvLine(cells))).toEqual([cells]);
  });

  it('import helpers', () => {
    expect(importHeaderKey('Student_Name (طالب علم کا نام)')).toBe('student_name');
    expect(importHeaderKey(' guardian phone ')).toBe('guardian_phone');
    expect(parseYesNo('Yes')).toBe(true);
    expect(parseYesNo('')).toBe(false);
    expect(parseYesNo('maybe')).toBeNull();
    expect(parseGender('لڑکی')).toBe('f');
    expect(parseGender('x')).toBeUndefined();
  });
});
