import { describe, expect, it } from 'vitest';
import { markSchemasPure } from '../../pure-schemas';

describe('markSchemasPure (build-only transform of @maktab/shared)', () => {
  it('wraps whole top-level schema expressions, chained and multi-line, in a pure IIFE', () => {
    const src = [
      "import { z } from 'zod';",
      "export const ROLES = ['a', 'b'] as const;",
      'export const roleSchema = z.enum(ROLES);',
      'export const inputSchema = z',
      '  .object({ name: z.string().trim().max(80), role: roleSchema })',
      "  .refine((v) => v.name !== '', { message: 'empty' });",
      'const shape = { id: z.ulid() };',
      'export const optText = (max: number) => z.string().max(max).optional();',
      'export type Role = (typeof ROLES)[number];',
    ].join('\n');
    const out = markSchemasPure(src);
    expect(out).toContain("export const ROLES = ['a', 'b'] as const;");
    expect(out).toContain('export const roleSchema = /* @__PURE__ */ (() => (z.enum(ROLES)))();');
    expect(out).toContain('export const inputSchema = /* @__PURE__ */ (() => (z\n  .object(');
    expect(out).toContain("{ message: 'empty' })))();");
    expect(out).toContain('const shape = /* @__PURE__ */ (() => ({ id: z.ulid() }))();');
    // Functions are already free to drop: untouched.
    expect(out).toContain(
      'export const optText = (max: number) => z.string().max(max).optional();',
    );
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
  });
});
