import { useState } from 'react';
import { cn } from '@/lib/utils';

/*
 * One avatar and one initials rule (M7b, UI plan §5.4): the signed-in user, search results, the
 * Students list, the register and the profile all draw the same thing. Small enough for the entry
 * chunk (AppShell uses it).
 */

/**
 * Up to two initials of a name: the first letter of each of the first two words that start with a
 * letter ("Ali Raza" → "AR", "(Late) Ahmed Khan" → "AK"). Urdu letters work too ("علی رضا" → "عر").
 * A name with no letters gives "".
 */
export function initials(name: string | null | undefined): string {
  return (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
}

const SIZE = {
  sm: 'size-8 text-xs',
  md: 'size-9 text-xs',
  lg: 'size-10 text-sm',
  xl: 'size-28 text-3xl',
} as const;
const TONE = {
  brand: 'bg-brand-soft text-brand',
  muted: 'bg-muted text-muted-foreground',
  side: 'bg-side-on text-white',
} as const;

/**
 * A photo when there is one (and it loads), else the initials on a tinted disc ("·" when the name
 * has no letters). Decorative: the name is always written next to it.
 */
export function Avatar({
  name,
  src,
  size = 'md',
  tone = 'brand',
  square = false,
  className,
  id,
}: {
  name: string | null | undefined;
  src?: string | null;
  size?: keyof typeof SIZE;
  tone?: keyof typeof TONE;
  square?: boolean;
  className?: string;
  id?: string;
}) {
  const [failed, setFailed] = useState(false);
  const shape = square ? 'rounded-md' : 'rounded-full';
  if (src && !failed)
    return (
      <img
        id={id}
        src={src}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn('shrink-0 object-cover', SIZE[size], shape, className)}
        data-avatar="photo"
      />
    );
  return (
    <span
      id={id}
      aria-hidden
      data-avatar="initials"
      className={cn(
        'grid shrink-0 place-items-center font-sans font-bold',
        SIZE[size],
        TONE[tone],
        shape,
        className,
      )}
    >
      <bdi>{initials(name) || '·'}</bdi>
    </span>
  );
}
