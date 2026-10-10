import { QueryClient } from '@tanstack/react-query';

/**
 * The app's query client. No background polling: D1 reads are a daily quota (PLAN §8).
 * networkMode 'offlineFirst': a query still runs its fetch when the browser reports offline, so the
 * service worker's API cache (offline/api-cache.ts) can answer it after a reload without
 * connection; retries then wait for the connection. With the default 'online' the query would sit
 * paused and the teacher would see "Loading…" forever.
 */
export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, staleTime: 60_000, networkMode: 'offlineFirst' },
    },
  });
