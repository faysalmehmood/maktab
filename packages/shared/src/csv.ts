/**
 * Minimal RFC 4180 CSV: quoted fields, doubled quotes, CR/LF line ends, a leading BOM (Excel saves
 * one with "CSV UTF-8", which is how Urdu names survive). Enough for the student import; no
 * dependency for something this small.
 */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && src[i + 1] === '\n') i++;
    } else field += ch;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines (all cells empty) carry nothing.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * The raw text of each non-blank record (quotes respected, BOM dropped), byte for byte, so a file
 * can be cut into chunks (header + N records) without re-serialising any cell. Record i here is
 * row i of parseCsv(text).
 */
export function csvRecords(text: string): string[] {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  const push = (end: number) => {
    const rec = src.slice(start, end);
    // Same "blank" rule as parseCsv: a record of empty / whitespace-only cells carries nothing.
    if (parseCsv(rec).length) out.push(rec);
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      push(i);
      if (ch === '\r' && src[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (start < src.length) push(src.length);
  return out;
}

const needsQuotes = /[",\r\n]/;

/**
 * Spreadsheet formula injection (OWASP "CSV injection"): Excel and Sheets evaluate a cell that
 * starts with one of these, so a student named `=HYPERLINK(…)` would run when the export is opened.
 * A leading `'` makes them show it as text. Numbers are written as-is: a JS number cannot carry a
 * formula, and `-5` must stay a number.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvSafeCell(s: string): string {
  return FORMULA_START.test(s) ? `'${s}` : s;
}

export function toCsvLine(cells: readonly (string | number | null | undefined)[]): string {
  return cells
    .map((c) => {
      const s = c == null ? '' : typeof c === 'number' ? String(c) : csvSafeCell(c);
      return needsQuotes.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    })
    .join(',');
}
