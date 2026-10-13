import { useEffect, useRef } from 'react';

/**
 * Cloudflare Turnstile widget (M7), shown only when the API hands out a site key (the school has
 * Turnstile on). The script loads on first use (explicit render), never on pages without it.
 * `onToken(null)` when a token expires or fails; tokens are single-use, so a parent re-renders
 * this with a new `resetKey` after each submit.
 */
type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
      language?: string;
    },
  ) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile'));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function Turnstile({
  siteKey,
  lang,
  onToken,
  resetKey = 0,
}: {
  siteKey: string;
  lang: string;
  onToken: (token: string | null) => void;
  resetKey?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey re-renders a fresh widget
  useEffect(() => {
    let id: string | null = null;
    let live = true;
    cb.current(null);
    void loadTurnstile()
      .then((ts) => {
        if (!live || !ref.current) return;
        id = ts.render(ref.current, {
          sitekey: siteKey,
          language: lang,
          callback: (t) => cb.current(t),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      live = false;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey, lang, resetKey]);
  return <div ref={ref} data-testid="turnstile" className="min-h-16" />;
}
