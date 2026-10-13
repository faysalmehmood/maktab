import type { ManifestOptions } from 'vite-plugin-pwa';

/**
 * The web app manifest (vite-plugin-pwa writes it to manifest.webmanifest). Its own module so
 * src/test/pwa.test.ts can check the installability basics without a build.
 */
// `translations` is the W3C manifest-localization proposal; browsers without it ignore the key.
export const manifest: Partial<ManifestOptions> & {
  translations: Record<string, { name: string; short_name: string }>;
} = {
  id: '/',
  name: 'Maktab',
  short_name: 'Maktab',
  description: 'School and academy management — مکتب',
  translations: { ur: { name: 'مکتب', short_name: 'مکتب' } },
  lang: 'en',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  categories: ['education', 'productivity'],
  background_color: '#ffffff',
  theme_color: '#0f766e',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
};
