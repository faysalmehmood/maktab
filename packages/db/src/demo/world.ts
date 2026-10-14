/**
 * The demo school, as pure data (no database): "Al-Noor Community School, Lahore", session 2026-27.
 * The people are a function of DEMO_SEED alone; every date is laid out relative to the seed day
 * (`DemoCalendar`, below), so the demo always looks like a school in the middle of its current month
 * (docs/demo.md). For one seed day every reseed (and every resumed step of one) sees the same people,
 * ids and plans. Names are common Pakistani names; phone numbers are visibly fake (`03XX 555 NNNN`);
 * CNICs use the 555 block too. Nothing here is a real person or organisation.
 */

export const DEMO_SEED = 20260401;
/** Months of money history, the last one being the seed day's own (partly collected) month. */
export const DEMO_MONTH_COUNT = 6;
/** Registers for the last week of school days only: a register day costs ~3 writes a student. */
export const ATTENDANCE_DAYS = 5;
export const RECEIPT_PREFIX = 'AN';

/** The fixed demo sign-ins (POST /api/auth/demo). Reserved `.invalid` TLD: never a real mailbox. */
export const DEMO_USERS = {
  principal: 'principal@alnoor-demo.invalid',
  admin: 'admin@alnoor-demo.invalid',
  accountant: 'accountant@alnoor-demo.invalid',
  teacher: 'teacher@alnoor-demo.invalid',
} as const;
export type DemoLogin = 'principal' | 'accountant' | 'teacher';

// ---- PRNG and ids -----------------------------------------------------------------------------

/** mulberry32: small, fast, good enough for fixtures; deterministic for a seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    shuffle: <T>(xs: T[]): T[] => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
      }
      return xs;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

/** A hash of a string key, to seed a per-(family, month) generator independent of call order. */
export function hashSeed(key: string): number {
  let h = 2166136261 ^ DEMO_SEED;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 2026-03-15T00:00:00Z: seed ids sort before anything a visitor creates. */
const ID_EPOCH = Date.UTC(2026, 2, 15);

/** A ULID-shaped id from a sequence number: time part = epoch + n ms, randomness from the key. */
export function demoId(n: number, key: string): string {
  let t = ID_EPOCH + n;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = rng(hashSeed(key));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(r.next() * 32)];
  return time + rand;
}

// ---- Calendar ---------------------------------------------------------------------------------

export type Holiday = { date: string; en: string; ur: string };

const addDay = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

const EID_FITR = { en: 'Eid ul Fitr', ur: 'عید الفطر' };
const EID_ADHA = { en: 'Eid ul Adha', ur: 'عید الاضحیٰ' };
const ASHURA = { en: 'Ashura', ur: 'عاشورہ' };
const MILAD = { en: 'Eid Milad un Nabi', ur: 'عید میلاد النبی' };
const IQBAL = { en: 'Iqbal Day', ur: 'یومِ اقبال' };
const QUAID = { en: 'Quaid-e-Azam Day', ur: 'یومِ قائد' };
const KASHMIR = { en: 'Kashmir Solidarity Day', ur: 'یومِ یکجہتیٔ کشمیر' };
const PAKISTAN = { en: 'Pakistan Day', ur: 'یومِ پاکستان' };
const LABOUR = { en: 'Labour Day', ur: 'یومِ مزدور' };
const AZADI = { en: 'Independence Day', ur: 'یومِ آزادی' };

/**
 * Gazetted holidays from the 2026-27 session start to the latest seed day anyone is likely to use
 * (spring 2028), so a seed day that moves forward still skips them. Islamic dates after 2026 are
 * estimates (they follow the moon sighting): Eid ul Fitr ~10 Mar 2027 and ~27 Feb 2028, Eid ul
 * Adha ~17 May 2027, Ashura ~15 Jun 2027, Eid Milad un Nabi ~15 Aug 2027.
 */
