import { GUIDE_UI, type GuideLang, type GuideTask, say } from '@maktab/shared/guide';
import { AlertTriangle, CheckCircle2, ChevronRight, Play } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/api';
import { startTour } from '@/lib/tour';
import { useCompletedTours } from '@/lib/tour-done';
import { cn } from '@/lib/utils';
import { Rich } from './Rich';

export const useGuideLang = (): GuideLang => {
  const { i18n } = useTranslation();
  return i18n.language === 'ur' ? 'ur' : 'en';
};

/** The "Show me" band: starts the task's tour on the real screens. */
export function ShowMe({ task, before }: { task: GuideTask; before?: () => void }) {
  const lang = useGuideLang();
  const userId = useMe().data?.user.id;
  const done = useCompletedTours(userId).includes(task.id);
  if (!task.tour?.length) return null;
  return (
    <div
      id="guide-show-me"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-brand-soft p-3 ps-4"
    >
      <p className="min-w-0 flex-1 basis-56 text-sm text-foreground">
        {say(GUIDE_UI.showMeHint, lang)}
      </p>
      {done && (
        <span className="inline-flex items-center gap-1 text-meta font-semibold text-ok">
          <CheckCircle2 className="size-4" aria-hidden />
          {say(GUIDE_UI.done, lang)}
        </span>
      )}
      <Button
        data-show-me={task.id}
        onClick={() => {
          before?.();
          startTour(task.id, userId);
        }}
      >
        <Play aria-hidden className="rtl:-scale-x-100" />
        {say(GUIDE_UI.showMe, lang)}
      </Button>
    </div>
  );
}

/**
 * A task's steps (a numbered ledger: the sequence is real), its common mistakes and its screens.
 * Shared by the full page and the help sheet. Steps with an id are anchors (#step-<id>).
 */
export function TaskBody({ task, onNavigate }: { task: GuideTask; onNavigate?: () => void }) {
  const lang = useGuideLang();
  const { hash } = useLocation();
  const target = hash.startsWith('#step-') ? hash.slice(1) : null;
  useEffect(() => {
    if (target) document.getElementById(target)?.scrollIntoView?.({ block: 'center' });
  }, [target]);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${task.id}-steps`} className="flex flex-col gap-2">
        <h2 id={`${task.id}-steps`} className="text-section font-semibold">
          {say(GUIDE_UI.steps, lang)}
        </h2>
        <ol className="flex flex-col" data-guide-steps>
          {task.steps.map((s, i) => {
            const id = s.id ? `step-${s.id}` : undefined;
            return (
              <li
                key={s.text.en}
                id={id}
                className={cn(
                  'relative grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-3 rounded-lg py-3 pe-2',
                  // The thread between the numbers, like the margin of a register.
                  'before:absolute before:start-[1.375rem] before:top-12 before:bottom-0 before:w-px before:bg-border last:before:hidden',
                  id && id === target && 'bg-brand-soft',
                )}
              >
                <span
                  className="num grid size-11 place-items-center rounded-full border-2 border-brand/30 bg-card text-lg font-bold text-brand"
                  aria-hidden
                >
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-col gap-1 pt-2.5">
                  <p className="text-[0.95rem] leading-relaxed text-pretty">
                    <Rich text={s.text[lang]} />
                  </p>
                  {s.to && (
                    <Link
                      to={s.to}
                      onClick={onNavigate}
                      className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-brand hover:underline"
                    >
                      {say(GUIDE_UI.open, lang)}
                      <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {task.mistakes.length > 0 && (
        <section
          aria-labelledby={`${task.id}-mistakes`}
          className="flex flex-col gap-2 rounded-xl border border-warn/25 bg-warn-soft/50 p-4"
        >
          <h2 id={`${task.id}-mistakes`} className="text-section font-semibold">
            {say(GUIDE_UI.mistakes, lang)}
          </h2>
          <ul className="flex flex-col gap-2.5">
            {task.mistakes.map((m) => (
              <li key={m.en} className="flex gap-2.5 text-sm leading-relaxed">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                <span className="min-w-0">
                  <Rich text={m[lang]} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {task.links.map((l) => (
            <Button key={l.to} asChild variant="outline">
              <Link to={l.to} onClick={onNavigate}>
                <Rich text={l.label[lang]} />
                <ChevronRight aria-hidden className="rtl:-scale-x-100" />
              </Link>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
