import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** First Strong Isolate … Pop: keeps a Latin number or name intact inside an Urdu sentence. */
export const isolate = (s: string) => `\u2068${s}\u2069`;