const GAZETTED: [string, { en: string; ur: string }][] = [
  ['2026-05-01', LABOUR],
  ['2026-05-27', EID_ADHA],
  ['2026-05-28', EID_ADHA],
  ['2026-05-29', EID_ADHA],
  ['2026-08-14', AZADI],
  ['2026-08-26', MILAD],
  ['2026-11-09', IQBAL],
  ['2026-12-25', QUAID],
  ['2027-02-05', KASHMIR],
  ['2027-03-10', EID_FITR],
  ['2027-03-11', EID_FITR],
  ['2027-03-12', EID_FITR],
  ['2027-03-23', PAKISTAN],
  ['2027-05-01', LABOUR],
  ['2027-05-17', EID_ADHA],
  ['2027-05-18', EID_ADHA],
  ['2027-05-19', EID_ADHA],
  ['2027-06-14', ASHURA],
  ['2027-06-15', ASHURA],
  ['2027-08-14', AZADI],
  ['2027-08-15', MILAD],
  ['2027-11-09', IQBAL],
  ['2027-12-25', QUAID],
  ['2028-02-05', KASHMIR],
  ['2028-02-27', EID_FITR],
  ['2028-02-28', EID_FITR],
  ['2028-02-29', EID_FITR],
  ['2028-03-23', PAKISTAN],
];
/** Summer vacation, 1 June to 13 August, every year (Punjab schools). */
const VACATION = (d: string) => d.slice(5) >= '06-01' && d.slice(5) <= '08-13';

const HOLIDAY_SET = new Set(GAZETTED.map(([d]) => d));

