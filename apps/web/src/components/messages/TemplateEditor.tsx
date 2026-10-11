import {
  type MessageLang,
  PLACEHOLDERS,
  type Placeholder,
  renderTemplate,
  unknownPlaceholders,
} from '@maktab/shared';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { todayPk } from '@/components/attendance/common';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { sampleVars } from '@/lib/messages';
import { useSchool } from '@/lib/queries';
import { MessageText } from './common';

/** The sample values for a preview in `lang`, with the school's own name. */
export function useSampleVars(lang: MessageLang) {
  const school = useSchool().data?.school;
  const name = (lang === 'ur' ? school?.name_ur || school?.name : school?.name) ?? '';
  return sampleVars(lang, name, todayPk());
}

/**
 * One language of a message text: textarea in that language's direction, placeholder chips that
 * insert `{children}` etc. at the cursor, an unknown-placeholder warning, and a live preview with
 * the shared renderer (the one the API uses), so what is shown is what a guardian gets.
 */
export function TemplateEditor({
  id,
  label,
  previewLabel,
  lang,
  value,
  onChange,
  previewBody,
  placeholders = PLACEHOLDERS,
}: {
  id: string;
  label: string;
  previewLabel: string;
  lang: MessageLang;
  value: string;
  onChange: (v: string) => void;
  /** What the preview renders (defaults to `value`; a notice falls back to the other language). */
  previewBody?: string;
  placeholders?: readonly Placeholder[];
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const vars = useSampleVars(lang);
  const unknown = unknownPlaceholders(value);
  const body = previewBody ?? value;

  const insert = (p: Placeholder) => {
    const el = ref.current;
    const token = `{${p}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        ref={ref}
        dir={lang === 'ur' ? 'rtl' : 'ltr'}
        lang={lang}
        rows={5}
        value={value}
        aria-invalid={unknown.length > 0}
        aria-describedby={unknown.length ? `${id}-unknown` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <fieldset className="flex flex-wrap gap-1" aria-label={t('msg.compose.insert')}>
        {placeholders.map((p) => (
          <button
            key={p}
            type="button"
            id={`${id}-ph-${p}`}
            title={t(`msg.placeholders.${p}`)}
            onClick={() => insert(p)}
            className="flex min-h-11 items-center rounded-md border px-2 text-xs hover:bg-accent"
          >
            <bdi className="num" dir="ltr">{`{${p}}`}</bdi>
            <span className="ms-1 text-muted-foreground">{t(`msg.placeholders.${p}`)}</span>
          </button>
        ))}
      </fieldset>
      {unknown.length > 0 && (
        <p id={`${id}-unknown`} role="alert" className="text-sm text-destructive">
          {t('msg.settings.unknown', { names: '' })}
          <bdi className="num">{unknown.map((u) => `{${u}}`).join(', ')}</bdi>
        </p>
      )}
      {body.trim() && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{previewLabel}</span>
          <MessageText
            id={`${id}-preview`}
            text={renderTemplate(body, vars)}
            lang={lang}
            className="rounded-md border bg-muted/40 p-2 text-sm"
          />
        </div>
      )}
    </div>
  );
}
