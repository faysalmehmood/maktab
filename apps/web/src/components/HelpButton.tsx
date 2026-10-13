import { type GuideTaskId, helpFor } from '@maktab/shared/guide-audience';
import { CircleHelp } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useRoles } from '@/lib/roles';

const GuideSheet = lazy(() => import('@/guide/GuideSheet'));

/**
 * The "?" in a screen's header: opens the screen's guide task in a sheet. Shown only to roles the
 * task is for; the guide text loads when it is pressed.
 */
export function HelpButton({ task }: { task: GuideTaskId }) {
  const { t } = useTranslation();
  const roles = useRoles();
  const [open, setOpen] = useState(false);
  if (!helpFor(task, roles)) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground hover:text-brand print:hidden"
        aria-label={t('shell.help')}
        aria-haspopup="dialog"
        data-help={task}
        onClick={() => setOpen(true)}
      >
        <CircleHelp aria-hidden className="size-5" />
      </Button>
      {open && (
        <Suspense fallback={null}>
          <GuideSheet task={task} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
