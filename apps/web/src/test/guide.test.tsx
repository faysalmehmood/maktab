import type { StaffRole } from '@maktab/shared';
import { GUIDE_TASKS, tasksFor } from '@maktab/shared/guide';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EngineLabels, type EngineStep, matchPath, place, TourEngine } from '@/guide/engine';
import TourRunner from '@/guide/TourRunner';
import { initI18n, setLanguage } from '@/i18n';
import { startTour, stopTour, useActiveTour } from '@/lib/tour';
import { completedTours, markTourDone, TOURS_KEY } from '@/lib/tour-done';
import { GuideHome, GuideTaskPage } from '@/pages/guide/Guide';
import { meAs, mockApi } from './api-mock';

beforeAll(async () => {
  await initI18n('en');
});
beforeEach(() => {
  localStorage.clear();
  stopTour();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await act(() => setLanguage('en'));
  document.documentElement.dir = 'ltr';
});

/** jsdom lays nothing out: give connected elements a box so the engine sees them as shown. */
function layout() {
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = Number((this as HTMLElement).dataset?.top ?? 100);
    return {
      top,
      left: 40,
      width: 200,
      height: 40,
      bottom: top + 40,
      right: 240,
      x: 40,
      y: top,
      toJSON() {},
    } as DOMRect;
  });
}

const labels: EngineLabels = {
  next: 'Next',
  back: 'Back',
  skip: 'Skip tour',
  finish: 'Finish',
  counter: (i, n) => `Step ${i} of ${n}`,
  skipped: 'A step was skipped',
  waiting: 'Waiting for you',
  label: 'Guided tour',
};

const routesClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** A tiny app: two "screens" with targets, the engine on top, and the current path shown. */
function TourApp({
  steps,
  onClose,
  start = '/a',
  extra,
}: {
  steps: EngineStep[];
  onClose: (done: boolean) => void;
  start?: string;
  extra?: React.ReactNode;
}) {
  return (
    <MemoryRouter initialEntries={[start]}>
      <Harness steps={steps} onClose={onClose} extra={extra} />
    </MemoryRouter>
  );
}

function Harness({
  steps,
  onClose,
  extra,
}: {
  steps: EngineStep[];
  onClose: (d: boolean) => void;
  extra?: React.ReactNode;
}) {
  const location = useLocation();
  const [nav, setNav] = useState<string | null>(null);
  return (
    <>
      <p data-testid="path">{nav ?? location.pathname}</p>
      <Routes>
        <Route
          path="/a"
          element={
            <div>
              <button type="button" data-tour="one">
                one
              </button>
              <button type="button" data-tour="two">
                two
              </button>
              {extra}
            </div>
          }
        />
        <Route path="/b" element={<input data-tour="three" aria-label="three" />} />
      </Routes>
      <TourEngine
        steps={steps}
        labels={labels}
        pathname={nav ?? location.pathname}
        navigate={(to) => setNav(to)}
        onClose={onClose}
        rtl={document.documentElement.dir === 'rtl'}
        timeoutMs={150}
      />
    </>
  );
}

const card = () => document.querySelector('[data-tour-card]') as HTMLElement;
const shownStep = async (i: number) =>
  waitFor(() => {
    expect(card().dataset.step).toBe(String(i));
    expect(card().dataset.phase).not.toBe('seek');
  });

