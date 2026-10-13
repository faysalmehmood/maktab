import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { markSchemasPure } from './pure-schemas';
import { manifest } from './pwa-manifest';
import { API_CACHE, isOfflineApi } from './src/offline/api-cache';

/** Build-only: tests and the API read the shared files untouched (see pure-schemas.ts). */
function pureZodSchemas(): Plugin {
  const shared = fileURLToPath(new URL('../../packages/shared/src/', import.meta.url));
  return {
    name: 'maktab:pure-zod-schemas',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!id.startsWith(shared) || !code.includes("from 'zod'")) return null;
      return { code: markSchemasPure(code), map: null };
    },
  };
}

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
    pureZodSchemas(),
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
        // API responses must never come from the precache, and neither may the parent page: `/p`
        // is served by the Worker with its own noindex / no-referrer / CSP headers (app.ts).
        navigateFallbackDenylist: [/^\/api\//, /^\/p(\/|$)/],
        runtimeCaching: [
          {
            // Offline reload: /api/me, school, today's list and rosters (see src/offline/api-cache.ts).
            urlPattern: isOfflineApi,
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: API_CACHE,
              expiration: { maxEntries: 80, maxAgeSeconds: 24 * 60 * 60 },
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
  build: {
    rolldownOptions: {
      output: {
        // zod is needed only by the office forms that validate on the client (lazy routes); its own
        // chunk keeps it off the first load instead of riding in the shared vendor chunk.
        advancedChunks: { groups: [{ name: 'zod', test: /[\\/]node_modules[\\/]zod[\\/]/ }] },
      },
    },
  },
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
