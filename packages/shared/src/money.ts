import { z } from 'zod';

/** Money is always an integer count of paisa (1 PKR = 100 paisa). Floats never touch money. */
export const paisaSchema = z.number().int().safe();
export type Paisa = z.infer<typeof paisaSchema>;

const group3 = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * `formatPKR(570000)` -> "PKR 5,700"; `formatPKR(-50050)` -> "-PKR 500.50".
 * Built by hand instead of Intl so the Urdu UI can never receive Arabic-Indic digits (PLAN §11).
 */
export function formatPKR(paisa: Paisa): string {
  if (!Number.isSafeInteger(paisa)) throw new RangeError(`not an integer paisa amount: ${paisa}`);
  const sign = paisa < 0 ? '-' : '';
  const abs = Math.abs(paisa);
  const rupees = group3(String(Math.floor(abs / 100)));
  const rem = abs % 100;
  const fraction = rem === 0 ? '' : `.${String(rem).padStart(2, '0')}`;
  return `${sign}PKR ${rupees}${fraction}`;
}

/** Parses user input like "5,700" or "5700.5" into paisa; returns null for anything ambiguous. */
export function parsePKR(input: string): Paisa | null {
  const m = /^\s*(-)?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const rupees = Number((m[2] ?? '0').replaceAll(',', ''));
  const paisa = Number((m[3] ?? '').padEnd(2, '0') || '0');
  const value = rupees * 100 + paisa;
  if (!Number.isSafeInteger(value)) return null;
  return m[1] ? -value : value;
}
