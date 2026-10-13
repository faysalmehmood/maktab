import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';

// PLAN §15 (amended 2026-10-13 for M7b): controls are 44 px on touch (coarse pointer, and when the
// pointer is unknown) and may be 36 px under a mouse. The height is one token, `--h`, set by
// pointer media queries in styles.css; components use `h-ctl` / `size-ctl`, never a fixed h-11.

const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

/** The `--h` value inside a block that starts with `head` (first match). */
function hIn(head: string): string | undefined {
  const at = css.indexOf(head);
  if (at < 0) return undefined;
  const block = css.slice(at, css.indexOf('}', css.indexOf('{', at)) + 1);
  return /--h:\s*([0-9]+px)/.exec(block)?.[1];
}

const cases = [
  ['default', 'h-ctl'],
  ['sm', 'h-ctl'],
  ['lg', 'h-12'],
  ['icon', 'size-ctl'],
] as const;

describe('Button sizes', () => {
  it.each(cases)('size %s uses the density token (%s), never a pointer class', (size, cls) => {
    render(<Button size={size}>{size}</Button>);
    const list = screen.getByRole('button').className.split(/\s+/);
    expect(list).toContain(cls);
    expect(list.some((c) => /^h-(9|10|8)$/.test(c))).toBe(false);
    expect(list.some((c) => /pointer-(fine|coarse)/.test(c))).toBe(false);
  });
});

describe('density token by pointer', () => {
  it('is 44 px by default and on coarse pointers, 36 px only under a fine pointer', () => {
    expect(hIn(':root {')).toBe('44px');
    expect(hIn('@media (pointer: coarse)')).toBe('44px');
    expect(hIn('@media (pointer: fine)')).toBe('36px');
    // The utilities resolve to the token.
    expect(css).toMatch(/--spacing-ctl:\s*var\(--h\)/);
  });

  it('inputs and selects use the same token', async () => {
    const { Input } = await import('@/components/ui/input');
    const { Select } = await import('@/components/ui/select');
    render(
      <>
        <Input aria-label="i" />
        <Select aria-label="s" />
      </>,
    );
    expect(screen.getByLabelText('i').className).toContain('h-ctl');
    expect(screen.getByLabelText('s').className).toContain('h-ctl');
  });
});
