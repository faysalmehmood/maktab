import { describe, expect, it } from 'vitest';
import {
  admissionInputSchema,
  csvRecords,
  DEFAULT_TEMPLATES,
  formatPkPhone,
  importHeaderKey,
  isPkMobile,
  normalizePkMobile,
  normalizePkPhone,
  PK_MOBILE_GLOB,
  parentLinkUrl,
  parseCsv,
  parseGender,
  parseYesNo,
  renderTemplate,
  type TemplateKey,
  templateProblems,
  toCsvLine,
  wasFor,
  wrapNotice,
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

  it('splits raw records for chunked upload, matching parseCsv rows', () => {
    const text = '﻿a,b\r\n"multi\nline",2\r\n\r\n , \n+92 300,"x,""y"""\n';
    const recs = csvRecords(text);
    expect(recs).toEqual(['a,b', '"multi\nline",2', '+92 300,"x,""y"""']);
    expect(parseCsv(recs.join('\r\n'))).toEqual(parseCsv(text));
  });

  it('neutralises spreadsheet formulas in exported cells', () => {
    const cells = ['=1+1', '+92300', '-2', '@SUM(A1)', '\tx', '\ry', 'ok=1', 'علی'];
    expect(parseCsv(toCsvLine(cells))).toEqual([
      ["'=1+1", "'+92300", "'-2", "'@SUM(A1)", "'\tx", "'\ry", 'ok=1', 'علی'],
    ]);
    // A real number is data, not a formula.
    expect(toCsvLine([-5, 3])).toBe('-5,3');
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

describe('M5 fix pass: mobile check, template rules, plural verb', () => {
  it('isPkMobile and its SQL glob accept exactly the normalised mobile form', () => {
    expect(isPkMobile('923001234567')).toBe(true);
    expect(isPkMobile('924235761234')).toBe(false); // Lahore landline
    expect(isPkMobile('')).toBe(false);
    expect(isPkMobile(null)).toBe(false);
    expect(PK_MOBILE_GLOB).toBe('923[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]');
  });

  it('every template needs {link}; the notice also {body}; {body} is the notice’s only', () => {
    expect(templateProblems('fee_due', 'Pay {amount}')).toEqual({ missing: ['link'], unknown: [] });
    expect(templateProblems('notice', 'Hi\n{link}').missing).toEqual(['body']);
    expect(templateProblems('absence', '{body}\n{link}').unknown).toEqual(['body']);
    for (const [key, langs] of Object.entries(DEFAULT_TEMPLATES))
      for (const body of Object.values(langs))
        expect(templateProblems(key as TemplateKey, body)).toEqual({ missing: [], unknown: [] });
  });

  it('wraps a notice so the link stays alone on the last line', () => {
    const t = renderTemplate(wrapNotice(DEFAULT_TEMPLATES.notice.en, 'Closed on {date}.'), {
      date: '11/10/2026',
      school: 'Al-Noor',
      link: parentLinkUrl('https://s.example/', 'TOKEN'),
    });
    expect(t.split('\n')).toEqual([
      'Assalamu alaikum.',
      'Closed on 11/10/2026.',
      '— Al-Noor',
      'https://s.example/p#TOKEN',
    ]);
  });

  it('{was} follows the number of children in English; Urdu uses تھے', () => {
    expect(wasFor(1, 'en')).toBe('was');
    expect(wasFor(2, 'en')).toBe('were');
    expect(wasFor(1, 'ur')).toBe('تھے');
    expect(wasFor(3, 'ur')).toBe('تھے');
  });
});
