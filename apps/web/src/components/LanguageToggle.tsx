import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { setLanguage } from '@/i18n';

/**
 * One tap switches between English and Urdu; each label is written in its own language. The label
 * uses the system font (`font-system`) so showing "اردو" on an English screen does not download
 * the Nastaliq web font.
 */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const next = i18n.language === 'ur' ? 'en' : 'ur';
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={t('common.language')}
      onClick={() => void setLanguage(next)}
    >
      <Languages aria-hidden />
      <span lang={next} className="font-system">
        {next === 'ur' ? 'اردو' : 'English'}
      </span>
    </Button>
  );
}
