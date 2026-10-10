import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StudentFeesCard } from '@/components/fees/StudentFees';
import { FeeSetup } from '@/components/fees/setup';
import { initI18n, setLanguage } from '@/i18n';
import { BillingPage } from '@/pages/fees/Billing';
import { CashPage } from '@/pages/fees/Cash';
import { CounterPage } from '@/pages/fees/Counter';
import { DefaultersPage } from '@/pages/fees/Defaulters';
import { FamilyStatementPage } from '@/pages/fees/FamilyStatement';
import { FeesHome } from '@/pages/fees/FeesHome';
import { ReceiptPage } from '@/pages/fees/Receipt';
import { ConcessionRegisterPage, FeeRegisterPage } from '@/pages/fees/Reports';
import { SponsorDetail, SponsorsPage } from '@/pages/fees/Sponsors';
import { group, meAs, mockApi, renderAt } from './api-mock';
import {
  accounts,
  ali,
  cashSession,
  fam,
  familyLines,
  familyStatement,
  feeSettings,
  receiptId,
  receiptPrint,
} from './fee-fixtures';

const ME = meAs(['owner']).user.id;

const API = {
  [`GET /api/fees/family/${fam}`]: familyStatement(),
  'GET /api/accounts': accounts,
  'GET /api/groups': { items: [group] },
  'GET /api/programmes': { items: [{ id: group.programme_id, name: 'Class 5' }] },
  'GET /api/staff': { items: [] },
  'GET /api/school/fees': feeSettings,
  [`GET /api/receipts/${receiptId}`]: receiptPrint(),
  'GET /api/fees/defaulters': { summary_only: false, defaulters: [], total_overdue: 0 },
  'GET /api/fees/runs': {
    period: '2026-10',
    complete: true,
    cursor: null,
    failing: [],
    attention_required: 0,
    chunks: [],
  },
  'GET /api/cash/sessions': { sessions: [cashSession({ collector_id: ME })] },
  'GET /api/fees/collection': { rows: [], total: 0 },
  'GET /api/fees/heads': {
    heads: [
      {
        id: 'H-TUI',
        name: 'Tuition',
        name_ur: 'ٹیوشن',
        kind: 'tuition',
        cadence: 'monthly',
        archived: false,
      },
    ],
  },
  'GET /api/fees/rates': { rates: [] },
  'GET /api/fees/sponsors': {
    sponsors: [{ id: 'SP1', name: 'Haji Sahib', phone: null, active_students: 1, due: 100000 }],
  },
  'GET /api/fees/sponsors/SP1/statement': {
    sponsor: { id: 'SP1', name: 'Haji Sahib', phone: null },
    sponsorships: [
      {
        id: 'SS1',
        student_id: ali,
        student_name: 'Ali',
        fee_head_id: null,
        share_pct: 50,
        valid_from: '2026-04-01',
        valid_to: null,
      },
    ],
    charges: [familyLines[0]],
    receipts: [],
    credit: 0,
    dues_hash: 'h',
    totals: { net: 100000, paid: 0, due: 100000 },
  },
  'GET /api/fees/concessions/register': {
    concessions: [
      {
        id: 'K1',
        student_id: ali,
        student_name: 'Ali',
        admission_no: 'A-1',
        head_name: null,
        type: 'pct',
        value: 50,
        reason: 'topper',
        note: null,
        approved_by_name: 'O',
        valid_from: '2026-04-01',
        valid_to: null,
        ended_at: null,
        end_reason: null,
        amount_given: 150000,
      },
    ],
    total_given: 150000,
  },
  [`GET /api/fees/student/${ali}`]: {
    student: { id: ali, name: 'Ali', admission_no: 'A-1', family_id: fam },
    family_name: 'Raza family',
    lines: familyLines.filter((l) => l.student_id === ali),
    sponsored: [],
    due: 720000,
    family_due: 1600000,
    family_credit: 50000,
    concessions: [],
    sponsorships: [],
    opening_balance: null,
    receipts: [receiptPrint().receipt],
  },
};

const PAGES: [string, string, string, ReactNode][] = [
  ['fees home', '/fees', '/fees', <FeesHome key="h" />],
  ['counter', `/fees/counter?family=${fam}`, '/fees/counter', <CounterPage key="c" />],
  ['receipt', `/receipts/${receiptId}?lang=ur`, '/receipts/:id', <ReceiptPage key="r" />],
  ['family statement', `/fees/family/${fam}`, '/fees/family/:id', <FamilyStatementPage key="f" />],
  ['defaulters', '/fees/defaulters', '/fees/defaulters', <DefaultersPage key="d" />],
  ['billing', '/fees/billing', '/fees/billing', <BillingPage key="b" />],
  ['cash', '/cash', '/cash', <CashPage key="k" />],
  ['fee setup', '/settings', '/settings', <FeeSetup key="s" />],
  ['sponsors', '/fees/sponsors', '/fees/sponsors', <SponsorsPage key="sp" />],
  ['sponsor detail', '/fees/sponsors/SP1', '/fees/sponsors/:id', <SponsorDetail key="sd" />],
  [
    'concession register',
    '/fees/concessions',
    '/fees/concessions',
    <ConcessionRegisterPage key="cr" />,
  ],
  ['fee register', '/fees/register', '/fees/register', <FeeRegisterPage key="fr" />],
  [
    'student fees',
    `/students/${ali}`,
    '/students/:id',
    <StudentFeesCard key="sf" studentId={ali} studentName="Ali" />,
  ],
];

