import 'i18next';
import type { en } from '@maktab/shared';

// Makes t('nav.fees') type-checked against the English source dictionary.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
