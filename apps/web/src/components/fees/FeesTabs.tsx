import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { canCollect, canGenerate, canReadFees, canUseCash } from '@/lib/fees';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

/*
 * The Fees area as one place (PLAN 2026-10-13: Fees hub = Counter / Defaulters / Billing / Cash
 * tabs; Concessions, Sponsors, Fee register and Collection under "More"). Links, not ARIA tabs:
 * each is its own page and URL. Only the tabs the role's grants allow are shown. The pages under
 * "More" (concessions, sponsors, fee register) show the strip too, with "More" as the active tab.
 * On a phone the strip scrolls sideways: the clipped edge fades so it reads as "there is more".
 */
const MORE_PAGES = ['/fees/concessions', '/fees/sponsors', '/fees/register'];
const underMore = (pathname: string) =>
  pathname === '/fees' || MORE_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** Which edges of a sideways-scrolling strip hide content (start/end, logical: RTL aware). */
function useScrollEdges<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false, rtl: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const pos = Math.abs(el.scrollLeft); // negative in RTL
      const rtl = getComputedStyle(el).direction === 'rtl';
      setEdges((e) => {
        const n = { start: pos > 1, end: max - pos > 1, rtl };
        return n.start === e.start && n.end === e.end && n.rtl === e.rtl ? e : n;
      });
    };
    // Bring the current tab into view first ("More" sits at the far end on a phone).
    const current = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (current && el.scrollWidth > el.clientWidth) {
      const box = current.getBoundingClientRect();
      const outer = el.getBoundingClientRect();
      if (box.right > outer.right || box.left < outer.left)
        el.scrollLeft += box.left < outer.left ? box.left - outer.left : box.right - outer.right;
    }
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);
  return [ref, edges] as const;
}
/** A mask that fades the strip's clipped edges (left/right flip with the writing direction). */
function fadeMask(e: { start: boolean; end: boolean; rtl: boolean }) {
  if (!e.start && !e.end) return undefined;
  const from = e.rtl ? e.end : e.start;
  const to = e.rtl ? e.start : e.end;
  return `linear-gradient(to right, ${from ? 'transparent 0, #000 28px' : '#000 0'}, ${
    to ? '#000 calc(100% - 28px), transparent 100%' : '#000 100%'
  })`;
}
const TABS = [
  { to: '/fees/counter', label: 'fee.nav.counter', show: canCollect },
  { to: '/fees/defaulters', label: 'fee.nav.defaulters', show: canReadFees },
  { to: '/fees/billing', label: 'fee.nav.billing', show: canGenerate },
  { to: '/cash', label: 'fee.nav.cash', show: canUseCash },
] as const;

export function FeesTabs() {
  const { t } = useTranslation();
  const roles = useRoles();
  const { pathname } = useLocation();
  const [ref, edges] = useScrollEdges<HTMLElement>();
  const tabs = TABS.filter((x) => x.show(roles));
  if (tabs.length < 2) return null;
  const onTab = tabs.some((x) => pathname === x.to);
  const mask = fadeMask(edges);
  return (
    <nav
      ref={ref}
      aria-label={t('fee.nav.home')}
      className="-mt-2 flex gap-1 overflow-x-auto border-b [scrollbar-width:none] print:hidden"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      data-fees-tabs
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
    >
      {[
        ...tabs.map((x) => ({ to: x.to, label: t(x.label) })),
        { to: '/fees', label: t('shell.nav.more') },
      ].map((x) => {
        const on = x.to === '/fees' ? !onTab && underMore(pathname) : pathname === x.to;
        return (
          <Link
            key={x.to}
            to={x.to}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'relative inline-flex min-h-ctl shrink-0 items-center px-3 text-sm font-semibold whitespace-nowrap text-muted-foreground hover:text-foreground',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
              on &&
                'text-brand after:absolute after:inset-x-2 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-brand',
            )}
          >
            {x.label}
          </Link>
        );
      })}
    </nav>
  );
}
