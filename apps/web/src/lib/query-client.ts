import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * The app's query client. No background polling: D1 reads are a daily quota (PLAN §8).
 * networkMode 'offlineFirst': a query still runs its fetch when the browser reports offline, so the
 * service worker's API cache (offline/api-cache.ts) can answer it after a reload without
 * connection; retries then wait for the connection. With the default 'online' the query would sit
 * paused and the teacher would see "Loading…" forever.
 * A 404 is an answer, not a failure: retrying it only keeps a detail page on its skeleton for seconds
 * before the not-found state.
 */
export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 60_000,
        networkMode: 'offlineFirst',
        retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 3,
      },
    },
  });
