import { type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

export function Login() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const failed = params.has('error');
  const turnstile = params.get('error') === 'turnstile_failed';
  const [needNet, setNeedNet] = useState(false);
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

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4">
      <div className="self-end">
        <LanguageToggle />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          {/* Decorative: the title next to it already names the app. */}
          <img src="/icons/favicon.svg" alt="" width={56} height={56} className="mb-2 size-14" />
          <CardTitle className="text-2xl">{t('app.name')}</CardTitle>
          <CardDescription>{t('app.tagline')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {failed && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {turnstile ? t('auth.turnstileFailed') : t('auth.failed')}
            </p>
          )}
          {needNet && (
            <p role="alert" className="rounded-md bg-amber-100 p-3 text-sm text-amber-950">
              {t('auth.connectToSignIn')}
            </p>
          )}
          {/* A full navigation, not fetch: the OAuth flow is a chain of redirects. */}
          <Button asChild size="lg" variant="outline">
            <a href="/api/auth/google/start" onClick={signInClick}>
              <GoogleMark />
              {t('auth.signInWithGoogle')}
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">{t('auth.inviteOnly')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