export function holidays(): Holiday[] {
  const out: Holiday[] = GAZETTED.map(([date, n]) => ({ date, ...n }));
  for (const y of ['2026', '2027'])
    for (let d = `${y}-06-01`; d <= `${y}-08-13`; d = addDay(d, 1))
      // A gazetted day inside the vacation keeps its own name (one row a date).
      if (weekday(d) !== 0 && !HOLIDAY_SET.has(d))
        out.push({ date: d, en: 'Summer vacation', ur: 'موسمِ گرما کی تعطیلات' });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The office counts cash Monday–Saturday, also in the summer vacation, never on a gazetted holiday. */
export const officeOpen = (d: string) => weekday(d) !== 0 && !HOLIDAY_SET.has(d);
/** Teaching days: office days outside the vacation. */
export const schoolDay = (d: string) => officeOpen(d) && !VACATION(d);

export function daysOf(period: string): string[] {
  const out: string[] = [];
  for (let d = `${period}-01`; d.startsWith(period); d = addDay(d, 1)) out.push(d);
  return out;
}
export const officeDays = (period: string) => daysOf(period).filter(officeOpen);
/** The first office day on or after `d` (within its month, else the month's last office day). */
export function officeDayFrom(d: string): string {
  const days = officeDays(d.slice(0, 7));
  return days.find((x) => x >= d) ?? (days.at(-1) as string);
}

/** `YYYY-MM` plus n months (n may be negative). */
export function addMonths(period: string, n: number): string {
  const t = Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export { addDay };

/** The seed day: today in Asia/Karachi (UTC+5, no DST), the school's calendar day. */
export const demoToday = (nowMs = Date.now()): string =>
  new Date(nowMs + 5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Where the dataset sits in time. Everything dated is derived from `today` (the seed day), so the
 * home screens show a school mid-month: the current month billed and partly collected, today's
 * drawer open, today's registers partly taken. The session stays 2026-27; it is stretched to
 * contain the six months when the seed day falls outside it (the demo never invents a new session).
 */
export type DemoCalendar = {
  today: string;
  /** DEMO_MONTH_COUNT months, oldest first; the last is today's. */
  months: string[];
  current: string;
  /** First day of the history: continuing students' enrolments, openings and concessions. */
  start: string;
  sessionStart: string;
  sessionEnd: string;
  /** The last ATTENDANCE_DAYS school days up to and including today. */
  attendanceDays: string[];
};

const calendars = new Map<string, DemoCalendar>();
export function demoCalendar(today: string): DemoCalendar {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(Date.parse(`${today}T00:00:00Z`)))
    throw new Error(`demo calendar: bad date ${today}`);
  const hit = calendars.get(today);
  if (hit) return hit;
  const current = today.slice(0, 7);
  const months = Array.from({ length: DEMO_MONTH_COUNT }, (_, i) =>
    addMonths(current, i - DEMO_MONTH_COUNT + 1),
  );
  const start = `${months[0]}-01`;
  const end = daysOf(current).at(-1) as string;
  const attendance: string[] = [];
  for (let d = today; attendance.length < ATTENDANCE_DAYS; d = addDay(d, -1))
    if (schoolDay(d)) attendance.unshift(d);
  const cal: DemoCalendar = {
    today,
    months,
    current,
    start,
    sessionStart: start < '2026-04-01' ? start : '2026-04-01',
    sessionEnd: end > '2027-03-31' ? end : '2027-03-31',
    attendanceDays: attendance,
  };
  calendars.set(today, cal);
  return cal;
}

const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTHS_UR = [
  'جنوری',
  'فروری',
  'مارچ',
  'اپریل',
  'مئی',
  'جون',
  'جولائی',
  'اگست',
  'ستمبر',
  'اکتوبر',
  'نومبر',
  'دسمبر',
];
/** A month's name, for the few free texts (notes, a notice) that mention a date. */
export const monthName = (period: string, lang: 'en' | 'ur' = 'en') =>
  (lang === 'ur' ? MONTHS_UR : MONTHS_EN)[Number(period.slice(5, 7)) - 1] as string;

// ---- Names ------------------------------------------------------------------------------------

const SURNAMES = [
  'Khan',
  'Ahmed',
  'Malik',
  'Butt',
  'Qureshi',
  'Sheikh',
  'Chaudhry',
  'Awan',
  'Rana',
  'Siddiqui',
  'Hashmi',
  'Bhatti',
  'Mughal',
  'Raja',
  'Mirza',
  'Ansari',
  'Rizvi',
  'Javed',
  'Aslam',
  'Hussain',
  'Abbasi',
  'Gill',
  'Cheema',
  'Warraich',
  'Bajwa',
  'Lodhi',
  'Niazi',
  'Shah',
  'Gilani',
  'Kazmi',
  'Naqvi',
  'Arain',
  'Jutt',
  'Dar',
  'Anjum',
  'Saleem',
  'Rafiq',
  'Akram',
  'Nadeem',
  'Zafar',
];
const FATHERS = [
  'Muhammad Asif',
  'Tariq Mahmood',
  'Imran Ali',
  'Khalid Hussain',
  'Zahid Iqbal',
  'Naveed Akhtar',
  'Shahzad Ahmed',
  'Arshad Mehmood',
  'Faisal Rehman',
  'Kamran Haider',
  'Sajid Ali',
  'Waqas Ahmed',
  'Adnan Rafique',
  'Nadeem Abbas',
  'Rizwan Ashraf',
  'Javed Iqbal',
  'Amjad Pervaiz',
  'Shoaib Akhtar',
  'Atif Saleem',
  'Babar Ali',
  'Mudassar Nazar',
  'Zeeshan Haider',
  'Irfan Ullah',
  'Ghulam Mustafa',
  'Abdul Rasheed',
  'Liaqat Ali',
  'Mohsin Raza',
  'Qaiser Abbas',
  'Usman Ghani',
  'Yasir Arafat',
];
const MOTHERS = [
  'Shazia Bibi',
  'Nazia Parveen',
  'Sadia Batool',
  'Rubina Kausar',
  'Asma Naz',
  'Farah Naz',
  'Saima Tariq',
  'Uzma Khalid',
  'Nighat Sultana',
  'Shabana Akhtar',
  'Bushra Iqbal',
  'Samina Yasmin',
  'Fozia Rani',
  'Kiran Shahzadi',
  'Mehwish Ali',
  'Tahira Bano',
];
const BOYS = [
  'Muhammad Ali',
  'Ahmed',
  'Hamza',
  'Hassan',
  'Hussain',
  'Abdullah',
  'Usman',
  'Bilal',
  'Umar',
  'Saad',
  'Zain',
  'Ayaan',
  'Ibrahim',
  'Taha',
  'Rayyan',
  'Huzaifa',
  'Talha',
  'Faizan',
  'Haris',
  'Arham',
  'Shayan',
  'Moiz',
  'Daniyal',
  'Sufyan',
  'Abdul Rehman',
  'Muhammad Ahmed',
  'Zaid',
  'Yahya',
];
const GIRLS = [
  'Ayesha',
  'Fatima',
  'Maryam',
  'Zainab',
  'Hira',
  'Aiman',
  'Eman',
  'Hafsa',
  'Khadija',
  'Iqra',
  'Laiba',
  'Mahnoor',
  'Areeba',
  'Anaya',
  'Hoorain',
  'Minahil',
  'Alishba',
  'Rida',
  'Sana',
  'Noor',
  'Javeria',
  'Amna',
  'Esha',
  'Dua',
  'Mehak',
  'Zoya',
  'Haniya',
  'Abeeha',
];
const AREAS = [
  'Faisal Town',
  'Model Town',
  'Johar Town',
  'Township',
  'Garden Town',
  'Wapda Town',
  'Iqbal Town',
  'Samanabad',
  'Mustafa Town',
  'Allama Iqbal Town',
];

// ---- Structure --------------------------------------------------------------------------------

export type Programme = {
  key: string;
  name: string;
  kind: 'grade' | 'course';
  seq: number;
  /** Monthly tuition (paisa). */
  tuition: number;
  age: number;
};
export type Group = {
  key: string;
  programme: string;
  name: string;
  primary: boolean;
  size: number;
  days?: string;
  start?: string;
  end?: string;
};

const RS = 100; // paisa per rupee

export const PROGRAMMES: Programme[] = [
  { key: 'nursery', name: 'Nursery', kind: 'grade', seq: 0, tuition: 3000 * RS, age: 4 },
  { key: 'prep', name: 'Prep', kind: 'grade', seq: 1, tuition: 3000 * RS, age: 5 },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
    key: `c${n}`,
    name: `Class ${n}`,
    kind: 'grade' as const,
    seq: n + 1,
    tuition: (n <= 3 ? 3500 : n <= 5 ? 4000 : n <= 8 ? 4500 : 5500) * RS,
    age: n + 5,
  })),
  { key: 'fsc', name: 'FSc Pre-Medical', kind: 'course', seq: 20, tuition: 7500 * RS, age: 17 },
  { key: 'matric', name: 'Matric Coaching', kind: 'course', seq: 21, tuition: 3500 * RS, age: 15 },
];

