import { LABEL_VARS, runs } from '@maktab/shared/guide';
import { useTranslation } from 'react-i18next';
import '@/i18n/screens';

type Lookup = (key: string, vars: object) => string;

/**
 * A guide text: plain words, Maktab labels (`[[key]]`, shown exactly as this language's screen
 * shows them), other bold names and code. Labels and names are isolated with <bdi> (Latin inside
 * Urdu and the other way round).
 */
export function Rich({ text }: { text: string }) {
  const { t } = useTranslation();
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
        return (
          <strong
            key={key}
            className="font-semibold"
            data-label={r.kind === 'label' ? r.text : undefined}
          >
            <bdi>{r.kind === 'label' ? label(r.text, LABEL_VARS) : r.text}</bdi>
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
