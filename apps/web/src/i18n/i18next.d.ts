import 'i18next';
import type { en } from '@maktab/shared';
import type { screensEn } from '@maktab/shared/i18n-screens';

// Makes t('nav.fees') type-checked against the English source dictionary (plus the lazily merged
// `screens.*` dictionary of M7b part 2, see src/i18n/screens.ts).
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en & { screens: typeof screensEn } };
  }
}