const sized: [string, number[]][] = [
  ['nursery', [6]],
  ['prep', [6]],
  ['c1', [8]],
  ['c2', [8]],
  ['c3', [8]],
  ['c4', [6, 6]],
  ['c5', [6, 6]],
  ['c6', [6, 6]],
  ['c7', [5, 5]],
  ['c8', [5, 5]],
  ['c9', [6]],
  ['c10', [6]],
];
export const GROUPS: Group[] = [
  ...sized.flatMap(([p, sizes]) =>
    sizes.map((size, i) => ({
      key: `${p}${sizes.length > 1 ? (i ? 'b' : 'a') : 'a'}`,
      programme: p,
      name: i ? 'B' : 'A',
      primary: true,
      size,
    })),
  ),
  {
    key: 'fsc-morning',
    programme: 'fsc',
    name: 'Morning batch',
    primary: false,
    size: 8,
    days: 'Mon-Sat',
    start: '08:00',
    end: '13:00',
  },
  {
    key: 'matric-evening',
    programme: 'matric',
    name: 'Evening batch',
    primary: false,
    size: 6,
    days: 'Mon-Fri',
    start: '16:00',
    end: '18:00',
  },
];

export const SUBJECTS = [
  { key: 'eng', name: 'English', short: 'ENG' },
  { key: 'urd', name: 'Urdu', short: 'URD' },
  { key: 'math', name: 'Mathematics', short: 'MATH' },
  { key: 'sci', name: 'General Science', short: 'SCI' },
  { key: 'isl', name: 'Islamiat', short: 'ISL' },
  { key: 'sst', name: 'Social Studies', short: 'SST' },
  { key: 'comp', name: 'Computer Science', short: 'COMP' },
  { key: 'phy', name: 'Physics', short: 'PHY' },
  { key: 'chem', name: 'Chemistry', short: 'CHEM' },
  { key: 'bio', name: 'Biology', short: 'BIO' },
  { key: 'pst', name: 'Pakistan Studies', short: 'PST' },
] as const;

export type StaffMember = {
  key: string;
  name: string;
  role: string;
  /** Monthly basic (paisa). */
  salary: number;
  allowance?: number;
  login?: keyof typeof DEMO_USERS;
  roles?: ('owner' | 'admin' | 'accountant' | 'teacher')[];
  subjects: string[];
  phone: string;
  joined: string;
};

