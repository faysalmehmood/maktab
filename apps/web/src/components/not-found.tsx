import { ChevronRight, SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Page, Panel } from '@/components/page';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';

/** The API's answer for an id that does not exist (or that this user may not see). */
export const isNotFound = (err: unknown): boolean =>
  err instanceof ApiError && err.code === 'not_found';

/**
 * What a detail page (and an unknown address) shows instead of its loading state when there is
 * nothing to show: a title, one sentence, and the way back to the list it belongs to.
 */
export function NotFoundState({
  back,
  title,
  body,
}: {
  back: { to: string; label: string };
  title?: string;
  body?: string;
}) {
  const { t } = useTranslation();
  return (
    <Page width="form" id="not-found">
      <Panel>
        {/* Same shape as EmptyState, but the title is the page's heading. */}
        <div
          role="alert"
          className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted-foreground"
        >
          <span className="mb-1 grid size-11 place-items-center rounded-full bg-brand-soft text-brand">
            <SearchX className="size-5" aria-hidden />
          </span>
          <h1 className="text-title text-foreground">{title ?? t('common.notFoundTitle')}</h1>
          <p className="max-w-prose text-sm">{body ?? t('common.notFoundBody')}</p>
          <Button asChild variant="outline" className="mt-2">
            <Link to={back.to} id="not-found-back">
              <ChevronRight className="rotate-180 rtl:rotate-0" aria-hidden />
              {back.label}
            </Link>
          </Button>
        </div>
      </Panel>
    </Page>
  );
}

/** Any address the app does not know ("/classes", "/fees/cash"). */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <NotFoundState
      back={{ to: '/', label: t('common.goHome') }}
      title={t('common.pageNotFound')}
      body={t('common.pageNotFoundBody')}
    />
  );
}
