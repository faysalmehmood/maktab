import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { type ManifestOptions, VitePWA } from 'vite-plugin-pwa';

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
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        // API responses must never come from the precache.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    // wrangler dev serves the API; same-origin in the browser keeps cookies simple.
    proxy: { '/api': 'http://localhost:8787' },
  },
});
