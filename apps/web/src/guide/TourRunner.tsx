import { GUIDE_UI, type GuideLang, type L, say, taskById } from '@maktab/shared/guide';
import { type ReactNode, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { useMe } from '@/lib/api';
import { stopTour } from '@/lib/tour';
import { markTourDone } from '@/lib/tour-done';
import { type EngineEmpty, type EngineLabels, type EngineStep, TourEngine } from './engine';
import { Rich } from './Rich';

/**
 * "Step {{i}} of {{n}}" with only the numbers isolated (`<bdi>`): in Urdu the words stay in the
 * Urdu run and each number keeps its own direction.
 */
export function isolateNumbers(l: L, lang: GuideLang, vars: Record<string, number>): ReactNode {
  return l[lang].split(/(\{\{\w+\}\})/).map((part, k) => {
    const name = /^\{\{(\w+)\}\}$/.exec(part)?.[1];
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a fixed template never move
    return name ? <bdi key={k}>{vars[name]}</bdi> : part;
  });
}

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
        vacant: s.vacant && {
          title: <Rich text={s.vacant.title[lang]} />,
          body: <Rich text={s.vacant.body[lang]} />,
        },
        title: <Rich text={s.title[lang]} />,
        body: <Rich text={s.body[lang]} />,
      })),
    [def, lang],
  );
  const empty = useMemo<EngineEmpty | undefined>(
    () =>
      def?.tourEmpty && {
        target: def.tourEmpty.target,
        title: <Rich text={def.tourEmpty.title[lang]} />,
        body: <Rich text={def.tourEmpty.body[lang]} />,
      },
    [def, lang],
  );
  const labels: EngineLabels = {
    next: say(GUIDE_UI.next, lang),
    back: say(GUIDE_UI.back, lang),
    skip: say(GUIDE_UI.skip, lang),
    finish: say(GUIDE_UI.finish, lang),
    counter: (i, n) => isolateNumbers(GUIDE_UI.counter, lang, { i, n }),
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
      empty={empty}
      labels={labels}
      pathname={location.pathname}
      navigate={navigate}
      rtl={i18n.dir(lang) === 'rtl'}
      onClose={(completed) => {
        if (completed) markTourDone(userId, task);
        // Focus would be lost with the card: give it back to the task's "Show me" when it is on
        // screen (the guide page), unless the user has moved on to something else.
        const now = document.activeElement;
        const lost = !now || now === document.body || !!now.closest('[data-tour-card]');
        const showMe = document.querySelector<HTMLElement>(`[data-show-me="${task}"]`);
        stopTour();
        if (lost) showMe?.focus();
      }}
    />
  );
}
