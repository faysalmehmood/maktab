import { en } from '../i18n';
import { screensEn } from '../i18n-screens';
import { ur } from '../i18n-ur';
import { GUIDE_TASKS, LABEL_VARS, lookup, runs } from './index';
import type { GuideLang, GuideTask, L } from './types';
import { GUIDE_SECTIONS, GUIDE_UI } from './ui';

const DICT: Record<GuideLang, unknown> = { en: { ...en, screens: screensEn }, ur };

/** A guide text as Markdown in one language: quoted labels resolved and bold. */
export function md(text: string, lang: GuideLang): string {
  return runs(text)
    .map((r) => {
      if (r.kind === 'plain') return r.text;
      if (r.kind === 'code') return `\`${r.text}\``;
      if (r.kind === 'strong') return `**${r.text}**`;
      const label = lookup(DICT[lang], r.text);
      if (label === undefined) throw new Error(`guide: no ${lang} label ${r.text}`);
      return `**${label.replace(/\{\{(\w+)\}\}/g, (_, k: keyof typeof LABEL_VARS) => LABEL_VARS[k] ?? '')}**`;
    })
    .join('');
}

/*
 * docs/onboarding.md is generated from the guide content (`npm run docs:guide`), so the in-app guide
 * and the repo doc say the same thing. CI runs `npm run docs:guide -- --check`.
 */

export const BEFORE_YOU_START: readonly L[] = [
  {
    en: 'Use Chrome. Setup and reports are easier on a laptop; attendance, the fee counter and the send queue are made for a phone.',
    ur: 'Chrome استعمال کریں۔ ترتیب اور رپورٹیں لیپ ٹاپ پر آسان ہیں؛ حاضری، فیس کاؤنٹر اور پیغامات فون کے لیے بنے ہیں۔',
  },
  {
    en: 'Numbers are always in English digits (0–9), also on the Urdu screen and on Urdu receipts. Dates are Gregorian. This is on purpose.',
    ur: 'نمبر ہمیشہ انگریزی ہندسوں (0–9) میں ہوتے ہیں، اردو اسکرین اور اردو رسید پر بھی۔ تاریخیں عیسوی ہیں۔ یہ جان بوجھ کر ہے۔',
  },
  {
    en: 'Money is never deleted. A mistake is corrected with a new entry (a reversal, a void with a reason). Every change is kept in the audit log.',
    ur: 'پیسوں کا کوئی اندراج مٹتا نہیں۔ غلطی نئے اندراج سے درست ہوتی ہے (واپسی، یا وجہ کے ساتھ منسوخی)۔ ہر تبدیلی آڈٹ لاگ میں رہتی ہے۔',
  },
  {
    en: 'First sign-in: the owner signs in with Google using the owner email set on the server, and becomes the [[staff.roles.owner]]. Everyone else signs in after the owner invites their Google email.',
    ur: 'پہلا سائن اِن: مالک سرور پر لکھے گئے ای میل سے گوگل کے ذریعے سائن اِن کرتا ہے اور [[staff.roles.owner]] بن جاتا ہے۔ باقی سب مالک کی دعوت کے بعد اپنے گوگل ای میل سے سائن اِن کرتے ہیں۔',
  },
];

/** Notes for whoever maintains the installation (doc only, not in the app). */
const MAINTAINER_NOTES = `## For the maintainer

- Receipt print URL parameters (for a bookmark or a shared link): \`/receipts/<id>?fmt=a5\` (default)
  or \`fmt=thermal\` (58 mm), and \`lang=en\` or \`lang=ur\` for the receipt language. Without \`lang\`,
  the language saved on the receipt is used.
- Receipt **Share** ends with the guardian's parent-page link even without WhatsApp consent (consent
  covers the automatic send queue; sharing by hand is the collector's choice). Each share is in the
  audit log; a reversed receipt gets no link. API: \`POST /api/receipts/:id/parent-link\` answers 200
  \`{url}\` (\`null\` when no link can be made), 409 \`already_reversed\`.
- Settings → Messages: the school's default parent-link check, the message templates (keep \`{link}\`
  in every text), and **Revoke all parent links** (owner, for a leak).
- Restore needs the same \`PARENT_LINK_SECRET\`, else revoke all parent links after the restore.
- Runbooks: docs/backup.md, docs/restore.md, docs/deploy.md, docs/pilot-checklist.md,
  docs/android-checks.md.

Help: ask the maintainer (maktab@conceptlix.com).
`;

const both = (l: L) => `${md(l.en, 'en')} / ${md(l.ur, 'ur')}`;
const rtl = (body: string) => `<div dir="rtl" lang="ur">\n\n${body}\n\n</div>`;
const list = (items: readonly string[], numbered: boolean) =>
  items.map((s, i) => `${numbered ? `${i + 1}.` : '-'} ${s}`).join('\n');

function task(t: GuideTask): string {
  const lang = (l: GuideLang) => {
    const body = [
      `*${md(t.summary[l], l)}*`,
      '',
      list(
        t.steps.map((s) => md(s.text[l], l)),
        true,
      ),
    ];
    if (t.mistakes.length)
      body.push(
        '',
        `**${GUIDE_UI.mistakes[l]}**`,
        '',
        list(
          t.mistakes.map((m) => md(m[l], l)),
          false,
        ),
      );
    return body.join('\n');
  };
  const meta = [`In the app: \`/guide/${t.id}\``, `for ${t.roles.join(', ')}`];
  if (t.tour?.length) meta.push(`"${GUIDE_UI.showMe.en}" tour: ${t.tour.length} steps`);
  return [
    `### ${both(t.title)}`,
    '',
    lang('en'),
    '',
    `${meta.join(' · ')}.`,
    '',
    rtl(lang('ur')),
    '',
  ].join('\n');
}

/** The whole of docs/onboarding.md. Pure and deterministic (same content → same bytes). */
export function renderOnboardingMarkdown(): string {
  const tasks = GUIDE_TASKS;
  const parts: string[] = [
    '<!-- Generated from packages/shared/src/guide by `npm run docs:guide`. Do not edit by hand. -->',
    '',
    `# Maktab onboarding guide / مکتب: شروع کرنے کی رہنمائی`,
    '',
    'For the school owner, the office and teachers. The same text is in the app under **Help & guide**',
    '(`/guide`), where each task also has a "Show me" tour on the real screen. Button names are quoted',
    "exactly as each language's screen shows them (English steps: English screen; Urdu steps: Urdu screen).",
    '',
    '## Before you start / شروع کرنے سے پہلے',
    '',
    list(
      BEFORE_YOU_START.map((l) => md(l.en, 'en')),
      false,
    ),
    '',
    rtl(
      list(
        BEFORE_YOU_START.map((l) => md(l.ur, 'ur')),
        false,
      ),
    ),
    '',
    '## Contents',
    '',
  ];
  for (const s of GUIDE_SECTIONS) {
    const ts = tasks.filter((t) => t.section === s.id);
    parts.push(`- ${s.title.en}: ${ts.map((t) => md(t.title.en, 'en')).join('; ')}`);
  }
  parts.push('');
  for (const s of GUIDE_SECTIONS) {
    parts.push('---', '', `## ${both(s.title)}`, '', s.blurb.en, '');
    for (const t of tasks.filter((x) => x.section === s.id)) parts.push(task(t));
  }
  parts.push('---', '', MAINTAINER_NOTES);
  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
