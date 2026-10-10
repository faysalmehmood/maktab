import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';

const cases = [
  ['default', 'h-11'],
  ['sm', 'h-11'],
  ['lg', 'h-12'],
  ['icon', 'size-11'],
] as const;

describe('Button sizes', () => {
  it.each(cases)('size %s has a 44px+ class and no pointer exception', (size, cls) => {
    render(<Button size={size}>{size}</Button>);
    const list = screen.getByRole('button').className.split(/\s+/);
    expect(list).toContain(cls);
    expect(list.some((c) => /pointer-(fine|coarse)/.test(c))).toBe(false);
  });
});