/**
 * Visible text that is not data: everything outside <bdi>/.num (names, numbers, codes), <option>
 * (data in pickers), elements marked lang="en" (the "English" toggle), and form values.
 */
function uiText(root: Element): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(n.textContent ?? '');
      return;
    }
    if (!(n instanceof Element)) return;
    if (['BDI', 'OPTION', 'SCRIPT', 'STYLE'].includes(n.tagName)) return;
    if (n.classList.contains('num') || n.getAttribute('lang') === 'en') return;
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out.join(' ');
}

beforeAll(async () => {
  await initI18n('ur');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

describe('RTL smoke: every fee page in Urdu', () => {
  it.each(PAGES)(
    '%s: dir=rtl and no English outside isolated data',
    async (_name, path, pattern, el) => {
      await act(() => setLanguage('ur'));
      mockApi(API);
      const { container } = renderAt(path, pattern, el);
      expect(document.documentElement.dir).toBe('rtl');
      // Wait for the data to land (the loading text goes away and something real renders).
      await waitFor(() => {
        const text = container.textContent ?? '';
        if (!text.trim() || text.includes('لوڈ ہو رہا ہے')) throw new Error('still loading');
      });
      await new Promise((r) => setTimeout(r, 50));
      const latin = uiText(container).match(/[A-Za-z]{2,}/g) ?? [];
      expect(latin, `untranslated: ${latin.join(', ')}`).toEqual([]);
    },
  );
});

/**
 * Lint-style: JSX in the fee screens must not carry hard-coded English. Flags text between tags
 * and user-facing string attributes (aria-label, title, placeholder, alt) that contain letters.
 */
describe('no hard-coded English in fee JSX', () => {
  const roots = ['src/pages/fees', 'src/components/fees'];
  const files = roots.flatMap((r) => {
    const dir = join(process.cwd(), r);
    return readdirSync(dir)
      .map((f) => join(dir, f))
      .filter((f) => statSync(f).isFile() && f.endsWith('.tsx'));
  });
  it('finds the files', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it('the check itself flags literals and lets translated JSX through', () => {
    expect(literals('<p>Hello there</p>')).toEqual(['Hello there']);
    expect(literals('<Button aria-label="Close">{t(\'x\')}</Button>')).toEqual([
      'aria-label="Close"',
    ]);
    expect(literals("<p>{t('fee.title')}</p>")).toEqual([]);
    expect(literals('<span lang="en">English</span>')).toEqual([]);
    expect(literals('const q = () => getJson<Foo>(url); let p: Promise<Bar>;')).toEqual([]);
    expect(literals('<li>\n  Collected today\n</li>')).toEqual(['Collected today']);
    expect(literals('<p>Total {n}</p>')).toEqual(['Total']);
    expect(literals("<p>{t('a')} <b>Due</b></p>")).toEqual(['Due']);
  });

  it.each(files.map((f) => [f.slice(f.indexOf('src/')), f]))('%s', (_short, file) => {
    expect(literals(readFileSync(file, 'utf8'))).toEqual([]);
  });
});

function literals(src: string): string[] {
  const ALLOWED = new Set(['English', 'اردو']);
  const bad: string[] = [];
  // >Text< or >Text {  (JSX children that are literal words)
  for (const m of src.matchAll(/>(\s*)([^<>{}\n]*[A-Za-z\u0600-\u06FF][^<>{}\n]*?)(\s*)([<{])/g)) {
    const text = (m[2] ?? '').trim();
    if (!text || ALLOWED.has(text)) continue;
    const start = m.index ?? 0;
    // TypeScript the regex catches is not JSX text: `=> getJson<T>(`, `: Promise<T>`, `a > b`.
    if (src[start - 1] === '=') continue;
    if (m[4] === '<' && !m[3] && src[start + m[0].length] !== '/' && /^[\w.]+$/.test(text))
      continue;
    if (/[=;()]|&&|\|\|/.test(text)) continue;
    bad.push(text);
  }
  for (const m of src.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-z][^"]*)"/g))
    bad.push(`${m[1]}="${m[2]}"`);
  return bad;
}
