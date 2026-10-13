import { GUIDE_UI, type GuideLang, say, taskById } from '@maktab/shared/guide';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { useMe } from '@/lib/api';
import { stopTour } from '@/lib/tour';
import { markTourDone } from '@/lib/tour-done';
import { type EngineLabels, type EngineStep, TourEngine } from './engine';
import { Rich } from './Rich';

/** Runs the tour of one guide task in the app shell (lazy: loaded when a tour starts). */
export default function TourRunner({ task }: { task: string }) {
  const { i18n } = useTranslation();
  const lang: GuideLang = i18n.language === 'ur' ? 'ur' : 'en';
  const location = useLocation();
  const navigate = useNavigate();
  const userId = useMe().data?.user.id;
  const def = taskById(task);

  const steps = useMemo<EngineStep[]>(
    () =>
      (def?.tour ?? []).map((s) => ({
        ...s,
        title: <Rich text={s.title[lang]} />,
        body: <Rich text={s.body[lang]} />,
      })),
    [def, lang],
  );
  const labels: EngineLabels = {
    next: say(GUIDE_UI.next, lang),
    back: say(GUIDE_UI.back, lang),
    skip: say(GUIDE_UI.skip, lang),
    finish: say(GUIDE_UI.finish, lang),
    counter: (i, n) => say(GUIDE_UI.counter, lang, { i, n }),
    skipped: say(GUIDE_UI.skipped, lang),
    waiting: say(GUIDE_UI.waiting, lang),
    label: say(GUIDE_UI.tourLabel, lang),
  };

  useEffect(() => {
    if (!steps.length) stopTour();
  }, [steps.length]);
  if (!steps.length) return null;
  return (
    <TourEngine
      steps={steps}
      labels={labels}
      pathname={location.pathname}
      navigate={navigate}
      rtl={i18n.dir(lang) === 'rtl'}
      onClose={(completed) => {
        if (completed) markTourDone(userId, task);
        stopTour();
      }}
    />
  );
}
