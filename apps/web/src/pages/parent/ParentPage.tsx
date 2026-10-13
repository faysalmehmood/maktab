import {
  formatDmy,
  formatPkPhone,
  joinNames,
  type MessageLang,
  monthLabel,
  normalizePkPhone,
  PARENT_TOKEN_HEADER,
  type ParentChildDto,
  type ParentGateResultDto,
  type ParentPageDto,
  type ParentReceiptDto,
  type ReceiptPrintDto,
  renderTemplate,
  telUrl,
  wasFor,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { ArrowLeft, Lock, Phone, Printer, Square, Volume2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReceiptPrint } from '@/components/fees/ReceiptPrint';
import { ErrorNote, Num } from '@/components/form';
import { LanguageToggle } from '@/components/LanguageToggle';
import { MARK, MessageText, WithValue } from '@/components/messages/common';
import { Turnstile } from '@/components/Turnstile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { currentLanguage, setLanguage } from '@/i18n';
import { ApiError, apiFetch } from '@/lib/api';
import { money } from '@/lib/fees';
import { printWhenReady } from '@/lib/print';
import { cn } from '@/lib/utils';

/**
 * The parent page (PLAN §7, §14.10): public, reached by the magic link `/p#<token>`, never a staff
 * session. The token is the URL fragment (never sent to a server, never in a Referer); the page
 * sends it in the X-Parent-Token header. Plain fetches (no cookies, no redirect to /login), the
 * gate token kept for this tab only, the language choice never saved, noindex while mounted.
 */

/** The link token from `#<token>` (43 base64url characters); '' when absent or malformed. */
export function tokenFromHash(hash: string): string {
  const t = hash.replace(/^#/, '');
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : '';
}

function useLinkToken(): string {
  const [token, setToken] = useState(() =>
    typeof location !== 'undefined' ? tokenFromHash(location.hash) : '',
  );
  useEffect(() => {
    const on = () => setToken(tokenFromHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return token;
}

const gateStorageKey = (token: string) => `maktab.pgate.${token.slice(0, 12)}`;

function readGate(token: string): string | null {
  try {
    return sessionStorage.getItem(gateStorageKey(token));
  } catch {
    return null;
  }
}

function writeGate(token: string, value: string | null): void {
  try {
    if (value) sessionStorage.setItem(gateStorageKey(token), value);
    else sessionStorage.removeItem(gateStorageKey(token));
  } catch {
    // Storage blocked: the check is asked again after a reload; nothing else breaks.
  }
}

const parentFetch = <T,>(
  path: string,
  token: string,
  gate: string | null,
  init: RequestInit = {},
): Promise<T> =>
  apiFetch(path, {
    ...init,
    credentials: 'omit',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      [PARENT_TOKEN_HEADER]: token,
      ...(gate ? { 'x-parent-gate': gate } : {}),
    },
  }) as Promise<T>;

/** The parent receipt (a whitelist) in the shape the shared paper receipt renders. */
function printShape(p: ParentReceiptDto): ReceiptPrintDto {
  return {
    // The logo comes from /api/p/logo (token header → blob URL) in ReceiptView.
    school: {
      name: p.school.name,
      name_ur: p.school.name_ur,
      address: p.school.address,
      phone: p.school.phone,
      has_logo: !!p.school.logo_v,
    },
    labels: p.labels,
    lang: p.lang,
    receipt: {
      id: '',
      receipt_no: p.receipt.receipt_no,
      kind: 'payment',
      reverses_id: null,
      reversed_by: null,
      payer_type: 'family',
      payer_id: '',
      payer_name: p.receipt.payer_name,
      amount: p.receipt.amount,
      method: p.receipt.method,
      account_id: null,
      collector_id: '',
      collector_name: null,
      cash_session_id: null,
      business_date: p.receipt.business_date,
      reference: null,
      note: null,
      created_at: '',
    },
    students: p.students.map((s) => ({
      student_id: `child-${s.child}`,
      student_name: s.first_name,
      admission_no: '',
      lines: s.lines.map((l, i) => ({ charge_id: `${s.child}-${i}`, ...l })),
      subtotal: s.subtotal,
    })),
    totals: p.totals,
    reversed: p.reversed,
  };
}

function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

const STATUS_STYLE: Record<NonNullable<ParentChildDto['today']>, string> = {
  P: 'bg-ok-soft text-ok',
  A: 'bg-bad-soft text-bad',
  L: 'bg-warn-soft text-warn',
  E: 'bg-info-soft text-info',
};

const synth = (): SpeechSynthesis | null =>
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof SpeechSynthesisUtterance !== 'undefined'
    ? window.speechSynthesis
    : null;

/** What "Listen" says: today's attendance per child and the fees to pay, in `lang`. */
export function spokenSummary(data: ParentPageDto, tt: TFunction): string {
  const parts = [String(tt('msg.parent.speech.greeting'))];
  for (const c of data.children)
    parts.push(
      String(
        tt('msg.parent.speech.child', {
          name: c.first_name,
          status: tt(`msg.parent.todayStatus.${c.today ?? 'none'}`),
        }),
      ),
    );
  if (data.dues)
    parts.push(
      data.dues.total > 0
        ? String(
            tt('msg.parent.speech.dues', {
              amount: Math.round(data.dues.total / 100).toLocaleString('en-US'),
            }),
          )
        : String(tt('msg.parent.speech.noDues')),
    );
  return parts.join(' ');
}

function ListenButton({ data }: { data: ParentPageDto }) {
  const { t, i18n } = useTranslation();
  const [speaking, setSpeaking] = useState(false);
  const s = synth();
  useEffect(() => () => s?.cancel(), [s]);
  if (!s) return null;
  const speak = () => {
    if (speaking) {
      s.cancel();
      setSpeaking(false);
      return;
    }
    s.cancel();
    const lang = currentLanguage();
    const urVoice = s.getVoices().find((v) => v.lang.toLowerCase().startsWith('ur'));
    // No Urdu voice on the phone: an English summary in the default voice beats Urdu read wrongly.
    const speakLang: MessageLang = lang === 'ur' && urVoice ? 'ur' : 'en';
    const u = new SpeechSynthesisUtterance(spokenSummary(data, i18n.getFixedT(speakLang)));
    if (speakLang === 'ur' && urVoice) {
      u.voice = urVoice;
      u.lang = urVoice.lang;
    } else u.lang = 'en';
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    s.speak(u);
    setSpeaking(true);
  };
  return (
    <Button id="parent-listen" variant="outline" size="sm" onClick={speak}>
      {speaking ? <Square aria-hidden /> : <Volume2 aria-hidden />}
      {speaking ? t('msg.parent.stop') : t('msg.parent.listen')}
    </Button>
  );
}

function GateForm({
  token,
  kind,
  turnstileSiteKey,
  onPassed,
}: {
  token: string;
  kind: 'birth_year' | 'pin';
  turnstileSiteKey: string | null;
  onPassed: (gate: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [value, setValue] = useState('');
  const [human, setHuman] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const r = await parentFetch<ParentGateResultDto>('/api/p/gate', token, null, {
        method: 'POST',
        body: JSON.stringify({
          ...(kind === 'birth_year' ? { birth_year: Number(v) } : { pin: v }),
          ...(human ? { turnstile_token: human } : {}),
        }),
      });
      onPassed(r.gate_token);
    } catch (err) {
      setError(err);
      // A Turnstile token is good for one answer: a fresh widget for the next try.
      if (turnstileSiteKey) setRound((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="gap-3 border-primary/40 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2">
          <Lock aria-hidden className="size-4" />
          {t('msg.parent.gateTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <form id="parent-gate" className="flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
          <Label htmlFor="parent-gate-input">
            {kind === 'birth_year' ? t('msg.parent.gateBirth') : t('msg.parent.gatePin')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="parent-gate-input"
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              className="num max-w-40"
              maxLength={kind === 'birth_year' ? 4 : 6}
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
            />
            <Button type="submit" disabled={busy || !value || (!!turnstileSiteKey && !human)}>
              {t('msg.parent.gateSubmit')}
            </Button>
          </div>
          {turnstileSiteKey ? (
            <Turnstile
              siteKey={turnstileSiteKey}
              lang={i18n.language}
              onToken={setHuman}
              resetKey={round}
            />
          ) : null}
          <p className="text-xs text-muted-foreground">{t('msg.parent.gateWhy')}</p>
          <ErrorNote error={error} />
        </form>
      </CardContent>
    </Card>
  );
}

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <Card className="gap-3 py-4" id={id}>
      <CardHeader className="px-4">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4">{children}</CardContent>
    </Card>
  );
}

function ChildCard({ c }: { c: ParentChildDto }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <bdi className="text-lg font-semibold">{c.first_name}</bdi>
        {c.group && (
          <span className="text-sm text-muted-foreground">
            <bdi>{c.group}</bdi>
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('msg.parent.today')}</span>
        <span
          className={cn(
            'rounded-md px-2 py-0.5 font-medium',
            c.today ? STATUS_STYLE[c.today] : 'bg-muted text-muted-foreground',
          )}
        >
          {t(`msg.parent.todayStatus.${c.today ?? 'none'}`)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-muted-foreground">{t('msg.parent.month')}</span>
        {c.month.pct !== null && (
          <span className="font-semibold">
            <Num>{`${c.month.pct}%`}</Num>
          </span>
        )}
        <span>
          {t('msg.parent.present')} <Num>{c.month.present}</Num>
        </span>
        <span>
          {t('msg.parent.absent')} <Num>{c.month.absent}</Num>
        </span>
        {c.month.late > 0 && (
          <span>
            {t('msg.parent.late')} <Num>{c.month.late}</Num>
          </span>
        )}
        {c.month.excused > 0 && (
          <span>
            {t('msg.parent.excused')} <Num>{c.month.excused}</Num>
          </span>
        )}
      </div>
    </li>
  );
}

function Dues({ dues, lang }: { dues: NonNullable<ParentPageDto['dues']>; lang: MessageLang }) {
  const { t } = useTranslation();
  return (
    <Section id="parent-dues" title={t('msg.parent.dues')}>
      {dues.total <= 0 && dues.lines.length === 0 ? (
        <p>{t('msg.parent.noDues')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-muted-foreground">{t('msg.parent.toPay')}</span>
            <span id="parent-total" className="text-2xl font-semibold">
              <Num>{money(dues.total)}</Num>
            </span>
            {dues.overdue > 0 && (
              <Badge variant="destructive">
                {t('msg.parent.overdue')} <Num>{money(dues.overdue)}</Num>
              </Badge>
            )}
          </div>
          <details className="rounded-md border">
            <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
              {t('msg.parent.howCalc')}
            </summary>
            <div className="overflow-x-auto px-3 pb-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 text-start font-normal">{t('msg.parent.period')}</th>
                    <th className="py-1 text-end font-normal">{t('msg.parent.net')}</th>
                    <th className="py-1 text-end font-normal">{t('msg.parent.paid')}</th>
                    <th className="py-1 text-end font-normal">{t('msg.parent.due')}</th>
                  </tr>
                </thead>
                <tbody>
                  {dues.lines.map((l) => (
                    <tr
                      key={`${l.child}|${l.head_name}|${l.period_key}|${l.due_date}`}
                      className="border-t"
                    >
                      <td className="py-1">
                        <bdi className="font-medium">{l.child}</bdi>
                        {' · '}
                        <bdi>{lang === 'ur' && l.head_name_ur ? l.head_name_ur : l.head_name}</bdi>
                        <br />
                        <bdi className="text-xs text-muted-foreground">
                          {monthLabel(l.period_key, lang)}
                        </bdi>
                      </td>
                      <td className="py-1 text-end">
                        <Num>{money(l.net)}</Num>
                      </td>
                      <td className="py-1 text-end">
                        <Num>{money(l.paid)}</Num>
                      </td>
                      <td className="py-1 text-end font-medium">
                        <Num>{money(l.due)}</Num>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t">
                    <td colSpan={3} className="py-1">
                      {t('msg.parent.beforeCredit')}
                    </td>
                    <td className="py-1 text-end">
                      <Num>{money(dues.total_before_credit)}</Num>
                    </td>
                  </tr>
                  {dues.credit > 0 && (
                    <tr>
                      <td colSpan={3} className="py-1">
                        {t('msg.parent.credit')}
                      </td>
                      <td className="py-1 text-end">
                        <Num>{`− ${money(dues.credit)}`}</Num>
                      </td>
                    </tr>
                  )}
                  <tr className="border-t font-semibold">
                    <td colSpan={3} className="py-1">
                      {t('msg.parent.total')}
                    </td>
                    <td className="py-1 text-end">
                      <Num>{money(dues.total)}</Num>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </details>
        </>
      )}
    </Section>
  );
}

/**
 * The school logo for the parent receipt: an <img> cannot send X-Parent-Token, so it is fetched
 * (the versioned URL lets the browser cache it for a week) and shown from a blob URL.
 */
function useParentLogo(
  token: string,
  version: string | null,
  path: '/api/p/logo' | '/api/p/badge' = '/api/p/logo',
): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!version) return;
    let url: string | null = null;
    let live = true;
    fetch(`${path}?v=${encodeURIComponent(version)}`, {
      credentials: 'omit',
      headers: { [PARENT_TOKEN_HEADER]: token },
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!live || !b) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, version, path]);
  return src;
}

/**
 * The school's picture for the parent page (M7b): its logo, else the generated badge from
 * /api/p/badge, both token-gated and fetched by version (an <img> cannot send the token header).
 */
function useSchoolPicture(
  token: string,
  school: { logo_v: string | null; badge_v: string | null } | undefined,
): string | null {
  const logo = school?.logo_v ?? null;
  return useParentLogo(
    token,
    logo ?? school?.badge_v ?? null,
    logo ? '/api/p/logo' : '/api/p/badge',
  );
}

function ReceiptView({
  token,
  no,
  gate,
  onBack,
}: {
  token: string;
  no: string;
  gate: string | null;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const q = useQuery({
    queryKey: ['parent-receipt', token, no, gate],
    queryFn: () =>
      parentFetch<ParentReceiptDto>(`/api/p/receipt/${encodeURIComponent(no)}`, token, gate),
    retry: false,
  });
  const lang = i18n.language === 'ur' ? 'ur' : 'en';
  const logo = useSchoolPicture(token, q.data?.school);
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button id="parent-receipt-back" variant="outline" onClick={onBack}>
          <ArrowLeft aria-hidden className="rtl:-scale-x-100" />
          {t('msg.parent.back')}
        </Button>
        {q.data && (
          <Button onClick={() => void printWhenReady()}>
            <Printer aria-hidden />
            {t('msg.parent.print')}
          </Button>
        )}
      </div>
      {q.isPending && <p className="text-muted-foreground">{t('common.loading')}</p>}
      <ErrorNote error={q.error} />
      {q.data && (
        <div className="overflow-x-auto">
          <ReceiptPrint
            data={{
              ...printShape(q.data),
              school: { ...printShape(q.data).school, has_logo: !!logo },
            }}
            fmt="a5"
            lang={lang}
            publicCopy
            logoSrc={logo ?? undefined}
          />
        </div>
      )}
    </section>
  );
}

function Invalid() {
  const { t } = useTranslation();
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-3 p-4">
      <div className="flex justify-end">
        <LanguageToggle />
      </div>
      <Card className="gap-2 py-6">
        <CardContent className="flex flex-col gap-2 px-4">
          <h1 id="parent-invalid" className="text-xl font-semibold">
            {t('msg.parent.invalidTitle')}
          </h1>
          <p className="text-muted-foreground">{t('msg.parent.invalidBody')}</p>
        </CardContent>
      </Card>
    </main>
  );
}

/** A notice body is a template: fill what the page knows (school, children, date); no link. */
function noticeText(
  body: string,
  lang: MessageLang,
  data: ParentPageDto,
  school: string,
  at: string,
): string {
  return renderTemplate(body, {
    school,
    children: joinNames(
      data.children.map((c) => c.first_name),
      lang,
    ),
    child: data.children[0]?.first_name ?? '',
    was: wasFor(data.children.length, lang),
    date: formatDmy(at.slice(0, 10)),
  });
}

export function ParentPage() {
  const token = useLinkToken();
  const { t, i18n } = useTranslation();
  useNoIndex();
  const [gate, setGate] = useState<string | null>(() => readGate(token));
  const [receipt, setReceipt] = useState<string | null>(null);
  const langSet = useRef(false);
  const q = useQuery({
    queryKey: ['parent-page', token, gate],
    queryFn: () => parentFetch<ParentPageDto>('/api/p', token, gate),
    enabled: !!token,
    retry: false,
    staleTime: 30_000,
  });
  const data = q.data;
  const picture = useSchoolPicture(token ?? '', data?.school);

  // First load: the page speaks the guardian's language; the toggle changes it afterwards.
  useEffect(() => {
    if (!data || langSet.current) return;
    langSet.current = true;
    const want = data.guardian.lang === 'ur' ? 'ur' : 'en';
    if (currentLanguage() !== want) void setLanguage(want);
  }, [data]);

  // A stored gate token that no longer passes (expired) is dropped, so the check is asked again.
  useEffect(() => {
    if (data && gate && data.gate.kind !== 'none' && !data.gate.passed) {
      writeGate(token, null);
      setGate(null);
    }
  }, [data, gate, token]);

  if (!token) return <Invalid />;
  if (q.isPending) return <p className="p-4 text-muted-foreground">{t('common.loading')}</p>;
  if (q.error instanceof ApiError && q.error.status === 404) return <Invalid />;
  if (!data)
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-3 p-4">
        <ErrorNote error={q.error} />
        <Button className="self-start" onClick={() => void q.refetch()}>
          {t('common.retry')}
        </Button>
      </main>
    );
  if (receipt)
    return <ReceiptView token={token} no={receipt} gate={gate} onBack={() => setReceipt(null)} />;

  const lang: MessageLang = i18n.language === 'ur' ? 'ur' : 'en';
  const school = lang === 'ur' && data.school.name_ur ? data.school.name_ur : data.school.name;
  const schoolTel = normalizePkPhone(data.school.phone ?? '')?.number;
  const needsGate = data.gate.kind !== 'none' && !data.gate.passed;

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        {picture && (
          <img
            src={picture}
            alt=""
            width={44}
            height={44}
            id="parent-school-mark"
            className="size-11 shrink-0 rounded-full bg-white object-contain"
          />
        )}
        <h1 className="text-lg font-semibold">
          <bdi>{school}</bdi>
        </h1>
        <div className="ms-auto flex items-center gap-2">
          <ListenButton data={data} />
          <LanguageToggle />
        </div>
      </header>
      <p className="text-xl">
        <WithValue sentence={t('msg.parent.hello', { name: MARK })}>
          {data.guardian.first_name}
        </WithValue>
      </p>
      <p id="parent-private" className="flex gap-2 rounded-md bg-warn-soft p-3 text-sm text-warn">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t('msg.parent.private')}
      </p>

      <ul className="flex flex-col gap-2">
        {data.children.map((c) => (
          <ChildCard key={c.index} c={c} />
        ))}
      </ul>

      {needsGate && data.gate.kind !== 'none' ? (
        <GateForm
          token={token}
          kind={data.gate.kind}
          turnstileSiteKey={data.turnstile_site_key ?? null}
          onPassed={(g) => {
            writeGate(token, g);
            setGate(g);
          }}
        />
      ) : (
        <>
          {data.dues ? (
            <Dues dues={data.dues} lang={lang} />
          ) : (
            <Section title={t('msg.parent.dues')}>
              <p>{t('msg.parent.noDues')}</p>
            </Section>
          )}
          <Section id="parent-receipts" title={t('msg.parent.receipts')}>
            {!data.receipts?.length ? (
              <p className="text-sm text-muted-foreground">{t('msg.parent.noReceipts')}</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {data.receipts.map((r) => (
                  <li key={r.receipt_no}>
                    <button
                      type="button"
                      id={`parent-receipt-${r.receipt_no}`}
                      aria-label={t('msg.parent.receiptOpen', { no: r.receipt_no })}
                      onClick={() => setReceipt(r.receipt_no)}
                      className="flex min-h-11 w-full flex-wrap items-center gap-2 text-start hover:bg-accent"
                    >
                      <Num>{r.receipt_no}</Num>
                      <span className="text-sm text-muted-foreground">
                        <Num>{formatDmy(r.business_date)}</Num>
                      </span>
                      <span className="ms-auto font-medium">
                        <Num>{money(r.amount)}</Num>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <Section id="parent-notices" title={t('msg.parent.notices')}>
        {data.notices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('msg.parent.noNotices')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.notices.map((n) => {
              const useUr = lang === 'ur' ? !!n.body_ur || !n.body_en : !n.body_en && !!n.body_ur;
              const textLang: MessageLang = useUr ? 'ur' : 'en';
              const body = useUr ? n.body_ur : n.body_en;
              const name =
                textLang === 'ur' && data.school.name_ur ? data.school.name_ur : data.school.name;
              return (
                <li
                  key={`${n.at}|${n.body_en}|${n.body_ur}`}
                  className="flex flex-col gap-1 border-b pb-2 last:border-0"
                >
                  <span className="text-xs text-muted-foreground">
                    <Num>{formatDmy(n.at.slice(0, 10))}</Num>
                  </span>
                  <MessageText
                    text={noticeText(body, textLang, data, name, n.at)}
                    lang={textLang}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {schoolTel && (
        <Button asChild variant="outline" className="self-start">
          <a href={telUrl(schoolTel)}>
            <Phone aria-hidden />
            {t('msg.parent.callSchool')} <Num>{formatPkPhone(data.school.phone)}</Num>
          </a>
        </Button>
      )}
    </main>
  );
}
