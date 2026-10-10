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

const needsQuotes = /[",\r\n]/;

export function toCsvLine(cells: readonly (string | number | null | undefined)[]): string {
  return cells
    .map((c) => {
      const s = c == null ? '' : String(c);
      return needsQuotes.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    })
    .join(',');
}