export const STAFF: StaffMember[] = [
  {
    key: 'principal',
    name: 'Nasreen Akhtar',
    role: 'Principal',
    salary: 120000 * RS,
    allowance: 10000 * RS,
    login: 'principal',
    roles: ['owner'],
    subjects: [],
    phone: '923005550101',
    joined: '2012-03-01',
  },
  {
    key: 'admin',
    name: 'Imran Haider',
    role: 'Administrator',
    salary: 65000 * RS,
    login: 'admin',
    roles: ['admin'],
    subjects: [],
    phone: '923215550102',
    joined: '2016-08-01',
  },
  {
    key: 'accountant',
    name: 'Tariq Mehmood',
    role: 'Accountant',
    salary: 55000 * RS,
    login: 'accountant',
    roles: ['accountant'],
    subjects: [],
    phone: '923335550103',
    joined: '2018-01-15',
  },
  {
    key: 'ayesha',
    name: 'Ayesha Siddiqa',
    role: 'Teacher (English)',
    salary: 48000 * RS,
    login: 'teacher',
    roles: ['teacher'],
    subjects: ['eng'],
    phone: '923455550104',
    joined: '2019-04-01',
  },
  {
    key: 'bilal',
    name: 'Bilal Ahmed',
    role: 'Teacher (Mathematics)',
    salary: 52000 * RS,
    subjects: ['math'],
    phone: '923015550105',
    joined: '2017-04-01',
  },
  {
    key: 'sadia',
    name: 'Sadia Noreen',
    role: 'Teacher (Urdu)',
    salary: 42000 * RS,
    subjects: ['urd'],
    phone: '923125550106',
    joined: '2020-04-01',
  },
  {
    key: 'kashif',
    name: 'Kashif Raza',
    role: 'Teacher (Physics)',
    salary: 58000 * RS,
    subjects: ['phy'],
    phone: '923225550107',
    joined: '2015-09-01',
  },
  {
    key: 'hina',
    name: 'Hina Batool',
    role: 'Teacher (Chemistry)',
    salary: 56000 * RS,
    subjects: ['chem'],
    phone: '923035550108',
    joined: '2018-04-01',
  },
  {
    key: 'usman',
    name: 'Usman Ghani',
    role: 'Teacher (Biology)',
    salary: 56000 * RS,
    subjects: ['bio'],
    phone: '923135550109',
    joined: '2019-09-01',
  },
  {
    key: 'farzana',
    name: 'Farzana Kausar',
    role: 'Teacher (Islamiat)',
    salary: 38000 * RS,
    subjects: ['isl', 'pst'],
    phone: '923235550110',
    joined: '2014-04-01',
  },
  {
    key: 'zubair',
    name: 'Zubair Hassan',
    role: 'Teacher (Computer)',
    salary: 45000 * RS,
    subjects: ['comp'],
    phone: '923405550111',
    joined: '2021-04-01',
  },
  {
    key: 'rabia',
    name: 'Rabia Shaheen',
    role: 'Teacher (Primary)',
    salary: 36000 * RS,
    subjects: ['sci', 'sst'],
    phone: '923065550112',
    joined: '2022-04-01',
  },
  {
    key: 'naila',
    name: 'Naila Parveen',
    role: 'Teacher (Montessori)',
    salary: 34000 * RS,
    subjects: [],
    phone: '923165550113',
    joined: '2023-04-01',
  },
  {
    key: 'asad',
    name: 'Asad Rafiq',
    role: 'Teacher (Social Studies)',
    salary: 40000 * RS,
    subjects: ['sst', 'pst'],
    phone: '923335550114',
    joined: '2020-09-01',
  },
];

/** Class teacher per group (staff key). */
export const CLASS_TEACHER: Record<string, string> = {
  nurserya: 'naila',
  prepa: 'naila',
  c1a: 'rabia',
  c2a: 'rabia',
  c3a: 'sadia',
  c4a: 'farzana',
  c4b: 'asad',
  c5a: 'ayesha',
  c5b: 'zubair',
  c6a: 'bilal',
  c6b: 'sadia',
  c7a: 'asad',
  c7b: 'farzana',
  c8a: 'zubair',
  c8b: 'bilal',
  c9a: 'kashif',
  c10a: 'hina',
  'fsc-morning': 'usman',
  'matric-evening': 'kashif',
};

