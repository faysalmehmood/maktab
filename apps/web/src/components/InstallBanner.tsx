import { Download, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Chrome on Android fires this when the app can be installed; not in the DOM lib types. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const DISMISSED_KEY = 'maktab.installDismissed';
/** "Not now" hides the banner for this long; it comes back afterwards (staff phones change hands). */
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

export const isStandalone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

function snoozed(now = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY));
    return Number.isFinite(at) && at > 0 && now - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

/**
 * The Android install banner (M7): Chrome's `beforeinstallprompt` is held and offered in our own
 * words — why install (opens like an app, the register works offline) — in the UI language. Never
 * shown when already installed, on iOS (no such event), or for two weeks after "Not now".
 */
export function InstallBanner() {
  const { t } = useTranslation();
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    if (isStandalone() || snoozed()) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  if (!event) return null;
  const notNow = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // Private mode: it just shows again next time.
    }
    setEvent(null);
  };
  const install = async () => {
    await event.prompt();
    await event.userChoice.catch(() => undefined);
    setEvent(null);
  };
  return (
    <section
      id="install-banner"
      aria-labelledby="install-title"
      className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2 text-sm print:hidden"
    >
      <div className="min-w-0 flex-1">
        <p id="install-title" className="font-medium">
          {t('pwa.installTitle')}
        </p>
        <p className="text-muted-foreground">{t('pwa.installBody')}</p>
      </div>
      <Button size="sm" className="min-h-11" onClick={() => void install()}>
        <Download aria-hidden />
        {t('pwa.install')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="min-h-11"
        onClick={notNow}
        aria-label={t('pwa.notNow')}
      >
        <X aria-hidden />
        <span className="max-sm:sr-only">{t('pwa.notNow')}</span>
      </Button>
    </section>
  );
}
