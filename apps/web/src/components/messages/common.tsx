import type { MessageLang } from '@maktab/shared';
import type { ReactNode } from 'react';
import { MARK, splitAt, splitLinks } from '@/lib/messages';
import { cn } from '@/lib/utils';

/**
 * A message text as the guardian will see it: in its own direction (Urdu right-to-left even on an
 * English screen), line breaks kept, and every URL an isolated LTR run so it is not reordered.
 * The whole text is data, so it sits in a <bdi>.
 */
export function MessageText({
  text,
  lang,
  className,
  id,
}: {
  text: string;
  lang: MessageLang;
  className?: string;
  id?: string;
}) {
  return (
    <bdi
      id={id}
      dir={lang === 'ur' ? 'rtl' : 'ltr'}
      lang={lang}
      className={cn('block whitespace-pre-line break-words', className)}
    >
      {splitLinks(text).map((part, i) =>
        part.url ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <bdi key={i} dir="ltr" className="num break-all">
            {part.text}
          </bdi>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <span key={i}>{part.text}</span>
        ),
      )}
    </bdi>
  );
}

/**
 * A translated sentence with one data value (a name) inside it: `sentence` is t(key, {name: MARK}),
 * and the value is rendered in its own <bdi> where the marker was.
 */
export function WithValue({ sentence, children }: { sentence: string; children: ReactNode }) {
  const [before, after] = splitAt(sentence);
  return (
    <>
      {before}
      <bdi>{children}</bdi>
      {after}
    </>
  );
}

export { MARK };