describe('tour engine', () => {
  const steps: EngineStep[] = [
    { path: '/a', target: 'one', title: 'First', body: 'Body one' },
    { path: '/a', target: 'two', title: 'Second', body: 'Body two' },
    { path: '/b', target: 'three', title: 'Third', body: 'Body three' },
  ];

  it('steps forward and back, counts, spotlights the target, navigates when a step needs another route', async () => {
    layout();
    const onClose = vi.fn();
    render(<TourApp steps={steps} onClose={onClose} />);
    await shownStep(0);
    expect(within(card()).getByText('Step 1 of 3')).toBeTruthy();
    expect(within(card()).getByRole('heading', { name: 'First' })).toBeTruthy();
    expect(document.querySelector('[data-tour-spot]')).toBeTruthy();
    // The dim never takes clicks; the card does.
    expect(document.querySelector('[data-tour-overlay]')?.className).toContain(
      'pointer-events-none',
    );
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    await shownStep(1);
    fireEvent.click(within(card()).getByRole('button', { name: 'Back' }));
    await shownStep(0);
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    await shownStep(1);
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    // Step 3 lives on /b: the engine asks the router to go there.
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/b'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc closes without completing; Finish on the last step completes', async () => {
    layout();
    const onClose = vi.fn();
    const two = steps.slice(0, 2);
    const { unmount } = render(<TourApp steps={two} onClose={onClose} />);
    await shownStep(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenLastCalledWith(false);
    unmount();
    render(<TourApp steps={two} onClose={onClose} />);
    await shownStep(0);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    await shownStep(1);
    expect(within(card()).getByRole('button', { name: 'Finish' })).toBeTruthy();
    fireEvent.click(within(card()).getByRole('button', { name: 'Finish' }));
    expect(onClose).toHaveBeenLastCalledWith(true);
  });

  it('arrows follow the reading direction: in Urdu (rtl) ← is forward, → is back', async () => {
    layout();
    document.documentElement.dir = 'rtl';
    render(<TourApp steps={steps.slice(0, 2)} onClose={vi.fn()} />);
    await shownStep(0);
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await shownStep(1);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    await shownStep(0);
  });

  it('a missing target is skipped with a note; a waiting step waits, then anchors', async () => {
    layout();
    const missing: EngineStep[] = [
      { path: '/a', target: 'nowhere', title: 'Gone', body: '' },
      { path: '/a', target: 'two', title: 'Second', body: '' },
    ];
    const { unmount } = render(<TourApp steps={missing} onClose={vi.fn()} />);
    await shownStep(1);
    expect(within(card()).getByRole('status').textContent).toBe('A step was skipped');
    unmount();

    function Late() {
      const [on, setOn] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOn(true)}>
            reveal
          </button>
          {on && <span data-tour="late">late</span>}
        </>
      );
    }
    const waiting: EngineStep[] = [
      { path: '/a', target: 'late', wait: true, title: 'Late', body: '' },
    ];
    render(<TourApp steps={waiting} onClose={vi.fn()} extra={<Late />} />);
    await waitFor(() => expect(card().dataset.phase).toBe('waiting'));
    expect(within(card()).getByRole('status').textContent).toBe('Waiting for you');
    fireEvent.click(screen.getByRole('button', { name: 'reveal' }));
    await waitFor(() => expect(card().dataset.phase).toBe('shown'));
  });

  it('a click step presses the link inside its row target', async () => {
    layout();
    const clicked = vi.fn();
    const row: EngineStep[] = [
      { path: '/a', target: 'row', click: true, title: 'Row', body: '' },
      { path: '/a', target: 'one', title: 'Next one', body: '' },
    ];
    render(
      <TourApp
        steps={row}
        onClose={vi.fn()}
        extra={
          <ul>
            <li data-tour="row">
              <button type="button" onClick={clicked}>
                open
              </button>
            </li>
          </ul>
        }
      />,
    );
    await shownStep(0);
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('places the card: under the target, its start edge (right in Urdu), above when no room, sheets on a phone', () => {
    const t = { top: 100, left: 600, width: 200, height: 40 };
    const view = { w: 1280, h: 800 };
    const safe = { top: 56, bottom: 800 };
    const ltr = place(t, 200, view, safe, false);
    expect(ltr).toMatchObject({ mode: 'below', top: 152, left: 600, width: 360 });
    const rtl = place(t, 200, view, safe, true);
    // The card's right edge lines up with the target's right edge.
    expect(rtl.left + rtl.width).toBe(800);
    const low = place({ ...t, top: 700 }, 200, view, safe, false);
    expect(low.mode).toBe('above');
    expect(low.top).toBe(700 - 12 - 200);
    // Never under the sticky bars: the bottom bar at 720 keeps the card above it.
    const bars = place({ ...t, top: 600 }, 200, view, { top: 56, bottom: 720 }, false);
    expect(bars.top + 200).toBeLessThanOrEqual(720 - 16);
    // Phone: full width with a 16 px gutter, away from the target's half.
    const phone = { w: 390, h: 844 };
    expect(
      place({ ...t, top: 120, left: 16 }, 180, phone, { top: 56, bottom: 788 }, false),
    ).toMatchObject({
      mode: 'sheet-bottom',
      left: 16,
      width: 358,
    });
    expect(
      place({ ...t, top: 700, left: 16 }, 180, phone, { top: 56, bottom: 788 }, true),
    ).toMatchObject({
      mode: 'sheet-top',
      top: 72,
    });
    expect(place(null, 180, view, safe, false).mode).toBe('center');
  });

  it('matches route patterns', () => {
    expect(matchPath('/students/:id', '/students/01J')).toBe(true);
    expect(matchPath('/students/:id', '/students')).toBe(false);
    expect(matchPath('/fees/counter', '/fees/counter')).toBe(true);
  });
});

describe('tours remembered per user (maktab.tours)', () => {
  it('stores finished tours under the user id', () => {
    markTourDone('U1', 'collect-fee');
    markTourDone('U1', 'collect-fee');
    markTourDone('U2', 'backups');
    expect(completedTours('U1')).toEqual(['collect-fee']);
    expect(JSON.parse(localStorage.getItem(TOURS_KEY) ?? '{}')).toEqual({
      U1: ['collect-fee'],
      U2: ['backups'],
    });
    expect(completedTours(undefined)).toEqual([]);
  });

  it('a real task tour run to the end is marked done for the signed-in user', async () => {
    layout();
    const me = meAs(['owner']);
    const client = routesClient();
    client.setQueryData(['me'], me);
    function Host() {
      const active = useActiveTour();
      return active ? <TourRunner key={active.key} task={active.task} /> : null;
    }
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/fees/billing']}>
          <div data-tour="billing-fines">fines</div>
          <button type="button" data-tour="fines-preview">
            preview
          </button>
          <Host />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    act(() => startTour('apply-fines'));
    await shownStep(0);
    expect(within(card()).getByText('Step 1 of 2')).toBeTruthy();
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    await shownStep(1);
    fireEvent.click(within(card()).getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(document.querySelector('[data-tour-card]')).toBeNull());
    expect(completedTours(me.user.id)).toEqual(['apply-fines']);
  });
});

describe('/guide routes per role', () => {
  const at = (path: string, roles: StaffRole[]) => {
    mockApi({});
    const client = routesClient();
    client.setQueryData(['me'], meAs(roles));
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/guide" element={<GuideHome />} />
            <Route path="/guide/:taskId" element={<GuideTaskPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };
  const taskLinks = () =>
    [...document.querySelectorAll('a[href^="/guide/"]')]
      .map((a) => a.getAttribute('href') ?? '')
      .filter((h) => !h.includes('#'));

  for (const role of ['owner', 'admin', 'accountant', 'teacher'] as const)
    it(`${role}: the landing lists exactly the role's tasks`, async () => {
      at('/guide', [role]);
      await screen.findByRole('heading', { level: 1, name: 'Help & guide' });
      const want = tasksFor([role]).map((t) => `/guide/${t.id}`);
      expect(new Set(taskLinks())).toEqual(new Set(want));
      expect(!!document.getElementById('guide-start')).toBe(role === 'owner' || role === 'admin');
    });

  it('a task page: numbered steps, mistakes, Show me (when it has a tour), screen links', async () => {
    at('/guide/collect-fee', ['accountant']);
    await screen.findByRole('heading', { level: 1, name: 'Collect a fee and give the receipt' });
    const steps = document.querySelectorAll('[data-guide-steps] > li');
    expect(steps.length).toBe(GUIDE_TASKS.find((t) => t.id === 'collect-fee')?.steps.length);
    expect(screen.getByRole('heading', { name: 'Common mistakes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show me' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Fee counter/ }).length).toBeGreaterThan(0);
  });

  it('guards: a teacher opening an office task goes back to /guide', async () => {
    at('/guide/collect-fee', ['teacher']);
    await screen.findByRole('heading', { level: 1, name: 'Help & guide' });
    expect(screen.queryByText('Collect a fee and give the receipt')).toBeNull();
  });

  it('an unknown task goes back to /guide', async () => {
    at('/guide/nope', ['owner']);
    await screen.findByRole('heading', { level: 1, name: 'Help & guide' });
  });

  it('Urdu: steps quote the Urdu screen labels (in an Urdu run), numbers stay Latin', async () => {
    await act(() => setLanguage('ur'));
    at('/guide/take-attendance', ['teacher']);
    const save = await waitFor(() => {
      const el = document.querySelector('[data-label="attendance.save"] bdi');
      if (!el) throw new Error('no label');
      return el as HTMLElement;
    });
    expect(save.getAttribute('dir')).toBe('rtl');
    expect(save.getAttribute('lang')).toBe('ur');
    expect(/[؀-ۿ]/.test(save.textContent ?? '')).toBe(true);
    expect(document.querySelector('[data-guide-steps] li span')?.textContent).toBe('1');
  });

  it('Show me starts the task tour', async () => {
    at('/guide/take-attendance', ['teacher']);
    let active: ReturnType<typeof useActiveTour> = null;
    function Spy() {
      active = useActiveTour();
      return null;
    }
    render(<Spy />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show me' }));
    await waitFor(() => expect(active?.task).toBe('take-attendance'));
  });
});
