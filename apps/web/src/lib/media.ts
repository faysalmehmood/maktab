import { useSyncExternalStore } from 'react';

/**
 * A CSS media query as React state (phone vs desktop layouts that differ in markup, not just CSS:
 * DataTable's table vs cards, FilterBar's sheet). `fallback` is used where matchMedia is missing
 * (jsdom, very old browsers): desktop markup by default.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof matchMedia !== 'function') return () => undefined;
      const mq = matchMedia(query);
      mq.addEventListener?.('change', onChange);
      return () => mq.removeEventListener?.('change', onChange);
    },
    () => (typeof matchMedia === 'function' ? matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** Tailwind's `md` breakpoint (48rem): below it the phone layouts apply. */
export const PHONE_QUERY = '(max-width: 47.99rem)';
export const useIsPhone = (): boolean => useMediaQuery(PHONE_QUERY, false);

/** The browser's own online flag as state (the `online` / `offline` events). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('online', onChange);
      window.addEventListener('offline', onChange);
      return () => {
        window.removeEventListener('online', onChange);
        window.removeEventListener('offline', onChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
