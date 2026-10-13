import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

/*
 * The "Show me" tour engine (in-house, lazy). Each step highlights `[data-tour="<target>"]` with a
 * spotlight (a cut-out in a dimmed screen) and a card: title, body, step counter, Back / Next /
 * Skip. The dim never takes clicks (the page, its sticky bars included, stays usable) and the card
 * is placed between the sticky top bar and the bottom bars. Steps may change the route (a path to
 * navigate to, or a target that Next clicks); a target that never appears is skipped with a note,
 * unless the step waits for the user to do something first (the card says so at once). A tour may
 * declare an empty-state card, shown instead of skipping when the screen has nothing to point at.
 * The tour closes when the app leaves every screen its remaining steps are on.
 *
 * Focus and keys: the card takes focus when it points at something, never while the user is typing
 * in a field and never while it waits for the user. ←/→/Esc are left alone where they already mean
 * something: fields, tabs, radio groups, listboxes and other dialogs.
 */

export type EngineStep = {
  path?: string;
  target: string;
  click?: boolean;
  wait?: boolean;
  title: ReactNode;
  body: ReactNode;
};

/** The card for a screen with nothing to show (e.g. an empty send queue). */
export type EngineEmpty = { target: string; title: ReactNode; body: ReactNode };

export type EngineLabels = {
  next: string;
  back: string;
  skip: string;
  finish: string;
  counter: (i: number, n: number) => ReactNode;
  skipped: string;
  waiting: string;
  label: string;
};

export type Rect = { top: number; left: number; width: number; height: number };
export type Placement = {
  top: number;
  left: number;
  width: number;
  mode: 'below' | 'above' | 'sheet-top' | 'sheet-bottom' | 'center';
};

/** Does a route pattern ("/students/:id") match a pathname? */
export function matchPath(pattern: string, pathname: string): boolean {
  const a = pattern.split('/').filter(Boolean);
  const b = pathname.split('/').filter(Boolean);
  return a.length === b.length && a.every((s, i) => (s.startsWith(':') ? !!b[i] : s === b[i]));
}

