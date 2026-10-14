import { formatPkPhone, telHref } from '@maktab/shared';
import { Phone } from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { RunsOnMaktab, SchoolMark } from '@/components/brand/SchoolBadge';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { useIdentity } from '@/lib/identity';
import { useBrand } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { flushLogout, logoutPending } from '@/offline/logout';

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"
      />
    </svg>
  );
}

/** The school's public face for this page (no session): GET /api/identity; null before setup. */
export { useIdentity } from '@/lib/identity';

/**
 * The public demo (DEMO_MODE=1, docs/demo.md): three fixed staff accounts, no Google needed. A
 * queued sign-out is sent first (as for Google sign-in), then a full navigation into the app.
 */
function DemoButtons() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const go = async (as: 'principal' | 'accountant' | 'teacher') => {
    setBusy(as);
    setFailed(false);
    try {
      if (logoutPending()) await flushLogout();
      await apiFetch('/api/auth/demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ as }),
      });
      window.location.assign('/');
    } catch {
      setFailed(true);
      setBusy(null);
    }
  };
  const roles = [
    ['principal', t('demo.asPrincipal')],
    ['accountant', t('demo.asAccountant')],
    ['teacher', t('demo.asTeacher')],
  ] as const;
  return (
    <section
      id="door-demo"
      className="flex flex-col gap-2 rounded-xl border border-brand/30 bg-brand-soft p-4"
    >
      <h3 className="font-semibold">{t('demo.tryTitle')}</h3>
      <p className="text-sm text-muted-foreground">{t('demo.tryBody')}</p>
      {roles.map(([as, label]) => (
        <Button
          key={as}
          id={`demo-${as}`}
          size="lg"
          className="w-full"
          disabled={busy !== null}
          onClick={() => void go(as)}
        >
          {label}
        </Button>
      ))}
      {failed && (
        <p role="alert" className="text-sm text-bad">
          {t('demo.failed')}
        </p>
      )}
    </section>
  );
}

/**
 * The school's front door (UI plan §7.1): one half is the school in its colour (badge or logo,
 * name in both scripts, city, "Runs on Maktab"); the other half has one job, staff sign-in, plus
 * one line for parents. On a phone the school band sits on top. Before setup: Maktab in teal.
 */
export function Login() {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const failed = params.has('error');
  const turnstile = params.get('error') === 'turnstile_failed';
  const [needNet, setNeedNet] = useState(false);
  const identity = useIdentity().data;
  const school = identity?.school ?? null;
  const demo = !!identity?.demo;
  useBrand(school ? school.brand_color : null);
  // A sign-out queued offline is sent before a new sign-in. The queued revocation names the old
  // session only (and rides along in a cookie the OAuth callback honours), so a 5xx / 429 now does
  // not block sign-in — but with no connection at all, Google cannot be reached anyway: say so.
  const signInClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!logoutPending()) return;
    e.preventDefault();
    const href = e.currentTarget.href;
    void flushLogout().then((r) => {
      if (r === 'offline') setNeedNet(true);
      else window.location.assign(href);
    });
  };
  const ur = i18n.language === 'ur';
  // In Urdu the Urdu name leads; the other script is the second line.
  const first = school ? (ur && school.name_ur ? school.name_ur : school.name) : t('app.name');
  const second = school ? (ur ? (school.name_ur ? school.name : null) : school.name_ur) : null;
  const secondUr = !!second && !ur;
  const tel = school?.phone ? formatPkPhone(school.phone) : null;

  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] bg-card md:grid-cols-2 md:grid-rows-1">
      <section
        id="door-school"
        className="relative flex flex-col items-center justify-center gap-2 bg-side px-5 pt-8 pb-5 text-center text-white md:px-8 md:py-10"
      >
        {school ? (
          <SchoolMark
            school={school}
            logoSrc={school.logo_v ? `/api/identity/logo?v=${school.logo_v}` : null}
            size={104}
            className="mb-2 hidden md:grid"
          />
        ) : (
          <img
            src="/icons/favicon.svg"
            alt=""
            width={88}
            height={88}
            className="mb-2 hidden size-22 md:block"
          />
        )}
        {school ? (
          <SchoolMark
            school={school}
            logoSrc={school.logo_v ? `/api/identity/logo?v=${school.logo_v}` : null}
            size={72}
            className="mb-1 md:hidden"
          />
        ) : (
          <img
            src="/icons/favicon.svg"
            alt=""
            width={64}
            height={64}
            className="mb-1 size-16 md:hidden"
          />
        )}
        <h1
          dir="auto"
          className={cn(
            'text-[1.375rem] leading-tight font-bold text-balance md:text-[1.625rem]',
            ur && school?.name_ur && 'font-urdu leading-[1.9]',
          )}
        >
          {first}
        </h1>
        {second && (
          <p
            lang={secondUr ? 'ur' : 'en'}
            dir={secondUr ? 'rtl' : 'ltr'}
            className={cn(
              'text-side-fg',
              secondUr ? 'font-urdu text-xl leading-[2.1] md:text-2xl' : 'font-system text-base',
            )}
          >
            {second}
          </p>
        )}
        {school?.city ? (
          <p className="text-sm text-side-mut">
            <bdi>{school.city}</bdi>
          </p>
        ) : (
          !school && <p className="text-sm text-side-mut">{t('app.tagline')}</p>
        )}
        {school && <RunsOnMaktab className="mt-3 text-side-mut md:absolute md:bottom-5 md:mt-0" />}
      </section>

      <section className="flex flex-col px-5 py-6 md:justify-center md:px-10">
        <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{t('door.staffTitle')}</h2>
            <LanguageToggle />
          </div>
          {failed && (
            <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
              {turnstile ? t('auth.turnstileFailed') : t('auth.failed')}
            </p>
          )}
          {needNet && (
            <p role="alert" className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
              {t('auth.connectToSignIn')}
            </p>
          )}
          {demo && <DemoButtons />}
          {/* A full navigation, not fetch: the OAuth flow is a chain of redirects. */}
          <Button asChild size="lg" variant="outline" className="w-full">
            <a href="/api/auth/google/start" onClick={signInClick}>
              <GoogleMark />
              {t('auth.signInWithGoogle')}
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">
            {demo ? t('demo.staffNote') : t('auth.inviteOnly')}
          </p>
          {school && (
            <aside id="door-parents" className="mt-2 rounded-xl bg-muted p-4 text-sm">
              <p className="font-semibold">{t('door.parentTitle')}</p>
              <p className="mt-1 text-muted-foreground">{t('door.parentBody')}</p>
              {tel && (
                <p className="mt-2 flex flex-wrap items-center gap-x-2">
                  <span>{t('door.parentCall')}:</span>
                  {/* A 44 px tap target, not a 17 px line of text (verify pass). */}
                  <a
                    id="door-call"
                    href={telHref(school.phone)}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border bg-card px-3 font-semibold hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Phone className="size-4" aria-hidden />
                    <bdi className="num">{tel}</bdi>
                  </a>
                </p>
              )}
            </aside>
          )}
          {!school && <RunsOnMaktab className="mt-4 text-muted-foreground" />}
        </div>
      </section>
    </div>
  );
}