/** Subjects taught per programme (subject key → staff key) for Classes 4–10 and the batches. */
export function subjectTeachers(group: Group): [string, string][] {
  const p = group.programme;
  const lower = ['c4', 'c5', 'c6', 'c7', 'c8'].includes(p);
  if (lower) {
    const eng = ['c5', 'c6'].includes(p) || group.key === 'c7a' ? 'ayesha' : 'sadia';
    return [
      ['eng', eng],
      ['urd', 'sadia'],
      ['math', 'bilal'],
      ['sci', p === 'c4' ? 'rabia' : 'hina'],
      ['isl', 'farzana'],
      ['sst', 'asad'],
      ['comp', 'zubair'],
    ];
  }
  if (p === 'c9' || p === 'c10')
    return [
      ['eng', 'ayesha'],
      ['urd', 'sadia'],
      ['math', 'bilal'],
      ['phy', 'kashif'],
      ['chem', 'hina'],
      ['bio', 'usman'],
      ['isl', 'farzana'],
      ['pst', 'asad'],
    ];
  if (p === 'fsc')
    return [
      ['phy', 'kashif'],
      ['chem', 'hina'],
      ['bio', 'usman'],
      ['eng', 'ayesha'],
    ];
  if (p === 'matric')
    return [
      ['math', 'bilal'],
      ['phy', 'kashif'],
      ['chem', 'hina'],
    ];
  return [];
}

// ---- People -----------------------------------------------------------------------------------

export type Guardian = {
  id: string;
  name: string;
  relation: 'father' | 'mother';
  phone: string;
  cnic: string | null;
  priority: number;
  consent: boolean;
  lang: 'en' | 'ur';
};
export type Family = {
  id: string;
  index: number;
  surname: string;
  name: string;
  area: string;
  address: string;
  guardians: Guardian[];
  students: Student[];
  /** Payment habit (PRNG): cash, bank or jazzcash. */
  method: 'cash' | 'bank' | 'jazzcash';
  /** 0..1: how reliably the family pays; 1 = always on time. */
  reliability: number;
};
export type Student = {
  id: string;
  index: number;
  familyId: string;
  name: string;
  gender: 'm' | 'f';
  dob: string;
  admissionNo: string;
  admissionDate: string;
  group: string;
  rollNo: number;
  enrolmentId: string;
  /** Joined mid-session (admission fee billed); everyone else was enrolled from `cal.start`. */
  joiner: boolean;
  start: string;
  /** Withdrawn at the end of this date (enrolment end + student left). */
  leftOn: string | null;
  /** Also in the Matric evening batch (secondary enrolment). */
  evening: { enrolmentId: string } | null;
  /** 0..1 chance of being absent on a school day. */
  absence: number;
};

export type World = {
  families: Family[];
  students: Student[];
  ids: (key: string) => string;
};

/**
 * Mid-session joiners: [group key, month index in `cal.months`, day of month]. Their admission fee
 * is billed in that month. Only completed months (never today's), so no one joins in the future.
 */
const JOINERS: [string, number, number][] = [
  ['c1a', 1, 11],
  ['c3a', 1, 18],
  ['c6b', 3, 17],
  ['nurserya', 3, 17],
  ['c4a', 3, 24],
  ['c8a', 4, 1],
  ['prepa', 4, 7],
  ['c2a', 4, 14],
  ['fsc-morning', 1, 4],
  ['fsc-morning', 3, 17],
];
/** Leavers: withdrawn at the end of the fourth month (moved city), by student index. */
export const LEAVER_INDEXES = [41, 83, 105];
/** The leavers' last month, as an index in `cal.months`. */
export const LEAVER_MONTH = 3;

type Base = World & { joins: Map<string, [number, number]>; leavers: Set<string> };
let base: Base | null = null;

/** The ids of every seeded entity: they depend on the key alone, never on the seed day. */
export const demoIds = (key: string): string => people().ids(key);

/** The school dated for a seed day (cheap: the people are built once per isolate). */
const dated = new Map<string, World>();
export function world(cal: DemoCalendar): World {
  const hit = dated.get(cal.today);
  if (hit) return hit;
  const b = people();
  const leftOn = daysOf(cal.months[LEAVER_MONTH] as string).at(-1) as string;
  const byId = new Map<string, Student>();
  const students = b.students.map((s0) => {
    const join = b.joins.get(s0.id);
    const start = join
      ? officeDayFrom(`${cal.months[join[0]]}-${String(join[1]).padStart(2, '0')}`)
      : cal.start;
    const s: Student = {
      ...s0,
      start,
      // Earlier years were admitted in their April; this year's from the start of the history.
      admissionDate: join
        ? start
        : s0.admissionNo.startsWith('2026-')
          ? cal.start
          : s0.admissionDate,
      leftOn: b.leavers.has(s0.id) ? leftOn : null,
    };
    byId.set(s.id, s);
    return s;
  });
  const families = b.families.map((f) => ({
    ...f,
    students: f.students.map((s) => byId.get(s.id) as Student),
  }));
  const w: World = { families, students, ids: b.ids };
  dated.set(cal.today, w);
  return w;
}

