import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { type ManifestOptions, VitePWA } from 'vite-plugin-pwa';
import { API_CACHE, isOfflineApi } from './src/offline/api-cache';

// `translations` is the W3C manifest-localization proposal; browsers without it ignore the key.
const manifest: Partial<ManifestOptions> & {
  translations: Record<string, { name: string; short_name: string }>;
} = {
  name: 'Maktab',
  short_name: 'Maktab',
  description: 'School and academy management — مکتب',
  translations: { ur: { name: 'مکتب', short_name: 'مکتب' } },
  lang: 'en',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#0f766e',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
};

/** Settings → About shows these (src/lib/backup.ts BUILD). No git (a tarball build) → 'unknown'. */
function gitCommit(): string {
  if (process.env.MAKTAB_COMMIT) return process.env.MAKTAB_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest,
      workbox: {
        // No woff2 here: the Nastaliq subset is fetched only when Urdu text is actually rendered
        // (unicode-range), so English-only users never pay for it. It is cached on first use below.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: '/index.html',
        // API responses must never come from the precache.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Offline reload: /api/me, school, today's list and rosters (see src/offline/api-cache.ts).
            urlPattern: isOfflineApi,
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: API_CACHE,
              expiration: { maxEntries: 40, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/fonts/') && url.pathname.endsWith('.woff2'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts',
              expiration: { maxEntries: 4, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // PORT / API_PORT move both dev servers together (apps/api/scripts/dev.ts reads the same two).
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    // wrangler dev serves the API; same-origin in the browser keeps cookies simple.
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` },
  },
});