/** The step's element, if it is on the page and rendered (a hidden phone/desktop twin is not). */
export function findTarget(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`))
    if (el.getClientRects().length > 0) return el;
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
const M = 16;
const GAP = 12;

/**
 * Where the card goes (pure). Phone (< 640 px): a full-width card at the bottom of the safe area,
 * or at its top when the target sits in the lower half. Wider: under the target (above it if there
 * is no room), lined up with the target's start edge: its left in English, its right in Urdu.
 */
export function place(
  t: Rect | null,
  cardH: number,
  view: { w: number; h: number },
  safe: { top: number; bottom: number },
  rtl: boolean,
): Placement {
  const phone = view.w < 640;
  const width = Math.min(phone ? view.w - 2 * M : 360, view.w - 2 * M);
  const bottomSheet: Placement = {
    top: safe.bottom - cardH - M,
    left: M,
    width,
    mode: 'sheet-bottom',
  };
  if (!t)
    return phone
      ? bottomSheet
      : {
          top: clamp((view.h - cardH) / 2, safe.top + M, safe.bottom - cardH - M),
          left: (view.w - width) / 2,
          width,
          mode: 'center',
        };
  if (phone)
    return t.top + t.height / 2 > (safe.top + safe.bottom) / 2
      ? { top: safe.top + M, left: M, width, mode: 'sheet-top' }
      : bottomSheet;
  const left = clamp(rtl ? t.left + t.width - width : t.left, M, view.w - width - M);
  const below = t.top + t.height + GAP;
  if (below + cardH <= safe.bottom - M) return { top: below, left, width, mode: 'below' };
  const above = t.top - GAP - cardH;
  if (above >= safe.top + M) return { top: above, left, width, mode: 'above' };
  return { top: clamp(below, safe.top + M, safe.bottom - cardH - M), left, width, mode: 'below' };
}

/** The band between the sticky top bar and any bottom bar (tab bar, save bars). */
export function safeArea(viewH: number): { top: number; bottom: number } {
  let top = 0;
  let bottom = viewH;
  for (const el of document.querySelectorAll<HTMLElement>(
    '[data-tour-bar], [data-action-bar], #tabbar',
  )) {
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= 0 || r.top >= viewH) continue;
    if (r.top < viewH / 2) top = Math.max(top, r.bottom);
    else bottom = Math.min(bottom, r.top);
  }
  return { top, bottom };
}

const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};

const editable = (t: unknown) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/**
 * Keys the tour must not take: typing in a field, arrows in a tab list / radio group / listbox,
 * and anything inside another dialog (its Esc closes it, not the tour).
 */
export function keysBelongElsewhere(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (editable(t) || t.closest('[role=tab],[role=radio],[role=option]')) return true;
  const dialog = t.closest('[role=dialog],[role=alertdialog]');
  return !!dialog && !dialog.hasAttribute('data-tour-card');
}

/** Does any of these steps belong on this path (a step without a path is on every screen)? */
const onAnyStep = (steps: readonly EngineStep[], pathname: string) =>
  steps.some((s) => !s.path || matchPath(s.path, pathname));

type Pos = { i: number; dir: 1 | -1; by: 'user' | 'skip'; skipped: boolean };

export function TourEngine({
  steps,
  empty,
  labels,
  pathname,
  navigate,
  onClose,
  rtl,
  timeoutMs = 800,
}: {
  steps: readonly EngineStep[];
  empty?: EngineEmpty;
  labels: EngineLabels;
  pathname: string;
  navigate: (to: string) => void;
  /** `true` when the last step was finished with Next. */
  onClose: (completed: boolean) => void;
  rtl: boolean;
  /** How long a missing target is looked for (once on its screen) before the step is skipped. */
  timeoutMs?: number;
}) {
  const [pos, setPos] = useState<Pos>({ i: 0, dir: 1, by: 'user', skipped: false });
  const [phase, setPhase] = useState<'seek' | 'shown' | 'waiting' | 'missing' | 'empty'>('seek');
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(180);
  const [view, setView] = useState({ w: innerWidth, h: innerHeight });
  const [reseek, setReseek] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLElement | null>(null);
  const path = useRef(pathname);
  path.current = pathname;
  const at = useRef(pos.i);
  at.current = pos.i;
  const step = steps[pos.i];
  const last = pos.i === steps.length - 1;

  // Entering a step on purpose (start, Next, Back) goes to its screen; a skip never moves you.
  useEffect(() => {
    const p = steps[pos.i]?.path;
    if (pos.by === 'user' && p && !p.includes(':') && !matchPath(p, path.current)) navigate(p);
  }, [pos, steps, navigate]);

  // Find the target: poll (routes and lazy screens take a moment), then skip, wait or show the
  // empty card. The skip clock starts once the app is on the step's screen; a step that waits for
  // the user says so at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reseek restarts the search on purpose
  useEffect(() => {
    if (!step) return;
    setPhase('seek');
    setRect(null);
    el.current = null;
    const started = Date.now();
    let here: number | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const anchor = (found: HTMLElement, as: 'shown' | 'empty') => {
      clearInterval(timer);
      el.current = found;
      const reduce = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      found.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      setRect(rectOf(found));
      setPhase(as);
      return true;
    };
    const tick = () => {
      const onScreen = !step.path || matchPath(step.path, path.current);
      const found = onScreen ? findTarget(step.target) : null;
      if (found) return anchor(found, 'shown');
      const blank = onScreen && empty ? findTarget(empty.target) : null;
      if (blank) return anchor(blank, 'empty');
      if (step.wait) {
        setPhase('waiting');
        return false;
      }
      if (onScreen) here ??= Date.now();
      // Not there yet (navigating, a lazy screen): wait, but not for ever.
      const since = here ?? started + 4000;
      if (Date.now() - since < timeoutMs) return false;
      clearInterval(timer);
      const next = pos.i + pos.dir;
      if (next >= 0 && next < steps.length)
        setPos({ i: next, dir: pos.dir, by: 'skip', skipped: true });
      else setPhase('missing');
      return true;
    };
    if (!tick()) timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [pos, step, steps.length, timeoutMs, reseek, empty]);

  // The app left every screen the rest of the tour is on (the user went elsewhere): close.
  const seenPath = useRef(pathname);
  useEffect(() => {
    if (pathname === seenPath.current) return;
    seenPath.current = pathname;
    if (!onAnyStep(steps.slice(at.current), pathname)) keys.current.onClose(false);
  }, [pathname, steps]);

  // Follow the target while it is shown (scroll, resize, layout); look again if it goes away.
  useEffect(() => {
    if (phase !== 'shown' && phase !== 'empty') return;
    const follow = () => {
      setView({ w: innerWidth, h: innerHeight });
      if (el.current?.isConnected && el.current.getClientRects().length > 0)
        setRect(rectOf(el.current));
      else setReseek((n) => n + 1);
    };
    addEventListener('scroll', follow, true);
    addEventListener('resize', follow);
    const timer = setInterval(follow, 400);
    return () => {
      removeEventListener('scroll', follow, true);
      removeEventListener('resize', follow);
      clearInterval(timer);
    };
  }, [phase]);

  useLayoutEffect(() => {
    const h = card.current?.offsetHeight;
    if (h && h !== cardH) setCardH(h);
  });

  // The card takes focus when it points at something (Tab reaches its buttons; screen readers read
  // it), but never out of a field the user is typing in, and not while it waits for the user.
  useEffect(() => {
    if (phase === 'seek' || phase === 'waiting' || editable(document.activeElement)) return;
    card.current?.focus({ preventScroll: true });
  }, [phase]);

  const next = () => {
    if (step?.click && el.current && phase === 'shown') {
      // A row target: press the link or button inside it (an <li> itself does nothing).
      const t = el.current;
      const press = t.matches('a,button,[role=tab]')
        ? t
        : (t.querySelector<HTMLElement>('a,button,[role=tab]') ?? t);
      press.click();
    }
    if (phase === 'empty') onClose(false);
    else if (last) onClose(phase !== 'missing');
    else setPos({ i: pos.i + 1, dir: 1, by: 'user', skipped: false });
  };
  const back = () => {
    if (pos.i > 0) setPos({ i: pos.i - 1, dir: -1, by: 'user', skipped: false });
  };
  const keys = useRef({ next, back, onClose });
  keys.current = { next, back, onClose };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      if (e.altKey || e.ctrlKey || e.metaKey || keysBelongElsewhere(e.target)) return;
      e.preventDefault();
      if (e.key === 'Escape') {
        keys.current.onClose(false);
        return;
      }
      // Arrows follow the reading direction: in Urdu, ← is forward.
      if ((e.key === 'ArrowRight') !== rtl) keys.current.next();
      else keys.current.back();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rtl]);

  if (!step) return null;
  const blank = phase === 'empty' && empty;
  const shown = (phase === 'shown' || phase === 'empty') && rect;
  const pl = place(shown ? rect : null, cardH, view, safeArea(view.h), rtl);
  const PAD = 6;

  return createPortal(
    <div data-tour-overlay className="pointer-events-none fixed inset-0 z-[70]">
      {shown && (
        <div
          data-tour-spot
          style={{
            top: rect.top - PAD,
            left: Math.max(2, rect.left - PAD),
            width: Math.min(rect.width + PAD * 2, view.w - 4 - Math.max(2, rect.left - PAD)),
            height: rect.height + PAD * 2,
          }}
          className="absolute rounded-xl shadow-[0_0_0_9999px_rgb(6_18_16/0.5)] ring-2 ring-brand motion-safe:transition-all motion-safe:duration-200"
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-roledescription={labels.label}
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        data-tour-card
        data-step={pos.i}
        data-phase={phase}
        data-placement={pl.mode}
        style={{ top: pl.top, left: pl.left, width: pl.width }}
        className={`pointer-events-auto absolute flex flex-col gap-2.5 rounded-xl border border-s-4 border-s-brand bg-popover p-4 text-popover-foreground shadow-2xl outline-none ${phase === 'seek' ? 'invisible' : ''}`}
      >
        <p data-tour-counter className="num text-meta font-semibold text-brand">
          {labels.counter(pos.i + 1, steps.length)}
        </p>
        <h2 id="tour-title" className="text-section font-semibold">
          {blank ? empty.title : step.title}
        </h2>
        <div id="tour-body" className="text-sm leading-relaxed">
          {blank ? empty.body : step.body}
        </div>
        {(pos.skipped || phase === 'missing') && (
          <p role="status" className="rounded-md bg-warn-soft px-2.5 py-1.5 text-meta text-warn">
            {labels.skipped}
          </p>
        )}
        {phase === 'waiting' && (
          <p role="status" className="rounded-md bg-info-soft px-2.5 py-1.5 text-meta text-info">
            {labels.waiting}
          </p>
        )}
        <div className="mt-1 flex items-center gap-2">
          <Button variant="ghost" className="-ms-2" onClick={() => onClose(false)}>
            {labels.skip}
          </Button>
          <span className="flex-1" />
          {pos.i > 0 && (
            <Button variant="outline" onClick={back}>
              {labels.back}
            </Button>
          )}
          <Button onClick={next} data-tour-next>
            {last || blank ? labels.finish : labels.next}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
