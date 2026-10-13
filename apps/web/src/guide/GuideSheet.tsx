import { GUIDE_UI, say, taskById } from '@maktab/shared/guide';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsPhone } from '@/lib/media';
import { Rich } from './Rich';
import { ShowMe, TaskBody, useGuideLang } from './TaskBody';

/**
 * Contextual help (the "?" in a screen's header): the screen's guide task in a side sheet on a
 * desktop, a full-height sheet on a phone. "Show me" closes it and starts the tour right here.
 */
export default function GuideSheet({ task: id, onClose }: { task: string; onClose: () => void }) {
  const lang = useGuideLang();
  const phone = useIsPhone();
  const task = taskById(id);
  if (!task) return null;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side={phone ? 'bottom' : 'end'}
        data-guide-sheet={task.id}
        className={
          phone
            ? 'h-dvh max-h-dvh gap-0 overflow-y-auto bg-card p-0 pb-[env(safe-area-inset-bottom)]'
            : 'w-full gap-0 overflow-y-auto bg-card p-0 sm:max-w-lg'
        }
      >
        <SheetHeader className="gap-1 border-b px-5 pt-5 pb-4">
          <p className="text-meta font-semibold text-brand">{say(GUIDE_UI.help, lang)}</p>
          <SheetTitle className="text-title">
            <Rich text={task.title[lang]} />
          </SheetTitle>
          <SheetDescription>
            <Rich text={task.summary[lang]} />
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-5 py-5">
          <ShowMe task={task} before={onClose} />
          <TaskBody task={task} onNavigate={onClose} />
          <Link
            to={`/guide/${task.id}`}
            onClick={onClose}
            className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-brand hover:underline"
          >
            {say(GUIDE_UI.fullPage, lang)}
            <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
