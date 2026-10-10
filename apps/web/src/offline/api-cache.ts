/**
 * Offline reload (PLAN §14.3, M2): the few GET responses a teacher needs to open the app and take
 * a register with no connection are kept by the service worker in a NetworkFirst runtime cache —
 * network when there is one, the last good copy (≤ 1 day old) when there is not:
 *   /api/me                   so RequireAuth mounts the shell
 *   /api/school               so SetupGate and the shell have the school
 *   /api/attendance/today     the teacher's list
 *   /api/attendance/register  each roster opened today (the URL carries group, date, subject)
 * Chosen over a persisted react-query cache: the SW sees every fetch whichever screen made it, the
 * outbox (IndexedDB) stays the only place that holds writes, and nothing else changes in the app.
 * Queries use networkMode 'offlineFirst' (lib/query-client.ts) so they still call fetch — and so
 * reach this cache — while the browser reports offline. Sign-out deletes the cache (AppShell).
 */
export const API_CACHE = 'api-offline';

/**
 * Workbox `urlPattern`. Serialised into the generated service worker by its source text, so it must
 * not reference anything outside its own body.
 */
export const isOfflineApi = ({ url, sameOrigin }: { url: URL; sameOrigin?: boolean }): boolean =>
  sameOrigin !== false &&
  (url.pathname === '/api/me' ||
    url.pathname === '/api/school' ||
    url.pathname === '/api/attendance/today' ||
    url.pathname === '/api/attendance/register');
