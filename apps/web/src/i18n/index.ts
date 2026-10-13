import { DIRECTION, en, LANGUAGES, type Language } from '@maktab/shared';
import i18next from 'i18next';
import { useEffect, useState } from 'react';
import { initReactI18next } from 'react-i18next';

const STORAGE_KEY = 'maktab.lang';

const isLanguage = (v: unknown): v is Language => LANGUAGES.includes(v as Language);

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    // Storage can be unavailable (private mode); fall through to the browser language.
  }
  return typeof navigator !== 'undefined' && navigator.language.startsWith('ur') ? 'ur' : 'en';
}

/** RTL is driven from <html dir>, so logical Tailwind utilities (ms-, pe-, start-) flip by themselves. */
function applyToDocument(lang: Language): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = DIRECTION[lang];
}

/**
 * The parent page (/p) runs on a guardian's phone, often shared, and never as staff: its language
 * choice is for that visit only and must not become the staff app's language (M5 fix pass).
 */
const isParentPage = (): boolean =>
  typeof location !== 'undefined' && /^\/p(\/|$)/.test(location.pathname);

/**
 * Urdu is its own chunk (M7 bundle work): English-only phones never download it. Loaded before the
 * switch so no frame renders Urdu keys; offline it comes from the precache like any other chunk.
 */
export async function ensureResources(lang: Language): Promise<void> {
  if (lang === 'en' || i18next.hasResourceBundle(lang, 'translation')) return;
  const { ur } = await import('@maktab/shared/i18n-ur');
  i18next.addResourceBundle('ur', 'translation', ur, true, true);
}

export async function setLanguage(lang: Language): Promise<void> {
  await ensureResources(lang);
  await i18next.changeLanguage(lang);
  applyToDocument(lang);
  if (isParentPage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not fatal: the choice just will not survive a reload.
  }
}

export const currentLanguage = (): Language =>
  isLanguage(i18next.language) ? i18next.language : 'en';

export async function initI18n(lang: Language = initialLanguage()): Promise<typeof i18next> {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { translation: en } },
      // Only en up front; setLanguage() below adds ur first if that is the language.
      partialBundledLanguages: true,
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  }
  await setLanguage(lang);
  return i18next;
}

/**
 * For text in a language other than the UI's (a guardian's WhatsApp text, a payslip printed in
 * Urdu from an English screen): loads that dictionary and re-renders once it is there, so
 * `i18n.getFixedT(lang)` never silently falls back to English.
 */
const hasBundle = (lang: Language) =>
  lang === 'en' || i18next.hasResourceBundle(lang, 'translation');

export function useLanguageResources(lang: Language): boolean {
  const [ready, setReady] = useState(() => hasBundle(lang));
  useEffect(() => {
    if (hasBundle(lang)) return setReady(true);
    let live = true;
    void ensureResources(lang).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [lang]);
  return ready;
}
