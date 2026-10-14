import type { StaffRole } from '@maktab/shared';
import { GUIDE_TASKS, GUIDE_UI, tasksFor } from '@maktab/shared/guide';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EngineEmpty,
  type EngineLabels,
  type EngineStep,
  keysBelongElsewhere,
  matchPath,
  place,
  safeArea,
  TourEngine,
} from '@/guide/engine';
import TourRunner, { isolateNumbers } from '@/guide/TourRunner';
import { initI18n, setLanguage } from '@/i18n';
import { startTour, stopTour, tourFor, useActiveTour } from '@/lib/tour';
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
  start = '/a',
  ...props
}: {
  steps: EngineStep[];
  onClose: (done: boolean) => void;
  start?: string;
  extra?: React.ReactNode;
  empty?: EngineEmpty;
  timeoutMs?: number;
}) {
  return (
    <MemoryRouter initialEntries={[start]}>
      <Harness {...props} />
    </MemoryRouter>
  );
}

function Harness({
  steps,
  onClose,
  extra,
  empty,
  timeoutMs = 150,
}: {
  steps: EngineStep[];
  onClose: (d: boolean) => void;
  extra?: React.ReactNode;
  empty?: EngineEmpty;
  timeoutMs?: number;
}) {
  const location = useLocation();
  const [nav, setNav] = useState<string | null>(null);
  return (
    <>
      <p data-testid="path">{nav ?? location.pathname}</p>
      <button type="button" onClick={() => setNav('/elsewhere')}>
        elsewhere
      </button>
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
        empty={empty}
        labels={labels}
        pathname={nav ?? location.pathname}
        navigate={(to) => setNav(to)}
        onClose={onClose}
        rtl={document.documentElement.dir === 'rtl'}
        timeoutMs={timeoutMs}
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

  it('first-week shape: a fresh school shows the checklist; a completed school shows the vacant card, then goes on to the next screen', async () => {
    layout();
    const tour: EngineStep[] = [
      {
        path: '/a',
        target: 'checklist',
        optional: true,
        vacant: { title: 'Your first week is done', body: 'Where the checklist lived' },
        title: 'Your checklist',
        body: '',
      },
      { path: '/b', target: 'three', title: 'Settings', body: '' },
    ];
    // Fresh school: the card is there.
    const fresh = render(
      <TourApp steps={tour} onClose={vi.fn()} extra={<p data-tour="checklist">list</p>} />,
    );
    await shownStep(0);
    expect(within(card()).getByRole('heading', { name: 'Your checklist' })).toBeTruthy();
    fresh.unmount();
    // Completed school: no card. Step 1 shows the vacant card (not skipped), Next reaches /b.
    render(<TourApp steps={tour} onClose={vi.fn()} />);
    await waitFor(() => expect(card().dataset.phase).toBe('vacant'));
    expect(within(card()).getByRole('heading', { name: 'Your first week is done' })).toBeTruthy();
    expect(screen.queryByText('A step was skipped')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/b'));
    await shownStep(1);
  });

  it("a skipped step still navigates to the next step's screen", async () => {
    layout();
    const onClose = vi.fn();
    render(
      <TourApp
        steps={[
          { path: '/a', target: 'gone', title: 'Gone', body: '' },
          { path: '/b', target: 'three', title: 'Third', body: '' },
        ]}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/b'));
    await shownStep(1);
    expect(within(card()).getByText('A step was skipped')).toBeTruthy();
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

  it('a waiting step says so at once; a screen with nothing to show ends on the empty card', async () => {
    layout();
    const waiting: EngineStep[] = [
      { path: '/a', target: 'later', wait: true, title: 'Later', body: '' },
    ];
    const { unmount } = render(<TourApp steps={waiting} onClose={vi.fn()} timeoutMs={60_000} />);
    // Long before any timeout: the card is visible and says it waits.
    await waitFor(() => expect(card().dataset.phase).toBe('waiting'), { timeout: 300 });
    expect(card().className).not.toContain('invisible');
    unmount();

    const onClose = vi.fn();
    const queue: EngineStep[] = [
      { path: '/a', target: 'one', title: 'Counts', body: '' },
      { path: '/a', target: 'row', title: 'Open in WhatsApp', body: '' },
      { path: '/a', target: 'skip', title: 'Skip', body: '' },
    ];
    render(
      <TourApp
        steps={queue}
        onClose={onClose}
        timeoutMs={60_000}
        empty={{ target: 'blank', title: 'Nothing to send', body: 'Empty queue' }}
        extra={<p data-tour="blank">Nothing waiting here.</p>}
      />,
    );
    await shownStep(0);
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(card().dataset.phase).toBe('empty'));
    expect(within(card()).getByRole('heading', { name: 'Nothing to send' })).toBeTruthy();
    expect(document.querySelector('[data-tour-spot]')).toBeTruthy();
    fireEvent.click(within(card()).getByRole('button', { name: 'Finish' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('focus: the card takes it when shown, never from a field being typed in, never while waiting', async () => {
    layout();
    const { unmount } = render(<TourApp steps={steps.slice(0, 2)} onClose={vi.fn()} />);
    await shownStep(0);
    expect(document.activeElement).toBe(card());
    unmount();

    // Someone is typing in a field when the step appears: the field keeps focus.
    const typing: EngineStep[] = [{ path: '/a', target: 'two', title: 'Two', body: '' }];
    const field = (
      <input
        aria-label="name"
        ref={(el) => {
          el?.focus();
        }}
      />
    );
    const second = render(<TourApp steps={typing} onClose={vi.fn()} extra={field} />);
    await shownStep(0);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'name' }));
    second.unmount();

    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    render(
      <TourApp
        steps={[{ path: '/a', target: 'later', wait: true, title: 'Later', body: '' }]}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(card().dataset.phase).toBe('waiting'));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('closes when the app leaves every screen the rest of the tour is on', async () => {
    layout();
    const onClose = vi.fn();
    const { unmount } = render(<TourApp steps={steps.slice(0, 2)} onClose={onClose} />);
    await shownStep(0);
    fireEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
    unmount();

    // Going on to a later step's screen (/b is step 3) is part of the tour: it stays open.
    const stay = vi.fn();
    render(<TourApp steps={steps} onClose={stay} />);
    await shownStep(0);
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    await shownStep(1);
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/b'));
    expect(stay).not.toHaveBeenCalled();
  });

  it('leaves ←/→/Esc to tabs, radios, listboxes, fields and other dialogs', async () => {
    layout();
    const onClose = vi.fn();
    render(
      <TourApp
        steps={steps.slice(0, 2)}
        onClose={onClose}
        extra={
          <>
            <div role="tablist">
              <button type="button" role="tab" aria-selected>
                tab
              </button>
            </div>
            <div role="radiogroup">
              {/* biome-ignore lint/a11y/useSemanticElements: a custom radio, as Radix renders one */}
              <span role="radio" aria-checked tabIndex={0}>
                radio
              </span>
            </div>
            <input aria-label="field" />
            <div role="dialog" aria-label="other">
              <button type="button">in dialog</button>
            </div>
          </>
        }
      />,
    );
    await shownStep(0);
    const tab = screen.getByRole('tab');
    for (const key of ['ArrowRight', 'ArrowLeft', 'Escape']) {
      fireEvent.keyDown(tab, { key });
      fireEvent.keyDown(screen.getByRole('radio'), { key });
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'field' }), { key });
      fireEvent.keyDown(screen.getByRole('button', { name: 'in dialog' }), { key });
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(card().dataset.step).toBe('0');
    expect(onClose).not.toHaveBeenCalled();
    expect(keysBelongElsewhere(card())).toBe(false);
    // From the card itself (or the page), the keys drive the tour.
    fireEvent.keyDown(card(), { key: 'ArrowRight' });
    await shownStep(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('Urdu counter: only the numbers are isolated', () => {
    render(<p data-testid="counter">{isolateNumbers(GUIDE_UI.counter, 'ur', { i: 2, n: 5 })}</p>);
    const p = screen.getByTestId('counter');
    expect(p.textContent).toBe('قدم 2 از 5');
    expect([...p.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['2', '5']);
    expect(p.firstChild?.nodeType).toBe(Node.TEXT_NODE);
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

  it('places beside the target on a wide screen when above and below do not fit', () => {
    const view = { w: 1280, h: 800 };
    const t = { top: 300, left: 300, width: 400, height: 380 };
    const p = place(t, 220, view, { top: 56, bottom: 800 }, false);
    expect(p.mode).toBe('side');
    expect(p.left).toBe(712);
    // Urdu prefers the start (left) side.
    expect(place({ ...t, left: 700 }, 220, view, { top: 56, bottom: 800 }, true).mode).toBe('side');
    // No room on either side: falls back (phone-width screens never use sides).
    expect(
      place({ ...t, left: 20, width: 1240 }, 220, view, { top: 56, bottom: 800 }, false).mode,
    ).toBe('below');
  });

  it('safeArea: only a fixed/sticky bar at the viewport bottom is a bottom bar; a mid-page bar is content', () => {
    const bar = (attr: string, pos: string, top: number, h: number) => {
      const el = document.createElement('div');
      el.setAttribute(attr, '');
      el.style.position = pos;
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + h, left: 0, right: 100, width: 100, height: h }) as DOMRect;
      document.body.append(el);
      return el;
    };
    const mid = bar('data-action-bar', 'sticky', 400, 70);
    expect(safeArea(800)).toEqual({ top: 0, bottom: 800 });
    mid.remove();
    const stuck = bar('data-action-bar', 'sticky', 700, 70);
    expect(safeArea(800).bottom).toBe(700);
    stuck.remove();
    const static_ = bar('data-action-bar', 'static', 700, 70);
    expect(safeArea(800).bottom).toBe(800);
    static_.remove();
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
    act(() => startTour('apply-fines', me.user.id));
    await shownStep(0);
    expect(card().querySelector('[data-tour-counter]')?.textContent).toBe('Step 1 of 2');
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    await shownStep(1);
    fireEvent.click(within(card()).getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(document.querySelector('[data-tour-card]')).toBeNull());
    expect(completedTours(me.user.id)).toEqual(['apply-fines']);
  });
});

describe('the running tour belongs to one user', () => {
  it('another account never sees it; stopTour clears it', () => {
    startTour('collect-fee', 'U1');
    let seen: ReturnType<typeof useActiveTour> = null;
    function Spy() {
      seen = useActiveTour();
      return null;
    }
    render(<Spy />);
    expect(tourFor(seen, 'U1')?.task).toBe('collect-fee');
    expect(tourFor(seen, 'U2')).toBeNull();
    expect(tourFor(seen, undefined)).toBeNull();
    act(() => stopTour());
    expect(seen).toBeNull();
  });

  it('closing a tour gives focus back to its Show me button', async () => {
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
          <button type="button" data-show-me="apply-fines">
            Show me
          </button>
          <div data-tour="billing-fines">fines</div>
          <Host />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    act(() => startTour('apply-fines', me.user.id));
    await shownStep(0);
    expect(document.activeElement).toBe(card());
    fireEvent.click(within(card()).getByRole('button', { name: 'Skip tour' }));
    await waitFor(() => expect(document.querySelector('[data-tour-card]')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show me' }));
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
      // Only an owner runs setup and invites staff: the first week is the owner's.
      expect(!!document.getElementById('guide-start')).toBe(role === 'owner');
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
