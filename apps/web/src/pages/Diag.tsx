import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageTitle } from '@/components/form';
import { isStandalone } from '@/components/InstallBanner';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { BUILD } from '@/lib/backup';
import { copyText } from '@/lib/messages';
import { failed, pending } from '@/offline/outbox';

export type DiagRow = { key: string; value: string };

const yesNo = (v: boolean | null | undefined) => (v == null ? 'unknown' : v ? 'yes' : 'no');

/**
 * Everything the Android device checks ask about (docs/android-checks.md), read from this phone.
 * Exported for tests: each probe is guarded, so a missing API reads "unsupported", never throws.
 */
export async function collectDiag(): Promise<DiagRow[]> {
  const rows: DiagRow[] = [];
  const add = (key: string, value: string) => rows.push({ key, value });
  add('app', `${BUILD.version} (${BUILD.commit})`);
  add('time', new Date().toISOString());
  add('user agent', navigator.userAgent);
  add('online', yesNo(navigator.onLine));
  try {
    add('outbox pending', String(await pending()));
    add('outbox failed', String((await failed()).length));
  } catch {
    add('outbox', 'unavailable (IndexedDB blocked?)');
  }
  const sw = navigator.serviceWorker;
  if (!sw) add('service worker', 'unsupported');
  else {
    const reg = await sw.getRegistration().catch(() => undefined);
    add(
      'service worker',
      reg
        ? `registered; active=${reg.active?.state ?? 'none'}; waiting=${reg.waiting ? 'yes' : 'no'}; controlling=${yesNo(!!sw.controller)}`
        : 'not registered',
    );
  }
  const storage = navigator.storage;
  if (storage?.persisted) {
    add('storage persisted', yesNo(await storage.persisted().catch(() => null)));
    const est = await storage.estimate?.().catch(() => null);
    if (est?.usage != null)
      add(
        'storage used',
        `${Math.round(est.usage / 1024)} KB of ${Math.round((est.quota ?? 0) / 1048576)} MB`,
      );
  } else add('storage persisted', 'unsupported');
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  if (!synth) add('speech voices', 'unsupported');
  else {
    const voices = synth.getVoices();
    const ur = voices.filter((v) => v.lang.toLowerCase().startsWith('ur'));
    add('speech voices', `${voices.length} (Urdu: ${ur.map((v) => v.name).join(', ') || 'none'})`);
  }
  add('web share', yesNo(typeof navigator.share === 'function'));
  let files: boolean | null = null;
  if (typeof navigator.canShare === 'function') {
    try {
      const f = new File(['x'], 'receipt.pdf', { type: 'application/pdf' });
      files = navigator.canShare({ files: [f] });
    } catch {
      files = false;
    }
  }
  add('canShare(files: PDF)', files === null ? 'unsupported' : yesNo(files));
  add('display mode', isStandalone() ? 'standalone' : 'browser');
  add('screen', `${window.innerWidth}×${window.innerHeight} css px @${window.devicePixelRatio}x`);
  add('fonts', document.fonts ? document.fonts.status : 'unsupported');
  add('language', `${navigator.language} / ui ${document.documentElement.lang}`);
  return rows;
}

export const diagReport = (rows: DiagRow[]): string =>
  ['Maktab /diag', ...rows.map((r) => `${r.key}: ${r.value}`)].join('\n');

/** Hidden owner page for device checks (M7): not in the nav, reached by typing /diag. */
export function DiagPage() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<DiagRow[] | null>(null);
  useEffect(() => {
    let live = true;
    const run = () => void collectDiag().then((r) => live && setRows(r));
    run();
    // Voices load late on Android; online/offline flips while testing.
    const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    synth?.addEventListener?.('voiceschanged', run);
    window.addEventListener('online', run);
    window.addEventListener('offline', run);
    return () => {
      live = false;
      synth?.removeEventListener?.('voiceschanged', run);
      window.removeEventListener('online', run);
      window.removeEventListener('offline', run);
    };
  }, []);
  const copy = async () => {
    if (rows && (await copyText(diagReport(rows)))) toast.success(t('diag.copied'));
  };
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>{t('diag.title')}</PageTitle>
      <p className="text-sm text-muted-foreground">{t('diag.help')}</p>
      {rows ? (
        <dl id="diag" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" dir="ltr">
          {rows.map((r) => (
            <div key={r.key} className="contents">
              <dt className="font-medium">{r.key}</dt>
              <dd className="num break-all" data-key={r.key}>
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      )}
      <Button id="diag-copy" className="self-start" disabled={!rows} onClick={() => void copy()}>
        <Copy aria-hidden />
        {t('diag.copy')}
      </Button>
    </div>
  );
}
