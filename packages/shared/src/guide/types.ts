/**
 * The in-app Help & Guide (and docs/onboarding.md, generated from the same text): one typed source
 * so the web guide and the repo doc never drift. Every visible string is a pair of English and Urdu.
 */

/** One text in both languages. Urdu as a school office speaks it; Latin digits; English button names. */
export type L = { readonly en: string; readonly ur: string };

export type GuideLang = keyof L;

/** Staff roles the guide speaks to (the parent page has no guide). */
export type GuideRole = 'owner' | 'admin' | 'accountant' | 'teacher';

export type GuideSectionId =
  | 'start'
  | 'daily'
  | 'office'
  | 'month'
  | 'parents'
  | 'staff'
  | 'safe'
  | 'phone';

export type GuideSection = { readonly id: GuideSectionId; readonly title: L; readonly blurb: L };

/** A numbered step of a task. `id` makes it linkable (/guide/<task>#<id>); `to` opens the screen. */
export type GuideStep = { readonly text: L; readonly id?: string; readonly to?: string };

/**
 * One step of a "Show me" tour. The engine highlights `[data-tour="<target>"]`.
 * - `path`: the screen it is on (`:param` segments allowed). If the app is elsewhere and the path has
 *   no params, the tour navigates there; with params it waits for the user to get there.
 * - `click`: Next clicks the target (e.g. a tab, or a row that opens the next screen).
 * - `wait`: the target appears only after the user does something (opens a family, picks a class),
 *   so the tour waits for it instead of skipping.
 */
export type TourStep = {
  readonly path?: string;
  readonly target: string;
  readonly click?: boolean;
  readonly wait?: boolean;
  /** The target may be absent (e.g. a card that goes away when done): `vacant` is shown instead of skipping. */
  readonly optional?: boolean;
  readonly vacant?: { readonly title: L; readonly body: L };
  readonly title: L;
  readonly body: L;
};

export type GuideTask = {
  readonly id: string;
  readonly section: GuideSectionId;
  /** Who sees it in the guide (and may open its page). */
  readonly roles: readonly GuideRole[];
  readonly title: L;
  /** One sentence for the card. */
  readonly summary: L;
  readonly steps: readonly GuideStep[];
  readonly mistakes: readonly L[];
  /** Screens to open from the task page. */
  readonly links: readonly { readonly to: string; readonly label: L }[];
  readonly tour?: readonly TourStep[];
  /**
   * What the tour shows when the screen has nothing to point at (an empty list): if a step's target
   * is missing and `[data-tour="<target>"]` is on the screen, the tour ends on this card instead
   * of skipping step after step.
   */
  readonly tourEmpty?: { readonly target: string; readonly title: L; readonly body: L };
};
