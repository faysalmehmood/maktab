import type { Paged, StudentListItem } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { getJson } from '@/lib/api';
import { canReadStudents, useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

/** How many matches the dropdown shows; "See all results" opens the Students list with the query. */
export const SEARCH_LIMIT = 6;

/** The search query: same endpoint and scope as the Students list (teachers get their groups only). */
export const searchUrl = (q: string) =>
  `/api/students?${new URLSearchParams({ q, status: 'active', page: '1' })}`;

function useDebounced(value: string, ms = 250): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

/**
 * Top-bar student search (UI plan §5.3): name, admission number or guardian phone; picks open the
 * profile. The server scopes the answer like the Students list (a teacher sees their own groups).
 * Hidden for a role that cannot read students.
 */
export function GlobalSearch() {
  const { t } = useTranslation();
  const roles = useRoles();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = useDebounced(text.trim());
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const allowed = canReadStudents(roles);
  const res = useQuery({
    queryKey: ['student-search', q],
    queryFn: () => getJson<Paged<StudentListItem>>(searchUrl(q)),
    enabled: allowed && q.length >= 2,
    staleTime: 30_000,
  });
  const items = (res.data?.items ?? []).slice(0, SEARCH_LIMIT);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  if (!allowed) return <div className="flex-1" />;

  const go = (path: string) => {
    setOpen(false);
    setText('');
    navigate(path);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = items[active];
      if (pick) go(`/students/${pick.id}`);
      else if (text.trim()) go(`/students?q=${encodeURIComponent(text.trim())}`);
    }
  };
  const showList = open && q.length >= 2;

  return (
    <div ref={box} className="relative min-w-0 flex-1 md:max-w-md">
      <Search
        className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={t('shell.search.label')}
        placeholder={t('shell.search.short')}
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className="h-ctl w-full min-w-0 rounded-lg border bg-background ps-9 pe-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 md:text-sm"
      />
      {showList && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('shell.search.label')}
          className="absolute inset-x-0 top-full z-40 mt-1.5 flex flex-col rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {res.isFetching && items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{t('shell.search.searching')}</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{t('shell.search.none')}</p>
          ) : (
            items.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onClick={() => go(`/students/${s.id}`)}
                className={cn(
                  'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-start hover:bg-accent',
                  i === active && 'bg-accent',
                )}
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold text-brand"
                  aria-hidden
                >
                  {initials(s.name)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    <bdi>{s.name}</bdi>
                  </span>
                  <span className="truncate text-meta text-muted-foreground">
                    {s.group_name ? <bdi>{s.group_name}</bdi> : '—'}
                  </span>
                </span>
                <bdi className="num text-meta text-muted-foreground">{s.admission_no}</bdi>
              </button>
            ))
          )}
          {res.data && res.data.total > items.length && (
            <button
              type="button"
              onClick={() => go(`/students?q=${encodeURIComponent(q)}`)}
              className="min-h-11 rounded-lg px-3 text-start text-sm font-semibold text-brand hover:bg-accent"
            >
              {t('shell.search.all')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
