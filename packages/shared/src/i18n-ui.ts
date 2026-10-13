/**
 * M7b UI/UX dictionary (UI plan §5–7): the grouped shell, the school's identity, the sign-in page,
 * the five-step setup and the role homes. Merged into i18n.ts as `shell`, `brand`, `door`, `wizard`
 * and `home`. English is the source of truth; Urdu (i18n-ur.ts) must match its shape. Numbers only
 * as {{placeholders}} (Latin digits, isolated by the caller).
 */

export const shellEn = {
  skip: 'Skip to content',
  groups: { people: 'People', daily: 'Daily work', money: 'Money', school: 'School' },
  nav: {
    home: 'Home',
    classes: 'Classes',
    messages: 'Messages',
    payroll: 'Payroll',
    more: 'More',
    moreTitle: 'Everything else',
  },
  search: {
    label: 'Search students',
    placeholder: 'Search students, admission no. or phone',
    short: 'Search students',
    none: 'No student matches this search.',
    all: 'See all results',
    searching: 'Searching…',
  },
  sync: {
    saved: 'All changes saved',
    waiting: '{{n}} waiting to sync',
    offline: 'Offline',
  },
  account: {
    menu: 'Account menu',
    theme: 'Theme',
    themes: { system: 'Auto', light: 'Light', dark: 'Dark' },
  },
  /** StatStrip comparison ("Up 12%" vs last month). */
  compare: {
    up: 'Up {{pct}}%',
    down: 'Down {{pct}}%',
    upNoPct: 'Up',
    downNoPct: 'Down',
    same: 'No change',
    vs: 'vs {{month}}',
  },
  rowMenu: 'More actions',
  filters: {
    open: 'Filters',
    title: 'Filters',
    applied: 'Filters applied',
    clear: 'Remove this filter',
    clearAll: 'Clear all',
    done: 'Show results',
  },
} as const;

export const brandEn = {
  runsOn: 'Runs on Maktab',
  badgeOf: '{{name}} badge',
  shortName: 'Short name',
  shortNameHelp: 'Up to 4 letters, shown in the badge.',
  shortNameNeeded:
    'The school name has no English letters, so type 2–3 letters for the badge (for example GSA).',
  city: 'City',
  colour: 'School colour',
  colours: { teal: 'Teal', blue: 'Blue', maroon: 'Maroon', purple: 'Purple', green: 'Green' },
  logoOrBadge: 'Logo',
  badgeNote: 'No logo yet? This badge is used until you add one.',
  uploadLogo: 'Upload a logo',
  changeLogo: 'Change logo',
} as const;

export const doorEn = {
  staffTitle: 'Staff sign-in',
  parentTitle: 'Are you a parent?',
  parentBody:
    'Parents do not sign in here. Open the link the school sent you on WhatsApp, or call the office.',
  parentCall: 'Office phone',
} as const;

export const wizardEn = {
  title: 'Set up your school',
  stepOf: 'Step {{n}} of {{total}}',
  partOf: 'Part {{n}} of {{total}}',
  stages: {
    identity: 'Your school',
    classes: 'Classes and sections',
    fees: 'Fees',
    people: 'Staff',
    done: 'Done',
  },
  identityHelp: 'This is what staff and parents will see. You can change it later in Settings.',
  preview: 'How it will look',
  previewReceipt: 'fee receipt',
  previewShell: 'Top of the app on a phone',
  continue: 'Continue',
  summary: {
    title: 'What you set up',
    classes: 'Classes and sections',
    rates: 'Fee rates',
    staff: 'Staff invited',
  },
} as const;

export const homeEn = {
  greeting: {
    morning: 'Good morning, {{name}}',
    afternoon: 'Good afternoon, {{name}}',
    evening: 'Good evening, {{name}}',
  },
  collect: 'Collect a fee',
  cardError: 'Could not load this. Check the connection and try again.',
  cardOffline: 'Offline: this will load when the connection is back.',
  registers: {
    title: 'Attendance registers',
    takenOf: '{{taken}} of {{total}} taken',
    help: 'Each block is one class. Dashed blocks still need a register.',
    take: 'Take {{name}}',
    allTaken: 'All registers are taken.',
    none: 'No class has a register today.',
  },
  collected: {
    title: 'Collected today',
    receipts: 'Payments by method',
    nothing: 'Nothing collected yet today.',
    open: 'Open fee counter',
  },
  messages: {
    title: 'Messages to send',
    waiting: '{{n}} waiting',
    byKind: 'Waiting messages by kind',
    toSend_one: '{{count}} message to send',
    toSend_other: '{{count}} messages to send',
    none: 'Nothing is waiting to be sent.',
    start: 'Start sending',
  },
  attention: {
    title: 'Needs attention',
    clear: 'Nothing needs attention right now.',
    failed:
      'Could not check everything. Some items may be missing here; try again when the connection is back.',
    offline: 'Offline: what needs attention cannot be checked until the connection is back.',
    tags: {
      attendance: 'Attendance',
      fees: 'Fees',
      cash: 'Cash',
      billing: 'Billing',
      system: 'System',
    },
    registers: 'Registers not taken yet: {{n}}',
    registersGo: 'Take them',
    defaulters: 'Students past the due date: {{n}}',
    defaultersGo: 'See defaulters',
    drawer: 'Your cash drawer is open',
    drawerGo: 'Open drawer',
    billing: 'Groups where monthly billing keeps failing: {{n}}',
    billingGo: 'Open billing',
    alarm: '{{kind}}: {{n}}',
    alarmGo: 'Open backup',
  },
  month: {
    title: 'This month',
    dues: 'Dues outstanding',
  },
  absent: {
    title: 'Absent today',
    none: 'Nobody is absent today.',
  },
  teacher: {
    registers: 'Your registers today',
    messages: 'Messages',
    messagesBody: 'Absence messages for your classes wait in the send queue.',
    openQueue: 'Open messages',
  },
  accountant: {
    drawer: 'Your cash drawer',
    drawerOpen: 'Drawer open, expecting',
    drawerClosed: 'Not open today.',
    openDrawer: 'Open cash drawer',
  },
} as const;
