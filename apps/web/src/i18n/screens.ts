import { screensEn } from '@maktab/shared/i18n-screens';
import i18next from 'i18next';

/*
 * M7b part 2: the restyled screens' English strings (`screens.*`) are not in the first-load `en`
 * bundle. Every screen that uses them imports this module, so the dictionary rides in a lazy chunk
 * and is merged before the screen renders (module evaluation precedes the first render). Urdu has
 * them already (i18n-ur is its own chunk).
 */
const add = () =>
  i18next.addResourceBundle('en', 'translation', { screens: screensEn }, true, true);
if (i18next.isInitialized) add();
else i18next.on('initialized', add);

export const SCREENS_READY = true;
