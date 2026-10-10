import type { I18nKey } from '@maktab/shared';
import { useTranslation } from 'react-i18next';

export function Placeholder({ title }: { title: I18nKey }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{t(title)}</h1>
      <p className="text-muted-foreground">{t('common.comingSoon')}</p>
    </section>
  );
}
