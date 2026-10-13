import { LABEL_VARS, runs } from '@maktab/shared/guide';
import { useTranslation } from 'react-i18next';
import '@/i18n/screens';

const URDU = /[\u0600-\u06FF]/;

type Lookup = (key: string, vars: object) => string;

/**
 * A guide text: plain words, Maktab labels (`[[key]]`, shown exactly as this language's screen
 * shows them), other bold names and code. A label is in the screen's own language, so in Urdu it is
 * an Urdu run (`<bdi dir="rtl" lang="ur">`: Nastaliq, right to left); Latin names and code are
 * isolated LTR runs (`<bdi>`, the system face).
 */
export function Rich({ text }: { text: string }) {
  const { t, i18n } = useTranslation();
  const ur = i18n.language === 'ur';
  const label = t as unknown as Lookup;
  return (
    <>
      {runs(text).map((r, i) => {
        const key = `${i}-${r.kind}`;
        if (r.kind === 'plain') return <span key={key}>{r.text}</span>;
        if (r.kind === 'code')
          return (
            <code key={key} className="rounded bg-muted px-1 font-mono text-[0.9em]">
              <bdi>{r.text}</bdi>
            </code>
          );
        if (r.kind === 'label') {
          const name = label(r.text, LABEL_VARS);
          return (
            <strong key={key} className="font-semibold" data-label={r.text}>
              {!ur ? (
                name
              ) : URDU.test(name) ? (
                <bdi dir="rtl" lang="ur">
                  {name}
                </bdi>
              ) : (
                // A label that is Latin in Urdu too ("58 mm", "A5"): an LTR run.
                <bdi>{name}</bdi>
              )}
            </strong>
          );
        }
        return (
          <strong key={key} className="font-semibold">
            <bdi>{r.text}</bdi>
          </strong>
        );
      })}
    </>
  );
}

/** Same text without marks (for aria labels and document titles). */
export function usePlain(): (text: string) => string {
  const { t } = useTranslation();
  const label = t as unknown as Lookup;
  return (text) =>
    runs(text)
      .map((r) => (r.kind === 'label' ? label(r.text, LABEL_VARS) : r.text))
      .join('');
}
