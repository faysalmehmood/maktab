import { DIRECTION, en, LANGUAGES, type Language, ur } from '@maktab/shared';
import i18next from 'i18next';
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

export async function setLanguage(lang: Language): Promise<void> {
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
      resources: { en: { translation: en }, ur: { translation: ur } },
      lng: lang,
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  }
  await setLanguage(lang);
  return i18next;
}