function people(): Base {
  if (base) return base;
  const r = rng(DEMO_SEED);
  const idMap = new Map<string, string>();
  let seq = 0;
  let sealed = false;
  // While the world is built, ids are numbered in build order (so students, families and groups
  // sort as built). Afterwards a key's id depends on the key alone: a Worker isolate asks for ids in
  // whatever order its step needs them, and every isolate must get the same answer.
  const ids = (key: string) => {
    let v = idMap.get(key);
    if (!v) {
      v = sealed
        ? demoId(1_000_000 + (hashSeed(`seq:${key}`) % 1_000_000_000), key)
        : demoId(seq++, key);
      idMap.set(key, v);
    }
    return v;
  };
  // Fixed entities first so their ids never depend on the people below.
  for (const p of PROGRAMMES) ids(`programme:${p.key}`);
  for (const g of GROUPS) ids(`grp:${g.key}`);
  for (const s of STAFF) ids(`staff:${s.key}`);

  // 112 seats; 70 families, 21 of them (30%) with siblings. Sized to the D1 write budget
  // (docs/demo.md): a reseed over the previous demo costs about 260 row writes a student.
  const seats = GROUPS.filter((g) => g.key !== 'matric-evening').flatMap((g) =>
    Array.from({ length: g.size }, () => g.key),
  );
  const nFamilies = 70;
  const multi = 21;
  const sizes: number[] = Array.from({ length: nFamilies }, (_, i) => (i < multi ? 2 : 1));
  let extra = seats.length - sizes.reduce((a, b) => a + b, 0);
  while (extra > 0) {
    const i = r.int(0, multi - 1);
    if ((sizes[i] as number) < 5) {
      sizes[i] = (sizes[i] as number) + 1;
      extra--;
    }
  }
  r.shuffle(sizes);
  const pool = r.shuffle([...seats]);
  const familiesSeats: string[][] = sizes.map((n) => {
    const mine: string[] = [];
    for (let k = 0; k < n; k++) {
      // Siblings sit in different programmes (different ages).
      const progOf = (g: string) => GROUPS.find((x) => x.key === g)?.programme;
      const idx = pool.findIndex((g) => !mine.some((m) => progOf(m) === progOf(g)));
      const [g] = pool.splice(idx >= 0 ? idx : 0, 1);
      mine.push(g as string);
    }
    return mine;
  });

  const families: Family[] = [];
  const students: Student[] = [];
  const rolls = new Map<string, number>();
  const usedNames = new Set<string>();
  const admissionCounters = new Map<string, number>();
  familiesSeats.forEach((seatsOf, fi) => {
    const surname = SURNAMES[fi % SURNAMES.length] as string;
    const familyId = ids(`family:${fi}`);
    const father = `${r.pick(FATHERS)} ${surname}`;
    const area = r.pick(AREAS);
    const prefix = r.pick([
      '300',
      '301',
      '302',
      '303',
      '304',
      '305',
      '306',
      '307',
      '308',
      '309',
      '310',
      '311',
      '312',
      '313',
      '314',
      '315',
      '320',
      '321',
      '322',
      '323',
      '330',
      '331',
      '332',
      '333',
      '334',
      '335',
      '336',
      '340',
      '341',
      '342',
      '343',
      '344',
      '345',
    ]);
    const landline = fi % 63 === 5;
    const guardians: Guardian[] = [
      {
        id: ids(`guardian:${fi}:f`),
        name: father,
        relation: 'father',
        // Visibly fake: 03XX 555 NNNN (or a 042-3555 NNNN landline for a few "call" families).
        phone: landline
          ? `9242355${String(5000 + fi).padStart(5, '0')}`
          : `92${prefix}555${String(1000 + fi * 7)
              .padStart(4, '0')
              .slice(-4)}`,
        cnic: `35202-555${String(fi).padStart(4, '0')}-${(fi % 9) + 1}`,
        priority: 1,
        consent: landline ? false : r.chance(0.86),
        lang: r.chance(0.68) ? 'ur' : 'en',
      },
    ];
    if (r.chance(0.32))
      guardians.push({
        id: ids(`guardian:${fi}:m`),
        name: `${r.pick(MOTHERS)}`,
        relation: 'mother',
        phone: `92${r.pick(['300', '321', '333', '345', '303'])}555${String(2000 + fi * 3)
          .padStart(4, '0')
          .slice(-4)}`,
        cnic: null,
        priority: 2,
        consent: r.chance(0.6),
        lang: 'ur',
      });
    const fam: Family = {
      id: familyId,
      index: fi,
      surname,
      name: `${surname} family`,
      area,
      address: `House ${r.int(1, 240)}, Street ${r.int(1, 30)}, ${area}, Lahore`,
      guardians,
      students: [],
      method: r.chance(0.74) ? 'cash' : r.chance(0.6) ? 'bank' : 'jazzcash',
      reliability: r.chance(0.16) ? 0.45 : r.chance(0.3) ? 0.7 : 0.94,
    };
    for (const g of seatsOf) {
      const group = GROUPS.find((x) => x.key === g) as Group;
      const prog = PROGRAMMES.find((p) => p.key === group.programme) as Programme;
      const gender: 'm' | 'f' = r.chance(0.5) ? 'm' : 'f';
      let first = r.pick(gender === 'm' ? BOYS : GIRLS);
      let name = `${first} ${surname}`;
      for (let k = 0; usedNames.has(name) && k < 5; k++) {
        first = r.pick(gender === 'm' ? BOYS : GIRLS);
        name = `${first} ${surname}`;
      }
      usedNames.add(name);
      const index = students.length;
      const birthYear = 2026 - prog.age - (r.chance(0.3) ? 1 : 0);
      const dob = `${birthYear}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;
      // Continuing students were admitted in an earlier April; academy students this year.
      const yearsIn = prog.kind === 'course' ? 0 : Math.min(prog.seq, r.int(0, prog.seq + 1));
      const admYear = String(2026 - yearsIn);
      const n = (admissionCounters.get(admYear) ?? 0) + 1;
      admissionCounters.set(admYear, n);
      const roll = (rolls.get(g) ?? 0) + 1;
      rolls.set(g, roll);
      const s: Student = {
        id: ids(`student:${index}`),
        index,
        familyId,
        name,
        gender,
        dob,
        admissionNo: `${admYear}-${String(n).padStart(4, '0')}`,
        admissionDate: `${admYear}-04-01`,
        group: g,
        rollNo: roll,
        enrolmentId: ids(`enrolment:${index}`),
        joiner: false,
        start: '',
        leftOn: null,
        evening: null,
        absence: r.chance(0.08) ? 0.16 : r.chance(0.3) ? 0.06 : 0.03,
      };
      fam.students.push(s);
      students.push(s);
    }
    families.push(fam);
  });

  // Joiners: the last student of each listed group starts mid-session (admitted that day).
  const joins = new Map<string, [number, number]>();
  for (const [g, month, day] of JOINERS) {
    const s = [...students].reverse().find((x) => x.group === g && !x.joiner);
    if (!s) continue;
    s.joiner = true;
    joins.set(s.id, [month, day]);
    const n = (admissionCounters.get('2026') ?? 0) + 1;
    admissionCounters.set('2026', n);
    s.admissionNo = `2026-${String(n).padStart(4, '0')}`;
  }
  const leavers = new Set<string>();
  for (const i of LEAVER_INDEXES) {
    const s = students[i];
    if (s && !s.joiner) leavers.add(s.id);
  }
  // Matric evening batch: 6 students of Classes 9 and 10.
  const seniors = students.filter(
    (s) => (s.group === 'c9a' || s.group === 'c10a') && !leavers.has(s.id),
  );
  for (const s of seniors.filter((_, i) => i % 3 === 0).slice(0, 6))
    s.evening = { enrolmentId: ids(`enrolment:${s.index}:evening`) };

  sealed = true;
  base = { families, students, ids, joins, leavers };
  return base;
}

/** Admission series rows: the highest number used per year (admission_series.last_no). */
export function demoAdmissionSeries(w: World): { series: string; last: number }[] {
  const m = new Map<string, number>();
  for (const s of w.students) {
    const [y, n] = s.admissionNo.split('-') as [string, string];
    m.set(y, Math.max(m.get(y) ?? 0, Number(n)));
  }
  return [...m.entries()].sort().map(([series, last]) => ({ series, last }));
}

export const rupees = (n: number) => n * RS;
